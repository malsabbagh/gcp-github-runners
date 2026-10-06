# Source-compatible executable profile

This is an executable profile of the original repository, selected source
PR #25 at `301ff51b8cb6493b2bb2c60b55b04586200c73eb` on main
`acbf72d91108fa6c2c4e911129e60fe7912b5c1b`. It is not an archive of documentation.
Its templates retain the source relative paths and control logic for Cloud
Build/direct handlers, original setup/apply/destroy/webhook/config-sync and
cleanup tools, multi-user/native/Docker/Rust worker variants, Terraform and
original regressions. The root workflows retain ReviewSensei automation.

Private configuration and literal secret defaults are input slots. The manifest
lists every required slot and the files using it; actual values never occur in
the templates. Supply a local JSON dictionary using the manifest's
`inputs_file_example` shape with your own values. Keep that file beneath ignored
`.source-profile/`. The sample values describe the shape; they are not cloud
configuration or credentials.

```sh
python3 scripts/source-profile.py \
  --configuration .source-profile/operator-inputs.json \
  --output-name operator-worktree
```

The materializer checks template hashes, rejects interpolation syntax, creates a
new private working directory and executes nothing. From the resulting
`.source-profile/operator-worktree`, original commands retain their original
paths, arguments and working-directory conventions. For example, the restored
setup and destroy programs are actual programs rather than links to prose:

```sh
cd .source-profile/operator-worktree/scripts
bash setup.sh
bash destroy-resources.sh
```

The optional test-PR helpers in Bash and PowerShell perform Git operations at
the containing repository root, then restore the original directory. This small
relocation adapter keeps their marker commits outside the ignored profile.
The remaining source runtime code is retained. The root and hybrid-cleanup package locks and hybrid dependency manifest receive
reviewed dependency maintenance recorded in the manifest, rather than being
described as byte-identical to the original source dependency declarations and locks.
Qualification installs each reviewed lock independently without lifecycle scripts
and exercises matching, schema validation, token signatures, proxy addresses,
gRPC serialization/status and framework HTTP raw bytes using synthetic fixtures.
The selected source has no hybrid handler entrypoint; these checks qualify its
dependency closure, not an absent handler or live cleanup behavior.
The source attributes file is stored under a literal template name, so Git
checkout cannot convert PowerShell template bytes before hash verification; it
materializes at its original `.gitattributes` path.

Those examples are operator commands, not qualification steps. Do not combine
this profile's independent state/templates with the one-job profile's allocation
state. Both architectures remain explicit; no source variant is silently
represented as an equivalent one-job controller route.

Code preservation and executed semantic regressions are recorded in
`behavior-matrix.json`. The source includes an invalid historical
`setup-bloated-backup.sh` and stale webhook tests for superseded pre-PR25
contracts. They are retained and identified, rather than removed or presented as
successful behavior. The selected source's standard unit/HTTP tests, the cleanup
suite, and command-shim lifecycle/provisioning tests provide the executable
acceptance evidence. Provider actions, original operational claims and imported
Git history are outside this code comparison.
