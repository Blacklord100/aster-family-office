from service.classifier import RelevanceClassifier, relevance_text


def test_negated_financial_topics_do_not_become_positive_features():
    text = 'Office planning and catering. This is not an investment report, capital call, NAV or distribution notice.'
    cleaned = relevance_text(text)
    assert 'office planning and catering' in cleaned
    for phrase in ('investment report','capital call','nav','distribution notice'):
        assert phrase not in cleaned
    assert RelevanceClassifier().predict(text)[0] is False


def test_positive_contrasting_clauses_and_later_sentences_are_preserved():
    text = 'No distribution is planned, but the NAV is EUR 3200000.00. A capital call is due next month.'
    cleaned = relevance_text(text)
    assert 'distribution' not in cleaned
    assert 'nav is eur 3200000.00' in cleaned
    assert 'capital call is due' in cleaned
    assert RelevanceClassifier().predict(text)[0] is True


def test_negation_in_a_separate_pdf_line_does_not_erase_a_notice():
    cleaned = relevance_text('Not an actual account record\nValuation statement\nNAV: EUR 3200000.00')
    assert 'valuation statement' in cleaned and 'nav:' in cleaned


def test_wrapped_financial_phrase_stays_inside_its_negation():
    cleaned = relevance_text('This is not a capital\ncall. Office lunch planning only.')
    assert 'capital' not in cleaned and 'call' not in cleaned
    assert 'office lunch planning' in cleaned
