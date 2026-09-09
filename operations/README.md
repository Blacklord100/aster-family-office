# Aster operations

This is a portable single-host Docker Compose template. It has not been booted with Docker in this workspace because Docker is unavailable. Read architecture.md and readiness.md before using it with confidential data. Nothing here deploys externally. For a disconnected LP installation, use the [offline packaging plan](offline-lp-packaging.md); the current connected Compose template is not an offline release.

## Files and application contract

Run Compose from this directory. Build context is the app repository root, one directory above operations/. The bundled processor lives at processor/ in that same repository. The app must produce `.next/standalone/server.js`, `dist-worker/index.js`, `dist-mailbox-worker/index.js`, `dist-delivery-worker/index.js`, `dist-ops/migrate.js` and `dist-ops/bootstrap.js` during `npm run build`; runtime SQL lives in `/app/migrations`. The same image serves Next on 3000 and runs `npm run worker` or `npm run mailbox:worker`. Health routes are web `/api/health` and processor `/healthz`; the worker writes `/run/aster-health/document` in its shared health volume at least once per 180 seconds.

The entrypoint reads Docker secret files and constructs `DATABASE_URL` without placing a password in Compose configuration. Only the maintenance service also receives `MIGRATION_DATABASE_URL` and `BOOTSTRAP_DATABASE_URL`. Canonical auth variables are `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. The processor receives `PROCESSOR_TOKEN` and authenticates `X-Processor-Key`.

## Prepare locally

1. Copy `.env.example` to `.env`. Set a domain you control, the exact HTTPS auth origin, a reviewed Ollama image version/digest, and your local model label. Replace placeholder addresses. Pin all images to reviewed digests for release.
2. Run `sh scripts/generate-secrets.sh`. It refuses an existing destination and prints no secrets. Its directory is mode 0700; files are readable only through the private host directory or explicitly granted container mounts. Compose does not remap file-secret ownership; test the chosen host/engine or use a managed secret service.
3. Create the configured local-models and model-import directories. On a Linux Docker host, grant only UID/GID 10001 the required model-cache write access, for example `install -d -m 0700 -o 10001 -g 10001 local-models` as the host administrator. Model-import must be readable/traversable by that UID. The model mounts never create missing host paths automatically.
4. Review resource limits for the chosen model and actual hardware. The supplied 8 GiB Ollama limit is a placeholder capacity limit, not a promise that a particular model fits. The CPU configuration includes no GPU device access.

Build and validate after configuration:

```sh
docker compose config --quiet
docker compose build web processor ollama
docker compose up -d postgres processor ollama
docker compose run --rm migrate npm run db:migrate
```

The PostgreSQL role initializer runs only for an empty data volume. Existing installations need an explicit reviewed role/password migration; changing the files does not rotate database passwords. Never delete a volume to fix an initialization error.

Create the initial owner with a private local password file (15–128 characters, no newline inside the password) and the wrapper, which copies it through stdin into a mode-0600 temporary file owned by the container user:

```sh
bash scripts/bootstrap.sh /secure/bootstrap-password owner@example.com "Owner Name" "Family Office"
```

The wrapper never puts the password in argv, environment or logs. Remove the operator's source file securely according to the host's storage policy after storing recovery information. Existing-owner refusal is intentional. Initial provisioning is followed by MFA enrollment; verify invitations and account recovery separately.

## Manually provision the model

Review the model provenance, checksum, license, inference format, minimum memory and extraction quality. Place an already obtained, approved GGUF at `model-import/approved.gguf`. Create a text `model-import/Modelfile` with `FROM /model-import/approved.gguf`. The operator then explicitly imports the configured label:

```sh
docker compose exec ollama ollama create aster-approved:gguf -f /model-import/Modelfile
docker compose exec ollama ollama list
```

Match `OLLAMA_MODEL` to that label. There is no automatic `pull`, cloud fallback or arbitrary model download. Verify `Ollama cloud disabled: true` in Ollama startup logs and execute the egress checks in readiness.md. With a missing model, classical classification/rules can return available facts and an explicit fallback warning; agentic work must report model unavailability. Neither mode may fall back to a cloud provider.

Use an ordinary explicit model tag such as `:gguf`: the locally exercised Ollama 0.33.3 interpreted `:local` as a routing modifier and looked up `:latest`, despite creation of a literal `:local` manifest. Always verify the exact configured name through `/api/show` before processing. For a host that needs CPU inference, an operator can add `PARAMETER num_gpu 0` to the reviewed local Modelfile and import it under a separate label. This changes execution hardware, not the approved weights; validate capacity and latency again on that host.

## Start through TLS

For your own TLS reverse proxy, keep its upstream at `127.0.0.1:3000`, replace client-IP metadata, limit bodies, and preserve streaming responses. Do not publish processor, database or Ollama ports.

For the optional Caddy profile, configure DNS and inbound 80/443 on the intended host, then explicitly start it:

```sh
docker compose --profile tls build caddy
docker compose --profile tls up -d web worker mailbox-worker caddy
```

Caddy listens as a nonroot user on container 8080/8443 mapped to host 80/443. Its admin API is container-loopback only. A public hostname can trigger certificate issuance; this step is an operator action and has not been run here. For private localhost TLS, use `ASTER_DOMAIN=localhost`, matching auth origin, and explicitly trust the private CA on the client; no production cookie weakening is provided. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

A local loopback HTTP health check does not establish usable production login: production auth requires HTTPS. The app owns its content-security policy; verify it against Next assets and the full UI before adding a strict proxy CSP.

## Upgrades and portability

Back up first; test the image and migrations against a restored database. Run migrations as a one-off task, then replace web/worker. Roll back code only when the migrated schema is backward-compatible. Carry Compose configuration, reviewed images, database backup and separately protected keys to a new Docker host. Keep the model artifact separately with its checksum/license. Scaling beyond one host requires managed PostgreSQL, coordinated job leases, trusted TLS between hosts, shared cache/session behavior, and a new infrastructure review.

## Mailboxes and assistant access

See [mailbox-oauth.md](mailbox-oauth.md) to register read-only Google/Microsoft connections and run the separate collection worker. See [agent-access.md](agent-access.md) for scoped, expiring MCP access. Both are disabled for outside tools/accounts until explicitly configured.

## Access and maintenance

Version 0.4 adds viewer family/entity scopes, optional encrypted password-reset delivery, keyring rotation, reviewed retention, operational monitoring and release CI. Read [access-recovery-maintenance.md](access-recovery-maintenance.md) before upgrading; existing secret directories need the new `encryption_keyring` file. No running keys are regenerated by an upgrade.
