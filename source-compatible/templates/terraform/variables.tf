variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP Region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP Zone for VM instances"
  type        = string
  default     = "us-central1-a"
}

variable "github_webhook_secret" {
  description = "Secret for GitHub webhook signature verification"
  type        = string
  sensitive   = true
  default     = ""
  validation {
    condition     = length(trimspace(var.github_webhook_secret)) > 0 && !startswith(var.github_webhook_secret, "placeholder-")
    error_message = "Configure a non-placeholder webhook secret before provisioning."
  }
}

variable "github_repo_owner" {
  description = "GitHub repository owner/organization"
  type        = string
}

variable "github_repo_name" {
  description = "GitHub repository name"
  type        = string
}

variable "github_branch" {
  description = "GitHub branch to use for Cloud Build triggers"
  type        = string
  default     = "main"
}

variable "instance_template_name" {
  description = "Readable prefix for generated immutable instance templates"
  type        = string
  default     = "github-runner-template"
}

variable "runner_labels" {
  description = "Labels to apply to runner instances"
  type        = map(string)
  default = {
    purpose = "github-runner"
    managed = "terraform"
  }
}

variable "machine_type" {
  description = "Machine type for the runner instances"
  type        = string
  default     = "c2-standard-4"
}

variable "disk_size" {
  description = "Boot disk size in GB"
  type        = number
  default     = 100
}

variable "github_pat" {
  description = "GitHub Personal Access Token for API access (needs repo scope for runner registration)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "force_recreate_template" {
  description = "Deprecated compatibility flag; immutable templates replace automatically when their configuration changes"
  type        = bool
  default     = false
}

variable "runner_isolation_mode" {
  description = "Runner isolation mode: 'multi-user' or 'docker'"
  type        = string
  default     = "docker"
  validation {
    condition     = contains(["multi-user", "docker"], var.runner_isolation_mode)
    error_message = "The runner_isolation_mode must be either 'multi-user' or 'docker'."
  }
}

variable "docker_runner_image" {
  description = "Docker image to use for GitHub Actions runner in Docker mode"
  type        = string
  default     = "PARITY_INPUT_073:stable"
}

variable "max_runner_vms" {
  description = "Maximum number of runner VMs to create for autoscaling."
  type        = number
  default     = 2
  validation {
    condition     = var.max_runner_vms >= 1 && floor(var.max_runner_vms) == var.max_runner_vms
    error_message = "max_runner_vms must be a positive integer."
  }
}

variable "repo_owner" {
  description = "GitHub repository owner for the runner (can be overridden at instance creation)"
  type        = string
  default     = null
}

variable "repo_name" {
  description = "GitHub repository name for the runner (can be overridden at instance creation)"
  type        = string
  default     = null
}

variable "runner_count" {
  description = "Number of GitHub runners to launch (can be overridden at instance creation)"
  type        = string
  default     = "4"
}

variable "create_test_instance" {
  description = "Create a one-off test VM from the runner template to validate startup/shutdown."
  type        = bool
  default     = false
}

# =====================
# All variables below are required for correct operation of the autoscaling infrastructure.
# See README.md for usage examples and required values.
# =====================
variable "required_runner_labels" {
  description = "All required GitHub job labels; self-hosted is mandatory. Existing managed runners provide linux, x64 and multi-user."
  type        = list(string)
  default     = ["self-hosted"]
  validation {
    condition     = contains(var.required_runner_labels, "self-hosted") && alltrue([for label in var.required_runner_labels : length(label) > 0])
    error_message = "Runner labels must include self-hosted and may not be empty."
  }
}

variable "webhook_api_key" {
  description = "Cloud Build webhook API key supplied by the operator; never emitted in ordinary outputs."
  type        = string
  sensitive   = true
  default     = ""
}
