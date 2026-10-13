# 06 — CI/CD + AWS (Phase 5) — Spec

## What
1. **Infrastructure as code** (Terraform, `infra/`) for one production environment on AWS.
2. **Continuous deployment** (`.github/workflows/deploy.yml`): after CI is green on `main`, build the images, push them to ECR tagged with the git SHA, run DB migrations as a one-off ECS task, roll the ECS services to the new images, and smoke-test the live URL.
3. **Cost control**: pause/resume scripts, a budget alert, and `COST.md` with exact teardown commands.

## Why
The project exists to prove Docker + CI/CD + AWS (00_PROJECT_BASE §1). Phase 4 made images CI can build and test; this phase ships the *same* images to a real cloud with no manual steps and no long-lived credentials.

## Topology
```
browser --HTTPS--> CloudFront (*.cloudfront.net, free TLS, caches /assets/*)
                      |  VPC origin (private)
                      v
               internal ALB (private subnets, only CloudFront can reach it)
                      |
                      v
   ECS task "app":  nginx (web image, :8080) --localhost--> api (:4000)
   ECS task "worker": api image, `node dist/worker.js`  (Fargate Spot)
   ECS task "redis":  redis:7.4 (Cloud Map DNS: redis.ams.internal)
   ECS task "migrate" (one-off): `prisma migrate deploy`
        |                    |                    |
   RDS Postgres 16      S3 (private,         SSM Parameter Store
   (private subnets)    presigned GETs)      (DATABASE_URL, JWT_SECRET, ...)
```
Region: `ap-southeast-2` (Sydney), the AWS project's selected Region (new AWS experience: a project can only create resources in its one Region). Two AZs. No NAT Gateway (tasks in public subnets with public IPs; security groups allow no inbound except ALB → app).

## Decisions (details + trade-offs in 06_aws_learnings.md)
| Choice | Over | Because |
|---|---|---|
| Terraform | console clicks / CDK | reproducible, reviewable (`plan`), destroyable in one command; most common IaC in job posts |
| S3 backend + `use_lockfile` | DynamoDB lock table | native S3 locking since TF 1.10; one less resource |
| CloudFront + internal ALB (VPC origin) | public ALB | HTTPS without a domain/cert; ALB has no public address at all |
| nginx + api in one task | separate web service / S3 static site | same image + nginx template as compose; same-origin cookies; one fewer service |
| Redis container on Fargate | ElastiCache | ~$12/mo saved; queue only carries job ids; the sweeper refunds anything lost |
| SSM Parameter Store SecureString | Secrets Manager | free vs $0.40/secret/month; same ECS `secrets` injection |
| Public subnets + SGs | NAT Gateway | NAT is ~$33/mo/AZ before traffic |
| Worker on Fargate Spot | on-demand | ~70% cheaper; the pipeline already tolerates interruption (retries, guarded transitions, sweeper) |
| GitHub OIDC → IAM role | access keys in GitHub secrets | no long-lived credentials; role trusts only this repo's `production` environment |
| Immutable SHA tags | `latest` | a tag always means the same bytes; rollback = redeploy an old SHA |

## Deploy pipeline
1. `workflow_run` after CI succeeds on a push to `main` (or manual `workflow_dispatch`).
2. OIDC → 1-hour AWS session. Read `/ams/prod/DEPLOY_CONFIG` (written by Terraform): GitHub stores only the role ARN + region.
3. Build + push `api`, `migrator`, `web` with tag = commit SHA (BuildKit cache from CI).
4. `scripts/aws/rollout.sh <sha>`: run the `migrate` task; **abort if it doesn't exit 0**; register new task-definition revisions; update services (rolling, circuit breaker with auto-rollback); wait until stable; write the SHA to `/ams/prod/IMAGE_TAG`.
5. `scripts/smoke.sh` against the CloudFront URL (`REMOTE=1`; skips generation if the paid provider is on).
6. If the environment is paused (desired count 0), images are pushed and the tag recorded, but nothing is started.

## Code changes needed
- `TRUST_PROXY_HOPS` env (default 1). On AWS it's 3 (CloudFront → ALB → nginx), so per-IP rate limits key on the real client IP. Tested.
- Runtime image: npm/npx/corepack removed (unused at runtime, carried HIGH CVEs). Unused prisma-CLI deps pruned.
- `scripts/smoke.sh` works against a remote URL.

## Security
- Static scan: **checkov** on `infra/` in CI, every skip justified in `infra/.checkov.yaml`.
- Image scan: **Trivy** (HIGH/CRITICAL, fixed-only) in CI, plus ECR scan-on-push.
- Least-privilege IAM: task role can only Get/Put/Delete `users/*` in the media bucket; the deploy role can push to 3 repos, register task defs, update services in one cluster, run only the migrate family, and pass only the two task roles to ECS.
- RDS: private, encrypted, `sslmode=require`, reachable only from the app SG.
- Third-party GitHub Actions in the deploy job pinned to commit SHAs.

## Acceptance criteria
- [ ] `terraform validate` + checkov pass in CI; Trivy finds no fixable HIGH/CRITICAL.
- [ ] `terraform plan` reviewed by the owner before the first `apply` (it creates billable resources).
- [ ] A push to `main` deploys automatically; the Actions summary shows the live URL.
- [ ] Live smoke test: register → generate (stub) → DONE → PNG via presigned S3 URL → balance 48.
- [ ] A migration failure stops the deploy before any service changes.
- [ ] A broken image rolls back automatically (circuit breaker).
- [ ] `down.sh` → only storage + ALB are billed; `up.sh` restores the same version.
- [ ] `terraform destroy` removes everything (`COST.md`).
