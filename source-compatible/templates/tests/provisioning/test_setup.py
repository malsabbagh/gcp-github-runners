"""Execute setup paths against isolated CLI fixtures; never contact a cloud API."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CONFIG = dict(project_id="synthetic", zone="synthetic-a", instance_template_name="generated-template-abc",
              max_runner_vms=2, runner_count=8, webhook_handler_service_account="PARITY_INPUT_116",
              cloudbuild_service_account="PARITY_INPUT_186", github_repo_owner="example",
              github_repo_name="repo", machine_type="e2-medium", required_runner_labels=["self-hosted", "linux"])
URL = "https://example.invalid/managed-trigger?key=synthetic-key&secret=synthetic%26secret"


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in ["scripts", "terraform", "cloud-functions/webhook-handler", "bin"]:
            (self.root / path).mkdir(parents=True)
        for name in ["setup-webhook.sh", "sync-terraform-config.sh", "setup-webhook.ps1", "sync-terraform-config.ps1"]:
            shutil.copyfile(ROOT / "scripts" / name, self.root / "scripts" / name)
        (self.root / "terraform/main.tf").touch()
        self.env = dict(os.environ, PATH=str(self.root / "bin") + ":" + os.environ["PATH"],
                        FIXTURE_ROOT=str(self.root), FIXTURE_URL=URL, FIXTURE_CONFIG=json.dumps(CONFIG))
        self.cli("terraform", "import os,sys\nprint(os.environ['FIXTURE_CONFIG'] if 'infrastructure_config' in sys.argv else os.environ['FIXTURE_URL'] if 'webhook_url' in sys.argv else 'managed-trigger')")
        self.cli("gcloud", "import os,sys,json\nfrom pathlib import Path\nPath(os.environ['FIXTURE_ROOT']+'/gcloud.json').write_text(json.dumps(sys.argv[1:]))")
        self.cli("gh", "import os,sys\nfrom pathlib import Path\nif 'api' in sys.argv:\n Path(os.environ['FIXTURE_ROOT']+'/request.json').write_text(sys.stdin.read())\n print('credential-bearing synthetic response')\n sys.exit(int(os.environ.get('FIXTURE_GH_EXIT','0')))\n")

    def cli(self, name, body):
        path = self.root / "bin" / name
        path.write_text("#!/usr/bin/env python3\n" + body + "\n")
        path.chmod(0o755)

    def run_script(self, name, *args, input=""):
        runtime = ["bash"] if name.endswith(".sh") else [self.pwsh(), "-NoLogo", "-NoProfile", "-File"]
        return subprocess.run([*runtime, str(self.root / "scripts" / name), *args], env=self.env,
                              cwd=self.root / "terraform", input=input, text=True, capture_output=True, timeout=20)

    def pwsh(self):
        binary = os.environ.get("POWERSHELL_BIN") or shutil.which("pwsh")
        if not binary:
            self.skipTest("PowerShell parser not installed; set POWERSHELL_BIN for local qualification")
        return binary

    def test_shell_webhook_uses_managed_authenticated_endpoint_and_hides_response(self):
        result = self.run_script("setup-webhook.sh", input="example\nrepo\nsynthetic-webhook-secret\nn\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        request = json.loads((self.root / "request.json").read_text())
        self.assertEqual(request["config"]["url"], URL)
        self.assertEqual(request["config"]["secret"], "synthetic-webhook-secret")
        self.assertEqual(request["events"], ["workflow_job"])
        self.assertNotIn(URL, result.stdout)
        self.assertNotIn("credential-bearing", result.stdout)

    def test_shell_missing_authenticated_output_fails_before_github_write(self):
        self.env["FIXTURE_URL"] = ""
        result = self.run_script("setup-webhook.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "request.json").exists())

    def check_sync(self, name, *args):
        result = self.run_script(name, *args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        envfile = self.root / ("cloud-functions/webhook-handler/.env.terraform" + (".ps1" if name.endswith(".ps1") else ""))
        data = envfile.read_text(encoding="utf-8-sig")
        for expected in ["generated-template-abc", "PARITY_INPUT_186", "GITHUB_REPO_OWNER", "MAX_RUNNER_VMS", "GITHUB_WEBHOOK_SECRET_NAME"]:
            self.assertIn(expected, result.stdout + data)
        import re
        encoded = re.search(r'REQUIRED_RUNNER_LABELS_B64="([A-Za-z0-9+/=]+)"', data).group(1)
        self.assertEqual(json.loads(base64.b64decode(encoded)), CONFIG["required_runner_labels"])

    def test_shell_sync_preserves_managed_contract(self):
        self.check_sync("sync-terraform-config.sh")

    def test_powershell_sync_deploy_uses_runtime_identity_and_managed_contract(self):
        self.check_sync("sync-terraform-config.ps1", "-Deploy")
        args = json.loads((self.root / "gcloud.json").read_text())
        self.assertIn("--service-account=PARITY_INPUT_116", args)
        self.assertTrue(any("REQUIRED_RUNNER_LABELS_B64=" in a and "GITHUB_REPO_OWNER=example" in a for a in args))

    def test_powershell_changed_scripts_parse(self):
        script = """$failures = 0
