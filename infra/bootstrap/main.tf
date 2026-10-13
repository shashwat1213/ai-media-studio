# One-time bootstrap: the S3 bucket that stores the MAIN stack's Terraform state.
#
# Chicken-and-egg: Terraform needs somewhere to keep state before it can create anything,
# so this tiny stack uses LOCAL state (bootstrap/terraform.tfstate, gitignored) and only
# creates the remote-state bucket. Run once per AWS account:
#   cd infra/bootstrap && terraform init && terraform apply
#
# Why remote state at all? The state file maps Terraform resources to real AWS ids and contains
# secrets (generated passwords). On a laptop it can be lost or leak; in a versioned, encrypted,
# private bucket it's backed up and shared. Terraform >= 1.10 locks it with an S3 lock file
# (use_lockfile), so no DynamoDB table is needed any more.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.68" }
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-2" # the AWS project's selected Region
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "ai-media-studio", ManagedBy = "terraform-bootstrap" } }
}

data "aws_caller_identity" "me" {}

resource "aws_s3_bucket" "tfstate" {
  # Bucket names are global: the account id keeps it unique.
  bucket = "ams-tfstate-${data.aws_caller_identity.me.account_id}"
  # Protect the state from an accidental `terraform destroy` of this stack.
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" } # every state write is a recoverable version
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Old state versions are only for recovery: expire them after 90 days.
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

output "next_step" {
  value = "cd ../terraform && terraform init -backend-config=\"bucket=${aws_s3_bucket.tfstate.bucket}\" -backend-config=\"region=${var.region}\""
}
