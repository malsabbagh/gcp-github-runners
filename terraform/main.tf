locals {
  function_name  = "${var.name_prefix}-controller"
  controller_url = "https://${var.region}-${var.project_id}.cloudfunctions.net/${local.function_name}"
  secret_refs = {
    webhook = var.webhook_secret_version
    app_key = var.github_app_private_key_secret_version

  }
  secret_resources = { for key, ref in local.secret_refs : key => {
    project   = split("/", ref)[1]
    secret_id = split("/", ref)[3]
  } }
  runtime_environment = {
    GOOGLE_CLOUD_PROJECT                = var.project_id
    DEFAULT_ZONE                        = var.zone
    INSTANCE_TEMPLATE_NAME              = google_compute_instance_template.worker.name
    MAX_RUNNER_VMS                      = tostring(var.max_runner_vms)
    RUNNERS_PER_VM                      = "1"
    FIRESTORE_DATABASE_ID               = google_firestore_database.state.name
    VM_CREATION_TIMEOUT_SECONDS         = "600"
    GITHUB_WEBHOOK_SECRET_VERSION       = var.webhook_secret_version
    GITHUB_APP_PRIVATE_KEY_VERSION      = var.github_app_private_key_secret_version
    BUILDER_IMAGE                       = var.builder_image
    WORKER_SERVICE_ACCOUNT              = google_service_account.runtime["worker"].email
    WORKER_SERVICE_ACCOUNT_UNIQUE_ID    = google_service_account.runtime["worker"].unique_id
    ALLOCATION_BROKER_URL               = "${local.controller_url}/bootstrap"
    GITHUB_REPO_OWNER                   = var.repository_owner
    GITHUB_REPO_NAME                    = var.repository_name
    CLOUDBUILD_SERVICE_ACCOUNT          = google_service_account.runtime["provisioner"].email
    RUNNER_LABELS_JSON                  = jsonencode(var.registered_runner_labels)
    REQUIRED_RUNNER_LABELS_B64          = base64encode(jsonencode(var.required_runner_labels))
    RUNNER_ROUTING_LABEL                = var.runner_routing_label
    GITHUB_APP_ID                       = var.github_app_id
    GITHUB_APP_INSTALLATION_ID          = var.github_app_installation_id
    GITHUB_REPOSITORY_ID                = var.github_repository_id
    RUNNER_GROUP_ID                     = var.runner_group_id
    JIT_RELEASE_WINDOW_MS               = "60000"
    CONTROLLER_AUDIENCE                 = local.controller_url
    ADMIN_SERVICE_ACCOUNT_UNIQUE_ID     = var.admin_subject
    SCHEDULER_SERVICE_ACCOUNT_UNIQUE_ID = google_service_account.runtime["cleanup"].unique_id
    WEBHOOK_ENABLED                     = tostring(var.runtime_readiness.webhook_enabled)
    MANAGEMENT_ENABLED                  = tostring(var.runtime_readiness.management_enabled)
    SCHEDULED_ENABLED                   = tostring(var.runtime_readiness.scheduled_enabled)
    JIT_PROVIDER_LIFETIME_QUALIFIED     = tostring(var.runtime_readiness.jit_provider_lifetime_qualified)
    APPROVED_QUIESCENCE                 = tostring(var.runtime_readiness.approved_quiescence)
    DISPATCH_ENABLED                    = tostring(var.runtime_readiness.dispatch_enabled)
    WORKER_DRAIN_QUALIFIED              = tostring(var.runtime_readiness.worker_drain_qualified)
    WORKER_STOP_QUALIFIED               = tostring(var.runtime_readiness.worker_stop_qualified)

  }
}
resource "google_project_service" "required" {
  for_each           = toset(["compute.googleapis.com", "cloudfunctions.googleapis.com", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "firestore.googleapis.com", "secretmanager.googleapis.com", "cloudscheduler.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "iam.googleapis.com", "storage.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}
resource "google_service_account" "runtime" {
  for_each     = toset(["controller", "provisioner", "cleanup", "worker"])
  account_id   = "${var.name_prefix}-${each.key}"
  display_name = "One-job runner ${each.key}"
  depends_on   = [google_project_service.required]
}
resource "google_firestore_database" "state" {
  name                    = var.firestore_database_id
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  deletion_policy         = "ABANDON"
  delete_protection_state = var.deletion_protection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  depends_on              = [google_project_service.required]
}
resource "google_compute_network" "workers" {
  name                    = "${var.name_prefix}-private"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required]
}
resource "google_compute_subnetwork" "workers" {
  name                     = "${var.name_prefix}-workers"
  region                   = var.region
  ip_cidr_range            = var.network_cidr
  network                  = google_compute_network.workers.id
  private_ip_google_access = true
}
resource "google_compute_router" "workers" {
  name    = "${var.name_prefix}-egress"
  region  = var.region
  network = google_compute_network.workers.id
}
resource "google_compute_router_nat" "workers" {
  name                               = "${var.name_prefix}-egress"
  router                             = google_compute_router.workers.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.workers.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]

  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"

  }
}
resource "google_compute_instance_template" "worker" {
  name_prefix    = "${var.name_prefix}-job-"
  machine_type   = var.machine_type
  region         = var.region
  can_ip_forward = false
  labels         = merge(var.runner_labels, { purpose = "github-runner" })
  disk {
    source_image = var.worker_image
    auto_delete  = true
    boot         = true
    disk_size_gb = var.worker_disk_size_gb
    disk_type    = "pd-balanced"

  }
  network_interface { subnetwork = google_compute_subnetwork.workers.id }
  service_account {
    email  = google_service_account.runtime["worker"].email
    scopes = []

  }
  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "DELETE"

  }
  metadata = {
    runner-count           = "1"
    worker-profile         = "trusted-private-one-job"
    block-project-ssh-keys = "true"
    enable-oslogin         = "true"
    serial-port-enable     = "false"

  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true

  }
  lifecycle { create_before_destroy = true }
}
module "iam" {
  source                = "./modules/iam"
  project_id            = var.project_id
  service_accounts      = { for role, account in google_service_account.runtime : role => account.email }
  name_prefix           = var.name_prefix
  firestore_database_id = google_firestore_database.state.name
  depends_on            = [google_project_service.required]
}
module "controller" {
  source                    = "./modules/cloud-function"
  project_id                = var.project_id
  region                    = var.region
  zone                      = var.zone
  name                      = local.function_name
  webhook_handler_sa_email  = google_service_account.runtime["controller"].email
  cleanup_function_sa_email = google_service_account.runtime["cleanup"].email
  webhook_secret_version    = var.webhook_secret_version
  archive_path              = var.controller_archive_path
  build_service_account     = var.function_build_service_account
  environment               = local.runtime_environment
  depends_on                = [module.iam, google_project_service.required]
}
module "worker_access" {
  source                      = "./modules/worker-access"
  service_accounts            = { for role, account in google_service_account.runtime : role => account.email }
  bootstrap_service           = { project = var.project_id, location = var.region, name = module.controller.service_name }
  controller_secret_resources = local.secret_resources
}
resource "google_cloud_scheduler_job" "recovery" {
  name             = "${var.name_prefix}-recovery"
  region           = var.region
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  paused           = var.scheduler_paused
  attempt_deadline = "300s"
  http_target {
    uri         = "${local.controller_url}/management/scheduled"
    http_method = "POST"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oidc_token {
      service_account_email = google_service_account.runtime["cleanup"].email
      audience              = local.controller_url

    }

  }
  retry_config {
    retry_count          = 3
    min_backoff_duration = "10s"
    max_backoff_duration = "60s"
    max_doublings        = 3

  }
  depends_on = [module.controller, google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "provisioner_image" {
  for_each   = var.builder_image_repository == null ? {} : { builder = var.builder_image_repository }
  project    = each.value.project
  location   = each.value.location
  repository = each.value.repository
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime["provisioner"].email}"
}
resource "google_compute_image_iam_member" "provisioner_boot_image" {
  project = split("/", var.worker_image)[1]
  image   = split("/", var.worker_image)[4]
  role    = "roles/compute.imageUser"
  member  = "serviceAccount:${google_service_account.runtime["provisioner"].email}"
}
