#!/usr/bin/env bash
# Resume the paused environment: start RDS, then redis -> migrations -> worker + app.
# Billing for Fargate/ALB/RDS compute starts again. Pause with scripts/aws/down.sh.
set -euo pipefail
source "$(dirname "$0")/common.sh"

TAG=$(current_tag)
[ "$TAG" != bootstrap ] || die "nothing deployed yet: push to main (or run the Deploy workflow) first"

DB=ams-prod
STATE=$(aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' --output text)
if [ "$STATE" = stopped ]; then
  log "starting RDS $DB (takes ~5 min)"
  aws rds start-db-instance --db-instance-identifier "$DB" >/dev/null
fi
aws rds wait db-instance-available --db-instance-identifier "$DB"
log "RDS available"

"$(dirname "$0")/rollout.sh" "$TAG" --start
