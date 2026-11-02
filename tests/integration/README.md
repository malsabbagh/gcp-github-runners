# Local allocation-state integration

This explicit test command starts one owned Firestore emulator with a synthetic
project/database. It does not deploy a controller, invoke gcloud, retrieve cloud
credentials, register callbacks or perform real Compute, Cloud Build or GitHub
operations. Default source CI does not launch the emulator.

Existing tools are required; the launcher never downloads or installs them:

- Node 24 and the committed npm lock, including Firestore SDK 7.11.2.
- Python 3 and existing Java 21.0.13.
- Official Firestore emulator 1.22.0 JAR, SHA-256
  `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`.

The entry point is `npm run test:state-integration`, with absolute existing-tool
paths in `LOCAL_FIRESTORE_JAVA` and `LOCAL_FIRESTORE_JAR`. It uses
`demo-gcp-runner-local`, `runner-local-state`, API `127.0.0.1:18080` and the
emulator's auxiliary WebSocket listener `127.0.0.1:18081`, refuses
ambient credential variables and other targets, strips proxy/provider settings
from child environments, and keeps all deployment flags false and recovery
paused. Missing tools, a wrong JAR checksum and occupied endpoints fail clearly.
The launcher passes its own absolute Python interpreter path to the Node driver.
The Python child bridge independently validates the fixed target and disabled
controls, then reconstructs the environment allowlist; direct invocation cannot
forward extra credential/proxy/provider variables through that bridge. Empty
credential variables are discarded, while empty target values are rejected.
Each Python child has a 45-second deadline (above the 30-second HTTP deadline),
bounded TERM/KILL cleanup and JSON parsing only after stdio closes. The Node
driver and emulator own separate process groups, both terminated/reaped on an
outer timeout. Temporary database state is not exported. The start record prints
the resolved Java path and binary SHA-256 for provenance; only the emulator JAR
is enforced by a fixed checksum, and the selected local toolchain remains trusted.

From a clean checkout, install the committed Node dependencies with
`npm ci --ignore-scripts --no-audit --no-fund`, then run:

```sh
LOCAL_FIRESTORE_JAVA=/absolute/path/to/java21/bin/java \
LOCAL_FIRESTORE_JAR=/absolute/path/to/cloud-firestore-emulator-v1.22.0.jar \
npm run test:state-integration
```

The tool paths must already exist. Run only in an environment where these two
local listeners are permitted. Save the full output and exit code; failure must
not be converted into a successful qualification result.

Each completed attempt generates TAP output and an `observations.json` under a
new ignored `dist/state-integration/<run>/` directory. The receipt is derived
from the actual TAP results, including nonzero exits, skipped/incomplete runs,
effect-count diagnostics, source hashes, tool identity and cleanup. It does not
overwrite an earlier observation or convert a failed run into a passed gate.
The source manifest includes the reviewed controller archive inventory and all
production files it lists, in addition to the harness. Binding a packaged file
does not claim it executed in the emulator; it prevents an adapter change from
silently retaining a fresh-looking receipt. Earlier harness-only receipts remain
historical and fail the expanded freshness check until a new run is recorded.

Committed observations are dated records of particular source bytes, not a claim
that future changes passed. The original review-head record is preserved as
`observations-3a6b78a.json`. Check the current receipt's source binding with
`npm run check:state-observations`, or supply another receipt path after `--`.
The check requires the complete expected evidence-file manifest, rejects
unexpected files and exits nonzero on missing files or source drift. It never
launches tests or rewrites history. An older manifest remains historical evidence
and cannot claim a match against today's required source set. Matching hashes
establish freshness only; the recorded integration result can still be failing.

Cleanup attempts both owned groups and the port checks even when an earlier
cleanup operation fails. Permission errors are reported without retrying a
denied signal. Bounded waits report surviving/unknown children as failures.
Cleanup errors stay in the receipt alongside TAP results; an operational
exception remains the chained cause of the final failure. A cleanup failure
cannot produce a passed result or replace the original test output.

## Initial observation and current limitations

The first approved local run on November 1, 2026 completed five tests: three
passed and two failed, with no skips. A later approved comparison pinned both
loopback ports and completed seven tests: five passed and the same two original
GET cases failed, with no skips. Both Java processes were reaped.

