"""Bounded synthetic Linux ingress qualification; never run against an installation."""
import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import sys
import time

HOSTNAME = 'aster-ingress.synthetic.test'
BODY = b'SYNTHETIC CADDY INGRESS'
CONFIG = '''{
    http_port 8080
    https_port 8443
    admin 127.0.0.1:2019
    auto_https disable_redirects
    skip_install_trust
}
https://aster-ingress.synthetic.test {
    tls internal
    respond /qualification "SYNTHETIC CADDY INGRESS" 200
    respond "SYNTHETIC NOT FOUND" 404
}
http://aster-ingress.synthetic.test {
    redir /qualification https://aster-ingress.synthetic.test/qualification permanent
    respond "SYNTHETIC NOT FOUND" 404
}
'''
ROOT = Path(__file__).resolve().parents[3]
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
OBJECT_ID = re.compile(r'[a-f0-9]{64}')
PUBLICATIONS = {
    'loopback': {'bind': '127.0.0.1', 'ports': {'8080/tcp': '', '8443/tcp': ''}},
    'appliance': {'bind': '0.0.0.0', 'ports': {'8080/tcp': '80', '8443/tcp': '443'}},
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def docker(arguments, work, timeout=30, check=True):
    # A configured remote context must not redirect this disposable-host probe.
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(work),
                   'DOCKER_CONFIG': str(work / 'docker-config'), 'LANG': 'C.UTF-8'}
    result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *arguments],
                            env=environment, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'Docker {arguments[0]} exited {result.returncode}: '
                           + (result.stdout + result.stderr)[-8192:])
    return result


def one_json(result):
    value = json.loads(result.stdout)
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise ValueError('Expected one inspected Docker object')
    return value[0]


def executable_capabilities(cid, work):
    capabilities = docker(['exec', cid, 'getcap', '/usr/bin/caddy'], work).stdout.strip()
    if capabilities:
        raise ValueError('Caddy executable still carries file capabilities: ' + capabilities[:1024])
    return {'path': '/usr/bin/caddy', 'capabilities': []}


def read_public_root(cid, work, ca):
    # Docker cp does not read tmpfs mounts. Read only this public certificate,
    # with a byte cap, from the actual running container; never copy its keys.
    result = docker(['exec', cid, 'head', '-c', '16385',
                     '/data/caddy/pki/authorities/local/root.crt'], work, check=False)
    if result.returncode:
        raise ValueError('Synthetic public root is not ready: ' + result.stderr[-2048:])
    encoded = result.stdout.encode('utf-8')
    if (not 1 <= len(encoded) <= 16384 or not encoded.startswith(b'-----BEGIN CERTIFICATE-----\n') or
            not encoded.rstrip().endswith(b'-----END CERTIFICATE-----') or encoded.count(b'-----BEGIN ') != 1):
        raise ValueError('Unexpected synthetic public root certificate size or format')
    ca.write_bytes(encoded)


