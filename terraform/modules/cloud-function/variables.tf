# Unwired function interface; no runtime consumers or resources.
variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Supply a valid bounded project id value."
  }
}

variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+(?:-[a-z]+)+[0-9]$", var.region)) && length(var.region) <= 63
    error_message = "Supply a valid bounded region value."
  }
}

variable "webhook_handler_sa_email" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.webhook_handler_sa_email))
    error_message = "Supply a valid bounded webhook handler sa email value."
  }
}

variable "cleanup_function_sa_email" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.cleanup_function_sa_email))
    error_message = "Supply a valid bounded cleanup function sa email value."
  }
}

# A numbered reference only, never a secret value or latest alias.
variable "webhook_secret_version" {
  type = string
  validation {
    condition     = can(regex("^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/secrets/[A-Za-z0-9_-]{1,255}/versions/[1-9][0-9]{0,17}$", var.webhook_secret_version))
    error_message = "Supply a valid bounded webhook secret version value."
  }
}

variable "zone" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+(?:-[a-z]+)+[0-9]-[a-z]$", var.zone)) && length(var.zone) <= 65
    error_message = "Supply a valid bounded zone value."
  }
}
