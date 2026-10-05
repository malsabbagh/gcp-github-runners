"""Local stop evidence only. Does not deregister/delete or mark job completed."""
import json
import os
from pathlib import Path
import sys
import time


def main():
    os.umask(0o077)
    if os.geteuid() == 0:
        raise RuntimeError('WORKER_STOP_UNAVAILABLE')
    directory = Path('/var/lib/ephemeral-runner')
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise RuntimeError('WORKER_STOP_UNAVAILABLE')
    path = directory / 'local-stop-requested.json'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return
    with os.fdopen(fd, 'w') as stream:
        json.dump({'at_ms': int(time.time() * 1000), 'completion_proof': False}, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('WORKER_STOP_UNAVAILABLE', file=sys.stderr)
        raise SystemExit(1)
