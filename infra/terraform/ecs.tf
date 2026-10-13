# ECS on Fargate: AWS runs our containers; no servers to patch.
#
#   service "app"     nginx (web image) + api, in ONE task. They share localhost, so nginx
#                     proxies /api -> 127.0.0.1:4000 exactly like docker-compose (same image,
#                     same nginx template, same-origin cookies). Behind the ALB.
#   service "worker"  same api image, command `node dist/worker.js`. Scales on its own.
#   service "redis"   BullMQ queue. Found by the others at redis.<namespace> via Cloud Map DNS.
#   task "migrate"    one-off `prisma migrate deploy`, run by the deploy pipeline BEFORE new
#                     code starts (expand/contract migrations keep old + new code compatible).
#
# Image tags: the deploy pipeline writes the git SHA it deployed to the IMAGE_TAG parameter.
# Terraform reads it back, so `terraform apply` never rolls the app back to an old image.

resource "aws_ecs_cluster" "main" {
  name = "${var.name}-${var.env}"
  setting {
    name  = "containerInsights"
    value = "disabled" # enhanced metrics cost extra; app metrics come from /metrics + logs
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}-${var.env}"
  retention_in_days = 7 # logs are billed per GB stored; a week is enough to debug
}

# Written by the deploy workflow (git SHA). "bootstrap" until the first deploy.
resource "aws_ssm_parameter" "image_tag" {
  name  = "${local.ssm_prefix}/IMAGE_TAG"
  type  = "String"
  value = "bootstrap"
  lifecycle { ignore_changes = [value] }
}

# Private DNS for service discovery (redis.ams.internal).
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.name}.internal"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "redis" {
  name = "redis"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {}
}

locals {
  tag      = aws_ssm_parameter.image_tag.value
  img      = { for k, r in aws_ecr_repository.repo : k => "${r.repository_url}:${local.tag}" }
  app_url  = "https://${aws_cloudfront_distribution.main.domain_name}"
  log_opts = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region }

  # Shared by api + worker (+ DATABASE_URL for migrate). Mirrors x-app-env in docker-compose.yml.
  app_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "REDIS_URL", value = "redis://redis.${aws_service_discovery_private_dns_namespace.main.name}:6379" },
    # Real S3: no endpoint, no keys (the task role signs requests), virtual-hosted URLs.
    { name = "S3_REGION", value = var.region },
    { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
    { name = "S3_FORCE_PATH_STYLE", value = "false" },
    { name = "AI_PROVIDER", value = var.ai_provider },
  ]
  app_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
    { name = "METRICS_TOKEN", valueFrom = aws_ssm_parameter.metrics_token.arn },
    { name = "OPENROUTER_API_KEY", valueFrom = aws_ssm_parameter.openrouter_api_key.arn },
  ]
  node_health = "node -e \"fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||process.env.PORT)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
}

# ---------------- app: nginx + api ----------------
resource "aws_ecs_task_definition" "app" {
  family                   = "${var.name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256 # 0.25 vCPU: the smallest Fargate size
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.img["api"]
      essential = true
      environment = concat(local.app_env, [
        { name = "PORT", value = "4000" },
        { name = "CORS_ORIGIN", value = local.app_url },
        # CloudFront -> ALB -> nginx -> api: the client IP is 3 hops back in X-Forwarded-For.
        { name = "TRUST_PROXY_HOPS", value = "3" },
      ])
      secrets          = concat(local.app_secrets, [{ name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn }])
      portMappings     = [{ containerPort = 4000, protocol = "tcp" }]
      healthCheck      = { command = ["CMD-SHELL", local.node_health], interval = 15, timeout = 5, retries = 3, startPeriod = 20 }
      logConfiguration = { logDriver = "awslogs", options = merge(local.log_opts, { "awslogs-stream-prefix" = "api" }) }
      stopTimeout      = 15
    },
    {
      name         = "web"
      image        = local.img["web"]
      essential    = true
      environment  = [{ name = "API_UPSTREAM", value = "http://127.0.0.1:4000" }]
      portMappings = [{ containerPort = 8080, protocol = "tcp" }]
      # Start nginx only once the api answers, so the ALB never routes to a half-ready task.
      dependsOn        = [{ containerName = "api", condition = "HEALTHY" }]
      healthCheck      = { command = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1"], interval = 15, timeout = 5, retries = 3, startPeriod = 10 }
      logConfiguration = { logDriver = "awslogs", options = merge(local.log_opts, { "awslogs-stream-prefix" = "web" }) }
    },
  ])
}

