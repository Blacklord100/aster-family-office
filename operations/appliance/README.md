# Aster appliance delivery

The appliance source now has separate deployment profiles, exact model/image
locks, an offline runtime collector, complete-media packager and a generalized VM
recipe. These are **preview release tools**. A signed, production-qualified Linux
appliance is not established by unit tests or the existing macOS demonstration.
Use the final qualification receipts to determine which candidate actually passed.

## Supported target and release media

The first candidate is Ubuntu 24.04 LTS, Linux amd64, one independently administered
office, local Gemma 4 E4B inference. The full workload qualification profile is
8 CPU cores / 32 GiB RAM with encrypted SSD storage and at least 250 GiB free for complete media, retained candidates and sealed recovery copies.
Capacity, latency, RPO and RTO remain measurements to collect on the target, not
guarantees. There is no GPU, macOS-server, ARM64 or automatic-HA certification.

The local inspected model `gemma4:e4b-it-qat` is pinned to
`sha256:ee665637121887cf3befff38abbb1be4ee117c7db867d97a67e29049ecd7e15f`.
It contains 6 files totaling 6,146,502,701 bytes: GGUF Q4_0 weights, vision projector,
native manifest/config/parameters and the exact Apache license. The pinned Google
revision is `7edc6763a77bbca236126a361613b834c5ea0f7a`. Later upstream revisions have
different bytes; no automatic substitution is permitted. The native Ollama config
requires at least 0.30.5; the image lock selects 0.33.3. An 8,192-token context and a 12 GiB Ollama
limit are initial 32 GiB host settings to qualify, independent of the model's much
larger advertised maximum context. The model supports vision; Linux text and vision
acceptance are separate checks. [Pinned Google source](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/tree/7edc6763a77bbca236126a361613b834c5ea0f7a).

```text
release.json                     # exact inventory authenticated by TUF
metadata/                        # root, timestamp, snapshot and target metadata
payload/
  bin/asterctl                    # Linux amd64 host controller
  images/                         # all 5 saved images, no registry required
  runtime/                        # Ubuntu .deb dependency closure + inventory
  models/ollama/                  # exact manifest and every referenced blob
  config/                         # standalone profiles, TLS and entrypoints
  licenses/                       # notices and native corresponding-source archives
  sbom/                           # image/controller scans, SPDX and inventories
  docs/
  vm/                             # generalized-image build recipe
```

