# Status & Next Steps (handoff)

_Last updated: 2026-10-13 (Phase 5 code complete, not yet applied to AWS)_

## Where things stand
| Branch | State | Contents |
|---|---|---|
| `main` | pushed, CI green | Phases 0, 1, 2, 4 + observability (PR #4 merged 2026-10-13) |
| `feat/aws-deploy` | local, uncommitted | **Phase 5:** Terraform (`infra/`), `deploy.yml`, `scripts/aws/`, CI `infra` job + Trivy, `COST.md`, `TRUST_PROXY_HOPS` fix, npm-free runtime image |

Phase 3 (Razorpay payments) is skipped for now; it's optional.

## Phase 5: what's verified vs. what's waiting
Verified offline: `terraform validate`, checkov (176 passed / 0 failed with justified skips),
Trivy (api + web: 0 fixable HIGH/CRITICAL), 87 API tests, actionlint, and the local compose smoke test.

Waiting on the owner (billable, so it needs an explicit go-ahead):
1. AWS account: root MFA, an admin identity, `aws configure` (the AWS CLI v2 and Terraform 1.16.5
   are installed in `~/.local/bin`).
2. `infra/bootstrap` apply, then `terraform plan` in `infra/terraform`, reviewed, then `apply`.
3. GitHub `production` environment + `AWS_DEPLOY_ROLE_ARN` / `AWS_REGION` repo variables.
4. First deploy (Actions → Deploy), then tick the acceptance criteria in `specs/06_aws_spec.md` and
   add the live numbers to `docs/RESUME_METRICS.md`.
Step-by-step: `infra/README.md`. Costs + teardown: `COST.md`.

## Run locally
```
docker compose up -d --build && ./scripts/smoke.sh     # full stack on :8080
docker compose up -d postgres redis minio minio-init   # infra only, then npm run dev / dev:worker
```

## Verify commands
```
cd api && npm run typecheck && npm run lint && npm run test:coverage && npm run build
cd web && npm run typecheck && npm run lint && npm run build && npm run size
docker compose up -d --build && ./scripts/smoke.sh
terraform -chdir=infra/terraform validate && checkov -d infra --config-file infra/.checkov.yaml
```

## Next steps after the first deploy
- Measure live numbers (latency through CloudFront, deploy duration, rollback drill), add to RESUME_METRICS.
- Phase 3 payments (optional). Redis-backed rate limiter if the app ever runs >1 task.
