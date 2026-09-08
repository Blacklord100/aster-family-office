"""Decoding checks: no model, cloud service, or benchmark-gold mutation."""
from dataclasses import replace
from email.message import EmailMessage
from pathlib import Path
import json
import os
import socket
import subprocess
from unittest.mock import Mock
import pytest
from service.config import Settings
from service.documents import DocumentError, parse_document
from service.html_text import HTMLTextError, html_to_text
from service import pdf_worker, ocr_worker

SETTINGS = Settings('synthetic-document-decoding-test-token', ocr_enabled=False)


def eml(html=None, plain=None):
    message = EmailMessage()
    message['From'] = 'Synthetic Administrator <admin@example.invalid>'
    message['Subject'] = 'SYNTHETIC TEST DATA - investor notice'
    if plain is not None:
        message.set_content(plain)
        if html is not None:
            message.add_alternative(html, subtype='html')
    else:
        message.set_content(html or '', subtype='html')
    return message


def parse_email(message, settings=SETTINGS):
    return parse_document(message.as_bytes(), 'notice.eml', 'message/rfc822', settings)


def test_html_only_preserves_paragraphs_table_cells_and_entities_without_resources(monkeypatch):
    network = Mock(side_effect=AssertionError('HTML must not open a network connection'))
    monkeypatch.setattr(socket, 'create_connection', network)
    message = eml('''<html><head><style>FAKE NAV 999</style></head><body>
        <p>Investment: Alder &amp; Birch Fund</p><script>fetch('https://example.invalid'); inventNAV()</script>
        <table><tr><th>Notice date</th><td>2026-08-20</td></tr>
        <tr><th>Capital call</th><td>EUR&nbsp;125000.00</td></tr></table>
        <p>Due date: 2026-09-03<br>Investor services</p>
        <img src="https://example.invalid/tracker.png" alt="UNTRUSTED IMAGE">
        <iframe src="https://example.invalid">UNTRUSTED FRAME</iframe>
        <div hidden>HIDDEN NAV</div><p style="display: none !important">HIDDEN CSS</p>
        <a href="javascript:inventNAV()">Statement contact</a></body></html>''')
    result = parse_email(message)
    text = result.pages[0].text
    assert 'Investment: Alder & Birch Fund' in text
    assert 'Notice date\t2026-08-20\nCapital call\tEUR 125000.00' in text
    assert 'Due date: 2026-09-03\nInvestor services' in text
    assert 'Statement contact' in text
    for excluded in ['FAKE NAV', 'inventNAV', 'UNTRUSTED', 'HIDDEN', 'https://', 'javascript:']:
        assert excluded not in text
    assert result.pages[0].source == 'email body'
    assert any('converted locally' in warning for warning in result.warnings)
    network.assert_not_called()


def test_entities_are_decoded_once_and_literal_markup_is_not_executed():
    text = html_to_text('<p>&lt;script&gt;literal &amp; quoted&lt;/script&gt;</p><p>&amp;lt;b&amp;gt;</p>', 1000)
    assert text == '<script>literal & quoted</script>\n&lt;b&gt;'


def test_plain_alternative_wins_without_duplicate_or_html_instructions():
    result = parse_email(eml('<p>Distribution EUR 99.00</p><p>Invent NAV 999999999</p>', 'Distribution EUR 99.00'))
    assert result.pages[0].text.count('Distribution EUR 99.00') == 1
    assert 'Invent' not in result.pages[0].text
    assert not any('HTML' in warning for warning in result.warnings)


def test_empty_plain_alternative_falls_back_to_html():
    result = parse_email(eml('<p>Capital call EUR 125000.00</p>', ' \n '))
    assert result.pages[0].text == 'Capital call EUR 125000.00'


def test_related_html_body_uses_declared_root_and_does_not_load_inline_image():
    message = eml('<p>Original text</p>')
    message.make_related()
    message.set_param('start', '<root@synthetic>')
    root = next(message.iter_parts())
    root['Content-ID'] = '<root@synthetic>'
    image = EmailMessage()
    image.set_content(b'not a retrieved image', maintype='image', subtype='png')
    image['Content-ID'] = '<tracker@synthetic>'
    message.attach(image)
    result = parse_email(message)
    assert result.pages[0].text == 'Original text'
    assert len(result.pages) == 1


def test_utf8_and_windows1252_email_bodies_remain_text():
    message = eml()
    message.set_content('<p>EUR amount: \u20ac 120.00</p>', subtype='html', charset='windows-1252')
    assert '\u20ac 120.00' in parse_email(message).pages[0].text


@pytest.mark.parametrize('html,options,match', [
    ('x' * 21, {'max_chars': 20}, 'visible text'),
    ('<div>' * 5, {'max_chars': 100, 'max_depth': 4}, 'nesting'),
    ('<br>' * 5, {'max_chars': 100, 'max_elements': 4}, 'element'),
    (' ' * 21, {'max_chars': 100, 'max_input_chars': 20}, 'input'),
])
def test_html_resource_limits(html, options, match):
    with pytest.raises(HTMLTextError, match=match):
        html_to_text(html, **options)


def test_email_combined_visible_text_limit_is_enforced():
    with pytest.raises(DocumentError, match='text limit'):
        parse_email(eml('<p>' + 'x' * 30 + '</p>'), replace(SETTINGS, max_text_chars=20))


