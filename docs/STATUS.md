# Status & Next Steps (handoff)

_Last updated: 2026-10-12 (Phase 4 complete)_

## Where things stand
| Branch | State | Contents |
|---|---|---|
| `main` | pushed, CI green | Phase 0, 1, observability, **Phase 2 (generation)** merged |
| `feat/dockerize` | PR open | **Phase 4: full Docker** (multi-stage images, 8-service compose, CI image build + smoke test) |

Phase 3 (Razorpay payments) was skipped for now. It's optional and can be done any time.

## Run everything in Docker (one command)
```
docker compose up -d --build        # postgres, redis, minio, migrate, api, worker, web
open http://localhost:8080          # the app (nginx -> SPA + /api proxy)
./scripts/smoke.sh                  # end-to-end check through the containers
docker compose down                 # stop (data stays in named volumes)
```
MinIO console: http://localhost:9001 (minioadmin / minioadmin).

## Or run the code natively (fast dev loop)
```
docker compose up -d postgres redis minio minio-init
cd api && npm run dev               # :4000
cd api && npm run dev:worker        # :4001
cd web && npm run dev               # :5173
```
Note: the full Docker stack also binds :4000, so stop the `api` container before `npm run dev`
(`docker compose stop api worker web`).

## Verify commands
```
cd api && npm run typecheck && npm run lint && npm run test:coverage && npm run build
cd web && npm run typecheck && npm run lint && npm run build && npm run size
docker compose up -d --build && ./scripts/smoke.sh
```

## Next steps
1. Merge the Phase 4 PR once CI is green.
2. **Phase 5: CI/CD + AWS.** ECR (push images), ECS Fargate (api + worker services + a one-off migrate task), RDS Postgres, S3, Redis (ElastiCache or a small container, decide on cost), Secrets Manager, GitHub OIDC deploy role, `deploy.yml`, `COST.md` with teardown commands.
   - Needs from the owner: an AWS account + AWS CLI configured. **Stop and ask before creating anything billable.**
3. Phase 3 (payments, optional) whenever wanted.

## Pending verification (future phases)
- "Deployed on AWS" / uptime / cost: Phase 5.
- Image vulnerability scan (Trivy or ECR scanning): Phase 5.
