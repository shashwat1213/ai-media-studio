# 00_PROJECT_BASE.md
### Master context & build spec for the AI coding agent (Hermes / Claude Code)
> Give this file to the coding agent ONCE at the start. It is the single source of truth for the project. Follow the Spec-Driven Workflow (Section 10) and the Honesty Guardrails (Section 12) for every change.

---

## 1. Project Identity

- **Working name:** AI Media Studio (a scoped-down, honest clone inspired by Higgsfield / "Pixovid")
- **One-line:** A credit-based AI media-generation SaaS where a user signs up, buys credits, submits a text prompt, and the backend calls an AI model (via OpenRouter) to generate an image/short asset, stores it in S3-compatible storage, and tracks every job and credit transaction.
- **Primary learning goals for the builder (in priority order):**
  1. **Docker** — containerize a real multi-service app properly (NOT a toy).
  2. **CI/CD** — a real GitHub Actions pipeline that tests → builds an image → pushes to a registry → deploys to AWS.
  3. **AWS deployment** — run the containerized app on AWS (ECS Fargate + RDS + S3).
  4. **Backend depth** — async job queues, credit/usage metering, 3rd-party API integration.
  5. **Modern frontend** — a clean dashboard UI.
- **Why this project exists:** It is the builder's 2nd portfolio project, meant to prove Docker + CI/CD + AWS + genuine AI integration with real, defendable engineering. It is NOT meant to be a commercial product.

---

## 2. Who Is Building This (context so the agent calibrates)

- **Builder:** Shashwat Jain — CS graduate (B.Tech CSE, AI & ML, UPES), pursuing Scaler's SE program. Backend-focused, comfortable with Node.js/Express, PostgreSQL, Prisma, React. Currently learning AWS, Docker in depth, and Spring Boot separately.
- **Builder's 1st project (for stack consistency):** "The Living Canvas PMS" — React + TS + Express + PostgreSQL + Prisma + JWT auth + RBAC + GitHub Actions CI + Docker. **Reuse the same conventions so this project feels consistent and the builder can explain it.**
- **Experience level:** Early-career. The agent must **teach while building** — explain every non-obvious decision in plain terms, because the builder must be able to defend every line in a job interview.

---

## 3. Scope — IN vs OUT (read carefully, do not over-build)

The source inspiration (Pixovid) is a huge, expensive platform. We deliberately **cut the expensive/complex parts** and keep the real engineering.

### ✅ IN SCOPE
- User auth (email + password, JWT) and sessions.
- **Credit system**: users start with free credits, can "buy" more (Razorpay **test mode** only), every generation deducts credits.
- **AI generation (cheap only):** text → image via **OpenRouter** (pick the cheapest available image model). Optionally one cheap text→short-clip later.
- **Async job queue**: generation runs as a background job (BullMQ + Redis), not inline in the HTTP request.
- **Object storage**: generated assets saved to **MinIO locally**, **AWS S3 in production** (S3-compatible, same SDK).
- **Dashboard UI**: login, credit balance, submit prompt, see job status (queued/processing/done/failed), gallery of generated assets, credit transaction history.
- **Full Docker setup** + **CI/CD** + **AWS deployment** (the whole point).

### ❌ OUT OF SCOPE (do NOT build — too expensive / not defendable for a fresher)
- GPU-hosted models, **FaceFusion / face-swapping**, self-hosted inference.
- Long-form video stitching, multi-track timeline editor, the "Bake" render pipeline, FFmpeg aggregation.
- Kubernetes (use ECS Fargate instead — simpler, still real).
- Anything costing real money per run. Keep every external call on the cheapest tier; default to mock/stub mode when no API key is set.

---

## 4. Reference Material (where this design comes from)

### 4a. Source lesson — "Building Higgsfield from Scratch" (Harkirat Singh / Pixovid)
Key ideas we ARE borrowing:
- **Spec-driven development**: every decision logged into numbered markdown spec files. (We adopt this fully — Section 10.)
- **Architecture shape**: React frontend + Express/TS backend + PostgreSQL/Prisma + S3-compatible object storage + OpenRouter as a unified AI model router.
- **Credit system + asymmetric pricing**: cheap ops cost few credits, heavy ops cost many.
- **Async job queueing** to avoid HTTP gateway timeouts on long AI calls.
Ideas we are NOT borrowing (see Section 3 OUT): GPU face-swap, long-form video, bake pipeline, Kubernetes.

