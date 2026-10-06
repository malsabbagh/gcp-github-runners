variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
}

variable "zone" {
  description = "GCP Zone for VM instances"
  type        = string
}

variable "webhook_handler_sa_email" {
  description = "Service account email for webhook handler"
  type        = string
}

variable "cleanup_function_sa_email" {
  description = "Service account email for cleanup function"
  type        = string
}

variable "github_webhook_secret" {
  description = "GitHub webhook secret"
  type        = string
  sensitive   = true
}