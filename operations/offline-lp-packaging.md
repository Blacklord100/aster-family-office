# Aster for LPs: offline installation and distribution plan

Prepared 8 September 2026. This is a delivery design and implementation plan, based on the current repository and primary documentation. It is not a claim that an offline appliance has already been built, installed, or penetration-tested. No customer systems, model installations, or network settings were changed for this research.

## Recommendation

Ship **Aster Private Appliance**: a signed, versioned Linux virtual machine for the client's existing hypervisor, containing a preinstalled container runtime, prebuilt Aster services, and an approved local model pack. Users open an internal HTTPS address in their browser. Provide the identical release as an offline installation bundle for clients that supply a dedicated Linux server. Start with one certified Linux/CPU architecture; add a separately tested GPU configuration and other architectures only when required.

Use one appliance per independently administered LP or family-office client. An MFO can manage several families within its own appliance using Aster's existing scopes. Do not distribute a copy of the MFO's database to an LP: that would also distribute encrypted originals, other families' records, credentials, and audit material. LP portability needs an explicit, reviewed export of that LP's authorized data into a clean destination.

The product should have two independent choices:

- **Deployment:** offline appliance or an explicitly connected deployment.
- **Processing:** local workflow or local agentic processing, using a pinned local model.

Both processing modes can run entirely locally. Neither mode is inherently more confidential, and agentic processing is not guaranteed to be more accurate. Confidentiality depends on the deployed endpoints, permitted tools, data access, and network controls; quality depends on the measured model/pipeline combination. A failed local model must leave a retryable job or a review task, never trigger an automatic cloud fallback. Ollama supports disabling its cloud features with `OLLAMA_NO_CLOUD=1`; that is useful application configuration, supplemented by network denial. [Ollama local-only configuration](https://docs.ollama.com/faq)

## What “internet-free” means

| Edition | How documents arrive | Who can use it | Network promise |
| --- | --- | --- | --- |
| Isolated appliance | An authorized person imports approved EML/PDF files from controlled media; optionally a separately approved one-way transfer system | Browsers on an isolated local network | No path from the appliance or its clients to the internet |
| Private LAN appliance | Manual import or a controlled internal upload endpoint; optional internal mail-server connector | Browsers on the client's private LAN | No outbound internet from Aster; internal DNS, time, PKI and other specifically approved services only |
| Connected collection gateway + private processing | A separate gateway fetches authorized mailboxes and submits a reviewed, bounded transfer package | Private-LAN users | Portfolio processing remains private, but mail collection is connected; this is not a fully air-gapped end-to-end system |

Gmail and Microsoft 365 messages cannot be newly retrieved from those hosted services while every component is disconnected. Their APIs use remote authenticated HTTP endpoints. Already exported messages can be processed offline. [Gmail message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [Microsoft Graph message retrieval](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0)

For an isolated installation, the application must also show the age and origin of imported news, FX rates, valuations, and reference data. “Latest” cannot imply live market coverage. Do not fetch linked reports, tracking pixels, external PDF resources, or URLs found in emails. A URL without an imported original becomes a missing-source task. A two-way staging gateway or USB transfer procedure introduces its own controls; naming it an air gap does not make it one.

If an LP wants only periodic reports and portfolio inspection, offer a lighter **LP review edition** later: the same clean-scope data format and browser UI, read-only permissions, with inference omitted unless required. Keep full ingestion and correction authority in the office appliance. A static HTML/PDF package alone cannot provide the full searchable, source-cited workflow.

## Why this package

| Option | Strength | Main cost or limitation | Decision |
| --- | --- | --- | --- |
| Signed Linux VM + preloaded Compose | One operational environment; centralized access, keys and backup; fits the existing services | A single host is a failure domain; GPU passthrough must be certified per host | Default for offices and LPs with an IT-managed hypervisor |
| Same bundle on a dedicated Linux machine | Direct GPU access; avoids hypervisor compatibility issues | Client or supplier must own hardware, OS and disk-encryption operations | Preferred physical appliance option when inference throughput matters |
| Full app on every Windows/Mac desktop | Personal isolation and no shared server | Duplicate databases and keys, reconciliation problems, different runtime/GPU behavior, much more support work | Later single-user edition only |
| Kubernetes/Helm | Suitable for clients already operating a supported cluster | More offline artifacts, networking, storage and upgrade responsibilities | Later enterprise package when the client requires it |

Do not make Docker Desktop an LP prerequisite. Docker documents its container GPU support on Windows with WSL2; the same design cannot be assumed to expose an Apple GPU to Linux containers. Native Ollama can use Apple's Metal API, but a Mac edition would need a separately validated native inference service and network boundary. [Docker Desktop GPU support](https://docs.docker.com/desktop/features/gpu/), [Ollama hardware support](https://docs.ollama.com/gpu)

## Current Aster readiness and concrete gaps

This assessment refers to `operations/compose.yaml`, the four Dockerfiles, `processor/service/config.py`, `processor/service/engines.py`, `lib/server/auth.ts`, and the linked operations procedures.

| Area | Present in the repository | Work required for the offline release |
| --- | --- | --- |
| Runtime | Standalone Next app; separate document, mailbox and delivery workers; PostgreSQL; Python/OCR processor; Ollama; Caddy template | Build and boot the actual Linux images on the chosen target. Docker is unavailable on the current development host; template review is not isolation evidence. |
| Dependencies | Locked npm/Python dependencies; local Geist fonts; local PDF.js worker prepared during build | Bundle final images and licenses. Current Docker builds call `npm ci`, `apt-get`, and `pip install`; first installation must perform none of these network operations. |
| Processing | Fixed local Ollama endpoint; cloud disabled by default; bounded source/tool handling | Set cloud denial explicitly in every offline service, omit cloud secrets/endpoints, and validate no fallback after failures. Pin allowed model digests and runtime configuration. |
| Networking | Internal database and processing networks, private processor/Ollama ports, non-root services, read-only root filesystems | Create a dedicated offline manifest. The current mailbox worker starts by default on `mail-egress`; web/Caddy join a non-internal `edge` network. Do not ship this unchanged as an offline edition. |
| TLS | HTTPS-aware auth and Caddy ingress template | Replace public certificate automation with client PKI or a locally trusted CA. Establish browser trust, renewal, expiry alerts and recovery without public ACME. |
| Accounts | Local invitation/bootstrap, password policy, MFA, scoped viewers and released-document checks | Package first-run owner setup, local recovery and a tested break-glass procedure. Existing email reset depends on SMTP; internet-free recovery needs internal SMTP or a new audited offline administrator flow. |
| Recovery | Encrypted document/keyring support, maintenance rotation, backup scripts and native recovery evidence | Operate encrypted off-host backups, recover all keys, and run the production `pg_dump`/`age` restore drill on the target. A VM snapshot alone is insufficient. |
| Distribution | Release validation, dependency audit/SBOM and CI configuration | Add signed release manifest, pinned image inventory, installer, updater, rollback controller, full license inventory and network-denial certification. |
| LP portability | Family/entity view restrictions and explicit original-document releases | Build a versioned authorized export/import package. Source grants cannot be replaced by copying an entire database or filtering only the visible UI. |

The PDF worker is already copied from the exact installed dependency by `scripts/prepare-pdf-worker.mjs` into `public/pdfjs/`; the container build copies `public` into the standalone application. Keep that as a build step and verify the packaged worker is available before allowing document review. Do not add runtime CDN fetches as a missing-asset workaround.

## Extraction quality is a separate release gate

The 100-email local experiment has exposed omissions in readable NAV/consolidation tables, unsupported nested email attachments, and missed legitimate operating news. These are shared reader/validator and classification issues as well as possible model limitations. Putting the current pipeline into a VM does not correct them. Keep the frozen sources and baseline outcomes; apply fixes under a new processing revision, then repeat the same comparison plus independently adjudicated client-like documents.

Prioritize a shared document representation with page/row provenance, explicit investor-versus-fund ownership, table units and date roles; bounded nested-EML decoding; more reliable news/relevance handling; and permanent-input error handling that avoids futile retries. Preserve unknown currencies, dates and weights, and retain financial review before posting. Evaluate the [optional offline document-layout stage](offline-document-layout.md) against those requirements before selecting another runtime/model dependency. Its inclusion must improve measured extraction and fit the offline resource and licensing inventory.

## Release bill of materials

Each release should be a self-contained, read-only bundle with a machine-readable manifest. Example layout below describes proposed artifacts; it is not an existing installer.

```text
aster-private-<release>-linux-amd64/
  release.json                       # product, commit, architecture, schema, compatibility
  release.sigstore.json               # signature and verification material
  SHA256SUMS                          # hashes of every delivered file
  images/                            # image archives for web/workers, processor, DB, proxy, Ollama
  models/<model-pack>/                # exact GGUF/support files, Modelfile, licenses, provenance
  runtime/                           # reviewed runtime packages and any offline OS dependencies
  config/compose.offline.yaml         # no build directives, no pull, no mail/cloud egress services
  config/                            # internal TLS, firewall, limits and first-run templates
  bin/asterctl                       # verify, install, status, upgrade, backup, restore, rollback
  verification/                      # pinned verifier, approved trust metadata, acceptance runner
  sbom/                              # app, OS images, Python, model and runtime inventories
  licenses/                          # redistribution notices and required source/offers
  docs/                              # installation, user, recovery, update and incident manuals
  fixtures/                          # synthetic acceptance emails/PDFs and expected results
```

Deliver the VM image as a separately signed OVA or QCOW2 for the first selected hypervisor; use the same manifest and images inside it. Provide a minimal ISO/rescue image if the operational target requires bare-metal recovery. Avoid promising every hypervisor and architecture in the first release.

The manifest must record artifact size/hash; image source digest and imported image identity; model upstream revision, exact file hashes, quantization and prompt template; schema range; pinned inference options; build toolchain; release sequence; key identifier; test evidence and license inventory. Model tags are friendly labels, not immutable identity. Preflight must verify the loaded runtime assets, not only the archive checksum.

Docker supports saving images to archives and loading them locally. Compose supports `--pull never` and `--no-build`; use these in a release wrapper and fail closed when an image is missing. A release must verify that its selected image-reference scheme works after a clean archive import on the pinned runtime, including whether registry digest metadata survives that path. [Docker image save](https://docs.docker.com/reference/cli/docker/image/save/), [Docker image load](https://docs.docker.com/reference/cli/docker/image/load/), [Compose startup options](https://docs.docker.com/reference/cli/docker/compose/up/)

Prepare the bundle on a connected, controlled build system. Download and review dependencies there, build without client data or client secrets, scan, run tests, sign, and transfer the finished package. Ship pinned runtime packages and their complete dependencies for a bare server; Docker documents installation from downloaded packages. Do not run an internet installer or `hello-world` pull during offline onboarding. [Docker package installation](https://docs.docker.com/engine/install/ubuntu/#install-from-a-package)

## Models, licenses and capacity

Bundle only a model pack whose exact provenance, redistribution rights and inference behavior have been reviewed. Ollama can create a model from a local GGUF file referenced by a Modelfile. Include all required template/tokenizer/support assets and verify that creation performs no downloads on an empty model store. Avoid a `FROM` instruction that silently names a remote model. [Ollama local model import](https://docs.ollama.com/import)

Gemma 4 uses Apache 2.0. Google's older Gemma terms explicitly point Gemma 4 users to a different license; do not reuse an older Gemma license checklist for all generations. Qwen3-1.7B's upstream license is also Apache 2.0, but this does not establish the license of every Qwen model or community conversion. Include applicable notices, the actual license, modification provenance, and any third-party converter or model-pack terms. Review the exact assembled distribution before shipping it. [Gemma 4 license](https://ai.google.dev/gemma/apache_2), [earlier Gemma terms](https://ai.google.dev/gemma/terms), [Qwen3-1.7B license](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE)

Complete the software license inventory for OS packages, OCR, PDF.js, fonts, database, inference runtime and optional GPU drivers. Provide source or written offers where the actual component license requires them. Define Aster's own client license/support agreement; offline operation should not depend on a periodic activation or entitlement server. If commercial license files are needed, verify their signatures locally and keep customer data/export/recovery accessible under the agreed expiry policy.

The developer computer is an **Apple M3 with 16 GiB RAM and 8 CPU cores**, verified from hardware metadata on this date. Its model tests are not a server capacity guarantee. The current scan fixtures were decoded with the Apple Vision backend. The Linux release must include and validate its supported local OCR backend and language data; successful macOS OCR is not proof of equivalent Linux extraction or evidence quotations. Google explicitly distinguishes model-loading estimates from additional context/runtime memory. [Gemma 4 memory considerations](https://ai.google.dev/gemma/docs/core#gemma-4-inference-memory-requirements)

For procurement, start with a **candidate** 8-vCPU, 32-GiB-RAM, encrypted SSD configuration for a small office and one queued local model at a time; validate before promising throughput. Provision data storage from measured document bytes, index/database growth, retention and backup copies. A candidate GPU tier should be selected only after measuring a supported device/driver/runtime combination; do not infer that a model fits from its “effective” parameter count. The current Compose 8-GiB Ollama memory cap is a placeholder, not a sizing result.

Certify each SKU using the same release/model settings: cold-start and warm latency, documents/hour, queue wait, p50/p95/p99, maximum RSS/VRAM, OCR-heavy files, multi-user report access during ingestion, sustained imports, restart recovery and low-disk behavior. Run Gemma and Qwen serially when memory cannot safely hold both. Preserve model and pipeline quality scores separately from speed. Establish the target daily volume, permissible backlog and retention before locking hardware.

## Network and trust design

Give the appliance one client-LAN interface and no general internet route. Enforce destination restrictions at the hypervisor/switch firewall and the host firewall. Permit only browser-to-proxy HTTPS and the explicitly approved internal DNS/time/PKI/backup services. Restrict administration to a client-owned management network. Disable IPv6 or apply equally restrictive IPv6 rules; block direct-IP, DNS and alternate proxy routes as well as ordinary hostname requests.

In the offline Compose manifest, include only PostgreSQL, web, document worker, processor, Ollama, TLS ingress and explicit one-shot maintenance. Omit mailbox/delivery/cloud processors and their credentials by default. A client that needs internal SMTP receives a separate allowlisted configuration; no message-sending agent tool is enabled by importing a document. Never mount the Docker socket or host filesystems into app/inference containers.

Use internal service networks for database and inference, expose only the HTTPS ingress, and restrict its host bind address. Test the Docker-aware forwarding rules on the chosen firewall backend: Docker warns that published container traffic can bypass UFW's normal rules. A UFW rule listing is not sufficient evidence of container egress denial. [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

Keep `ALLOW_CLOUD_ENGINES=false`, `OLLAMA_NO_CLOUD=1`, no cloud endpoint or API credentials, and telemetry disabled. Treat this as a defense in addition to enforced network policy. Inventory all first-boot behavior: OS updates, package mirrors, crash reporting, public NTP/DNS, certificate renewal, model discovery/pulls, vulnerability database refreshes, browser synchronization/extensions and any remote licensing. Perform update scans on the connected build system or with signed offline scanner databases; show their freshness locally.

Prefer the client's existing internal PKI and DNS, with a name in its controlled namespace. Caddy supports explicit certificate/key files or an internal issuer. A local CA requires distributing trust to client browsers; a container cannot be assumed to install that trust for users. Keep CA roots offline where practical, delegate server certificate issuance, alert before expiry, and test renewal with public internet denied. [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls)

Require full-disk encryption for the host and backup media. Aster's application encryption complements this but does not prevent an authorized host administrator or compromised running application from accessing plaintext. Keep audit exports under a separate client-controlled retention policy. No package should claim that agents or encryption eliminate all disclosure risk.

Define the client-owned disk-unlock procedure before delivery: attended console unlock or an explicitly approved local automatic-unlock arrangement. Keep recovery material separately and test restart after power loss and recovery on replacement hardware. Boot and recovery must not depend on an internet key service; record who can access the hypervisor or physical console when SSH is unavailable.

## First-run installation and identity

1. Verify the release using a client-pinned vendor signing key or approved identity/trust policy, before executing its installer. Confirm the fingerprint through the procurement/onboarding channel, not solely a key included next to the archive. Reject changed files, wrong architecture, unsigned model packs and unauthorized downgrades.
2. Confirm clean host/VM compatibility, free storage, time, LAN-only reachability, disk encryption, backup destination and TLS trust. Import the runtime/image/model artifacts without contacting a registry. Record installation hashes and configuration metadata without secrets.
3. Generate unique client secrets locally: database roles, application encryption/auth keys, processor credentials and recovery assets. A template must never contain the developer `.env.local`, owner account, production database, shared encryption key, reused host SSH keys, or a pre-enrolled authenticator.
4. Start the database, run only reviewed migrations using the maintenance role, bootstrap the first named owner through a one-time local console workflow, and retire bootstrap credentials. Require MFA enrollment and recovery-code custody before normal use. Add a second named administrator; keep individual accounts, not shared family passwords.
5. Apply family/entity scopes and explicit source-document releases for LP users. Prove denial of other scopes through API, search, Ask, exports and original retrieval. A mixed-family consolidation requires review before any source release.
6. Run the offline acceptance suite, produce a signed installation receipt, and hand the recovery set to the client's nominated custodians. Record operating ownership, patch window, RPO/RTO and escalation path.

Use current Aster local authentication and TOTP as the first release path. TOTP must work without a cloud service; provide a trusted internal clock and test drift handling. Email address is an account identifier, not proof that an external inbox is reachable. For no-SMTP sites, build an audited, short-lived offline reset flow with identity verification, session revocation and separate MFA recovery, rather than disabling MFA or editing database rows by hand.

For larger clients, add a separately tested local OIDC integration with their internal identity provider. Keycloak supports local users and integration with LDAP/Active Directory or OIDC/SAML providers, but Aster does not currently ship that integration. Keep role/scope mapping, disabled-user propagation, key rollover, logout and break-glass behavior in scope; a cloud Entra/Google redirect would break the disconnected promise. [Keycloak capabilities](https://www.keycloak.org/)

## Collection and LP transfer format

The first offline input is a folder/package of EML and PDF originals. Support bulk import with a manifest naming office, mailbox/person, original Message-ID, receipt time, attachment relation, content hash, provenance and import-batch ID. Show an import receipt with accepted, duplicate, unsupported, quarantined and failed items. Resume by stable source identity without silently duplicating a holding update. Do not imply PST, MBOX, MSG, internal IMAP or Exchange connectors are already implemented; add and test adapters explicitly if clients need them.

A connected gateway is a separate future deployment: give it only authorized mailbox credentials and an outbound provider allowlist. It should produce signed, bounded transfer packages and have no database credentials or bidirectional query path into the confidential appliance. Validate attachment types, size/depth limits, malicious archives, forwarded-message identities and duplicate/revision relationships at the receiving boundary. A truly one-way transfer requires a suitable physical/approved transfer mechanism; an ordinary shared folder is not one-way by declaration.

For an LP data export, include only authorized facts, holdings, dates, currency/FX provenance, reports, permitted originals and source references, plus a versioned schema, hashes, signature and recipient identity. Preserve unknown weights and stale/missing disclosures. Encrypt the package for the intended LP and import into a clean tenant. Reject cross-tenant identifiers and collisions; preserve amendments without silently overwriting accepted history. Run a human source-release review for consolidations containing more than one family. Revocation cannot recall already delivered copies; the recipient must agree retention and onward-sharing rules.

## Signing, updates, rollback and support

Sign the release manifest and its asset hashes on the build side. Cosign supports local public-key verification and a bundle carrying signature/trust material. Bundle the reviewed verifier and trust metadata; test verification with a clean cache and network denied. Do not make LP installation depend on an online OIDC login, transparency-log lookup, registry or key service. Include a documented signing-key rotation/revocation channel and a minimum approved release sequence. [Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/), [Cosign bundle and local-key verification options](https://github.com/sigstore/cosign/blob/main/doc/cosign_verify-blob.md)

Proposed upgrade transaction:

1. Import and verify a new signed bundle; validate schema compatibility, capacity, model identity and all licenses. Run it against a synthetic test tenant or isolated restored copy first.
2. Announce maintenance, stop admission of new ingestion jobs, drain or checkpoint jobs, and stop all old writers. Take and verify an encrypted database backup plus a separately protected configuration/key recovery set.
3. Keep versioned release directories and the previous images/model pack. Apply reviewed migrations, start one writer fleet, check health, TLS, MFA, source decryption, ledger/report invariants, grants, ingestion and no-network evidence.
4. Switch the active release only after checks pass. Store a release receipt and keep the prior compatible artifacts until the agreed recovery window closes.
5. If only application code changed compatibly, roll back to the previous supported image set. If the schema/data changed incompatibly, restore the verified pre-upgrade database and matching keys/artifacts. Never start an older application against an unsupported schema or run two writer fleets against one restored queue.

Model updates are separate signed releases with their own comparison results. Preserve a job's original model/pipeline revision. Do not re-extract and replace accepted holdings when installing a new model; offer a reviewed comparison run. Security patches need a declared support window and delivery cadence; emergency signed media must remain possible when a normal patch window is too late.

Provide a local operations screen and a metadata-only support bundle: release/schema/model identifiers, bounded error codes, queue counts, storage, timings and network-denial results. Exclude documents, prompts, holdings, credentials, full request URLs and raw SQL by default. The client reviews and explicitly exports any diagnostic material. Remote support is disabled in the offline edition; assisted work occurs through an approved, time-bounded client process or on-site access.

Back up with Aster's existing [backup and recovery procedure](backup-restore.md), keep application/keyring/auth secrets separately, and preserve keys needed by retained backups and the legacy audit chain. Use the [controlled rotation procedure](access-recovery-maintenance.md) rather than replacing the original key. Schedule independent encrypted off-host copies, periodically restore to an isolated machine, verify all encryption contexts and permissions, and measure actual recovery time. Logical dumps are consistent backups, while restoring them requires a trusted source and controlled database roles. [PostgreSQL dump backup](https://www.postgresql.org/docs/17/backup-dump.html), [PostgreSQL restore behavior](https://www.postgresql.org/docs/17/app-pgrestore.html)

## Acceptance gates before the first LP installation

| Gate | Evidence required |
| --- | --- |
| Empty-host offline install | Install from delivered media with network disconnected and empty package/model/image caches. No hidden downloads; all required assets present. |
| Network denial | Capture attempts and results from every service and a clean browser. Direct IP, IPv4/IPv6, DNS, HTTPS, alternate proxy, cloud API/model and remote-PDF attempts fail; approved internal traffic succeeds. Include first boot, inference, errors, restart, update and TLS renewal. |
| Model/mode parity | Replay the frozen messy-email corpus through Gemma workflow, Gemma agentic, Qwen workflow and Qwen agentic. Record collection completeness separately from extraction precision/recall, attribution/date/currency correctness, unsupported facts, review load and latency. Do not certify equal outputs without the measured result. |
| Hostile documents | Prompt injection cannot enable tools or release data; external links/pixels remain inert; malformed/oversized/nested/password-protected inputs fail or enter review with clear bounded status. |
| Access boundaries | Multiple offices/mailboxes and scoped LPs; cross-office API/Ask/export/original requests denied; revoked grants/sessions no longer work. |
| Financial integrity | Re-import, forwards, restatements, report-of-report and consolidations do not automatically double-count holdings or cash; contradictions and unknown exposures require review. |
| Identity/recovery | Fresh owner bootstrap, MFA, invitation, internal/offline reset, lost authenticator, clock drift, account disablement and restored-session revocation. |
| Package trust | Corrupt/missing asset, substituted model, wrong signature/key, unauthorized downgrade and incompatible schema all refuse installation. |
| Upgrade and failure | Interrupted update, worker crash, power loss, model absence, full disk and restore/rollback leave a diagnosable system with one writer fleet and preserved accepted history. |
| Recovery objectives | Encrypted backup restored on a separate host; all data/keys/provenance verified; measured RPO/RTO meet client agreement. |
| Operations handover | Named patch/backup/key custodians; license notices, support period, disposal/export procedures and a signed installation receipt. |

The current native/browser tests and synthetic model comparisons provide application evidence. They do not substitute for these Linux appliance, network, external infrastructure or client-policy checks.

## Implementation sequence

| Step | Deliverable | Completion criterion |
| --- | --- | --- |
| 1. Freeze the contract | Supported host/architecture, offline vs gateway choice, LP data scope, model pack, volume/retention/RPO/RTO | A named deployment profile with no ambiguous external dependency |
| 2. Build the release | Reproducible prebuilt images, full licenses/SBOM, exact model assets, signed manifest and verifier | Artifact inventory verifies locally; no client secrets in build output |
| 3. Build appliance controls | Offline Compose, host firewall, private TLS, first-run configuration and `asterctl` | Empty-host install and cold restart pass with external network denied |
| 4. Complete offline onboarding | Bulk import receipts, original provenance, manual/internal-SMTP recovery, clean LP export/import | Multi-mailbox import and LP isolation/recovery tests pass |
| 5. Complete lifecycle | Encrypted backup scheduling, restore, staged upgrade/rollback, offline patch/support bundles | Interrupted upgrade and independent restore drills meet agreed targets |
| 6. Certify one deployment | Full acceptance matrix, realistic sustained load, independent security review | Published supported configuration, limits and measured evidence |
| 7. Pilot and expand | One client-owned pilot; later GPU/native desktop/Kubernetes variants as needed | Client acceptance before claiming support for additional environments |

The fastest dependable route is one controlled appliance configuration with signed offline updates and client-owned recovery. Broader packaging should follow measured demand and the first complete installation/restore cycle.
