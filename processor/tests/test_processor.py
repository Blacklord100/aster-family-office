from dataclasses import replace
from email.message import EmailMessage
from io import BytesIO
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from service.app import create_app
from service.classifier import RelevanceClassifier
from service.config import Settings
from service.documents import Document, DocumentError, Page, parse_document
from service.grounding import deterministic_facts, verify_fact
from service.pipeline import process
from service.schema import Fact, Extraction
from tests.fake_ollama import fake_ollama

TOKEN = 'synthetic-test-secret-at-least-24'
NOTICE = (Path(__file__).parent.parent / 'corpus' / 'sample-capital-call.txt').read_text().strip()
DOC = Document([Page(1, NOTICE, 'document')], [])


@pytest.fixture(scope='session')
def classifier():
    return RelevanceClassifier()


def candidate(**updates):
    data = {'kind': 'capital_call', 'investmentName': 'Cedar Partners IV', 'effectiveDate': '2026-08-31',
            'amount': '420000.00', 'currency': 'EUR', 'dueDate': '2026-09-30',
            'summary': 'Must be replaced by verified source excerpt', 'evidence': {'page': 1, 'quote': NOTICE}}
    data.update(updates)
    return data


def test_workflow_is_deterministic_and_decimal(classifier):
    result = process(DOC, 'doc-1', 'workflow', Settings(TOKEN), classifier)
    assert result.facts[0].amount == '420000.00'
    assert result.model is None
    assert result.documentType == 'capital_call'
    assert result.facts[0].summary.startswith('Synthetic capital call')
    assert Extraction.model_validate_json(result.model_dump_json()) == result


@pytest.mark.parametrize('updates,reason', [
    ({'amount': '999999'}, 'amount_currency_not_in_quote'),
    ({'currency': 'USD'}, 'amount_currency_not_in_quote'),
    ({'investmentName': 'Invented Capital'}, 'investment_not_in_quote'),
    ({'effectiveDate': '2026-09-30'}, 'effectiveDate_contradicts_label'),
    ({'dueDate': '2026-08-31'}, 'dueDate_contradicts_label'),
    ({'kind': 'distribution'}, 'event_kind_not_supported'),
    ({'evidence': {'page': 2, 'quote': NOTICE}}, 'quote_not_in_page'),
    ({'evidence': {'page': 1, 'quote': 'Cedar Partners IV has invented valuation EUR 999.00'}}, 'quote_not_in_page'),
])
def test_reject_ungrounded_facts(updates, reason):
    assert verify_fact(Fact(**candidate(**updates)), DOC.pages) == (None, reason)


@pytest.mark.parametrize('amount', [420000.0, 'NaN', '1e5', '1,000', 'Infinity'])
def test_money_schema_rejects_unsafe_values(amount):
    with pytest.raises(ValueError):
        Fact(**candidate(amount=amount))


def test_locale_ambiguous_money_does_not_partially_match():
    notice = NOTICE.replace('EUR 420,000.00', 'EUR 420.000,00')
    pages = [Page(1, notice, 'document')]
    facts = deterministic_facts(pages)
    assert facts[0].amount is None and facts[0].currency is None
    fact = Fact(**candidate(amount='420.000', evidence={'page': 1, 'quote': notice}))
    assert verify_fact(fact, pages)[0] is None


def test_agentic_uses_bounded_local_contract(classifier, monkeypatch):
    monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:1')
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:1')
    replies = [{'action': 'read_page', 'page': 1}, {'action': 'extract', 'page': 1},
               {'facts': [candidate()]}, {'action': 'finish', 'page': None}]
    with fake_ollama(replies) as (url, requests):
        result = process(DOC, 'agent-doc', 'agentic', Settings(TOKEN, ollama_base_url=url), classifier)
    assert len(result.facts) == 1
    assert len(requests) == 5
    assert all(r['think'] is False and r['stream'] is False and isinstance(r['format'], dict)
               for path, r in requests if path == '/api/chat')
    assert all('tools' not in r for _, r in requests)
    assert result.mode == 'agentic' and result.execution == 'local'


def test_workflow_fallback_and_agentic_share_schema(classifier):
    prose = 'Cedar Partners IV capital call dated 2026-08-31 is EUR 420,000.00 due 2026-09-30.'
    doc = Document([Page(1, prose, 'document')], [])
    fact = candidate(evidence={'page': 1, 'quote': prose})
    with fake_ollama([{'facts': [fact]}]) as (url, _):
        result = process(doc, 'fallback', 'workflow', Settings(TOKEN, ollama_base_url=url), classifier)
    assert result.facts[0].amount == '420000.00'
    assert set(result.model_dump()) == {'schemaVersion', 'documentId', 'mode', 'execution', 'documentType',
                                        'relevant', 'confidence', 'facts', 'warnings', 'trace', 'model'}