`release.json` lists each regular payload file's SHA-256, byte length and Unix mode,
plus all image IDs, the model digest, schema range and runtime packages. TUF
authenticates that manifest against a separately trusted publisher root. A key or
checksum found only inside an untrusted download does not establish authenticity.
Obtain the initial `asterctl` binary and trusted-root fingerprint through the
publisher's authenticated channel. Do not execute an untrusted bundled verifier
to establish trust in itself. [TUF](https://theupdateframework.io/docs/overview/).

## Build from reviewed inputs

Build on a disposable Ubuntu 24.04 amd64 release machine. Never mount an office
database, intake, archive, home directory or secrets into a builder. The image lock
pins every base by digest; npm/Python source locks and processor upstream/security
evidence remain in the source revision. Resolving new tags is an explicit review
step using `scripts/resolve-image-lock.py`, never part of installation.

1. Build `asterctl` with Go 1.27.1 and `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build
   -trimpath -o <output>/asterctl .` from `cli/`. Run its tests first.
2. Run `scripts/build-images.py --lock image-lock.json --output <new-images-dir>`.
   It exports all 5 images and records exact image IDs and tar hashes.
3. Run `scripts/collect-runtime.py --base <runtimeBase-from-image-lock>
   --output <new-runtime-dir>` on the connected builder. It uses Ubuntu's signed
   APT indexes and an empty package status to download the entire runtime dependency
   closure, including packages already installed in the builder. Preserve every
   `.deb` and the emitted versions/hashes as the immutable runtime lock.
4. Run `scripts/fetch-model.py --output <new-model-dir>` to obtain the exact reviewed
   Google artifacts, or `scripts/export-model.py --source <approved-cache>
   --output <new-model-dir>` for an existing approved cache. Both verify every
   manifest/config/weights/projector/license/parameter asset. No model is invoked.
5. Run `scripts/collect-compliance.sh` to retain SBOMs, raw scans, the exact-image
   processor assessment, runtime notices and native source material in
   `compliance/{licenses,sbom}`. The security gate
   must cover the exact 5 image IDs; missing license texts or unresolved findings
   block a distributable candidate. A receipt is evidence, not a vulnerability
   exception. Preserve original findings even where exact patched-artifact
   applicability has been independently substantiated. The sharp/libvips collector
   retains the original registry artifact, reviewed recipe, native source archives
   and transitive Cargo sources, then independently verifies them against the exact
   app image. This does not close other OS-package obligations or claim a reproducible rebuild.
   Also run `scripts/collect-controller.py --binary <asterctl> --go <actual-go-binary>
   --govulncheck <pinned-v1.8.0-binary> --output <compliance>/controller`.
   It retains the exact executable’s SPDX, notices and vulnerability results. A
   strict ordinary binary scan gates acceptance alongside the retained JSON scan;
   JSON mode’s exit status alone is insufficient.
6. Run `scripts/stage-bundle.py --spec release-spec.json --images ... --runtime ...
   --model ... --compliance ... --asterctl ... --output <new-bundle-dir>`.
   Staging rejects missing/changed files, incomplete images/runtime/vision assets,
   symlinks, a wrong-platform controller and mismatched security evidence.
7. Sign the staged manifest with `asterctl sign` using the separately controlled
   publisher keys. Production signing keys never enter normal CI. CI uses an
   ephemeral **test trust root**; its artifacts are test candidates, not publisher
   releases. Verify with the independently held root/fingerprint.
8. Run `scripts/pack-bundle.py --bundle ... --output <new-media-dir>`. It checks the
   payload again and emits deterministic compressed media split into parts smaller
   than 2 GB, with a transport inventory. Reassemble in `parts.json` order, validate
   every part and the full-stream hash, then perform TUF verification. Transport
   hashes do not replace release authentication. Retain all parts together.

The full offline media includes the runtime and model. A source archive, Compose
file or list of remote image names is not that deliverable. App-only update packs
are a future optimization; currently retain the complete verified release for
recovery. No release publication is automated by this repository workflow.
Each staged candidate includes `docs/distribution-status.json` with
`distributionReady: false`. Corresponding-source coverage for other OS packages
and runtime-service images, final license review and target qualification remain
required before public binary distribution. Passing the sharp/libvips source gate
and image scans does not waive those obligations.

## Installation and network modes

Use `asterctl install` on an empty supported host, supplying the bundle, independent
trusted root and SHA-256, private installation root, hostname, recovery recipient,
offline/connected mode and TLS mode. `--install-runtime` explicitly allows installing
the bundled runtime packages; no existing unrelated runtime is silently replaced.
APT closure simulation and installation use `--no-download`.

The two Compose files are standalone. Do not merge either with
`operations/compose.yaml`, and never add a build/pull fallback. Every service has
`pull_policy: never`; the controller loads and verifies local image IDs first.
Only Caddy publishes HTTP redirect and HTTPS ports. PostgreSQL, the web backend,
processor and Ollama expose no host port. The web container never gets a Docker
socket or host command authority. Durable storage is explicitly bound beneath the
installation root's `data/` directory, so backups can enumerate the entire set:
`postgres`, `archive`, `intake`, `ollama`, `caddy`, `secrets`, `receipts`, `health`.
Use the actual `ASTER_DATA_ROOT` generated by the controller, not an implicit
Compose named volume or an arbitrary browser download folder.

Offline: all container networks are internal, external DNS forwarding is disabled,
mail/delivery workers are absent, cloud engines are disabled, and Ollama cloud is
disabled. Local document upload and approved intake folders continue to work.
Public ACME is never used. This limits application-container egress; a host-level
firewall and isolated LAN policy must also deny host services, host proxies,
IPv6/metadata routes and other software. Never label a host air-gapped solely
because its Compose networks are internal. Qualification probes each container
and captures external DNS and direct-IP attempts on the actual target.
[Docker internal networks](https://docs.docker.com/reference/compose-file/networks/#internal).

Connected: local processing remains internal. An explicitly enabled `mailbox`
profile can access configured mail providers; the `delivery` profile can reach
configured SMTP. Both are omitted by default and require separate provider setup.
The collector has database access needed to retain mail but no route to private
inference. Its authorized provider access is a confidentiality boundary; this
mode is not an end-to-end air gap. Cloud inference is not enabled by this profile.

TLS: `internal` creates a fresh local CA in protected persistent Caddy storage.
Distribute only its public root certificate to customer browsers through office
PKI; never bypass TLS warnings or copy a template private CA. `supplied` mounts
`caddy/tls/server.crt` (leaf+chain) and `server.key` with controlled ownership.
The certificate must match the exact hostname and current trusted time. Neither
mode makes a public certificate request. Renew supplied certificates through
client PKI and rerun validation; back up Caddy trust material with the recovery set.
[Caddy local TLS](https://caddyserver.com/docs/caddyfile/directives/tls).

## Qualification and current limits

`tests/profiles.test.cjs` checks composition boundaries and missing safeguards.
Python packaging tests exercise complete inventory, tampering and transport
contracts. Process-observer tests really kill only their own synthetic child
process, proving phase detection rather than appliance recovery. These are not
network, inference, restore or hypervisor proof.

Hosted GitHub runners can run static, native and lifecycle tests. The bounded
low-context model smoke measures actual total and available RAM before admission.
Its memory cap is at most 12 GiB, with at least 2 GiB left available for the host;
this model requires at least an 8 GiB bounded cap. Smaller or busy hosts are refused.
Hosted smoke admission also records disk capacity and may
remove only the unused preinstalled Android and .NET SDK directories. It keeps
the 10 GiB reserve plus temporary image space; insufficient capacity produces a
refusal receipt. Model request failures retain partial timings and errors, and
container state, resource limits and logs are captured before cleanup. This does
not certify the 32 GiB full-workload profile.
The full dispatch requires a disposable Ubuntu 24.04 runner with labels
`self-hosted,linux,x64,aster-qualification`, at least 32 GiB RAM and 250 GiB free disk.
It must contain no customer services or data. If unavailable, qualification stays
**blocked by target resources**, with no fabricated throughput or appliance-ready
claim. This development Mac had only 16 GiB free, so no local VM or 6 GB duplicate model
was created. Its existing native demo is independent evidence.

The full dispatch currently runs an actual **same-host installation/recovery
drill**: HTTPS and MFA, harmless EML/PDF negative control, a registered synthetic
investment with exactly EUR 1,200,000 NAV and EUR 100,000 capital-call notice, both
local processing modes, original-source review and acceptance, duplicate posting
protection, archive file hashes, cold restart and sealed backup/restore into a
second private directory after stopping the original fleet. It then signs two
synthetic successor releases using the same application images and higher release
sequences. The helper observes and freezes the actual update controller after
`old-fleet-stopped` and `candidate-starting`, kills its process group, inspects the
sealed database, and runs `continue-update`. Each continuation must preserve the
accepted nonzero facts, exact archive downloads and existing MFA session scope,
while advancing the writer generation. Wrong trust roots, changed manifests,
changed payload files and a new 16 MiB test filesystem must be refused.
Receipts appear only after actual execution; these are bounded same-host controller
interruptions, not physical power loss or every migration boundary. The receipt
explicitly lists unqualified gates. This is not independent spare-host recovery or automatic HA.
The runner must use the Ubuntu `docker.io` package family; an unrelated Docker CE
installation must not be silently replaced by the offline runtime package set.

Required full gate: empty-cache offline install, no hidden downloads, approved
text+vision model identity, real synthetic EML/PDF ingestion and archive hashes,
owner, MFA and scope checks, cold restart, duplicate delivery, active-writer rejection,
sealed backup, spare-host restore, interrupted update/resume, incompatible
rollback refusal and corrupted/signature/expired-metadata rejection. Retain
measured receipts against the exact source, image/model IDs and host inventory.
Use [recovery.md](recovery.md) for standby/recovery scope and
[vm/README.md](vm/README.md) for the unqualified VM recipe.
