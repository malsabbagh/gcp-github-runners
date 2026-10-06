variable "name_prefix" {
  type    = string
  default = "runner"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,17}$", var.name_prefix))
    error_message = "Use a bounded lowercase resource prefix."
  }
}
variable "controller_archive_path" {
  type        = string
  description = "Local screened controller ZIP produced by npm run package:controller. No source is fetched by Terraform."
  validation {
    condition     = fileexists(var.controller_archive_path)
    error_message = "Assemble and screen the local archive before planning. Terraform does not fetch source."
  }
}
variable "function_build_service_account" {
  type        = string
  description = "Existing deployment build account email; distinct from every runtime identity."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.function_build_service_account))
    error_message = "Supply a canonical service account email."
  }
  validation {
    condition     = endswith(var.function_build_service_account, "@${var.project_id}.iam.gserviceaccount.com") && !contains([for role in ["controller", "provisioner", "cleanup", "worker"] : "${var.name_prefix}-${role}@${var.project_id}.iam.gserviceaccount.com"], var.function_build_service_account)
    error_message = "The external function builder must belong to this project and differ from runtime accounts."
  }
}
variable "worker_image" {
  type        = string
  description = "Exact prebuilt native GCE image resource, never an image family."
  validation {
    condition     = can(regex("^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/global/images/[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.worker_image))
    error_message = "Supply an exact projects/.../global/images/... resource."
  }
}
variable "builder_image" {
  type        = string
  description = "Qualified Python/gcloud provisioner container pinned by digest."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$", var.builder_image))
    error_message = "Pin the builder by SHA256 digest."
  }
}
variable "machine_type" {
  type    = string
  default = "e2-standard-2"
}
variable "worker_disk_size_gb" {
  type    = number
  default = 30
  validation {
    condition     = var.worker_disk_size_gb >= 10 && var.worker_disk_size_gb <= 1024 && floor(var.worker_disk_size_gb) == var.worker_disk_size_gb
    error_message = "Use an integer disk size between 10 and 1024 GiB."
  }
}
variable "network_cidr" {
  type    = string
  default = "10.42.0.0/24"
  validation {
    condition     = can(cidrnetmask(var.network_cidr))
    error_message = "Use a valid IPv4 worker subnet CIDR."
  }
}
variable "max_runner_vms" {
  type    = number
  default = 2
  validation {
    condition     = var.max_runner_vms >= 1 && var.max_runner_vms <= 9999 && floor(var.max_runner_vms) == var.max_runner_vms
    error_message = "Use an integer ceiling from 1 to 9999."
  }
}
variable "firestore_database_id" {
  type    = string
  default = "autoscaler-state"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,61}[a-z0-9]$", var.firestore_database_id))
    error_message = "Use a four-to-63-character named database id."
  }
}
variable "webhook_secret_version" {
  type = string
  validation {
    condition     = startswith(var.webhook_secret_version, "projects/${var.project_id}/secrets/")
    error_message = "Secret references must belong to the selected controller project."
  }
  validation {
    condition     = can(regex("^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/secrets/[A-Za-z0-9_-]{1,255}/versions/[1-9][0-9]{0,17}$", var.webhook_secret_version))
    error_message = "Use a numbered existing secret-version reference, never its value or latest alias."
  }
}
variable "github_app_private_key_secret_version" {
  type = string
  validation {
    condition     = startswith(var.github_app_private_key_secret_version, "projects/${var.project_id}/secrets/")
    error_message = "Secret references must belong to the selected controller project."
  }
  validation {
    condition     = can(regex("^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/secrets/[A-Za-z0-9_-]{1,255}/versions/[1-9][0-9]{0,17}$", var.github_app_private_key_secret_version))
    error_message = "Use a numbered existing secret-version reference."
  }
}
variable "github_app_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]{0,15}$", var.github_app_id)) && try(tonumber(var.github_app_id), 0) <= 9007199254740991
    error_message = "Use a verified positive App id of at most 16 digits and at most 9007199254740991."
  }
}
variable "github_app_installation_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]{0,15}$", var.github_app_installation_id)) && try(tonumber(var.github_app_installation_id), 0) <= 9007199254740991
    error_message = "Supply a verified positive id of at most 16 digits and at most 9007199254740991."
  }
}
variable "github_repository_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]{0,15}$", var.github_repository_id)) && try(tonumber(var.github_repository_id), 0) <= 9007199254740991
    error_message = "Supply a verified positive id of at most 16 digits and at most 9007199254740991."
  }
}
variable "runner_group_id" {
  type    = string
  default = "1"
  validation {
    condition     = can(regex("^[1-9][0-9]{0,15}$", var.runner_group_id)) && try(tonumber(var.runner_group_id), 0) <= 9007199254740991
    error_message = "Supply a positive runner group id of at most 16 digits and at most 9007199254740991."
  }
}
variable "admin_subject" {
  type        = string
  description = "Verified numeric OIDC sub of the existing operator service account, not an email."
  validation {
    condition     = can(regex("^[1-9][0-9]{5,30}$", var.admin_subject))
    error_message = "Supply the verified numeric service-account subject."
  }
}
variable "runner_routing_label" {
  type    = string
  default = "gcp-one-job"
}
variable "required_runner_labels" {
  type    = list(string)
  default = ["self-hosted", "gcp-one-job"]
  validation {
    condition     = length(distinct(var.required_runner_labels)) == length(var.required_runner_labels)
    error_message = "Required routing labels must not contain duplicates."
  }
}
variable "registered_runner_labels" {
  type    = list(string)
  default = ["self-hosted", "linux", "x64", "gcp-one-job"]
  validation {
    condition     = length(var.registered_runner_labels) >= 2 && length(var.registered_runner_labels) <= 16 && length(distinct(var.registered_runner_labels)) == length(var.registered_runner_labels) && alltrue([for label in var.registered_runner_labels : can(regex("^[A-Za-z0-9_-]{1,100}$", label))]) && contains(var.registered_runner_labels, "self-hosted") && contains(var.registered_runner_labels, var.runner_routing_label) && alltrue([for label in var.required_runner_labels : contains(var.registered_runner_labels, label)]) && contains(var.required_runner_labels, "self-hosted") && contains(var.required_runner_labels, var.runner_routing_label) && !contains(["self-hosted", "linux", "windows", "macos", "x64", "arm", "arm64"], lower(var.runner_routing_label))
    error_message = "Registered and required labels must include self-hosted and a dedicated routing label, with no duplicates or unmatched requirements."
  }
}
variable "runtime_readiness" {
  description = "Explicit provider-qualification switches. False preserves allocations and denies unqualified side effects."
  type = object({
    webhook_enabled                 = optional(bool, false)
    management_enabled              = optional(bool, false)
    scheduled_enabled               = optional(bool, false)
    jit_provider_lifetime_qualified = optional(bool, false)
    approved_quiescence             = optional(bool, false)
    dispatch_enabled                = optional(bool, false)
    worker_drain_qualified          = optional(bool, false)
    worker_stop_qualified           = optional(bool, false)
  })
  default = {}
}
variable "scheduler_paused" {
  type    = bool
  default = true
}
variable "deletion_protection" {
  type    = bool
  default = true
}

variable "builder_image_repository" {
  description = "Optional exact Artifact Registry repository for a private builder digest; absent for public images."
  type        = object({ project = string, location = string, repository = string })
  default     = null
}
