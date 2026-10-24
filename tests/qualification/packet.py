"""Offline report-only qualification packet validation. Never executes operations."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

SOURCE_FILES = (
    'deployment/archive-manifest.json', 'deployment/archive-source-map.json',
    'deployment/dependency-inventory.json', 'packaging/worker-image-source.json',
    'docker/runner-release.json', 'cloud-functions/webhook-handler/deployment-runtime.js',
)
PREREQUISITES = {
    'source-contracts': 'source', 'dependency-disposition': 'decision',
    'firestore-transactions': 'live', 'operation-approval': 'decision',
    'build-approval': 'decision', 'target-and-identities': 'live',
    'effective-iam': 'live', 'image-boot': 'live', 'jit-provider-lifetime': 'live',
    'worker-quiescence': 'live', 'worker-drain': 'live', 'worker-stop': 'live',
    'job-association': 'live', 'cleanup-controls': 'live', 'runner-maintenance': 'live',
    'retention-plan': 'decision', 'capacity-one-trial': 'live', 'broad-fault-campaign': 'live',
}
FLAG_REQUIREMENTS = {
    'WEBHOOK_ENABLED': ['source-contracts', 'dependency-disposition', 'firestore-transactions',
                        'target-and-identities', 'effective-iam', 'job-association', 'cleanup-controls'],
    'MANAGEMENT_ENABLED': ['source-contracts', 'target-and-identities', 'effective-iam', 'firestore-transactions'],
    'SCHEDULED_ENABLED': ['source-contracts', 'firestore-transactions', 'job-association', 'cleanup-controls'],
    'JIT_PROVIDER_LIFETIME_QUALIFIED': ['source-contracts', 'dependency-disposition', 'image-boot', 'jit-provider-lifetime'],
    'APPROVED_QUIESCENCE': ['image-boot', 'effective-iam', 'worker-quiescence'],
    'DISPATCH_ENABLED': ['source-contracts', 'firestore-transactions', 'worker-quiescence', 'worker-drain', 'worker-stop'],
    'WORKER_DRAIN_QUALIFIED': ['image-boot', 'worker-quiescence', 'worker-drain'],
    'WORKER_STOP_QUALIFIED': ['image-boot', 'worker-quiescence', 'worker-stop'],
}
OPERATIONS = {
    'image-build': {'flags': [], 'requires': ['source-contracts', 'build-approval', 'target-and-identities', 'retention-plan']},
    'controller-install': {'flags': [], 'requires': ['source-contracts', 'operation-approval', 'target-and-identities', 'effective-iam', 'dependency-disposition']},
    'job': {'flags': ['WEBHOOK_ENABLED', 'JIT_PROVIDER_LIFETIME_QUALIFIED'],
            'requires': ['source-contracts', 'operation-approval', 'image-boot', 'runner-maintenance', 'retention-plan']},
    'cancellation-recovery': {'flags': ['MANAGEMENT_ENABLED', 'SCHEDULED_ENABLED', 'DISPATCH_ENABLED',
                                      'APPROVED_QUIESCENCE', 'WORKER_DRAIN_QUALIFIED', 'WORKER_STOP_QUALIFIED'],
                              'requires': ['source-contracts', 'operation-approval', 'cleanup-controls', 'retention-plan']},
    'cleanup': {'flags': ['MANAGEMENT_ENABLED', 'DISPATCH_ENABLED', 'APPROVED_QUIESCENCE',
                         'WORKER_DRAIN_QUALIFIED', 'WORKER_STOP_QUALIFIED'],
                'requires': ['source-contracts', 'operation-approval', 'cleanup-controls', 'retention-plan']},
}
CASE_IDS = {'google-token-bindings', 'live-compute-binding', 'durable-transaction', 'github-app-sdk',
            'worker-image', 'actual-job-association', 'declared-vs-effective-iam', 'bounded-lifecycle'}
WORKSHEET_FIELDS = (
    'project_id region zone build_subnetwork private_pool capacity_stages capacity_stage one_job_per_vm '
    'repository.owner repository.name repository.id repository.private repository.all_writers_trusted repository.branch '
    'routing.route_label routing.registered_labels routing.required_labels '
    'identities.image_build_service_account identities.function_build_service_account '
    'identities.controller_service_account identities.provisioner_service_account '
    'identities.scheduler_service_account identities.worker_service_account identities.worker_unique_id '
    'identities.admin_subject identities.scheduler_subject '
    'references.webhook_secret_version references.github_app_private_key_version '
    'artifacts.source_image_resource artifacts.apt_snapshot artifacts.packer_builder_image '
    'artifacts.provisioner_builder_image artifacts.worker_image_name artifacts.worker_image_resource '
    'artifacts.worker_image_numeric_id artifacts.controller_archive_sha256 artifacts.controller_receipt_sha256 '
    'artifacts.worker_source_manifest_sha256 limits.duration_minutes limits.build_timeout_minutes '
    'limits.max_jobs limits.max_builds limits.cost_ceiling limits.currency '
    'cleanup.owner cleanup.deadline_utc cleanup.evidence_location '
    'retention.owner retention.approved_location retention.days retention.redaction_policy retention.no_new_export_authority '
    'runner_maintenance.owner runner_maintenance.post_start_version runner_maintenance.post_start_binary_sha256 '
    'runner_maintenance.update_behavior runner_maintenance.observations_reference'
).split()
STATES = {'satisfied', 'pending', 'held', 'deferred'}
PLACEHOLDER = re.compile(r'(?i)(?:\b(?:todo|tbd|pending|placeholder|changeme|example|sample)\b|your[_ -]|replace[_ -]|[<>])')
COMMON_FIELDS = ['project_id', 'region', 'zone'] + [field for field in WORKSHEET_FIELDS
    if field.startswith(('limits.', 'cleanup.', 'retention.'))]
RUNTIME_FIELDS = [field for field in WORKSHEET_FIELDS
    if field.startswith(('repository.', 'routing.', 'references.'))] + [
    'identities.controller_service_account', 'identities.provisioner_service_account',
    'identities.scheduler_service_account', 'identities.worker_service_account', 'identities.worker_unique_id',
    'identities.admin_subject', 'identities.scheduler_subject', 'artifacts.provisioner_builder_image',
    'artifacts.worker_image_resource', 'artifacts.worker_image_numeric_id',
    'artifacts.controller_archive_sha256', 'artifacts.controller_receipt_sha256', 'artifacts.worker_source_manifest_sha256']
OPERATION_FIELDS = {
    'image-build': COMMON_FIELDS + ['build_subnetwork', 'private_pool', 'identities.image_build_service_account',
        'artifacts.source_image_resource', 'artifacts.apt_snapshot', 'artifacts.packer_builder_image',
        'artifacts.worker_image_name', 'artifacts.worker_source_manifest_sha256', 'runner_maintenance.owner'],
    'controller-install': COMMON_FIELDS + RUNTIME_FIELDS + ['identities.function_build_service_account'],
    'job': COMMON_FIELDS + RUNTIME_FIELDS + [field for field in WORKSHEET_FIELDS if field.startswith('runner_maintenance.')],
    'cancellation-recovery': COMMON_FIELDS + RUNTIME_FIELDS,
    'cleanup': COMMON_FIELDS + RUNTIME_FIELDS,
}


def concrete(value):
    return isinstance(value, str) and bool(value.strip()) and not PLACEHOLDER.search(value)


def lookup(document, name):
    for part in name.split('.'):
        if not isinstance(document, dict) or part not in document:
            raise KeyError(name)
        document = document[part]
    return document


def field_valid(worksheet, name):
    value = lookup(worksheet, name)
    if name in ('repository.private', 'repository.all_writers_trusted', 'retention.no_new_export_authority'):
        return value is True
    if name in ('repository.id', 'retention.days') or name.startswith('limits.') and name != 'limits.currency':
        if type(value) not in (int, float) or value <= 0 or value == float('inf') or value != value:
            return False
        if name != 'limits.cost_ceiling' and type(value) is not int:
            return False
        return name not in ('limits.max_jobs', 'limits.max_builds') or value <= worksheet['capacity_stage']
    if name in ('routing.registered_labels', 'routing.required_labels'):
        return isinstance(value, list) and bool(value) and all(concrete(v) for v in value) and len(set(value)) == len(value)
    if not concrete(value):
        return False
    if name.endswith('sha256'):
        return re.fullmatch(r'[a-f0-9]{64}', value) is not None
    if name.endswith(('worker_unique_id', 'admin_subject', 'scheduler_subject', 'worker_image_numeric_id')):
        return re.fullmatch(r'[1-9][0-9]{0,19}', value) is not None
    if name.endswith('_service_account'):
        return re.fullmatch(r'[a-z][a-z0-9-]+@' + re.escape(str(worksheet['project_id'])) + r'\.iam\.gserviceaccount\.com', value) is not None
    if name.startswith('references.'):
        return re.fullmatch(r'projects/' + re.escape(str(worksheet['project_id'])) +
                            r'/secrets/[A-Za-z0-9_-]+/versions/[1-9][0-9]*', value) is not None
    if name == 'artifacts.source_image_resource':
        # Packer selects source_image_project_id separately from its output project.
        return re.fullmatch(r'projects/[a-z0-9-]+/global/images/[a-z0-9-]+', value) is not None
    if name == 'artifacts.worker_image_resource':
        return re.fullmatch(r'projects/' + re.escape(str(worksheet['project_id'])) + r'/global/images/[a-z][a-z0-9-]+', value) is not None
    if name.endswith(('packer_builder_image', 'provisioner_builder_image')):
        return re.fullmatch(r'[A-Za-z0-9./_-]+@sha256:[a-f0-9]{64}', value) is not None
    if name == 'project_id':
        return re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', value) is not None
    if name == 'region':
        return re.fullmatch(r'[a-z]+(?:-[a-z]+)+[0-9]+', value) is not None
    if name == 'zone':
        return re.fullmatch(re.escape(str(worksheet['region'])) + r'-[a-z]', value) is not None
    if name == 'build_subnetwork':
        return re.fullmatch(r'projects/' + re.escape(str(worksheet['project_id'])) + '/regions/' +
                            re.escape(str(worksheet['region'])) + r'/subnetworks/[a-z][a-z0-9-]+', value) is not None
    if name == 'private_pool':
        return re.fullmatch(r'projects/' + re.escape(str(worksheet['project_id'])) + '/locations/' +
                            re.escape(str(worksheet['region'])) + r'/workerPools/[A-Za-z0-9_-]+', value) is not None
    if name == 'artifacts.apt_snapshot':
        return re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', value) is not None
    if name == 'limits.currency':
        return re.fullmatch(r'[A-Z]{3}', value) is not None
    if name == 'cleanup.deadline_utc':
        try:
            return len(value) == 20 and datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ') is not None
        except ValueError:
            return False
    if name == 'runner_maintenance.post_start_version':
        return re.fullmatch(r'2\.[0-9]+\.[0-9]+', value) is not None
    if name == 'runner_maintenance.update_behavior':
        return value in ('unchanged', 'updated')
    return True


def identity_blockers(worksheet, operation):
    identities = worksheet['identities']
    pairs = []
    if operation != 'image-build':
        # Terraform creates these four distinct runtime roles; the scheduler is
        # its cleanup account. The runtime also forbids provisioner == worker.
        runtime = ['controller_service_account', 'provisioner_service_account',
                   'scheduler_service_account', 'worker_service_account']
        pairs.extend((left, right) for index, left in enumerate(runtime) for right in runtime[index + 1:])
        subjects = ['worker_unique_id', 'admin_subject', 'scheduler_subject']
        pairs.extend((left, right) for index, left in enumerate(subjects) for right in subjects[index + 1:])
    builders = ['image_build_service_account'] if operation == 'image-build' else [
        'image_build_service_account', 'function_build_service_account']
    pairs.extend((builder, 'worker_service_account') for builder in builders)
    return ['worksheet:identity-separation:' + left + ':' + right for left, right in pairs
            if concrete(identities[left]) and identities[left] == identities[right]]


def validate(plan, cases, source_root, expected_commit, expected_tree):
    """Return evidence readiness, never execution authority; expected revision is caller-attested."""
    issues = []
    flags, operations = {}, {}
    try:
        if plan['schema_version'] != 2 or cases['schema_version'] != 2:
            raise ValueError('schema-version')
        source = plan['selected_source']
        revision = {'commit': source['commit'], 'tree': source['tree']}
        if not all(re.fullmatch(r'[a-f0-9]{40}', value or '') for value in (expected_commit, expected_tree)) or \
                revision != {'commit': expected_commit, 'tree': expected_tree} or cases['source_revision'] != revision:
            issues.append('source-revision-mismatch')
        root = Path(source_root)
        bindings = source['sha256']
        if set(bindings) != set(SOURCE_FILES):
            issues.append('source-bindings-incomplete')
        for name in SOURCE_FILES:
            file = root / name
            if any(parent.is_symlink() for parent in (file, *file.parents)) or not file.is_file() or \
                    file.stat().st_size > 2 * 1024 * 1024 or hashlib.sha256(file.read_bytes()).hexdigest() != bindings.get(name):
                issues.append('source-bytes-mismatch:' + name)
        if issues:
            raise ValueError('source-binding-invalid')
        actual_flags = re.findall(r"flag\(env,'([A-Z_]+)'\)", (root / SOURCE_FILES[-1]).read_text())
        if len(actual_flags) != 8 or set(actual_flags) != set(FLAG_REQUIREMENTS):
            issues.append('runtime-flags-mismatch')
        release = json.loads((root / 'docker/runner-release.json').read_text())
        if any(plan['runner_release'].get(key) != value for key, value in release.items()):
            issues.append('runner-release-mismatch')
        if plan['flag_requirements'] != FLAG_REQUIREMENTS or plan['operations'] != OPERATIONS:
            issues.append('readiness-requirements-mismatch')
        prerequisites = plan['prerequisites']
        if set(prerequisites) != set(PREREQUISITES):
            issues.append('prerequisites-incomplete')
        for name, scope in PREREQUISITES.items():
            item = prerequisites[name]
            if item['status'] not in STATES or not concrete(item['consequence']) or not isinstance(item['evidence'], list):
                issues.append('prerequisite-shape:' + name)
            if item['status'] == 'satisfied' and (not item['evidence'] or any(
                    evidence.get('scope') != scope or evidence.get('source_revision') != revision or
                    not concrete(evidence.get('reference')) for evidence in item['evidence'])):
                issues.append('prerequisite-evidence:' + name)
        worksheet = plan['worksheet']
        for field in WORKSHEET_FIELDS:
            lookup(worksheet, field)
        if worksheet['capacity_stages'] != [1, 2] or type(worksheet['capacity_stage']) is not int or \
                worksheet['capacity_stage'] not in (1, 2) or type(worksheet['one_job_per_vm']) is not int or worksheet['one_job_per_vm'] != 1:
            issues.append('capacity-profile-mismatch')
        declared = worksheet['runtime_flags']
        if set(declared) != set(FLAG_REQUIREMENTS) or any(type(value) is not bool for value in declared.values()):
            issues.append('declared-flags-mismatch')
        records = cases['cases']
        if len(records) != len(CASE_IDS) or {record['id'] for record in records} != CASE_IDS:
            issues.append('cases-incomplete')
        for record in records:
            if not record['operations'] or not set(record['operations']) <= set(OPERATIONS) or \
                    not record['prerequisites'] or not set(record['prerequisites']) <= set(PREREQUISITES) or \
                    record['status'] not in STATES or not concrete(record['action']) or any(
                        not isinstance(record[field], list) or not record[field] or not all(concrete(v) for v in record[field])
                        for field in ('expected_observations', 'evidence_required', 'stop_conditions')):
                issues.append('case-shape')
        for name, requires in FLAG_REQUIREMENTS.items():
            blockers = [key for key in requires if prerequisites[key]['status'] != 'satisfied']
            flags[name] = {'declared_value': declared.get(name), 'evidence_ready': not issues and not blockers,
                           'blockers': blockers}
        for name, policy in OPERATIONS.items():
            required = set(policy['requires'])
            for flag in policy['flags']:
                required.update(FLAG_REQUIREMENTS[flag])
            for record in records:
                if name in record['operations']:
                    required.update(record['prerequisites'])
            if worksheet['capacity_stage'] == 2 and name in ('job', 'cancellation-recovery', 'cleanup'):
                required.add('capacity-one-trial')
            blockers = ['prerequisite:' + key for key in sorted(required) if prerequisites[key]['status'] != 'satisfied']
            blockers += ['flag:' + flag for flag in policy['flags'] if declared.get(flag) is not True]
            blockers += ['worksheet:' + field for field in OPERATION_FIELDS[name] if not field_valid(worksheet, field)]
            routing = worksheet['routing']
            if all(field_valid(worksheet, field) for field in ('routing.route_label', 'routing.registered_labels', 'routing.required_labels')):
                if 'self-hosted' not in routing['required_labels'] or routing['route_label'] not in routing['required_labels'] or \
                        not set(routing['required_labels']) <= set(routing['registered_labels']):
                    blockers.append('worksheet:routing-consistency')
            blockers += identity_blockers(worksheet, name)
            operations[name] = {'available': not issues and not blockers, 'blockers': blockers}
    except (KeyError, TypeError, ValueError, OSError, AttributeError):
        issues.append('packet-shape-or-input-invalid')
    if issues:
        for operation in operations.values():
            operation['available'] = False
        for flag in flags.values():
            flag['evidence_ready'] = False
    return {'preparation_complete': not issues, 'issues': sorted(set(issues)),
            'flags': flags, 'operations': operations, 'execution_authorized': False}


def read_json(filename):
    file = Path(filename)
    if any(parent.is_symlink() for parent in (file, *file.parents)) or not file.is_file() or file.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('invalid-input-file')
    return json.loads(file.read_text())


def main(arguments=None):
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', default=str(root / 'deployment/qualification-plan.json'))
    parser.add_argument('--cases', default=str(root / 'tests/qualification-cases.json'))
    parser.add_argument('--source-root', default=str(root))
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--source-tree', required=True)
    parser.add_argument('--mode', choices=['preparation', 'operation-ready'], default='preparation')
    parser.add_argument('--operation', choices=sorted(OPERATIONS))
    args = parser.parse_args(arguments)
    if args.mode == 'operation-ready' and args.operation is None:
        parser.error('--operation is required in operation-ready mode')
    try:
        report = validate(read_json(args.plan), read_json(args.cases), args.source_root, args.source_commit, args.source_tree)
    except (OSError, ValueError, TypeError):
        report = {'preparation_complete': False, 'issues': ['invalid-input-file'],
                  'flags': {}, 'operations': {}, 'execution_authorized': False}
    print(json.dumps(report, sort_keys=True, indent=2))
    if not report['preparation_complete']:
        return 1
    return 0 if args.mode == 'preparation' else int(not report['operations'][args.operation]['available'])


if __name__ == '__main__':
    raise SystemExit(main())
