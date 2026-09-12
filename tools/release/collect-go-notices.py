"""Offline license inventory and SPDX SBOM bound to an actual Go executable."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote

spec = importlib.util.spec_from_file_location('license_inventory', Path(__file__).with_name('collect-notices.py'))
licenses = importlib.util.module_from_spec(spec)
spec.loader.exec_module(licenses)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def json_stream(value):
    decoder = json.JSONDecoder()
    result = []
    while value.strip():
        value = value.lstrip()
        item, end = decoder.raw_decode(value)
        result.append(item)
        value = value[end:]
    return result


def select_modules(build, modules):
    """Require every embedded module to match the locked local module graph."""
    main = build.get('Main', {})
    if not main.get('Path') or not build.get('GoVersion') or not build.get('Path'):
        raise ValueError('Executable lacks complete Go build information')
    graph = {}
    for module in modules:
        if module['Path'] in graph:
            raise ValueError('Duplicate module identity in local graph')
        graph[module['Path']] = module
    if not graph.get(main['Path'], {}).get('Main'):
        raise ValueError('Executable main module differs from the selected project')
    if main.get('Replace'):
        raise ValueError('Replacement main modules require a separate reviewed inventory')
    result, seen = [], set()
    for dep in build.get('Deps', []):
        path = dep.get('Path')
        if path in seen or not path or not dep.get('Version') or not dep.get('Sum'):
            raise ValueError('Embedded module identity is incomplete or duplicated')
        seen.add(path)
        actual = graph.get(path)
        if dep.get('Replace') or (actual and actual.get('Replace')):
            raise ValueError('Replacement dependencies require a separate reviewed inventory')
        if not actual or any(actual.get(key) != dep.get(key) for key in ('Version', 'Sum')):
            raise ValueError('Executable dependency differs from the locked local graph: ' + path)
        if not actual.get('Dir'):
            raise ValueError('Exact module source is absent from the offline cache: ' + path)
        result.append(actual)
    if not result:
        raise ValueError('Expected controller dependency metadata is absent')
    return result


def notice_files(root):
    root = root.resolve(strict=True)
    found = []
    count = 0
    for directory, children, filenames in os.walk(root, followlinks=False):
        children[:] = [name for name in children if name not in {'.git', 'node_modules'}
                       and not (Path(directory) / name).is_symlink()]
        for name in filenames:
            count += 1
            if count > 200000:
                raise ValueError('Go notice source tree exceeds its inventory limit')
            path = Path(directory) / name
            if not path.is_symlink() and licenses.license_path(path.relative_to(root)):
                found.append((path, str(path.relative_to(root))))
    return sorted(found)


def run_go(executable, arguments, root):
    # Resolve locally only; never download a toolchain or module while generating
    # distribution evidence. The release workflow populates the verified cache.
    env = dict(os.environ)
    env.update({'GOTOOLCHAIN': 'local', 'GOPROXY': 'off', 'GOSUMDB': 'off',
                'GOWORK': 'off', 'GOFLAGS': '-mod=readonly'})
    result = subprocess.run([str(executable), *arguments], cwd=root, env=env,
                            check=True, text=True, capture_output=True, timeout=120)
    if len(result.stdout.encode()) > 8 * 1024 * 1024:
        raise ValueError('Go metadata exceeds its output limit')
    return result.stdout


def spdx(build, binary, digest, modules, timestamp):
    def package(identifier, name, version, license_name='NOASSERTION'):
        return {'SPDXID': identifier, 'name': name, 'versionInfo': version,
                'downloadLocation': 'NOASSERTION', 'filesAnalyzed': False,
                'licenseConcluded': 'NOASSERTION', 'licenseDeclared': license_name,
                'copyrightText': 'NOASSERTION'}
    main = package('SPDXRef-Controller', build['Main']['Path'], build['Main'].get('Version', '(devel)'), 'Apache-2.0')
    main['packageFileName'] = binary.name
    main['checksums'] = [{'algorithm': 'SHA256', 'checksumValue': digest}]
    runtime = package('SPDXRef-GoRuntime', 'Go standard library and runtime', build['GoVersion'], 'BSD-3-Clause')
    packages = [main, runtime]
    relations = [{'spdxElementId': 'SPDXRef-DOCUMENT', 'relationshipType': 'DESCRIBES', 'relatedSpdxElement': 'SPDXRef-Controller'},
                 {'spdxElementId': 'SPDXRef-Controller', 'relationshipType': 'DEPENDS_ON', 'relatedSpdxElement': 'SPDXRef-GoRuntime'}]
    for module in modules:
        identifier = 'SPDXRef-Module-' + hashlib.sha256(module['Path'].encode()).hexdigest()[:20]
        record = package(identifier, module['Path'], module['Version'])
        record['externalRefs'] = [{'referenceCategory': 'PACKAGE-MANAGER', 'referenceType': 'purl',
                                  'referenceLocator': 'pkg:golang/' + quote(module['Path'], safe='/') + '@' + quote(module['Version'], safe='')}]
        record['sourceInfo'] = 'Go module content checksum: ' + module['Sum']
        packages.append(record)
        relations.append({'spdxElementId': 'SPDXRef-Controller', 'relationshipType': 'DEPENDS_ON', 'relatedSpdxElement': identifier})
    return {'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT',
            'name': 'Aster appliance controller ' + digest[:16],
            'documentNamespace': 'https://github.com/Blacklord100/aster-family-office/spdx/controller/' + digest,
            'creationInfo': {'creators': ['Tool: aster-go-binary-notice-inventory-v1'], 'created': timestamp},
            'packages': packages, 'relationships': relations}


def collect(binary, executable, module_root, project_root, output):
    binary = binary.absolute()
    if binary.is_symlink() or not binary.is_file() or binary.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('Controller must be a bounded regular executable artifact')
    executable = executable.resolve(strict=True)
    module_root = module_root.resolve(strict=True)
    project_root = project_root.resolve(strict=True)
    before = sha256(binary)
    builds = json_stream(run_go(executable, ['version', '-m', '-json', str(binary)], module_root))
    if len(builds) != 1:
        raise ValueError('Expected one executable build identity')
    build = builds[0]
    identities = [build.get('Main', {}).get('Path'), *(dep.get('Path') for dep in build.get('Deps', []))]
    if not all(isinstance(value, str) and value and not value.startswith('-') for value in identities):
        raise ValueError('Executable module identity is invalid')
    # Asking for "all" also traverses unused test/tool dependencies that a
    # production build need not have downloaded. Inventory only embedded code.
    modules = select_modules(build, json_stream(run_go(executable, ['list', '-m', '-json', *identities], module_root)))
    environment = json.loads(run_go(executable, ['env', '-json', 'GOROOT', 'GOVERSION', 'GOMODCACHE'], module_root))
    if environment['GOVERSION'] != build['GoVersion']:
        raise ValueError('Collector toolchain license source differs from executable Go version')
    cache = Path(environment['GOMODCACHE']).resolve(strict=True)
    goroot = Path(environment['GOROOT']).resolve(strict=True)
    source_version = (goroot / 'VERSION').read_text().splitlines()[0]
    if source_version != build['GoVersion']:
        raise ValueError('Go runtime source version does not match executable')
    records = []
    for module in modules:
        path = Path(module['Dir'])
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(cache):
            raise ValueError('Go module source escapes the local module cache')
        record = {'ecosystem': 'golang', 'name': module['Path'], 'version': module['Version'],
                  'moduleSum': module['Sum'], 'declaredLicense': None}
        records.append((record, notice_files(path), None))
    project_files = [(project_root / name, name) for name in ('LICENSE', 'NOTICE')]
    if any(not path.is_file() or path.is_symlink() for path, _ in project_files):
        raise ValueError('Project LICENSE/NOTICE texts are required')
    records.append(({'ecosystem': 'golang', 'name': build['Main']['Path'],
                     'version': build['Main'].get('Version', '(devel)'), 'declaredLicense': 'Apache-2.0'}, project_files, None))
    runtime_files = [(goroot / name, name) for name in ('LICENSE', 'PATENTS') if (goroot / name).is_file()]
    runtime_files.extend((path, 'src/' + original) for path, original in notice_files(goroot / 'src'))
    if not (goroot / 'LICENSE').is_file():
        raise ValueError('Go runtime license text is absent')
    records.append(({'ecosystem': 'golang-toolchain', 'name': 'Go standard library and runtime',
                     'version': build['GoVersion'], 'declaredLicense': 'BSD-3-Clause'}, runtime_files, None))
    if sha256(binary) != before:
        raise ValueError('Controller artifact changed during inventory')
    inventory = licenses.collect(records, output)
    if inventory['missingInstalledTexts']:
        raise ValueError('Missing exact module license texts; review inventory.json')
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    # Embedded Go build details contain no operator environment or customer data.
    # Remove the host path to the input executable from portable evidence.
    build.pop('Name', None)
    (output / 'build-info.json').write_text(json.dumps(build, indent=2) + '\n')
    (output / 'controller.spdx.json').write_text(json.dumps(spdx(build, binary, before, modules, timestamp), indent=2) + '\n')
    receipt = {'schemaVersion': 1, 'type': 'aster-go-binary-notice-inventory-v1', 'binarySha256': before,
               'binaryBytes': binary.stat().st_size, 'goVersion': build['GoVersion'],
               'mainModule': build['Main'], 'dependencies': [{key: module[key] for key in ('Path', 'Version', 'Sum')} for module in modules],
               'licenseInventorySha256': sha256(output / 'inventory.json'),
               'spdxSha256': sha256(output / 'controller.spdx.json'),
               'networkUsed': False, 'legalApproval': False}
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--go', type=Path, required=True, help='Matching locally installed Go executable')
    parser.add_argument('--module-root', type=Path, required=True)
    parser.add_argument('--project-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New directory; never overwritten')
    args = parser.parse_args()
    receipt = collect(args.binary, args.go, args.module_root, args.project_root, args.output)
    print(json.dumps({'binarySha256': receipt['binarySha256'], 'dependencies': len(receipt['dependencies']), 'legalApproval': False}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
