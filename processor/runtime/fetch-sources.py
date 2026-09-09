"""Build-time fixed release retrieval and authentication; never a runtime tool."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request


def check_hash(path, expected):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Source checksum mismatch: {path.name}')


def signed_tag(tag, auth):
    payload = tag['verification']['payload'].encode()
    signature = tag['verification']['signature'].encode()
    raw = payload + signature
    digest = hashlib.sha1(f'tag {len(raw)}\0'.encode() + raw, usedforsecurity=False).hexdigest()
    if (digest != auth['tagObject'] or tag['sha'] != digest or
            tag['object']['sha'] != auth['commit'] or
            not payload.startswith(f"object {auth['commit']}\ntype commit\n".encode())):
        raise RuntimeError('The signed Tesseract tag does not match the reviewed Git object')
    return payload, signature


def verify_signature(key_file, signature, payload, fingerprint, work):
    # ASCII armor is a transport encoding, not a signature-verification step.
    # gpgv checks the resulting public key packet and the exact signed bytes.
    armor = key_file.read_text().split('\n\n', 1)[1]
    packet = base64.b64decode(''.join(line for line in armor.splitlines()
                                    if line and not line.startswith(('=', '-'))), validate=True)
    keyring = work / 'release-keyring.gpg'
    keyring.write_bytes(packet)
    signature_path, payload_path = work / 'release.sig', work / 'release.payload'
    signature_path.write_bytes(signature)
    payload_path.write_bytes(payload)
    result = subprocess.run(['gpgv', '--homedir', str(work), '--keyring', str(keyring),
                             '--status-fd', '1', str(signature_path), str(payload_path)],
                            capture_output=True, text=True, check=True)
    valid = [line.split()[2] for line in result.stdout.splitlines()
             if line.startswith('[GNUPG:] VALIDSIG ')]
    if valid != [fingerprint]:
        raise RuntimeError('Release signature did not use the reviewed maintainer key')


def main():
    config = Path('/build/upstream-sources.json')
    sources = json.loads(config.read_text())
    evidence = Path('/build/source-provenance')
    destination = Path('/build/sources')
    destination.mkdir()
    for record in sources['provenanceFiles']:
        check_hash(evidence / record['filename'], record['sha256'])
    records = [sources[name] for name in ['tesseract', 'libtiff', 'pillow']] + sources['buildDependencies']
    for record in records:
        target = destination / record['filename']
        with urllib.request.urlopen(record['url'], timeout=90) as response, target.open('wb') as output:
            # All URLs and expected bytes are immutable reviewed build inputs.
            while data := response.read(1024 * 1024):
                output.write(data)
        check_hash(target, record['sha256'])
    auth = sources['tesseract']['authentication']
    payload, signature = signed_tag(json.loads((evidence / auth['tagFile']).read_text()), auth)
    work = Path('/build/signature-check')
    work.mkdir(mode=0o700)
    verify_signature(evidence / auth['keyFile'], signature, payload, auth['fingerprint'], work)
    auth = sources['libtiff']['authentication']
    verify_signature(evidence / auth['keyFile'], (evidence / auth['signatureFile']).read_bytes(),
                     (destination / sources['libtiff']['filename']).read_bytes(), auth['fingerprint'], work)
    for name in ['tesseract', 'libtiff', 'pillow']:
        record = sources[name]
        with tarfile.open(destination / record['filename']) as archive:
            archive.extractall(destination, filter='data')
        if not (destination / record['directory']).is_dir():
            raise RuntimeError(f'Unexpected source archive layout: {name}')
    print('Verified pinned source archives, exact libtiff signature and Tesseract signed tag')


if __name__ == '__main__':
    main()
