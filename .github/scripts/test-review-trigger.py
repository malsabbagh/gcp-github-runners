"""Exercise the restored resolver offline; never invoke GitHub or inference."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/review-sensei-review.yml"


class ReviewTriggerTests(unittest.TestCase):
    def setUp(self):
        text = WORKFLOW.read_text()
        marker = 'python - "$pull_json" "$EVENT_NAME" "$COMMENT_BODY" <<\'PY\'\n'
        body = text.split(marker, 1)[1].split("\n          PY", 1)[0]
        self.resolver = textwrap.dedent(body)
        self.pull = {
            "number": 42,
            "head": {"sha": "a" * 40, "ref": "feature/synthetic"},
            "base": {"sha": "b" * 40, "ref": "main"},
        }

    def resolve(self, event="workflow_dispatch", comment=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "pull.json"
            source.write_text(json.dumps(self.pull))
            output = root / "outputs"
            env = dict(os.environ, GITHUB_OUTPUT=str(output))
            result = subprocess.run(
                [sys.executable, "-", str(source), event, comment],
                input=self.resolver, text=True, capture_output=True, env=env, timeout=10,
            )
            return result, output.read_text() if output.exists() else ""

    def test_manual_dispatch_freezes_current_pr_identity(self):
        result, output = self.resolve()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(dict(line.split("=", 1) for line in output.splitlines()), {
            "operation": "review", "head_sha": "a" * 40, "head_ref": "feature/synthetic",
            "base_ref": "main", "base_sha": "b" * 40, "pull_request_number": "42",
        })

    def test_source_automatic_pr_event_resolves_review(self):
        result, output = self.resolve("pull_request")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("operation=review\n", output)

    def test_source_issue_commands_and_conversation_resolve_distinct_operations(self):
        for body, operation in [("@sensei review status", "command"),
                                ("@sensei verify", "command"),
                                ("@sensei explain this finding", "reply")]:
            with self.subTest(body=body):
                result, output = self.resolve("issue_comment", body)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("operation=" + operation + "\n", output)

    def test_source_inline_mention_resolves_reply(self):
        result, output = self.resolve("pull_request_review_comment", "@sensei explain")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("operation=reply\n", output)

    def test_invalid_identity_cannot_inject_github_outputs(self):
        for location, field, bad in [
            ("head", "sha", "a" * 40 + "\noperation=command"),
            ("base", "ref", "main\nhead_sha=" + "c" * 40),
            ("head", "ref", "../outside"),
            ("head", "ref", "/outside"),
            ("head", "ref", "feature//outside"),
        ]:
            with self.subTest(location=location, field=field, bad=bad):
                old = self.pull[location][field]
                self.pull[location][field] = bad
                result, output = self.resolve()
                self.pull[location][field] = old
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")

    def test_boolean_or_nonpositive_pr_number_is_rejected(self):
        for number in [True, False, 0, -1, "42"]:
            with self.subTest(number=number):
                self.pull["number"] = number
                result, output = self.resolve()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")

    def test_rescan_cannot_substitute_an_unrelated_commit(self):
        result, output = self.resolve("issue_comment", "@sensei rescan commit " + "c" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")

    def test_rescan_prefix_resolves_only_to_current_head(self):
        result, output = self.resolve("issue_comment", "@sensei rescan commit aaaaaaa")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("head_sha=" + "a" * 40 + "\n", output)

    def test_unsupported_event_is_rejected(self):
        result, output = self.resolve("push")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
