# Synthetic Caddy ingress qualification

The earlier appliance profiles attached Caddy only to an `internal: true` bridge,
while requesting published HTTP/HTTPS ports. This retained manual check tests that
original routing assumption on a disposable Ubuntu24.04 GitHub runner. The failure
below led to protected Unix listeners and a confined host relay; see
[the separate Unix-ingress qualification](UNIX-INGRESS-QUALIFICATION.md). This
historical probe does not exercise the new relay. It does not change either
profile or prove a complete installation, reverse proxy, external LAN route,
firewall policy, or supplied-certificate deployment.

Run the **Qualify synthetic Caddy ingress** workflow at a reviewed commit. It
builds the existing `operations/Dockerfile.caddy` using the digest-pinned Caddy
base from `image-lock.json`. The resulting immutable image runs as UID/GID10001
with a read-only root, no capabilities, no new privileges, 256MiB memory, one CPU,
64 process slots and three bounded temporary filesystems. Its only network is
an internal bridge. Two separate jobs request either random loopback ports or
the appliance's actual `0.0.0.0:80:8080` and `0.0.0.0:443:8443` bindings. Each job
has its own receipt and cleanup. Only the fixed `/qualification` synthetic
response/redirect is served; other paths return a synthetic404. No office, model,
database, secret, real certificate or existing container is used.

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

The workflow's retained `synthetic-caddy-ingress-loopback` and
`synthetic-caddy-ingress-appliance` artifacts are the evidence. Until
an actual hosted run is inspected, unit tests establish only the probe's local
controls. An internal bridge's direct-IP success must not be described as working
published ingress. Docker documents that internal networks restrict other-network
traffic while allowing the host to address container IPs directly; this distinction
is why both paths are tested. See [Docker internal networks](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal)
and [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

## First hosted result and startup correction

[Run 34711707877](https://github.com/Blacklord100/aster-family-office/actions/runs/34711707877)
at commit `6630e51a0cf3d2238895ae80e908c5c02674cb42` built image
`sha256:b55c37781319d1e6e56da160be456ad93722bbd9484247dcb8ffabafe018453e`,
but Caddy exited before TLS or routing could be checked: `tini` reported
`exec caddy failed: Operation not permitted`. The retained artifact confirms
UID/GID 10001, all capabilities dropped, and no new privileges. The upstream
[Caddy Dockerfile](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile)
sets `cap_net_bind_service=ep` on the executable. The [Linux capabilities
documentation](https://man7.org/linux/man-pages/man7/capabilities.7.html)
describes execution refusal when such a binary cannot obtain its requested
capabilities.

The appliance Caddy recipe now removes this unused file capability and asserts
the result is empty. It uses the base image's existing `setcap`/`getcap` tools;
no package is added. The probe independently reads the running executable's
capabilities. This historical probe's internal listeners remain8080/8443 and all runtime restrictions
are retained. A new hosted run must confirm startup before published ingress
can be assessed; the first run proves neither working nor broken publication.

[Run 34712294750](https://github.com/Blacklord100/aster-family-office/actions/runs/34712294750)
at commit `a6b4a3f2a4f21a9ce66449c7e96901b02d39a808` confirmed that correction:
image `sha256:648e8add635b11c2f8751ddacf24680556dd47fe75a0a8e932004b8b38913e3c`
was running with empty executable capabilities and had issued its internal
certificate. Docker28.0.4 recorded requested loopback ports but no effective
published bindings. The probe stopped before TLS checks because `docker cp`
cannot read the certificate from its temporary filesystem. The probe now uses
a bounded, fixed-path `docker exec head` read of only the public certificate,
as required for [Docker cp's documented tmpfs limitation](https://docs.docker.com/reference/cli/docker/container/cp/#corner-cases).
The following run must exercise both binding profiles and TLS before drawing
a publication conclusion; host-local checks still do not establish an external
LAN route.

## Publication failure reproduced for both binding profiles

[Run 34712792503](https://github.com/Blacklord100/aster-family-office/actions/runs/34712792503),
commit `0609b617a586e2a3f05fd9a9c87de6140537892b`, completed both profiles on
Docker28.0.4. Caddy started with empty file capabilities. Direct internal-bridge
HTTPS returned the exact synthetic body with TLS1.3 and verified hostname/CA in
both jobs; both rejected the untrusted root. Docker retained the requested
loopback/random and all-interface80/443 port configuration, but
`NetworkSettings.Ports` was empty and neither profile had an effective published
HTTP or HTTPS port. This reproduces the missing ingress under the appliance's
actual default binding semantics, not just the loopback test configuration.

| Profile | Exact Caddy image | Retained artifact ZIP SHA256 |
| --- | --- | --- |
| Loopback/random | `sha256:b30347c2916ba1b3f52b86e059b7b6ceb178ba789f5d572a5ed21cb38e2f5573` | `138a12e342599515d678e64708af054ed1b224396c69b1d131a82583d5055bde` |
| All-interface80/443 | `sha256:541ac47d00eff10d3552a73dba46e597002855c9b83fe0732b5769adeb741a53` | `b0a777803f95d6eb17bdfac2c619080834e727344d4f1c72c01f43e7b35807f9` |

Both artifact ZIPs were independently checked against GitHub's published
digests. The raw receipts also mark the wrong-hostname control as failed because
Caddy actively refused the unknown SNI with `TLSV1_ALERT_INTERNAL_ERROR`, rather
than returning a mismatched certificate. The probe now distinguishes that
specific rejection: it requires an immediate successful valid-hostname TLS
control before accepting the alert. Generic socket failures are not accepted,
and the untrusted-root control still requires a certificate verification error.
The publication failures remain failures regardless of that corrected
classification. No Caddy/web egress, host firewall or network policy was relaxed.

Appliance ingress remains blocked pending a separately qualified path from the
host's listening sockets into restricted Caddy. These results do not qualify a
Unix-socket relay or a full appliance installation.
