output "project_id" {
  description = "GCP Project ID"
  value       = var.project_id
}

output "region" {
  description = "GCP Region"
  value       = var.region
}

output "zone" {
  description = "GCP Zone"
  value       = var.zone
}

output "cloudbuild_service_account" {
  description = "Cloud Build service account email"
  value       = module.iam.cloudbuild_sa_email
}

output "webhook_trigger_name" {
  description = "Name of the GitHub webhook Cloud Build trigger"
  value       = google_cloudbuild_trigger.github_webhook.name
}

output "webhook_url" {
  description = "Complete sensitive Cloud Build webhook endpoint; empty until the operator API key and secret are configured."
  sensitive   = true
  value       = var.webhook_api_key != "" && var.github_webhook_secret != "" ? "https://cloudbuild.googleapis.com/v1/projects/${var.project_id}/triggers/${google_cloudbuild_trigger.github_webhook.trigger_id}:webhook?key=${urlencode(var.webhook_api_key)}&secret=${urlencode(var.github_webhook_secret)}" : ""
}

output "github_trigger_id" {
  description = "ID of the GitHub webhook Cloud Build trigger"
  value       = google_cloudbuild_trigger.github_webhook.trigger_id
}

output "github_trigger_repo" {
  description = "GitHub repository connected to the trigger"
  value       = "${var.github_repo_owner}/${var.github_repo_name}"
}

output "cleanup_trigger_name" {
  description = "Name of the cleanup Cloud Build trigger"
  value       = google_cloudbuild_trigger.cleanup.name
}

output "cleanup_pubsub_topic" {
  description = "Pub/Sub topic for cleanup triggers"
  value       = google_pubsub_topic.cleanup_trigger.name
}

output "instance_template_name" {
  description = "The name of the created instance template"
  value       = google_compute_instance_template.runner_template.name
}

output "max_runner_vms" {
  description = "Maximum number of runner VMs for autoscaling"
  value       = var.max_runner_vms
}

output "runner_count" {
  description = "Number of runners per VM instance"
  value       = var.runner_count
}

output "infrastructure_config" {
  description = "Configuration values for Cloud Functions"
  value = {
    project_id                      = var.project_id
    zone                            = var.zone
    instance_template_name          = google_compute_instance_template.runner_template.name
    max_runner_vms                  = var.max_runner_vms
    runner_count                    = var.runner_count
    machine_type                    = var.machine_type
    webhook_secret_name             = google_secret_manager_secret.webhook_secret.secret_id
    github_repo_owner               = var.github_repo_owner
    github_repo_name                = var.github_repo_name
    cloudbuild_service_account      = module.iam.cloudbuild_sa_email
    webhook_handler_service_account = module.iam.webhook_handler_sa_email
    required_runner_labels          = var.required_runner_labels
  }
}
