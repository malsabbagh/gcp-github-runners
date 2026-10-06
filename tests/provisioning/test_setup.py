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
              max_runner_vms=2, runner_count=8, webhook_handler_service_account="example-project",
              cloudbuild_service_account="example-project", github_repo_owner="example",
              github_repo_name="repo", machine_type="e2-medium", required_runner_labels=["self-hosted", "linux"])
CONFIG.update(region="us-central1", webhook_handler_name="runner-webhook", service_accounts={"controller": "example-project"}, required_runner_labels=["self-hosted", "linux"], runtime_environment={
    "GOOGLE_CLOUD_PROJECT": "synthetic", "DEFAULT_ZONE": "synthetic-a", "INSTANCE_TEMPLATE_NAME": "generated-template-abc",
    "MAX_RUNNER_VMS": "2", "RUNNERS_PER_VM": "1", "GITHUB_REPO_OWNER": "example", "GITHUB_REPO_NAME": "repo",
    "GITHUB_WEBHOOK_SECRET_VERSION": "projects/synthetic/secrets/github-webhook/versions/1", "CLOUDBUILD_SERVICE_ACCOUNT": "example-project"})
URL = "https://example.invalid/managed-trigger?key=synthetic-key&secret=synthetic%26secret"


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in ["scripts", "terraform", "cloud-functions/webhook-handler", "bin"]:
            (self.root / path).mkdir(parents=True)
        for name in ["setup-webhook.sh", "sync-terraform-config.sh", "setup-webhook.ps1", "sync-terraform-config.ps1", "sync-terraform-config.py", "management.py"]:
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
        for expected in ["generated-template-abc", "example-project", "GITHUB_REPO_OWNER", "MAX_RUNNER_VMS", "GITHUB_WEBHOOK_SECRET_VERSION"]:
            self.assertIn(expected, result.stdout + data)
        import re
        encoded = re.search(r"REQUIRED_RUNNER_LABELS_B64=[\"']([A-Za-z0-9+/=]+)[\"']", data).group(1)
        self.assertEqual(json.loads(base64.b64decode(encoded)), CONFIG["required_runner_labels"])

    def test_shell_sync_preserves_managed_contract(self):
        self.check_sync("sync-terraform-config.sh")

    def test_sync_accepts_actual_terraform_runtime_key_contract(self):
        import re
        source = (ROOT / 'terraform/main.tf').read_text()
        block = source[source.index('runtime_environment = {'):source.index('\nresource "google_project_service"')]
        keys = re.findall(r'^\s+([A-Z][A-Z0-9_]*)\s*=', block, re.M)
        self.assertIn('GITHUB_APP_INSTALLATION_ID', keys)
        self.assertIn('WEBHOOK_ENABLED', keys)
        config = json.loads(json.dumps(CONFIG))
        config['runtime_environment'] = {key: 'synthetic' for key in keys}
        config['runtime_environment']['RUNNERS_PER_VM'] = '1'
        self.env['FIXTURE_CONFIG'] = json.dumps(config)
        result = self.run_script('sync-terraform-config.sh')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = json.loads((self.root / 'cloud-functions/webhook-handler/.env.terraform.yaml').read_text())
        self.assertEqual(set(output), set(keys))

    def test_sync_refuses_secret_values_and_shared_workers_before_writing(self):
        for changes in [{"RUNNERS_PER_VM": "8"}, {"GITHUB_TOKEN": "synthetic-token"}]:
            config = json.loads(json.dumps(CONFIG))
            config["runtime_environment"].update(changes)
            self.env["FIXTURE_CONFIG"] = json.dumps(config)
            result = self.run_script("sync-terraform-config.sh")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.root / "cloud-functions/webhook-handler/.env.terraform").exists())
            self.assertNotIn("synthetic-token", result.stdout + result.stderr)

    def test_management_validation_does_not_invoke_cloud_or_authenticate(self):
        request = self.root / "request.local.json"
        request.write_text('{}')
        result = subprocess.run(["python3", str(self.root / "scripts/management.py"), "scheduled", "--request", str(request)],
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "gcloud.json").exists())
        self.assertFalse((self.root / "request.json").exists())

    def test_management_requires_exact_fenced_request(self):
        request = self.root / "request.local.json"
        request.write_text('{"request":{"name":"runner-example"}}')
        result = subprocess.run(["python3", str(self.root / "scripts/management.py"), "retire", "--request", str(request)],
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "gcloud.json").exists())

    def test_management_execute_requires_existing_identity_token(self):
        request = self.root / "request.local.json"
        request.write_text('{}')
        result = subprocess.run(["python3", str(self.root / "scripts/management.py"), "scheduled", "--request", str(request),
                                 "--execute", "--controller-url", "https://example.invalid"],
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "gcloud.json").exists())

    def test_management_preserves_terraform_function_url_base(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('management', ROOT / 'scripts/management.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        url = 'https://us-central1-example-project.cloudfunctions.net/runner-controller'
        self.assertEqual(module.endpoint(url, 'scheduled'), url + '/management/scheduled')
        for suffix in ['/../other', '?key=synthetic', '#fragment', '/%2Fother']:
            with self.assertRaises(ValueError):
                module.endpoint(url + suffix, 'scheduled')

    def test_powershell_sync_preserves_managed_contract_without_deployment(self):
        self.check_sync("sync-terraform-config.ps1")
        self.assertFalse((self.root / "gcloud.json").exists())
        environment = json.loads((self.root / "cloud-functions/webhook-handler/.env.terraform.yaml").read_text())
        self.assertEqual(environment["GITHUB_REPO_OWNER"], "example")
        self.assertEqual(environment["RUNNERS_PER_VM"], "1")

    def test_sync_rejects_direct_deployment(self):
        for script, argument in [("sync-terraform-config.sh", "--deploy"), ("sync-terraform-config.ps1", "-Deploy")]:
            result = self.run_script(script, argument)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.root / "gcloud.json").exists())


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

    def test_powershell_secret_reference_default_is_masked_and_round_trips(self):
        source = (ROOT / "scripts/setup.ps1").read_text()
        block = source[source.index('$defaults = @{}'):source.index('# Prompt for config')]
        checker = self.root / "api-key.ps1"
        checker.write_text("""$ErrorActionPreference = 'Stop'
$tfvarsPath = Join-Path $env:FIXTURE_ROOT 'existing.tfvars'
""" + block + """
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors)
$helper = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Read-SecretReference'}, $false)
Invoke-Expression $helper.Extent.Text
function Read-Host { param($Prompt, [switch]$AsSecureString)
 if (($Prompt -notmatch '\\*\\*\\*masked\\*\\*\\*' -and $env:FIXTURE_REQUIRE_MASK -eq '1') -or ($env:FIXTURE_REQUIRE_MASK -eq '1' -and $Prompt.Contains($env:FIXTURE_VALUE))) { throw 'unsafe prompt' }
 $secure = New-Object Security.SecureString
 foreach ($c in $env:FIXTURE_RESPONSE.ToCharArray()) { $secure.AppendChar($c) }
 return $secure
}
try { $value = Read-SecretReference -DefaultValue $defaults['webhook_secret_version']; if ($value -cne $env:FIXTURE_EXPECTED) { throw 'unexpected key' } }
catch { Write-Output $_.Exception.Message; exit 2 }
""")
        value = 'synthetic"${literal}%{literal}\\value'
        (self.root / "existing.tfvars").write_text('webhook_secret_version = ' + json.dumps(value.replace('${', '$${').replace('%{', '%%{')) + '\n')
        self.env.update(FIXTURE_VALUE=value, FIXTURE_RESPONSE="", FIXTURE_EXPECTED=value, FIXTURE_REQUIRE_MASK="1")
        for response in ["", "synthetic-replacement"]:
            self.env.update(FIXTURE_RESPONSE=response, FIXTURE_EXPECTED=response or value)
            result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn(value, result.stdout + result.stderr)
        self.env["FIXTURE_RESPONSE"] = " \t "
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("Secret reference cannot be whitespace", result.stdout)
        (self.root / "existing.tfvars").write_text('')
        self.env["FIXTURE_RESPONSE"] = ""
        self.env["FIXTURE_REQUIRE_MASK"] = "0"
        result = subprocess.run([self.pwsh(), "-NoLogo", "-NoProfile", "-File", str(checker), str(ROOT / "scripts/setup.ps1")], env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("Secret reference is required", result.stdout)

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
            literal = next(line.split(" = ", 1)[1] for line in data.splitlines() if line.startswith("webhook_secret_version = "))
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
        literal = next(line.split(" = ", 1)[1] for line in result.stdout.splitlines() if line.startswith("github_app_private_key_secret_version = "))
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
