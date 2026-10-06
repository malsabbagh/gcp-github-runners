#!/usr/bin/env python3
"""Export only non-secret runtime settings from Terraform; deployment is opt-in."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

RUNTIME_KEYS = set('''GOOGLE_CLOUD_PROJECT DEFAULT_ZONE INSTANCE_TEMPLATE_NAME MAX_RUNNER_VMS RUNNERS_PER_VM
FIRESTORE_DATABASE_ID VM_CREATION_TIMEOUT_SECONDS GITHUB_WEBHOOK_SECRET_VERSION GITHUB_APP_PRIVATE_KEY_VERSION
BUILDER_IMAGE WORKER_SERVICE_ACCOUNT WORKER_SERVICE_ACCOUNT_UNIQUE_ID ALLOCATION_BROKER_URL GITHUB_REPO_OWNER
GITHUB_REPO_NAME CLOUDBUILD_SERVICE_ACCOUNT RUNNER_LABELS_JSON REQUIRED_RUNNER_LABELS_B64 RUNNER_ROUTING_LABEL
GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_REPOSITORY_ID RUNNER_GROUP_ID JIT_RELEASE_WINDOW_MS CONTROLLER_AUDIENCE
ADMIN_SERVICE_ACCOUNT_UNIQUE_ID SCHEDULER_SERVICE_ACCOUNT_UNIQUE_ID WEBHOOK_ENABLED MANAGEMENT_ENABLED SCHEDULED_ENABLED
JIT_PROVIDER_LIFETIME_QUALIFIED APPROVED_QUIESCENCE DISPATCH_ENABLED WORKER_DRAIN_QUALIFIED WORKER_STOP_QUALIFIED
BOOTSTRAP_TTL_MS RECONCILIATION_BATCH_SIZE'''.split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deploy', action='store_true')
    parser.add_argument('--powershell', action='store_true')
    args = parser.parse_args()
    if args.deploy:
        raise ValueError('Direct deployment is unsupported. Terraform owns controller deployment; review terraform plan before applying it.')
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(['terraform', f'-chdir={root / "terraform"}', 'output', '-json', 'infrastructure_config'], check=True, capture_output=True, text=True)
    cfg = json.loads(result.stdout)
    env = cfg.get('runtime_environment')
    if not isinstance(env, dict) or not env:
        raise ValueError('Terraform infrastructure_config.runtime_environment is required; use the current Terraform module.')
    if env.get('RUNNERS_PER_VM') != '1':
        raise ValueError('Only one-job workers are supported.')
    for key, value in env.items():
        if key not in RUNTIME_KEYS or not isinstance(value, str) or chr(0) in value or '\n' in value or '\r' in value:
            raise ValueError('Invalid runtime environment entry.')
        # Secret *references* are allowed; plaintext authentication material is not.
        if re.search(r'(TOKEN|PASSWORD|PRIVATE_KEY|SECRET|API_KEY)$', key):
            raise ValueError('Plaintext authentication settings cannot be exported.')
    labels = cfg.get('required_runner_labels')
    if labels is not None:
        env['REQUIRED_RUNNER_LABELS_B64'] = base64.b64encode(json.dumps(labels, separators=(',', ':')).encode()).decode()
    destination = root / 'cloud-functions/webhook-handler'
    destination.mkdir(parents=True, exist_ok=True)
    shell = destination / ('.env.terraform.ps1' if args.powershell else '.env.terraform')
    lines = []
    for key, value in sorted(env.items()):
        if args.powershell:
            lines.append('$env:' + key + "='" + value.replace("'", "''") + "'")
        elif key == 'REQUIRED_RUNNER_LABELS_B64':
            lines.append(f'export {key}="{value}"')
        else:
            lines.append(f'export {key}={shlex.quote(value)}')
    # JSON is valid YAML and preserves commas in label arrays safely.
    envfile = destination / '.env.terraform.yaml'
    for path, content in [(shell, '\n'.join(lines) + '\n'), (envfile, json.dumps(env, indent=2) + '\n')]:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(content)
        path.chmod(0o600)
    print('Generated local runtime configuration (secret references only).')
    print('No deployment performed. Terraform owns controller deployment; review terraform plan before applying it.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        # Terraform/provider output can contain sensitive data. Report only the reason.
        print(str(error) if isinstance(error, ValueError) else 'Configuration command failed.', file=sys.stderr)
        sys.exit(1)
