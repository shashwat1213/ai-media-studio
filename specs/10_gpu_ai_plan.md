# 10 — GPU AI plan (RTX 3050 Laptop, 4 GB VRAM)

Status: **plan + baseline measured** (15 Oct 2026). Nothing new downloaded or built yet.

## Hardware (measured)
| | |
|---|---|
| GPU | NVIDIA GeForce RTX 3050 Laptop (GA107M), **4 GB VRAM**, max 75 W, driver 595 |
| CPU / RAM | AMD Ryzen 7 170, 8 cores / 16 threads, 30 GB RAM |
| Disk free | ~13 GB (87% used): the hard limit for new models |
| Engine | stable-diffusion.cpp via **Vulkan** (no CUDA toolkit needed), one GPU job at a time (gateway lock) |

## Baseline: what the GPU gives us today (same picture, same seed, same binary)
DreamShaper 8 (SD 1.5) + LCM-LoRA, 6 steps, 512×768, `generate_image` time from sd-cli logs:

| Backend | Sampling | VAE decode | Total | Peak VRAM |
|---|---|---|---|---|
| CPU (`--backend cpu`, 8 cores) | 66.2 s | 46.8 s | **113.6 s** | — |
| GPU (Vulkan, RTX 3050) | 7.9 s | 3.0 s | **11.5 s** | 2.1 GB of 4 GB |
| GPU, 768×768 | 12.1 s | 4.8 s | 17.5 s | 2.3 GB |

**≈ 9.9× faster on the GPU.** A 4-shot scene: pictures ~46 s instead of ~7.5 min, which is
what makes the Scene Director usable at all. GPU peaked at 100% utilisation and ~30 W.

Still on the CPU today: the LLM director (Qwen3-4B, ~14.6 tok/s), the Gemma scribe, whisper.cpp, Piper.

## What the installed sd-cli can already do (from `sd-cli --help`)
`--mode vid_gen`, `--motion-module` (AnimateDiff for SD 1.5), `--ip-adapter`, `--photo-maker`,
`--control-net`, `--upscale-model` (ESRGAN), Wan / LTX model support. **No new engine needed, only models.**

## Plan (ordered by value ÷ risk on 4 GB)
| # | Feature | Model (approx size) | Fits 4 GB? | What the user gets |
|---|---|---|---|---|
| G1 | **Character consistency** | IP-Adapter (SD1.5) + CLIP vision, or PhotoMaker | Yes (~2.5–3 GB) | Library CHARACTER gets a reference photo → same face in every shot (today: same description + seed = "close, not exact") |
| G2 | **Upscale** | Real-ESRGAN x4 (~65 MB) | Yes | 512×768 shots → sharp 1080×1920 reels (today the editor just scales up) |
| G3 | **Real motion in shots** | AnimateDiff motion module for SD 1.5 (~1.7 GB) | Probably, at 512×512 / 16 frames — must measure | 2 s of real movement (water, smoke, hair) instead of only a camera move over a still |
| G4 | **LLM on the GPU** | Same Qwen3-4B Q4 (2.4 GB), `-ngl` partial offload | Only when SD is idle (shared 4 GB) | Faster scripts; needs a VRAM scheduler so LLM and SD never load together |
| G5 | Text/image-to-video (Wan2.1 1.3B, LTX-Video 2B) | 3–6 GB + text encoder | Doubtful; minutes per second of video | Real AI video. Probably needs an 8 GB+ GPU or a paid cloud API |

Each step: measure VRAM/time first, keep the stub path for CI, same job/credit/refund flow
(`PictureEngine` / gateway endpoint), honest numbers in this file.

## G2 — HD pictures: BUILT (15 Oct 2026)
- Real-ESRGAN **x4plus** (64 MB, BSD-3) on `/mnt/ubuntu-storage/ams-ai/models/upscale`, run by the same
  `sd-cli -M upscale` (Vulkan). Gateway: `POST /image {"upscale": true}` → SD 512×768 → ESRGAN ×4 →
  Lanczos to long side 1920 → JPEG q2; returns `X-Width/X-Height`. `/health` reports `upscale`.