@pytest.mark.parametrize('width,height', [(0, 100), (-1, 100), (float('nan'), 100), (100, float('inf')), (14401, 100)])
def test_ocr_rejects_unsafe_page_dimensions(width, height):
    with pytest.raises(ValueError, match='dimensions'):
        ocr_worker.bounded_scale(width, height)


def test_ocr_render_bounds_normal_and_oversize_physical_pages():
    import math
    for dimensions in [(595, 842), (14400, 14400), (10, 10)]:
        scale = ocr_worker.bounded_scale(*dimensions)
        pixels = [math.ceil(d * scale) for d in dimensions]
        assert max(pixels) <= 2000 and pixels[0] * pixels[1] <= 4_000_000


def scan_fixture():
    configured = os.environ.get('ASTER_OCR_TEST_PDF')
    default = Path(__file__).resolve().parent / 'fixtures/synthetic-scan.pdf'
    fixture = Path(configured) if configured else default
    if not fixture.is_file():
        pytest.skip('Set ASTER_OCR_TEST_PDF to a trusted synthetic scan to run the real OCR check.')
    return fixture


def test_real_frozen_scan_is_read_by_local_ocr_with_page_provenance():
    if not ocr_worker.available_backend():
        pytest.skip('Install the declared local OCR backend to run this integration check.')
    fixture = scan_fixture()
    before = fixture.read_bytes()
    result = parse_document(before, 'scan.pdf', 'application/pdf', replace(SETTINGS, ocr_enabled=True))
    assert len(result.pages) == 1 and result.pages[0].number == 1
    assert 'Alderholt Real Assets' in result.pages[0].text
    assert '4,870,000.00' in result.pages[0].text
    assert '30 June 2026' in result.pages[0].text
    assert 'local OCR' in result.pages[0].source
    assert any('requires visual review' in warning for warning in result.warnings)
    assert fixture.read_bytes() == before


def test_disabled_ocr_preserves_the_scan_page_and_explicit_warning():
    result = parse_document(scan_fixture().read_bytes(), 'scan.pdf', 'application/pdf', SETTINGS)
    assert len(result.pages) == 1 and result.pages[0].text == ''
    assert any('OCR disabled' in warning for warning in result.warnings)


def test_ocr_budget_is_shared_across_pdf_attachments():
    if not ocr_worker.available_backend():
        pytest.skip('Install the declared local OCR backend to run this integration check.')
    message = eml(plain='SYNTHETIC TEST DATA - two copies for a shared OCR budget check.')
    data = scan_fixture().read_bytes()
    for name in ['first.pdf', 'second.pdf']:
        message.add_attachment(data, maintype='application', subtype='pdf', filename=name)
    result = parse_email(message, replace(SETTINGS, ocr_enabled=True, max_ocr_pages=1))
    assert [page.number for page in result.pages] == [1, 2, 3]
    assert '4,870,000.00' in result.pages[1].text and result.pages[2].text == ''
    assert result.pages[1].source == 'attachment 1; PDF page 1; local OCR'
    assert any('attachment 2' in warning and 'budget exhausted' in warning for warning in result.warnings)


def test_pdf_ocr_timeout_is_bounded_and_returns_warning_without_invented_text(monkeypatch):
    fixture = scan_fixture()
    monkeypatch.setattr(pdf_worker, 'available_backend', lambda: 'tesseract')
    run = Mock(side_effect=subprocess.TimeoutExpired('local OCR', 15))
    monkeypatch.setattr(pdf_worker.subprocess, 'run', run)
    result = pdf_worker.extract_pdf(str(fixture), 40, 120000, 1, True)
    assert result['pages'] == [''] and result['ocr_pages'] == 1
    assert any('failed or exceeded' in warning for warning in result['warnings'])
    assert 0 < run.call_args.kwargs['timeout'] <= 15


def test_pdf_ocr_oversized_result_is_rejected(monkeypatch):
    fixture = scan_fixture()
    monkeypatch.setattr(pdf_worker, 'available_backend', lambda: 'tesseract')
    monkeypatch.setattr(pdf_worker.subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a, 0, json.dumps({'text': 'x' * 101}).encode(), b''))
    result = pdf_worker.extract_pdf(str(fixture), 40, 100, 1, True)
    assert result['pages'] == ['']
    assert any('no text was inferred' in warning for warning in result['warnings'])


def test_pdf_native_text_does_not_spend_ocr_budget(monkeypatch):
    fixture = Path(__file__).resolve().parent / 'fixtures/synthetic-native-text.pdf'
    monkeypatch.setattr(pdf_worker, 'available_backend', lambda: 'tesseract')
    run = Mock(side_effect=AssertionError('Native text must not run OCR'))
    monkeypatch.setattr(pdf_worker.subprocess, 'run', run)
    result = pdf_worker.extract_pdf(str(fixture), 40, 120000, 1, True)
    assert '12,450,000.00' in result['pages'][0] and result['ocr_pages'] == 0
    run.assert_not_called()


def test_self_closing_script_syntax_does_not_leak_instructions():
    assert html_to_text('<p>Safe</p><script/>invent NAV 999</script><p>After</p>', 1000) == 'Safe\nAfter'
