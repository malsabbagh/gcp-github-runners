"""Offline wire contract for Pool.get_document via transactional batchGet."""
import importlib.util
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("provision", ROOT / "cloud-functions/webhook-handler/provision-runner.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)
TX = "/+8="  # base64 bytes whose characters must not be URL-escaped in JSON

class TransactionReadTests(unittest.TestCase):
    def setUp(self):
        self.pool = provision.Pool("synthetic", "token")
        self.name = "projects/synthetic/databases/autoscaler-state/documents/job_provisioning/abc"

    def get(self, rows):
        with patch.object(self.pool, "request", return_value=rows) as req:
            result = self.pool.get_document("/job_provisioning/abc", TX)
        req.assert_called_once_with(":batchGet", {"documents": [self.name], "transaction": TX})
        return result

    def test_found_and_exact_missing(self):
        doc = {"name": self.name, "fields": {"state": {"stringValue": "waiting"}}}
        self.assertEqual(self.get([{"found": doc, "readTime": "2026-01-01T00:00:00Z"}]), doc)
        self.assertIsNone(self.get([{"missing": self.name}]))

    def test_malformed_error_and_unbound_rows_fail_closed(self):
        doc = {"name": self.name, "fields": {}}
        bad = [None, {}, [], [{"found": doc}, {"missing": self.name}], ["x"], [{}],
            [{"error": {"code": 5}}], [{"found": doc, "missing": self.name}],
            [{"found": {"name": self.name + "x"}}], [{"missing": self.name + "x"}],
            [{"found": "x"}], [{"missing": 1}], [{"found": {"name": self.name, "fields": []}}],
            [{"found": doc, "extra": 1}], [{"transaction": TX}]]
        for rows in bad:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.get(rows)

    def test_http_errors_are_not_absence(self):
        for code in (404, 409, 429, 503):
            err = urllib.error.HTTPError("synthetic.invalid", code, "x", {}, None)
            with self.subTest(code=code), patch.object(self.pool, "request", side_effect=err):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.pool.get_document("/job_provisioning/abc", TX)
            self.assertIs(caught.exception, err)
            err.close()

    def test_transaction_read_conflicts_retry_with_fresh_tokens_before_commit(self):
        attempts, commits, rollbacks, failures = [], [], [], []
        def request(suffix, data=None):
            if suffix == ':beginTransaction':
                attempts.append('transaction-' + str(len(attempts) + 1))
                return {'transaction': attempts[-1]}
            if suffix == ':batchGet':
                self.assertEqual(data['transaction'], attempts[-1])
                if len(attempts) < 3:
                    error = urllib.error.HTTPError('synthetic.invalid', 409 if len(attempts) == 1 else 429, 'retry', {}, None)
                    failures.append(error)
                    raise error
                return [{'missing': self.pool.name}]
            if suffix == ':commit':
                commits.append(data)
                return {}
            if suffix == ':rollback':
                rollbacks.append(data['transaction'])
                return {}
            self.fail('Unexpected request')
        with patch.object(self.pool, 'request', request), patch.object(provision.time, 'sleep') as sleep:
            self.pool.mutate(lambda entries: entries.update(kept='charged'))
        self.assertEqual([row['transaction'] for row in commits], ['transaction-3'])
        self.assertEqual(rollbacks, attempts)
        self.assertEqual([row.args[0] for row in sleep.call_args_list], [0.1, 0.2])
        for error in failures:
            error.close()

if __name__ == "__main__":
    unittest.main()
