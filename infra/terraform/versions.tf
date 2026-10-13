terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.68" }
    random = { source = "hashicorp/random", version = "~> 3.7" }
  }
  # Partial config: the bucket name contains the account id, so it's passed at init time:
  #   terraform init -backend-config="bucket=ams-tfstate-<account>" -backend-config="region=ap-southeast-2"
  backend "s3" {
    key          = "ai-media-studio/prod.tfstate"
    encrypt      = true
    use_lockfile = true # S3-native state locking (Terraform >= 1.10): no DynamoDB table
  }
}

provider "aws" {
  region = var.region
  # Every resource gets these tags: makes the bill filterable by project and teardown auditable.
  default_tags {
    tags = { Project = "ai-media-studio", Environment = var.env, ManagedBy = "terraform" }
  }
}
