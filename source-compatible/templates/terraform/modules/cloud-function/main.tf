# Storage bucket for Cloud Function source code
resource "google_storage_bucket" "function_source" {
  name                        = "${var.project_id}-github-runner-functions"
  location                    = var.region
  uniform_bucket_level_access = true
  
  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }
}

# Zip webhook handler source code
data "archive_file" "webhook_handler_source" {
  type        = "zip"
  output_path = "/tmp/webhook-handler.zip"
  source_dir  = "${path.root}/../cloud-functions/webhook-handler"
}

# Upload webhook handler source to bucket
resource "google_storage_bucket_object" "webhook_handler_source" {
  name   = "webhook-handler-${data.archive_file.webhook_handler_source.output_md5}.zip"
  bucket = google_storage_bucket.function_source.name
  source = data.archive_file.webhook_handler_source.output_path
}

# Webhook handler Cloud Function
resource "google_cloudfunctions2_function" "webhook_handler" {
  name        = "github-webhook-handler"
  location    = var.region
  description = "Handles GitHub webhooks for runner provisioning"

  build_config {
    runtime     = "nodejs18"
    entry_point = "webhookHandler"
    
    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.webhook_handler_source.name
      }
    }
  }

  service_config {
    max_instance_count = 10
    available_memory   = "256M"
    timeout_seconds    = 60
    
    environment_variables = {
      GOOGLE_CLOUD_PROJECT  = var.project_id
      DEFAULT_ZONE          = var.zone
      GITHUB_WEBHOOK_SECRET = var.github_webhook_secret
    }
    
    service_account_email = var.webhook_handler_sa_email
  }
}

# Allow unauthenticated invocations of webhook handler
resource "google_cloudfunctions2_function_iam_member" "webhook_handler_invoker" {
  project        = var.project_id
  location       = google_cloudfunctions2_function.webhook_handler.location
  cloud_function = google_cloudfunctions2_function.webhook_handler.name
  role           = "roles/cloudfunctions.invoker"
  member         = "allUsers"
}

# Zip cleanup function source code
data "archive_file" "cleanup_function_source" {
  type        = "zip"
  output_path = "/tmp/cleanup-function.zip"
  source_dir  = "${path.root}/../cloud-functions/cleanup-function"
}

# Upload cleanup function source to bucket
resource "google_storage_bucket_object" "cleanup_function_source" {
  name   = "cleanup-function-${data.archive_file.cleanup_function_source.output_md5}.zip"
  bucket = google_storage_bucket.function_source.name
  source = data.archive_file.cleanup_function_source.output_path
}

# Cleanup function Cloud Function
resource "google_cloudfunctions2_function" "cleanup_function" {
  name        = "runner-cleanup-function"
  location    = var.region
  description = "Cleans up old GitHub runner instances"

  build_config {
    runtime     = "nodejs18"
    entry_point = "cleanupRunners"
    
    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.cleanup_function_source.name
      }
    }
  }

  service_config {
    max_instance_count = 1
    available_memory   = "256M"
    timeout_seconds    = 540
    
    environment_variables = {
      GOOGLE_CLOUD_PROJECT = var.project_id
      DEFAULT_ZONE         = "us-central1-a"
    }
    
    service_account_email = var.cleanup_function_sa_email
  }
}