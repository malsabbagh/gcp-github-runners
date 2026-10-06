packer {
  required_plugins {
    googlecompute = {
      version = "= 1.2.7"
      source  = "github.com/hashicorp/googlecompute"
    }
  }
}

variable "project_id" { type = string }
variable "zone" { type = string }
variable "subnetwork" { type = string }
variable "source_image" {
  type = string
  validation {
    condition     = can(regex("^projects/[a-z0-9-]+/global/images/[a-z0-9-]+$", var.source_image))
    error_message = "Pin an exact Debian 12 GCE image resource; image families are unsupported."
  }
}
variable "image_name" { type = string }
variable "apt_snapshot" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{8}T[0-9]{6}Z$", var.apt_snapshot))
    error_message = "Supply a fixed authenticated Debian snapshot timestamp."
  }
}

source "googlecompute" "worker" {
  project_id                      = var.project_id
  zone                            = var.zone
  source_image                    = split("/", var.source_image)[4]
  source_image_project_id         = [split("/", var.source_image)[1]]
  image_name                      = var.image_name
  subnetwork                      = var.subnetwork
  omit_external_ip                = true
  use_internal_ip                 = true
  disable_default_service_account = true
  ssh_username                    = "image-builder"
  disk_size                       = 30
  image_labels                    = { worker-profile = "trusted-private-one-job" }
}

build {
  sources = ["source.googlecompute.worker"]
  provisioner "shell" { inline = ["mkdir -p /tmp/worker-build"] }
  provisioner "file" {
    sources     = ["startup", "docker", "cloudbuild"]
    destination = "/tmp/worker-build/"
  }
  provisioner "shell" {
    inline = ["sudo env APT_SNAPSHOT='${var.apt_snapshot}' bash /tmp/worker-build/cloudbuild/bake-worker.sh"]
  }
  post-processor "manifest" { output = "worker-image-manifest.json" }
}