### 4b. Mindmap (builder-provided) — "Video Mind Map"
The mindmap describes the FULL Pixovid long-form video export pipeline:
- Master Audio Track Integration (45MB max audio, full template sync)
- Multi-Track Timeline Clips (parallel layers; 4/5/6/8s blocks; drag + crop; clip properties)
- Start/End Frame Face Swaps (Avatar 1/2; FaceFusion local; Flux 2 paid)
- Bake Feature Rendering (single-block render; OpenRouter execution; DB caching of baked keys)
- FFmpeg Stitching & Export (reuse baked blocks; sequential merge; AI thumbnail)
**→ This entire pipeline is OUT OF SCOPE for our build.** It is kept here only as reference for what the original does and what we deliberately simplified. If the builder later wants to extend, the "job + storage + credits" foundation we build is exactly what that pipeline would sit on top of.

### 4c. YouTube reference
`https://youtu.be/LuCXiNxZ1Dw` — same Higgsfield-from-scratch walkthrough. (Could not be auto-read at build time; the lesson text + mindmap above cover the same content.)

---

## 5. Tech Stack (fixed — do not substitute without logging a reason)

**Backend**
- Node.js + **Express** + **TypeScript** (strict mode)
- **PostgreSQL** + **Prisma ORM**
- **Redis** + **BullMQ** (async job queue)
- **JWT** auth (httpOnly cookies), bcrypt password hashing
- **Zod** for request validation
- **AWS SDK v3** (S3 client; points at MinIO locally, S3 in prod)
- **OpenRouter** API (AI generation; cheapest model; stub mode when no key)
- **Razorpay** (test mode) for credit purchase

**Frontend / UI**
- **React + TypeScript + Vite**
- **Tailwind CSS**
- **shadcn/ui** (+ **Radix UI**, **lucide-react** icons) — primary component system
- **TanStack Query (React Query)** — server state, loading/caching, job-status polling
- **React Hook Form + Zod** — forms + validation
- **Framer Motion** — subtle animations/transitions only
- Do NOT add Material UI / Chakra / Ant Design (conflicts with shadcn). No Three.js (not needed here).

**Infra / DevOps (the learning focus)**
- **Docker** + **docker-compose** (multi-service)
- **GitHub Actions** (CI/CD)
- **AWS**: **ECR** (image registry), **ECS Fargate** (run containers), **RDS PostgreSQL**, **S3** (assets), **Secrets Manager/SSM** (secrets), optional **CloudFront** for the frontend.

---

## 6. Architecture

```
[ React (Vite) dashboard ]  --->  [ Express/TS API ]  --->  [ PostgreSQL (Prisma) ]
                                        |      |
                                        |      +--> enqueue job --> [ Redis + BullMQ ] --> [ Worker ]
                                        |                                                      |
                                        |                                        calls OpenRouter (AI)
                                        v                                                      |
                                   [ S3 / MinIO ] <------------------ worker uploads result ---+
```

### 6a. Data model (Prisma — starting point)
- **User**: id, email, passwordHash, createdAt
- **CreditBalance** (or field on User): userId, credits
- **CreditTransaction**: id, userId, delta (+/-), reason (signup_bonus | purchase | generation), createdAt
- **GenerationJob**: id, userId, type (image), prompt, model, status (QUEUED|PROCESSING|DONE|FAILED), creditsCost, resultAssetId?, error?, createdAt, updatedAt
- **Asset**: id, userId, jobId, storageKey (S3/MinIO key), mimeType, createdAt
- **Payment** (test): id, userId, razorpayOrderId, amount, creditsGranted, status

