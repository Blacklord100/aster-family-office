# Virtual appliance recipe

This recipe produces a generalized Ubuntu24.04 amd64 QCOW2 containing the same
verified release media used for server installation. It is a reproducible recipe,
not a claim that a hypervisor image has been built or certified. Qualification
requires a disposable Linux/KVM builder and a second clean VM for first boot.

Pin the Ubuntu cloud-image SHA256, Packer binary, QEMU package versions and QEMU
plugin1.1.4 in the retained build receipt. Never use an unverified `current` image.
Generate a new temporary SSH build key; supply its public and private paths to
Packer. Review the publisher root fingerprint through a separate trusted channel.
Run `packer init`, `packer validate`, then `packer build` with all variables in
`aster.pkr.hcl`; retain the input lock and final QCOW2 SHA256 beside the release.
This process builds from pinned inputs; byte-for-byte QCOW2 reproducibility is not
promised because OS initialization timestamps and filesystem identifiers differ.

The image never runs Aster during construction. It contains no application keys,
database, TLS private CA, sessions, recovery identity or default administrator
password. The build SSH key, machine identity, SSH host keys, random seed and
cloud-init state are removed. No template account may be exposed as a customer
login. Inject a **customer-owned console administrator** and network configuration
using a fresh NoCloud seed before first boot. Remove the build `cidata` disk.
The customer seed must not include a shared/default password or the build key.

On the customer console, configure the LAN hostname, trustworthy local time,
encrypted storage and outbound-denial policy. Then run `sudo aster-first-boot`.
It calls the same `asterctl install` used on a server, including offline runtime
installation, model import, fresh secrets and verification. The recovery recipient
is a public age key whose private identity is kept on separate controlled media.
Use `asterctl bootstrap` for the first owner and MFA. No default owner is created.

For a supplied certificate, call `asterctl install` directly with
`--tls-mode supplied` and the CLI's certificate options. Internal-CA mode requires
distributing the generated public CA certificate through office PKI; never tell
users to bypass browser certificate warnings. Exporting a QCOW2 to another
hypervisor format is a separate compatibility qualification.

Required image acceptance: two clones generate different machine/SSH/TLS/app
identities; no build key authenticates; no default account works; first offline
install and cold restart pass; the model+vision hashes match; source/archive
acceptance passes; actual spare-host restore passes. Until those run, this remains
an unqualified VM build recipe.

References: [Packer QEMU](https://developer.hashicorp.com/packer/integrations/hashicorp/qemu/latest/components/builder/qemu),
[cloud-init clean](https://cloudinit.readthedocs.io/en/latest/reference/cli.html#clean).
