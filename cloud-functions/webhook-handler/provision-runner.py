"""Shared default/HTTP build provisioner. No provider packages or shell eval.

Firestore's global pool transaction is the VM ceiling boundary. Unknown entries
remain charged; CLI/transport errors never free a potentially accepted insert.
"""
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


def allocation(owner, repo, run, job, attempt="1"):
    fields = [owner, repo, run, job, attempt]
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repo):
        raise ValueError("Invalid repository")
    if not all(re.fullmatch(r"[1-9][0-9]*", value) for value in fields[2:]):
        raise ValueError("Invalid job identity")
    key = hashlib.sha256(json.dumps(fields, separators=(",", ":")).encode()).hexdigest()
    prefix = re.sub(r"[^a-z0-9-]", "-", f"runner-{owner}-{repo}".lower())[:38].rstrip("-")
    return key, f"{prefix}-{key[:24]}"


def command(args):
    return subprocess.check_output(["gcloud", *args], text=True).strip()


class Pool:
    def __init__(self, project, token, database="autoscaler-state"):
        if not re.fullmatch(r"[a-z][a-z0-9-]{2,62}", database):
            raise ValueError("Invalid Firestore database")
        self.base = f"https://firestore.googleapis.com/v1/projects/{project}/databases/{database}/documents"
        self.name = f"projects/{project}/databases/{database}/documents/provisioning_pools/global"
        self.token = token

    def request(self, suffix, data=None):
        request = urllib.request.Request(self.base + suffix,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def get_document(self, suffix, transaction):
        try:
            return self.request(suffix + "?transaction=" + urllib.parse.quote(transaction, safe=""))
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            return None

    @staticmethod
    def decode_job(doc):
        if not doc:
            return {}
        result = {}
        for key, value in doc.get("fields", {}).items():
            if "booleanValue" in value:
                result[key] = value["booleanValue"]
            elif "stringValue" in value:
                result[key] = value["stringValue"]
            else:
                raise ValueError("Invalid job state field")
        return result

    def waiting(self, page_size=20):
        # Rotate bounded pages even when their jobs cannot yet be retried.
        # A transaction serializes the cursor across concurrent schedulers.
        cursor_name = self.name.rsplit("/provisioning_pools/global", 1)[0] + "/provisioning_cursors/waiting"
        for attempt in range(5):
            transaction = self.request(":beginTransaction", {})["transaction"]
            committed = False
            try:
                cursor = self.decode_job(self.get_document("/provisioning_cursors/waiting", transaction)).get("after")
                query = {
                    "from": [{"collectionId": "job_provisioning"}],
                    "where": {"fieldFilter": {"field": {"fieldPath": "state"}, "op": "EQUAL", "value": {"stringValue": "waiting"}}},
                    "orderBy": [{"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}],
                    "limit": page_size}
                if cursor:
                    query["startAt"] = {"values": [{"referenceValue": cursor}], "before": False}
                rows = self.request(":runQuery", {"structuredQuery": query, "transaction": transaction})
                documents = [row["document"] for row in rows if "document" in row]
                if not documents and cursor:
                    del query["startAt"]
                    rows = self.request(":runQuery", {"structuredQuery": query, "transaction": transaction})
                    documents = [row["document"] for row in rows if "document" in row]
                after = documents[-1]["name"] if documents else ""
                self.request(":commit", {"transaction": transaction, "writes": [{"update": {
                    "name": cursor_name, "fields": {"after": {"stringValue": after}}}}]})
                committed = True
                return [self.decode_job(doc) for doc in documents]
            except urllib.error.HTTPError as error:
                if error.code not in (409, 429) or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))
            finally:
                if not committed:
                    try:
                        self.request(":rollback", {"transaction": transaction})
                    except Exception:
                        pass

    def mutate(self, fn, job_key=None):
        for attempt in range(5):
            transaction = self.request(":beginTransaction", {})["transaction"]
            try:
                doc = self.get_document("/provisioning_pools/global", transaction)
                entries = json.loads(doc["fields"]["entries"]["stringValue"]) if doc else {}
                if not isinstance(entries, dict):
                    raise ValueError("Invalid provisioning pool")
                job = self.decode_job(self.get_document("/job_provisioning/" + job_key, transaction)) if job_key else None
                result = fn(entries, job) if job_key else fn(entries)
                writes = [{"update": {"name": self.name, "fields": {"entries": {"stringValue": json.dumps(entries, separators=(",", ":"))}}}}]
                if job_key:
                    fields = {key: {"booleanValue" if type(value) is bool else "stringValue": value} for key, value in job.items()}
                    writes.append({"update": {"name": self.name.rsplit("/provisioning_pools/global", 1)[0] + "/job_provisioning/" + job_key, "fields": fields}})
                self.request(":commit", {"transaction": transaction, "writes": writes})
                return result
            except urllib.error.HTTPError as error:
                if error.code not in (409, 429) or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))
            finally:
                try:
                    self.request(":rollback", {"transaction": transaction})
                except Exception:
                    pass


