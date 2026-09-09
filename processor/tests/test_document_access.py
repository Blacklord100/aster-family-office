"""Independent controls for local nested messages and alternate page views."""
import base64
from dataclasses import replace
from email.message import EmailMessage
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock

from PIL import Image
from pypdf import PdfReader
import pytest

from service import documents, pdf_worker
from service.config import Settings
from service.documents import DocumentError, parse_document
from service.page_images import render_source_page


SETTINGS = Settings('synthetic-document-access-test-token', ocr_enabled=False)
FIXTURES = Path(__file__).parent / 'fixtures'


def message(text='Outer archive copy.'):
    result = EmailMessage()
    result['From'] = 'archive@example.invalid'
    result['Subject'] = 'Synthetic local reader control'
    result.set_content(text)
    return result


def decode(email, settings=SETTINGS):
    return parse_document(email.as_bytes(), 'notice.eml', 'message/rfc822', settings)


def nested_chain(depth):
    current = message('Innermost legitimate investor source.')
    for _ in range(depth):
        parent = message()
        parent.add_attachment(current, filename='original.eml')
        current = parent
    return current


def test_nested_message_keeps_separate_bodies_attachment_ancestry_and_page_numbers():
    inner = message('Source email body with a distinct owner.')
    native = (FIXTURES / 'synthetic-native-text.pdf').read_bytes()
    inner.add_attachment(native, maintype='application', subtype='pdf', filename='source.pdf')
    outer = message()
    outer.add_attachment(inner, filename='forwarded.eml')
    outer.add_attachment(b'Separate outer text source.', maintype='text', subtype='plain', filename='outer.txt')
    result = decode(outer)
    assert [p.number for p in result.pages] == [1, 2, 3, 4]
    assert [p.source for p in result.pages] == [
        'email body', 'attachment 1; email body', 'attachment 1; attachment 3; PDF page 1', 'attachment 2']
    assert 'Outer archive' in result.pages[0].text and 'distinct owner' not in result.pages[0].text
    assert 'distinct owner' in result.pages[1].text
    assert '12,450,000.00' in result.pages[2].text
    assert native == (FIXTURES / 'synthetic-native-text.pdf').read_bytes()


def test_nested_depth_is_bounded_across_the_entire_tree():
    assert len(decode(nested_chain(3)).pages) == 4
    with pytest.raises(DocumentError, match='Nested EML depth'):
        decode(nested_chain(4))
    with pytest.raises(DocumentError, match='Nested EML depth'):
        decode(nested_chain(1), replace(SETTINGS, max_nested_eml_depth=0))


def test_nested_mime_parts_and_attachment_counts_share_outer_limits():
    assert len(decode(message(), replace(SETTINGS, max_email_parts=1)).pages) == 1
    inner = message('Child source.')
    inner.add_attachment(b'Child attachment.', maintype='text', subtype='plain', filename='child.txt')
    outer = message()
    outer.add_attachment(inner, filename='source.eml')
    with pytest.raises(DocumentError, match='MIME part limit'):
        decode(outer, replace(SETTINGS, max_email_parts=5))
    with pytest.raises(DocumentError, match='Attachment count'):
        decode(outer, replace(SETTINGS, max_email_attachments=1))


def test_mime_part_budget_applies_during_parsing_before_tree_walk(monkeypatch):
    outer = message()
    for number in range(20):
        outer.add_attachment(b'Ignored inert text.', maintype='text', subtype='plain', filename=f'{number}.txt')
    constructed = []
    real_message = documents.EmailMessage

    def counted_message(*args, **kwargs):
        constructed.append(True)
        return real_message(*args, **kwargs)

    monkeypatch.setattr(documents, 'EmailMessage', counted_message)
    with pytest.raises(DocumentError, match='MIME part limit'):
        decode(outer, replace(SETTINGS, max_email_parts=5))
    assert len(constructed) == 5


def test_nested_pages_and_visible_text_share_outer_limits():
    outer = nested_chain(1)
    with pytest.raises(DocumentError, match='Combined page limit'):
        decode(outer, replace(SETTINGS, max_pages=1))
    with pytest.raises(DocumentError, match='text limit'):
        decode(outer, replace(SETTINGS, max_text_chars=45))


def test_nested_octet_stream_eml_is_decoded_without_saving_document_filename():
    outer = message()
    outer.add_attachment(message('A legitimate nested source.').as_bytes(), maintype='application',
                         subtype='octet-stream', filename='../../source.eml')
    result = decode(outer)
    assert result.pages[1].text.strip() == 'A legitimate nested source.'
    assert result.pages[1].source == 'attachment 1; email body'
    assert '../../' not in result.pages[1].source


def test_nested_decoded_bytes_do_not_reset_upload_budget():
    outer = message()
    outer.add_attachment(message('b' * 4000).as_bytes(), maintype='application', subtype='octet-stream', filename='source.eml')
    data = outer.as_bytes()
    # Nested MIME bytes and their decoded payload both spend the same budget.
    with pytest.raises(DocumentError, match='Decoded attachment size'):
        parse_document(data, 'notice.eml', 'message/rfc822', replace(SETTINGS, max_file_bytes=len(data)))