foreach ($path in $args) {
 $tokens = $null; $errors = $null
 $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
 foreach ($e in $errors) { Write-Output ($path + ': ' + $e.Message); $failures++ }
}
exit $failures
"""
        checker = self.root / "parse.ps1"
        checker.write_text(script)
        files = [ROOT / "scripts" / n for n in ["setup.ps1", "setup-webhook.ps1", "sync-terraform-config.ps1"]]
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), *map(str, files)], text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_powershell_api_key_default_is_masked_and_round_trips(self):
        source = (ROOT / "scripts/setup.ps1").read_text()
        block = source[source.index('$defaults = @{}'):source.index('# Prompt for config')]
        checker = self.root / "api-key.ps1"
        checker.write_text("""$ErrorActionPreference = 'Stop'
$tfvarsPath = Join-Path $env:FIXTURE_ROOT 'existing.tfvars'
""" + block + """
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
$helper = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Read-WebhookApiKey'}, $false)
Invoke-Expression $helper.Extent.Text
function Read-Host { param($Prompt, [switch]$AsSecureString)
 if ($Prompt -notmatch '\\*\\*\\*masked\\*\\*\\*' -or $Prompt.Contains($env:FIXTURE_VALUE)) { throw 'unsafe prompt' }
 $secure = New-Object Security.SecureString
 foreach ($c in $env:FIXTURE_RESPONSE.ToCharArray()) { $secure.AppendChar($c) }
 return $secure
}
try { $value = Read-WebhookApiKey -DefaultValue $defaults['webhook_api_key']; if ($value -cne $env:FIXTURE_EXPECTED) { throw 'unexpected key' } }
catch { Write-Output $_.Exception.Message; exit 2 }
""")
        value = 'synthetic"${literal}%{literal}\\value'
        (self.root / "existing.tfvars").write_text('webhook_api_key = ' + json.dumps(value.replace('${', '$${').replace('%{', '%%{')) + '\n')
        self.env.update(FIXTURE_VALUE=value, FIXTURE_RESPONSE="", FIXTURE_EXPECTED=value)
        for response in ["", "synthetic-replacement"]:
            self.env.update(FIXTURE_RESPONSE=response, FIXTURE_EXPECTED=response or value)
            result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn(value, result.stdout + result.stderr)
        self.env["FIXTURE_RESPONSE"] = " \t "
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("API Key cannot be whitespace", result.stdout)
        (self.root / "existing.tfvars").write_text('')
        self.env["FIXTURE_RESPONSE"] = ""
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("API Key is required", result.stdout)

    def test_shell_tfvars_quotes_special_characters_without_expansion(self):
        import re
        value = 'synthetic"${operator-value}\n%{directive}$(false)'
        self.env["FIXTURE_VALUE"] = value
        for name in ["setup.sh", "setup-clean.sh"]:
            source = (ROOT / "scripts" / name).read_text()
            helper = re.search(r'^hcl_string\(\) \{.*?^\}', source, re.M | re.S).group(0)
            result = subprocess.run(["bash", "-c", helper + '\nhcl_string "$FIXTURE_VALUE"'], env=self.env, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), value.replace("${", "$${").replace("%{", "%%{"))

    def test_powershell_tfvars_quotes_special_characters_without_expansion(self):
        value = 'synthetic"${operator-value}\n%{directive}$(false)'
        self.env["FIXTURE_VALUE"] = value
        checker = self.root / "quote.ps1"
        checker.write_text("""$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
