#!/usr/bin/env python3
"""Read-only source binding check for a dated integration observation; no test run."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_state_launcher',
    ROOT / 'tests/integration/run-state-integration.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tests/integration/observations.json'
    observation = json.loads(path.read_text())
    mismatches = launcher.verify_observation(ROOT, observation)
    print(json.dumps({'observation': str(path), 'recorded_date': observation.get('recorded_date'),
        'source_binding': 'historical-source-mismatch' if mismatches else 'matches',
        'mismatches': mismatches, 'recorded_results': observation.get('results'),
        'scope': 'Source freshness only; matching hashes do not mean integration passed or a new run occurred.'}))
    return int(bool(mismatches))


if __name__ == '__main__':
    raise SystemExit(main())
