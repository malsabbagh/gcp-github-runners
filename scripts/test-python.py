#!/usr/bin/env python3
"""Discover every Python regression directory and fail on skipped tests."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CHILD = """
import sys, unittest
suite = unittest.TestLoader().discover(sys.argv[1], pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=1).run(suite)
if result.skipped:
    print('Incomplete Python qualification: skipped tests are failures.', file=sys.stderr)
sys.exit(0 if result.wasSuccessful() and not result.skipped else 1)
"""


def main():
    directories = sorted({path.parent for path in (ROOT / 'tests').rglob('test_*.py')
                          if not any(part in ('node_modules', '__pycache__') for part in path.parts)})
    if not directories:
        print('No Python regression suites found.', file=sys.stderr)
        return 1
    failures = 0
    for directory in directories:
        print(f'Python suite: {directory.relative_to(ROOT)}', flush=True)
        result = subprocess.run([sys.executable, '-B', '-c', CHILD, str(directory)], cwd=ROOT)
        failures += result.returncode != 0
    return int(failures != 0)


if __name__ == '__main__':
    raise SystemExit(main())
