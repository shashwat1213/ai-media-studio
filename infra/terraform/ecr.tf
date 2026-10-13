# Image registry. One repo per image; tags are git SHAs and IMMUTABLE, so a tag always means
# the same bytes (you can't silently overwrite what's running). scan_on_push = free basic CVE scan.

locals {
  repos = ["api", "migrator", "web"]
}

resource "aws_ecr_repository" "repo" {
  for_each             = toset(local.repos)
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.teardown_friendly
  image_scanning_configuration { scan_on_push = true }
}

# Keep the 10 newest images per repo (storage is billed per GB-month).
resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}
