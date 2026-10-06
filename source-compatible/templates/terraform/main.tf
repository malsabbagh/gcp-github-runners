terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Cloud Build API
resource "google_project_service" "cloudbuild" {
  service = "cloudbuild.googleapis.com"
}

# Cloud Scheduler API (for cleanup scheduling)
resource "google_project_service" "cloudscheduler" {
  service = "cloudscheduler.googleapis.com"
}

# Compute API (should already be enabled)
resource "google_project_service" "compute" {
  service = "compute.googleapis.com"
}

# Pub/Sub API (for triggering cleanup builds)
resource "google_project_service" "pubsub" {
  service = "pubsub.googleapis.com"
}

# Secret Manager API (for webhook secrets)
resource "google_project_service" "secretmanager" {
  service = "secretmanager.googleapis.com"
}

# API Keys API (for webhook authentication)
resource "google_project_service" "apikeys" {
  service = "apikeys.googleapis.com"
}

# Firestore API (for state tracking)
resource "google_project_service" "firestore" {
  service = "firestore.googleapis.com"
}

# Cloud Functions API (for cleanup functions)
resource "google_project_service" "cloudfunctions" {
  service = "cloudfunctions.googleapis.com"
}

# IAM roles and service accounts
module "iam" {
  source = "./modules/iam"

  project_id = var.project_id
}

# Service account for cleanup functions
resource "google_service_account" "cleanup_function" {
  account_id   = "cleanup-function-sa"
  display_name = "Cleanup Function Service Account"
  description  = "Service account for GitHub runner cleanup Cloud Functions"
}

# IAM permissions for cleanup function
resource "google_project_iam_member" "cleanup_function_logs_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cleanup_function.email}"
}

resource "google_project_iam_member" "cleanup_function_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cleanup_function.email}"
}

resource "google_project_iam_member" "cleanup_function_firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.cleanup_function.email}"
}

resource "google_project_iam_member" "cleanup_function_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.cleanup_function.email}"
}

