import pytest

from service.classifier import RelevanceClassifier
from service.config import Settings
from service.documents import Document, Page
from service.pipeline import process
from tests.fake_ollama import fake_ollama


TABLE = ('Distribution advice\nInvestment\nDistribution date\nCurrency\nCash distribution\n'
         'Oakhaven Credit Partners\n14 August 2026\nEUR\n62,410.20\n')


def run_table(text, mode):
    replies = [{'facts': []}]
    if mode == 'agentic':
        replies = [{'action': 'read_page', 'page': 1}, {'action': 'extract', 'page': 1},
                   {'facts': []}, {'action': 'finish', 'page': None}]
    with fake_ollama(replies) as (url, _):
        return process(Document([Page(1, text, 'synthetic table')], []), 'table-warning', mode,
                       Settings('synthetic-table-warning-token-only', ollama_base_url=url),
                       RelevanceClassifier())


@pytest.mark.parametrize('mode', ['workflow', 'agentic'])
def test_unvalidated_table_rows_remain_visible_in_both_modes(mode):
    output = run_table(TABLE.replace('62,410.20', '62,4x0.20'), mode)
    assert not output.facts
    assert any(warning.startswith('Page 1:') and 'table' in warning.casefold()
               for warning in output.warnings)
    assert any(item.stage == 'table_coverage' and item.status == 'warning'
               for item in output.trace)


@pytest.mark.parametrize('mode', ['workflow', 'agentic'])
def test_complete_table_rows_do_not_receive_an_unreadable_warning(mode):
    output = run_table(TABLE, mode)
    assert len(output.facts) == 1
    assert output.facts[0].investmentName == 'Oakhaven Credit Partners'
    assert output.facts[0].amount == '62410.20'
    assert output.facts[0].effectiveDate == '2026-08-14'
    assert not any(item.stage == 'table_coverage' and item.status == 'warning'
                   for item in output.trace)
