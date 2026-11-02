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
TX = "dHgtYmFzZTY0Kz09"  # exact token must be preserved untouched

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

if __name__ == "__main__":
    unittest.main()
