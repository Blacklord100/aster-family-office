import importlib.util
from decimal import Decimal
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from hashlib import sha256
import unittest
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('history_integrity',ROOT/'verify.py');verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)

class HistoryCorpusTests(unittest.TestCase):
    def test_frozen_sources_routing_and_mime_counts(self):
        manifest,gold,catalog=verify.load_frozen();self.assertEqual(manifest['expectedFactCount'],111)
        self.assertEqual(len(catalog['offices']),3);self.assertEqual(len(catalog['mailboxes']),9)
        mailboxes={row['id']:row for row in catalog['mailboxes']};pdfs=0
        for row in catalog['documents']:
            self.assertEqual(mailboxes[row['mailbox_id']]['office_id'],row['office_id'])
            message=BytesParser(policy=policy.default).parsebytes((ROOT/row['path']).read_bytes())
            pdfs+=sum(part.get_content_type()=='application/pdf' for part in message.walk())
            self.assertIn('.example.invalid',message['From'])
        self.assertEqual(pdfs,64)
        self.assertEqual(sum(len(case['facts']) for case in gold['cases']),111)
    def test_twelve_real_observation_dates_and_explicit_correction_expectations(self):
        data=json.loads((ROOT/'expected-history.json').read_text());self.assertEqual(len(data['positions']),6)
        self.assertEqual(len(data['dates']),12);self.assertEqual(data['dates'],sorted(data['dates']))
        for position in data['positions']:
            self.assertEqual([mark['date'] for mark in position['marks']],data['dates'])
            self.assertLess(position['effectiveOpeningDateAfterReview'],data['dates'][0])
        self.assertEqual(sum('basis' in mark for position in data['positions'] for mark in position['marks']),3)
    def test_cash_scenarios_require_explicit_settlement_and_never_assert_reconciliation(self):
        data=json.loads((ROOT/'expected-history.json').read_text());self.assertEqual(data['automaticSettlements'],0)
        for case in data['manualSettlementScenarios']:
            self.assertEqual(Decimal(case['openingCash'])-Decimal(case['callAmount'])+Decimal(case['distributionAmount']),Decimal(case['cashAfterExplicitSettlements']))
            self.assertFalse(case['reconciled']);self.assertGreaterEqual(len(case['requires']),4)
    def test_missing_notice_details_and_duplicate_receipts_are_not_repaired(self):
        _,gold,_=verify.load_frozen();cases={case['id']:case for case in gold['cases']}
        incomplete=[case for case in cases.values() if case['category']=='incomplete_call'];self.assertEqual(len(incomplete),3)
        for case in incomplete: self.assertIsNone(case['facts'][0]['amount']);self.assertIsNone(case['facts'][0]['dueDate'])
        duplicate=[case for case in cases.values() if 'identicalTo' in case];self.assertEqual(len(duplicate),3)
        for case in duplicate: self.assertEqual((ROOT/case['path']).read_bytes(),(ROOT/cases[case['identicalTo']]['path']).read_bytes())
    def test_scoring_keeps_missing_jobs_and_rejects_changed_page_records(self):
        # Deliberately empty unit-test page registry: no extraction output is fabricated.
        manifest,gold,catalog=verify.load_frozen();by_path={row['path']:row for row in catalog['documents']}
        with TemporaryDirectory(prefix='aster-history-score-unit-') as directory:
            root=Path(directory);decoded=root/'decoded';decoded.mkdir();entries=[]
            for case in gold['cases']:
                target=decoded/(case['id']+'.json');target.write_text(json.dumps({'pages':[],'contentHash':by_path[case['path']]['sha256']}))
                entries.append({'caseId':case['id'],'decodedSha256':sha256(target.read_bytes()).hexdigest()})
            (decoded/'decode-index.json').write_text(json.dumps({'goldSha256':manifest['goldSha256'],'manifestSha256':sha256((ROOT/'manifest.json').read_bytes()).hexdigest(),'decoderUnchanged':True,'documents':entries}))
            exports=root/'empty.json';exports.write_text(json.dumps({'organizationId':'unit-test-only','dataset':'history-v1','goldProvidedToProcessor':False,'jobs':[]}))
            result=verify.score(exports,decoded)
            self.assertEqual(result['expectedFacts'],111);self.assertEqual(result['supportedExactFacts'],0);self.assertEqual(result['missingOrUnprocessed'],100);self.assertEqual(result['factPerfectReceipts'],0)
            (decoded/'history-001.json').write_text('Changed source pages')
            with self.assertRaisesRegex(ValueError,'page file changed'): verify.score(exports,decoded)
if __name__=='__main__': unittest.main()
