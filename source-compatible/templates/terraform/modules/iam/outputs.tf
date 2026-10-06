output "cloudbuild_sa_email" {
  description = "Email of the Cloud Build service account"
  value       = google_service_account.cloudbuild.email
}

output "github_runner_manager_role_id" {
  description = "ID of the custom GitHub runner manager role"
  value       = google_project_iam_custom_role.github_runner_manager.id
}

output "webhook_handler_sa_email" {
  description = "Email of the webhook handler Cloud Function service account"
  value       = google_service_account.webhook_handler.email
}