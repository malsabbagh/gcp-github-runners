"""Install and exercise the standalone controller outside the repository; no provider calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    major = subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip()
    if major != '24':
        raise RuntimeError('Standalone qualification requires Node24.')
    subprocess.run(['node', 'packaging/check-controller.js'], cwd=ROOT, check=True)
    files = json.loads(subprocess.check_output(['node', '-e',
        'process.stdout.write(JSON.stringify(require("./packaging/assemble-controller").inputs()))'], cwd=ROOT, text=True))
    environment = {key: value for key, value in os.environ.items() if key not in ('NODE_PATH', 'NODE_OPTIONS')}
    with tempfile.TemporaryDirectory(prefix='runner-standalone-') as temporary:
        stage = Path(temporary).resolve() / 'controller'
        stage.mkdir()
        for file in files:
            relative = Path(file['path'])
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('Unsafe standalone input path.')
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as output:
                output.write(file['content'].encode('utf-8'))
            destination.chmod(file['mode'])
        lock = stage / 'package-lock.json'
        before = hashlib.sha256(lock.read_bytes()).hexdigest()
        subprocess.run(['npm', 'ci', '--ignore-scripts', '--engine-strict', '--no-audit', '--no-fund', '--workspaces=false'],
                       cwd=stage, env=environment, check=True)
        if hashlib.sha256(lock.read_bytes()).hexdigest() != before:
            raise RuntimeError('Standalone installation changed the reviewed lock.')
        subprocess.run(['node', '--test', str(ROOT / 'tests/dependencies/standalone.cjs')], cwd=stage,
                       env=dict(environment, CONTROLLER_QUALIFICATION_DIR=str(stage)), check=True)
        print('Standalone Node24 SDK, framework and disabled-route contracts passed from an independent lock install; no provider calls.')


if __name__ == '__main__':
    main()
