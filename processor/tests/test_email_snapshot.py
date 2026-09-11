"""Synthetic archive copies: correctness, confinement and deterministic artifacts."""
import base64
import hashlib
from io import BytesIO
import json
import socket

from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
import pytest

from service.app import create_app
from service.config import Settings
from service.email_snapshot import (
    COPY_NOTICE, EmailSnapshotRequest, MAX_PAGES, REQUEST_BYTES,
    canonical_email, render_email_snapshot,
)

TOKEN = 'synthetic-email-archive-test-token'


def query(**updates):
    return EmailSnapshotRequest.model_validate({
        'headers': [{'name': 'From', 'value': 'Élodie <elodie@example.test>'},
                    {'name': 'To', 'value': 'Family office <office@example.test>'},
                    {'name': 'Subject', 'value': 'Cedar quarterly report - EUR 1,200,000'},
                    {'name': 'Date', 'value': 'Thu, 10 Sep 2026 12:00:00 +0000'}],
        'textBody': 'Dear office,\n\nReported NAV: EUR 1,200,000 as of 2026-06-30.\nDistribution: EUR 80,000.\n\nRegards,\nÉlodie',
        'attachmentNames': ['Cedar Q2 report.pdf', 'Capital call notice.pdf'],
        'sourceSha256': 'a' * 64,
        **updates,
    })


def test_canonical_copy_exposes_header_injection_bidi_and_keeps_unicode():
    q = query(headers=[{'name': 'Subject', 'value': 'NAV\r\nFrom: forged@example.test\u202e'}],
              textBody='Élodie €120 Ω\nPreserve newlines\x00\u200b',
              attachmentNames=['report.pdf\nSubject: forged'])
    canonical, warnings = canonical_email(q)
    assert COPY_NOTICE in canonical
    assert 'not a screenshot of the original mailbox' in canonical
    assert 'Subject: NAV\\u000AFrom: forged@example.test\\u202E' in canonical
    assert 'Élodie €120 Ω\nPreserve newlines\\u0000\\u200B' in canonical
    assert 'report.pdf\\u000ASubject: forged' in canonical
    assert '\nFrom: forged' not in canonical
    assert any('directional' in item for item in warnings)


