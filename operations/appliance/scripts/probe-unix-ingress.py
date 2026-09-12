"""Synthetic hosted-Linux proof of the actual systemd -> Unix -> Caddy ingress.

No installation, host trust, firewall, model, mailbox or customer data is touched.
Only uniquely named probe units, containers and one internal network are changed.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
import grp
import pwd
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('caddy_probe', Path(__file__).with_name('probe-caddy-ingress.py'))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
HOSTNAME = common.HOSTNAME
CLIENT_IP = '127.0.0.2'
EXPECTED = b'SYNTHETIC|127.0.0.2||'
UPSTREAM = '''{
  admin off
  auto_https off
}
http://:3000 {
  respond /qualification "SYNTHETIC|{http.request.header.X-Real-IP}|{http.request.header.Forwarded}|" 200
  respond "SYNTHETIC NOT FOUND" 404
}
'''
PATH_PATTERN = re.compile(r'/[A-Za-z0-9._/-]+')
TEMPLATES = ROOT / 'operations/appliance/cli/ingress_templates'
ACCOUNT = 'aster-ingress'


def render_units(root, binary, templates=TEMPLATES):
    for value in (str(root), str(binary)):
        if not PATH_PATTERN.fullmatch(value) or os.path.normpath(value) != value or value == '/' or len(value) > 4096:
            raise ValueError('Noncanonical or unsafe systemd template path')
    if not str(binary).startswith(str(root) + '/releases/') or not str(binary).endswith('/payload/bin/asterctl'):
        raise ValueError('Expected the controller inside the synthetic release')
    base = 'aster-ingress-' + hashlib.sha256(str(root).encode()).hexdigest()[:16]
    units, hashes = {}, {}
    for kind in ('socket', 'service'):
        original = (templates / (kind + '.unit')).read_bytes()
        hashes[kind] = hashlib.sha256(original).hexdigest()
        for protocol, port in (('http', '80'), ('https', '443')):
            text = original.decode('utf-8')
            values = {'UNIT_BASE': base, 'JAIL': str(root / 'run/ingress-jail'), 'BINARY': str(binary),
                      'SOCKETS': str(root / 'run/ingress-sockets'), 'PROTOCOL': protocol, 'PORT': port}
            for token, value in values.items():
                text = text.replace('@' + token + '@', value)
            if '@' in text:
                raise ValueError('Unresolved systemd template token')
            units[base + '-' + protocol + '.' + kind] = text
    return units, hashes


def privileged(arguments, timeout=30, check=True):
    if not arguments or not arguments[0].startswith('/usr/bin/'):
        raise ValueError('Probe privileged command requires an absolute system executable')
    result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
                             'LANG=C.UTF-8', *arguments], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Synthetic command failed: ' + ' '.join(arguments[:2]) + ': '
                           + (result.stdout + result.stderr)[-8192:])
    return result


def account_presence():
    result = {}
    for key, lookup, identifier in [('userName', pwd.getpwnam, ACCOUNT), ('userId', pwd.getpwuid, 10001),
                                    ('groupName', grp.getgrnam, ACCOUNT), ('groupId', grp.getgrgid, 10001)]:
        try:
            lookup(identifier)
            result[key] = True
        except KeyError:
            result[key] = False
    return result


def prepare_account(binary):
    # The copied, root-owned exact Linux controller executes its production
    # account helper; the probe has no separate account creation implementation.
    result = privileged(['/usr/bin/env', str(binary), 'prepare-ingress-account'], timeout=35)
    if len(result.stdout.encode()) > 4096:
        raise ValueError('Oversized public account receipt')
    value = json.loads(result.stdout)
    if (not isinstance(value, dict) or set(value) != {'name', 'uid', 'gid', 'createdUser', 'createdGroup'}
            or value['name'] != ACCOUNT or type(value['uid']) is not int or value['uid'] != 10001
            or type(value['gid']) is not int or value['gid'] != 10001
            or type(value['createdUser']) is not bool or type(value['createdGroup']) is not bool):
        raise ValueError('Unexpected public ingress account receipt')
    return value


def cleanup_account(before, prepared, binary):
    if before is None or any(before.values()):
        return {'result': 'passed', 'action': 'preexisting identities preserved; no provisioning attempted'}
    current = account_presence()
    if prepared is None:
        if any(current.values()):
            raise ValueError('Account changed without a validated creation receipt; no unproven identity will be deleted')
        return {'result': 'passed', 'action': 'no account created'}
    if not prepared['createdUser'] or not prepared['createdGroup'] or not all(current.values()):
        raise ValueError('Only this probe\'s two positively verified newly created identities may be removed')
    validated = prepare_account(binary)
    if validated['createdUser'] or validated['createdGroup']:
        raise ValueError('Account changed during cleanup validation; no deletion attempted')
    # The production helper just rechecked local/static+NSS identity, lock and
    # no supplementary memberships. Also refuse a group used by another UID.
    if any(user.pw_gid == 10001 and (user.pw_uid != 10001 or user.pw_name != ACCOUNT) for user in pwd.getpwall()):
        raise ValueError('Probe group is used by another account; no deletion attempted')
    privileged(['/usr/bin/env', '/usr/sbin/userdel', ACCOUNT])
    after_user = account_presence()
    if after_user['userName'] or after_user['userId']:
        raise ValueError('Newly created synthetic user still exists after removal')
    # Shadow userdel may already remove this newly created private group.
    if after_user['groupName'] or after_user['groupId']:
        by_name, by_id = grp.getgrnam(ACCOUNT), grp.getgrgid(10001)
        if (by_name.gr_name != ACCOUNT or by_name.gr_gid != 10001 or by_name.gr_mem
                or by_id.gr_name != ACCOUNT or by_id.gr_gid != 10001 or by_id.gr_mem
                or any(user.pw_gid == 10001 for user in pwd.getpwall())):
            raise ValueError('Newly created synthetic group changed; no deletion attempted')
        privileged(['/usr/bin/env', '/usr/sbin/groupdel', ACCOUNT])
    if any(account_presence().values()):
        raise ValueError('Synthetic account cleanup did not restore initial absence')
    return {'result': 'passed', 'action': 'removed only the two verified newly created identities'}


def https(ca, hostname=HOSTNAME):
    context = ssl.create_default_context(cafile=str(ca)) if ca else ssl.create_default_context()
    with socket.create_connection(('127.0.0.1', 443), timeout=5, source_address=(CLIENT_IP, 0)) as raw:
        with context.wrap_socket(raw, server_hostname=hostname) as secured:
            secured.sendall(('GET /qualification HTTP/1.1\r\nHost: ' + hostname + '\r\n'
                             'X-Real-IP: 198.51.100.23\r\nForwarded: for=198.51.100.24\r\n'
                             'X-Forwarded-For: 198.51.100.25\r\nConnection: close\r\n\r\n').encode())
            response = http.client.HTTPResponse(secured)
            response.begin()
            body = response.read(4097)
            if response.status != 200 or body != EXPECTED:
                raise ValueError(f'Actual upstream identity/response differs: status={response.status}, body={body[:512]!r}')
            return {'status': response.status, 'bodySha256': hashlib.sha256(body).hexdigest(),
                    'tlsVersion': secured.version(), 'hostnameVerified': hostname,
                    'actualClientIp': CLIENT_IP, 'spoofedHeadersIgnored': True,
                    'certificateSha256': hashlib.sha256(secured.getpeercert(binary_form=True)).hexdigest()}


def reject_tls(ca, hostname):
    try:
        https(ca, hostname)
    except ssl.SSLCertVerificationError as error:
        return {'certificateRejected': True, 'reason': error.reason, 'verifyCode': error.verify_code}
    except ssl.SSLError as error:
        if ca is None or hostname == HOSTNAME or error.reason not in {'TLSV1_ALERT_INTERNAL_ERROR', 'TLSV1_UNRECOGNIZED_NAME'}:
            raise
        return {'handshakeRejected': True, 'reason': error.reason, 'validHostnameControl': https(ca)}
    raise ValueError('Invalid TLS identity was accepted')


def host_redirect():
    connection = http.client.HTTPConnection('127.0.0.1', 80, timeout=5, source_address=(CLIENT_IP, 0))
    try:
        connection.request('GET', '/qualification', headers={'Host': HOSTNAME})
        response = connection.getresponse()
        if response.status != 308 or response.getheader('Location') != 'https://' + HOSTNAME + '/qualification':
            raise ValueError('Actual host HTTP socket did not redirect to the expected HTTPS origin')
        response.read(4097)
        return {'status': response.status, 'location': response.getheader('Location')}
    finally:
        connection.close()


def forged_proxy_line():
    # The relay's own kernel-derived line comes first. Client bytes cannot
    # replace it or introduce a second trusted forwarding envelope.
    with socket.create_connection(('127.0.0.1', 80), timeout=5, source_address=(CLIENT_IP, 0)) as raw:
        raw.sendall(('PROXY TCP4 198.51.100.99 127.0.0.1 1234 80\r\n'
                     'GET /qualification HTTP/1.1\r\nHost: ' + HOSTNAME + '\r\nConnection: close\r\n\r\n').encode())
        response = http.client.HTTPResponse(raw); response.begin()
        body = response.read(4097)
        if response.status != 400 or len(body) > 4096:
            raise ValueError('Client-supplied second PROXY line was not explicitly rejected as malformed HTTP')
        return {'status': response.status, 'validHttpControl': host_redirect()}


def socket_permissions(directory):
    evidence = {}
    for filename, expected in [('', 'directory|700|10001|10001'),
                               ('http.sock', 'socket|200|10001|10001'),
                               ('https.sock', 'socket|200|10001|10001')]:
        path = directory / filename
        actual = privileged(['/usr/bin/stat', '-c', '%F|%a|%u|%g', str(path)]).stdout.strip()
        if actual != expected:
            raise ValueError('Protected Unix path type/ownership/mode differs: ' + filename + ': ' + actual)
        evidence[filename or 'directory'] = actual
    return evidence


def persistent_ca(cid, work, expected_sha):
    observed = work / 'observed-public-root.crt'
    common.read_public_root(cid, work, observed)
    actual = common.digest(observed)
    if actual != expected_sha:
        raise ValueError('Synthetic persistent Caddy CA changed across restart')
    return {'publicRootSha256': actual, 'unchanged': True}


def inspect_topology(containers, network, name, image_id):
    if (network.get('Name') != name or network.get('Internal') is not True or network.get('Driver') != 'bridge'
            or network.get('Scope') != 'local' or not common.OBJECT_ID.fullmatch(network.get('Id', '')) or len(containers) != 2):
        raise ValueError('Expected the exact synthetic internal bridge')
    identities = set()
    for container in containers:
        if not common.OBJECT_ID.fullmatch(container.get('Id', '')):
            raise ValueError('Invalid actual container identity')
        identities.add(container['Id'])
        host = container.get('HostConfig', {})
        if (container.get('Image') != image_id or container.get('Config', {}).get('User') != '10001:10001'
                or not container.get('State', {}).get('Running') or host.get('ReadonlyRootfs') is not True
                or host.get('Privileged') is not False or host.get('CapAdd')
                or {str(value).upper() for value in host.get('CapDrop') or []} != {'ALL'}
                or 'no-new-privileges:true' not in (host.get('SecurityOpt') or [])
                or host.get('Dns') != ['127.0.0.1'] or host.get('PortBindings')
                or any((container.get('NetworkSettings', {}).get('Ports') or {}).values())
                or set(container.get('NetworkSettings', {}).get('Networks', {})) != {name}
                or container['NetworkSettings']['Networks'][name].get('NetworkID') != network['Id']):
            raise ValueError('Actual Caddy/upstream identity, isolation or no-publication contract differs')
    if set(network.get('Containers', {})) != identities:
        raise ValueError('Unexpected network member')
    return {'internal': True, 'dockerPublications': [], 'imageId': image_id,
            'containerIds': sorted(identities), 'networkId': network['Id']}


def confinement(unit, expected_binary_sha, output, expected_root):
    properties = ['MainPID', 'User', 'Group', 'RootDirectory', 'PrivateNetwork', 'RestrictAddressFamilies',
                  'BindReadOnlyPaths', 'NoNewPrivileges', 'CapabilityBoundingSet', 'AmbientCapabilities', 'ActiveState']
    result = privileged(['/usr/bin/systemctl', 'show', unit, '--property=' + ','.join(properties)])
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if (values.get('ActiveState') != 'active' or values.get('User') != '10001' or values.get('Group') != '10001'
            or values.get('PrivateNetwork') != 'yes' or values.get('RestrictAddressFamilies') != 'AF_UNIX'
            or values.get('NoNewPrivileges') != 'yes' or values.get('CapabilityBoundingSet')
            or values.get('AmbientCapabilities') or values.get('RootDirectory') != str(expected_root / 'run/ingress-jail')):
        raise ValueError('Actual systemd confinement properties differ: ' + json.dumps(values))
    pid = int(values.get('MainPID', '0'))
    if pid <= 1:
        raise ValueError('Relay has no running process')
    status = privileged(['/usr/bin/cat', f'/proc/{pid}/status']).stdout
    fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
    if (fields.get('Uid', '').split() != ['10001'] * 4 or int(fields.get('CapEff', '1').strip(), 16)
            or fields.get('NoNewPrivs', '').strip() != '1'):
        raise ValueError('Actual process identity/capabilities differ')
    host_ns = os.readlink('/proc/self/ns/net')
    relay_ns = privileged(['/usr/bin/readlink', f'/proc/{pid}/ns/net']).stdout.strip()
    if host_ns == relay_ns or not re.fullmatch(r'net:\[\d+\]', relay_ns):
        raise ValueError('Relay is not inside its private network namespace')
    routes = privileged(['/usr/bin/cat', f'/proc/{pid}/net/route']).stdout
    interfaces = privileged(['/usr/bin/cat', f'/proc/{pid}/net/dev']).stdout
    names = [line.split(':', 1)[0].strip() for line in interfaces.splitlines() if ':' in line]
    if names != ['lo'] or len(routes.strip().splitlines()) != 1:
        raise ValueError('Relay namespace exposes an external interface or IPv4 route')
    mounts = privileged(['/usr/bin/cat', f'/proc/{pid}/mountinfo']).stdout
    for mountpoint in ('/asterctl', '/sockets'):
        matching = [line.split() for line in mounts.splitlines() if len(line.split()) > 5 and line.split()[4] == mountpoint]
        if len(matching) != 1 or 'ro' not in matching[0][5].split(','):
            raise ValueError('Expected a read-only relay executable/socket-directory bind')
    executed_sha = privileged(['/usr/bin/sha256sum', f'/proc/{pid}/exe']).stdout.split()[0]
    if executed_sha != expected_binary_sha:
        raise ValueError('Systemd did not execute the exact retained controller')
    (output / (unit + '.properties.json')).write_text(json.dumps(values, indent=2) + '\n')
    (output / (unit + '.process.txt')).write_text(status + '\n' + routes + '\n' + interfaces + '\n' + mounts)
    return {'unit': unit, 'pid': pid, 'uid': 10001, 'hostNetworkNamespace': host_ns,
            'relayNetworkNamespace': relay_ns, 'interfaces': names, 'noExternalRoutes': True,
            'readOnlyBinds': ['/asterctl', '/sockets'], 'binarySha256': executed_sha}


def ready_https(ca):
    last_error = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            return https(ca)
        except (OSError, ValueError, http.client.HTTPException) as error:
            last_error = error
            time.sleep(0.25)
    raise ValueError('Synthetic HTTPS readiness failed: ' + str(last_error))


def activated_relay(unit, port, expected_binary_sha, output, expected_root):
    """Trigger the inherited socket and prove exec, not only systemd's fork."""
    deadline = time.monotonic() + 10
    last_error = None
    with socket.create_connection(('127.0.0.1', port), timeout=3, source_address=(CLIENT_IP, 0)):
        while time.monotonic() < deadline:
            state = privileged(['/usr/bin/systemctl', 'show', unit,
                                '--property=MainPID,ActiveState,ExecMainCode,ExecMainStatus,Result']).stdout
            values = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
            (output / (unit + '.startup.json')).write_text(json.dumps(values, indent=2) + '\n')
            if values.get('ExecMainStatus', '0') != '0':
                raise ValueError('Relay failed before serving clients: ' + json.dumps(values))
            try:
                return confinement(unit, expected_binary_sha, output, expected_root)
            except (OSError, ValueError, RuntimeError) as error:
                last_error = error
                time.sleep(0.1)
    raise ValueError('Relay did not become a verified running process: ' + str(last_error))


