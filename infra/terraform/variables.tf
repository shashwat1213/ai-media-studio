variable "region" {
  description = "AWS region. Must be the AWS project's selected Region (new AWS experience: one Region per project)."
  type        = string
  default     = "ap-southeast-2"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "ams"
}

variable "github_repo" {
  description = "owner/repo allowed to deploy via OIDC."
  type        = string
  default     = "shashwat1213/ai-media-studio"
}

variable "budget_alert_email" {
  description = "Where AWS Budgets sends cost alerts. Empty = no budget created."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  type    = number
  default = 20
}

variable "ai_provider" {
  description = "'stub' (free placeholder images) or 'openrouter' (real, paid). openrouter also needs the API key in SSM (see COST.md)."
  type        = string
  default     = "stub"
  validation {
    condition     = contains(["stub", "openrouter"], var.ai_provider)
    error_message = "ai_provider must be 'stub' or 'openrouter'."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro" # smallest Graviton instance; covered by free-tier credits
}

variable "worker_use_spot" {
  description = "Run the worker on Fargate Spot (~70% cheaper; can be interrupted, which the job pipeline already tolerates: retries + sweeper)."
  type        = bool
  default     = true
}

variable "teardown_friendly" {
  description = "true = `terraform destroy` removes everything incl. data (no final DB snapshot, buckets/repos emptied). Right for a portfolio project; false for anything real."
  type        = bool
  default     = true
}
