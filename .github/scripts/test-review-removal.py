"""Compare removal command behavior offline; external commands are intercepted."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('removal', Path(__file__).with_name('remove-review-sensei.py'))
REMOVAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REMOVAL)
REPOSITORY = REMOVAL.VERIFIED_NAME + "/gcp-github-runners"


class RemovalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git('init', '--initial-branch=main')
        self.git('config', 'user.name', REMOVAL.VERIFIED_NAME)
        self.git('config', 'user.email', REMOVAL.VERIFIED_EMAIL)
        for name in REMOVAL.PATHS:
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('sample\n')
        (self.root / 'keep.txt').write_text('retained\n')
        self.git('-c', 'commit.gpgsign=false', 'add', '.')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture')
        self.calls = []

    def git(self, *args):
        env = dict(os.environ, GIT_AUTHOR_NAME=REMOVAL.VERIFIED_NAME,
                   GIT_AUTHOR_EMAIL=REMOVAL.VERIFIED_EMAIL,
                   GIT_COMMITTER_NAME=REMOVAL.VERIFIED_NAME,
                   GIT_COMMITTER_EMAIL=REMOVAL.VERIFIED_EMAIL)
        return subprocess.run(['git', *args], cwd=self.root, env=env, check=True,
                              text=True, capture_output=True)

    def execute(self, command, **kwargs):
        self.calls.append(command)
        if command[:2] == ['git', 'push'] or command[0] == 'gh':
            return subprocess.CompletedProcess(command, 0)
        return subprocess.run(command, **kwargs, text=True, capture_output=True)

    def test_source_branch_removal_commit_push_pr_behavior_and_owner_identity(self):
        self.assertTrue(REMOVAL.remove(REPOSITORY, 'main', '123', self.root, self.execute))
        self.assertEqual(self.git('branch', '--show-current').stdout.strip(), 'review-sensei/uninstall-123')
        self.assertEqual(self.git('show', '-s', '--format=%an <%ae> | %cn <%ce>').stdout.strip(),
                         f"{REMOVAL.VERIFIED_NAME} <{REMOVAL.VERIFIED_EMAIL}> | {REMOVAL.VERIFIED_NAME} <{REMOVAL.VERIFIED_EMAIL}>")
        self.assertTrue((self.root / 'keep.txt').is_file())
        self.assertFalse(any((self.root / p).exists() for p in REMOVAL.PATHS))
        self.assertEqual(self.calls[-2], ['git', 'push', '--set-upstream', 'origin', 'review-sensei/uninstall-123'])
        self.assertEqual(self.calls[-1][:8], ['gh', 'pr', 'create', '--repo', REPOSITORY, '--base', 'main', '--head'])

    def test_already_removed_setup_does_not_commit_push_or_create_pr(self):
        self.git('rm', '--', *REMOVAL.PATHS)
        self.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Already removed')
        self.assertFalse(REMOVAL.remove(REPOSITORY, 'main', '124', self.root, self.execute))
        self.assertFalse(any(c[:2] == ['git', 'push'] or c[0] == 'gh' for c in self.calls))

    def test_invalid_identity_or_untrusted_metadata_never_runs_commands(self):
        for repo, branch, run in [('different-owner/repo', 'main', '1'),
                                 (REMOVAL.VERIFIED_NAME + "/repo", '--bad', '1'),
                                 (REMOVAL.VERIFIED_NAME + "/repo", 'main\nother', '1'),
                                 (REMOVAL.VERIFIED_NAME + "/repo", 'main', '1;bad')]:
            with self.subTest(repo=repo, branch=branch, run=run):
                with self.assertRaises(ValueError):
                    REMOVAL.remove(repo, branch, run, self.root, self.execute)
        self.assertEqual(self.calls, [])

    def test_local_failure_cannot_push_or_create_pr(self):
        self.git('switch', '-c', 'review-sensei/uninstall-125')
        with self.assertRaises(subprocess.CalledProcessError):
            REMOVAL.remove(REPOSITORY, 'main', '125', self.root, self.execute)
        self.assertFalse(any(c[:2] == ['git', 'push'] or c[0] == 'gh' for c in self.calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