def inventory(project):
    instances = json.loads(command(["compute", "instances", "list", "--project=" + project,
        "--filter=labels.purpose=github-runner", "--format=json"]))
    if not isinstance(instances, list):
        raise ValueError("Incomplete VM inventory")
    return {item["zone"].rsplit("/", 1)[-1] + "/" + item["name"] for item in instances}


def archive_bootstrap(job, entry):
    # Independently authored adaptation. Proved absence precedes receipt archival.
    pending = json.loads(job.get("pendingCleanup", "[]"))
    if not isinstance(pending, list) or len(pending) >= 100:
        raise RuntimeError("Allocation audit archive unavailable")
    pending.append({"allocation": json.loads(json.dumps(entry)), "archivedAtMs": int(time.time() * 1000)})
    job["pendingCleanup"] = json.dumps(pending, separators=(",", ":"))
    if not job.get("bootstrap"):
        return
    receipt = json.loads(job["bootstrap"])
    history = json.loads(job.get("bootstrapHistory", "[]"))
    if not isinstance(history, list) or len(history) >= 100 or not isinstance(receipt, dict):
        raise RuntimeError("Bootstrap audit archive unavailable")
    history.append({"instanceId": entry.get("instanceId"),
        "instanceCreationTimestamp": entry.get("instanceCreationTimestamp"),
        "reservationToken": entry["token"], "bootstrap": receipt,
        "archivedAtMs": int(time.time() * 1000)})
    job["bootstrapHistory"] = json.dumps(history, separators=(",", ":"))
    del job["bootstrap"]


def reconcile(pool, project):
    # CLI filtered inventory is not authoritative absence/incarnation proof.
    # Retain every reservation here; the controller's exact SDK GET + durable
    # ownership CAS handles hydration and narrowly qualified absence release.
    snapshot = pool.mutate(lambda entries: dict(entries))
    for key, entry in snapshot.items():
        if entry["state"] not in ("pending", "submitting"):
            continue
        build_id = entry.get("buildId")
        if not build_id:
            builds = json.loads(command(["builds", "list", "--project=" + project,
                "--filter=tags=runner-reservation-" + entry["token"], "--format=json", "--limit=2"]))
            if len(builds) != 1:
                continue  # Missing/ambiguous accepted submission stays charged.
            build_id = builds[0]["id"]
        build = json.loads(command(["builds", "describe", build_id, "--project=" + project, "--format=json"]))
        def update(entries, job):
            current = entries.get(key)
            if current and current.get("token") == entry.get("token") and current["state"] == entry["state"]:
                current["buildId"] = build_id
                if build["status"] in ("SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"):
                    current["state"] = "unknown"
        pool.mutate(update, key)



class CapacityExhausted(RuntimeError):
    """Expected waiting demand; no new reservation or insert was attempted."""


def reserve(entries, key, name, token, build, zone, live, limit, job=None):
    prior = entries.get(key)
    if (job and job.get("done")) or (prior and prior.get("demandDone")):
        return False
    if prior:
        # HTTP reserved before submission. Only its assigned build may execute.
        if prior["token"] != token or prior.get("buildId", build) != build or prior.get("name") != name or prior.get("zone") != zone:
            return False
        if prior["state"] != "pending" and prior["state"] != "submitting":
            return False
    else:
        if job and job.get("bootstrap"):
            raise RuntimeError("Unarchived bootstrap receipt blocks new reservation")
        charged = live | {entry["zone"] + "/" + entry["name"] for entry in entries.values()}
        if len(charged) >= limit:
            raise CapacityExhausted("VM capacity exhausted; retry after reconciliation")
        entries[key] = {"name": name, "token": token, "zone": zone, "state": "submitting", "creationStarted": False}
    entries[key].update(state="pending", buildId=build)
    return True