- Measured, 512×768 → 2048×3072: **GPU 31 s, 0.5 GB VRAM** vs CPU 238 s (7.6×).
  anime_6B is 3× faster but makes skin waxy (rejected); tile 256 = 2.7 GB VRAM, slower; tile 512 fails on 4 GB.
- API: `Scene.hd` (migration `scene_hd`, default false). Price 5 → **8 credits** (`SCENE_HD_EXTRA = 3`), full
  HD price refunded once on failure, retry charges HD again. `POST /scenes {hd:true}` → **409 before charging**
  if the gateway has no upscaler. Uploads store the REAL size (1280×1920 JPEG, ~240–400 KB each).
- Web: Director "Pictures: Fast / HD ×4" toggle (hidden when the upscaler isn't installed), price on the button.
- Tests: +6 (HD request/headers/JPEG/size fallback, `hdSize`, health flag, HD scene stores real size and the
  draft validates, non-HD never upscales, 409-without-charge, HD price + refund + retry, ledger == balance).
  239 pass; stmts 92.5%, branches 81.1%.
- E2E (real Chrome, Docker, local AI): Hinglish HD scene, 5 shots → READY in 445 s (script ~100 s incl. LLM
  cold start, ~57–67 s per HD shot), balance 50 → 42, editor render 19.4 s 1080×1920 H.264+AAC in ~6.5 s;
  frame checked: sharp, no upscale blockiness.
- Seen, not caused by HD: the on-screen title can sit over the character's face (placement is fixed at the top).

## G1 — Same face in every shot: BUILT (15 Oct 2026)
- IP-Adapter **plus-face SD1.5** (98 MB) + **CLIP ViT-H** image encoder (2.5 GB), run by the same `sd-cli`
  (`--ip-adapter --clip_vision --ip-adapter-image --ip-adapter-strength`). Measured: ~25 s per 512×768, **3.2 GB VRAM**.
- Strength tests on an AI-generated reference: 0.7 = strongest likeness but outfits drift bold; 0.55 = worse (slits,
  sleeveless); **0.65 + a modesty negative = same face, scene followed, dressed as described** (default).
  The adapter pulls outfits towards "glamour"; the gateway always adds a modesty negative when a face is used.
- Consent is enforced server-side: CHARACTER `settings.faceRef` needs `faceConsent` ∈ self / consented / ai_generated
  AND a photo, on create and update. The producer only sends the face if the upload is still the user's own READY
  PNG/JPEG (a forged id in the library row sends nothing). Gateway accepts only base64 PNG/JPEG ≤ 4 MB, never a path.
- Web: Library → Character → "Same face in every shot": upload photo, pick "Me / Someone who agreed / AI-generated".
- E2E (Chrome, local AI): AI-generated "Riya" → 3-shot Goa scene, READY 140 s, same face in all 3 (frames checked),
  render 5.1 s. Tests: +4 (consent rules, face bytes reach every shot, forged id ignored, gateway body). 265 pass.

## Text-to-video (moving character) — choosing the model for 4 GB (15 Oct 2026)
| Model | Size (quant) | 4 GB? | Verdict |
|---|---|---|---|
| Wan 2.1 T2V **1.3B** | 1.6 GB Q8 GGUF + umt5 Q4 3.7 GB (CPU) + VAE 0.25 GB | Likely (480p, 33 frames) | **First pick**: best quality/size, sd-cli supports it |
| Wan 2.1 **VACE 1.3B** | 1.7 GB Q5_K_M | Likely | **Second**: reference image → video = OUR character moving |
| CausVid LoRA (1.3B) | 90 MB | — | 4–8 steps instead of 30: the speed trick |
| Wan 2.2 TI2V 5B | 3.4 GB Q4 | Tight, slow | Later, if 1.3B quality isn't enough |
| LTX-Video 2B | ~4 GB | 6 GB min | Skip for now |
| Wan 14B / Hunyuan | 10+ GB | No | Paid/cloud only |
| AnimateDiff SD1.5 | 1.7 GB | Yes | Fallback: short loops, weaker motion |

### Text-to-video measured (Wan 2.1 T2V 1.3B Q8 + CausVid LoRA, sd-cli vid_gen, 15 Oct 2026)
| Test | Size / frames | Steps | Time | Peak VRAM | Result |
|---|---|---|---|---|---|
| Beach dance at sunset | 480×832, 33 (2.1 s @16 fps) | 8 | **193 s** (sample 124 s + VAE 54 s) | 3.0 GB | Real motion: arms, dupatta, spin; coherent person |
| Rain dance, Mumbai night | 480×832, 49 (3.1 s) | 6 | **303 s** (209 + 79) | 3.3 GB | Real motion, neon reflections, rain; coherent |
- **Pitfall found:** auto-fit put the video model on the AMD iGPU (Radeon 680M, "more free memory") → 60 s/step.
  Forcing `--backend "te=cpu,diffusion=Vulkan1,vae=Vulkan1" --params-backend te=cpu` → **15 s/step on the RTX 3050 (4×)**.
- Text encoder (umt5-xxl Q4_K_M, 3.7 GB) stays in RAM on the CPU; DiT 1.5 GB + VAE 0.25 GB in VRAM.
- Output is MJPEG AVI at 16 fps → ffmpeg `minterpolate=fps=24` → H.264 MP4.
- Limits: ~2–3 s per clip, 480p, ~1.5 min of GPU per second of video. Identity is from the TEXT only (no face
  reference yet) → next: **VACE 1.3B** with the library character's reference image.

### Reference-to-video: OUR character moving (Wan 2.1 VACE 1.3B, 15 Oct 2026)
- Model: `wan2.1-v3-vace-1.3b-q5_0.gguf` (calcuis, 1.6 GB). **Pitfall:** the un-versioned `wan2.1-vace-1.3b-*`
  quants are missing `vace_patch_embedding.weight` → sd-cli refuses ("not in model metadata"); the `v2`/`v3` files
  are complete (checked by reading the GGUF tensor table over an HTTP range request before downloading).
- Same flags as T2V plus `-i reference.png`. 33 frames, 8 steps, CausVid: **435 s**, peak VRAM 3.2 GB.
- Result (AI-generated reference "Riya"): same face, bindi, hair and yellow kurta; real motion (arms out, spin,
  dress swirls) on a beach at sunset. Clearly better identity than text-only T2V.
- Cost: ~3.5 min of GPU per second of video. A 15 s reel ≈ 5 clips ≈ 35–40 min → background job, not interactive.

## Honest limits
- 4 GB is the ceiling: one model at a time; video models are the stretch goal, not a promise.
- Disk: models live on /mnt/ubuntu-storage (600+ GB free); each step lists its download size before it starts.

### Wan2GP (DeepBeepMeep, Python/PyTorch) vs our sd-cli VACE — measured 16 Oct 2026
Same AI-generated "Riya" reference, same prompt (beach dance at sunset), seed 42, 33 frames @16 fps, RTX 3050 4 GB.
| | Wan2GP `fun_inp_1.3B` (image-to-video), profile 4.5, sdpa | sd-cli VACE 1.3B q5 + CausVid (reference-to-video) |
|---|---|---|
| Steps | 20 (no speed LoRA) | 8 |
| Time | **420 s** (load 40 s, 20 × ~18 s, VAE decode 25 s) | **435 s** |
| Peak VRAM | **2.7 GB** (weights mostly in RAM, offloaded) | 3.2 GB |
| Output | 624×624 (square: it keeps the input picture's frame) | 480×832 |
| Identity | Near-perfect (it starts FROM the picture) | Close (face a bit rounder) |
| Motion / scene | Stays in the reference shot: smiles, head turns, a hand gesture; **no new scene, no dance** | New scene (beach), full body, real dance: spin, arms out, dress swirls |
| Download | ~13 GB extra (own umt5 int8 6.7 GB + models; can't share our GGUFs) | already installed |
- Verdict: **keep sd-cli VACE as the engine.** Image-to-video only animates the picture it's given, so its value is
  "animate a shot picture exactly", not "put the character into a new scene".
- Worth one more test later: Wan2GP i2v on a real full-body SHOT picture (made by IP-Adapter in the scene) with a
  speed LoRA (4–8 steps). That would give perfect picture→video continuity in ~2–3 min per clip.
- Outputs: `~/Downloads/wan2gp-riya-i2v-20steps.mp4`, comparison strip `~/Downloads/wan2gp-vs-vace-compare.png`.
