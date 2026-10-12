# 02 — Auth + Credits (Phase 1) — Learnings

## What got built
**API**
- `POST /auth/register | /auth/login | /auth/logout`, `GET /auth/me`, `GET /credits?limit=`
- Modules: `src/modules/auth/*` (schemas, service, routes, tokens, `requireAuth`) and `src/modules/credits/*` (service, routes)
- Cross-cutting: central `errorHandler` (Zod → 400, `HttpError` → status, unknown → 500 with no stack trace leaked), `requireJson` (415), `helmet`, auth rate limit
- Migration `20261012074654_auth_credits`: `credits` column, `CreditReason` enum, `CreditTransaction` ledger, plus **hand-written CHECK constraints**

**Web**
- React Router 7 routes: `/login`, `/register` (guest-only), `/` dashboard (auth-required), `*` 404
- `AuthForm` (React Hook Form + Zod, server errors mapped back onto the form), `AppShell` (sidebar, credit pill, account menu with logout)
- Dashboard: balance card + credit-history table (loading skeleton, empty state, error state)
- Route-level code splitting (`React.lazy`), framer-motion fade-ins, sonner toasts

## Verified (real runs, not assumptions)
- **27 API tests** pass against a real Postgres (`ai_media_studio_test` DB). They cover: register/duplicate/validation/415, identical 401 for wrong-password vs unknown-email, tampered / expired / `alg=none` tokens, deleted user, logout, rate limit 429, grant/debit/overdraw, DB CHECK constraint, user scoping of `/credits`, and the concurrency test below.
- **Race proof.** The same 10 parallel debits of 10 credits on a 50-credit balance, run 3 rounds each:
  | Implementation | Succeeded | Final balance |
  |---|---|---|
  | naive (read balance → check → write) | **10 / 10** ❌ | 40 (should be 0; 50 credits of work given away free) |
  | ours (conditional atomic `UPDATE … WHERE credits >= amt`) | **5 / 5** ✅ | 0, and ledger sum = balance |
  The naive version was a throwaway test, deleted after. These are real numbers you can quote.
- **Real server, curl:** 201 register → cookie → `/auth/me` 200 → `/credits` shows the bonus → duplicate 409 → bad login 401 → logout 204 → `/auth/me` 401. Helmet headers present (CSP, HSTS, nosniff).
- **Real browser (headless Chrome, end-to-end through the Vite proxy):** logged-out `/` → `/login`; client validation errors; register → dashboard with 50 credits + "Signup bonus" row + toast; reload keeps the session; cookie is `httpOnly`, `SameSite=Lax`, and **not visible to `document.cookie`**; logout → `/login`; wrong password shows the server error; login works; logged-in `/login` bounces to `/`; 404 page.
  - The only console "errors" are the expected 401s from `/auth/me` while logged out. That's how the app learns "nobody's logged in".
- Bundle: before code splitting, one 690 kB JS chunk (Vite warned). After, the entry chunk is 101.7 kB gzip and each page is its own chunk.

## Decisions & trade-offs (interview material)

**1. Atomic conditional UPDATE instead of read-then-write.**
`UPDATE "User" SET credits = credits - 10 WHERE id = $1 AND credits >= 10`. Postgres evaluates the WHERE and the SET while holding a row lock, so concurrent debits queue up behind each other and each sees the latest value. If 0 rows were updated, the user didn't have enough credits. This is simpler than `SELECT … FOR UPDATE` or SERIALIZABLE isolation and does the same job for a single-row invariant.

**2. Balance column + ledger, written in one transaction.**
The column makes reading the balance O(1). The ledger is the audit trail (`balanceAfter` on each row lets you replay history). A test asserts `SUM(delta) == credits`.

**3. Defence in depth with CHECK constraints.**
`credits >= 0`, `delta <> 0`, `balanceAfter >= 0` are enforced by Postgres itself. Even a future bug, or someone running SQL by hand, can't make a balance negative. Prisma's schema language can't express CHECKs, so we used `--create-only`, edited the SQL, then applied it. This is a normal workflow, and the migration file is the source of truth.

**4. The migration back-fill trick.**
Adding a NOT NULL `updatedAt` column to a table that already has rows fails. We added it with `DEFAULT CURRENT_TIMESTAMP` (which back-fills existing rows), then dropped the default, because Prisma sets it from now on.

**5. JWT in an httpOnly cookie, not localStorage.**
localStorage is readable by any script on the page, so one XSS bug would leak every session. With an httpOnly cookie the browser attaches the token automatically and JS can't read it (verified in the browser test). The trade-off is that cookies bring CSRF risk, which we handle with `SameSite=Lax` + JSON-only write endpoints (415 otherwise), because an HTML form can't send `application/json`.

**6. Stateless JWT means logout can't revoke a stolen token.**
Logout clears the cookie, but a copied token stays valid until `exp` (7 days). Mitigations if needed later: shorter TTL + refresh tokens, or a `tokenVersion` column checked on each request. Out of scope for now. *Know this limitation; interviewers ask.*

**7. No account enumeration.**
Wrong password and unknown email return byte-identical 401 bodies, and login always runs one bcrypt compare (against a dummy hash if the user doesn't exist), so response timing doesn't leak which emails exist either.

**8. Algorithm pinning.**
`jwt.verify(..., { algorithms: ['HS256'] })`. Without it, an attacker could submit an `alg: none` token. There's a test for exactly that.

**9. Unique constraint instead of "check if email exists, then insert".**
Two simultaneous signups with the same email would both pass a check. The DB unique index makes one of them fail (`P2002` → 409). It's the same check-then-act lesson as credits.

**10. Real DB in tests (separate database).**
Mocking Prisma can't catch a broken migration, a missing constraint or a race condition. Tests use `ai_media_studio_test`, run `prisma migrate deploy` first (the same command prod will use), and `TRUNCATE` between tests. CI gets its own Postgres via `services:`.

**11. Express 5.**
Async route handlers that throw are forwarded to the error handler automatically. In Express 4 you'd need `try/catch` + `next(err)` in every handler, or a wrapper library.

## Deviations from 00_PROJECT_BASE (§12)
- **`bcryptjs` instead of native `bcrypt`.** Same algorithm and hash format, but no native compilation. Native `bcrypt` needs python/make/g++ inside Alpine images and breaks across CPU architectures. It's slower in pure JS, which only matters at very high login rates.
- **`credits` column on `User`** (the spec allowed either a column or a separate `CreditBalance` table). Using a column avoids a join and an extra row per user.
- **Credit reasons are an enum** with a `REFUND` value added for Phase 2's reserve/refund flow. (Spec listed lower-case strings without refund.)
- **`402 Payment Required` for insufficient credits.** It's semantically what that status code is for. Phase 2 will use it.
- **`cn` package instead of `clsx` + `tailwind-merge`.** The current shadcn CLI now generates components that import `cn` from the `cn` npm package (by shadcn, ~9M weekly downloads, zero dependencies). We followed the generator instead of fighting it, and removed `src/lib/utils.ts`.
- **`next-themes` removed.** The sonner component imported it, but it's a Next.js-oriented theme helper we don't use. The toaster is fixed to the light theme.

## Known gaps / follow-ups
- The header credit pill reads `user.credits` from `/auth/me`. Once Phase 2 spends credits, invalidate `['auth','me']` and `['credits']` after a job completes.
- Rate limiter state is in-memory, so per-container. With 2+ ECS tasks, move it to Redis (`rate-limit-redis`). Redis arrives in Phase 2 anyway.
- The dev DB contains a few `smoke-*` / `ui-*` test users from manual verification. Harmless.
