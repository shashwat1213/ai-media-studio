#!/usr/bin/env bash
# Pause the environment to stop compute billing: all services -> 0 tasks, RDS stopped.
# What still costs money while paused: the ALB (~$16/mo), RDS storage, S3/ECR storage, CloudFront (~0).
# For $0, destroy everything instead: see COST.md.
# NOTE: AWS auto-starts a stopped RDS instance after 7 days. Run this again if you're away longer.
set -euo pipefail
source "$(dirname "$0")/common.sh"

for s in app worker redis; do scale "$(cfg ".services.$s")" 0; done
wait_stable "$(cfg .services.app)" "$(cfg .services.worker)" "$(cfg .services.redis)"

STATE=$(aws rds describe-db-instances --db-instance-identifier ams-prod --query 'DBInstances[0].DBInstanceStatus' --output text)
if [ "$STATE" = available ]; then
  aws rds stop-db-instance --db-instance-identifier ams-prod >/dev/null
  log "RDS stopping"
else
  log "RDS is '$STATE' (not stopping it)"
fi
log "paused. Resume with scripts/aws/up.sh"
