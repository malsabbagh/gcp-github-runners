output "project_id" { value = var.project_id }
output "region" { value = var.region }
output "zone" { value = var.zone }
output "webhook_url" { value = "${local.controller_url}/webhook" }
output "controller_url" { value = local.controller_url }
output "instance_template_name" { value = google_compute_instance_template.worker.name }
output "cloudbuild_service_account" { value = google_service_account.runtime["provisioner"].email }
output "infrastructure_config" {
  value = {
    project_id                            = var.project_id
    region                                = var.region
    zone                                  = var.zone
    instance_template_name                = google_compute_instance_template.worker.name
    max_runner_vms                        = var.max_runner_vms
    runners_per_vm                        = 1
    runner_count                          = 1
    machine_type                          = var.machine_type
    github_repo_owner                     = var.repository_owner
    github_repo_name                      = var.repository_name
    repository_branch                     = var.repository_branch
    required_runner_labels                = var.required_runner_labels
    webhook_handler_service_account       = google_service_account.runtime["controller"].email
    cloudbuild_service_account            = google_service_account.runtime["provisioner"].email
    github_webhook_secret                 = split("/", var.webhook_secret_version)[3]
    github_webhook_secret_version         = var.webhook_secret_version
    github_app_private_key_secret_version = var.github_app_private_key_secret_version
    firestore_database_id                 = google_firestore_database.state.name
    service_accounts                      = { for role, account in google_service_account.runtime : role => account.email }
    worker_service_account_unique_id      = google_service_account.runtime["worker"].unique_id
    webhook_url                           = "${local.controller_url}/webhook"
    controller_url                        = local.controller_url
    runtime_environment                   = local.runtime_environment
    scheduler_paused                      = var.scheduler_paused

  }
}
