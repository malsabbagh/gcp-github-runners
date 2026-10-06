# Non-authoritative IAM members preserve existing policies. Legacy grants must
# be inventoried and removed separately; these definitions do not revoke them.
variable "name_prefix" {
  type = string
}
variable "firestore_database_id" {
  type = string
}
resource "google_project_iam_custom_role" "provisioner_compute" {
  project = var.project_id
  role_id = "${replace(var.name_prefix, "-", "_")}_provisioner"
  title   = "One-job worker provisioning"
  permissions = [
    "compute.instances.create", "compute.instances.get", "compute.instances.list",
    "compute.instances.setMetadata", "compute.instances.setLabels", "compute.instances.setServiceAccount",
    "compute.instanceTemplates.get", "compute.instanceTemplates.useReadOnly",
    "compute.disks.create", "compute.disks.use", "compute.images.useReadOnly",
    "compute.subnetworks.use", "compute.subnetworks.get", "compute.networks.get",
    "compute.zoneOperations.get", "compute.globalOperations.get", "compute.projects.get"
  ]
}
resource "google_project_iam_custom_role" "controller_compute" {
  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_retirement"
  title       = "Exact worker verification and retirement"
  permissions = ["compute.instances.get", "compute.instances.list", "compute.instances.delete", "compute.instances.stop", "compute.instances.setMetadata", "compute.zoneOperations.get"]
}
resource "google_project_iam_custom_role" "controller_builds" {
  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_build_submit"
  title       = "Internal provisioner build submission"
  permissions = ["cloudbuild.builds.create", "cloudbuild.builds.get", "cloudbuild.builds.list"]
}
resource "google_project_iam_member" "provisioner_compute" {
  project = var.project_id
  role    = google_project_iam_custom_role.provisioner_compute.name
  member  = "serviceAccount:${var.service_accounts.provisioner}"
}
resource "google_project_iam_member" "controller_compute" {
  project = var.project_id
  role    = google_project_iam_custom_role.controller_compute.name
  member  = "serviceAccount:${var.service_accounts.controller}"
}
resource "google_project_iam_member" "controller_builds" {
  project = var.project_id
  role    = google_project_iam_custom_role.controller_builds.name
  member  = "serviceAccount:${var.service_accounts.controller}"
}
resource "google_project_iam_member" "state" {
  for_each = { controller = var.service_accounts.controller, provisioner = var.service_accounts.provisioner }
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${each.value}"
  condition {
    title      = "Selected runner database only"
    expression = "resource.name == 'projects/${var.project_id}/databases/${var.firestore_database_id}'"

  }
}
resource "google_project_iam_member" "logs" {
  for_each = { controller = var.service_accounts.controller, provisioner = var.service_accounts.provisioner }
  project  = var.project_id
  role     = "roles/logging.logWriter"
  member   = "serviceAccount:${each.value}"
}
resource "google_service_account_iam_member" "controller_build_identity" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.service_accounts.provisioner}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.service_accounts.controller}"
}
resource "google_service_account_iam_member" "provisioner_worker_identity" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.service_accounts.worker}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.service_accounts.provisioner}"
}
resource "google_service_account_iam_member" "provisioner_worker_read" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.service_accounts.worker}"
  role               = "roles/iam.serviceAccountViewer"
  member             = "serviceAccount:${var.service_accounts.provisioner}"
}
# No worker project IAM, Compute, Firestore, Secret Manager, actAs or management
# authority; cleanup owns only its scheduler OIDC identity, not retirement.

resource "google_project_iam_custom_role" "provisioner_builds" {
  project     = var.project_id
  role_id     = "${replace(var.name_prefix, "-", "_")}_build_observe"
  title       = "Provisioning build status observation"
  permissions = ["cloudbuild.builds.get", "cloudbuild.builds.list"]
}
resource "google_project_iam_member" "provisioner_builds" {
  project = var.project_id
  role    = google_project_iam_custom_role.provisioner_builds.name
  member  = "serviceAccount:${var.service_accounts.provisioner}"
}
output "project_role_members" {
  value = {
    provisioner_compute = google_project_iam_member.provisioner_compute.member
    controller_compute  = google_project_iam_member.controller_compute.member
    controller_builds   = google_project_iam_member.controller_builds.member
    provisioner_builds  = google_project_iam_member.provisioner_builds.member
    state               = [for binding in google_project_iam_member.state : binding.member]
    logs                = [for binding in google_project_iam_member.logs : binding.member]
  }
}
output "role_permissions" {
  value = {
    controller  = concat(tolist(google_project_iam_custom_role.controller_compute.permissions), tolist(google_project_iam_custom_role.controller_builds.permissions))
    provisioner = concat(tolist(google_project_iam_custom_role.provisioner_compute.permissions), tolist(google_project_iam_custom_role.provisioner_builds.permissions))
    worker      = []
    cleanup     = []
  }
}
