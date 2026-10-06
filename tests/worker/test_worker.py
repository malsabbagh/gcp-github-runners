"""Offline lifecycle, control and image-input regression tests."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker_module = load('one_job_worker', 'startup/one-job-worker.py')
control = load('worker_control', 'startup/worker-control.py')
installer = load('install_runner', 'docker/install-runner.py')


def worker_identity():
    return {'allocationKey': 'a' * 64, 'reservationToken': '00000000-0000-4000-8000-000000000001',
            'repositoryOwner': 'example', 'repositoryName': 'fixture', 'runId': '1',
            'jobId': '2', 'attempt': '1', 'instanceId': '3', 'runnerId': 4,
            'runnerName': 'fixture-worker', 'incarnation': '2026-10-05T00:00:00.000Z'}


def operation(phase='drain'):
    w = worker_identity()
    return {'version': 1, 'dispatchId': '00000000-0000-4000-8000-000000000002',
            'phase': phase, 'evidenceSha256': 'b' * 64, 'binding': {
                'key': w['allocationKey'], 'token': w['reservationToken'], 'name': w['runnerName'],
                'zone': 'example-region1-a', 'project': 'example-project', 'instanceId': '3',
                'instanceCreationTimestamp': w['incarnation'],
                'claimId': '00000000-0000-4000-8000-000000000003', 'runnerId': 4,
                'runnerName': w['runnerName'], 'labels': ['self-hosted', 'fixture-route'],
                'receiptSha256': 'c' * 64}}


class ControlTests(unittest.TestCase):
    def test_only_exited_quiescent_listener_acknowledges(self):
        for phase in ('drain', 'stop'):
            for exit_code in (0, 1, -15):
                ack = control.acknowledge(operation(phase), worker_identity(),
                    types.SimpleNamespace(poll=lambda: exit_code), quiet=lambda: True)
                self.assertEqual(set(ack), {'worker', 'operation', 'state'})
                self.assertEqual(ack['state'], 'drained' if phase == 'drain' else 'stopped')
                self.assertNotIn('authenticated', ack)
                self.assertNotIn('completion_proof', ack)
            self.assertIsNone(control.acknowledge(operation(phase), worker_identity(),
                types.SimpleNamespace(poll=lambda: None), quiet=lambda: True))
            self.assertIsNone(control.acknowledge(operation(phase), worker_identity(),
                types.SimpleNamespace(poll=lambda: 0), quiet=lambda: False))

    def test_incarnation_and_allocation_fences(self):
        for field in ('key', 'token', 'name', 'instanceId', 'instanceCreationTimestamp', 'runnerId', 'runnerName', 'claimId', 'receiptSha256'):
            op = operation()
            op['binding'][field] = 99 if field == 'runnerId' else 'wrong'
            with self.assertRaises(ValueError):
                control.acknowledge(op, worker_identity(), types.SimpleNamespace(poll=lambda: 0), quiet=lambda: True)
        for field, value in [('version', 2), ('phase', 'delete'), ('dispatchId', '../x'), ('evidenceSha256', 'x')]:
            op = operation()
            op[field] = value
            with self.assertRaises(ValueError):
                control.envelope(op, worker_identity())

    def test_cgroup_descendants_unknown_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / 'self.cgroup'
            proc.write_text('0::/service\n')
            group = root / 'service'
            group.mkdir()
            (group / 'cgroup.procs').write_text(str(os.getpid()))
            self.assertTrue(control.cgroup_quiet(proc, root))
            descendant = group / 'job'
            descendant.mkdir()
            (descendant / 'cgroup.procs').write_text(str(os.getpid() + 1))
            self.assertFalse(control.cgroup_quiet(proc, root))
            (descendant / 'cgroup.procs').unlink()
            self.assertFalse(control.cgroup_quiet(proc, root))
            descendant.rmdir()
            (group / 'job').symlink_to(root, target_is_directory=True)
            self.assertFalse(control.cgroup_quiet(proc, root))
            proc.write_text('1:name=systemd:/service\n')
            self.assertFalse(control.cgroup_quiet(proc, root))

    def test_poll_refreshes_identity_and_retries_only_same_ack(self):
        calls, markers, identity_calls = [], [], []
        op = operation()
        def bounded(opener, request):
            calls.append((request.full_url, json.loads(request.data), request.headers))
            if request.full_url.endswith('/poll'):
                return json.dumps({'ok': True, 'operation': op}).encode()
            if len(calls) == 2:
                raise OSError('synthetic lost response')
            return b'{"ok":true}'
        sleeps = 0
        def sleep(delay):
            nonlocal sleeps
            sleeps += 1
            if sleeps == 2:
                raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            control.supervise(worker_identity(), types.SimpleNamespace(poll=lambda: 0),
                'https://broker.example.invalid/bootstrap',
                lambda path: identity_calls.append(path) or 'synthetic_assertion', bounded,
                object(), lambda name, value: markers.append((name, value)), sleep, lambda: True)
        self.assertEqual(len(markers), 1)
        self.assertEqual(calls[1][1], calls[3][1])
        self.assertEqual(len(identity_calls), 4)
        self.assertTrue(all('audience=https%3A%2F%2Fbroker.example.invalid%2Fbootstrap' in x for x in identity_calls))


class BootstrapTests(unittest.TestCase):
    def fixture(self, directory):
        state = Path(directory)
        state.chmod(0o700)
        runner = state / 'runner' / 'run.sh'
        runner.parent.mkdir()
        runner.write_text('#!/bin/sh\nexit 0\n')
        runner.chmod(0o755)
        identity = worker_identity()
        attrs = {'allocation-key': identity['allocationKey'], 'reservation-token': identity['reservationToken'],
            'repo-owner': 'example', 'repo-name': 'fixture', 'run-id': '1', 'job-id': '2', 'run-attempt': '1',
            'allocation-broker-url': 'https://broker.example.invalid/bootstrap', 'bootstrap-expires-at-ms': '200000'}
        def metadata(path):
            if path.startswith('instance/attributes/'):
                return attrs[path.split('/')[-1]]
            if path == 'instance/id':
                return '3'
            if path == 'instance/name':
                return 'fixture-worker'
            return 'synthetic_assertion'
        result = {'ok': True, 'allocationKey': identity['allocationKey'], 'instanceId': '3',
            'encodedJitConfig': 'synthetic_jit_fixture', 'runnerId': 4, 'runnerName': 'fixture-worker',
            'incarnation': identity['incarnation'], 'releaseBeforeMs': 190000}
        return state, runner, metadata, result

    def test_lost_exchange_response_is_consumed_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, runner, metadata, _ = self.fixture(tmp)
            operations = []
            def bounded(opener, request):
                op = request.get_header('X-bootstrap-operation')
                operations.append(op)
                if op == 'readiness':
                    return b'{"ok":true,"ready":true}'
                raise urllib.error.URLError('synthetic lost exchange')
            with patch.object(worker_module, 'STATE', state), patch.object(worker_module, 'RUNNER', runner), \
                    patch.object(worker_module, 'metadata', metadata), patch.object(worker_module, 'bounded', bounded), \
                    patch.object(worker_module.time, 'time', lambda: 100), patch.object(worker_module.sys, 'argv', ['worker']):
                with self.assertRaises(urllib.error.URLError):
                    worker_module.main()
                with self.assertRaises(FileExistsError):
                    worker_module.main()
            self.assertEqual(operations, ['readiness', 'exchange'])
            self.assertTrue((state / 'consumed-startup.json').exists())
            self.assertFalse((state / 'issued-runner.json').exists())

    def test_exactly_one_jit_listener_no_material_in_markers(self):
        class Done(Exception):
            pass
        with tempfile.TemporaryDirectory() as tmp:
            state, runner, metadata, result = self.fixture(tmp)
            operations, children, supervised = [], [], []
            def bounded(opener, request):
                op = request.get_header('X-bootstrap-operation')
                operations.append(op)
                return json.dumps({'ok': True, 'ready': True} if op == 'readiness' else result).encode()
            child = types.SimpleNamespace(wait=lambda: 0, poll=lambda: 0, pid=999999)
            def popen(argv, **kwargs):
                children.append((argv, kwargs))
                return child
            def supervise(*args):
                supervised.append(args)
                raise Done()
            control_module = types.SimpleNamespace(supervise=supervise)
            spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
            with patch.object(worker_module, 'STATE', state), patch.object(worker_module, 'RUNNER', runner), \
                    patch.object(worker_module, 'metadata', metadata), patch.object(worker_module, 'bounded', bounded), \
                    patch.object(worker_module.time, 'time', lambda: 100), patch.object(worker_module.sys, 'argv', ['worker']), \
                    patch.object(worker_module.subprocess, 'Popen', popen), patch.object(worker_module.signal, 'signal'), \
                    patch.object(worker_module.importlib.util, 'spec_from_file_location', lambda *args: spec), \
                    patch.object(worker_module.importlib.util, 'module_from_spec', lambda *args: control_module):
                with self.assertRaises(Done):
                    worker_module.main()
            self.assertEqual(operations, ['readiness', 'exchange'])
            self.assertEqual(len(children), 1)
            self.assertEqual(children[0][0], [str(runner), '--jitconfig', 'synthetic_jit_fixture'])
            self.assertEqual(children[0][1]['env'], {'PATH': '/usr/bin:/bin', 'HOME': str(state), 'LANG': 'C.UTF-8'})
            self.assertEqual(supervised[0][0], worker_identity())
            markers = '\n'.join(path.read_text() for path in state.glob('*.json'))
            self.assertNotIn('synthetic_jit_fixture', markers)
            self.assertNotIn('synthetic_assertion', markers)
            self.assertFalse(json.loads((state / 'local-exit.json').read_text())['completion_proof'])

    def test_private_marker_is_consumed_and_symlink_safe(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker_module, 'STATE', Path(tmp)):
            worker_module.private_marker('started.json', {'state': 'started'})
            path = Path(tmp) / 'started.json'
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                worker_module.private_marker('started.json', {})
            target = Path(tmp) / 'outside'
            target.write_text('untouched')
            (Path(tmp) / 'link.json').symlink_to(target)
            with self.assertRaises(FileExistsError):
                worker_module.private_marker('link.json', {})
            self.assertEqual(target.read_text(), 'untouched')

    def test_number_and_redirect_rejection(self):
        for value in ('0', '01', '-1', '１２', '1' * 21, '1\n'):
            with self.assertRaises(RuntimeError):
                worker_module.number(value)
        self.assertEqual(worker_module.number('3'), '3')
        with self.assertRaises(RuntimeError):
            worker_module.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid')


class ImageInstallerTests(unittest.TestCase):
    def archive(self, directory, extra=None):
        archive = directory / 'runner.tar.gz'
        with tarfile.open(archive, 'w:gz') as stream:
            for name in ('run.sh', 'bin/Runner.Listener'):
                member = tarfile.TarInfo(name)
                member.size = 4
                member.mode = 0o755
                stream.addfile(member, io.BytesIO(b'test'))
            if extra:
                stream.addfile(extra, io.BytesIO(b''))
        lock = json.loads((ROOT / 'docker/runner-release.json').read_text())
        lock['sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        path = directory / 'lock.json'
        path.write_text(json.dumps(lock))
        return path, archive

    def test_verified_archive_install_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock, archive = self.archive(root)
            target = root / 'runner'
            installer.install(lock, archive, target)
            self.assertEqual((target / 'run.sh').read_text(), 'test')
            self.assertTrue((target / 'release-provenance.json').exists())
            with self.assertRaises(ValueError):
                installer.install(lock, archive, target)

    def test_checksum_and_provenance_rejected_before_extract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock, archive = self.archive(root)
            archive.write_bytes(archive.read_bytes() + b'wrong')
            with self.assertRaisesRegex(ValueError, 'CHECKSUM'):
                installer.install(lock, archive, root / 'runner')
            self.assertFalse((root / 'runner').exists())
            value = json.loads(lock.read_text())
            value['url'] = 'https://other.invalid/runner'
            lock.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'RELEASE'):
                installer.install(lock, archive, root / 'runner')

    def test_traversal_link_device_setuid_and_credential_rejected(self):
        for name, kind, mode in [('../escape', tarfile.REGTYPE, 0o644),
                ('/escape', tarfile.REGTYPE, 0o644), ('link', tarfile.SYMTYPE, 0o644),
                ('device', tarfile.CHRTYPE, 0o644), ('privileged', tarfile.REGTYPE, 0o4755),
                ('.credentials', tarfile.REGTYPE, 0o600)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                member = tarfile.TarInfo(name)
                member.type, member.mode = kind, mode
                member.linkname = '../escape'
                lock, archive = self.archive(root, member)
                with self.assertRaises(ValueError):
                    installer.install(lock, archive, root / 'runner')
                self.assertFalse((root / 'runner').exists())


if __name__ == '__main__':
    unittest.main()