$helper = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'ConvertTo-HclString'}, $false)
Invoke-Expression $helper.Extent.Text
ConvertTo-HclString $env:FIXTURE_VALUE
""")
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), value.replace("${", "$${").replace("%{", "%%{"))

    def test_shell_actual_tfvars_block_does_not_execute_operator_strings(self):
        import re
        value = 'synthetic"${operator-value}\n%{directive}$(touch "$FIXTURE_ROOT/sentinel")'
        self.env["FIXTURE_VALUE"] = value
        for name in ["setup.sh", "setup-clean.sh"]:
            source = (ROOT / "scripts" / name).read_text()
            helper = re.search(r'^hcl_string\(\) \{.*?^\}', source, re.M | re.S).group(0)
            block = source[source.index('cat > terraform.tfvars << EOF'):]
            block = block[:block.index('\nEOF') + len('\nEOF')]
            variables = set(re.findall(r'hcl_string "\$([a-z_]+)"', block))
            fixture = helper + '\n' + '\n'.join(v + '="$FIXTURE_VALUE"' for v in variables) + '\n' + block
            result = subprocess.run(["bash", "-c", fixture], env=self.env, cwd=self.root, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = (self.root / "terraform.tfvars").read_text()
            literal = next(line.split(" = ", 1)[1] for line in data.splitlines() if line.startswith("github_webhook_secret = "))
            self.assertEqual(json.loads(literal), value.replace("${", "$${").replace("%{", "%%{"))
            self.assertFalse((self.root / "sentinel").exists())

    def test_powershell_actual_tfvars_block_preserves_operator_strings(self):
        import re
        value = 'synthetic"${operator-value}\n%{directive}$(throw "operator string executed")'
        self.env["FIXTURE_VALUE"] = value
        source = (ROOT / "scripts/setup.ps1").read_text()
        block = source[source.index('$tfvarsContent = @"'):]
        block = block[:block.index('\n"@') + len('\n"@')]
        variables = set(re.findall(r'ConvertTo-HclString \$([A-Z_]+)', block))
        checker = self.root / "actual-quote.ps1"
        checker.write_text("""$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
$helper = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'ConvertTo-HclString'}, $false)
Invoke-Expression $helper.Extent.Text
""" + '\n'.join('$' + v + ' = $env:FIXTURE_VALUE' for v in variables) + '\n' + block + '\nWrite-Output $tfvarsContent\n')
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        literal = next(line.split(" = ", 1)[1] for line in result.stdout.splitlines() if line.startswith("github_pat = "))
        self.assertEqual(json.loads(literal), value.replace("${", "$${").replace("%{", "%%{"))

    def test_powershell_webhook_cli_failure_is_not_reported_successfully(self):
        checker = self.root / "webhook.ps1"
        checker.write_text("""$ErrorActionPreference = 'Stop'
$Red = 'Red'; $Green = 'Green'; $Yellow = 'Yellow'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
$definitions = $ast.FindAll({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false) | ForEach-Object { $_.Extent.Text }
Invoke-Expression ($definitions -join "`n")
try { Set-GitHubWebhook -WebhookUrl $env:FIXTURE_URL -RepoOwner example -RepoName repo -WebhookSecret 'synthetic-secret' } catch { Write-Output $_.Exception.Message; exit 2 }
""")
        for code in [0, 1]:
            self.env["FIXTURE_GH_EXIT"] = str(code)
            result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(self.root / "scripts/setup-webhook.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0 if code == 0 else 2, result.stdout + result.stderr)
            self.assertNotIn("credential-bearing", result.stdout)
            self.assertNotIn(URL, result.stdout)
            self.assertEqual(json.loads((self.root / "request.json").read_text())["config"]["url"], URL)


if __name__ == "__main__":
    unittest.main()
