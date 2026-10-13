#!/usr/bin/env bash
# One-screen overview: what's running, which image, DB state, the URL.
set -euo pipefail
source "$(dirname "$0")/common.sh"

echo "URL:        $APP_URL"
echo "Image tag:  $(current_tag)"
echo "RDS:        $(aws rds describe-db-instances --db-instance-identifier ams-prod --query 'DBInstances[0].DBInstanceStatus' --output text)"
aws ecs describe-services --cluster "$CLUSTER" \
  --services "$(cfg .services.app)" "$(cfg .services.worker)" "$(cfg .services.redis)" \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output table
curl -fsS --max-time 10 "$APP_URL/api/health" && echo || echo "health: not reachable (paused?)"
