"""Qualify the built processor under a read-only root and Docker --network none.

Only synthetic repository fixtures are used. No model server, provider, host
mail directory, database, or production credential is available to this probe.
"""
import errno
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
import uuid


def image_identity():
    assert (os.getuid(), os.getgid()) == (10001, 10001)
    assert sys.version_info[:3] == (3, 12, 13)
    assert Path(sys.executable).resolve() == Path('/usr/local/bin/python3.12')
    for unavailable in ('/bin/sh', '/bin/bash', '/usr/bin/apt', '/usr/bin/apt-get',
                        '/usr/bin/perl', '/usr/local/bin/pip', '/usr/local/bin/pip3'):
        assert not Path(unavailable).exists(), unavailable
    try:
        Path('/srv/processor/forbidden').write_text('synthetic write probe')
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES)
    else:
        raise AssertionError('The processor root filesystem is writable')
    manifest = json.loads(Path('/opt/aster/runtime-manifest.json').read_text())
    assert manifest['schemaVersion'] == 1
    assert manifest['python']['version'] == '3.12.13'
    assert hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest() == manifest['python']['binarySha256']
    assert manifest['tesseract']['version'] == '5.5.0'
    assert manifest['tesseract']['sourceArchives'], 'Custom OCR source inventory is missing'
    assert manifest['tesseract']['options'] == {'archive': False, 'curl': False, 'graphics': False, 'training': False}
    assert manifest['systemPackages'], 'Debian scanner inventory is missing'
    for package in manifest['systemPackages']:
        metadata = Path(package['metadataPath'])
        assert metadata.is_absolute() and metadata.stat().st_size > 0
        assert package['name'] and package['version'] and package['source']
        for retained in package['files']:
            path = Path(retained['path'])
            assert path.is_absolute()
            if 'sha256' in retained:
                assert hashlib.sha256(path.read_bytes()).hexdigest() == retained['sha256'], str(path)
            else:
                assert path.is_symlink() and os.readlink(path) == retained['symlink'], str(path)


def native_dependencies():
    import numpy as np
    from scipy.linalg import solve
    from PIL import Image

    for name in ('fastapi', 'uvicorn', 'httpx', 'pypdf', 'pypdfium2', 'sklearn'):
        importlib.import_module(name)
    np.testing.assert_allclose(solve(np.array([[3., 1.], [1., 2.]]), np.array([9., 8.])), [2., 3.])
    buffer = io.BytesIO()
    Image.new('RGB', (2, 2), '#ffffff').save(buffer, format='PNG')
    assert Image.open(io.BytesIO(buffer.getvalue())).size == (2, 2)
    assert uuid.uuid4().version == 4, 'Pure Python UUID fallback is unavailable'
    assert ssl.create_default_context().get_ca_certs(), 'TLS trust store is missing'
    from service.ocr_worker import available_backend
    assert available_backend() == 'tesseract', 'The Linux local OCR backend is missing'
    output = subprocess.run(['tesseract', '--list-langs'], check=True, capture_output=True,
                            text=True, timeout=10)
    assert 'eng' in output.stdout.splitlines(), 'English OCR data is missing'


def http_runtime(processor_root: Path, entrypoint: Path = Path('/opt/aster/processor-entrypoint.py')):
    import httpx

    token = secrets.token_urlsafe(48)
    environment = {
        **os.environ,
        'OLLAMA_BASE_URL': 'http://127.0.0.1:9',
        'OLLAMA_TIMEOUT_SECONDS': '1',
        'ALLOW_CLOUD_ENGINES': 'false',
        'OCR_ENABLED': 'true',
        'PYTHONDONTWRITEBYTECODE': '1',
    }
    fixture = processor_root / 'tests/fixtures/synthetic-scan.pdf'
    scan = fixture.read_bytes()
    notice = (processor_root / 'corpus/sample-capital-call.txt').read_bytes()
    environment.pop('PROCESSOR_TOKEN', None)
    with tempfile.TemporaryDirectory(prefix='aster-probe-secret-') as secret_directory, tempfile.TemporaryFile() as logs:
        token_file = Path(secret_directory) / 'token'
        token_file.write_text(token)
        token_file.chmod(0o600)
        environment['PROCESSOR_TOKEN_FILE'] = str(token_file)
        child = subprocess.Popen(
            [sys.executable, str(entrypoint), 'uvicorn', 'service.app:create_app', '--factory',
             '--host', '0.0.0.0', '--port', '8000', '--workers', '1', '--no-access-log',
             '--limit-concurrency', '8', '--timeout-keep-alive', '5'],
            cwd=processor_root, env=environment, stdin=subprocess.DEVNULL, stdout=logs, stderr=logs)
        try:
            with httpx.Client(base_url='http://127.0.0.1:8000', trust_env=False, timeout=90) as client:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline and child.poll() is None:
                    try:
                        health = client.get('/healthz', timeout=1)
                        if health.status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(.2)
                else:
                    raise AssertionError('Built processor did not start within 30 seconds')
                assert health.json() == {'status': 'ok'}
                assert client.post('/v1/extract', content=b'not parsed').status_code == 401
                assert client.post('/v1/knowledge/decode', content=b'not parsed').status_code == 401
                headers = {'X-Processor-Key': token}
                result = client.post('/v1/extract', headers=headers,
                                     data={'mode': 'workflow', 'document_id': 'runtime-probe'},
                                     files={'file': ('notice.txt', notice, 'text/plain')})
                assert result.status_code == 200, result.text
                extraction = result.json()
                assert extraction['model'] is None, 'Deterministic probe unexpectedly used a model'
                assert extraction['facts'][0]['amount'] == '420000.00'
                assert extraction['facts'][0]['currency'] == 'EUR'
                assert extraction['facts'][0]['investmentName'] == 'Cedar Partners IV'
                malformed = client.post('/v1/extract', headers=headers,
                                        data={'mode': 'workflow', 'document_id': 'runtime-malformed'},
                                        files={'file': ('bad.pdf', b'Not a PDF', 'application/pdf')})
                assert malformed.status_code == 422
                decoded = client.post('/v1/knowledge/decode', headers=headers,
                                      files={'file': ('scan.pdf', scan, 'application/pdf')})
                assert decoded.status_code == 200, decoded.text
                pages = decoded.json()['pages']
                assert len(pages) == 1 and pages[0]['number'] == 1
                for expected in ('Alderholt Real Assets', '4,870,000.00', '30 June 2026'):
                    assert expected in pages[0]['text'], 'Frozen scan OCR content is missing: ' + expected
                assert 'local OCR' in pages[0]['source']
                assert any('requires visual review' in item for item in decoded.json()['warnings'])
                assert fixture.read_bytes() == scan
        except BaseException:
            logs.seek(0, os.SEEK_END)
            logs.seek(max(0, logs.tell() - 4000))
            print(logs.read().decode('utf-8', errors='replace').replace(token, '[redacted]'), file=sys.stderr)
            raise
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


if __name__ == '__main__':
    processor_root = Path('/srv/processor')
    sys.path.insert(0, str(processor_root))
    image_identity()
    native_dependencies()
    http_runtime(processor_root)
    print('Processor identity, inventory, native dependencies, TLS, UUID, local OCR and authenticated HTTP sandbox probes passed without a model or external network.')
