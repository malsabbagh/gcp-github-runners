import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "cloud-functions/webhook-handler/provision-runner.py"
spec = importlib.util.spec_from_file_location("provision", SOURCE)
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class FakePool:
    def __init__(self, entries):
        self.entries = entries
        self.jobs = {}

    def mutate(self, fn, job_key=None):
        candidate = json.loads(json.dumps(self.entries))
        job = json.loads(json.dumps(self.jobs.get(job_key, {})))
        result = fn(candidate, job) if job_key else fn(candidate)
        if job_key:
            self.jobs[job_key] = job
        self.entries.clear()
        self.entries.update(candidate)
        return result

    def waiting(self):
        return [job for job in self.jobs.values() if job.get("state") == "waiting" and not job.get("done")]


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.entries, self.live, self.calls, self.builds = {}, set(), [], {}
        self.env = dict(ACTION="queued", REPO_OWNER="example", REPO_NAME="repo", ALLOWED_OWNER="example", ALLOWED_REPO="repo",
            RUN_ID="20", JOB_ID="10", RUN_ATTEMPT="1", JOB_LABELS='["self-hosted"]', PROJECT_ID="synthetic",
            ZONE="synthetic-a", BUILD_ID="direct-build-1", INSTANCE_TEMPLATE="synthetic-template-unique", MAX_RUNNER_VMS="2")
        self.pool = FakePool(self.entries)

    def command(self, args):
        self.calls.append(args)
        if args[:2] == ["auth", "print-access-token"]:
            return "synthetic-access-token"
        if args[:3] == ["compute", "instances", "list"]:
            return json.dumps([{"name": name, "zone": "synthetic-a"} for name in self.live])
        if args[:3] == ["compute", "instance-templates", "describe"]:
            return json.dumps({"properties": {"metadata": {"items": [{"key": "startup-script", "value": "echo 'a,b'\ntrue"},
                {"key": "docker-runner-image", "value": "synthetic/custom:v2"}, {"key": "runner-count", "value": "8"}]}}})
        if args[:3] == ["compute", "instances", "create"]:
            self.live.add(args[3])
            return ""
        if args[:2] == ["builds", "describe"]:
            return json.dumps({"status": self.builds.get(args[2], "WORKING")})
        if args[:2] == ["builds", "list"]:
            return "[]"
        raise AssertionError("Unexpected command: " + repr(args))

    def execute(self, **env):
        with patch.object(provision, "Pool", lambda *_: self.pool), patch.object(provision, "command", self.command):
            provision.main(dict(self.env, **env))

    def test_direct_route_filters_hosted_ubicloud_and_other_repository(self):
        for env in [{"JOB_LABELS": '["ubuntu-latest"]'}, {"JOB_LABELS": '["ubicloud-standard-2"]'}, {"REPO_OWNER": "other"}, {"ACTION": "ping"}]:
            self.execute(**env)
        self.assertEqual(self.calls, [])

    def test_direct_route_preserves_complete_template_metadata_before_first_boot(self):
        self.execute()
        create = next(call for call in self.calls if call[:3] == ["compute", "instances", "create"])
        metadata = next(arg for arg in create if arg.startswith("--metadata="))
        self.assertIn("startup-script=echo 'a,b'\ntrue", metadata)
        self.assertIn("docker-runner-image=synthetic/custom:v2", metadata)
        self.assertIn("repo-owner=example", metadata)
        self.assertIn("job-id=10", metadata)
        self.assertEqual(next(iter(self.entries.values()))["state"], "active")

    def test_duplicate_delivery_and_distinct_same_run_jobs(self):
        self.execute()
        self.execute(BUILD_ID="duplicate-build")
        self.execute(JOB_ID="11", BUILD_ID="second-job")
        creates = [call[3] for call in self.calls if call[:3] == ["compute", "instances", "create"]]
        self.assertEqual(len(creates), 2)
        self.assertNotEqual(*creates)

    def test_shared_http_pending_slot_counts_against_direct_vm_ceiling(self):
        self.entries["http-allocation"] = {"name": "http-pending-vm", "zone": "synthetic-a", "state": "pending", "token": "http-token", "buildId": "http-build"}
        self.live.add("existing-legacy-vm")
        with self.assertRaisesRegex(RuntimeError, "VM capacity exhausted"):
            self.execute()
        self.assertFalse(any(call[:3] == ["compute", "instances", "create"] for call in self.calls))
        self.assertTrue(any(entry["state"] == "waiting" for entry in self.pool.jobs.values()))

    def test_failed_build_without_vm_releases_but_partial_insert_does_not(self):
        key, name = provision.allocation("example", "repo", "20", "10")
        self.entries[key] = {"name": name, "zone": "synthetic-a", "state": "pending", "token": "old", "buildId": "failed-build"}
        self.builds["failed-build"] = "FAILURE"
        self.execute()
        self.assertTrue(any(call[:3] == ["compute", "instances", "create"] for call in self.calls))
        self.calls.clear()
        self.entries[key]["state"] = "pending"
        self.entries[key]["buildId"] = "failed-build"
        self.execute(BUILD_ID="third-build")
        self.assertFalse(any(call[:3] == ["compute", "instances", "create"] for call in self.calls))

    def test_http_reserved_build_can_execute_once_and_retains_owner(self):
        key, name = provision.allocation("example", "repo", "20", "10")
        self.entries[key] = {"name": name, "state": "submitting", "token": "http-token", "zone": "synthetic-a"}
        self.execute(RESERVATION_TOKEN="other-token")
        self.assertFalse(self.live)
        self.execute(RESERVATION_TOKEN="http-token")
        self.assertEqual(len(self.live), 1)
        self.execute(RESERVATION_TOKEN="http-token")
        self.assertEqual(len([c for c in self.calls if c[:3] == ["compute", "instances", "create"]]), 1)

    def test_completion_tombstone_blocks_late_queued_create(self):
        self.execute(ACTION="completed")
        self.execute()
        self.assertFalse(self.live)

    def test_scheduled_reconciler_retries_waiting_demand_after_capacity_frees(self):
        self.live.update(["existing-one", "existing-two"])
        with self.assertRaises(RuntimeError):
            self.execute()
        self.live.clear()
        self.execute(ACTION="reconcile", BUILD_ID="scheduled-build")
        self.assertEqual(len(self.live), 1)

    def test_scheduled_reconciler_recovers_async_direct_failure_without_redelivery(self):
        ordinary = self.command
        def fail(args):
            if args[:3] == ["compute", "instances", "create"]:
                raise subprocess.CalledProcessError(1, "synthetic gcloud")
            return ordinary(args)
        with patch.object(provision, "Pool", lambda *_: self.pool), patch.object(provision, "command", fail):
            with self.assertRaises(subprocess.CalledProcessError):
                provision.main(self.env)
        self.builds["direct-build-1"] = "FAILURE"
        self.execute(ACTION="reconcile", BUILD_ID="scheduled-build")
        self.assertEqual(len(self.live), 1)

    def test_scheduled_partial_failure_continues_other_jobs_and_recovers_next_run(self):
        for job_id in ["10", "11"]:
            key, _ = provision.allocation("example", "repo", "20", job_id)
            self.pool.jobs[key] = dict(state="waiting", done=False, event=json.dumps(dict(
                repo_owner="example", repo_name="repo", run_id="20", job_id=job_id,
                run_attempt="1", labels=["self-hosted"])))
        ordinary = self.command
        failed = False
        def fail_once(args):
            nonlocal failed
            if args[:3] == ["compute", "instances", "create"] and not failed:
                failed = True
                raise subprocess.CalledProcessError(1, "synthetic credential-like error must not be logged")
            return ordinary(args)
        logs = io.StringIO()
        with patch.object(provision, "Pool", lambda *_: self.pool), patch.object(provision, "command", fail_once), patch("sys.stdout", logs):
            with self.assertRaisesRegex(RuntimeError, "retries deferred"):
                provision.main(dict(self.env, ACTION="reconcile", BUILD_ID="scheduled-build"))
        self.assertIn("examined=2 deferred=1", logs.getvalue())
        self.assertNotIn("credential-like", logs.getvalue())
        self.assertEqual(sorted(entry["state"] for entry in self.entries.values()), ["active", "pending"])
        self.assertEqual(len(self.live), 1)
        self.builds["scheduled-build"] = "FAILURE"
        self.execute(ACTION="reconcile", BUILD_ID="recovery-build")
        self.assertEqual(len(self.live), 2)
        self.assertTrue(all(entry["state"] == "active" for entry in self.entries.values()))

    def test_malformed_waiting_event_does_not_block_valid_jobs(self):
        self.pool.jobs["malformed"] = dict(state="waiting", done=False, event="{")
        key, _ = provision.allocation("example", "repo", "20", "10")
        self.pool.jobs[key] = dict(state="waiting", done=False, event=json.dumps(dict(
            repo_owner="example", repo_name="repo", run_id="20", job_id="10", labels=["self-hosted"])))
        with self.assertRaisesRegex(RuntimeError, "retries deferred"):
            self.execute(ACTION="reconcile", BUILD_ID="scheduled-build")
        self.assertEqual(len(self.live), 1)
        self.assertEqual(self.pool.jobs["malformed"]["state"], "waiting")

    def test_capacity_only_deferral_keeps_demand_without_failing_scheduled_build(self):
        self.live.update(["existing-one", "existing-two"])
        with self.assertRaises(provision.CapacityExhausted):
            self.execute()
        logs = io.StringIO()
        with patch("sys.stdout", logs):
            self.execute(ACTION="reconcile", BUILD_ID="scheduled-build")
        self.assertIn("examined=1 deferred=1 failed=0", logs.getvalue())
        self.assertEqual(self.entries, {})
        self.assertTrue(any(job["state"] == "waiting" for job in self.pool.jobs.values()))

    def test_unknown_submission_and_success_without_vm_keep_capacity_charged(self):
        for state, extra in [("submitting", {}), ("pending", {"buildId": "success-build"})]:
            self.entries.clear()
            self.entries["unknown"] = dict(name="unknown-vm", zone="synthetic-a", state=state, token="unknown-token", **extra)
            self.builds["success-build"] = "SUCCESS"
            self.execute(MAX_RUNNER_VMS="1", ACTION="reconcile")
            self.assertNotEqual(self.entries["unknown"]["state"], "failed")

    def test_missing_vm_without_completion_recovers_original_queued_demand(self):
        self.execute()
        self.live.clear()
        self.execute(ACTION="reconcile", BUILD_ID="spot-recovery-build")
        self.assertEqual(len(self.live), 1)

    def test_same_name_vms_in_distinct_zones_count_separately(self):
        ordinary = self.command
        def zonal(args):
            if args[:3] == ["compute", "instances", "list"]:
                return json.dumps([{"name": "legacy", "zone": "zone-a"}, {"name": "legacy", "zone": "zone-b"}])
            return ordinary(args)
        with patch.object(provision, "Pool", lambda *_: self.pool), patch.object(provision, "command", zonal):
            with self.assertRaisesRegex(RuntimeError, "VM capacity exhausted"):
                provision.main(self.env)
        self.assertFalse(self.live)

    def test_insert_failure_retains_pending_reservation_for_reconciliation(self):
        ordinary = self.command
        def fail(args):
            if args[:3] == ["compute", "instances", "create"]:
                raise subprocess.CalledProcessError(1, "synthetic gcloud")
            return ordinary(args)
        with patch.object(provision, "Pool", lambda *_: self.pool), patch.object(provision, "command", fail):
            with self.assertRaises(subprocess.CalledProcessError):
                provision.main(self.env)
        self.assertEqual(next(iter(self.entries.values()))["state"], "pending")

    def test_js_python_identity_agree_without_rounding(self):
        fields = ["a" * 39, "b" * 100, "9007199254740993", "9007199254740995", "2"]
        key, name = provision.allocation(*fields)
        script = "const {identity}=require(process.argv[1]); console.log(JSON.stringify(identity(JSON.parse(process.argv[2]))));"
        event = dict(zip(["repo_owner", "repo_name", "run_id", "job_id", "run_attempt"], fields))
        node = json.loads(subprocess.check_output(["node", "-e", script, str(ROOT / "cloud-functions/webhook-handler/provisioning-state.js"), json.dumps(event)], text=True))
        self.assertEqual({"key": key, "name": name}, node)
        self.assertLessEqual(len(name), 63)

    def test_waiting_pages_rotate_past_permanently_blocked_first_twenty(self):
        pool = provision.Pool("synthetic", "synthetic-token")
        prefix = pool.name.rsplit("/provisioning_pools/global", 1)[0] + "/job_provisioning/"
        documents = [{"name": prefix + f"{i:02}", "fields": {
            "state": {"stringValue": "waiting"}, "event": {"stringValue": str(i)}, "done": {"booleanValue": False}}} for i in range(25)]
        cursor, queries, commits, rollbacks = {}, [], [], []
        def request(suffix, data=None):
            if suffix == ":beginTransaction":
                return {"transaction": "synthetic-transaction"}
            if suffix.startswith("/provisioning_cursors/waiting?"):
                return {"fields": cursor}
            if suffix == ":runQuery":
                query = data["structuredQuery"]
                queries.append(json.loads(json.dumps(query)))
                self.assertEqual(data["transaction"], "synthetic-transaction")
                self.assertEqual(query["limit"], 20)
                self.assertEqual(query["orderBy"][0]["field"]["fieldPath"], "__name__")
                after = query.get("startAt", {}).get("values", [{}])[0].get("referenceValue", "")
                return [{"document": doc} for doc in documents if doc["name"] > after][:20]
            if suffix == ":commit":
                commits.append(data)
                self.assertEqual(len(data["writes"]), 1)
                self.assertTrue(data["writes"][0]["update"]["name"].endswith("/provisioning_cursors/waiting"))
                cursor.update(data["writes"][0]["update"]["fields"])
                return {}
            if suffix == ":rollback":
                rollbacks.append(data)
                return {}
            raise AssertionError(suffix)
        with patch.object(pool, "request", request):
            first, second, wrapped = pool.waiting(), pool.waiting(), pool.waiting()
        self.assertEqual([job["event"] for job in first], list(map(str, range(20))))
        self.assertEqual([job["event"] for job in second], list(map(str, range(20, 25))))
        self.assertEqual(wrapped, first)
        self.assertEqual(len(commits), 3)
        self.assertEqual(rollbacks, [])
        self.assertFalse(queries[1]["startAt"]["before"])

    def test_waiting_cursor_conflict_retries_without_losing_page(self):
        pool = provision.Pool("synthetic", "synthetic-token")
        cursor, commits, rollbacks = {}, [], []
        def request(suffix, data=None):
            if suffix == ":beginTransaction":
                return {"transaction": "synthetic-transaction"}
            if suffix.startswith("/provisioning_cursors/waiting?"):
                return {"fields": cursor}
            if suffix == ":runQuery":
                self.assertNotIn("startAt", data["structuredQuery"])
                return [{"document": {"name": "projects/synthetic/databases/autoscaler-state/documents/job_provisioning/first", "fields": {"event": {"stringValue": "first"}}}}]
            if suffix == ":commit":
                commits.append(data)
                if len(commits) == 1:
                    raise urllib.error.HTTPError("synthetic.invalid", 409, "conflict", {}, None)
                cursor.update(data["writes"][0]["update"]["fields"])
                return {}
            if suffix == ":rollback":
                rollbacks.append(data)
                return {}
            raise AssertionError(suffix)
        with patch.object(pool, "request", request), patch.object(provision.time, "sleep") as sleep:
            self.assertEqual(pool.waiting(), [{"event": "first"}])
        self.assertEqual(len(commits), 2)
        self.assertEqual(len(rollbacks), 1)
        sleep.assert_called_once_with(0.1)

    def test_waiting_begin_failure_preserves_original_error(self):
        pool = provision.Pool("synthetic", "synthetic-token")
        error = urllib.error.HTTPError("synthetic.invalid", 429, "limited", {}, None)
        with patch.object(pool, "request", side_effect=error) as request:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                pool.waiting()
        self.assertIs(caught.exception, error)
        request.assert_called_once_with(":beginTransaction", {})


if __name__ == "__main__":
    unittest.main()
