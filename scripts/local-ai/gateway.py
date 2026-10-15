#!/usr/bin/env python3
"""
Local AI gateway for AI Media Studio (standard library only, no pip installs).

    POST /image       {"prompt", "negative"?, "width", "height", "seed"?, "steps"?, "upscale"?,
                       "faceRef"?: base64 PNG/JPEG (<= 4 MB), "faceStrength"?: 0.3..0.9}
                      -> image/png, or with "upscale": true an ESRGAN x4 image/jpeg (long side 1920)
    POST /video       {"prompt", "ref": base64 PNG/JPEG (the shot's picture), "width", "height", "frames"?: 17..49,
                       "steps"?: 4..10, "seconds"?: 1..12, "seed"?}                              -> video/mp4
                       Wan 2.1 VACE 1.3B: the picture's character MOVES (~7 min per 2 s clip on 4 GB).
    POST /tts         {"text", "voice", "speed"?}                                   -> audio/wav
    POST /transcribe  raw audio bytes (any format ffmpeg reads), ?language=hi         -> JSON words
    GET  /health      -> {"ok": true, "voices": [...], "image": bool, "upscale": bool, "stt": bool}

Every request needs "Authorization: Bearer <LOCAL_AI_TOKEN>". Engines run as subprocesses with
fixed argument lists (no shell), inputs are length-limited, and the GPU is used by ONE image at a
time (the RTX 3050 has 4 GB). Pictures: stable-diffusion.cpp (Vulkan) + DreamShaper 8 + LCM-LoRA
(4-6 steps). Voice: Piper. Speech-to-text: whisper.cpp large-v3-turbo.
"""
import base64
import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.environ.get("AMS_AI_HOME", os.path.expanduser("~/.local/share/ams-ai"))
TOKEN = os.environ["LOCAL_AI_TOKEN"]
BIND = os.environ.get("LOCAL_AI_BIND", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_AI_PORT", "8082"))

SD_BIN = os.path.join(ROOT, "bin/sd/sd-cli")
SD_MODEL = os.path.join(ROOT, "models/sd/dreamshaper8.safetensors")
LORA_DIR = os.path.join(ROOT, "models/lora")
# Real-ESRGAN x4plus (BSD-3): 512x768 -> 2048x3072 on the GPU in ~31 s, ~0.5 GB VRAM (tile 128).
# Measured: anime_6B is 3x faster but paints skin waxy; tile 256 needs 2.7 GB for no speed gain;
# tile 512 fails on 4 GB.
ESRGAN_MODEL = os.path.join(ROOT, "models/upscale/RealESRGAN_x4plus.pth")
# Same face in every shot: IP-Adapter plus-face (SD1.5) + CLIP ViT-H. Measured on the 4 GB GPU:
# ~25 s per 512x768 picture, 3.2 GB VRAM. Strength 0.65 keeps the face and still follows the scene.
IPA_MODEL = os.path.join(ROOT, "models/ipadapter/ip-adapter-plus-face_sd15.safetensors")
IPA_CLIP = os.path.join(ROOT, "models/ipadapter/clip-vision-vit-h.safetensors")
MAX_FACE_REF = 4 * 1024 * 1024
# Moving shots: Wan 2.1 VACE 1.3B (reference image -> video) + CausVid LoRA (6-8 steps), umt5 text encoder on CPU.
WAN_DIR = os.path.join(ROOT, "models/wan")
WAN_VACE = os.path.join(WAN_DIR, "wan2.1-v3-vace-1.3b-q5_0.gguf")
WAN_VAE = os.path.join(WAN_DIR, "wan_2.1_vae.safetensors")
WAN_TE = os.path.join(WAN_DIR, "umt5-xxl-Q4_K_M.gguf")
WAN_LORA = os.path.join(WAN_DIR, "causvid_1_3b_lora.safetensors")
WAN_NEGATIVE = ("static, still frame, blurry, low quality, jpeg artifacts, deformed, extra fingers, extra limbs, bad hands, "
                "bad face, text, subtitles, watermark, nsfw, nude, revealing clothes, bare shoulders")
_gpu_device = None


def gpu_device():
    """The NVIDIA Vulkan device. sd-cli's auto-fit picks the iGPU on hybrid laptops (4x slower, measured)."""
    global _gpu_device
    if _gpu_device is None:
        _gpu_device = ""
        try:
            out = subprocess.run([SD_BIN, "--list-devices"], capture_output=True, text=True, timeout=60,
                                 env={**os.environ, "LD_LIBRARY_PATH": os.path.dirname(SD_BIN)}).stdout
            for line in out.splitlines():
                name, _, desc = line.partition("\t")
                if name.startswith("Vulkan") and any(k in desc for k in ("NVIDIA", "GeForce", "RTX")):
                    _gpu_device = name
                    break
        except Exception:
            pass
    return _gpu_device


def video_ready():
    return all(os.path.isfile(p) for p in (WAN_VACE, WAN_VAE, WAN_TE, WAN_LORA))
# The face adapter pulls outfits towards "glamour" (measured); keep characters dressed as described.
MODEST_NEGATIVE = "nsfw, nude, cleavage, off-shoulder, bare shoulders, thigh slit, bare legs, revealing clothes, lingerie, sexy"
UPSCALE_LONG_SIDE = 1920  # final size: enough for a 1080x1920 reel, no wasted bytes
PIPER_BIN = os.path.join(ROOT, "bin/piper/piper")
PIPER_DIR = os.path.join(ROOT, "models/piper")
WHISPER_BIN_CANDIDATES = ["bin/whisper/whisper-bin-ubuntu-x64/whisper-cli", "bin/whisper/whisper-cli"]
WHISPER_MODEL = os.path.join(ROOT, "models/whisper/large-v3-turbo-q5_0.bin")

GPU = threading.Lock()  # one picture at a time
CPU_STT = threading.Semaphore(1)  # whisper uses all cores; one at a time
MAX_BODY = 30 * 1024 * 1024
DEFAULT_NEGATIVE = "lowres, blurry, bad anatomy, extra fingers, deformed, text, watermark, logo, signature, jpeg artifacts, nsfw, nude, naked, topless, nipples, explicit"


def find_whisper():
    for rel in WHISPER_BIN_CANDIDATES:
        p = os.path.join(ROOT, rel)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    found = shutil.which("whisper-cli", path=os.path.join(ROOT, "bin/whisper"))
    return found


def voices():
    out = []
    if os.path.isdir(PIPER_DIR):
        for f in sorted(os.listdir(PIPER_DIR)):
            if f.endswith(".onnx"):
                out.append(f[:-5])
    return out


def run(args, timeout, stdin=None):
    # Each engine ships its own ggml .so files next to the binary.
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(args[0]) if os.path.isabs(args[0]) else "")
    p = subprocess.run(args, input=stdin, capture_output=True, timeout=timeout, env=env)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or b"").decode(errors="replace")[-600:])
    return p


