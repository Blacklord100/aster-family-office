"""Qualify the built processor under a read-only root and Docker --network none.

Only synthetic repository fixtures are used. No model server, provider, host
mail directory, database, or production credential is available to this probe.
"""
import errno
import base64
import ctypes
import hashlib
import importlib
import importlib.metadata
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


EXPECTED_CUSTOM_PACKAGES = (
    ('libtiff6', '4.7.2-1+aster1', 'tiff (4.7.2)'),
    ('tesseract-ocr', '5.5.3-1+aster3', 'tesseract (5.5.3)'),
)


def custom_package_identity(manifest):
    # Preserve Debian's canonical source identities. A renamed package/source
    # must not make unresolved advisory entries silently disappear from scans.
    for name, version, source in EXPECTED_CUSTOM_PACKAGES:
        packages = [item for item in manifest['systemPackages'] if item['name'] == name]
        assert len(packages) == 1, 'Missing or duplicate custom package: ' + name
        assert packages[0]['version'] == version, 'Unexpected custom package version: ' + name
        assert packages[0]['source'] == source, 'Unexpected custom package source: ' + name
        metadata = Path(packages[0]['metadataPath']).read_text().splitlines()
        for field in ['Package: ' + name, 'Version: ' + version, 'Source: ' + source]:
            assert field in metadata, field


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
    assert manifest['tesseract']['version'] == '5.5.3'
    assert manifest['tesseract']['sourceArchives'], 'Custom OCR source inventory is missing'
    assert manifest['tesseract']['compiledDataPrefix'] == '/opt/tesseract/share'
    assert manifest['tesseract']['options'] == {'archive': False, 'curl': False, 'graphics': False, 'training': False}
    assert manifest['tesseract']['authentication']
    assert manifest['libtiff']['version'] == '4.7.2'
    assert manifest['libtiff']['libraryPath'] == '/opt/libtiff/lib/libtiff.so.6'
    assert manifest['libtiff']['sourceArchives'] and manifest['libtiff']['authentication']
    assert manifest['pillow']['version'] == '12.3.0'
    assert manifest['pillow']['libtiffVersion'] == '4.7.2'
    assert set(manifest['pillow']['enabledCodecs']) == {'zlib', 'jpeg', 'tiff'}
    assert set(manifest['pillow']['disabledFeatures']) == {'freetype', 'raqm', 'lcms', 'webp', 'jpeg2000', 'imagequant', 'xcb', 'avif'}
    assert manifest['pillow']['sourceArchives'] and manifest['pillow']['buildDependencies']
    assert manifest['pillow']['buildWheel']['filename'].lower().startswith('pillow-12.3.0-')
    assert len(bytes.fromhex(manifest['pillow']['buildWheel']['sha256'])) == 32
    provenance_root = Path('/opt/aster/source-provenance').resolve()
    assert manifest['sourceProvenance'], 'Authenticated source provenance is missing'
    for source_file in manifest['sourceProvenance']:
        path = Path(source_file['path'])
        assert path.is_absolute() and path.resolve().is_relative_to(provenance_root)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == source_file['sha256'], str(path)
    assert manifest['systemPackages'], 'Debian scanner inventory is missing'
    trust = manifest['runtimeConfiguration']['trustStore']
    assert hashlib.sha256(Path(trust['bundle']).read_bytes()).hexdigest() == trust['sha256']
    for alias in trust['aliases']:
        assert Path(alias['path']).is_symlink() and os.readlink(alias['path']) == alias['symlink']
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
    custom_package_identity(manifest)


def image_codec_roundtrips():
    from PIL import Image, features

    for codec in ('jpg', 'zlib', 'libtiff'):
        assert features.check_codec(codec), 'Required Pillow codec is missing: ' + codec
    color = (24, 96, 180)
    original = Image.new('RGB', (8, 8), color)
    for image_format, options in [('PNG', {}), ('JPEG', {'quality': 95, 'subsampling': 0}),
                                  ('TIFF', {'compression': 'tiff_deflate'})]:
        buffer = io.BytesIO()
        original.save(buffer, format=image_format, **options)
        with Image.open(io.BytesIO(buffer.getvalue())) as decoded:
            decoded.load()
            assert decoded.format == image_format and decoded.size == original.size and decoded.mode == 'RGB'
            if image_format == 'JPEG':
                # JPEG is lossy; verify the known solid color within its rounding tolerance.
                assert all(abs(value - color[index % 3]) <= 3 for index, value in enumerate(decoded.tobytes()))
            else:
                assert decoded.tobytes() == original.tobytes()
    return {name: features.version_codec(name) for name in ('jpg', 'zlib', 'libtiff')}


def pillow_native_record_hashes():
    distribution = importlib.metadata.distribution('Pillow')
    assert distribution.version == '12.3.0'
    extensions = [item for item in distribution.files or [] if str(item).startswith('PIL/') and str(item).endswith('.so')]
    assert extensions, 'Installed Pillow native extension inventory is missing'
    for extension in extensions:
        assert extension.hash and extension.hash.mode == 'sha256', str(extension)
        digest = hashlib.sha256(distribution.locate_file(extension).read_bytes()).digest()
        assert base64.urlsafe_b64encode(digest).decode().rstrip('=') == extension.hash.value, str(extension)
    return len(extensions)


def native_dependencies():
    import numpy as np
    from scipy.linalg import solve
    from PIL import features, __version__ as pillow_version

    for name in ('fastapi', 'uvicorn', 'httpx', 'pypdf', 'pypdfium2', 'sklearn'):
        importlib.import_module(name)
    np.testing.assert_allclose(solve(np.array([[3., 1.], [1., 2.]]), np.array([9., 8.])), [2., 3.])
    assert pillow_version == '12.3.0'
    codecs = image_codec_roundtrips()
    assert codecs['libtiff'] == '4.7.2', 'Pillow still uses an older bundled TIFF library'
    for feature in ('freetype2', 'raqm', 'littlecms2', 'webp', 'jpg_2000', 'libimagequant', 'xcb', 'avif'):
        assert not features.check(feature), 'An undeclared optional Pillow feature is enabled: ' + feature
    extension_count = pillow_native_record_hashes()
    tiff = ctypes.CDLL('/opt/libtiff/lib/libtiff.so.6')
    tiff.TIFFGetVersion.restype = ctypes.c_char_p
    tiff_version = tiff.TIFFGetVersion().decode('ascii')
    assert tiff_version.splitlines()[0] == 'LIBTIFF, Version 4.7.2'
    assert uuid.uuid4().version == 4, 'Pure Python UUID fallback is unavailable'
    assert ssl.create_default_context().get_ca_certs(), 'TLS trust store is missing'
    from service.ocr_worker import available_backend
    assert available_backend() == 'tesseract', 'The Linux local OCR backend is missing'
    version = subprocess.run(['tesseract', '--version'], check=True, capture_output=True, text=True, timeout=10)
    assert version.stdout.splitlines()[0] == 'tesseract 5.5.3'
    output = subprocess.run(['tesseract', '--list-langs'], check=True, capture_output=True,
                            text=True, timeout=10)
    assert 'eng' in output.stdout.splitlines(), 'English OCR data is missing: ' + output.stdout[:2000] + output.stderr[:2000]
    print(json.dumps({'tesseract': '5.5.3', 'systemTiff': '4.7.2', 'pillow': pillow_version,
                      'pillowCodecs': codecs, 'verifiedPillowNativeExtensions': extension_count,
                      'imageRoundTrips': ['PNG', 'JPEG', 'TIFF']}))


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