def cleanup_command(function, *args, **kwargs):
    """Keep later exact-resource cleanup and the failed receipt on a timeout."""
    try:
        return function(*args, **kwargs)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        return subprocess.CompletedProcess([], 1, '', str(error)[-8192:])


def qualify(output, source_binary):
    if sys.platform != 'linux' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('This synthetic probe requires a disposable GitHub-hosted Linux runner')
    if source_binary.is_symlink() or not source_binary.is_file() or source_binary.stat().st_size > 128 * 1024 * 1024:
        raise ValueError('Expected a bounded regular Linux controller')
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    work = output / 'work'; work.mkdir(mode=0o700)
    root = Path('/tmp/aster-synthetic-unix-' + secrets.token_hex(8)); root.mkdir(mode=0o700)
    name = root.name
    receipt = {'schemaVersion': 1, 'type': 'aster-synthetic-systemd-unix-ingress-v1', 'result': 'failed',
               'scope': 'Actual Linux systemd relay and internal Caddy; not full appliance or external-LAN qualification',
               'checks': [], 'cleanup': [], 'sourceCommit': os.environ.get('GITHUB_SHA')}
    containers, created_units, nid, built = [], [], None, False
    before_account, prepared_account, binary = None, None, None
    units = {}
    try:
        listeners = privileged(['/usr/bin/ss', '-H', '-ltn', 'sport = :80 or sport = :443'])
        if listeners.stdout.strip():
            raise ValueError('Disposable runner already has a listener on port 80 or 443; no service will be replaced')
        before_account = account_presence()
        receipt['accountBefore'] = before_account
        if any(before_account.values()):
            raise ValueError('Disposable probe requires absent ingress account name and UID/GID10001; existing identities are preserved')
        binary = root / 'releases/synthetic/payload/bin/asterctl'
        binary.parent.mkdir(parents=True)
        shutil.copyfile(source_binary, binary); binary.chmod(0o755)
        (root / 'run').mkdir(mode=0o700)
        (root / 'run/ingress-jail').mkdir(mode=0o755)
        sockets = root / 'run/ingress-sockets'; sockets.mkdir(mode=0o700)
        caddy_data = root / 'synthetic-caddy-data'; caddy_data.mkdir(mode=0o700)
        privileged(['/usr/bin/chown', '-R', '0:0', str(root)])
        prepared_account = prepare_account(binary)
        receipt['accountProvisioning'] = prepared_account
        if not prepared_account['createdUser'] or not prepared_account['createdGroup']:
            raise ValueError('Fresh probe identities were not both created by this exact controller')
        privileged(['/usr/bin/chown', '10001:10001', str(sockets)])
        privileged(['/usr/bin/chown', '10001:10001', str(caddy_data)])
        units, template_hashes = render_units(root, binary)
        receipt.update({'controllerSha256': common.digest(source_binary), 'templateSha256': template_hashes,
                        'unitSha256': {key: hashlib.sha256(value.encode()).hexdigest() for key, value in units.items()}})
        for key, value in units.items():
            (output / key).write_text(value)
        lock_path = ROOT / 'operations/appliance/image-lock.json'
        lock = json.loads(lock_path.read_text()); base = lock['bases']['caddy']
        if lock.get('platform') != 'linux/amd64' or not re.fullmatch(r'caddy:[^\s@]+@sha256:[a-f0-9]{64}', base):
            raise ValueError('Expected the exact reviewed Linux Caddy base')
        recipe = ROOT / 'operations/Dockerfile.caddy'
        (work / 'Dockerfile').write_bytes(recipe.read_bytes())
        build = common.docker(['build', '--platform', 'linux/amd64', '--progress', 'plain', '--build-arg',
                              'CADDY_IMAGE=' + base, '--tag', name, str(work)], work, timeout=300, check=False)
        (output / 'build.log').write_text((build.stdout + build.stderr)[-262144:])
        if build.returncode:
            raise ValueError('Pinned Caddy image build failed; see retained build.log')
        built = True
        image_id = common.docker(['image', 'inspect', '--format', '{{.Id}}', name], work).stdout.strip()
        if not common.IMAGE_ID.fullmatch(image_id):
            raise ValueError('Invalid exact Caddy image ID')
        receipt.update({'imageId': image_id, 'baseImage': base, 'dockerfileSha256': common.digest(recipe),
                        'imageLockSha256': common.digest(lock_path)})
        (output / 'docker-version.json').write_text(common.docker(['version', '--format', '{{json .}}'], work).stdout)
        for filename in ('Caddyfile.internal', 'headers.caddy'):
            source = ROOT / 'operations/appliance/config' / filename
            target = output / filename; target.write_bytes(source.read_bytes()); target.chmod(0o444)
        upstream = output / 'Caddyfile.upstream'; upstream.write_text(UPSTREAM); upstream.chmod(0o444)
        receipt['configSha256'] = {file: common.digest(output / file) for file in ('Caddyfile.internal', 'headers.caddy', 'Caddyfile.upstream')}
        nid = common.docker(['network', 'create', '--driver', 'bridge', '--internal', '--label',
                             'org.aster.synthetic-ingress=' + name, name], work).stdout.strip()
        if not common.OBJECT_ID.fullmatch(nid):
            raise ValueError('Invalid exact synthetic network ID')
        for role in ('web', 'caddy'):
            config = upstream if role == 'web' else output / 'Caddyfile.internal'
            arguments = ['create', '--name', name + '-' + role, '--label', 'org.aster.synthetic-ingress=' + name,
                         '--platform', 'linux/amd64', '--init', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL',
                         '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '64', '--cpus', '1',
                         '--network', name, '--network-alias', role, '--dns', '127.0.0.1',
                         '--tmpfs', '/config:rw,nosuid,noexec,size=32m,uid=10001,gid=10001',
                         '--mount', f'type=bind,src={config},dst=/etc/caddy/Caddyfile,readonly']
            if role == 'caddy':
                arguments += ['--mount', f'type=bind,src={caddy_data},dst=/data',
                              '--mount', f'type=bind,src={sockets},dst=/run/aster-ingress', '--mount',
                              f'type=bind,src={output / "headers.caddy"},dst=/etc/aster/headers.caddy,readonly',
                              '--env', 'ASTER_DOMAIN=' + HOSTNAME, '--env', 'ASTER_ORIGIN=https://' + HOSTNAME]
            else:
                arguments += ['--tmpfs', '/data:rw,nosuid,noexec,size=32m,uid=10001,gid=10001']
            cid = common.docker([*arguments, image_id, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], work).stdout.strip()
            if not common.OBJECT_ID.fullmatch(cid):
                raise ValueError('Invalid exact synthetic container ID')
            containers.append((role, cid))
            common.docker(['start', cid], work)
        caddy_id = containers[-1][1]
        ca = output / 'root.crt'
        last_error = None
        for attempt in range(30):
            try:
                common.read_public_root(caddy_id, work, ca)
                break
            except (OSError, ValueError) as error:
                last_error = error
                time.sleep(1)
        else:
            raise ValueError('Actual Unix Caddy did not become ready: ' + str(last_error))
        receipt['publicRootSha256'] = common.digest(ca)
        inspected = [common.one_json(common.docker(['inspect', cid], work)) for _, cid in containers]
        network = common.one_json(common.docker(['network', 'inspect', nid], work))
        (output / 'containers.json').write_text(json.dumps(inspected, indent=2) + '\n')
        (output / 'network.json').write_text(json.dumps(network, indent=2) + '\n')
        common.check(receipt, 'internal topology without Docker publication', lambda: inspect_topology(inspected, network, name, image_id))
        common.check(receipt, 'no Caddy file capabilities', lambda: common.executable_capabilities(caddy_id, work))
        common.check(receipt, 'protected Unix socket ownership and permissions', lambda: socket_permissions(sockets))
        for unit in units:
            destination = Path('/etc/systemd/system') / unit
            if destination.exists() or destination.is_symlink():
                raise ValueError('Synthetic systemd unit destination already exists')
            privileged(['/usr/bin/install', '-o', '0', '-g', '0', '-m', '0644', str(output / unit), str(destination)])
            created_units.append(unit)
        privileged(['/usr/bin/systemctl', 'daemon-reload'])
        for unit in units:
            if unit.endswith('.socket'):
                privileged(['/usr/bin/systemctl', 'start', unit])
        startup_passed = True
        for unit in units:
            if unit.endswith('.service'):
                port = 443 if unit.endswith('-https.service') else 80
                okay = common.check(receipt, 'actual socket-activated relay startup ' + unit,
                                    lambda unit=unit, port=port: activated_relay(unit, port, receipt['controllerSha256'], output, root))
                startup_passed = okay and startup_passed
        if not startup_passed:
            raise ValueError('Host relay startup failed; TLS/restart checks were not attempted. See retained unit startup state and journals.')
        common.check(receipt, 'host HTTPS and client IP / header-spoof control', lambda: ready_https(ca))
        common.check(receipt, 'host HTTP redirect', host_redirect)
        common.check(receipt, 'client-supplied PROXY line cannot replace kernel source', forged_proxy_line)
        common.check(receipt, 'untrusted CA rejected', lambda: reject_tls(None, HOSTNAME))
        common.check(receipt, 'wrong SNI rejected with live positive control', lambda: reject_tls(ca, 'wrong.synthetic.test'))
        for unit in units:
            if unit.endswith('.service'):
                common.check(receipt, 'actual process confinement ' + unit, lambda unit=unit: confinement(unit, receipt['controllerSha256'], output, root))
        # Recreate the socket in the same protected directory. This catches an
        # accidental bind of one old inode instead of the directory itself.
        common.docker(['restart', '--time', '10', caddy_id], work, timeout=30)
        common.check(receipt, 'persistent CA unchanged after graceful restart', lambda: persistent_ca(caddy_id, work, receipt['publicRootSha256']))
        common.check(receipt, 'HTTPS after Caddy restart and Unix socket replacement', lambda: ready_https(ca))
        common.docker(['kill', '--signal', 'KILL', caddy_id], work)
        common.docker(['start', caddy_id], work)
        common.check(receipt, 'persistent CA unchanged after crash recovery', lambda: persistent_ca(caddy_id, work, receipt['publicRootSha256']))
        common.check(receipt, 'HTTPS after Caddy crash with stale Unix socket paths', lambda: ready_https(ca))
        common.check(receipt, 'socket protection retained after crash recovery', lambda: socket_permissions(sockets))
        if all(item['result'] == 'passed' for item in receipt['checks']):
            receipt['result'] = 'passed'
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        receipt['error'] = str(error)[-8192:]
    finally:
        for unit in created_units:
            if unit.endswith('.service'):
                journal = cleanup_command(privileged, ['/usr/bin/journalctl', '--no-pager', '-u', unit, '-n', '100', '-o', 'short-iso'], check=False)
                (output / (unit + '.log')).write_text((journal.stdout + journal.stderr)[-65536:])
        if created_units:
            result = cleanup_command(privileged, ['/usr/bin/systemctl', 'stop', *sorted(created_units, key=lambda item: not item.endswith('.socket'))], check=False)
            receipt['cleanup'].append({'kind': 'stop-exact-units', 'result': 'passed' if result.returncode == 0 else 'failed'})
            for unit in created_units:
                result = cleanup_command(privileged, ['/usr/bin/rm', '--', '/etc/systemd/system/' + unit], check=False)
                receipt['cleanup'].append({'kind': 'remove-exact-unit', 'unit': unit, 'result': 'passed' if result.returncode == 0 else 'failed'})
            result = cleanup_command(privileged, ['/usr/bin/systemctl', 'daemon-reload'], check=False)
            receipt['cleanup'].append({'kind': 'reload-after-exact-unit-removal', 'result': 'passed' if result.returncode == 0 else 'failed'})
        for role, cid in reversed(containers):
            logs = cleanup_command(common.docker, ['logs', '--tail', '200', cid], work, check=False)
            (output / (role + '.log')).write_text((logs.stdout + logs.stderr)[-65536:])
            result = cleanup_command(common.docker, ['rm', '--force', cid], work, check=False)
            receipt['cleanup'].append({'kind': 'exact-container', 'id': cid, 'result': 'passed' if result.returncode == 0 else 'failed'})
        if nid:
            result = cleanup_command(common.docker, ['network', 'rm', nid], work, check=False)
            receipt['cleanup'].append({'kind': 'exact-network', 'id': nid, 'result': 'passed' if result.returncode == 0 else 'failed'})
        if built:
            result = cleanup_command(common.docker, ['image', 'rm', name], work, check=False)
            receipt['cleanup'].append({'kind': 'probe-image-tag', 'result': 'passed' if result.returncode == 0 else 'failed'})
        try:
            if any(item['result'] != 'passed' for item in receipt['cleanup']):
                raise ValueError('Owned resources did not finish cleanup; account deletion will not be attempted')
            account_cleanup = cleanup_account(before_account, prepared_account, binary)
        except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
            account_cleanup = {'result': 'failed', 'error': str(error)[-4096:]}
        receipt['cleanup'].append({'kind': 'only-new-ingress-account', **account_cleanup})
        # Only this freshly created random synthetic root; it contains no real
        # installation data. The persistent synthetic Caddy private keys are
        # confined to this root and are never selected for evidence upload.
        result = cleanup_command(privileged, ['/usr/bin/rm', '-rf', '--', str(root)], check=False)
        receipt['cleanup'].append({'kind': 'synthetic-root', 'result': 'passed' if result.returncode == 0 else 'failed'})
        if any(item['result'] != 'passed' for item in receipt['cleanup']):
            receipt['result'] = 'failed'
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--asterctl', type=Path, required=True)
    arguments = parser.parse_args()
    result = qualify(arguments.output.absolute(), arguments.asterctl.absolute())
    print(json.dumps({'result': result['result'], 'checks': len(result['checks']), 'receipt': str(arguments.output / 'receipt.json')}))
    sys.exit(0 if result['result'] == 'passed' else 1)