def make_image(body):
    prompt = str(body.get("prompt", ""))[:1500].strip()
    if not prompt:
        raise ValueError("prompt required")
    w = int(body.get("width", 512))
    h = int(body.get("height", 512))
    # SD 1.5 sweet spot ~512-768 px; multiples of 64. The editor upscales/crops for the video.
    w = max(256, min(768, w - w % 64))
    h = max(256, min(768, h - h % 64))
    steps = max(2, min(12, int(body.get("steps", 6))))
    seed = int(body.get("seed", int(time.time() * 1000) % 2147483647))
    negative = str(body.get("negative") or DEFAULT_NEGATIVE)[:600]
    if "nsfw" not in negative:  # a caller's own negative never removes the safety terms
        negative = f"{negative}, nsfw, nude, naked, topless, nipples, explicit"[:700]
    upscale = body.get("upscale") is True
    if upscale and not os.path.isfile(ESRGAN_MODEL):
        raise ValueError("upscaler not installed (run scripts/local-ai/install.sh)")
    face = None
    if body.get("faceRef"):
        if not (os.path.isfile(IPA_MODEL) and os.path.isfile(IPA_CLIP)):
            raise ValueError("face reference needs IP-Adapter (run scripts/local-ai/install.sh)")
        try:
            face = base64.b64decode(str(body["faceRef"]), validate=True)
        except Exception:
            raise ValueError("faceRef must be base64")
        # Only real PNG/JPEG bytes, never a path or URL.
        if len(face) > MAX_FACE_REF or not (face[:8] == b"\x89PNG\r\n\x1a\n" or face[:3] == b"\xff\xd8\xff"):
            raise ValueError("faceRef must be a PNG or JPEG up to 4 MB")
        negative = f"{negative}, {MODEST_NEGATIVE}"[:700]
    face_strength = max(0.3, min(0.9, float(body.get("faceStrength", 0.65))))
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "out.png")
        args = [
            SD_BIN, "-m", SD_MODEL,
            "--lora-model-dir", LORA_DIR,
            # LCM-LoRA: good pictures in 4-8 steps with cfg ~1.5 (vs 25+ steps without).
            "-p", prompt + " <lora:lcm-sd15:1>",
            "-n", negative,
            "--sampling-method", "lcm", "--steps", str(steps), "--cfg-scale", "1.5",
            "-W", str(w), "-H", str(h), "-s", str(seed),
            "--vae-tiling",
            "-o", out,
        ]
        if face is not None:
            ref = os.path.join(d, "face.img")
            with open(ref, "wb") as f:
                f.write(face)
            args += ["--ip-adapter", IPA_MODEL, "--clip_vision", IPA_CLIP,
                     "--ip-adapter-image", ref, "--ip-adapter-strength", f"{face_strength:.2f}"]
        with GPU:
            t = time.time()
            run(args, timeout=300)
            if upscale:
                big = os.path.join(d, "x4.png")
                run([SD_BIN, "-M", "upscale", "--upscale-model", ESRGAN_MODEL, "--upscale-tile-size", "128",
                     "-i", out, "-o", big], timeout=300)
            ms = int((time.time() - t) * 1000)
        if not upscale:
            with open(out, "rb") as f:
                return f.read(), {"seed": seed, "width": w, "height": h, "ms": ms, "mime": "image/png"}
        # x4 -> long side 1920 (Lanczos), JPEG q2: ~1 MB instead of an 8 MB PNG per shot.
        k = UPSCALE_LONG_SIDE / max(w, h)
        fw, fh = round(w * k / 2) * 2, round(h * k / 2) * 2
        jpg = os.path.join(d, "hd.jpg")
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", big,
             "-vf", f"scale={fw}:{fh}:flags=lanczos", "-q:v", "2", jpg], timeout=60)
        with open(jpg, "rb") as f:
            return f.read(), {"seed": seed, "width": fw, "height": fh, "ms": ms, "mime": "image/jpeg"}


