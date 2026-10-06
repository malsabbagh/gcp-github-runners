"""Exercise the tracked Terraform cleanup argument without any cloud services."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class EmbeddingTests(unittest.TestCase):
    def test_terraform_cleanup_argument_executes_with_offline_gcloud(self):
        terraform = (ROOT / "terraform/main.tf").read_text()
        match = re.search(r'args\s*=\s*\["-c",\s*(replace\(file\("(\$\{path.module\}/[^"\n]+runner-cleanup\.sh)"\),\s*"\$",\s*"\$\$"\))\]', terraform)
        self.assertIsNotNone(match, "cleanup must embed the tracked shared reaper")
        source = (ROOT / "terraform" / match[2].removeprefix("${path.module}/")).resolve()
        self.assertEqual(source, ROOT / "cloudbuild/runner-cleanup.sh")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expression = match[1].replace(match[2], str(source))
            terraform_bin = os.environ.get("TERRAFORM_BIN")
            if terraform_bin:
                # Pure console expression: no backend/provider/state/config.
                result = subprocess.run([terraform_bin, f"-chdir={root}", "console"],
                    input="jsonencode(" + expression + ")\n", text=True, capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                encoded = json.loads(json.loads(result.stdout))
            else:
                # Terraform replace's literal arguments are asserted above.
                encoded = source.read_text().replace("$", "$$")
            # Cloud Build substitutes escaped dollar literals before bash runs.
            script = encoded.replace("$$", "$")
            self.assertEqual(script, source.read_text())
            syntax = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True, timeout=10)
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
            (root / "gcloud").write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\n"
                "Path(os.environ['FIXTURE_CALL']).write_text(json.dumps(sys.argv[1:]))\n"
                "if sys.argv[1:4] != ['compute','instances','list']: sys.exit(3)\nprint('[]')\n")
            (root / "gcloud").chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                FIXTURE_CALL=str(root / "call.json"), MAX_AGE_HOURS="2", REGION="")
            result = subprocess.run(["bash", "-c", script], env=env, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((root / "call.json").read_text()),
                ["compute", "instances", "list", "--filter=labels.purpose=github-runner", "--format=json"])


if __name__ == "__main__":
    unittest.main()
