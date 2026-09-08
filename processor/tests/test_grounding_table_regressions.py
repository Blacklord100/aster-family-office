"""Source row/currency/date binding and conservative table coverage boundaries."""
import pytest
from service.documents import Page
from service.grounding import deterministic_facts,verify_fact
from service.source_events import source_table_warnings

A=('Kiteford Renewable Partners II','8 August 2026','EUR','72,810.45')
B=('Solmere Energy Transition IV','12 August 2026','USD','93,570.60')


def table(rows, heading='Cash distribution advice', headers=None):
    headers=headers or ('Investment','Distribution date','Currency','Cash distribution')
    return heading+'\n'+'\n'.join(headers)+'\n'+'\n'.join('\n'.join(row) for row in rows)+'\n'


def facts(text):
    return deterministic_facts([Page(1,text,'synthetic generic row regression')])


@pytest.mark.parametrize('rows',[(A,B),(B,A)])
def test_explicit_rows_bind_names_dates_currencies_and_values_independently(rows):
    text=table(rows)
    fs=facts(text)
    assert {(f.investmentName,f.effectiveDate,f.amount,f.currency) for f in fs}=={
        (A[0],'2026-08-08','72810.45','EUR'),(B[0],'2026-08-12','93570.60','USD')}
    assert not source_table_warnings(text)
    for f in fs:
        wrong=f.model_copy(update={'investmentName':B[0] if f.investmentName==A[0] else A[0]})
        assert verify_fact(wrong,[Page(1,text,'synthetic')])[0] is None


def test_same_investment_two_rows_preserve_periods():
    fs=facts(table((A,(A[0],'12 August 2026','EUR','79,130.25'))))
    assert {(f.effectiveDate,f.amount) for f in fs}=={('2026-08-08','72810.45'),('2026-08-12','79130.25')}


def test_separated_currency_column_remains_grounded_when_columns_reordered():
    text=table(((A[0],A[2],A[1],A[3]),),headers=('Investment','Currency','Distribution date','Cash distribution'))
    fs=facts(text)
    assert len(fs)==1 and fs[0].currency=='EUR' and fs[0].amount=='72810.45'
    assert verify_fact(fs[0],[Page(1,text,'synthetic')])[0] is not None


@pytest.mark.parametrize('separator',['\t',' | '])
def test_explicit_horizontal_cell_separators(separator):
    text=separator.join(('Investment','Distribution date','Currency','Cash distribution'))+'\n'+separator.join(A)+'\n'+separator.join(B)
    assert len(facts(text))==2


@pytest.mark.parametrize('bad',[
    (A[0],A[1],'???',A[3]),
    (A[0],A[1],A[2],'invalid amount'),
    (A[0],'date pending',A[2],A[3]),
    (A[0],A[1],A[2],'1.25e6'),
    (A[0],A[1],A[2],'This amount is not reported.'),
])
def test_invalid_row_never_leaks_into_prose_or_relabels_later_money(bad):
    text=table((bad,B))+'These amounts are distributions, not fund valuations.'
    fs=facts(text)
    assert all(f.investmentName==B[0] and f.effectiveDate=='2026-08-12' and f.amount=='93570.60' and f.currency=='USD' for f in fs)
    assert source_table_warnings(text)


@pytest.mark.parametrize('rows',[
    ((A[0],A[1],A[3]),B),
    ((A[0].replace('Renewable ','Renewable\n'),*A[1:]),B),
])
def test_ambiguous_missing_or_wrapped_flattened_cells_abstain_whole_region(rows):
    text=table(rows)
    assert not facts(text)
    assert source_table_warnings(text)


def test_financial_illustration_header_qualifies_all_fund_rows():
    text=table((A,B),'ILLUSTRATIVE DISTRIBUTION EXAMPLE')
    assert not facts(text)


@pytest.mark.parametrize('withdrawn',[A[0],B[0]])
def test_explicit_named_row_withdrawal_does_not_retract_the_wrong_row(withdrawn):
    text=table((A,B))+f'The distribution for {withdrawn} above has been withdrawn. It is no longer valid.'
    fs=facts(text)
    assert len(fs)==1 and fs[0].investmentName!=withdrawn


def test_status_column_excludes_noncurrent_rows():
    text=table(((*A,'Approved'),(*B,'Withdrawn')),headers=('Investment','Distribution date','Currency','Cash distribution','Status'))
    fs=facts(text)
    assert len(fs)==1 and fs[0].investmentName==A[0]
    assert source_table_warnings(text)


def test_table_total_is_not_a_third_row():
    text=table((A,B))+'Total\nEUR\n166,381.05\n'
    assert len(facts(text))==2


def test_explicit_new_source_section_ends_table_protection():
    text=table((A,))+'Investment: Willowbank Credit Fund\nValuation date: 31 July 2026\nNAV: EUR 1,453,902.65.'
    fs=facts(text)
    assert {(f.kind,f.investmentName) for f in fs}=={('distribution',A[0]),('valuation','Willowbank Credit Fund')}


