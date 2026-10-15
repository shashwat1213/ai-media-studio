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

## Honest limits
- 4 GB is the ceiling: one model at a time; video models are the stretch goal, not a promise.
- Disk: models live on /mnt/ubuntu-storage (600+ GB free); each step lists its download size before it starts.
