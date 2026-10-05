# Independently authored candidate adaptation. No project IAM grant is created.
# Provider schema, effective inherited IAM and module wiring remain UNQUALIFIED.
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

variable "worker_image_repositories" {
  # Empty for the selected preinstalled-image profile. Explicit opt-in only if
  # a later qualified worker path actually pulls from these repositories.
  type = map(object({ project = string, location = string, repository = string }))
  default = {}
}

variable "bootstrap_service" {
  type = object({ project = string, location = string, name = string })
}

variable "controller_secret_resources" {
  # IAM binds a secret resource, not one version; document this provider boundary.
  # Values must identify existing webhook/App-key resources, never secret values.
  type = map(object({ project = string, secret_id = string }))
}

resource "google_artifact_registry_repository_iam_member" "worker_image_read" {
  for_each   = var.worker_image_repositories
  project    = each.value.project
  location   = each.value.location
  repository = each.value.repository
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${var.service_accounts.worker}"
}

resource "google_cloud_run_v2_service_iam_member" "worker_bootstrap_only" {
  project  = var.bootstrap_service.project
  location = var.bootstrap_service.location
  name     = var.bootstrap_service.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.service_accounts.worker}"
}

resource "google_secret_manager_secret_iam_member" "controller_exact_secrets" {
  for_each  = var.controller_secret_resources
  project   = each.value.project
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_accounts.controller}"
}

# Deliberately no worker Firestore, Secret Manager, Compute, actAs, backend,
# management project-role or retirement invocation authority. This does not
# revoke legacy/inherited permissions; source migration must remove old bindings.
# Provisioner Compute/actAs, cleanup and scheduler/deployer permissions belong
# to the root-composed resource/caller matrix, with exact targets and live tests.
