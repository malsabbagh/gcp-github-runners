#!/usr/bin/env python3
"""Stage or verify the allowlisted worker-image build inputs; never upload/build."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys

ROOT = Path(__file__).absolute().parent.parent
CONTRACT = Path(__file__).with_suffix('.json')
RECEIPT = 'worker-image-source-manifest.json'


def fail(reason):
    raise ValueError(reason)


def no_links(path):
    for parent in reversed((path, *path.parents)):
        if parent.is_symlink():
            fail('symlink path: ' + str(parent))


def inventory():
    value = json.loads(CONTRACT.read_text())
    if value.get('schemaVersion') != 1 or not isinstance(value.get('files'), list) or not value['files']:
        fail('invalid image source contract')
    files = {}
    for row in value['files']:
        name = row['path']
        if not re.fullmatch(r'[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*', name) or \
                any(part in ('', '.', '..') for part in name.split('/')) or \
                name in files or name in (RECEIPT, '.gcloudignore') or row['mode'] not in ('0644', '0755'):
            fail('invalid image source path or mode')
        files[name] = row['mode']
    return files


def directories(names):
    return {parent.as_posix() for name in names for parent in Path(name).parents if parent != Path('.')}


def read_regular(path, mode):
    no_links(path)
    if not stat.S_ISREG(path.stat().st_mode):
        fail('unexpected file type: ' + str(path))
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != int(mode, 8):
            fail('unexpected file type or mode: ' + str(path))
        return stream.read()


def payloads(source):
    no_links(source)
    files = inventory()
    result = {name: (read_regular(source / name, mode), mode) for name, mode in files.items()}
    names = {*files, '.gcloudignore', RECEIPT}
    # A second boundary if an operator accidentally adds files after verification.
    rules = ['# Generated image source allowlist. Do not edit.', '/*']
    for name in sorted(directories(names)):
        rules += ['!/' + name + '/', '/' + name + '/*']
    rules += ['!/' + name for name in sorted(names)]
    result['.gcloudignore'] = (('\n'.join(rules) + '\n').encode(), '0644')
    rows = [{'path': name, 'mode': mode, 'sha256': hashlib.sha256(data).hexdigest()}
            for name, (data, mode) in sorted(result.items())]
    result[RECEIPT] = ((json.dumps({'schemaVersion': 1, 'files': rows}, indent=2) + '\n').encode(), '0644')
    return result


def verify(stage, expected):
    no_links(stage)
    if not stage.is_dir():
        fail('image source stage is not a directory')
    found_files, found_dirs = set(), set()
    for current, dirs, files in os.walk(stage, followlinks=False):
        for name in dirs + files:
            path = Path(current) / name
            if path.is_symlink():
                fail('symlink in image source stage')
            relative = path.relative_to(stage).as_posix()
            if path.is_dir():
                found_dirs.add(relative)
            else:
                found_files.add(relative)
    if found_files != set(expected) or found_dirs != directories(expected):
        fail('image source inventory mismatch')
    for name, (data, mode) in expected.items():
        if read_regular(stage / name, mode) != data:
            fail('image source content mismatch: ' + name)


def stage_source(stage, expected):
    no_links(stage)
    if stage.exists():
        fail('image source destination already exists')
    stage.parent.mkdir(parents=True, exist_ok=True)
    stage.mkdir(mode=0o755)
    try:
        stage.chmod(0o755)
        for name in sorted(directories(expected)):
            (stage / name).mkdir(mode=0o755, parents=True, exist_ok=True)
            (stage / name).chmod(0o755)
        for name, (data, mode) in expected.items():
            with (stage / name).open('xb') as stream:
                stream.write(data)
            (stage / name).chmod(int(mode, 8))
        verify(stage, expected)
    except Exception:
        shutil.rmtree(stage)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('stage', 'verify'))
    parser.add_argument('--source-root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True, help='new stage directory (or existing stage to verify)')
    args = parser.parse_args()
    source, stage = args.source_root.absolute(), args.output.absolute()
    try:
        if '..' in args.source_root.parts or '..' in args.output.parts:
            fail('path traversal in source or destination')
        expected = payloads(source)
        if args.command == 'stage':
            stage_source(stage, expected)
        else:
            verify(stage, expected)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('Image source rejected: ' + str(error), file=sys.stderr)
        return 1
    print(json.dumps({'ok': True, 'fileCount': len(expected),
                      'manifestSha256': hashlib.sha256(expected[RECEIPT][0]).hexdigest()}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
