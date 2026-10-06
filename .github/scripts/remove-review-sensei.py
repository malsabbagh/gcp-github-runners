"""Create the source-compatible removal PR with the verified repository owner's identity."""
import argparse
import os
import re
import subprocess
from pathlib import Path

VERIFIED_NAME = "malsabbagh"
VERIFIED_EMAIL = "malsabbagh@users.noreply.github.com"
PATHS = (
    ".github/workflows/review-sensei-review.yml",
    ".github/workflows/review-sensei-uninstall.yml",
    ".reviewsensei.yml",
    ".github/review-sensei/config.yml",
    ".github/scripts/remove-review-sensei.py",
    ".github/scripts/test-review-trigger.py",
    ".github/scripts/test-review-removal.py",
)


def remove(repository, default_branch, run_id, worktree, execute=subprocess.run):
    if not re.fullmatch(r"malsabbagh/[A-Za-z0-9._-]+", repository):
        raise ValueError("The verified owner identity does not match this repository.")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", default_branch) or default_branch.startswith("-"):
        raise ValueError("Invalid default branch.")
    if not re.fullmatch(r"[0-9]+", run_id):
        raise ValueError("Invalid workflow run ID.")
    branch = "review-sensei/uninstall-" + run_id
    environment = dict(os.environ, GIT_AUTHOR_NAME=VERIFIED_NAME,
                       GIT_AUTHOR_EMAIL=VERIFIED_EMAIL, GIT_COMMITTER_NAME=VERIFIED_NAME,
                       GIT_COMMITTER_EMAIL=VERIFIED_EMAIL)

    def run(*command, check=True):
        return execute(list(command), cwd=worktree, env=environment, check=check)

    run("git", "switch", "--create", branch)
    run("git", "rm", "--force", "--ignore-unmatch", "--", *PATHS)
    diff = run("git", "diff", "--cached", "--quiet", "--", *PATHS, check=False)
    if diff.returncode == 0:
        print("ReviewSensei setup files are already absent; no cleanup PR is needed.")
        return False
    if diff.returncode != 1:
        raise RuntimeError("Unable to inspect staged removal.")
    run("git", "-c", "user.name=" + VERIFIED_NAME, "-c", "user.email=" + VERIFIED_EMAIL,
        "-c", "commit.gpgsign=false", "commit", "-m", "Remove ReviewSensei setup")
    run("git", "push", "--set-upstream", "origin", branch)
    run("gh", "pr", "create", "--repo", repository, "--base", default_branch,
        "--head", branch, "--title", "Remove ReviewSensei setup", "--body",
        "Remove ReviewSensei setup files. This does not uninstall the App or revoke broker access.")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--default-branch", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--worktree", type=Path, default=Path.cwd())
    args = parser.parse_args()
    remove(args.repository, args.default_branch, args.run_id, args.worktree)
