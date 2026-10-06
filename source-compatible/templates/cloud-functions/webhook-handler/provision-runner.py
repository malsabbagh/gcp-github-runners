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
    def __init__(self, project, token):
        self.base = f"https://firestore.googleapis.com/v1/projects/{project}/databases/autoscaler-state/documents"
        self.name = f"projects/{project}/databases/autoscaler-state/documents/provisioning_pools/global"
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

    def waiting(self):
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
                    "limit": 20}
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


def reconcile(pool, project):
    snapshot = pool.mutate(lambda entries: dict(entries))
    live = inventory(project)
    for key, entry in snapshot.items():
        state = None
        qualified_name = entry.get("zone", "") + "/" + entry["name"]
        if entry["state"] == "active" and qualified_name not in live:
            state = "waiting"
        elif entry["state"] in ("pending", "submitting"):
            build_id = entry.get("buildId")
            if not build_id:
                builds = json.loads(command(["builds", "list", "--project=" + project,
                    "--filter=tags=runner-reservation-" + entry["token"], "--format=json", "--limit=2"]))
                if len(builds) == 1:
                    build_id = builds[0]["id"]
                elif len(builds) > 1:
                    raise RuntimeError("Ambiguous reservation build history")
                else:
                    continue  # Absence is not proof that an ambiguous RPC failed.
            build = json.loads(command(["builds", "describe", build_id, "--project=" + project, "--format=json"]))
            if build["status"] in ("FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"):
                state = "active" if qualified_name in live else "waiting"
            elif build["status"] == "SUCCESS":
                state = "active" if qualified_name in live else "unknown"
        if state is not None:
            def update(entries, job):
                current = entries.get(key)
                if current and current.get("token") == entry.get("token") and current["state"] == entry["state"]:
                    if state in ("waiting", "failed"):
                        del entries[key]
                        job["state"] = "completed" if job.get("done") else "waiting"
                    else:
                        current["state"] = state
            pool.mutate(update, key)



class CapacityExhausted(RuntimeError):
    """Expected waiting demand; no new reservation or insert was attempted."""


def reserve(entries, key, name, token, build, zone, live, limit, job=None):
    prior = entries.get(key)
    if (job and job.get("done")) or (prior and prior.get("demandDone")):
        return False
    if prior and prior["state"] not in ("failed", "waiting"):
        # HTTP reserved before submission. Only its assigned build may execute.
        if prior["token"] != token or prior.get("buildId", build) != build:
            return False
        if prior["state"] == "active":
            return False
    else:
        charged = live | {entry["zone"] + "/" + entry["name"] for entry in entries.values() if entry["state"] not in ("failed", "waiting")}
        if len(charged) >= limit:
            raise CapacityExhausted("VM capacity exhausted; retry after reconciliation")
        entries[key] = {"name": name, "token": token, "zone": zone, "state": "submitting"}
    entries[key].update(state="pending", buildId=build)
    return True


def main(env=None):
    env = os.environ if env is None else env
    if env.get("ACTION") == "reconcile":
        project = env["PROJECT_ID"]
        pool = Pool(project, command(["auth", "print-access-token"]))
        reconcile(pool, project)
        batch = pool.waiting()[:20]
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
    required = json.loads(env.get("REQUIRED_LABELS", '["self-hosted"]'))
    if not isinstance(labels, list) or not all(label in labels for label in required):
        return
    key, name = allocation(owner, repo, env["RUN_ID"], env["JOB_ID"], env.get("RUN_ATTEMPT") or "1")
    project, zone = env["PROJECT_ID"], env["ZONE"]
    limit = int(env["MAX_RUNNER_VMS"])
    if limit < 1:
        raise ValueError("Invalid VM ceiling")
    build = env["BUILD_ID"]
    token = env.get("RESERVATION_TOKEN") or build
    pool = Pool(project, command(["auth", "print-access-token"]))
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
        if job.get("done"):
            return False
        try:
            claimed = reserve(entries, key, name, token, build, zone, live, limit, job)
            if claimed:
                job.update(done=False, state="pending", event=json.dumps(event, separators=(",", ":")))
            return claimed
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
            metadata = {item["key"]: item["value"] for item in template["properties"].get("metadata", {}).get("items", [])}
            metadata.update({"repo-owner": owner, "repo-name": repo, "vm-id": name,
                "run-id": env["RUN_ID"], "job-id": env["JOB_ID"], "run-attempt": env.get("RUN_ATTEMPT") or "1"})
            # gcloud's alternate delimiter preserves commas/newlines in scripts;
            # argv prevents branch/repository values from becoming shell code.
            delimiter = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode()).hexdigest()
            if any(delimiter in value for value in metadata.values()):
                raise ValueError("Metadata delimiter collision")
            metadata_flag = "^" + delimiter + "^" + delimiter.join(f"{k}={v}" for k, v in metadata.items())
            command(["compute", "instances", "create", name, "--project=" + project, "--zone=" + zone,
                "--source-instance-template=" + env["INSTANCE_TEMPLATE"], "--metadata=" + metadata_flag,
                "--labels=purpose=github-runner,allocation=" + key[:40], "--quiet"])
        def active(entries):
            if entries[key]["token"] != token:
                raise RuntimeError("Reservation ownership lost")
            entries[key]["state"] = "active"
        pool.mutate(active)
    except Exception:
        # Even a failed synchronous CLI can have inserted a VM. The reconciler
        # checks build status AND inventory; retain this slot until then.
        raise


if __name__ == "__main__":
    main()
