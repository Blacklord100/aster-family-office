"""Small offline controls for safe publication and complete evidence binding."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('bundle_controls', ROOT / 'bundle_demo.py')
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


def complete_plan():
    unique, receipts = [], []
    for cell in range(4):
        for index in range(97):
            unique.append({'jobId': f'{cell}-{index}', 'caseId': str(index), 'cell': cell, 'model': f'model-{cell // 2}', 'mode': ['workflow', 'agentic'][cell % 2], 'final': {'status': 'failed', 'score': {'caseId': str(index), 'goldFactCount': 1}, 'output': None}})
        receipts.extend(deepcopy(unique[-97:]))
        for index in range(3):
            duplicate = deepcopy(unique[-97 + index])
            duplicate['caseId'] = str(97 + index)
            duplicate['final']['score']['caseId'] = str(97 + index)
            receipts.append(duplicate)
    return {'uniqueSourceRows': unique, 'rows': receipts, 'matrix': {'uniqueSourcesStoredFinal': [{'cell': cell, 'complete': True, 'finished': 97, 'planned': 97} for cell in range(4)]}}


class BundleControls(unittest.TestCase):
    def test_complete_detail_required_even_when_aggregate_claims_complete(self):
        score = complete_plan()
        bundle.require_complete(score)  # Shared duplicate receipts may have different score case IDs.
        score['uniqueSourceRows'][0]['final']['status'] = 'pending'
        with self.assertRaisesRegex(ValueError, 'still partial'):
            bundle.require_complete(score)
        score = complete_plan()
        score['uniqueSourceRows'][-1]['jobId'] = score['uniqueSourceRows'][0]['jobId']
        with self.assertRaisesRegex(ValueError, '388 distinct-job'):
            bundle.require_complete(score)

    def test_unsafe_archive_names_and_input_symlinks_rejected(self):
        for name in ['/absolute', '../outside', 'corpus/../other', 'corpus//file', 'corpus\\file', 'C:private', 'file\nother']:
            with self.assertRaises(ValueError):
                bundle.archive_name(name)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'regular').write_bytes(b'synthetic fixture')
            self.assertEqual(bundle.read_regular(root, 'regular'), b'synthetic fixture')
            (root / 'report.html').symlink_to(root / 'regular')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                bundle.read_regular(root, 'report.html')

    def test_atomic_publication_cannot_overwrite_a_late_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary, target = Path(directory) / 'new.partial', Path(directory) / 'existing.zip'
            temporary.write_bytes(b'new archive control')
            target.write_bytes(b'preserved archive control')
            with self.assertRaises(FileExistsError):
                bundle.publish_no_replace(temporary, target)
            self.assertEqual(target.read_bytes(), b'preserved archive control')
            self.assertEqual(temporary.read_bytes(), b'new archive control')
            target.unlink()
            bundle.publish_no_replace(temporary, target)
            self.assertEqual(target.read_bytes(), b'new archive control')
            self.assertFalse(temporary.exists())

    def test_passing_audit_for_another_run_is_rejected(self):
        score = {'runId': 'current-run', 'manifestSha256': 'same-corpus'}
        audit = {'status': 'passed', 'partial': False, 'finalUniqueJobs': 388, 'everyRecordedRequestMatchesFrozenOriginalAndPin': True, 'runId': 'different-run', 'manifestSha256': 'same-corpus'}
        with self.assertRaisesRegex(ValueError, 'different run or corpus'):
            bundle.verify_bindings(score, {'attempt-integrity.json': json.dumps(audit).encode()}, {})


if __name__ == '__main__':
    unittest.main()