def make_video(body):
    if not video_ready():
        raise ValueError("AI video needs the Wan models (run scripts/local-ai/install.sh)")
    prompt = str(body.get("prompt", ""))[:1200].strip()
    if not prompt:
        raise ValueError("prompt required")
    try:
        ref = base64.b64decode(str(body.get("ref", "")), validate=True)
    except Exception:
        raise ValueError("ref must be base64")
    if not ref or len(ref) > MAX_FACE_REF * 2 or not (ref[:8] == b"\x89PNG\r\n\x1a\n" or ref[:3] == b"\xff\xd8\xff"):
        raise ValueError("ref must be a PNG or JPEG up to 8 MB")
    # 480p-ish on a 4 GB card; multiples of 16. Frames are 4k+1 (Wan's latent stride).
    w, h = int(body.get("width", 480)), int(body.get("height", 832))
    long_side = max(384, min(832, int(body.get("longSide", 832))))
    k = long_side / max(w, h)
    w, h = max(256, int(w * k) // 16 * 16), max(256, int(h * k) // 16 * 16)
    frames = max(17, min(49, int(body.get("frames", 33))))
    frames = (frames - 1) // 4 * 4 + 1
    steps = max(4, min(10, int(body.get("steps", 6))))
    seconds = max(1.0, min(12.0, float(body.get("seconds", 4))))
    seed = int(body.get("seed", int(time.time() * 1000) % 2147483647))
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "ref.img")
        with open(src, "wb") as f:
            f.write(ref)
        out = os.path.join(d, "clip.mp4")
        dev = gpu_device()
        args = [SD_BIN, "-M", "vid_gen", "--diffusion-model", WAN_VACE, "--vae", WAN_VAE, "--t5xxl", WAN_TE,
                "--lora-model-dir", WAN_DIR,
                "-p", prompt + ", smooth natural motion <lora:causvid_1_3b_lora:1>", "-n", WAN_NEGATIVE,
                "--cfg-scale", "1.0", "--sampling-method", "euler", "--steps", str(steps),
                "-W", str(w), "-H", str(h), "-i", src, "--video-frames", str(frames), "--fps", "16",
                "--flow-shift", "3.0", "--vae-tiling", "-s", str(seed), "-o", out]
        if dev:
            args += ["--backend", f"te=cpu,diffusion={dev},vae={dev}", "--params-backend", "te=cpu"]
        with GPU:
            t = time.time()
            run(args, timeout=1500)
            ms = int((time.time() - t) * 1000)
        raw = out + ".avi" if os.path.isfile(out + ".avi") else out
        # 16 fps -> 24 fps (motion interpolation), then forward+backward ("boomerang") until it covers
        # the shot, so a 2 s clip fills a 4-6 s shot without freezing on the last frame.
        fwd = os.path.join(d, "fwd.mp4")
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", raw,
             "-vf", "minterpolate=fps=24:mi_mode=mci,format=yuv420p", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", fwd], timeout=300)
        clip_s = frames / 16
        loops = max(0, int(seconds / (2 * clip_s) + 0.999) - 1)
        final = os.path.join(d, "final.mp4")
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", fwd,
             "-filter_complex", f"[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,loop=loop={loops}:size=32767:start=0,setpts=N/24/TB[v]",
             "-map", "[v]", "-t", f"{seconds:.2f}", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], timeout=300)
        with open(final, "rb") as f:
            return f.read(), {"seed": seed, "width": w, "height": h, "ms": ms}


