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

# One canonical repository input set; no triggers are created.
variable "repository_owner" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$", var.repository_owner))
    error_message = "Supply a valid bounded repository owner value."
  }
}

variable "repository_name" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$", var.repository_name))
    error_message = "Supply a valid bounded repository name value."
  }
}

variable "repository_branch" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$", var.repository_branch)) && length(regexall("\\.\\.", var.repository_branch)) == 0 && !can(regex("\\.lock$", var.repository_branch))
    error_message = "Supply a valid bounded repository branch value."
  }
}
