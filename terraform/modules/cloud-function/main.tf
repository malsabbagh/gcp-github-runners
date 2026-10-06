variable "name" {
  type = string
}
variable "archive_path" {
  type = string
}
variable "build_service_account" {
  type = string
}
variable "environment" {
  type = map(string)
}
resource "google_storage_bucket" "source" {
  name                        = "${substr(var.project_id, 0, 20)}-${substr(var.name, 0, 25)}-${substr(sha256("${var.project_id}/${var.name}"), 0, 16)}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
}
resource "google_storage_bucket_iam_member" "builder_source" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.build_service_account}"
}
resource "google_storage_bucket_object" "controller" {
  name   = "controller-${filesha256(var.archive_path)}.zip"
  bucket = google_storage_bucket.source.name
  source = var.archive_path
}
resource "google_cloudfunctions2_function" "controller" {
  name        = var.name
  location    = var.region
  description = "One-job runner controller: HMAC webhook plus identity-bound bootstrap and management"
  build_config {
    runtime           = "nodejs24"
    entry_point       = "controllerHttp"
    docker_repository = google_artifact_registry_repository.function_images.id
    service_account   = "projects/${var.project_id}/serviceAccounts/${var.build_service_account}"
    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = google_storage_bucket_object.controller.name

      }

    }

  }
  service_config {
    service_account_email            = var.webhook_handler_sa_email
    available_memory                 = "512M"
    timeout_seconds                  = 300
    max_instance_count               = 5
    min_instance_count               = 0
    max_instance_request_concurrency = 1
    ingress_settings                 = "ALLOW_ALL"
    environment_variables            = var.environment

  }
  depends_on = [google_storage_bucket_iam_member.builder_source, google_artifact_registry_repository_iam_member.builder_images, google_project_iam_member.builder_logs, google_project_iam_member.builder_generated_source]
}
# GitHub cannot mint Google OIDC tokens. Public transport is limited by the
# runtime's HMAC verification and separate fail-closed management/bootstrap auth.
resource "google_cloud_run_service_iam_member" "github_transport" {
  project  = var.project_id
  location = var.region
  service  = google_cloudfunctions2_function.controller.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
output "uri" { value = google_cloudfunctions2_function.controller.service_config[0].uri }
output "service_name" { value = google_cloudfunctions2_function.controller.name }

# The compilation identity is separate from all four runtime identities.
# Source: official Cloud Run functions build-service-account requirements.
data "google_project" "selected" { project_id = var.project_id }
resource "google_artifact_registry_repository" "function_images" {
  location      = var.region
  repository_id = "${var.name}-images"
  format        = "DOCKER"
}
resource "google_artifact_registry_repository_iam_member" "builder_images" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.function_images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.build_service_account}"
}
resource "google_project_iam_member" "builder_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${var.build_service_account}"
}
# Functions may copy supplied sources into its managed staging bucket. Reading
# only the upload object is insufficient for a custom compilation account.
resource "google_project_iam_member" "builder_generated_source" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${var.build_service_account}"
  condition {
    title      = "This function region staging sources"
    expression = "resource.type == 'storage.googleapis.com/Object' && resource.name.startsWith('projects/_/buckets/gcf-v2-sources-${data.google_project.selected.number}-${var.region}/')"
  }
}
resource "google_cloud_run_service_iam_member" "scheduler_invocation" {
  project  = var.project_id
  location = var.region
  service  = google_cloudfunctions2_function.controller.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.cleanup_function_sa_email}"
}

output "source_bucket_name" { value = google_storage_bucket.source.name }
