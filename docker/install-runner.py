"""Install a SHA-verified upstream archive. Runs only during image baking.

No registration, provider credential, cloud API, or startup exchange occurs here.
"""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile


def release(lock):
    value = json.loads(Path(lock).read_text())
    if set(value) != {'version', 'architecture', 'url', 'sha256', 'provenance'} or \
            not re.fullmatch(r'2\.[0-9]+\.[0-9]+', value['version']) or \
            value['architecture'] != 'linux-x64' or \
            not re.fullmatch(r'[a-f0-9]{64}', value['sha256']):
        raise ValueError('RUNNER_RELEASE_INVALID')
    base = 'https://github.com/actions/runner/releases/'
    if value['url'] != base + 'download/v' + value['version'] + '/actions-runner-linux-x64-' + value['version'] + '.tar.gz' or \
            value['provenance'] != base + 'tag/v' + value['version']:
        raise ValueError('RUNNER_RELEASE_INVALID')
    return value


def install(lock, archive, destination):
    locked = release(lock)
    archive = Path(archive)
    with archive.open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1048576), b''):
            digest.update(chunk)
        digest = digest.hexdigest()
    if digest != locked['sha256']:
        raise ValueError('RUNNER_CHECKSUM_MISMATCH')
    target = Path(destination)
    if target.exists():
        raise ValueError('RUNNER_DESTINATION_EXISTS')
    # Reject paths, links and devices before creating anything. The official
    # archive contains ordinary files/directories, never a privileged installer.
    with tarfile.open(archive, 'r:gz') as stream:
        members = stream.getmembers()
        if not members or len(members) > 50000 or sum(m.size for m in members) > 2000000000:
            raise ValueError('RUNNER_ARCHIVE_INVALID')
        seen = set()
        for member in members:
            parts = Path(member.name).parts
            if member.name in ('.', './') and member.isdir():
                continue
            normalized = '/'.join(parts)
            if not parts or normalized in seen or Path(member.name).is_absolute() or '..' in parts or \
                    not (member.isfile() or member.isdir()) or member.mode & 0o6000:
                raise ValueError('RUNNER_ARCHIVE_INVALID')
            seen.add(normalized)
        names = {m.name.removeprefix('./') for m in members}
        if not {'run.sh', 'bin/Runner.Listener'}.issubset(names):
            raise ValueError('RUNNER_ARCHIVE_INVALID')
        if any(name in names for name in ('.runner', '.credentials', '.credentials_rsaparams')):
            raise ValueError('RUNNER_ALREADY_CONFIGURED')
        target.mkdir(mode=0o700)
        # We prevalidated every member; Python 3.11's tarfile lacks filter=data.
        stream.extractall(target, members=members)
    (target / 'release-provenance.json').write_text(json.dumps(locked, sort_keys=True) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('usage: install-runner.py LOCK ARCHIVE NEW_DIRECTORY')
    install(*sys.argv[1:])
