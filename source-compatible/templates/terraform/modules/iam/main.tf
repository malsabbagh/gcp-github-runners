# IAM roles for webhook handler Cloud Function service account
resource "google_service_account" "webhook_handler" {
  account_id   = "webhook-handler"
  display_name = "GitHub Webhook Handler Cloud Function"
  description  = "Service account for the webhook handler Cloud Function"
}

resource "google_project_iam_member" "webhook_handler_firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.webhook_handler.email}"
}

resource "google_project_iam_member" "webhook_handler_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.webhook_handler.email}"
}

resource "google_project_iam_member" "webhook_handler_cloudbuild_editor" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.webhook_handler.email}"
}

# Grant webhook handler the custom GitHub runner manager role for compute permissions
resource "google_project_iam_member" "webhook_handler_compute" {
  project = var.project_id
  role    = google_project_iam_custom_role.github_runner_manager.name
  member  = "serviceAccount:${google_service_account.webhook_handler.email}"
}

# Allow webhook handler to act as service accounts (required for creating VMs with service accounts)
resource "google_project_iam_member" "webhook_handler_service_account_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.webhook_handler.email}"
}

# Service account for Cloud Build (replaces webhook handler and cleanup function)
resource "google_service_account" "cloudbuild" {
  account_id   = "github-runner-cloudbuild"
  display_name = "GitHub Runner Cloud Build Service Account"
  description  = "Service account for Cloud Build triggers managing GitHub runners"
}

# Custom IAM role for GitHub runner management with minimal permissions
resource "google_project_iam_custom_role" "github_runner_manager" {
  role_id     = "githubRunnerManager"
  title       = "GitHub Runner Manager"
  description = "Custom role with minimal permissions for managing GitHub runner instances"
  permissions = [
    "compute.instances.create",
    "compute.zoneOperations.get",
    "cloudbuild.builds.get",
    "cloudbuild.builds.list",
    "compute.instances.delete",
    "compute.instances.get",
    "compute.instances.list",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
    "compute.instances.setTags",
    "compute.instances.setServiceAccount",
    "compute.instanceTemplates.get",
    "compute.instanceTemplates.useReadOnly",
    "compute.images.useReadOnly",
    "compute.networks.use",
    "compute.networks.useExternalIp",
    "compute.subnetworks.use",
    "compute.subnetworks.useExternalIp",
    "compute.addresses.use",
    "compute.disks.create",
    "compute.disks.use",
    "compute.disks.useReadOnly",
    "compute.zones.get",
    "compute.zones.list",
    "compute.projects.get"
  ]
}

# IAM roles for Cloud Build service account
resource "google_project_iam_member" "cloudbuild_compute" {
  project = var.project_id
  role    = google_project_iam_custom_role.github_runner_manager.id
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

resource "google_project_iam_member" "cloudbuild_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

resource "google_project_iam_member" "cloudbuild_source" {
  project = var.project_id
  role    = "roles/source.reader"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Build to publish to Pub/Sub for triggering cleanup
resource "google_project_iam_member" "cloudbuild_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Scheduler to publish to Pub/Sub
resource "google_project_iam_member" "scheduler_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}

# Allow Cloud Build service account to access secrets for webhook validation
resource "google_project_iam_member" "cloudbuild_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Build service account to impersonate service accounts (required for instance creation)
resource "google_project_iam_member" "cloudbuild_service_account_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Build service account to access Firestore for state tracking
resource "google_project_iam_member" "cloudbuild_firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Allow Cloud Build service agent to subscribe to Pub/Sub (for build event triggers, etc)
resource "google_project_iam_member" "cloudbuild_service_agent_pubsub_subscriber" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
}

# Grant Artifact Registry Reader role to the Cloud Build service account so VMs can pull Docker images from Artifact Registry.
resource "google_project_iam_member" "cloudbuild_artifact_registry_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.cloudbuild.email}"
}

# Get project data for Cloud Scheduler service account
data "google_project" "project" {
  project_id = var.project_id
}
