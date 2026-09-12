packer {
  required_plugins {
    qemu = {
      version = "= 1.1.4"
      source  = "github.com/hashicorp/qemu"
    }
  }
}

variable "ubuntu_image" { type = string }
variable "ubuntu_image_sha256" { type = string }
variable "bundle_directory" { type = string }
variable "trusted_root" { type = string }
variable "trusted_root_sha256" { type = string }
variable "asterctl_binary" { type = string }
variable "build_ssh_public_key" { type = string }
variable "build_ssh_private_key" {
  type = string
  sensitive = true
}
variable "output_directory" {
  type = string
  default = "output-aster-qcow2"
}

source "qemu" "aster" {
  # Supply the reviewed, checksum-pinned Ubuntu24.04 amd64 cloud-image file.
  # Packer/QEMU/plugins and this base are release-engineering dependencies, not
  # installation dependencies. Build on a disposable Linux/KVM machine.
  iso_url          = var.ubuntu_image
  iso_checksum     = "sha256:${var.ubuntu_image_sha256}"
  disk_image       = true
  format           = "qcow2"
  accelerator      = "kvm"
  machine_type     = "q35"
  cpu_model        = "host"
  cpus             = 4
  memory           = 4096
  disk_size        = "100G"
  headless         = true
  net_device       = "virtio-net"
  disk_interface   = "virtio"
  output_directory = var.output_directory
  vm_name          = "aster-ubuntu24.04-amd64.qcow2"
  ssh_username     = "aster-builder"
  ssh_private_key_file = var.build_ssh_private_key
  ssh_timeout      = "20m"
  shutdown_command = "sudo sh -c 'rm -f /etc/sudoers.d/90-cloud-init-users; /sbin/shutdown -P now'"
  cd_label         = "cidata"
  cd_content = {
    "meta-data" = "instance-id: aster-build-only\nlocal-hostname: aster-build\n"
    "user-data" = "#cloud-config\nusers:\n  - name: aster-builder\n    lock_passwd: true\n    groups: [sudo]\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - ${var.build_ssh_public_key}\nssh_pwauth: false\ndisable_root: true\npackage_update: false\npackage_upgrade: false\n"
  }
}

build {
  sources = ["source.qemu.aster"]
  provisioner "shell" {
    inline = ["sudo mkdir -p /opt/aster/media /etc/aster /usr/local/lib/aster", "sudo chown aster-builder /opt/aster/media"]
  }
  provisioner "file" {
    source = "${var.bundle_directory}/"
    destination = "/opt/aster/media/"
  }
  provisioner "file" {
    source = var.asterctl_binary
    destination = "/tmp/asterctl"
  }
  provisioner "file" {
    source = var.trusted_root
    destination = "/tmp/aster-root.json"
  }
  provisioner "file" {
    source = "${path.root}/first-boot.sh"
    destination = "/tmp/first-boot.sh"
  }
  provisioner "file" {
    source = "${path.root}/generalize.sh"
    destination = "/tmp/generalize.sh"
  }
  provisioner "shell" {
    environment_vars = ["ASTER_TRUSTED_ROOT_SHA256=${var.trusted_root_sha256}"]
    inline = [
      "printf '%s  /tmp/aster-root.json\\n' \"$ASTER_TRUSTED_ROOT_SHA256\" | sha256sum -c -",
      "sudo install -m755 /tmp/asterctl /usr/local/bin/asterctl",
      "sudo install -m644 /tmp/aster-root.json /etc/aster/trusted-root.json",
      "printf '%s\\n' \"$ASTER_TRUSTED_ROOT_SHA256\" | sudo tee /etc/aster/trusted-root.sha256 >/dev/null",
      "sudo install -m755 /tmp/first-boot.sh /usr/local/sbin/aster-first-boot",
      "sudo chmod -R go-w /opt/aster/media",
      "sudo asterctl verify --bundle /opt/aster/media --trust-root /etc/aster/trusted-root.json --trust-root-sha256 \"$ASTER_TRUSTED_ROOT_SHA256\"",
      "sudo sh /tmp/generalize.sh"
    ]
  }
  # No customer configuration or credentials are ever put into this template.
  # First boot is an operator console action using the exact same asterctl install.
}
