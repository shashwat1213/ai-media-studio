# infra/: AWS infrastructure (Terraform)

Everything the app needs on AWS, as code. Design and trade-offs: `specs/06_aws_spec.md` and
`specs/06_aws_learnings.md`. Costs + how to stop paying: `COST.md` (read it first).

```
bootstrap/    one-time: the S3 bucket that stores Terraform state (local state, run once)
terraform/    the environment: VPC, RDS, S3, ECR, ECS (app/worker/redis/migrate), ALB, CloudFront,
              IAM (task roles + GitHub OIDC deploy role), SSM secrets, budget
.checkov.yaml static security scan config (CI); every skipped check has a written reason
```

## First-time setup (about 30 minutes)

### 0. Prerequisites (you, once)
1. An AWS account. Enable **MFA on the root user**, then create an admin identity for daily use
   (IAM Identity Center user, or an IAM user with `AdministratorAccess` + MFA). Never use root keys.
2. AWS CLI v2 + Terraform ≥ 1.10. Log in and check you're in the right account:
   ```bash
   aws configure sso        # or: aws configure  (IAM user access key)
   aws sts get-caller-identity
   ```

### 1. State bucket (once per account)
```bash
cd infra/bootstrap
terraform init
terraform apply                      # creates s3://ams-tfstate-<account-id>
```

### 2. Review the plan, then create the environment
```bash
cd ../terraform
cp terraform.tfvars.example terraform.tfvars   # set budget_alert_email
terraform init -backend-config="bucket=ams-tfstate-<account-id>" -backend-config="region=ap-southeast-2"
terraform plan -out=tfplan           # READ IT: this is everything that will be created
terraform apply tfplan               # ~15 min (RDS + CloudFront are the slow ones)
```
All services start at **0 tasks**: nothing runs (or bills for compute) until the first deploy.

### 3. Connect GitHub
```bash
gh api -X PUT repos/shashwat1213/ai-media-studio/environments/production   # create the environment
# Repo-level variables (the job's `if:` is evaluated before the environment is entered, so
# environment-scoped variables wouldn't be visible there). Not secrets: an ARN is useless
# without the OIDC trust, which only accepts this repo's `production` environment.
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform output -raw deploy_role_arn)"
gh variable set AWS_REGION --body ap-southeast-2
```
Optional: protect the `production` environment (Settings → Environments) so it only accepts
deployments from `main`, and/or requires your approval.

### 4. First deploy
Run **Actions → Deploy → Run workflow** (or push to `main`). It builds + pushes the images,
runs migrations, starts redis/worker/app, and smoke-tests the live URL:
```bash
terraform output app_url             # https://dxxxxxxxx.cloudfront.net
../../scripts/aws/status.sh
```

## Day-to-day
| Want to | Do |
|---|---|
| Ship a change | merge to `main` (CI → Deploy runs automatically) |
| Roll back | Actions → Deploy → run on an older commit, or `scripts/aws/rollout.sh <old-sha>` |
| Pause billing | `scripts/aws/down.sh` |
| Resume | `scripts/aws/up.sh` |
| Change infra | edit `.tf` → PR (CI runs fmt/validate/checkov) → `terraform plan` → `terraform apply` |
| Delete everything | `terraform destroy` (see `COST.md`) |
| Read logs | CloudWatch → Log groups → `/ecs/ams-prod` (streams `api/`, `web/`, `worker/`, `migrate/`) |

## Who owns what
Terraform owns the *shape* of everything. Two values are owned by the deploy pipeline instead, and
Terraform deliberately ignores changes to them so an `apply` never fights a deploy:
- `/ams/prod/IMAGE_TAG`: the git SHA that's live (Terraform reads it to build task definitions).
- service `desired_count`: set by the first deploy and by `up.sh`/`down.sh`.
