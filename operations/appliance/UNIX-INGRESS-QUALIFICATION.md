# Confined Unix ingress qualification

**Bounded ingress gate passed.** [Run34715658483](https://github.com/Blacklord100/aster-family-office/actions/runs/34715658483)
at exact commit `ac32b5002c4a8c7de53bb45d6ac2097e0d08dcad` passed all 17 ingress
checks and all 12 cleanup checks on the disposable Ubuntu runner. The artifact
ZIP was independently matched to GitHub's SHA256; retained unit/configuration/CA
bytes and both executed controller identities match the receipt.

| Qualified artifact | Exact identity |
| --- | --- |
| Caddy image | `sha256:77887dce9b85387d2d6f8a58a9e0310053bad42832b4ffe3145f79e6c25258fc` |
| Executed controller SHA256 | `3875ac3770fdabe4747f88e2db57b70427e3e7434a5101b0dc00126558712d84` |
| Persistent public CA SHA256 | `d21b77ad01022def1063607256979f2af03c502215a9e24766d0f43e7a3e2849` |
| Artifact ZIP SHA256 | `9100380c62645ef28d7a4e5ad285a9c28137cdeb871be6fd48f8fe9aec1ca291` |

Observed results include host HTTPS200/TLS1.3 with verified CA and SNI, HTTP301
to the exact HTTPS origin, forged-PROXY rejection400 followed by a valid301
control, and client127.0.0.2 preserved despite forged forwarding headers. Both
UID10001 relay processes ran in distinct loopback-only network namespaces with
no effective capabilities, no new privileges, and read-only binary/socket binds.
Strict CA/SNI negatives, graceful and crash restart recovery with unchanged CA,
protected socket permissions, and removal of only newly created account/resources
all passed. This qualifies the bounded ingress path; complete appliance
install/update/restore, external-LAN routing, supplied-certificate deployment and
the broader release/source gates remain separate.

The new appliance profile uses host systemd sockets for HTTP80 and HTTPS443.
The socket-activated `asterctl ingress` process passes a kernel-derived PROXYv1
prefix and then opaque client bytes to Caddy's protected Unix socket. Caddy stays
on an internal Docker bridge, with no Docker port publication or external
network. TLS terminates in Caddy; the relay reads neither certificate keys nor
application credentials. This replaces the publication assumption that failed
in [the retained earlier hosted tests](CADDY-INGRESS-QUALIFICATION.md).

The **Qualify confined Unix ingress** manual workflow builds the current static
Linux controller and the digest-pinned Caddy image. It uses the exact production
`Caddyfile.internal`, shared headers, and the same embedded systemd unit templates
as the controller. The script substitutes only validated synthetic root/release
paths and the fixed HTTP/HTTPS protocol/port pairs. It retains the original
template hashes and each resulting unit hash. An upstream container using the
same Caddy image returns only a synthetic header-evidence response. Neither
container has a published port or a noninternal network.

The probe requires a disposable GitHub-hosted Ubuntu24.04 runner. It refuses
existing host80/443 listeners and any pre-existing `aster-ingress` name or
UID/GID10001 identity. It calls the exact built controller's
`prepare-ingress-account` command, validates its public creation receipt, and
retains only the selected identity/presence flags. The production helper verifies
the dedicated locked, nonlogin static account and group; numeric IDs alone are
insufficient for systemd startup. The probe never replaces another unit,
installation or container. It creates only its own service identity, randomly
named synthetic root, hashed unit prefix, exact container IDs and one internal
network. Unit startup changes no
host firewall or trust store. The relay runs as UID/GID10001 inside an empty
root directory, with the actual executable and socket directory bound read-only,
`PrivateNetwork=true`, `RestrictAddressFamilies=AF_UNIX`, no capabilities and no
new privileges. The only public listeners are descriptors inherited from
systemd. The socket directory is UID/GID10001/mode0700 and each Caddy socket is
UID/GID10001/mode0200.

The retained checks require:

- Host HTTPS on443 with explicit synthetic CA trust, correct SNI, and the exact
  synthetic upstream response. No certificate verification is disabled.
- Source address127.0.0.2 to arrive as `X-Real-IP` despite deliberately forged
  forwarding headers; `Forwarded` must be absent at the upstream.
- A client-supplied second PROXY line to be rejected as malformed HTTP, followed
  by a successful ordinary request to the same host socket.
- HTTP80 to redirect to the exact HTTPS origin, untrusted CA rejection, and
  wrong-hostname rejection. An early unknown-SNI TLS alert counts only with an
  immediate valid-hostname control; network timeouts cannot pass that check.
- Actual systemd properties and process UID, effective capabilities, no-new-
  privileges, separate network namespace, loopback-only interfaces, no external
  routes, read-only socket/executable mounts, and the executed binary's SHA256.
  A real socket connection first triggers activation. A reported systemd exec
  failure stops the probe before TLS retries, retaining the exact status/journal.
- Successful HTTPS after graceful Caddy restart and again after a synthetic
  SIGKILL/start that leaves old socket paths. Socket ownership/modes must remain
  protected; the relay services remain running during both cases. A fresh private
  persistent Caddy data bind matches production certificate storage, and the
  public root hash must remain identical after both restarts.
- Successful cleanup of only the probe's units, containers, network, image tag
  and synthetic root. Only after resource cleanup and another strict production
  account check may the two newly created identities be removed. Existing or
  unproven identities are never deleted. Partial account provisioning without a
  verified creation receipt remains a failed cleanup record. A failed cleanup
  keeps the overall receipt failed.

The `synthetic-systemd-unix-ingress` artifact retains `receipt.json`, configuration
and template-derived units, exact image/controller identities, public CA
certificate, bounded build/Caddy/relay logs, and process/network/mount evidence.
Synthetic private CA keys exist only in the new private synthetic root, are
removed by its exact cleanup, and are never uploaded. No real emails, office
data, model or database is used.

**Qualification scope:** the fully passing exact artifact is recorded above.
The following sections preserve the earlier failures and their corrections.
This probe does not establish a complete appliance install/update/restore, external-LAN reachability,
supplied-certificate deployment, or customer firewall policy.

## First hosted result: missing host service identity

[Run34714096001](https://github.com/Blacklord100/aster-family-office/actions/runs/34714096001)
at commit `59aab5bb948cca0825d23a717c320ab93e037d1b` passed the actual Linux Go
race suite and static build. Exact Caddy image
`sha256:752a537e2cd5e4d2cad97fcc13518b2c88870c72b35ba63acf6d9d7566de3cba`
created both protected Unix sockets, retained its internal-only topology with no
Docker publications, and preserved the same CA and socket permissions after
graceful and crash restarts. Controller SHA256 was
`3cd271cb8ed5dec0d7475f7bfaa890632c381ad47f409e8ad1e708264d16e1a9`.

The actual relay never executed: both systemd services repeatedly exited with
`217/USER` and reported failure to determine user credentials. Host HTTP/TLS
requests timed out, so this run does not prove working ingress or process
confinement. The receipt contains6 passing and9 failing checks; exact-resource
cleanup passed. The artifact ZIP SHA256
`d28804c3814e77680fcf88cdae531a1dd4ec8451987395ff647c8a065e81937b`
was independently verified against GitHub's published digest.

The follow-up added the production static-account provisioning call and immediate
exec-status checks to the probe. The original failures remain retained; subsequent
actual results are recorded below. The [systemd v255 execution documentation](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.exec.xml)
requires the configured user/group to exist in the static user database when
`DynamicUser` is not used; accepting a numeric `User` value does not create it.

## Account postflight correction

[Run34715022878](https://github.com/Blacklord100/aster-family-office/actions/runs/34715022878)
at commit `13ddfb16231688165194fde1f51a1f2fd334ca7d` passed its Linux tests/build,
then stopped during the production account helper's post-creation validation.
The selected account/group names and numeric IDs were all absent beforehand.
No Caddy container, host unit or ingress check started. Because no verified
creation receipt was returned, cleanup preserved the unproven partial identities
on that disposable runner and removed only its synthetic root. Retained artifact
ZIP SHA256 is
`aeb3983775898bcbb27af85f81ec80451ab15cecde0ff3efeeffb6339d145c58`,
independently checked against GitHub's digest.

Source review found that [glibc2.39's `getent initgroups` implementation](https://raw.githubusercontent.com/bminor/glibc/glibc-2.39/nss/getent.c)
uses a sentinel instead of the primary group and omits that sentinel from output.
A user with no supplementary memberships therefore produces only its username.
The helper incorrectly required a following GID, rejecting the intended account
with zero additional groups. The correction accepts that exact username-only
result; the primary GID remains independently checked in the passwd record, and
any foreign supplementary GID still fails. Safe validation error categories are
now retained. The probe also records the controller/template hashes before
provisioning and captures only bounded selected public account fields plus the
systemd version on failure; it never retains password or shadow records. The
subsequent actual runs confirmed this correction, culminating in the fully
passing ingress receipt above.

## Actual HTTPS success and HTTP assertion correction

[Run34715358876](https://github.com/Blacklord100/aster-family-office/actions/runs/34715358876)
at commit `924d573803c86a5f21aebac3a06111541d9bee87` passed15 of17 checks and all12
cleanup checks. It proved actual static account creation and safe removal,
socket activation, TLS1.3 HTTPS200 on host443 with the correct CA/SNI,
kernel-derived client127.0.0.2 despite spoofed forwarding headers, strict negative
TLS controls, and both real UID10001 relay processes in separate loopback-only
network namespaces with no capabilities and read-only executable/socket binds.
Both graceful and crash restarts recovered HTTPS with the same CA and protected
socket permissions. These are observed bounded results, not full appliance or
external-LAN qualification.

| Evidence | Exact identity |
| --- | --- |
| Caddy image | `sha256:e4e49078c40947d540867142be86cf451a17ae32644410308707469f4dada0d2` |
| Executed controller SHA256 | `db618a154afedbc17f42c5614bfc3b496e37288d5c767ca0d1d84a8c8e96ec5f` |
| Persistent public CA SHA256 | `e34f5e8e217506500390d3728913eb48b6e1803948c1b729f05789a9981e4d9b` |
| Retained artifact ZIP SHA256 | `2df594cb8e6a877a930fc40bf1ce3c6a7723cdf74ca7718ae65c786e8fa422cf` |

The artifact digest was independently matched to GitHub; retained configuration,
unit and CA bytes match the receipt hashes, and both executed process identities
match the controller hash. The two failed checks were the HTTP redirect and the
ordinary HTTP control following the forged-PROXY rejection. The probe expected308,
but the unchanged production configuration uses `redir ... permanent`, which
[Caddy documents as301](https://caddyserver.com/docs/caddyfile/directives/redir).
The correction requires301 and the exact HTTPS destination, rejects other codes
or origins, and retains actual response status/location on mismatch. The forged
PROXY request had reached its required400 check before the subsequent ordinary
HTTP assertion failed. This raw failed receipt remains retained; the fully
passing run recorded above subsequently verified the corrected complete controls.

The upstream interfaces are documented by [Caddy's Unix bind directive](https://caddyserver.com/docs/caddyfile/directives/bind)
and [its PROXY listener wrapper](https://caddyserver.com/docs/caddyfile/options#listener-wrappers).
The wrapper precedes TLS, trusts Unix peers, and HTTP/3 is disabled for these Unix
listeners. The relay and protected filesystem permissions supply the peer boundary;
client-provided HTTP headers never select the PROXY source address.
