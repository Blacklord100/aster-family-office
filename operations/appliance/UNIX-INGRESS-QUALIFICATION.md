# Confined Unix ingress qualification

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
existing host80/443 listeners and never replaces another unit, installation or
container. It creates only its own randomly named synthetic root, hashed unit
prefix, exact container IDs and one internal network. Unit startup changes no
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
- Successful HTTPS after graceful Caddy restart and again after a synthetic
  SIGKILL/start that leaves old socket paths. Socket ownership/modes must remain
  protected; the relay services remain running during both cases. A fresh private
  persistent Caddy data bind matches production certificate storage, and the
  public root hash must remain identical after both restarts.
- Successful cleanup of only the probe's units, containers, network, image tag
  and synthetic root. A failed cleanup keeps the overall receipt failed.

The `synthetic-systemd-unix-ingress` artifact retains `receipt.json`, configuration
and template-derived units, exact image/controller identities, public CA
certificate, bounded build/Caddy/relay logs, and process/network/mount evidence.
Synthetic private CA keys exist only in the new private synthetic root, are
removed by its exact cleanup, and are never uploaded. No real emails, office
data, model or database is used.

**Qualification status:** local tests verify rendering, strict trust/identity
checks, topology rejection and failure handling. A passing actual hosted receipt
is still required before claiming the new ingress works. This bounded probe does
not establish a complete appliance install/update/restore, external-LAN reachability,
supplied-certificate deployment, or customer firewall policy.

The upstream interfaces are documented by [Caddy's Unix bind directive](https://caddyserver.com/docs/caddyfile/directives/bind)
and [its PROXY listener wrapper](https://caddyserver.com/docs/caddyfile/options#listener-wrappers).
The wrapper precedes TLS, trusts Unix peers, and HTTP/3 is disabled for these Unix
listeners. The relay and protected filesystem permissions supply the peer boundary;
client-provided HTTP headers never select the PROXY source address.
