"""Source-only ownership and role guards added after the Gemma development run.

These use independent wording/figures, not benchmark gold or a model fallback.
"""
import pytest
from service.documents import Page
from service.grounding import deterministic_facts, verify_fact
from service.schema import Fact
from service.source_events import name_mentions, source_events


def pages(text):
    return [Page(1, text, 'synthetic ownership regression')]


def facts(text):
    return deterministic_facts(pages(text))


@pytest.mark.parametrize('event,kind', [
    ('capital call', 'capital_call'), ('drawdown', 'capital_call'),
    ('distribution', 'distribution'),
])
def test_event_first_names_are_literal_and_keep_amount_roles(event, kind):
    text = (f'The {event} for Willowmere Growth IV is EUR 44,318.72 effective 6 August 2026.\n'
            'Your commitment is EUR 930,000.00. Manager-wide assets under management are EUR 90,000,000.00.')
    fs = facts(text)
    assert len(fs) == 1
    assert (fs[0].kind, fs[0].investmentName, fs[0].effectiveDate, fs[0].amount) == (
        kind, 'Willowmere Growth IV', '2026-08-06', '44318.72')
    assert fs[0].evidence.quote in text
    assert verify_fact(fs[0].model_copy(update={'amount': '930000.00'}), pages(text))[0] is None


@pytest.mark.parametrize('verb', ['reports a distribution', 'reports the distribution', 'report a distribution'])
def test_reported_distribution_preserves_native_currency_and_effective_date(verb):
    text = (f'Willowmere Growth IV {verb} of CHF 19,482.17 effective 4 August 2026.\n'
            'Funds were received on 7 August 2026. The income and return-of-capital split is unknown.')
    fs = facts(text)
    assert len(fs) == 1
    assert (fs[0].kind, fs[0].currency, fs[0].amount, fs[0].effectiveDate, fs[0].dueDate) == (
        'distribution', 'CHF', '19482.17', '2026-08-04', None)
    assert verify_fact(fs[0].model_copy(update={'effectiveDate': '2026-08-07'}), pages(text))[0] is None


def test_two_event_first_calls_keep_each_owners_effective_date_and_deadline():
    text = ('Administrator letter issued 10 August 2026.\n'
            'The capital call for Willowmere Growth IV is EUR 44,318.72 effective 6 August 2026.\n'
            'Payment must reach our account by 21 August 2026.\n'
            'The capital call for Ashcombe Credit II is GBP 28,609.34 effective 8 August 2026.\n'
            'Payment must reach our account by 25 August 2026.')
    fs = facts(text)
    assert {(f.investmentName, f.currency, f.amount, f.effectiveDate, f.dueDate) for f in fs} == {
        ('Willowmere Growth IV', 'EUR', '44318.72', '2026-08-06', '2026-08-21'),
        ('Ashcombe Credit II', 'GBP', '28609.34', '2026-08-08', '2026-08-25'),
    }
    first = next(f for f in fs if f.investmentName == 'Willowmere Growth IV')
    for updates in ({'dueDate': '2026-08-25'}, {'effectiveDate': '2026-08-10'},
                    {'investmentName': 'Ashcombe Credit II'}, {'amount': '28609.34', 'currency': 'GBP'}):
        assert verify_fact(first.model_copy(update=updates), pages(text))[0] is None


def test_ambiguous_dollar_in_reported_distribution_stays_unknown():
    text = ('Ashcombe Credit II reports a distribution of EUR 28,609.34 effective 8 August 2026.\n'
            'Willowmere Growth IV reports a distribution of $19,482.17 effective 4 August 2026.\n'
            'The dollar currency is not identified.')
    fs = facts(text)
    candidate = next(f for f in fs if f.investmentName == 'Willowmere Growth IV')
    assert candidate.currency is None and candidate.amount == '19482.17'
    for currency in ('USD', 'EUR', 'CAD'):
        assert verify_fact(candidate.model_copy(update={'currency': currency}), pages(text))[0] is None


@pytest.mark.parametrize('layout', [': investor NAV', ': NAV', ': net asset value', ': valuation'])
def test_colon_nav_is_owned_by_the_fund_not_later_underlying_company(layout):
    text = (f'Willowmere Growth IV{layout} as of 31 July 2026 is EUR 3,615,709.28.\n'
            'Underlying issuer\nLarchwick Sensor Systems Ltd\n36.0%\n'
            'Another company has an undisclosed weight. The remaining allocation is unknown.')
    fs = facts(text)
    assert [(f.investmentName, f.amount) for f in fs] == [('Willowmere Growth IV', '3615709.28')]
    assert verify_fact(fs[0].model_copy(update={'investmentName': 'Larchwick Sensor Systems Ltd'}), pages(text))[0] is None


