output "webhook_handler_trigger_url" {
  description = "Trigger URL for webhook handler function"
  value       = google_cloudfunctions2_function.webhook_handler.service_config[0].uri
}

output "cleanup_function_trigger_url" {
  description = "Trigger URL for cleanup function"
  value       = google_cloudfunctions2_function.cleanup_function.service_config[0].uri
}