@pytest.mark.parametrize('response', ['not json', {'facts': [candidate(amount='666.00')]}, {'facts': [], 'unexpected': 1}])
def test_model_response_fails_closed(classifier, response):
    replies = [{'action': 'read_page', 'page': 1}, {'action': 'extract', 'page': 1}, response,
               {'action': 'finish', 'page': None}]
    with fake_ollama(replies) as (url, _):
        result = process(DOC, 'invalid', 'agentic', Settings(TOKEN, ollama_base_url=url), classifier)
    assert not result.facts
    assert any('rejected' in warning or 'failed closed' in warning for warning in result.warnings)


def test_agent_step_limit(classifier):
    with fake_ollama([{'action': 'read_page', 'page': 1}]) as (url, requests):
        result = process(DOC, 'bounded', 'agentic', Settings(TOKEN, ollama_base_url=url, max_agent_steps=1), classifier)
    assert len(requests) == 2 and not result.facts
    assert any('step limit' in warning for warning in result.warnings)


@pytest.mark.parametrize('args', [{'ollama_model': 'qwen:cloud'}, {'ollama_base_url': 'https://evil.example'},
                                {'ollama_base_url': 'http://127.0.0.1:11434/path'}, {'ollama_base_url': 'http://user:pass@localhost'}])
def test_reject_cloud_or_arbitrary_endpoint(args):
    with pytest.raises(ValueError):
        Settings(TOKEN, **args)


@pytest.mark.parametrize('remote,redirect', [(True, False), (False, True)])
def test_remote_models_and_redirects_fail_closed(classifier, remote, redirect):
    with fake_ollama([], remote=remote, redirect=redirect) as (url, requests):
        result = process(DOC, 'remote', 'agentic', Settings(TOKEN, ollama_base_url=url), classifier)
    assert not result.facts and len(requests) == 1
    assert result.trace[-1].status == 'error'


def test_http_auth_contract_and_invalid_upload():
    with TestClient(create_app(Settings(TOKEN))) as client:
        assert client.get('/healthz').json() == {'status': 'ok'}
        assert client.post('/v1/extract', content=b'not parsed').status_code == 401
        response = client.post('/v1/extract', headers={'X-Processor-Key': TOKEN},
                               data={'mode': 'workflow', 'document_id': 'http-test'},
                               files={'file': ('notice.txt', NOTICE.encode(), 'text/plain')})
        assert response.status_code == 200, response.text
        assert response.json()['facts'][0]['amount'] == '420000.00'
        response = client.post('/v1/extract', headers={'X-Processor-Key': TOKEN},
                               data={'mode': 'workflow', 'document_id': 'http-test'},
                               files={'file': ('bad.pdf', b'Not a PDF', 'application/pdf')})
        assert response.status_code == 422


def test_mime_binary_and_size_limits():
    for data, name, mime in [(b'MZbinary', 'bad.exe', 'text/plain'), (b'\x00binary', 'bad.txt', 'text/plain'),
                             (b'%PDF-invalid', 'bad.txt', 'application/pdf'),
                             (b'%PDF-1.7 hidden PDF', 'bad.txt', 'text/plain')]:
        with pytest.raises(DocumentError):
            parse_document(data, name, mime, Settings(TOKEN))
    with pytest.raises(DocumentError):
        parse_document(b'12345', 'test.txt', 'text/plain', replace(Settings(TOKEN), max_file_bytes=4))


def test_eml_supported_attachment_and_skip_active_payload():
    message = EmailMessage()
    message['From'] = 'synthetic@example.invalid'
    message['Subject'] = 'Synthetic investor notice'
    message.set_content('Please see the attached statement.')
    message.add_attachment(NOTICE.encode(), maintype='text', subtype='plain', filename='notice.txt')
    message.add_attachment(b'MZuntrusted', maintype='application', subtype='octet-stream', filename='bad.exe')
    document = parse_document(message.as_bytes(), 'sample.eml', 'message/rfc822', Settings(TOKEN))
    assert len(document.pages) == 2 and document.pages[1].number == 2
    assert len(deterministic_facts(document.pages)) == 1
    assert any('skipped' in warning for warning in document.warnings)


def pdf_bytes(encrypt=False, active=False):
    writer = PdfWriter()
    writer.add_blank_page(200, 200)
    if encrypt:
        writer.encrypt('secret')
    if active:
        writer._root_object[NameObject('/OpenAction')] = DictionaryObject()
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def test_pdf_blank_and_encrypted_and_active():
    document = parse_document(pdf_bytes(), 'blank.pdf', 'application/pdf', Settings(TOKEN))
    assert not document.pages[0].text and document.warnings
    for blob in [pdf_bytes(encrypt=True), pdf_bytes(active=True)]:
        with pytest.raises(DocumentError):
            parse_document(blob, 'unsafe.pdf', 'application/pdf', Settings(TOKEN))