def make_tts(body):
    text = str(body.get("text", ""))[:3000].strip()
    voice = str(body.get("voice", ""))
    if not text:
        raise ValueError("text required")
    if voice not in voices():  # whitelist: never a path from the client
        raise ValueError("unknown voice")
    speed = float(body.get("speed", 1.0))
    length_scale = max(0.5, min(2.0, 1.0 / max(0.5, min(2.0, speed))))
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "out.wav")
        run([PIPER_BIN, "--model", os.path.join(PIPER_DIR, voice + ".onnx"), "--length_scale", f"{length_scale:.2f}",
             "--sentence_silence", "0.25", "--output_file", out], timeout=120, stdin=text.encode("utf-8"))
        with open(out, "rb") as f:
            return f.read()


def transcribe(data, language):
    wbin = find_whisper()
    if not wbin or not os.path.isfile(WHISPER_MODEL):
        raise RuntimeError("whisper.cpp not installed")
    if language and not re.fullmatch(r"[a-z]{2}", language):
        raise ValueError("bad language")
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in")
        wav = os.path.join(d, "in.wav")
        with open(src, "wb") as f:
            f.write(data)
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], timeout=120)
        base = os.path.join(d, "out")
        with CPU_STT:
            # -ml 1 -sow: one word per segment with timings; -oj: JSON output.
            run([wbin, "-m", WHISPER_MODEL, "-f", wav, "-l", language or "auto", "-ml", "1", "-sow", "-oj", "-of", base,
                 "-t", str(os.cpu_count() or 4), "-np"], timeout=900)
        with open(base + ".json", encoding="utf-8") as f:
            j = json.load(f)
    words = []
    for seg in j.get("transcription", []):
        txt = seg.get("text", "").strip()
        off = seg.get("offsets", {})
        if txt and "from" in off and "to" in off:
            words.append({"word": txt, "start": off["from"] / 1000.0, "end": off["to"] / 1000.0})
    lang = (j.get("result") or {}).get("language") or language or "unknown"
    text = " ".join(w["word"] for w in words)
    dur = words[-1]["end"] if words else 0
    # Same shape as Cloudflare's whisper result, so the API parses both the same way.
    return {"text": text, "transcription_info": {"language": lang, "duration": dur}, "segments": [{"words": words}]}


class Handler(BaseHTTPRequestHandler):
    server_version = "ams-local-ai/1"

    def log_message(self, fmt, *args):  # quieter logs, no bodies
        print(f"{self.address_string()} {self.command} {self.path} -> " + (fmt % args), flush=True)

    def _auth(self):
        got = self.headers.get("Authorization", "")
        if not hmac.compare_digest(got, f"Bearer {TOKEN}"):
            self._send(401, {"error": "unauthorized"})
            return False
        return True

    def _send(self, code, obj=None, body=None, ctype="application/json", headers=None):
        data = body if body is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > MAX_BODY:
            raise ValueError("bad body size")
        return self.rfile.read(n)

    def do_GET(self):
        if not self._auth():
            return
        if urlparse(self.path).path == "/health":
            self._send(200, {"ok": True, "voices": voices(), "image": os.path.isfile(SD_MODEL) and os.path.isfile(SD_BIN),
                             "upscale": os.path.isfile(ESRGAN_MODEL),
                             "faceRef": os.path.isfile(IPA_MODEL) and os.path.isfile(IPA_CLIP),
                             "video": video_ready(),
                             "stt": bool(find_whisper()) and os.path.isfile(WHISPER_MODEL)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return
        url = urlparse(self.path)
        try:
            if url.path == "/image":
                png, meta = make_image(json.loads(self._body()))
                self._send(200, body=png, ctype=meta["mime"], headers={"X-Seed": str(meta["seed"]), "X-Render-Ms": str(meta["ms"]),
                                                                    "X-Width": str(meta["width"]), "X-Height": str(meta["height"])})
            elif url.path == "/video":
                mp4, meta = make_video(json.loads(self._body()))
                self._send(200, body=mp4, ctype="video/mp4", headers={"X-Seed": str(meta["seed"]), "X-Render-Ms": str(meta["ms"]),
                                                                       "X-Width": str(meta["width"]), "X-Height": str(meta["height"])})
            elif url.path == "/tts":
                self._send(200, body=make_tts(json.loads(self._body())), ctype="audio/wav")
            elif url.path == "/transcribe":
                lang = (parse_qs(url.query).get("language") or [""])[0]
                self._send(200, transcribe(self._body(), lang))
            else:
                self._send(404, {"error": "not found"})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except subprocess.TimeoutExpired:
            self._send(504, {"error": "engine timed out"})
        except Exception as e:  # engine failure: short message only
            print("engine error:", repr(e)[:500], flush=True)
            self._send(502, {"error": "engine failed"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"ams local AI gateway on {BIND}:{PORT}; voices={voices()}", flush=True)
    srv.serve_forever()