@pytest.mark.parametrize('separator', ['.\n', '; '])
def test_later_sole_name_cannot_own_an_earlier_unattributed_nav(separator):
    text = ('The investor NAV as of 31 July 2026 is EUR 3,615,709.28' + separator +
            'Larchwick Sensor Systems Ltd announced an unrelated director appointment.')
    assert name_mentions(text)  # Guard still applies when a later name is recognized.
    assert not any(f.kind == 'valuation' for f in facts(text))
    candidate = Fact(kind='valuation', investmentName='Larchwick Sensor Systems Ltd',
                     amount='3615709.28', currency='EUR', effectiveDate='2026-07-31',
                     dueDate=None, summary='Unsupported owner', evidence={'page': 1, 'quote': text})
    assert verify_fact(candidate, pages(text))[0] is None


def test_model_hint_cannot_supply_missing_earlier_fund_name():
    text = ('The investor NAV as of 31 July 2026 is EUR 3,615,709.28.\n'
            'Underlying issuer\nLarchwick Sensor Systems Ltd\n36.0%')
    assert not source_events(text, investment_hint='Willowmere Growth IV')


@pytest.mark.parametrize('body', [
    'There is no capital call for Willowmere Growth IV of EUR 44,318.72.',
    'The capital call for Willowmere Growth IV is not EUR 44,318.72.',
    'Willowmere Growth IV reports no distribution of CHF 19,482.17.',
    'Willowmere Growth IV: investor NAV is not EUR 3,615,709.28.',
    'Willowmere Growth IV: the illustrative investor NAV is EUR 3,615,709.28.',
])
def test_new_name_grammar_never_turns_a_negation_or_illustration_into_a_fact(body):
    assert not any(f.amount is not None for f in facts(body))


def test_new_name_grammar_preserves_retraction_and_corrected_mark():
    text = ('Willowmere Growth IV: investor NAV as of 31 July 2026 is EUR 3,615,709.28.\n'
            'The preceding valuation is withdrawn.\n'
            'Willowmere Growth IV: investor NAV as of 31 July 2026 is the corrected EUR 3,629,102.53.')
    fs = facts(text)
    assert [(f.amount, f.effectiveDate) for f in fs] == [('3629102.53', '2026-07-31')]
    assert verify_fact(fs[0].model_copy(update={'amount': '3615709.28'}), pages(text))[0] is None


def test_same_fund_historical_periods_survive_multipage_deduplication():
    source = [Page(1, 'Willowmere Growth IV: investor NAV as of 30 June 2026 is EUR 3,501,208.44.', 'first period'),
              Page(2, 'Willowmere Growth IV: investor NAV as of 31 July 2026 is EUR 3,615,709.28.', 'later period')]
    fs = deterministic_facts(source)
    assert {(f.effectiveDate, f.amount, f.evidence.page) for f in fs} == {
        ('2026-06-30', '3501208.44', 1), ('2026-07-31', '3615709.28', 2)}
    assert verify_fact(fs[0].model_copy(update={'amount': fs[1].amount}), source)[0] is None


def test_forwarded_exact_repeat_deduplicates_without_losing_the_event():
    notice = 'The capital call for Willowmere Growth IV is EUR 44,318.72 effective 6 August 2026.'
    text = notice + '\nForwarded message:\n> ' + notice
    fs = facts(text)
    assert len(fs) == 1 and fs[0].amount == '44318.72'


def test_model_quote_cannot_omit_event_role_or_invent_quote_text():
    source = ('Willowmere Growth IV reports a distribution of CHF 19,482.17 effective 4 August 2026.\n'
              'Reference: Willowmere Growth IV / CHF 19,482.17 / 4 August 2026.')
    candidate = facts(source)[0]
    for quote in ('Reference: Willowmere Growth IV / CHF 19,482.17 / 4 August 2026.',
                  'Willowmere Growth IV confirms CHF 19,482.17 for 4 August 2026.'):
        assert verify_fact(candidate.model_copy(update={'evidence': candidate.evidence.model_copy(update={'quote': quote})}), pages(source))[0] is None
