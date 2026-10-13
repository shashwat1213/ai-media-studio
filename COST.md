# AWS cost: what runs, what it costs, how to stop it

Region `ap-southeast-2` (Sydney), the AWS project's selected Region. Prices are **approximate on-demand list prices** (USD, Sydney,
checked 2026-10) and change. Your real numbers are in **AWS Billing → Cost Explorer**, filtered by the tag
`Project = ai-media-studio` (every resource carries it).

New accounts get **$100–200 in Free Tier credits** (6–12 months), which covers a few months of
the "running" column below. Credits are not unlimited, so pause when you're not demoing.

## Monthly estimate

| Resource | Running 24×7 | Paused (`down.sh`) | Notes |
|---|---|---|---|
| Fargate `app` (0.25 vCPU, 0.5 GB) | ~$11 | $0 | nginx + api |
| Fargate Spot `worker` (0.25 vCPU, 0.5 GB) | ~$4 | $0 | Spot ≈ 70% off |
| Fargate `redis` (0.25 vCPU, 0.5 GB) | ~$11 | $0 | instead of ElastiCache (~$13) |
| Public IPv4 on tasks (3 × $0.005/h) | ~$11 | $0 | AWS bills every public IPv4 |
| Internal ALB | ~$19 | **~$19** | bills hourly while it exists, even with no traffic |
| RDS db.t4g.micro + 20 GB gp3 | ~$20 | ~$3 (storage) | stopped RDS auto-starts after 7 days |
| S3, ECR (≤10 images/repo), CloudWatch Logs (7 days) | <$1 | <$1 | |
| CloudFront | ~$0 | $0 | free tier: 1 TB + 10M requests/month |
| SSM Parameter Store (standard) | $0 | $0 | |
| **Total** | **~$75** | **~$23** | |
| **Destroyed** (`terraform destroy`) | | **~$0** | only the tiny Terraform-state bucket remains |

**Rule of thumb:** demo → `up.sh`; done → `down.sh`; not demoing this week → `terraform destroy`.
A redeploy from scratch is `terraform apply` + re-run the Deploy workflow (~20 min).

## Guardrails already in place
- **AWS Budgets** email at 50% actual and 100% forecast of `monthly_budget_usd` (set `budget_alert_email` in `terraform.tfvars`).
- No NAT Gateway (~$33/mo/AZ), no Multi-AZ RDS, no Container Insights, no WAF, no storage autoscaling.
- `AI_PROVIDER=stub` by default: generations cost $0. The live smoke test **skips generation** when the paid provider is on.
- ECR keeps the 10 newest images per repo; logs expire after 7 days.

## Commands
All from the repo root, with the AWS CLI logged in to the right account (`aws sts get-caller-identity`).

```bash
# Status: URL, live image tag, RDS state, task counts, health
scripts/aws/status.sh

# Pause: services -> 0 tasks, RDS stopped. Leaves the ALB + storage (~$20/mo).
scripts/aws/down.sh

# Resume the last deployed version (starts RDS, migrates, starts services; ~8 min)
scripts/aws/up.sh

# Delete EVERYTHING (DB data and generated images included, by design: teardown_friendly = true)
cd infra/terraform && terraform destroy

# ...and, if you're done with AWS for good, the state bucket too (it has prevent_destroy):
#   aws s3 rm s3://ams-tfstate-<account-id> --recursive   (+ delete object versions in the console)
#   then remove `prevent_destroy` in infra/bootstrap/main.tf and `terraform destroy` there.
```

## Turning on real AI images (paid)
OpenRouter charges per image ($0.007–0.03, see `specs/04_generation_spec.md`). Set a spend limit
on the OpenRouter key first.

```bash
aws ssm put-parameter --name /ams/prod/OPENROUTER_API_KEY --type SecureString --overwrite --value 'sk-or-...'
# then set ai_provider = "openrouter" in infra/terraform/terraform.tfvars
cd infra/terraform && terraform apply      # new task-definition revisions with AI_PROVIDER=openrouter
```
The key never touches git, Terraform files or GitHub. Terraform creates the parameter with a
placeholder and ignores its value afterwards.