def topology(container, network, name, image_id, publication='loopback'):
    specification = PUBLICATIONS[publication]
    cid, nid = container.get('Id', ''), network.get('Id', '')
    if not OBJECT_ID.fullmatch(cid) or not OBJECT_ID.fullmatch(nid):
        raise ValueError('Invalid inspected object identity')
    if (container.get('Name') != '/' + name or container.get('Image') != image_id or
            container.get('Config', {}).get('User') != '10001:10001' or
            not container.get('State', {}).get('Running')):
        raise ValueError('Caddy identity, nonroot user or running state differs')
    host = container.get('HostConfig', {})
    if (host.get('ReadonlyRootfs') is not True or host.get('Privileged') is not False or
            {str(item).upper() for item in host.get('CapDrop') or []} != {'ALL'} or
            host.get('CapAdd') or 'no-new-privileges:true' not in (host.get('SecurityOpt') or []) or
            host.get('Dns') != ['127.0.0.1']):
        raise ValueError('Caddy runtime confinement differs')
    if (network.get('Name') != name or network.get('Internal') is not True or
            network.get('Driver') != 'bridge' or network.get('Scope') != 'local'):
        raise ValueError('Expected only an internal local bridge')
    networks = container.get('NetworkSettings', {}).get('Networks', {})
    if set(networks) != {name} or networks[name].get('NetworkID') != nid:
        raise ValueError('Caddy has an extra or different network')
    members = network.get('Containers') or {}
    address = ipaddress.ip_address(networks[name].get('IPAddress', ''))
    subnets = [ipaddress.ip_network(item['Subnet']) for item in network.get('IPAM', {}).get('Config', [])]
    if (set(members) != {cid} or members[cid].get('Name') != name or address.version != 4 or
            not address.is_private or address.is_loopback or address.is_unspecified or
            not any(address in subnet and address not in (subnet.network_address, subnet.broadcast_address)
                    for subnet in subnets if subnet.version == 4) or
            ipaddress.ip_interface(members[cid].get('IPv4Address', '')).ip != address):
        raise ValueError('Inspected bridge membership or private IPv4 address differs')
    requested = host.get('PortBindings') or {}
    if set(requested) != {'8080/tcp', '8443/tcp'}:
        raise ValueError('Expected exactly the two requested ingress publications')
    for port, entries in requested.items():
        if (len(entries) != 1 or entries[0].get('HostIp') != specification['bind'] or
                entries[0].get('HostPort') != specification['ports'][port]):
            raise ValueError('Requested publication differs from the selected synthetic profile')
    actual = container.get('NetworkSettings', {}).get('Ports') or {}
    if any(entries for key, entries in actual.items() if key not in requested):
        raise ValueError('Unexpected effective published port')
    published = {}
    for port in requested:
        entries = actual.get(port)
        # Missing effective bindings are the suspected defect, retained as a
        # result so the direct-IP control still executes before failure.
        published[port] = None
        if entries:
            if len(entries) != 1 or entries[0].get('HostIp') != specification['bind']:
                raise ValueError('Effective publication differs from the selected synthetic profile')
            value = entries[0].get('HostPort', '')
            if not value.isdecimal() or not 1 <= int(value) <= 65535:
                raise ValueError('Invalid effective published port')
            if specification['ports'][port] and value != specification['ports'][port]:
                raise ValueError('Effective publication differs from the requested appliance port')
            published[port] = int(value)
    return {'containerId': cid, 'imageId': image_id, 'networkId': nid, 'internal': True,
            'publicationProfile': publication, 'hostBind': specification['bind'],
            'containerIPv4': str(address), 'requestedPublications': requested,
            'effectivePublications': published}


def https(address, port, ca, hostname=HOSTNAME):
    context = ssl.create_default_context(cafile=str(ca)) if ca else ssl.create_default_context()
    # Connect to an inspected local address, with actual SNI and hostname/CA
    # validation. Never disable verification or consult a proxy/DNS override.
    with socket.create_connection((address, port), timeout=4) as raw:
        with context.wrap_socket(raw, server_hostname=hostname) as secured:
            secured.sendall(('GET /qualification HTTP/1.1\r\nHost: ' + hostname
                             + '\r\nConnection: close\r\n\r\n').encode('ascii'))
            response = http.client.HTTPResponse(secured)
            response.begin()
            body = response.read(4097)
            if response.status != 200 or body != BODY:
                raise ValueError('HTTPS response differs from the exact synthetic known answer')
            return {'status': response.status, 'bodySha256': hashlib.sha256(body).hexdigest(),
                    'tlsVersion': secured.version(), 'certificateSha256': hashlib.sha256(
                        secured.getpeercert(binary_form=True)).hexdigest(), 'hostnameVerified': hostname}


def http_redirect(address, port):
    client = http.client.HTTPConnection(address, port, timeout=4)
    try:
        client.request('GET', '/qualification', headers={'Host': HOSTNAME})
        response = client.getresponse()
        if response.status != 301 or response.getheader('Location') != f'https://{HOSTNAME}/qualification':
            raise ValueError('HTTP ingress did not produce the configured HTTPS301 redirect: '
                             + str(response.status) + ' ' + (response.getheader('Location') or '')[:4096])
        response.read(4097)
        return {'status': response.status, 'location': response.getheader('Location')}
    finally:
        client.close()


def check(receipt, name, action):
    started = time.monotonic()
    try:
        value = action()
        item = {'name': name, 'result': 'passed', 'evidence': value}
    except (OSError, ValueError, RuntimeError, http.client.HTTPException) as error:
        item = {'name': name, 'result': 'failed', 'error': str(error)[-4096:]}
    item['elapsedSeconds'] = round(time.monotonic() - started, 3)
    receipt['checks'].append(item)
    return item['result'] == 'passed'


