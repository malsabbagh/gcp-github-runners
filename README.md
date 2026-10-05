# GCP GitHub runners — private WIP

This branch prepares a portable one-job Spot runner controller for Google Cloud. It is an incremental migration and implementation preview. Source changes retain separate sanitized commits and contributor credit; new controller adaptations are credited separately.

The current local controller source passed 170 built-in/injected fixture tests, 42 JavaScript syntax checks and 9 Python AST checks under OS network denial. Those results cover source behavior using synthetic inputs. They do not qualify a deployment, actual Google/GitHub adapters or a production installation.

Management, scheduling, dispatch, JIT admission and destructive retirement qualification flags default to disabled. Busy workers, unknown incarnation and ambiguous provider outcomes retain capacity charges. Active-job graceful drain is unsupported. A worker exit does not establish VM shutdown; unresolved instances can continue accruing cost and block capacity.

The root workspace package and lock are historical source inputs. The separate deployment package still lacks a qualified complete lock. Its Functions Framework 3.5.1 proposal fails strict Node24 engine resolution through a transitive dependency. A separately reviewed 5.0.5 compatibility proposal has not been installed or qualified and is not included in this branch's current source claim. Use the documented focused fixtures when reviewing this WIP; do not infer installation or deployment readiness from the historical workspace commands.

SDK/image/effective IAM/live lifecycle qualification, release license/public attribution and production adoption remain open. Private WIP review does not approve public release, cloud operations or production cutover.
