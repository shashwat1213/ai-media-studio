# ---- Postgres (RDS) ----
# Managed Postgres: AWS handles patching, backups and the disk. Private subnets only,
# not publicly accessible, encrypted at rest, reachable only from the app security group.

resource "random_password" "db" {
  length  = 32
  special = false # goes into a postgres:// URL; alphanumeric avoids URL-encoding bugs
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier     = "${var.name}-${var.env}"
  engine         = "postgres"
  engine_version = "16" # same major as docker-compose + CI; AWS picks the latest 16.x minor

  instance_class        = var.db_instance_class
  allocated_storage     = 20
  max_allocated_storage = 0 # no storage autoscaling: a runaway table can't grow the bill
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "ai_media_studio"
  username = "studio"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false # a standby doubles the price; fine for a portfolio project

  backup_retention_period    = 1
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  apply_immediately          = true

  skip_final_snapshot       = var.teardown_friendly
  deletion_protection       = !var.teardown_friendly
  final_snapshot_identifier = var.teardown_friendly ? null : "${var.name}-${var.env}-final"
}

# ---- S3 (generated images) ----
data "aws_caller_identity" "me" {}

resource "aws_s3_bucket" "media" {
  bucket        = "${var.name}-media-${data.aws_caller_identity.me.account_id}"
  force_destroy = var.teardown_friendly # destroy also deletes the generated images
}

# Private bucket: the browser only ever gets short-lived presigned GET URLs from the API.
resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule { object_ownership = "BucketOwnerEnforced" } # ACLs disabled; IAM decides everything
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# ---- Secrets (SSM Parameter Store, SecureString) ----
# Standard SecureString parameters are free (Secrets Manager is $0.40/secret/month).
# ECS injects them as env vars at container start; they never appear in the task definition,
# the image, the repo or GitHub. They DO live in the Terraform state, which is why the state
# bucket is private + encrypted.

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_password" "metrics" {
  length  = 40
  special = false
}

locals {
  ssm_prefix   = "/${var.name}/${var.env}"
  database_url = "postgresql://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${aws_db_instance.main.db_name}?schema=public&sslmode=require"
}

resource "aws_ssm_parameter" "database_url" {
  name  = "${local.ssm_prefix}/DATABASE_URL"
  type  = "SecureString"
  value = local.database_url
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "${local.ssm_prefix}/JWT_SECRET"
  type  = "SecureString"
  value = random_password.jwt.result
}

resource "aws_ssm_parameter" "metrics_token" {
  name  = "${local.ssm_prefix}/METRICS_TOKEN"
  type  = "SecureString"
  value = random_password.metrics.result
}

# Created with a placeholder; the real key is set by hand so it never touches Terraform/git:
#   aws ssm put-parameter --name /ams/prod/OPENROUTER_API_KEY --type SecureString --overwrite --value sk-or-...
resource "aws_ssm_parameter" "openrouter_api_key" {
  name  = "${local.ssm_prefix}/OPENROUTER_API_KEY"
  type  = "SecureString"
  value = "set-me-by-hand"
  lifecycle { ignore_changes = [value] }
}