def test_pdf_native_text_extraction():
    writer = PdfWriter()
    page = writer.add_blank_page(600, 800)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 50 750 Td (Synthetic valuation report) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    out = BytesIO()
    writer.write(out)
    document = parse_document(out.getvalue(), 'native.pdf', 'application/pdf', Settings(TOKEN))
    assert 'Synthetic valuation report' in document.pages[0].text


def test_classifier_holdout_not_training(classifier):
    base = Path(__file__).parent.parent / 'corpus'
    train = json.loads((base / 'train.json').read_text())
    heldout = json.loads((base / 'holdout.json').read_text())
    assert not {row['text'] for row in train} & {row['text'] for row in heldout}
    accuracy = sum(classifier.predict(row['text'])[0] == row['relevant'] for row in heldout) / len(heldout)
    assert accuracy >= 0.75


def test_eml_attachment_limit():
    message = EmailMessage()
    message['From'] = 'synthetic@example.invalid'
    message.set_content('Synthetic statement attachments')
    for number in range(9):
        message.add_attachment(b'synthetic text', maintype='text', subtype='plain', filename=f'{number}.txt')
    with pytest.raises(DocumentError, match='Attachment count'):
        parse_document(message.as_bytes(), 'many.eml', 'message/rfc822', Settings(TOKEN))


def test_http_body_limit():
    with TestClient(create_app(replace(Settings(TOKEN), max_file_bytes=4))) as client:
        response = client.post('/v1/extract', headers={'X-Processor-Key': TOKEN}, content=b'x' * (128 * 1024 + 5))
        assert response.status_code == 413


def test_hard_deadline_kills_process_group(monkeypatch):
    import service.app as app_module
    killed = []
    class TimedOutChild:
        pid = 123456789
        returncode = -9
        calls = 0

        def poll(self):
            return None

        def communicate(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                assert kwargs['timeout'] == 590
                raise app_module.subprocess.TimeoutExpired('synthetic-worker', 590)
            return b'', b''
    monkeypatch.setattr(app_module.subprocess, 'Popen', lambda *args, **kwargs: TimedOutChild())
    monkeypatch.setattr(app_module.os, 'killpg', lambda pid, signal: killed.append(pid))
    with TestClient(create_app(Settings(TOKEN))) as client:
        response = client.post('/v1/extract', headers={'X-Processor-Key': TOKEN},
                               data={'mode': 'workflow', 'document_id': 'deadline'},
                               files={'file': ('notice.txt', NOTICE.encode(), 'text/plain')})
    assert response.status_code == 504 and killed == [123456789]


def test_agent_cannot_request_arbitrary_tool(classifier):
    with fake_ollama([{'action': 'run_shell', 'page': None}]) as (url, requests):
        output = process(DOC, 'no-shell', 'agentic', Settings(TOKEN, ollama_base_url=url), classifier)
    assert not output.facts and len(requests) == 2
    assert any('model_schema_invalid' in w for w in output.warnings)


def test_disconnect_kills_child_and_cleans_parent_tmp(monkeypatch):
    import threading
    import service.app as app_module
    released = threading.Event()
    killed, temp_paths = [], []
    class WaitingChild:
        pid = 123456790
        returncode = None
        def poll(self):
            return self.returncode
        def communicate(self, *args, **kwargs):
            assert released.wait(timeout=5)
            return b'', b''
    child = WaitingChild()
    def start(*args, **kwargs):
        temp_paths.append(Path(kwargs['env']['TMPDIR']))
        (temp_paths[0] / 'synthetic-private-temp.txt').write_text('synthetic only')
        return child
    def kill(pid, signal):
        killed.append(pid)
        child.returncode = -9
        released.set()
    async def disconnected(self):
        return True
    monkeypatch.setattr(app_module.subprocess, 'Popen', start)
    monkeypatch.setattr(app_module.os, 'killpg', kill)
    monkeypatch.setattr(app_module.Request, 'is_disconnected', disconnected)
    with TestClient(create_app(Settings(TOKEN))) as client:
        response = client.post('/v1/extract', headers={'X-Processor-Key': TOKEN},
                               data={'mode': 'workflow', 'document_id': 'disconnect'},
                               files={'file': ('notice.txt', NOTICE.encode(), 'text/plain')})
    assert response.status_code == 499
    assert killed == [123456790] and not temp_paths[0].exists()


@pytest.mark.parametrize('token', ['REPLACE_WITH_AT_LEAST_24_RANDOM_CHARACTERS', 'CHANGE_ME_TO_A_RANDOM_SECRET_KEY', 'CHANGEME_TO_A_LONG_RANDOM_SECRET', 'TODO_SET_A_RANDOM_SECRET_HERE'])
def test_placeholder_processor_tokens_fail_startup(token):
    with pytest.raises(ValueError, match='placeholder'):
        Settings(token)
