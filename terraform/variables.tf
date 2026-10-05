# Resource-free input contract; no deployment is implied.
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

variable "zone" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+(?:-[a-z]+)+[0-9]-[a-z]$", var.zone)) && length(var.zone) <= 65
    error_message = "Supply a valid bounded zone value."
  }
}

variable "runner_labels" {
  type = map(string)
  validation {
    condition = length(var.runner_labels) >= 1 && length(var.runner_labels) <= 16 && alltrue([
      for key, value in var.runner_labels : can(regex("^[a-z][a-z0-9_-]{0,62}$", key)) && can(regex("^[a-z0-9][a-z0-9_-]{0,62}$", value))
    ])
    error_message = "Supply one to sixteen safe metadata labels."
  }
}