def test_html_is_visible_text_only_never_fetches_any_resource(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('An archive copy attempted network access')
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    html = ('<head><style>body{background:url(http://127.0.0.1/private)}</style></head>'
            '<script>leak_secret()</script><iframe src="file:///etc/passwd">secret</iframe>'
            '<img src="http://169.254.169.254/credentials">'
            '<p>Visible EUR 4,200 &amp; approved</p><div hidden>invisible value</div>'
            '<a href="https://example.test/private">Read report</a>')
    result = render_email_snapshot(query(textBody=None, htmlBody=html), force_bitmap=True)
    assert 'Visible EUR 4,200 & approved\nRead report' in result.canonicalText
    assert all(value not in result.canonicalText for value in ['leak_secret', 'invisible value', '169.254', '/etc/passwd'])
    assert any('HTML converted' in warning for warning in result.warnings)


def test_plain_alternative_is_preferred_and_html_limit_is_explicit():
    canonical, warnings = canonical_email(query(textBody='The actual plain alternative', htmlBody='<p>Different HTML</p>'))
    assert 'actual plain alternative' in canonical and 'Different HTML' not in canonical
    assert any('alternate HTML' in item for item in warnings)
    canonical, warnings = canonical_email(query(textBody=None, htmlBody='<div>' * 129 + 'body'))
    assert 'could not be converted within safety limits' in canonical
    assert any('HTML body omitted' in item for item in warnings)


@pytest.mark.parametrize('bitmap', [False, True])
def test_equal_inputs_produce_equal_png_and_pdf_bytes_and_passive_pdf(bitmap):
    first = render_email_snapshot(query(), force_bitmap=bitmap)
    second = render_email_snapshot(query(), force_bitmap=bitmap)
    assert first.model_dump() == second.model_dump()
    assert first.pageCount == 1 and not first.truncated
    assert first.pngPages[0].width == 1240 and first.pngPages[0].height == 1754
    png = base64.b64decode(first.pngPages[0].base64, validate=True)
    assert hashlib.sha256(png).hexdigest() == first.pngPages[0].sha256
    with Image.open(BytesIO(png)) as im:
        assert im.format == 'PNG' and im.size == (1240, 1754)
    pdf = base64.b64decode(first.pdf.base64, validate=True)
    assert hashlib.sha256(pdf).hexdigest() == first.pdf.sha256
    reader = PdfReader(BytesIO(pdf), strict=True)
    assert len(reader.pages) == 1
    assert reader.metadata['/CreationDate'] == 'D:19700101000000Z'
    root = reader.trailer['/Root']
    assert all(key not in root for key in ['/OpenAction', '/AA', '/AcroForm', '/Names'])
    assert all('/Annots' not in page and '/AA' not in page for page in reader.pages)
    if bitmap:
        assert first.fontProfile == 'pillow-bundled-bitmap-v1'
        assert 'Élodie' in first.canonicalText
        assert any('Unicode escapes' in item for item in first.warnings)


def test_eight_page_bound_preserves_full_canonical_text_and_reports_truncation():
    body = 'UNBROKEN' * 20_000 + '\nFINAL SOURCE MARKER'
    result = render_email_snapshot(query(textBody=body), force_bitmap=True)
    assert result.truncated and result.pageCount == MAX_PAGES == len(result.pngPages)
    assert 'FINAL SOURCE MARKER' in result.canonicalText
    assert any('truncated at 8 pages' in item for item in result.warnings)
    assert len(PdfReader(BytesIO(base64.b64decode(result.pdf.base64))).pages) == 8


def test_output_byte_limit_is_enforced_while_encoding(monkeypatch):
    import service.email_snapshot as snapshot
    monkeypatch.setattr(snapshot, 'MAX_ARTIFACT_BYTES', 1024)
    with pytest.raises(ValueError, match='artifact byte limit'):
        snapshot.render_email_snapshot(query(), force_bitmap=True)


@pytest.mark.parametrize('updates', [
    {'headers': [{'name': 'Subject\nInjected', 'value': 'secret'}]},
    {'headers': [{'name': 'Subject', 'value': 'x'}] * 33},
    {'attachmentNames': ['file.pdf'] * 65},
    {'attachmentNames': ['x' * 1025]},
    {'textBody': 'x' * 200_001},
    {'textBody': 'x' * 100_000, 'htmlBody': 'x' * 100_000},
    {'sourceSha256': '../../private'},
    {'engine': {'provider': 'cloud'}},
    {'fontPath': '/etc/passwd'},
])
def test_request_schema_rejects_unsafe_or_oversized_options(updates):
    with pytest.raises(ValueError):
        query(**updates)


def test_endpoint_auth_and_body_limit_run_before_parsing_or_worker(monkeypatch):
    import service.app as app_module
    monkeypatch.setattr(app_module.subprocess, 'Popen', lambda *args, **kwargs: pytest.fail('Worker must not start'))
    with TestClient(create_app(Settings(TOKEN))) as client:
        denied = client.post('/v1/archive/email-snapshot', content=b'x' * (REQUEST_BYTES + 1))
        assert denied.status_code == 401
        oversized = client.post('/v1/archive/email-snapshot', content=b'x' * (REQUEST_BYTES + 1), headers={'X-Processor-Key': TOKEN})
        assert oversized.status_code == 413
        bad = client.post('/v1/archive/email-snapshot', json={'engine': 'cloud', 'textBody': 'private synthetic text'}, headers={'X-Processor-Key': TOKEN})
        assert bad.status_code == 422 and 'private synthetic text' not in bad.text


def test_authenticated_endpoint_uses_local_renderer_with_no_model_available():
    # A real disposable child, with a deliberately unreachable model endpoint.
    settings = Settings(TOKEN, ollama_base_url='http://127.0.0.1:1', allow_cloud_engines=True)
    with TestClient(create_app(settings)) as client:
        response = client.post('/v1/archive/email-snapshot', json=query().model_dump(), headers={'X-Processor-Key': TOKEN})
    assert response.status_code == 200, response.text[:200]
    data = response.json()
    assert data['pageCount'] == 1 and data['rendererVersion'] == 'aster-email-copy-v1'
    assert 'Reported NAV: EUR 1,200,000' in data['canonicalText']


def test_snapshot_deadline_kills_child_and_never_supplies_settings_or_secrets(monkeypatch):
    import service.app as app_module
    killed = []
    monkeypatch.setenv('SYNTHETIC_PROVIDER_SECRET', 'must-not-reach-renderer')

    class Child:
        pid = 123456789
        returncode = -9
        calls = 0

        def poll(self):
            return None

        def communicate(self, data=None, timeout=None):
            self.calls += 1
            if self.calls == 1:
                payload = json.loads(data)
                assert set(payload) == {'operation', 'query'}
                assert timeout == 20
                raise app_module.subprocess.TimeoutExpired('synthetic-email-copy', 20)
            return b'', b''

    def start(args, **kwargs):
        assert args[-1] == 'service.email_snapshot_worker'
        assert 'SYNTHETIC_PROVIDER_SECRET' not in kwargs['env']
        return Child()

    monkeypatch.setattr(app_module.subprocess, 'Popen', start)
    monkeypatch.setattr(app_module.os, 'killpg', lambda pid, signal: killed.append(pid))
    with TestClient(create_app(Settings(TOKEN))) as client:
        response = client.post('/v1/archive/email-snapshot', json=query().model_dump(), headers={'X-Processor-Key': TOKEN})
    assert response.status_code == 504 and killed == [123456789]
