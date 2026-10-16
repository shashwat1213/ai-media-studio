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

---

## Voice-over language + follow-the-brief (15 Oct 2026)
- **Language: Auto (default) / English / हिंदी / Hinglish.** Auto = what the brief asks for ("English voice-over",
  "narration in Hindi", "hindi mein", "language: English"; a language next to a voice word wins), else how the brief
  is written (Devanagari → hi, Roman with Hindi words → hinglish, else en). `detectLanguage()` (15 test cases); the web
  mirrors it for a live "Auto → English (asked in the brief)" hint.
- **The narrator always speaks the scene's language.** The API swaps a mismatched voice (e.g. Hindi Rohan on an English
  scene) for the default narrator (`en_US-ryan-high` / `hi_IN-rohan-medium`); the UI lists only matching voices.
  New offline English Piper voices: Ryan (US, high) and Alan (UK); Whisper hears both word-accurate.
- **Follow the brief:** system prompt has hard rules (brief's events/order/characters, one shot per described scene,
  given lines word for word, given sound directions, mood/time/weather, ignore format/role instructions in the brief).
  `briefCues()` pulls `VO:`/`Narrator:` lines, quoted dialogue and `Sound:`/`SFX:`/`Music:` lines and passes them as
  numbered requirements. Pictures: every visual re-describes people in full (the image model has no memory) and never
  asks for readable text. Hindi-written briefs get a small glossary so visuals/sounds come out in English.
- E2E (real Chrome, local AI): English Shimla brief → READY 76 s; Whisper on the final MP4 hears exactly the 3 VO lines
  from the brief; sound = the brief's sound line. Hindi Banaras brief → READY 147 s, Hindi voice + Devanagari captions,
  visuals in English and on-brief (fog, boat, diya).
- Honest limits: the 4B LLM still writes some odd Hindi lines when it has to invent them ("घंटा भी घंटा"); SD 1.5 can
  still drift on a character's look/ethnicity between shots (G1 / reference image will fix that). Lines given in the
  brief are used word for word, so writing your own VO lines gives the best result today.

---

## Music + beat sync (16 Oct 2026)
- **Built-in beds, synthesised by ffmpeg** (`api/src/modules/audio/stock-music.ts`): no files shipped, no licence, no
  download. Music: Dance Pulse 120 bpm, Sunny Pop 104, Lo-fi Chill 84, Cinematic Rise 70. Ambience: rain, ocean, wind,
  city street, night crickets. Each is a deterministic recipe (kick/hat/clap/bass/pad/arp layers) rendered to the
  scene's exact length with fades; ~1.5 s per 20 s of music, ~0.2 s for ambience. Mean levels -15..-21 dB, peaks <= -4 dB.
- `Scene.music` = `auto` (default) / `none` / a track id (migration `scene_music`, + `UploadSource.MUSIC`).
  Auto = tags in the BRIEF + the shots' sound lines ("dancing" -> Dance Pulse, "chai" -> Lo-fi), else the director's mood.
  A music SOUND from the user's own library wins. Ambience only when named (rain, waves, traffic…).
- **Beat sync:** chosen right after planning, before any picture/clip, so shot lengths (and AI-video clip lengths)
  are snapped: `length - 0.5 s crossfade` = whole beat units (1 beat for slow music, 2 beats for >= 100 bpm). Every
  cut lands on a beat; music starts on beat 1 at frame 0. Never re-timed once AI clips exist.
- Music and ambience are separate audio tracks, both ducked under the narration (editor's sidechain).
- E2E (Docker + local AI): English rooftop-dance brief -> READY in ~80 s, Dance Pulse + city ambience picked
  automatically, clips 5.5/5.5/5.5 s (cuts at 0, 5, 10 s = on the beat), render 15.5 s 1080×1920 in ~5 s;
  Whisper on the final MP4 heard all 3 VO lines exactly over the music.
- Tests: +7 (matching, beat unit, snap math, every start on a beat, choice rules, every track renders with real ffmpeg at
  the exact length without clipping, produced scene with music + ambience + retry reuse + `none`). 286 pass,
  stmts 93.2%, branches 83.2%.
- Limits: synthesised music is simple (good bed, not a hit song). No vocals. Real songs = user uploads them as SOUND.

## Templates (16 Oct 2026)
- `web/src/features/director/templates.ts`: Dance reel 💃 (Dance Pulse, Reel, 16 s, Hero shots), Travel vlog 🏝️
  (Sunny Pop, ocean), Chai moment ☕ (Hinglish, Lo-fi, rain), Motivation 🔥 (Cinematic, wind, Hero shots), Product
  showcase 🛍️ (Square, Sunny Pop). Each is a brief in the format the Director follows best (`Scene N:` + `VO:` +
  `Sound:`) plus format / length / music / motion. `{who}` = the chosen library CHARACTER (`@handle`, so the face
  reference + seed apply) or a generic person. Picking a template fills everything; the brief stays editable.
- All 10 variants (5 templates × with/without a character) pass the content policy and detect the intended language
  (EN ×4, Hinglish ×1).
- E2E (real Chrome): Dance reel + star @meera → brief/music/format filled → READY (4 shots, all use @meera, Dance Pulse
  + city ambience, cuts on the beat) → render 15.5 s; Whisper on the final MP4 hears all 4 VO lines exactly.

## Outfits drift towards "glamour" (16 Oct 2026, measured)
- Problem: @meera = "emerald green saree" → 3 of 4 dance shots came out as crop top / bare midriff (SD 1.5 +
  words like dance / night / neon). At LCM cfg 1.5 the negative prompt barely acts.
- Same seed (4242), same 3 shots, 8 variants compared: modesty words at the END = no change; negatives alone at cfg 2 =
  little change; a WEIGHTED prefix `(modestly dressed:1.4), (full-sleeve top covering the stomach:1.3)` + cfg 2 = full
  sleeves and fewer crop tops; describing a kurta/anarkali instead of a saree = fully covered in 3/3.
- Shipped: the prefix + a modesty negative on every shot that shows a person (`showsPerson`: a CHARACTER in the shot, or
  person words in the visual); objects/landscapes untouched (leather-bag shot identical in quality). Gateway cfg 1.5 → 2
  (same 8.4 s per picture).
- Honest result: re-run of the same Dance reel → READY in 95 s, full sleeves in 4/4, but a saree still shows the midriff
  (that's how a saree is worn) and one shot was off-shoulder. For a fully covered look, describe a kurta / anarkali /
  full-sleeve outfit in the character.
