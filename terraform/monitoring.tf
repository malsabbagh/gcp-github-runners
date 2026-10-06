variable "monitoring_enabled" {
  type    = bool
  default = false
}
variable "monitoring_notification_channels" {
  type        = list(string)
  default     = []
  description = "Existing notification channel resource names, no addresses or credentials."
}
resource "google_logging_metric" "controller_errors" {
  count  = var.monitoring_enabled ? 1 : 0
  name   = "${var.name_prefix}_controller_errors"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.function_name}\" AND severity>=ERROR"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
  depends_on = [google_project_service.required]
}
resource "google_monitoring_alert_policy" "controller_errors" {
  count                 = var.monitoring_enabled ? 1 : 0
  display_name          = "${var.name_prefix} controller errors"
  combiner              = "OR"
  notification_channels = var.monitoring_notification_channels
  conditions {
    display_name = "Controller errors within five minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.controller_errors[0].name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  documentation {
    content   = "Inspect controller errors, scheduler delivery, and durable allocation charges. Never release ambiguous reservations based only on logs or filtered VM inventory."
    mime_type = "text/markdown"
  }
}