def rejected_certificate(address, ca, hostname):
    try:
        https(address, 8443, ca, hostname)
    except ssl.SSLCertVerificationError as error:
        return {'certificateRejected': True, 'reason': error.reason, 'verifyCode': error.verify_code}
    except ssl.SSLError as error:
        # Caddy may refuse unknown SNI before offering a certificate. Accept
        # only the observed/defined TLS alerts for that negative control, and
        # immediately prove the same endpoint still serves the valid hostname.
        # The untrusted-root control must remain an actual certificate failure.
        if (hostname == HOSTNAME or ca is None or error.reason not in
                {'TLSV1_ALERT_INTERNAL_ERROR', 'TLSV1_UNRECOGNIZED_NAME'}):
            raise
        control = https(address, 8443, ca, HOSTNAME)
        return {'tlsHandshakeRejected': True, 'reason': error.reason,
                'diagnostic': str(error)[:1024], 'validHostnameControl': control}
    raise ValueError('Invalid TLS trust or hostname was accepted')


def qualify(output, publication='loopback'):
    if sys.platform != 'linux':
        raise ValueError('This probe requires a disposable Linux Docker host; no local macOS Docker run')
    if publication not in PUBLICATIONS:
        raise ValueError('Unknown synthetic publication profile')
    specification = PUBLICATIONS[publication]
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    work = output / 'work'; work.mkdir(mode=0o700)
    name = 'aster-synthetic-ingress-' + secrets.token_hex(8)
    receipt = {'schemaVersion': 1, 'type': 'aster-synthetic-caddy-ingress-v1', 'result': 'failed',
               'publicationProfile': publication,
               'scope': 'One internal-bridge Caddy ingress; not full appliance or external-LAN qualification',
               'checks': [], 'cleanup': []}
    cid = nid = None
    built = False
    try:
        lock = json.loads((ROOT / 'operations/appliance/image-lock.json').read_text())
        base = lock['bases']['caddy']
        if lock.get('platform') != 'linux/amd64' or not re.fullmatch(r'caddy:[^\s@]+@sha256:[a-f0-9]{64}', base):
            raise ValueError('Expected reviewed, digest-pinned linux/amd64 Caddy base')
        recipe = ROOT / 'operations/Dockerfile.caddy'
        (work / 'Dockerfile').write_bytes(recipe.read_bytes())
        config = output / 'Caddyfile.synthetic'; config.write_text(CONFIG); config.chmod(0o444)
        receipt.update({'baseImage': base, 'dockerfileSha256': digest(recipe), 'configSha256': digest(config),
                        'imageLockSha256': digest(ROOT / 'operations/appliance/image-lock.json'),
                        'profileSha256': {mode: digest(ROOT / f'operations/appliance/config/compose.{mode}.yaml')
                                          for mode in ['offline', 'connected']}})
        version = docker(['version', '--format', '{{json .}}'], work)
        (output / 'docker-version.json').write_text(version.stdout)
        result = docker(['build', '--platform', 'linux/amd64', '--progress', 'plain',
                         '--build-arg', 'CADDY_IMAGE=' + base, '--tag', name, str(work)], work, timeout=300)
        (output / 'build.log').write_text((result.stdout + result.stderr)[-262144:])
        built = True
        image_id = docker(['image', 'inspect', '--format', '{{.Id}}', name], work).stdout.strip()
        if not IMAGE_ID.fullmatch(image_id):
            raise ValueError('Built Caddy image ID is missing')
        receipt['imageId'] = image_id
        nid = docker(['network', 'create', '--driver', 'bridge', '--internal',
                      '--label', 'org.aster.synthetic-ingress=' + name, name], work).stdout.strip()
        if not OBJECT_ID.fullmatch(nid):
            raise ValueError('Created network ID is invalid')
        cid = docker(['create', '--name', name, '--label', 'org.aster.synthetic-ingress=' + name,
                      '--platform', 'linux/amd64', '--init', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL',
                      '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '64',
                      '--cpus', '1', '--network', name, '--dns', '127.0.0.1',
                      '--publish', specification['bind'] + ':' + specification['ports']['8080/tcp'] + ':8080',
                      '--publish', specification['bind'] + ':' + specification['ports']['8443/tcp'] + ':8443',
                      '--tmpfs', '/data:rw,nosuid,noexec,size=32m,uid=10001,gid=10001',
                      '--tmpfs', '/config:rw,nosuid,noexec,size=32m,uid=10001,gid=10001',
                      '--tmpfs', '/tmp:rw,nosuid,noexec,size=32m,uid=10001,gid=10001',
                      '--mount', f'type=bind,source={config.resolve()},target=/etc/caddy/Caddyfile,readonly',
                      image_id, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], work).stdout.strip()
        if not OBJECT_ID.fullmatch(cid):
            raise ValueError('Created container ID is invalid')
        docker(['start', cid], work)
        def inspect():
            container = one_json(docker(['inspect', cid], work))
            network = one_json(docker(['network', 'inspect', nid], work))
            return topology(container, network, name, image_id, publication)
        endpoint = inspect(); receipt['topology'] = endpoint
        receipt['executableCapabilities'] = executable_capabilities(cid, work)
        ca = output / 'root.crt'
        deadline = time.monotonic() + 60
        last = 'Caddy has not created its synthetic public root certificate'
        while time.monotonic() < deadline:
            inspect()
            try:
                read_public_root(cid, work, ca)
                https(endpoint['containerIPv4'], 8443, ca)
                break
            except (OSError, ValueError, http.client.HTTPException) as error:
                last = str(error)[-2048:]
            time.sleep(1)
        else:
            raise RuntimeError('Caddy public-root retrieval or direct-IP TLS readiness timed out: ' + last)
        receipt['publicRootSha256'] = digest(ca)
        direct = endpoint['containerIPv4']
        check(receipt, 'direct-internal-bridge-https', lambda: https(direct, 8443, ca))
        check(receipt, 'wrong-hostname-rejected', lambda: rejected_certificate(direct, ca, 'wrong.synthetic.test'))
        check(receipt, 'untrusted-root-rejected', lambda: rejected_certificate(direct, None, HOSTNAME))
        def published(port, action):
            actual = endpoint['effectivePublications'][port]
            if actual is None:
                raise ValueError('Docker did not expose an effective ' + publication + ' host port for ' + port)
            return action(actual)
        check(receipt, 'host-published-https', lambda: published('8443/tcp', lambda port: https('127.0.0.1', port, ca)))
        check(receipt, 'host-published-http-redirect', lambda: published('8080/tcp', lambda port: http_redirect('127.0.0.1', port)))
        if inspect() != endpoint:
            raise ValueError('Inspected container or topology changed during qualification')
        receipt['result'] = 'passed' if all(item['result'] == 'passed' for item in receipt['checks']) else 'failed'
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        receipt['error'] = str(error)[-8192:]
    finally:
        if cid and OBJECT_ID.fullmatch(cid):
            for action, filename in [(['logs', '--tail', '100', cid], 'caddy.log'), (['inspect', cid], 'container.json')]:
                try:
                    result = docker(action, work, check=False)
                    (output / filename).write_text((result.stdout + result.stderr)[-65536:])
                except subprocess.SubprocessError as error:
                    receipt['cleanup'].append({'diagnostic': filename, 'error': str(error)[-1024:]})
        # Only this invocation's exact created objects and unique build tag.
        for target, action in [(cid, ['rm', '--force', '--volumes', cid]),
                               (nid, ['network', 'rm', nid]),
                               (name if built else None, ['image', 'rm', name])]:
            if not target or (target != name and not OBJECT_ID.fullmatch(target)):
                continue
            try:
                result = docker(action, work, check=False)
                receipt['cleanup'].append({'action': action, 'result': 'passed' if not result.returncode else 'failed',
                                           'diagnostic': (result.stdout + result.stderr)[-2048:]})
                if result.returncode:
                    receipt['result'] = 'failed'
            except (OSError, subprocess.SubprocessError) as error:
                receipt['cleanup'].append({'action': action, 'result': 'failed', 'error': str(error)[-2048:]})
                receipt['result'] = 'failed'
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    if receipt['result'] != 'passed':
        raise RuntimeError('Synthetic Caddy ingress qualification failed; inspect retained receipt.json')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='New private evidence directory')
    parser.add_argument('--publication', choices=sorted(PUBLICATIONS), default='loopback',
                        help='Loopback/random ports or the appliance all-IPv4-interface 80/443 bindings')
    args = parser.parse_args()
    try:
        result = qualify(args.output, args.publication)
        print(json.dumps({'result': result['result'], 'imageId': result['imageId'], 'checks': len(result['checks'])}))
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
