# Provider is mocked: no credential loading, cloud requests or deployment.
mock_provider "google" {}
variables {
  project_id                            = "example-project"
  region                                = "us-central1"
  zone                                  = "us-central1-a"
  repository_owner                      = "example"
  repository_name                       = "runner-workload"
  repository_branch                     = "main"
  controller_archive_path               = "tests/fixtures/controller.txt"
  function_build_service_account        = "function-builder@example-project.iam.gserviceaccount.com"
  worker_image                          = "projects/example-project/global/images/runner-qualified-image"
  builder_image                         = "example.invalid/build/provisioner@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  webhook_secret_version                = "projects/example-project/secrets/github-webhook/versions/1"
  github_app_private_key_secret_version = "projects/example-project/secrets/github-app-key/versions/1"
  github_app_id                         = "123456"
  github_app_installation_id            = "123456"
  github_repository_id                  = "123456"
  admin_subject                         = "123456789012345678901"
}
run "private_one_job_spot_defaults" {
  command = plan
  assert {
    condition     = google_compute_instance_template.worker.scheduling[0].provisioning_model == "SPOT" && google_compute_instance_template.worker.scheduling[0].instance_termination_action == "DELETE" && !google_compute_instance_template.worker.scheduling[0].automatic_restart
    error_message = "Worker must terminate as one-job Spot capacity."
  }
  assert {
    condition     = length(google_compute_instance_template.worker.network_interface[0].access_config) == 0 && length(google_compute_instance_template.worker.service_account[0].scopes) == 0
    error_message = "Worker must have no external address or OAuth access scopes."
  }
  assert {
    condition     = google_compute_instance_template.worker.metadata["runner-count"] == "1" && google_compute_instance_template.worker.metadata["worker-profile"] == "trusted-private-one-job"
    error_message = "Shared-host runner metadata must never return."
  }
  assert {
    condition     = google_cloud_scheduler_job.recovery.paused && google_cloud_scheduler_job.recovery.http_target[0].uri == "https://us-central1-example-project.cloudfunctions.net/runner-controller/management/scheduled" && google_cloud_scheduler_job.recovery.http_target[0].oidc_token[0].audience == "https://us-central1-example-project.cloudfunctions.net/runner-controller"
    error_message = "Recovery must use the authenticated controller route, paused by default."
  }
  assert {
    condition     = local.runtime_environment.WEBHOOK_ENABLED == "false" && local.runtime_environment.MANAGEMENT_ENABLED == "false" && local.runtime_environment.APPROVED_QUIESCENCE == "false" && local.runtime_environment.JIT_PROVIDER_LIFETIME_QUALIFIED == "false"
    error_message = "Unqualified provider side effects must remain disabled."
  }
}
run "separate_runtime_authorities" {
  command = plan
  assert {
    condition     = length(module.iam.role_permissions.worker) == 0 && length(module.iam.role_permissions.cleanup) == 0 && !contains(module.iam.role_permissions.provisioner, "compute.instances.delete") && contains(module.iam.role_permissions.controller, "compute.instances.delete")
    error_message = "Worker and scheduler must never receive project compute roles; retirement belongs to the controller."
  }
  assert {
    condition     = length(distinct([for account in google_service_account.runtime : account.account_id])) == 4
    error_message = "Controller, provisioner, cleanup and worker account ids must differ."
  }
  assert {
    condition     = length(google_monitoring_alert_policy.controller_errors) == 0 && length(google_artifact_registry_repository_iam_member.provisioner_image) == 0
    error_message = "Monitoring and private builder repository access must require explicit input."
  }
}
run "reject_shared_routing" {
  command = plan
  variables { runner_routing_label = "self-hosted" }
  expect_failures = [var.registered_runner_labels]
}
run "reject_secret_alias" {
  command = plan
  variables { webhook_secret_version = "projects/example-project/secrets/github-webhook/versions/latest" }
  expect_failures = [var.webhook_secret_version]
}
run "reject_external_secret" {
  command = plan
  variables { webhook_secret_version = "projects/another-project/secrets/github-webhook/versions/1" }
  expect_failures = [var.webhook_secret_version]
}
run "reject_region_mismatch" {
  command = plan
  variables { zone = "europe-west1-a" }
  expect_failures = [var.zone]
}
run "accept_runtime_safe_id_boundary_and_multidigit_region" {
  command = plan
  variables {
    github_app_id              = "9007199254740991"
    github_app_installation_id = "9007199254740991"
    github_repository_id       = "9007199254740991"
    runner_group_id            = "9007199254740991"
    region                     = "europe-west12"
    zone                       = "europe-west12-a"
  }
  assert {
    condition     = local.runtime_environment.GITHUB_APP_ID == "9007199254740991" && local.runtime_environment.GITHUB_APP_INSTALLATION_ID == "9007199254740991" && local.runtime_environment.GITHUB_REPOSITORY_ID == "9007199254740991" && local.runtime_environment.RUNNER_GROUP_ID == "9007199254740991" && local.runtime_environment.DEFAULT_ZONE == "europe-west12-a"
    error_message = "Terraform must preserve exact safe decimal identifiers and support valid multi-digit GCP regions."
  }
}
run "reject_runtime_unsafe_id_boundary" {
  command = plan
  variables {
    github_app_id              = "9007199254740992"
    github_app_installation_id = "9007199254740992"
    github_repository_id       = "9007199254740992"
    runner_group_id            = "9007199254740992"
  }
  expect_failures = [var.github_app_id, var.github_app_installation_id, var.github_repository_id, var.runner_group_id]
}
run "reject_runtime_id_overlength" {
  command = plan
  variables {
    github_app_id              = "10000000000000000"
    github_app_installation_id = "10000000000000000"
    github_repository_id       = "10000000000000000"
    runner_group_id            = "10000000000000000"
  }
  expect_failures = [var.github_app_id, var.github_app_installation_id, var.github_repository_id, var.runner_group_id]
}
run "bounded_unique_source_bucket_at_maximum_inputs" {
  command = plan
  variables {
    project_id                            = "example-abcdefghijklmnopqrstuv"
    name_prefix                           = "abcdefghijklmnopqr"
    function_build_service_account        = "function-builder@example-abcdefghijklmnopqrstuv.iam.gserviceaccount.com"
    webhook_secret_version                = "projects/example-abcdefghijklmnopqrstuv/secrets/github-webhook/versions/1"
    github_app_private_key_secret_version = "projects/example-abcdefghijklmnopqrstuv/secrets/github-app-key/versions/1"
  }
  assert {
    condition     = length(module.controller.source_bucket_name) <= 63 && module.controller.source_bucket_name == "${substr(var.project_id, 0, 20)}-${substr("${var.name_prefix}-controller", 0, 25)}-${substr(sha256("${var.project_id}/${var.name_prefix}-controller"), 0, 16)}" && can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", module.controller.source_bucket_name))
    error_message = "Maximum portable identifiers must produce a deterministic GCS-safe name with full-namespace hash coverage."
  }
}
