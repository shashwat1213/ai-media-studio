# Security groups = stateful firewalls on each network interface. The chain is:
#
#   CloudFront --(VPC origin, private)--> ALB :80 --> web task :8080 (nginx -> api on localhost)
#   web/worker tasks --> Postgres :5432, Redis :6379
#
# Each rule references the SOURCE security group, not an IP range, so only those resources can
# connect no matter what IPs they get.

# CloudFront's origin-facing IP ranges, maintained by AWS.
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Internal ALB: only CloudFront may connect"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  description       = "HTTP from CloudFront origin-facing IPs only"
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  description                  = "ALB to nginx in app tasks"
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

# Shared by the web (nginx+api), worker and migrate tasks.
resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "App tasks: inbound only from the ALB"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  description                  = "nginx only from the ALB"
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

# Outbound anywhere: ECR image pulls, S3, SSM, CloudWatch Logs, OpenRouter, RDS, Redis.
resource "aws_vpc_security_group_egress_rule" "app_out" {
  description       = "ECR, S3, SSM, logs, OpenRouter, RDS, Redis"
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis task: only app tasks may connect"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  description                  = "Redis only from app tasks"
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

# Needed to pull the redis image from ECR Public / Docker Hub.
resource "aws_vpc_security_group_egress_rule" "redis_out" {
  description       = "pull the redis image"
  security_group_id = aws_security_group.redis.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres: only app tasks may connect"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  description                  = "Postgres only from app tasks"
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