# Secret Manager secret for GitHub Personal Access Token (PAT)
resource "google_secret_manager_secret" "runner_token" {
  secret_id = "github-runner-token"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

# Version of the GitHub PAT (to be set manually or via setup script)
resource "google_secret_manager_secret_version" "runner_token_version" {
  secret      = google_secret_manager_secret.runner_token.id
  secret_data = var.github_pat != "" ? var.github_pat : "placeholder-set-github-pat"

  depends_on = [google_secret_manager_secret.runner_token]
}

# Secret Manager secret for GitHub webhook
resource "google_secret_manager_secret" "webhook_secret" {
  secret_id = "github-webhook-secret"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

# Version of the webhook secret (to be set manually or via setup script)
resource "google_secret_manager_secret_version" "webhook_secret_version" {
  secret      = google_secret_manager_secret.webhook_secret.id
  secret_data = var.github_webhook_secret

  depends_on = [google_secret_manager_secret.webhook_secret]
}

# Project data for Cloud Build service account
data "google_project" "project" {}

# IAM policy for secrets access
data "google_iam_policy" "secret_accessor" {
  binding {
    role = "roles/secretmanager.secretAccessor"
    members = [
      "serviceAccount:service-${data.google_project.project.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com",
      "serviceAccount:${module.iam.cloudbuild_sa_email}",
    ]
  }
}

resource "google_secret_manager_secret_iam_policy" "webhook_secret_policy" {
  project     = google_secret_manager_secret.webhook_secret.project
  secret_id   = google_secret_manager_secret.webhook_secret.secret_id
  policy_data = data.google_iam_policy.secret_accessor.policy_data
}

resource "google_secret_manager_secret_iam_policy" "runner_token_policy" {
  project     = google_secret_manager_secret.runner_token.project
  secret_id   = google_secret_manager_secret.runner_token.secret_id
  policy_data = data.google_iam_policy.secret_accessor.policy_data
}

# Pub/Sub topic for triggering cleanup builds
resource "google_pubsub_topic" "cleanup_trigger" {
  name = "runner-cleanup-trigger"
}

# Firestore database for state tracking
resource "google_firestore_database" "autoscaler_state" {
  project     = var.project_id
  name        = "autoscaler-state"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.firestore]
}

# Cloud Build trigger for GitHub webhooks
# This trigger listens for GitHub webhook events and launches VMs for queued jobs.
# Do not duplicate this trigger unless you need separate scaling logic.
resource "google_cloudbuild_trigger" "github_webhook" {
  name            = "github-runner-webhook"
  description     = "Trigger for GitHub webhook events to create runners"
  project         = var.project_id
  location        = "global"
  disabled        = false
  service_account = "projects/${var.project_id}/serviceAccounts/${module.iam.cloudbuild_sa_email}"

  webhook_config {
    secret = google_secret_manager_secret_version.webhook_secret_version.id
  }

  substitutions = {
    _PROJECT           = var.project_id
    _ZONE              = var.zone
    _INSTANCE_TEMPLATE = google_compute_instance_template.runner_template.name
    _ACTION            = "$(body.action)"
    _REPO_OWNER        = "$(body.repository.owner.login)"
    _REPO_NAME         = "$(body.repository.name)"
    _RUN_ID            = "$(body.workflow_job.run_id)"
    _JOB_ID            = "$(body.workflow_job.id)"
    _RUN_ATTEMPT       = "$(body.workflow_job.run_attempt)"
    _JOB_LABELS        = "$(body.workflow_job.labels)"
  }

  build {
    timeout = "600s"
    options {
      logging               = "CLOUD_LOGGING_ONLY"
      substitution_option   = "ALLOW_LOOSE"
      dynamic_substitutions = true
    }
    step {
      name       = "PARITY_INPUT_231:latest"
      id         = "provision-runner"
      entrypoint = "bash"
      env = [
        "ACTION=$_ACTION", "REPO_OWNER=$_REPO_OWNER", "REPO_NAME=$_REPO_NAME",
        "RUN_ID=$_RUN_ID", "JOB_ID=$_JOB_ID", "RUN_ATTEMPT=$_RUN_ATTEMPT",
        "JOB_LABELS=$_JOB_LABELS", "REQUIRED_LABELS=${jsonencode(var.required_runner_labels)}",
        "ALLOWED_OWNER=${var.github_repo_owner}", "ALLOWED_REPO=${var.github_repo_name}",
        "PROJECT_ID=${var.project_id}", "ZONE=${var.zone}",
        "INSTANCE_TEMPLATE=${google_compute_instance_template.runner_template.name}",
        "MAX_RUNNER_VMS=${var.max_runner_vms}", "BUILD_ID=$BUILD_ID"
      ]
      args = ["-c", "python3 - <<'RUNNER_PROVISIONER'\n${replace(file("${path.module}/../cloud-functions/webhook-handler/provision-runner.py"), "$", "$$")}\nRUNNER_PROVISIONER"]
    }
  }

  depends_on = [
    google_project_service.cloudbuild,
    google_secret_manager_secret.webhook_secret,
    module.iam,
  ]
}

# Cloud Build trigger for cleanup (triggered by Pub/Sub)
# This trigger is invoked by the scheduler to clean up old runner VMs.
resource "google_cloudbuild_trigger" "cleanup" {
  name            = "github-runner-cleanup"
  description     = "Trigger for cleaning up old GitHub runner instances"
  project         = var.project_id
  location        = "global"
  disabled        = false
  service_account = "projects/${var.project_id}/serviceAccounts/${module.iam.cloudbuild_sa_email}"

  pubsub_config {
    topic = google_pubsub_topic.cleanup_trigger.id
  }
  build {
    options {
      logging = "CLOUD_LOGGING_ONLY"
    }
    step {
      name       = "PARITY_INPUT_231:latest"
      id         = "reconcile-provisioning"
      wait_for   = ["-"]
      entrypoint = "bash"
      env = [
        "ACTION=reconcile", "PROJECT_ID=${var.project_id}", "ZONE=${var.zone}", "BUILD_ID=$BUILD_ID",
        "ALLOWED_OWNER=${var.github_repo_owner}", "ALLOWED_REPO=${var.github_repo_name}",
        "INSTANCE_TEMPLATE=${google_compute_instance_template.runner_template.name}",
        "MAX_RUNNER_VMS=${var.max_runner_vms}", "REQUIRED_LABELS=${jsonencode(var.required_runner_labels)}"
      ]
      args = ["-c", "python3 - <<'RUNNER_PROVISIONER'\n${replace(file("${path.module}/../cloud-functions/webhook-handler/provision-runner.py"), "$", "$$")}\nRUNNER_PROVISIONER"]
    }
    step {
      name       = "PARITY_INPUT_231:latest"
      id         = "cleanup-runners"
      wait_for   = ["-"]
      entrypoint = "bash"
      env        = ["REGION=${var.region}", "MAX_AGE_HOURS=2", "CLOUDSDK_CORE_PROJECT=${var.project_id}"]
      args       = ["-c", replace(file("${path.module}/../cloudbuild/runner-cleanup.sh"), "$", "$$")]
    }

  }

  depends_on = [
    google_project_service.cloudbuild,
    google_pubsub_topic.cleanup_trigger,
    module.iam
  ]
}

# Cloud Scheduler for cleanup (publishes to Pub/Sub)
resource "google_cloud_scheduler_job" "runner_cleanup" {
  name             = "runner-cleanup-schedule"
  description      = "Scheduled cleanup of old GitHub runner instances"
  schedule         = "0 */2 * * *" # Every 2 hours
  time_zone        = "UTC"
  attempt_deadline = "320s"

  pubsub_target {
    topic_name = google_pubsub_topic.cleanup_trigger.id
    data = base64encode(jsonencode({
      action    = "cleanup"
      timestamp = timestamp()
    }))
  }
  depends_on = [
    google_project_service.cloudscheduler,
    google_project_service.pubsub,
    google_pubsub_topic.cleanup_trigger
  ]
}

# Instance template for runner VMs
# Only one template should be active at a time. Use the runner_isolation_mode variable to select the startup script.
resource "google_compute_instance_template" "runner_template" {
  name_prefix  = "${substr(var.instance_template_name, 0, 36)}-"
  project      = var.project_id
  machine_type = var.machine_type

  disk {
    source_image = "PARITY_INPUT_337/debian-12"
    auto_delete  = true
    boot         = true
    disk_size_gb = var.disk_size
    disk_type    = "pd-ssd"
  }

  network_interface {
    network = "default"
    access_config {
      // Ephemeral IP
    }
  }

  # Network tags for identification and potential firewall rules
  tags = ["github-runner", "github-runner-outbound", "https-server"]

  scheduling {
    provisioning_model          = "SPOT"
    instance_termination_action = "DELETE"
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    preemptible                 = true
  }

  service_account {
    email  = module.iam.cloudbuild_sa_email
    scopes = ["cloud-platform"]
  }

  labels = {
    purpose = "github-runner"
  }

  metadata = {
    # Repository configuration from Terraform variables
    repo-owner              = var.github_repo_owner
    repo-name               = var.github_repo_name
    runner-count            = var.runner_count
    startup-script          = var.runner_isolation_mode == "docker" ? file("${path.module}/../cloudbuild/runner-startup-multi-user-docker.sh") : file("${path.module}/../cloudbuild/runner-startup-multi-user.sh")
    shutdown-script         = var.runner_isolation_mode == "docker" ? file("${path.module}/../cloudbuild/runner-shutdown-multi-user-docker.sh") : file("${path.module}/../cloudbuild/runner-shutdown-multi-user.sh")
    docker-runner-image     = var.docker_runner_image
    shutdown-script-timeout = "300"
    cleanup-pubsub-topic    = "hybrid-cleanup-events"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Optional: Create a one-off VM from the template for validation
resource "google_compute_instance_from_template" "runner_test" {
  count                    = var.create_test_instance ? 1 : 0
  project                  = var.project_id
  name                     = "runner-template-validation-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  zone                     = var.zone
  source_instance_template = google_compute_instance_template.runner_template.self_link

  labels = {
    purpose    = "github-runner"
    validation = "true"
  }

  # Metadata can be set directly since this is a test instance
  metadata = {
    repo-owner = coalesce(var.repo_owner, var.github_repo_owner)
    repo-name  = coalesce(var.repo_name, var.github_repo_name)
  }
}
