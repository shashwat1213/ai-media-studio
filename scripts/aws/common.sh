#!/usr/bin/env bash
# Shared helpers for the AWS scripts. Sourced, not executed.
# Everything the scripts need about the infrastructure comes from ONE SSM parameter that
# Terraform writes (/ams/prod/DEPLOY_CONFIG), so nothing (ids, ARNs, URLs) is hard-coded here.
set -euo pipefail

: "${AWS_REGION:=${AWS_DEFAULT_REGION:-ap-southeast-2}}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
: "${SSM_PREFIX:=/ams/prod}"

log() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "aws CLI not found"
command -v jq >/dev/null || die "jq not found"

CONFIG=$(aws ssm get-parameter --name "$SSM_PREFIX/DEPLOY_CONFIG" --query Parameter.Value --output text) \
  || die "can't read $SSM_PREFIX/DEPLOY_CONFIG (is the infrastructure applied? right account/region?)"
cfg() { jq -r "$1" <<<"$CONFIG"; }

CLUSTER=$(cfg .cluster)
APP_URL=$(cfg .appUrl)
TAG_PARAM=$(cfg .imageTagParam)

current_tag() { aws ssm get-parameter --name "$TAG_PARAM" --query Parameter.Value --output text; }

desired_count() {
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" \
    --query 'services[0].desiredCount' --output text
}

scale() { # scale <service> <count>
  aws ecs update-service --cluster "$CLUSTER" --service "$1" --desired-count "$2" >/dev/null
  log "service $1 -> desired $2"
}

# New revision of a task definition family with every image from OUR registry re-tagged to $2.
# Prints the new task definition ARN. (Third-party images like redis are left alone.)
register_with_tag() { # register_with_tag <family> <tag>
  local family=$1 tag=$2 registry
  registry=$(cfg .registry)
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg reg "$registry" --arg tag "$tag" '
      .containerDefinitions |= map(
        if (.image | startswith($reg + "/")) then .image = ((.image | sub(":[^:/]+$"; "")) + ":" + $tag) else . end)
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
            .registeredAt, .registeredBy, .deregisteredAt)' >/tmp/taskdef-"$family".json
  aws ecs register-task-definition --cli-input-json "file:///tmp/taskdef-$family.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

# Run the one-off migration task with the given image tag and fail if it doesn't exit 0.
run_migrations() { # run_migrations <tag>
  local td task exit_code
  td=$(register_with_tag "$(cfg .families.migrate)" "$1")
  log "running migrations ($td)"
  task=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$td" --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$(cfg '.subnets | join(",")')],securityGroups=[$(cfg .securityGroup)],assignPublicIp=ENABLED}" \
    --query 'tasks[0].taskArn' --output text)
  [ -n "$task" ] && [ "$task" != None ] || die "run-task returned no task"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  exit_code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  # Show what prisma printed (stream name = <prefix>/<container>/<task id>).
  aws logs get-log-events --log-group-name "$(cfg .logGroup)" \
    --log-stream-name "migrate/migrate/${task##*/}" --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || true
  [ "$exit_code" = 0 ] || die "migrations failed (exit code $exit_code): nothing was rolled out"
  log "migrations applied"
}

# Point a service at a new task definition (rolling deploy; ECS circuit breaker rolls back on failure).
roll() { # roll <service-key> <tag> [desired]
  local svc family td
  svc=$(cfg ".services.$1"); family=$(cfg ".families.$1")
  td=$(register_with_tag "$family" "$2")
  if [ -n "${3:-}" ]; then
    aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "$td" --desired-count "$3" >/dev/null
  else
    aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "$td" >/dev/null
  fi
  log "service $svc -> $td"
}

wait_stable() {
  log "waiting for services to become stable: $*"
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$@"
}