resource "aws_ecs_service" "app" {
  name                              = "app"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = 0 # 0 until the first deploy; afterwards the pipeline / pause scripts own it
  launch_type                       = "FARGATE"
  enable_execute_command            = false
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # egress to ECR/SSM/OpenRouter without a NAT Gateway; SG blocks inbound
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "web"
    container_port   = 8080
  }

  # Rolling deploy: start the new task first (200%), keep the old one serving (100%) until the
  # new one passes ALB health checks. The circuit breaker rolls back a deploy that never gets healthy.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_lb_listener.http]
}

# ---------------- worker ----------------
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = local.img["api"]
    essential = true
    command   = ["node", "dist/worker.js"]
    environment = concat(local.app_env, [
      { name = "WORKER_PORT", value = "4001" },
      { name = "HEALTH_PORT", value = "4001" },
      { name = "WORKER_CONCURRENCY", value = "4" },
    ])
    secrets          = local.app_secrets
    healthCheck      = { command = ["CMD-SHELL", local.node_health], interval = 15, timeout = 5, retries = 3, startPeriod = 20 }
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_opts, { "awslogs-stream-prefix" = "worker" }) }
    stopTimeout      = 35 # ECS max is 120; matches compose stop_grace_period so in-flight jobs finish
  }])
}

resource "aws_ecs_service" "worker" {
  name                   = "worker"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = 0
  enable_execute_command = false

  capacity_provider_strategy {
    capacity_provider = var.worker_use_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  deployment_minimum_healthy_percent = 0 # one worker: stop old, start new (jobs wait in Redis meanwhile)
  deployment_maximum_percent         = 100
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_ecs_cluster_capacity_providers.main]
}

# ---------------- redis ----------------
# A Redis container instead of ElastiCache: cache.t4g.micro is ~$12/month and the queue holds
# only job ids (Postgres is the source of truth). If this task restarts and loses queued ids,
# the stuck-job sweeper fails + refunds those jobs within JOB_TIMEOUT_MINUTES. Trade-off logged
# in specs/06_aws_learnings.md. Image from ECR Public (no Docker Hub rate limits).
resource "aws_ecs_task_definition" "redis" {
  family                   = "${var.name}-redis"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name             = "redis"
    image            = "public.ecr.aws/docker/library/redis:7.4-alpine"
    essential        = true
    command          = ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "200mb", "--maxmemory-policy", "noeviction"]
    portMappings     = [{ containerPort = 6379, protocol = "tcp" }]
    healthCheck      = { command = ["CMD", "redis-cli", "ping"], interval = 10, timeout = 3, retries = 3, startPeriod = 5 }
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_opts, { "awslogs-stream-prefix" = "redis" }) }
  }])
}

resource "aws_ecs_service" "redis" {
  name                               = "redis"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.redis.arn
  desired_count                      = 0
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0 # a single stateful instance: never run two at once
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.redis.id]
    assign_public_ip = true # only to pull the image; SG allows inbound from app tasks only
  }

  service_registries {
    registry_arn = aws_service_discovery_service.redis.arn
  }

  lifecycle { ignore_changes = [desired_count] }
}

# ---------------- migrate (one-off task, no service) ----------------
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = local.img["migrator"]
    essential        = true
    secrets          = [{ name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn }]
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_opts, { "awslogs-stream-prefix" = "migrate" }) }
  }])
}

# Everything the deploy workflow needs, in one parameter: GitHub only stores the role ARN + region.
resource "aws_ssm_parameter" "deploy_config" {
  name = "${local.ssm_prefix}/DEPLOY_CONFIG"
  type = "String"
  value = jsonencode({
    cluster       = aws_ecs_cluster.main.name
    registry      = split("/", aws_ecr_repository.repo["api"].repository_url)[0]
    repos         = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
    services      = { app = aws_ecs_service.app.name, worker = aws_ecs_service.worker.name, redis = aws_ecs_service.redis.name }
    families      = { app = aws_ecs_task_definition.app.family, worker = aws_ecs_task_definition.worker.family, migrate = aws_ecs_task_definition.migrate.family }
    subnets       = aws_subnet.public[*].id
    securityGroup = aws_security_group.app.id
    imageTagParam = aws_ssm_parameter.image_tag.name
    logGroup      = aws_cloudwatch_log_group.app.name
    appUrl        = local.app_url
  })
}
