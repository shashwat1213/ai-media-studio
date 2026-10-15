# 09 — Scene Director: prompt + library -> AI shot list -> pictures + voice + sound -> editor

Status: built on `feat/editor`. Runs **on this computer** (no paid API, works offline once the
models are downloaded). Optional cloud fallback: Cloudflare Workers AI (free daily quota).

## What the user does
1. **Library** (Director → Library): reusable things a prompt mentions with `@handle`
   - CHARACTER (look description + fixed "look seed"), PLACE, STYLE (added to every picture),
     VOICE (Piper Hindi/English offline, or Cloudflare Aura English), SOUND (an audio file + tags).
2. **Brief**: e.g. `@arjun subah subah @varanasi ke ghat pe chai peeta hai…` — typing `@` suggests
   library items; unknown handles are flagged. Pick language (हिंदी / English), format, length, narrator.
3. **Direct scene** (5 credits, refunded once if it fails): the local LLM writes a shot list —
   per shot: **visual** description, **camera** move, **narration**, **sound** description,
   **on-screen text**, which library items appear.
4. The worker paints every shot (GPU), voices every line, picks a sound bed from the library by the
   sound descriptions, joins the narration into one track, transcribes it for **karaoke captions**,
   and builds an **editor draft**. The storyboard shows pictures + narration + sound + camera per shot.
5. **Open in Editor** → everything is on the timeline, editable by hand → Render MP4.

## Engines (scripts/local-ai)
| Job | Engine | Model | Measured on this laptop (Ryzen 7 170, RTX 3050 4 GB) |
|---|---|---|---|
| Director | llama.cpp `llama-server` (CPU, 8 physical cores) | Qwen3-4B-Instruct-2507 Q4_K_M (Apache-2.0) | ~35–45 s per shot list (~14.6 tok/s) |
| Pictures | stable-diffusion.cpp (Vulkan, NVIDIA) | DreamShaper 8 (SD 1.5) + LCM-LoRA, 6 steps | ~12–13 s per 512×768 picture |
| Voice | Piper | hi_IN rohan / pratham / priyamvada, en_US lessac | 7.6 s of Hindi in 0.7 s |
| Speech-to-text | whisper.cpp | large-v3-turbo q5_0 | 7.7 s of Hindi in ~11–13 s; word-accurate on Piper Hindi |
- `install.sh`: user-space only (no sudo), resumable downloads, ~5.5 GB in `~/.local/share/ams-ai`.
- `start.sh [start|stop|restart|status]`: LLM on :8081, gateway (`gateway.py`, stdlib only) on :8082.
  Both require `LOCAL_AI_TOKEN` (random, in the gitignored `.env`). Containers reach them via
  `host.docker.internal` (`extra_hosts: host-gateway`). Voices are whitelisted (never a path),
  engines run with fixed argv (no shell), one GPU job at a time.
- Transcription prefers local whisper (no quota) and falls back to Cloudflare; voices route by id.

## End-to-end (real browser, real local AI, Docker stack)
Library (character, place, Hindi narrator) → brief with @ suggestions → **READY in ~136 s**
(script 37 s, 4 pictures ~12 s each, voice, captions) → Open in Editor → render 15 s 1080×1920 in
~6 s. Whisper on the FINAL MP4 hears the Hindi narration correctly. No console errors.

## Found and fixed while testing
- Director writes `zoomin`; editor expects `zoom-in` → every scene would have failed to open (caught by
  an integration test that validates the draft with the editor's own schema).
- Character drifted between shots → identity descriptions now go FIRST in the picture prompt (SD 1.5
  weights the start; ~75-token window), same seed for every shot of a character.
- SD defaults to East-Asian looks for "street with signs" → director told to name the culture.
- `pickSound` gave music a bonus even with zero matches → unrelated music chosen. Fixed + tested.
- Hindi captions rendered as boxes **in Docker only**: Alpine has no fontconfig fonts, so libass
  could not fall back to Noto Devanagari. The image now registers `/app/assets/fonts` with fontconfig
  and the build FAILS if Noto Devanagari isn't found.
- Cloudflare free quota (10k neurons/day) ran out during testing → the local engines make scenes
  independent of it.

## Honest limits
- Pictures are still images with camera motion (Ken Burns), not generated video: text-to-video
  needs ≥ 8 GB VRAM and minutes per second of video on this GPU.
- Character consistency is close, not exact (same description + seed). Next step if needed:
  IP-Adapter / a reference image per character.
- Piper Hindi voices are clear but flat (not emotional). Paid voices (ElevenLabs etc.) would be the upgrade.
- The local LLM is 4B: scripts are short and simple; occasional awkward Hindi phrasing.
- First scene after starting the engines is slower (models load into memory/VRAM).
