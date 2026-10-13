#!/usr/bin/env bash
# Roll out images tagged <tag> (a git SHA already pushed to ECR):
#   1. run DB migrations as a one-off task (abort everything if they fail)
#   2. point the worker and app services at new task revisions (rolling, auto-rollback)
#   3. wait until stable, record the tag in SSM (so `terraform apply` keeps it)
#
#   scripts/aws/rollout.sh <tag> [--start]     --start = also scale everything to 1 (first deploy / `up`)
#
# Order matters: migrations BEFORE new code (new code may need new columns), and migrations must be
# backwards compatible with the OLD code that keeps serving during the rolling deploy
# (expand -> deploy -> contract). See specs/06_aws_learnings.md.
set -euo pipefail
source "$(dirname "$0")/common.sh"

TAG=${1:?usage: rollout.sh <tag> [--start]}
START=${2:-}

if [ "$START" = --start ]; then
  scale "$(cfg .services.redis)" 1
fi

run_migrations "$TAG"

if [ "$START" = --start ]; then
  roll worker "$TAG" 1
  roll app "$TAG" 1
else
  roll worker "$TAG"
  roll app "$TAG"
fi

aws ssm put-parameter --name "$TAG_PARAM" --type String --overwrite --value "$TAG" >/dev/null
wait_stable "$(cfg .services.redis)" "$(cfg .services.worker)" "$(cfg .services.app)"
log "live: $APP_URL  (images :$TAG)"
