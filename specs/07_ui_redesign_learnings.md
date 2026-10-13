# 07 — Studio UI redesign + free real AI (Cloudflare) — Learnings

## What got built
**Free real AI images: Cloudflare Workers AI provider**
- `providers/cloudflare.ts`: `POST /client/v4/accounts/{id}/ai/run/@cf/black-forest-labs/flux-1-schnell` with `{ prompt, steps }`, base64 image back.
- `AI_PROVIDER=cloudflare` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`. Missing either → stub (and the env schema refuses to boot), same "never call a real provider by accident" rule as OpenRouter.
- Per-provider model catalogs (`catalogFor(mode)`): Cloudflare offers **FLUX.1 Schnell** (4 steps, 2 credits) and **FLUX.1 Schnell HQ** (8 steps, 4 credits). Models declare their own `aspectRatios`; flux-1-schnell is square-only, so the API rejects 16:9 for it and the UI only shows 1:1.

**UI: "studio black" redesign (Higgsfield-inspired)**
- Tokens only (`index.css`): near-black canvas, charcoal surfaces, electric-violet accent, Geist + Geist Mono, glass / glow / spotlight / shimmer / aurora utilities.
- New public **landing page** at `/` when logged out: aurora hero, a typewriter "composer", an infinite marquee of style tiles, feature cards with a pointer-following spotlight.
- **Split-screen auth** (brand panel + form).
- **Floating glass nav** with a spring-animated active pill; **bottom tab bar** on phones; route transitions.
- **Composer** (Generate): one prompt box with the controls docked inside (model dropdown with prices, ratio chips with a sliding pill, "Surprise me", live cost on the send button), sticky under the nav, Ctrl/Cmd+Enter.
- **Results feed**: masonry; running jobs show a shimmering "developing" card with a pulse; finished images fade in from blur; hover actions (remix, open, download); failures show the reason + "credits refunded".
- **Gallery**: masonry that respects each image's aspect ratio; **lightbox** with ←/→ keyboard navigation, remix, download, copy, delete.
- **Dashboard**: big create card with glow, credit stats, recent strip, ledger.

## Verified
- API: typecheck, lint, **93 tests** (+10 Cloudflare: request shape, `:hq` → same upstream model with steps 8, quota-exhausted → permanent + friendly message, 5xx/401/400 mapping, provider detail never shown to users, `success:false` handling, network error, MIME sniffing, provider selection, boot refusal, catalog API + ratio validation + pricing).
- Web: typecheck, lint, build; **initial JS 102 kB gzip (budget 120 kB)**: the landing page is its own lazy chunk.
- Headless Chrome tour (desktop 1440 + mobile 390): landing, register, dashboard, generate (4 prompts incl. `[fail]`), model menu, gallery, lightbox + arrow-key nav. No page errors; **no horizontal overflow** on any mobile page. The only console error was an expected 429 (4th parallel job hit the 3-active-jobs cap) that the UI shows as a toast.

## Decisions & trade-offs
1. **Why Cloudflare, not OpenRouter, for "free":** checked OpenRouter's live model list on 2026-10-13: every `:free` model is text-only, every image model is paid. Cloudflare's Workers AI free allocation (10,000 Neurons/day, no card) covers ~170 flux-1-schnell images/day at 4 steps (4.8 neurons/tile × 4 tiles + 9.6/step). Pollinations needs no key at all but adds rate limits and its own terms; Cloudflare is an account you control, with a dashboard showing usage.
2. **Quota exhaustion is a permanent error, not a retry.** Retrying a 429 caused by an exhausted daily allocation can't succeed until 00:00 UTC; three retries would only delay the refund. The user gets "Today's free image quota is used up" + their credits back.
3. **Model variants (`:hq`) are ours, not the provider's.** Same upstream model, different `steps`. `upstreamModelId()` strips the suffix. This keeps credits honest (twice the steps ≈ twice the neurons ≈ twice the credits).
4. **Per-model aspect ratios.** A global ratio list would let users pick 16:9 for a square-only model and silently get a square. The model declares what it supports; the API validates it; the UI only offers it.
5. **Landing page honesty.** The hero badge says "Powered by FLUX" only when the server really runs Cloudflare; style tiles are CSS gradients, not fake "AI samples".
6. **Motion budget.** All ambient animation is CSS transform/opacity (GPU-composited); the spotlight writes CSS variables on pointermove (no React re-render); everything honours `prefers-reduced-motion`.
7. **Dark only.** A creative tool where images are the content reads best on black (Higgsfield, Midjourney, Krea all do this); one theme halves the design surface.
