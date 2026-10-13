# Three kinds of IAM identity, each with only what it needs (least privilege):
#   execution role  used by the ECS AGENT: pull images, write logs, read the SSM secrets
#   task roles      used by OUR CODE at runtime: the api/worker may touch only the media bucket
#   deploy role     assumed by GitHub Actions via OIDC: push images, roll out new task revisions

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---- execution role ----
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" # ECR pull + logs
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-app-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameters"]
      Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter${local.ssm_prefix}/*"
    }]
  })
}

# ---- app task role (api + worker) ----
resource "aws_iam_role" "app_task" {
  name               = "${var.name}-app-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "app_s3" {
  name = "media-bucket"
  role = aws_iam_role.app_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Objects live under users/<userId>/..., and that's all the code may touch.
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.media.arn}/users/*"
      },
      {
        # HeadBucket (the storage health ping) is authorised by s3:ListBucket.
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.media.arn
      },
    ]
  })
}

# ---- GitHub Actions OIDC ----
# GitHub mints a short-lived signed token per workflow run; AWS verifies it against this provider
# and hands back 1-hour credentials. No long-lived AWS keys stored in GitHub at all.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only jobs of THIS repo that run in the protected `production` GitHub environment
    # (not PRs, not forks, not other branches) can assume the role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:environment:production"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
          "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
          "ecr:PutImage", "ecr:UploadLayerPart", "ecr:DescribeImageScanFindings",
        ]
        Resource = [for r in aws_ecr_repository.repo : r.arn]
      },
      {
        # Task-definition APIs don't support resource-level permissions.
        Sid      = "TaskDefinitions"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Sid      = "Services"
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:UpdateService"]
        Resource = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.me.account_id}:service/${aws_ecs_cluster.main.name}/*"
      },
      {
        Sid       = "MigrationTask"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.me.account_id}:task-definition/${var.name}-migrate:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } }
      },
      {
        Sid      = "WatchTasks"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTasks"]
        Resource = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.me.account_id}:task/${aws_ecs_cluster.main.name}/*"
      },
      {
        # RegisterTaskDefinition/RunTask must "pass" these roles to ECS. Only these two.
        Sid       = "PassTaskRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.execution.arn, aws_iam_role.app_task.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Sid      = "DeployConfig"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [aws_ssm_parameter.deploy_config.arn, aws_ssm_parameter.image_tag.arn]
      },
      {
        # Record which git SHA is live, so `terraform apply` keeps using it.
        Sid      = "RecordImageTag"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter"]
        Resource = aws_ssm_parameter.image_tag.arn
      },
      {
        # Print the migration task's output in the workflow log when it fails.
        Sid      = "ReadMigrationLogs"
        Effect   = "Allow"
        Action   = ["logs:GetLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app.arn}:log-stream:migrate/*"
      },
    ]
  })
}
