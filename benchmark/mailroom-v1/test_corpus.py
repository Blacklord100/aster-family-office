"""Offline integrity checks for the frozen mailroom inputs; no inference."""
from collections import Counter
from email import policy
from email.parser import BytesParser
from hashlib import sha256
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent
MANIFEST=json.loads((ROOT/'manifest.json').read_text())
GOLD=json.loads((ROOT/'gold.json').read_text())

class FrozenCorpusTests(unittest.TestCase):
    def test_all_frozen_bytes_match(self):
        self.assertEqual(MANIFEST['freezeStatus'],'complete')
        for relative,expected in MANIFEST['files'].items():
            path=(ROOT/relative).resolve()
            self.assertTrue(path.is_relative_to(ROOT))
            self.assertEqual(sha256(path.read_bytes()).hexdigest(),expected,relative)
        self.assertEqual(sha256((ROOT/'build_corpus.py').read_bytes()).hexdigest(),MANIFEST['generatorSha256'])

    def test_receipts_and_offices_are_complete(self):
        docs=MANIFEST['documents']
        self.assertEqual(len(docs),100)
        self.assertEqual(len({d['id'] for d in docs}),100)
        self.assertEqual(len({d['receipt_id'] for d in docs}),100)
        self.assertEqual(Counter(d['office_id'] for d in docs),{'alder-house':34,'belwick-office':33,'cinder-trust':33})
        self.assertEqual(len({d['mailbox_id'] for d in docs}),9)
        self.assertEqual({d['id'] for d in docs},{g['id'] for g in GOLD['cases']})

    def test_email_envelopes_are_synthetic_and_parseable(self):
        for doc in MANIFEST['documents']:
            message=BytesParser(policy=policy.default).parsebytes((ROOT/doc['filename']).read_bytes())
            self.assertFalse(message.defects,doc['id'])
            self.assertIn('example.invalid',str(message['From']))
            self.assertIn('example.invalid',str(message['To']))
            self.assertEqual(str(message['Message-ID']),doc['source_message_id'])
            self.assertEqual(doc['media_type'],'message/rfc822')

    def test_same_office_content_deduplication_is_cross_mailbox(self):
        docs={d['id']:d for d in MANIFEST['documents']}
        for office in MANIFEST['offices']:
            original=docs[office['id']+'-05'];copy=docs[office['id']+'-32']
            self.assertEqual(original['sha256'],copy['sha256'])
            self.assertNotEqual(original['mailbox_id'],copy['mailbox_id'])
            self.assertEqual(copy['duplicate_of'],original['id'])

    def test_cross_office_identical_content_remains_separate(self):
        docs=[d for d in MANIFEST['documents'] if d['category']=='cross_office_identical']
        self.assertEqual(len(docs),3)
        self.assertEqual(len({d['sha256'] for d in docs}),1)
        self.assertEqual(len({d['office_id'] for d in docs}),3)

    def test_core_gold_and_economic_event_counts(self):
        facts=[f for c in GOLD['cases'] for f in c['facts']]
        self.assertEqual(len(facts),93)
        self.assertEqual(len({f['eventKey'] for f in facts}),72)
        fields=set(GOLD['factsFields'])
        for fact in facts:
            self.assertTrue(fields.issubset(fact))
            self.assertGreaterEqual(fact['evidencePage'],1)
            self.assertTrue(fact['evidenceAnchors'])
        self.assertEqual(sum(c['relevant'] for c in GOLD['cases']),88)

    def test_boundary_cases_remain_in_gold(self):
        for case in GOLD['cases']:
            if case['category']=='missing_effective_date':self.assertIsNone(case['facts'][0]['effectiveDate'])
            if case['category']=='ambiguous_currency':self.assertIsNone(case['facts'][0]['currency'])
            if case['category']=='nested_eml_attachment':self.assertEqual(len(case['facts']),1)
            if case['category']=='encrypted_attachment':
                self.assertEqual(case['facts'],[])
                self.assertTrue(case['reviewExpectation']['expectedSafeInputBlock'])
                self.assertEqual(len(case['unavailableSourceFacts']),1)

    def test_pdf_attachment_sources_match_embedded_bytes(self):
        sources={path.name:sha256(path.read_bytes()).hexdigest() for path in (ROOT/'fixtures/attachments').glob('*.pdf')}
        self.assertEqual(len(sources),57)
        embedded={}
        for doc in MANIFEST['documents']:
            msg=BytesParser(policy=policy.default).parsebytes((ROOT/doc['filename']).read_bytes())
            for part in msg.walk():
                if part.get_content_type()=='application/pdf':
                    embedded[part.get_filename()]=sha256(part.get_payload(decode=True)).hexdigest()
        self.assertEqual(embedded,sources)

if __name__=='__main__':unittest.main()