@pytest.mark.parametrize('headers',[
    ('Investment','Date','Currency','Amount'),
    ('Investment','Distribution date','Currency','Currency','Cash distribution'),
    ('Investment','Valuation date','Currency','Cash distribution'),
])
def test_ambiguous_financial_headers_are_quarantined_instead_of_prose_fallback(headers):
    text=table((A,B),headers=headers)+'These are investor distributions.'
    assert not facts(text)
    assert any('headers' in warning for warning in source_table_warnings(text))


def test_unlabelled_financial_tail_is_reported_not_guessed_as_a_table_row():
    text=table((A,))+'The new valuation for the investor is EUR 1,453,902.65 at 31 July 2026.'
    fs=facts(text)
    assert len(fs)==1 and fs[0].kind=='distribution'
    assert any('trailing' in warning for warning in source_table_warnings(text))


def test_table_row_budget_is_explicit_and_not_silent_truncation():
    text=table((A,)*101)
    assert not facts(text)
    assert any('100-row' in warning for warning in source_table_warnings(text))


def test_long_header_to_row_evidence_abstains_with_coverage_warning():
    rows=tuple((f'Wideford Investment Partnership {chr(65+i//26)}{chr(65+i%26)}',A[1],A[2],A[3]) for i in range(50))
    text=table(rows)
    assert any('3000-character' in warning for warning in source_table_warnings(text))
    assert all(len(f.evidence.quote)<=3000 for f in facts(text))


CALL='Fund: Willowbank Credit Fund\nNotice date: 3 August 2026\nA drawdown of EUR 62,480.30 has been called from your interest. '


def test_funds_receipt_deadline_does_not_use_an_administrative_reply_date():
    fs=facts(CALL+'Please reply by 9 August 2026. Funds must arrive in the partnership account by 25 August 2026.')
    assert len(fs)==1 and fs[0].effectiveDate=='2026-08-03' and fs[0].dueDate=='2026-08-25'


@pytest.mark.parametrize('suffix',[
    'Please reply by 9 August 2026.',
    'Funds are not required to reach the partnership by 25 August 2026.',
    'No payment must arrive in the account by 25 August 2026.',
])
def test_reply_or_negated_receipt_instruction_does_not_create_a_due_date(suffix):
    fs=facts(CALL+suffix)
    assert len(fs)==1 and fs[0].dueDate is None


def test_new_fund_does_not_inherit_prior_fund_payment_deadline():
    text=(CALL+'Funds must reach the partnership by 25 August 2026.\n'
          'Fund: Coppervale Timber Assets II\nNotice date: 4 August 2026\n'
          'A drawdown of USD 39,740.65 has been called from your interest. Please reply by 10 August 2026.')
    fs=facts(text)
    assert {(f.investmentName,f.dueDate) for f in fs}=={('Willowbank Credit Fund','2026-08-25'),('Coppervale Timber Assets II',None)}


@pytest.mark.parametrize('separator',['\n',' | '])
def test_quoted_event_cannot_borrow_another_rows_date_even_when_fact_exists_elsewhere(separator):
    header=separator.join(('Fund','Valuation date','Currency','NAV'))
    first=separator.join((A[0],'31 July 2026','EUR','100.00'))
    other=separator.join((B[0],'31 August 2026','EUR','100.00'))
    last=separator.join((A[0],'31 August 2026','EUR','100.00'))
    quote='\n'.join((header,first,other))
    text=quote+'\n'+last
    fs=facts(text)
    candidate=next(f for f in fs if f.investmentName==A[0] and f.effectiveDate=='2026-08-31')
    assert verify_fact(candidate,[Page(1,text,'synthetic')])[0] is not None
    short=candidate.model_copy(update={'evidence':candidate.evidence.model_copy(update={'quote':quote})})
    assert verify_fact(short,[Page(1,text,'synthetic')])[0] is None


def test_quoted_call_cannot_borrow_another_rows_due_date():
    headers=('Fund','Notice date','Due date','Currency','Capital called')
    first=(A[0],'3 August 2026','20 August 2026','EUR','100.00')
    other=(B[0],'3 August 2026','25 August 2026','EUR','100.00')
    last=(A[0],'3 August 2026','25 August 2026','EUR','100.00')
    text=table((first,other,last),headers=headers)
    quote=table((first,other),headers=headers)
    fs=facts(text)
    candidate=next(f for f in fs if f.investmentName==A[0] and f.dueDate=='2026-08-25')
    short=candidate.model_copy(update={'evidence':candidate.evidence.model_copy(update={'quote':quote})})
    assert verify_fact(short,[Page(1,text,'synthetic')])[0] is None


def test_incomplete_repeated_header_run_is_scanned_once(monkeypatch):
    import service.source_events as parser
    original=parser._table_header
    calls=0
    def counted(value):
        nonlocal calls
        calls+=1
        return original(value)
    monkeypatch.setattr(parser,'_table_header',counted)
    assert parser._source_tables('Fund\n'*600)==([],[],[])
    assert calls<=601
