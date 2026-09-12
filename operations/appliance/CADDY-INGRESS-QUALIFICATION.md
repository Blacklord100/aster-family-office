# Synthetic Caddy ingress qualification

The appliance profiles currently attach Caddy only to an `internal: true` bridge,
while requesting published HTTP/HTTPS ports. This manual check tests that routing
assumption on a disposable Ubuntu 24.04 GitHub runner. It does not change either
profile or prove a complete installation, reverse proxy, external LAN route,
firewall policy, or supplied-certificate deployment.

Run the **Qualify synthetic Caddy ingress** workflow at a reviewed commit. It
builds the existing `operations/Dockerfile.caddy` using the digest-pinned Caddy
base from `image-lock.json`. The resulting immutable image runs as UID/GID10001
with a read-only root, no capabilities, no new privileges, 256MiB memory, one CPU,
64 process slots and three bounded temporary filesystems. Its only network is
an internal bridge. Only randomly assigned loopback HTTP/HTTPS ports are
requested; no office, model, database, secret, real certificate or existing
container is used.

The synthetic Caddyfile preserves the appliance's internal HTTPS/HTTP listeners,
internal CA and disabled host trust installation. A fixed known-answer response
replaces the application upstream. The probe copies only the generated public
root certificate and passes it explicitly to Python's TLS verifier. It uses the
real hostname and SNI while connecting to an inspected IP, without disabling
certificate checks, installing system trust, or using proxy/DNS overrides.

The receipt records direct internal-bridge HTTPS separately from host-published
HTTPS and the HTTP redirect. Valid direct access cannot make a missing or broken
publication pass. Negative controls require rejection of both an untrusted root
and a wrong hostname. The probe records exact image, recipe/profile/configuration
hashes, requested/effective ports, Docker version and bounded diagnostics. Failure
produces a failed receipt and nonzero exit. Cleanup targets only its own exact
container/network IDs and unique image tag; it never prunes other resources.
Private certificate keys remain in the disposable container's temporary memory
filesystems and are not uploaded.

The workflow's retained `synthetic-caddy-ingress` artifact is the evidence. Until
an actual hosted run is inspected, unit tests establish only the probe's local
controls. An internal bridge's direct-IP success must not be described as working
published ingress. Docker documents that internal networks restrict other-network
traffic while allowing the host to address container IPs directly; this distinction
is why both paths are tested. See [Docker internal networks](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal)
and [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

## First hosted result and startup correction

[Run34711707877](https://github.com/Blacklord100/aster-family-office/actions/runs/34711707877)
at commit `6630e51a0cf3d2238895ae80e908c5c02674cb42` built image
`sha256:b55c37781319d1e6e56da160be456ad93722bbd9484247dcb8ffabafe018453e`,
but Caddy exited before TLS or routing could be checked: `tini` reported
`exec caddy failed: Operation not permitted`. The retained artifact confirms
UID/GID10001, all capabilities dropped, and no new privileges. The upstream
[Caddy Dockerfile](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile)
sets `cap_net_bind_service=ep` on the executable. The [Linux capabilities
documentation](https://man7.org/linux/man-pages/man7/capabilities.7.html)
describes execution refusal when such a binary cannot obtain its requested
capabilities.

The appliance Caddy recipe now removes this unused file capability and asserts
the result is empty. It uses the base image's existing `setcap`/`getcap` tools;
no package is added. The probe independently reads the running executable's
capabilities. Internal listeners remain8080/8443 and all runtime restrictions
are retained. A new hosted run must confirm startup before published ingress
can be assessed; the first run proves neither working nor broken publication.
