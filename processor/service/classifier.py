import json
import re
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline


FINANCIAL_TERMS = re.compile(
    r'\b(?:investment\s+(?:statement|report)|capital\s+calls?|drawdowns?|'
    r'distributions?(?:\s+notices?)?|net\s+asset\s+value|NAV|valuations?)\b', re.I)
NEGATED_CLAUSE = re.compile(
    r'\b(?:not|no|without|neither|excluding)\b(?:(?!\b(?:but|however|yet)\b)[^.;\n])*', re.I)


def relevance_text(text: str) -> str:
    """Do not count explicitly negated financial topics as positive TF-IDF evidence.

    Keep surrounding operational vocabulary and later positive clauses. This
    preprocessing is shared by fitting and inference; training rows stay fixed.
    It does not decide financial facts or alter the source used for evidence.
    """
    phrases = FINANCIAL_TERMS.sub(lambda match: ' '.join(match.group().split()), text)
    return NEGATED_CLAUSE.sub(
        lambda match: FINANCIAL_TERMS.sub(' ', match.group()), phrases).casefold()


class RelevanceClassifier:
    """Small synthetic baseline, trained reproducibly; confidence is not calibrated."""
    def __init__(self):
        rows = json.loads((Path(__file__).parent.parent / 'corpus' / 'train.json').read_text())
        self.model = make_pipeline(TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True,
                                                 preprocessor=relevance_text),
                                   LogisticRegression(C=8, random_state=42, max_iter=1000))
        self.model.fit([row['text'] for row in rows], [row['relevant'] for row in rows])

    def predict(self, text: str) -> tuple[bool, float]:
        probability = float(self.model.predict_proba([text])[0][1])
        return probability >= 0.5, probability
