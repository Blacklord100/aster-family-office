"""Independent operational invoices and mixed investment material stay distinct."""
import json
from pathlib import Path
import pytest
from service.classifier import RelevanceClassifier


@pytest.fixture(scope='module')
def classifier():
    return RelevanceClassifier()


@pytest.mark.parametrize('text',[
    'Invoice 73: quarterly lift inspection at the investment office, payable by the facilities team.',
    'Accounts payable reminder: copier rental and telephone charges for the investor services department.',
    'Office stationery purchase receipt for fund administration: pens, labels and envelopes.',
    'Staff payroll reconciliation for the family office employees. Overtime and pension deductions are included.',
    'Software maintenance bill for employee email accounts and desktop antivirus subscriptions.',
    'Supplier charge for meeting room catering at our investment managers office.',
    'The office cleaning invoice is attached. It contains no investment valuation or capital call.',
    'Please process the internal travel expense claim for the portfolio reporting team.',
    'Retail delivery notification: your personal parcel is ready for collection.',
])
def test_operational_supplier_or_staff_messages_are_not_investment_reports(classifier,text):
    assert classifier.predict(text)[0] is False


@pytest.mark.parametrize('text',[
    'The invoice is for administrative services. Separately, Junco Fen Fund reports investor NAV EUR 781,482.61 as of 31 August 2026.',
    'The capital call total includes legal invoices and manager fees. The investor must contribute EUR 83,042.19 by the deadline.',
    'A manager withdrawal notice cancels the earlier distribution advice; do not rely on the previous amount.',
    'The investor account valuation has not been finalized. The reported amount remains unknown and requires administrator review.',
    'The investment manager is exploring an acquisition of a battery business. No transaction is complete and no weight is known.',
    'Portfolio company update: the business commenced operations at the new logistics depot.',
    'There is no capital call this month, but the investor NAV has been revised after a financing round.',
    'The contribution requested for your investment is pending approval. A confirmed amount will follow.',
])
def test_investment_events_incomplete_notices_and_mixed_packs_remain_relevant(classifier,text):
    assert classifier.predict(text)[0] is True


def test_original_holdout_remains_distinct_from_training(classifier):
    root=Path(__file__).parent.parent/'corpus'
    training=json.loads((root/'train.json').read_text())
    holdout=json.loads((root/'holdout.json').read_text())
    assert {row['text'] for row in training}.isdisjoint(row['text'] for row in holdout)
    assert all(classifier.predict(row['text'])[0]==row['relevant'] for row in holdout)


def test_explicit_investment_fact_keeps_a_mixed_operational_pack_visible(classifier):
    from service.documents import Page
    from service.grounding import deterministic_facts
    text='Office rent receipt attached alongside the capital call for Bracken Cove Credit VIII: GBP 16,357.80 due 21 September 2026.'
    relevant,probability=classifier.predict(text)
    facts=deterministic_facts([Page(1,text,'mixed source')])
    # The pipeline independently extracts source facts before routing and uses
    # relevant OR facts for final relevance. Keep the model probability honest.
    assert bool(relevant or facts)
    assert len(facts)==1 and facts[0].kind=='capital_call' and facts[0].amount=='16357.80'
    assert probability==float(classifier.model.predict_proba([text])[0][1])
