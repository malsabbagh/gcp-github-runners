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

    def waiting(self, limit=20):
        return [job for job in self.jobs.values() if job.get("state") == "waiting" and not job.get("done")]


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.entries, self.live, self.calls, self.builds = {}, set(), [], {}
        self.env = dict(ACTION="queued", REPO_OWNER="example", REPO_NAME="repo", ALLOWED_OWNER="example", ALLOWED_REPO="repo",
            RUN_ID="20", JOB_ID="10", RUN_ATTEMPT="1", JOB_LABELS='["self-hosted"]', PROJECT_ID="synthetic",
            ZONE="synthetic-a", BUILD_ID="direct-build-1", INSTANCE_TEMPLATE="synthetic-template-unique", MAX_RUNNER_VMS="2",
            FIRESTORE_DATABASE_ID="autoscaler-state", REQUIRED_LABELS='["self-hosted","synthetic-runner"]',
            REGISTERED_LABELS='["self-hosted","synthetic-runner"]', RUNNER_ROUTING_LABEL="synthetic-runner",
            WORKER_SERVICE_ACCOUNT="worker@synthetic.iam.gserviceaccount.com", WORKER_SERVICE_ACCOUNT_UNIQUE_ID="1234567890",
            ALLOCATION_BROKER_URL="https://controller.example.test/bootstrap")
        self.env['JOB_LABELS'] = self.env['REQUIRED_LABELS']
        self.pool = FakePool(self.entries)

    def command(self, args):
        self.calls.append(args)
        if args[:2] == ["auth", "print-access-token"]:
            return "synthetic-access-token"
        if args[:3] == ["compute", "instances", "list"]:
            return json.dumps([{"name": name, "zone": "synthetic-a"} for name in self.live])
        if args[:3] == ["compute", "instance-templates", "describe"]:
            return json.dumps({"properties": {"metadata": {"items": [{"key": "startup-script", "value": "echo 'a,b'\ntrue"},
                {"key": "enable-oslogin", "value": "TRUE"}, {"key": "block-project-ssh-keys", "value": "TRUE"},
                {"key": "worker-profile", "value": "trusted-private-one-job"}, {"key": "runner-count", "value": "1"}]},
                "serviceAccounts": [{"email": self.env['WORKER_SERVICE_ACCOUNT'], "scopes": []}],
                "networkInterfaces": [{"networkIP": "10.0.0.2"}]}})
        if args[:3] == ["compute", "instances", "create"]:
            self.live.add(args[3])
            return ""
        if args[:3] == ["compute", "instances", "describe"]:
            create = next(c for c in reversed(self.calls) if c[:3] == ["compute", "instances", "create"] and c[3] == args[3])
            flag = next(a.removeprefix('--metadata=') for a in create if a.startswith('--metadata='))
            _, delimiter, values = flag.split('^', 2)
            metadata = dict(item.split('=', 1) for item in values.split(delimiter))
            return json.dumps(dict(id='12345678901', creationTimestamp='2026-01-01T00:00:00Z',
                metadata={'items': [dict(key=k,value=v) for k,v in metadata.items()]},
                serviceAccounts=[dict(email=self.env['WORKER_SERVICE_ACCOUNT'],scopes=[])],
                networkInterfaces=[dict(networkIP='10.0.0.2')],
                scheduling=dict(provisioningModel='SPOT',instanceTerminationAction='DELETE')))
        if args[:3] == ['iam', 'service-accounts', 'describe']:
            return self.env['WORKER_SERVICE_ACCOUNT_UNIQUE_ID']
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

    def test_direct_route_inherits_template_and_overrides_exact_one_job_metadata(self):
        self.execute()
        create = next(call for call in self.calls if call[:3] == ["compute", "instances", "create"])
        metadata = next(arg for arg in create if arg.startswith("--metadata="))
        self.assertIn('--source-instance-template=synthetic-template-unique', create)
        self.assertIn("startup-script=echo 'a,b'\ntrue", metadata)
        self.assertIn('enable-oslogin=TRUE', metadata)
        self.assertIn('block-project-ssh-keys=TRUE', metadata)
        self.assertIn('runner-count=1', metadata)
        self.assertIn('worker-profile=trusted-private-one-job', metadata)
        self.assertIn('--no-scopes', create)
        self.assertIn('--no-address', create)
        self.assertNotIn('docker-runner-image', metadata)
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
        self.assertTrue(any(entry.get("state") == "waiting" for entry in self.pool.jobs.values()))

    def test_terminal_build_without_exact_vm_proof_stays_charged(self):
        key, name = provision.allocation("example", "repo", "20", "10")
        self.entries[key] = {"name": name, "zone": "synthetic-a", "state": "pending", "token": "old", "buildId": "failed-build"}
        self.builds["failed-build"] = "FAILURE"
        self.execute()
        self.assertFalse(any(call[:3] == ["compute", "instances", "create"] for call in self.calls))
        self.assertEqual(self.entries[key]['state'], 'unknown')
        self.calls.clear()
        self.entries[key]["state"] = "pending"
        self.entries[key]["buildId"] = "failed-build"
        self.execute(BUILD_ID="third-build")
        self.assertFalse(any(call[:3] == ["compute", "instances", "create"] for call in self.calls))

    def test_http_reserved_build_can_execute_once_and_retains_owner(self):
        key, name = provision.allocation("example", "repo", "20", "10")
        self.entries[key] = {"name": name, "state": "submitting", "token": "http-token", "zone": "synthetic-a", "creationStarted": False}
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

    def test_scheduled_cli_reconciler_keeps_ambiguous_insert_charged(self):
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
        self.assertEqual(len(self.live), 0)
        self.assertEqual(next(iter(self.entries.values()))['state'], 'unknown')
        self.assertTrue(next(iter(self.entries.values()))['creationStarted'])

    def test_scheduled_partial_failure_continues_other_jobs_and_retains_uncertainty(self):
        for job_id in ["10", "11"]:
            key, _ = provision.allocation("example", "repo", "20", job_id)
            self.pool.jobs[key] = dict(state="waiting", done=False, event=json.dumps(dict(
                repo_owner="example", repo_name="repo", run_id="20", job_id=job_id,
                run_attempt="1", labels=["self-hosted", "synthetic-runner"])))
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
        self.assertEqual(len(self.live), 1)
        self.assertEqual(sorted(entry['state'] for entry in self.entries.values()), ['active', 'unknown'])

    def test_malformed_waiting_event_does_not_block_valid_jobs(self):
        self.pool.jobs["malformed"] = dict(state="waiting", done=False, event="{")
        key, _ = provision.allocation("example", "repo", "20", "10")
        self.pool.jobs[key] = dict(state="waiting", done=False, event=json.dumps(dict(
            repo_owner="example", repo_name="repo", run_id="20", job_id="10", labels=["self-hosted", "synthetic-runner"])))
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

    def test_missing_vm_filtered_inventory_is_not_absence_authority(self):
        self.execute()
        self.live.clear()
        self.execute(ACTION="reconcile", BUILD_ID="spot-recovery-build")
        self.assertEqual(len(self.live), 0)
        self.assertEqual(next(iter(self.entries.values()))['state'], 'active')

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

    def test_rejects_shared_host_or_public_template_before_insert(self):
        ordinary = self.command
        for drift in ('credential', 'batch', 'public', 'identity'):
            with self.subTest(drift=drift):
                self.entries.clear(); self.pool.jobs.clear(); self.calls.clear()
                def altered(args):
                    result = ordinary(args)
                    if args[:3] != ['compute', 'instance-templates', 'describe']:
                        return result
                    template = json.loads(result)
                    props = template['properties']
                    if drift == 'credential':
                        props['metadata']['items'].append(dict(key='github-token', value='fixture-placeholder'))
                    elif drift == 'batch':
                        props['metadata']['items'][-1]['value'] = '8'
                    elif drift == 'public':
                        props['networkInterfaces'][0]['accessConfigs'] = [dict(type='ONE_TO_ONE_NAT')]
                    else:
                        props['serviceAccounts'][0]['email'] = 'other@synthetic.iam.gserviceaccount.com'
                    return json.dumps(template)
                with patch.object(provision, 'Pool', lambda *_: self.pool), patch.object(provision, 'command', altered):
                    with self.assertRaises(ValueError):
                        provision.main(self.env)
                self.assertFalse(any(call[:3] == ['compute', 'instances', 'create'] for call in self.calls))
                self.assertFalse(next(iter(self.entries.values()))['creationStarted'])

    def test_inserted_vm_drift_retains_consumed_creation_intent(self):
        ordinary = self.command
        for drift in ('token', 'scope', 'spot', 'unique-id'):
            with self.subTest(drift=drift):
                self.entries.clear(); self.pool.jobs.clear(); self.calls.clear(); self.live.clear()
                def altered(args):
                    result = ordinary(args)
                    if drift == 'unique-id' and args[:3] == ['iam', 'service-accounts', 'describe']:
                        return '9876543210'
                    if args[:3] != ['compute', 'instances', 'describe']:
                        return result
                    vm = json.loads(result)
                    if drift == 'token':
                        next(item for item in vm['metadata']['items'] if item['key'] == 'reservation-token')['value'] = 'other'
                    elif drift == 'scope':
                        vm['serviceAccounts'][0]['scopes'] = ['https://www.googleapis.com/auth/cloud-platform']
                    elif drift == 'spot':
                        vm['scheduling']['provisioningModel'] = 'STANDARD'
                    return json.dumps(vm)
                with patch.object(provision, 'Pool', lambda *_: self.pool), patch.object(provision, 'command', altered):
                    with self.assertRaises(RuntimeError):
                        provision.main(self.env)
                entry = next(iter(self.entries.values()))
                self.assertEqual(entry['state'], 'pending')
                self.assertTrue(entry['creationStarted'])
                self.assertEqual(len(self.live), 1)

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
