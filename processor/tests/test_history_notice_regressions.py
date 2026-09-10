"""Source-role regressions: deadlines, restatements and explicit legal events."""
import pytest
from service.documents import Page
from service.grounding import deterministic_facts, verify_fact
from service.schema import Fact


def facts(text):
    return deterministic_facts([Page(number=1, text=text, source='synthetic literal source')])


@pytest.mark.parametrize('wording', ['due date 2026-08-20', 'payable by 2026-08-20', 'payment due: 2026-08-20'])
def test_distribution_retains_its_explicit_payment_deadline(wording):
    result = facts('Cedar Infrastructure I: distribution notice effective 2026-08-12; amount EUR 450.20; ' + wording + '.')
    assert len(result) == 1
    assert result[0].dueDate == '2026-08-20'
    assert result[0].effectiveDate == '2026-08-12'


def test_call_deadline_is_not_borrowed_by_same_fund_distribution():
    result = facts('Cedar Infrastructure I: capital call notice effective 2026-08-12, amount EUR 600.10, due date 2026-08-20.\n'
                   'Cedar Infrastructure I: distribution notice effective 2026-08-13, amount EUR 250.05.')
    assert [(f.kind, f.dueDate) for f in result] == [('capital_call', '2026-08-20'), ('distribution', None)]


def test_bank_statement_keeps_cash_owner_and_two_event_deadlines_separate():
    result = facts('Cedar operating cash balance: opening cash balance as of 2026-08-01 is EUR 95000.00.\n'
                   'Cedar Infrastructure I: capital call notice effective 2026-08-12, amount EUR 600.10, due date 2026-08-20.\n'
                   'Cedar Infrastructure I: distribution notice effective 2026-08-13, amount EUR 250.05, due date 2026-08-21.')
    assert [(f.kind, f.investmentName, f.amount, f.dueDate) for f in result] == [
        ('valuation', 'Cedar operating cash balance', '95000.00', None),
        ('capital_call', 'Cedar Infrastructure I', '600.10', '2026-08-20'),
        ('distribution', 'Cedar Infrastructure I', '250.05', '2026-08-21')]


def test_numeric_old_figure_reference_does_not_retract_the_corrected_nav():
    text = ('Cedar Infrastructure I: the investor NAV as of 2026-06-30 is EUR 95000.25.\n'
            'This final correction supersedes our earlier 2026-06-30 investor NAV. '
            'The withdrawn figure was EUR 96000.30 and must not be treated as the current mark.')
    result = facts(text)
    assert [(f.kind, f.amount) for f in result] == [('valuation', '95000.25')]
    wrong = result[0].model_copy(update={'amount': '96000.30'})
    assert verify_fact(wrong, [Page(number=1, text=text, source='synthetic')])[0] is None


def test_explicit_retraction_without_numeric_old_reference_still_retracts_current_value():
    assert facts('Cedar Infrastructure I: investor NAV as of 2026-06-30 is EUR 95000.25. '
                 'The reported valuation is withdrawn and must not be used.') == []


@pytest.mark.parametrize('kind,noun', [('valuation','investor NAV'), ('capital_call','capital call'), ('distribution','distribution')])
def test_matching_numeric_withdrawal_never_leaves_the_revoked_financial_fact(kind, noun):
    text = ('Cedar Infrastructure I: ' + noun + ' effective 2026-06-30 is EUR 95000.25. '
            'The withdrawn figure was EUR 95000.25 and must not be used.')
    assert facts(text) == []
    candidate = Fact(kind=kind, investmentName='Cedar Infrastructure I', effectiveDate='2026-06-30',
                     amount='95000.25', currency='EUR', dueDate=None, summary='Candidate',
                     evidence={'page':1, 'quote':text.split(' The withdrawn')[0]})
    assert verify_fact(candidate, [Page(1,text,'synthetic')])[0] is None


def test_numeric_withdrawal_targets_the_old_amount_without_removing_a_new_mark():
    result = facts('Cedar Infrastructure I: investor NAV as of 2026-03-31 is EUR 95000.25. '
                   'Cedar Infrastructure I: investor NAV as of 2026-06-30 is EUR 96000.30. '
                   'The withdrawn figure was EUR 95000.25 and must not be used.')
    assert [(f.amount,f.effectiveDate) for f in result] == [('96000.30','2026-06-30')]


def test_numeric_withdrawal_cannot_cross_an_explicit_currency_or_owner_boundary():
    result = facts('Cedar Infrastructure I: investor NAV as of 2026-06-30 is EUR 95000.25. '
                   'The withdrawn figure was USD 95000.25 and must not be used.')
    assert [(f.investmentName,f.amount,f.currency) for f in result] == [('Cedar Infrastructure I','95000.25','EUR')]
    result = facts('Cedar Infrastructure I: investor NAV as of 2026-06-30 is EUR 95000.25. '
                   'Elm Credit II: investor NAV as of 2026-06-30 is EUR 96000.30. '
                   'The withdrawn figure was EUR 95000.25 and must not be used.')
    assert len(result) == 2


def test_numeric_withdrawal_date_preserves_an_equal_sized_newer_mark():
    result = facts('Cedar Infrastructure I: investor NAV as of 2026-03-31 is EUR 95000.25. '
                   'Cedar Infrastructure I: investor NAV as of 2026-06-30 is EUR 95000.25. '
                   'The withdrawn figure was EUR 95000.25 as of 2026-03-31 and must not be used.')
    assert [(f.amount,f.effectiveDate) for f in result] == [('95000.25','2026-06-30')]


def test_equivalent_decimal_spelling_of_withdrawn_amount_remains_revoked():
    assert facts('Cedar Infrastructure I: investor NAV as of 2026-06-30 is EUR 95000.250. '
                 'The withdrawn figure was EUR 95000.25 and must not be used.') == []


def test_numeric_withdrawal_deadline_targets_the_matching_call_only():
    result = facts('Cedar Infrastructure I: capital call effective 2026-06-01 is EUR 95000.25, due date 2026-06-10. '
                   'Cedar Infrastructure I: capital call effective 2026-06-20 is EUR 95000.25, due date 2026-06-30. '
                   'The withdrawn call was EUR 95000.25, due date 2026-06-10, and must not be used.')
    assert [(f.amount,f.effectiveDate,f.dueDate) for f in result] == [('95000.25','2026-06-20','2026-06-30')]


def test_legal_position_acquisition_is_news_only_with_no_implied_cost_or_payment():
    result = facts('Cedar Infrastructure I: this investor position was legally acquired on 2023-07-01.\n'
                   'Elm Credit II: this investor position was legally acquired on 2024-03-02.\n'
                   'The source supplies no acquisition cost or cash payment.')
    assert [(f.kind, f.investmentName, f.effectiveDate, f.amount, f.currency) for f in result] == [
        ('news', 'Cedar Infrastructure I', '2023-07-01', None, None),
        ('news', 'Elm Credit II', '2024-03-02', None, None)]


def test_negated_cash_balance_and_acquisition_remain_unestablished():
    assert facts('Cedar operating cash balance: no opening cash balance is reported.\n'
                 'Cedar Infrastructure I: this investor position was not legally acquired on 2023-07-01.') == []