def test_encoded_message_rfc822_handles_legacy_base64_and_rejects_garbage():
    child = message('Legacy encoded source.').as_bytes()
    raw = (b'From: archive@example.invalid\nSubject: Synthetic encoding\nMIME-Version: 1.0\n'
           b'Content-Type: message/rfc822\nContent-Transfer-Encoding: base64\n\n')
    result = parse_document(raw + base64.b64encode(child), 'source.eml', 'message/rfc822', SETTINGS)
    assert result.pages[1].text.strip() == 'Legacy encoded source.'
    with pytest.raises(DocumentError, match='Invalid encoded nested EML'):
        parse_document(raw + b'$$$invalid', 'source.eml', 'message/rfc822', SETTINGS)


def test_nested_active_payload_is_skipped_and_binary_disguised_as_eml_is_rejected():
    child = message('Ordinary source text.')
    child.add_attachment(b'MZ executable payload', maintype='application', subtype='octet-stream', filename='run.exe')
    outer = message()
    outer.add_attachment(child, filename='source.eml')
    result = decode(outer)
    assert len(result.pages) == 2 and any('nothing executed' in warning for warning in result.warnings)
    child = message()
    child.add_attachment(b'MZ executable payload', maintype='application', subtype='octet-stream', filename='run.eml')
    with pytest.raises(DocumentError, match='Invalid EML header'):
        decode(child)


def test_deep_multipart_structure_is_rejected_without_recursive_walk():
    current = message()
    for _ in range(14):
        parent = EmailMessage()
        parent.make_mixed()
        parent.attach(current)
        current = parent
    current['From'] = 'archive@example.invalid'
    with pytest.raises(DocumentError, match='MIME nesting'):
        decode(current)


def test_document_deadline_is_shared_instead_of_reset_per_attachment(monkeypatch):
    tick = iter([0, 76])
    monkeypatch.setattr(documents.time, 'monotonic', lambda: next(tick))
    with pytest.raises(DocumentError, match='decoding time'):
        decode(message())


def test_layout_preserves_original_evidence_and_actual_scan_png_is_bounded():
    native = FIXTURES / 'synthetic-native-text.pdf'
    result = parse_document(native.read_bytes(), native.name, 'application/pdf', SETTINGS)
    assert result.pages[0].text == PdfReader(native, strict=True).pages[0].extract_text()
    assert result.pages[0].layout_text and '12,450,000.00' in result.pages[0].layout_text
    scan = FIXTURES / 'synthetic-scan.pdf'
    result = parse_document(scan.read_bytes(), scan.name, 'application/pdf', SETTINGS)
    png = base64.b64decode(result.pages[0].image_png_base64, validate=True)
    assert png == render_source_page(scan, 0, SETTINGS.max_visual_bytes)
    assert result.pages[0].text == '' and result.pages[0].layout_text is None
    with Image.open(BytesIO(png)) as image:
        assert image.format == 'PNG' and max(image.size) <= 2000
        assert image.width * image.height <= 4_000_000
    assert len(png) <= 4 * 1024 * 1024


def test_visual_page_and_byte_budgets_are_shared_across_nested_attachments():
    data = (FIXTURES / 'synthetic-scan.pdf').read_bytes()
    inner = message()
    inner.add_attachment(data, maintype='application', subtype='pdf', filename='inner.pdf')
    outer = message()
    outer.add_attachment(data, maintype='application', subtype='pdf', filename='outer.pdf')
    outer.add_attachment(inner, filename='source.eml')
    result = decode(outer, replace(SETTINGS, max_visual_pages=1))
    assert sum(p.image_png_base64 is not None for p in result.pages) == 1
    assert result.pages[1].image_png_base64 and result.pages[-1].image_png_base64 is None
    assert any('attachment 2; attachment 3' in warning and 'visual page/byte budget' in warning for warning in result.warnings)
    result = decode(outer, replace(SETTINGS, max_visual_bytes=100))
    assert not any(p.image_png_base64 for p in result.pages)
    assert any('rendering failed or exceeded bounds' in warning for warning in result.warnings)


def test_visual_disabled_never_calls_renderer_and_layout_budget_is_independent(monkeypatch):
    renderer = Mock(side_effect=AssertionError('Disabled vision must not render'))
    monkeypatch.setattr(pdf_worker, 'render_source_page', renderer)
    result = pdf_worker.extract_pdf(str(FIXTURES / 'synthetic-scan.pdf'), 40, 120000, 0, False, visual_limit=0)
    assert result['page_images'] == {}
    renderer.assert_not_called()
    result = pdf_worker.extract_pdf(str(FIXTURES / 'synthetic-native-text.pdf'), 40, 120000, 0, False, layout_chars_limit=1)
    assert result['layout_pages'] == [None] and result['layout_chars'] == 0
    assert '12,450,000.00' in result['pages'][0]
    assert any('layout text exceeded' in warning for warning in result['warnings'])


def test_render_attempt_spends_budget_even_when_it_fails(monkeypatch):
    renderer = Mock(side_effect=ValueError('Synthetic bounded render failure'))
    monkeypatch.setattr(pdf_worker, 'render_source_page', renderer)
    result = pdf_worker.extract_pdf(str(FIXTURES / 'synthetic-scan.pdf'), 40, 120000, 0, False, visual_limit=1)
    assert result['visual_pages'] == 1 and result['visual_bytes'] == 0 and result['page_images'] == {}
    renderer.assert_called_once()


@pytest.mark.parametrize('index,limit', [(-1, 1000), (40, 1000), (0, 0), (0, 16 * 1024 * 1024 + 1)])
def test_source_renderer_rejects_invalid_indices_and_budgets(index, limit):
    with pytest.raises(ValueError, match='bounds'):
        render_source_page(FIXTURES / 'synthetic-scan.pdf', index, limit)
