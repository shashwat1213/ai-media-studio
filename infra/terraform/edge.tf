# Traffic path:  browser --HTTPS--> CloudFront --(VPC origin)--> internal ALB --> app task (nginx)
#
# Why CloudFront in front of an INTERNAL load balancer?
#  - Free HTTPS on *.cloudfront.net (no domain, no certificate to manage). Secure cookies need HTTPS.
#  - The ALB lives in private subnets with no public address: CloudFront is the only way in.
#  - Hashed static assets (/assets/*) are cached at the edge.

resource "aws_lb" "app" {
  name                       = "${var.name}-${var.env}"
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = aws_subnet.private[*].id
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 60
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "app" {
  name        = "${var.name}-app"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip" # Fargate tasks register by IP
  vpc_id      = aws_vpc.main.id
  # How long a draining task keeps finishing in-flight requests during a deploy.
  deregistration_delay = 20

  health_check {
    # Through nginx to the api: "healthy" means the whole task can serve (incl. the DB ping).
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP" # only CloudFront talks to it, privately inside the VPC
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = "${var.name}-alb"
    arn                    = aws_lb.app.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

# AWS-managed policies (fixed, documented ids).
locals {
  cache_disabled         = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  cache_optimized        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  security_headers       = "67f7725c-6f97-4210-82d7-5512b31e9d03" # Managed-SecurityHeadersPolicy (HSTS etc.)
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "${var.name} ${var.env}"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = "PriceClass_200" # includes Asia-Pacific + India edges, excludes the priciest (South America)

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.app.dns_name
    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.alb.id
      origin_keepalive_timeout = 5
      origin_read_timeout      = 30
    }
  }

  # Default: SPA routes + index.html. Not cached (nginx says no-cache) so a deploy is visible at once.
  # Forward everything (cookies, query, headers) except Host.
  default_cache_behavior {
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_disabled
    origin_request_policy_id   = local.all_viewer_except_host
    response_headers_policy_id = local.security_headers
  }

  # Vite's content-hashed bundles: immutable, cache at the edge for as long as allowed.
  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_optimized
    response_headers_policy_id = local.security_headers
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# The ALB only accepts CloudFront (prefix list rule in security.tf).

# ---------------- cost guardrail ----------------
resource "aws_budgets_budget" "monthly" {
  count        = var.budget_alert_email == "" ? 0 : 1
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
