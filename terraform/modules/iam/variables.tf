# Interface only. Identities are supplied; no accounts or grants are created.
# This four-role object is an explicit supported profile adaptation.
variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Supply a valid bounded project id value."
  }
}

variable "service_accounts" {
  type = object({
    controller  = string
    provisioner = string
    cleanup     = string
    worker      = string
  })
  validation {
    condition = length(distinct(values(var.service_accounts))) == 4 && alltrue([
      for email in values(var.service_accounts) : can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", email))
    ])
    error_message = "Supply four distinct canonical service account references."
  }
}