def main(env=None):
    env = os.environ if env is None else env
    batch_size = int(env.get("RECONCILIATION_BATCH_SIZE", "20"))
    ttl_ms = int(env.get("BOOTSTRAP_TTL_MS", "600000"))
    if not 1 <= batch_size <= 100 or not 1 <= ttl_ms <= 900000:
        raise ValueError("Invalid recovery or bootstrap bounds")
    if env.get("ACTION") == "reconcile":
        project = env["PROJECT_ID"]
        pool = Pool(project, command(["auth", "print-access-token"]), env["FIRESTORE_DATABASE_ID"])
        reconcile(pool, project)
        batch = pool.waiting(batch_size)[:batch_size]
        deferred = 0
        failed = 0
        for entry in batch:
            try:
                event = json.loads(entry["event"])
                retry_env = dict(env, ACTION="queued", REPO_OWNER=event["repo_owner"], REPO_NAME=event["repo_name"],
                    RUN_ID=str(event["run_id"]), JOB_ID=str(event["job_id"]), RUN_ATTEMPT=str(event.get("run_attempt") or "1"),
                    JOB_LABELS=json.dumps(event["labels"]))
                main(retry_env)
            except Exception as error:
                # Each retry retains its reservation/demand. One failed insert
                # must not prevent reconciliation of the other queued jobs.
                # Never log exceptions: API errors can contain credentials.
                deferred += 1
                if not isinstance(error, CapacityExhausted):
                    failed += 1
                print("Provisioning retry deferred; reservation retained")
        print(f"Provisioning reconciliation: examined={len(batch)} deferred={deferred} failed={failed}")
        if failed:
            # Failed inserts reference this scheduled build. Its terminal failure
            # lets the next recurring run release only reservations with no VM;
            # reporting SUCCESS would strand them in conservative unknown state.
            raise RuntimeError("Provisioning retries deferred; inspect reconciliation logs")
        return
    if env.get("ACTION") not in ("queued", "completed", "cancelled"):
        return
    owner, repo = env["REPO_OWNER"], env["REPO_NAME"]
    if (owner.lower(), repo.lower()) != (env["ALLOWED_OWNER"].lower(), env["ALLOWED_REPO"].lower()):
        return
    labels = json.loads(env["JOB_LABELS"])
    required = json.loads(env["REQUIRED_LABELS"])
    registered = json.loads(env["REGISTERED_LABELS"])
    routing = env["RUNNER_ROUTING_LABEL"]
    if not isinstance(registered, list) or not all(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", v) for v in registered) or not 2 <= len(registered) <= 16 or len(set(registered)) != len(registered):
        raise ValueError("Invalid registered labels")
    if routing.lower() in ("self-hosted", "linux", "windows", "macos", "x64", "arm", "arm64") or routing not in registered or "self-hosted" not in registered or not isinstance(required, list) or routing not in required or "self-hosted" not in required or not all(v in registered for v in required):
        raise ValueError("Dedicated routing labels required")
    if not isinstance(labels, list) or not all(label in labels for label in required) or not all(label in registered for label in labels):
        return
    key, name = allocation(owner, repo, env["RUN_ID"], env["JOB_ID"], env.get("RUN_ATTEMPT") or "1")
    project, zone = env["PROJECT_ID"], env["ZONE"]
    worker_sa = env["WORKER_SERVICE_ACCOUNT"]
    worker_unique_id = env["WORKER_SERVICE_ACCOUNT_UNIQUE_ID"]
    broker_url = env["ALLOCATION_BROKER_URL"]
    if not re.fullmatch(r"[1-9][0-9]{5,30}", worker_unique_id) or not re.fullmatch(r"https://[a-z0-9.-]+(?:/[A-Za-z0-9/_-]*)?", broker_url):
        raise ValueError("Invalid worker bootstrap configuration")
    limit = int(env["MAX_RUNNER_VMS"])
    if limit < 1:
        raise ValueError("Invalid VM ceiling")
    build = env["BUILD_ID"]
    token = env.get("RESERVATION_TOKEN") or build
    pool = Pool(project, command(["auth", "print-access-token"]), env["FIRESTORE_DATABASE_ID"])
    if env["ACTION"] != "queued":
        def done(entries, job):
            job.update(done=True, state="completed")
            if key in entries:
                entries[key]["demandDone"] = True
        pool.mutate(done, key)
        return
    reconcile(pool, project)
    live = inventory(project)
    def claim(entries, job):
        event = {"repo_owner": owner, "repo_name": repo, "run_id": env["RUN_ID"], "job_id": env["JOB_ID"],
            "run_attempt": env.get("RUN_ATTEMPT") or "1", "labels": labels}
        if job.get("done") or job.get("executedBy"):
            return False
        try:
            claimed = reserve(entries, key, name, token, build, zone, live, limit, job)
            if claimed:
                current = entries[key]
                deadline = current.get("bootstrapExpiresAtMs", int(time.time() * 1000) + ttl_ms)
                if type(deadline) is not int or deadline <= int(time.time() * 1000):
                    raise RuntimeError("Reservation bootstrap deadline expired")
                profile = dict(project=project, workerServiceAccountEmail=worker_sa,
                    workerServiceAccountUniqueId=worker_unique_id, brokerUrl=broker_url)
                if any(field in current and current[field] != value for field, value in profile.items()):
                    raise RuntimeError("Reservation worker profile changed")
                current.update(**profile, bootstrapExpiresAtMs=deadline)
                job.update(done=False, state="pending", event=json.dumps(event, separators=(",", ":")))
                return {"bootstrapExpiresAtMs": deadline}
            return False
        except CapacityExhausted:
            job.update(done=False, state="waiting", event=json.dumps(event, separators=(",", ":")))
            return "capacity"
    claimed = pool.mutate(claim, key)
    if claimed == "capacity":
        raise CapacityExhausted("VM capacity exhausted; retry after reconciliation")
    if not claimed:
        return
    try:
        if zone + "/" + name not in inventory(project):
            template = json.loads(command(["compute", "instance-templates", "describe", env["INSTANCE_TEMPLATE"],
                "--project=" + project, "--format=json"]))
            properties = template["properties"]
            accounts = properties.get("serviceAccounts", [])
            networks = properties.get("networkInterfaces", [])
            if len(accounts) != 1 or accounts[0].get("email") != worker_sa:
                raise ValueError("Template worker identity mismatch")
            if len(networks) != 1 or networks[0].get("accessConfigs") or networks[0].get("ipv6AccessConfigs"):
                raise ValueError("Template must have one private network interface")
            inherited = {item["key"]: item["value"] for item in properties.get("metadata", {}).get("items", [])}
            forbidden = {"github-token", "github-pat", "github-secret", "github-token-secret", "github-token-secret-name", "docker-runner-image"}
            if forbidden.intersection(inherited) or any(re.search(r"(?:github.*(?:token|pat|secret)|credential)", k, re.I) for k in inherited):
                raise ValueError("Worker template contains management credential metadata")
            if inherited.get("runner-count") != "1" or inherited.get("worker-profile") != "trusted-private-one-job":
                raise ValueError("Template must declare trusted private one-job profile")
            expires_at_ms = claimed["bootstrapExpiresAtMs"]
            metadata = {"repo-owner": owner, "repo-name": repo, "vm-id": name,
                "run-id": env["RUN_ID"], "job-id": env["JOB_ID"], "run-attempt": env.get("RUN_ATTEMPT") or "1",
                "allocation-key": key, "reservation-token": token,
                "allocation-broker-url": broker_url, "bootstrap-expires-at-ms": str(expires_at_ms),
                "worker-profile": "trusted-private-one-job", "runner-count": "1"}
            # gcloud's alternate delimiter preserves commas/newlines in scripts;
            # argv prevents branch/repository values from becoming shell code.
            delimiter = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
            if any(delimiter in value for value in metadata.values()):
                raise ValueError("Metadata delimiter collision")
            metadata_flag = "^" + delimiter + "^" + delimiter.join(f"{k}={v}" for k, v in metadata.items())
            # Consume creation intent BEFORE the provider side effect. A retry
            # cannot assume an interrupted accepted insert never existed.
            def begin_creation(entries, job):
                current = entries.get(key)
                if not current or current.get("token") != token or current.get("buildId") != build or job.get("done") or job.get("executedBy"):
                    return False
                if current.get("creationStarted") is not False:
                    return False
                profile = dict(name=name, zone=zone, project=project,
                    workerServiceAccountEmail=worker_sa, workerServiceAccountUniqueId=worker_unique_id,
                    brokerUrl=broker_url, bootstrapExpiresAtMs=expires_at_ms)
                if any(current.get(field) != value for field, value in profile.items()) or expires_at_ms <= int(time.time() * 1000):
                    return False
                if current.get("state") != "pending":
                    return False
                current["creationStarted"] = True
                return True
            if not pool.mutate(begin_creation, key):
                raise RuntimeError("Creation already attempted or ownership changed")
            command(["compute", "instances", "create", name, "--project=" + project, "--zone=" + zone,
                "--source-instance-template=" + env["INSTANCE_TEMPLATE"], "--metadata=" + metadata_flag,
                "--labels=purpose=github-runner,allocation=" + key[:40],
                "--provisioning-model=SPOT", "--instance-termination-action=DELETE", "--no-address",
                "--service-account=" + worker_sa, "--no-scopes", "--quiet"])
        # Bind the actual VM incarnation before bootstrap can consume a JIT.
        instance = json.loads(command(["compute", "instances", "describe", name,
            "--project=" + project, "--zone=" + zone, "--format=json"]))
        instance_id = str(instance.get("id", ""))
        created = instance.get("creationTimestamp")
        actual_metadata = {item["key"]: item["value"] for item in instance.get("metadata", {}).get("items", [])}
        actual_accounts = instance.get("serviceAccounts", [])
        actual_networks = instance.get("networkInterfaces", [])
        if not re.fullmatch(r"[1-9][0-9]*", instance_id) or not isinstance(created, str) or not created:
            raise RuntimeError("VM incarnation unavailable")
        if actual_metadata.get("allocation-key") != key or actual_metadata.get("reservation-token") != token:
            raise RuntimeError("VM allocation ownership mismatch")
        if len(actual_accounts) != 1 or actual_accounts[0].get("email") != worker_sa or actual_accounts[0].get("scopes"):
            raise RuntimeError("VM worker identity mismatch")
        if len(actual_networks) != 1 or actual_networks[0].get("accessConfigs") or actual_networks[0].get("ipv6AccessConfigs"):
            raise RuntimeError("VM private network mismatch")
        scheduling = instance.get("scheduling", {})
        if scheduling.get("provisioningModel") != "SPOT" or scheduling.get("instanceTerminationAction") != "DELETE":
            raise RuntimeError("VM Spot termination profile mismatch")
        actual_unique_id = command(["iam", "service-accounts", "describe", worker_sa,
            "--project=" + project, "--format=value(uniqueId)"])
        if actual_unique_id != worker_unique_id:
            raise RuntimeError("Worker service account unique identity mismatch")
        bootstrap_expires = int(actual_metadata["bootstrap-expires-at-ms"])
        if bootstrap_expires != claimed["bootstrapExpiresAtMs"] or actual_metadata.get("worker-profile") != "trusted-private-one-job" or actual_metadata.get("runner-count") != "1":
            raise RuntimeError("VM immutable worker profile/deadline mismatch")
        def active(entries, job):
            current = entries.get(key)
            if not current or current["token"] != token or current.get("buildId") != build:
                raise RuntimeError("Reservation ownership lost")
            if current["state"] not in ("pending", "active"):
                raise RuntimeError("Reservation state changed")
            if current.get("instanceId") and (current["instanceId"] != instance_id or current.get("instanceCreationTimestamp") != created):
                raise RuntimeError("VM incarnation changed")
            if current.get("bootstrapExpiresAtMs") != bootstrap_expires:
                raise RuntimeError("Reservation deadline changed")
            profile = dict(name=name, zone=zone, project=project,
                workerServiceAccountEmail=worker_sa, workerServiceAccountUniqueId=worker_unique_id,
                brokerUrl=broker_url)
            if any(current.get(field) != value for field, value in profile.items()):
                raise RuntimeError("Reservation worker profile changed")
            current.update(state="active", instanceId=instance_id,
                instanceCreationTimestamp=created, project=project,
                workerServiceAccountEmail=worker_sa, workerServiceAccountUniqueId=worker_unique_id,
                bootstrapExpiresAtMs=bootstrap_expires)
            if job.get("done"):
                current["demandDone"] = True
        pool.mutate(active, key)
    except Exception:
        # Even a failed synchronous CLI can have inserted a VM. The reconciler
        # checks build status AND inventory; retain this slot until then.
        raise


if __name__ == "__main__":
    main()
