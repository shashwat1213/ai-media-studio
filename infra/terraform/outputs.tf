output "app_url" {
  description = "The live app (CloudFront, HTTPS)."
  value       = local.app_url
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub `production` environment."
  value       = aws_iam_role.deploy.arn
}

output "region" {
  value = var.region
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "media_bucket" {
  value = aws_s3_bucket.media.bucket
}

output "ecr_repos" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}
