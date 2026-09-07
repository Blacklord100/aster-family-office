import json
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline


class RelevanceClassifier:
    """Small synthetic baseline, trained reproducibly; confidence is not calibrated."""
    def __init__(self):
        rows = json.loads((Path(__file__).parent.parent / 'corpus' / 'train.json').read_text())
        self.model = make_pipeline(TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True),
                                   LogisticRegression(C=8, random_state=42, max_iter=1000))
        self.model.fit([row['text'] for row in rows], [row['relevant'] for row in rows])

    def predict(self, text: str) -> tuple[bool, float]:
        probability = float(self.model.predict_proba([text])[0][1])
        return probability >= 0.5, probability
