# 02 — Auth + Credits (Phase 1) — Spec

## What
1. Users can **register, log in, log out** and fetch **who am I**.
2. Every user has a **credit balance**. New users get a **signup bonus**.
3. Every change to a balance is recorded in an append-only **credit ledger** (`CreditTransaction`).
4. A **credit service** with `grant` and `debit` that can never take a balance below zero, even under concurrent requests. Phase 2 (generation) will call it.
5. UI: login + register pages, a protected **dashboard shell** (sidebar + top bar), credit balance card, transaction history table.

## Why
- Auth is the base for everything else: jobs, assets and payments all belong to a user.
- Credits are the product's "money". They must be **correct under concurrency** and **auditable** (every +/- explained by a row).

## Data model changes (Prisma)
```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique          // stored lower-cased
  passwordHash String
  credits      Int      @default(0)      // current balance (cached total of the ledger)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  transactions CreditTransaction[]
}

enum CreditReason { SIGNUP_BONUS  PURCHASE  GENERATION  REFUND }

model CreditTransaction {
  id           String       @id @default(uuid())
  userId       String
  delta        Int                         // +grant / -debit, never 0
  reason       CreditReason
  balanceAfter Int                         // balance right after this row: makes audits trivial
  refId        String?                     // e.g. jobId / paymentId (Phase 2/3)
  createdAt    DateTime     @default(now())
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
}
```
Plus a DB `CHECK (credits >= 0)` constraint as a last line of defence.

**Why balance on `User` *and* a ledger?** Reading a balance must be cheap (one column). The ledger is the audit trail. Both are written in the **same DB transaction**, so they can't drift apart.

## Endpoints
| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/auth/register` | – | `{ email, password }` | 201 `{ user }` + sets cookie |
| POST | `/auth/login` | – | `{ email, password }` | 200 `{ user }` + sets cookie |
| POST | `/auth/logout` | – | – | 204, clears cookie |
| GET | `/auth/me` | ✔ | – | 200 `{ user }` |
| GET | `/credits` | ✔ | `?limit=` (1–100, default 20) | 200 `{ balance, transactions[] }` |

`user` = `{ id, email, credits, createdAt }` and **never** includes `passwordHash`.

Validation (Zod): email is a valid email, trimmed + lower-cased. Password is 8–72 chars. 72 is bcrypt's input limit; anything longer would be silently truncated, so we reject it.

Errors share one JSON shape: `{ error: string, details?: object }`.
- 400 validation · 401 not logged in / bad credentials · 409 email taken · 429 rate limited · 500 unexpected (no stack trace leaked)

## Security decisions
- **JWT in an httpOnly cookie** (`token`). JavaScript can't read it, so an XSS bug can't steal it. Cookie flags: `SameSite=Lax`, `Secure` in production, `Path=/`, 7-day expiry (same as the JWT `exp`).
- **CSRF:** `SameSite=Lax` stops cross-site POSTs from carrying the cookie, and the API only accepts `application/json` bodies (a plain HTML form can't send those). That's enough for this project. Logged as a trade-off.
- **bcrypt** with cost 12. We use `bcryptjs` (pure JS, same algorithm). It avoids native compilation inside Alpine Docker images. Logged as a deviation.
- **Same error for "no such email" and "wrong password"** (`Invalid email or password`), so attackers can't discover which emails are registered. Login always runs one bcrypt compare, even when the user doesn't exist, so response timing doesn't leak it either.
- **Rate limiting** on `/auth/*` (express-rate-limit): 20 requests / 15 min / IP, to slow down password guessing.
- **helmet** for standard security headers.
- `JWT_SECRET` must be at least 32 chars and is validated at boot.

## Credit rules
- Signup bonus = `SIGNUP_BONUS_CREDITS` env (default **50**). It's granted in the **same transaction** as user creation, so you can't end up with a user who has no bonus.
- `debit(userId, amount, reason, refId)` uses a **conditional atomic update**:
  `UPDATE "User" SET credits = credits - $amt WHERE id = $id AND credits >= $amt`.
  If 0 rows are updated → `InsufficientCreditsError`. Postgres row locking serialises concurrent updates, so two parallel debits can't both pass a stale balance check (the classic *check-then-act* race).
- `grant(userId, amount, reason, refId)` → increments the balance plus a ledger row, in one transaction.

## Acceptance criteria
- [x] Register → 201, cookie set, balance 50, one `SIGNUP_BONUS` ledger row.
- [x] Duplicate email (case-insensitive) → 409.
- [x] Login with a wrong password and login with an unknown email → identical 401 body.
- [x] `/auth/me` and `/credits` → 401 without a cookie, 200 with one. A tampered or expired token → 401.
- [x] Logout clears the cookie.
- [x] **Concurrency test:** a user with 50 credits fires 10 parallel debits of 10. Exactly 5 succeed, the balance ends at 0, and the ledger sum equals the balance.
- [x] Response bodies never contain `passwordHash`.
- [x] Integration tests run against a **real Postgres** locally. CI `services:` is configured; its first real run happens once pushed.
- [x] UI: register → lands on the dashboard showing 50 credits + the bonus row. Logout → back to login. Protected routes redirect when logged out.
- [x] api + web typecheck / lint / test / build green.
