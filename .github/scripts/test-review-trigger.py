"""Exercise the installed caller resolver offline; never invoke GitHub or inference."""
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
            ("head", "ref", "feature/"),
            ("base", "sha", "b" * 39),
            ("head", "ref", "$(touch injected)"),
            ("head", "ref", "feature\rcommand=evil"),
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

    def assert_operation(self, body, operation, event="issue_comment"):
        result, output = self.resolve(event, body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(dict(line.split("=", 1) for line in output.splitlines()), {
            "operation": operation, "head_sha": "a" * 40,
            "head_ref": "feature/synthetic", "base_ref": "main",
            "base_sha": "b" * 40, "pull_request_number": "42",
        })

    def test_both_handles_and_canonical_case_variants(self):
        for alias in ("@reviewsensei", "@ReviewSensei", "@REVIEWSENSEI", "@sensei"):
            for body, operation in (("rescan", "review"), ("re-scan commit AAAAAAA", "review"),
                                    ("re scan", "review"), ("review remaining", "review"),
                                    ("review status", "command"), ("explain this", "reply")):
                with self.subTest(alias=alias, body=body):
                    self.assert_operation(f"{alias} {body}", operation)
            self.assert_operation(f"{alias} rescan", "reply", "pull_request_review_comment")

    def test_only_standalone_rescan_or_remaining_requests_start_review(self):
        for command in ("rescan", "review remaining"):
            for body in (f"please @reviewsensei {command}", f"> @reviewsensei {command}",
                         f"`@reviewsensei {command}`", f"text\n@reviewsensei {command}",
                         f" @reviewsensei {command}", f"@reviewsensei\n{command}",
                         f"@reviewsensei {command}\nmore text", f"@reviewsensei {command} commit xyz",
                         f"@reviewsensei {command} commit aaaaaa", f"@reviewsensei {command} commit " + "a" * 41,
                         f"@reviewsenseiish {command}", f"@reviewſensei {command}",
                         f"@SENSEI {command}", f"@reviewsensei\u00a0{command}"):
                with self.subTest(body=body):
                    self.assert_operation(body, "reply")

    def test_explicit_review_request_head_validation(self):
        for command in ("rescan", "review remaining"):
            for token in ("AAAAAAA", "A" * 39, "A" * 40):
                with self.subTest(command=command, token=token):
                    self.assert_operation(f"@reviewsensei {command} commit {token}", "review")
            for token in ("c" * 7, "c" * 40):
                with self.subTest(command=command, token=token):
                    result, output = self.resolve("issue_comment", f"@reviewsensei {command} commit {token}")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("does not match", result.stderr)
                    self.assertEqual(output, "")

    def test_review_requests_are_bounded_by_utf8_bytes(self):
        for command in ("rescan", "review remaining"):
            prefix = f"@reviewsensei {command}"
            limit = prefix + " " * (4096 - len(prefix.encode("utf-8")))
            self.assert_operation(limit, "review")
            for body in (limit + " ", prefix + "\t" * 4096):
                result, output = self.resolve("issue_comment", body)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("4096 UTF-8 bytes", result.stderr)
                self.assertEqual(output, "")
        # Rescan accepts Unicode trailing whitespace; remaining uses strict ASCII whitespace.
        self.assert_operation("@reviewsensei rescan\u3000", "review")
        result, output = self.resolve("issue_comment", "@reviewsensei rescan" + "\u3000" * 1400)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")
        for suffix in ("\f", "\v", "\u00a0"):
            self.assert_operation("@reviewsensei review remaining" + suffix, "reply")
        self.assert_operation("@reviewsensei review remaining\t\r\n", "review")

    def test_current_command_prefilter_routes_without_granting_authority(self):
        commands = ["review status", "review pause", "review continue", "review reenroll", "verify",
                    "dismiss " + "a" * 16 + " --reason accepted locally",
                    "defer " + "a" * 64 + " --reason follow up",
                    "accept-risk " + "a" * 16 + " --reason accepted",
                    "accept-coverage-uncertainty --reason inspected",
                    "review accept-coverage-uncertainty --reason inspected",
                    "i reviewed the media files and i approve", "override rs-abcdef",
                    "override abcdef, rs-123456 acceptable risk", "abcdef is acceptable risk",
                    "abcdef, 123456 are acceptable risk",
                    "override " + ", ".join(["abcdef"] * 10)]
        for alias in ("@reviewsensei", "@ReviewSensei", "@sensei"):
            for command in commands:
                with self.subTest(alias=alias, command=command):
                    self.assert_operation(f"{alias} {command}\t\r\n", "command")
        # The caller deliberately does not validate reasons/actor authority; the runtime does.
        self.assert_operation('@reviewsensei accept-risk ' + 'a' * 16 + ' --reason ""', "command")

    def test_quoted_multiline_malformed_or_oversized_commands_stay_conversation(self):
        for body in ("please @reviewsensei verify", "> @reviewsensei verify", "`@reviewsensei verify`",
                     "text\n@reviewsensei verify", "@reviewsensei\nverify", " @reviewsensei verify",
                     "@reviewsensei review\npause", "@reviewsensei verify\nmore text",
                     "@reviewsensei review\u00a0pause", "@reviewsensei verify\u00a0",
                     "@reviewsensei override " + ",".join(["abcdef"] * 11),
                     "@reviewsensei dismiss abcdef --reason short id", "@reviewsensei accept-risk " + "a" * 16,
                     "@reviewsensei verify" + " " * 4096):
            with self.subTest(body=body[:100]):
                self.assert_operation(body, "reply")

    def test_unsupported_event_is_rejected(self):
        result, output = self.resolve("push")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