### 6b. Core API endpoints
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /credits` (balance + transactions)
- `POST /payments/create-order`, `POST /payments/verify` (Razorpay test)
- `POST /generate` → validates, checks credits, **enqueues a job**, returns jobId (202)
- `GET /jobs/:id` (status — frontend polls this via React Query)
- `GET /assets` (user's gallery), `GET /assets/:id` (signed URL)

### 6c. Job flow (the important backend story)
1. `POST /generate` → check credits → create `GenerationJob(status=QUEUED)` → add BullMQ job → return 202 + jobId.
2. **Worker** picks it up → set PROCESSING → call OpenRouter → download result → upload to S3/MinIO → create Asset → deduct credits (CreditTransaction) → set DONE (or FAILED + refund credits).
3. Frontend polls `GET /jobs/:id` with React Query until DONE/FAILED, then shows the asset.
> Credits are only deducted on success; on failure, refund. Log this decision.

---

## 7. DOCKER — deep focus (LEARNING GOAL #1)

The builder must understand, not just copy. Build this in stages and explain each.

### 7a. Images to create
- **Backend Dockerfile** — multi-stage: `deps` → `build` (tsc) → slim `runtime` (node:20-alpine, non-root user, only prod deps + compiled dist). Explain why multi-stage (smaller, safer image).
- **Worker** — reuse the backend image with a different start command (`node dist/worker.js`), OR a separate target. Explain the choice.
- **Frontend Dockerfile** — multi-stage: build with Vite → serve static with nginx:alpine. Explain why nginx for static.

### 7b. docker-compose.yml (local dev — one command up)
Services: `api`, `worker`, `postgres`, `redis`, `minio`, `frontend`.
- Named volumes for postgres & minio data (explain persistence).
- `.env` for config; never bake secrets into the image.
- `depends_on` + healthchecks so api waits for postgres/redis.
- MinIO console exposed locally for the builder to see uploaded files.

### 7c. Docker best practices to teach (and apply)
- `.dockerignore` (node_modules, .git, .env) — explain layer caching.
- Pin base image versions. Run as non-root. Keep final image small (compare image sizes before/after multi-stage — this is a real resume metric).
- One process per container (api vs worker split).

### 7d. Learning checkpoint — builder must be able to answer:
- What does each Dockerfile stage do and why multi-stage?
- Image vs container vs volume? Why named volumes for the DB?
- Why is the worker a separate container from the API?
- How do services find each other in compose (service-name DNS)?

---

## 8. CI/CD — deep focus (LEARNING GOAL #2)

Build the pipeline incrementally. Start with CI (tests), then add CD (deploy).

### 8a. Stage 1 — Continuous Integration (`.github/workflows/ci.yml`)
On every push / PR:
- Checkout, setup Node, install, `tsc --noEmit` (type-check), `eslint`, run tests (Vitest/Jest) **against a real Postgres + Redis service container** (GitHub Actions `services:`), `npm run build`.
- Build the Docker images to confirm they build (don't push yet).
> This mirrors the builder's PMS CI, extended. Explain `services:` containers in Actions.

### 8b. Stage 2 — Continuous Deployment (`.github/workflows/deploy.yml`)
On push to `main` (after CI passes):
- Configure AWS credentials (GitHub OIDC → IAM role; explain why OIDC > long-lived keys).
- Build images → tag with git SHA → **push to Amazon ECR**.
- Update the **ECS Fargate** service to the new image (force new deployment). Explain rolling deployment.
- Run Prisma migrations against RDS as a one-off task (explain migration-on-deploy safety).

### 8c. Secrets
- GitHub: store AWS role ARN / region as repo secrets/vars.
- Runtime: DB URL, JWT secret, OpenRouter key, Razorpay keys → **AWS Secrets Manager / SSM**, injected into the ECS task. **Never commit secrets.**

### 8d. Learning checkpoint — builder must be able to answer:
- Difference between CI and CD?
- What is ECR and why push images there vs building on the server?
- How does the ECS service roll out a new image without downtime?
- Why OIDC federation instead of storing AWS access keys in GitHub?
- Where do runtime secrets live and how do they reach the container?

---

## 9. AWS Deployment Topology (production)

- **ECR**: stores `api`/`worker`/`frontend` images.
- **ECS Fargate**: service for `api`, service for `worker` (serverless containers; no EC2 to manage).
- **RDS PostgreSQL**: managed DB (free-tier instance).
- **ElastiCache Redis** *(or a small Redis container to start — note the cost trade-off and log the decision).*
- **S3**: generated assets bucket (+ optional CloudFront for the frontend static build).
- **Secrets Manager / SSM**: all runtime secrets.
- **IAM**: least-privilege roles for ECS tasks (S3 access scoped to the one bucket) and the GitHub OIDC deploy role.
- **Cost guardrails (MUST tell the builder):** stay on free tier; **stop/delete RDS, ECS services, ElastiCache when not demoing** — these bill hourly. Add a short `COST.md` with teardown commands.

---

## 10. Spec-Driven Workflow (how the agent must work — borrowed from the source lesson)

- Keep a `/specs` folder. This file is `00_PROJECT_BASE.md`.
- **Before** building a feature, write `NN_<feature>_spec.md` (what, why, data model changes, endpoints, acceptance criteria). Get it right on paper first.
- **After** completing it, append `NN_<feature>_learnings.md` (what changed, decisions, trade-offs, anything the builder should be able to explain). This keeps the agent's context clean and gives the builder an interview-ready decision log.
- Commit in small, labelled steps. Conventional commits (`feat:`, `fix:`, `chore:`, `ci:`).
- One feature branch at a time; open a PR so CI runs.

---

## 11. Build Phases (~2 weeks, adjustable)

**Phase 0 — Scaffold (Day 1–2)**
- Monorepo (or two folders: `/api`, `/web`). Express+TS boot, Prisma init, health route. React+Vite+Tailwind+shadcn boot. First `docker-compose up` with postgres+redis+minio. CI (type-check+lint+build) green.

**Phase 1 — Auth + Credits (Day 3–4)**
- Register/login/JWT, credit balance + transactions, signup bonus. UI: auth pages + dashboard shell (shadcn). Tests for auth + credit deduction logic.

**Phase 2 — Generation + Jobs (Day 5–7)**
- OpenRouter integration (with stub mode), BullMQ worker, `POST /generate` → job → S3/MinIO upload → asset. UI: prompt form (RHF+Zod), job-status polling (React Query), gallery. Credit deduct/refund logic.

**Phase 3 — Payments (Day 8)** *(optional)*
- Razorpay test order + verify → grant credits.

**Phase 4 — Dockerize fully (Day 9–10)**
- Multi-stage Dockerfiles (api/worker/frontend), harden compose, `.dockerignore`, image-size pass. **Learning checkpoints §7d.**

**Phase 5 — CI/CD + AWS (Day 11–14)**
- Finish CI with service containers. Provision AWS (ECR, RDS, S3, ECS, secrets). `deploy.yml`: build→ECR→ECS, migrations, OIDC. Live URL. `COST.md` teardown. **Learning checkpoints §8d.**

> After each phase: write the `_learnings.md`, commit, and make sure CI is green before moving on.

---

## 12. Honesty Guardrails (NON-NEGOTIABLE)

- The builder must be able to **explain every feature in an interview.** If a piece is too advanced to explain yet, the agent must pause and teach it (plain language + the "why"), not just generate and move on.
- **Real metrics only** on the resume later (image size reduction, number of services, CI steps, routes). **No invented user/traffic/revenue numbers.**
- Prefer clarity over cleverness. Standard patterns the builder can reason about beat exotic ones.
- Keep everything cheap/free; default external AI/payment calls to stub/test mode unless keys are explicitly provided.
- If a decision deviates from this spec, log the reason in a `_learnings.md` entry.

---

## 13. Resume payoff (what this unlocks — only after it's actually built & deployed)
- **Docker**: multi-stage images, multi-service compose, image-size optimization.
- **CI/CD**: GitHub Actions pipeline building & deploying to AWS on every push.
- **AWS**: ECS Fargate + RDS + S3 + ECR + Secrets Manager + IAM.
- **Backend**: async job queues (BullMQ/Redis), credit/usage metering, 3rd-party API integration.
- **AI integration**: genuine LLM/image generation via OpenRouter (makes "AI-integrated app" true).
- **Modern frontend**: React + shadcn/ui + TanStack Query + RHF/Zod.