Passing observations: concurrent admissions at capacity one submitted one mocked
build; concurrent broker exchanges issued one mocked JIT and preserved matching
pool/job receipts; the actual SDK retried a controlled application-level ABORTED
callback and the external mock effect ran once after commit. The controlled
ABORTED case is distinct from a service-generated contention observation.

Both Python-involving cases timed out at the production adapter's transactional
document GET. Emulator logs reported `Unmapped JavaType: BYTE_STRING` while
parsing the transaction query argument. The upstream project's open
[issue 3293](https://github.com/firebase/firebase-tools/issues/3293) describes the
same request and error. This is evidence of the pinned emulator's compatibility
gap; it does not establish that production Firestore fails. The failing tests
remain present. Python's actual transaction and field-codec methods run through
a test-only credentialless loopback transport; production runtime is unchanged.

The first emulator opened an automatically selected auxiliary loopback
WebSocket port. After explicit approval, the launcher pins it to 18081 and
checks both ports before startup and after process termination. Cleanup uses
connection refusal because TIME_WAIT can reject a bind after the server has
already exited; a timeout or permission error is not accepted as absence.

The two new comparison cases override only the test subclass's `get_document`
method with the documented transactional POST `batchGet` operation. Both pass,
including concurrent JS/Python updates of the same pool and job documents.
The production adapter still uses GET. No runtime wire operation, credentials,
permissions, state schema or live readiness setting is changed. This comparison
isolates an emulator limitation; it does not qualify the original GET path.

## Expanded local acceptance result

The expanded run completed 18 tests: 15 passed, three failed and none skipped.
The third failing case is the original Python waiting cursor's transactional
GET; it fails with the same parser error. The command exits 1. All independent
new cases passed using real emulator transactions and mocked provider clients:

| Case | Observed result |
| --- | --- |
| Cancellation and completion during asynchronous mint | Each retained one consumed claim and known runner ID, kept capacity charged and released no material; one mock mint per case. |
| Unknown mint outcome | One mock mint, replay rejected, absence recovery retained unknown charged state. |
| Eligible job B executed on runner reserved for A | Matching forward/reverse receipts, completed state survives delayed progress, A remains separate; delayed queue creates zero builds. |
| SDK waiting query | Pages 2/2/1, wrap to 2, one failed item does not starve later items. |
| Python waiting query through test-only batchGet | Actual REST queries page 2/2/1 and wrap to 2. Original GET remains failing. |
| Failed unissued build recovery | Two mocked exact absence reads and one failed-build read precede atomic slot release; eligible demand replays into one mocked build. |
| Malformed or missing state | Corrupt pool, missing pool/job and mismatched receipts remain untouched with zero mints; corrupt waiting event/cursor are retained. |
| Ownership replaced during recovery inspection | Replacement token remains charged; the stale observation cannot release it. |
| Expiry or incarnation drift during mint | Known provider identity survives, material is withheld, consumed claim and capacity remain. |
| Ambiguous build submission | One mock call, reservation remains charged, duplicate does not resubmit. |

The original two field/transaction GET failures are preserved alongside the new
waiting GET failure. The batchGet comparisons are test-only alternatives, not a
pass of the original production transport. See [the contract diagnosis and
bounded options](CONTRACT.md) and [revision-bound observations](observations.json).

No complete original-adapter integration pass, live transaction qualification or
completion of issue 49 is claimed. Do not swap the production wire operation
merely to hide the emulator failure. Default source CI remains unchanged and
does not run this explicit emulator command; none of its gates are disabled or
waived by these observations. Mocked Compute absence and build outcomes are
fixtures, not evidence of actual cloud cleanup or capacity safety.

Source CI collects the pure launcher regressions through `scripts/test-python.py`
and the child-process regressions through the root Node fixtures. They cover
configuration, source-receipt freshness, owned-group cleanup, child environment
validation, interpreter selection, stdio completion, spawn/input failures and
deadline escalation without starting an emulator or provider client. The actual
emulator command remains a separate diagnostic until the original GET contract
is qualified; adding its known failures to a required green source gate would
not resolve that compatibility gap.
