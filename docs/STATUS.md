# Status & Next Steps (handoff)

_Last updated: 2026-10-12_

## Where things stand
| Branch | Commit | Contents |
|---|---|---|
| `main` | `d6f2f00` | Phase 0: scaffold (api, web, compose, CI) |
| `feat/auth-credits` | `b0ed49d` | Phase 1: auth + atomic credit ledger (on top of main) |
| `feat/observability` | `4e6e118` | Logging, request ids, Prometheus metrics, benchmarks, coverage, bundle budget, native bcrypt (on top of Phase 1) |

- Everything is committed locally. **Nothing is pushed yet**: the gh token was missing the `workflow` scope.
- Local stack: `docker compose up -d` (postgres :5433, redis :6379, Silo/MinIO :9000/:9001). Migrations applied to the dev DB and the test DB (`ai_media_studio_test`).

## Owner to-do (manual, in this order)
1. **Docker without sudo.** The user is already in the `docker` group. Log out and back in (or reboot), then run `groups` (should list `docker`) and `docker ps` (no permission error).
2. **Restart the stack.** Run `cd ~/ai-media-studio && docker compose up -d && docker compose ps -a`. postgres/redis/minio should be `healthy`, and `minio-init` should be `Exited (0)`.
3. **GitHub push:**
   ```
   gh auth refresh -h github.com -s workflow    # enter code at github.com/login/device -> Authorize -> wait for "Congratulations"
   gh auth status                               # scopes must include 'workflow'
   git push -u origin main feat/auth-credits feat/observability
   ```

## Agent next steps (after the push)
1. Open PRs: `feat/auth-credits` → `main`, then `feat/observability` → `main`. Check the first real CI run and fix whatever only shows up in CI.
2. Merge once green.
3. Phase 2: generation + jobs (BullMQ worker, OpenRouter stub mode, Silo/S3 upload, credit reserve/refund, gallery UI). Start with `specs/04_generation_spec.md`.

## Pending verification
- Native bcrypt prebuild inside `node:22-alpine` (musl). Check in Phase 4.
