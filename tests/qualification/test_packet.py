"""Public report contract for source-only operator preparation."""
import importlib.util
import contextlib
import copy
import io
import json
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('qualification_packet', Path(__file__).with_name('packet.py'))
PACKET = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKET)
COMMIT = '72592e241eb42579faf6d6024ddaca4ce234d323'
TREE = '3d4870be1da0afbd5599741a32052a56c2d1093b'


class PacketTests(unittest.TestCase):
    def documents(self):
        return (json.loads((ROOT / 'deployment/qualification-plan.json').read_text()),
                json.loads((ROOT / 'tests/qualification-cases.json').read_text()))

    def test_preparation_can_be_complete_while_every_operation_is_unavailable(self):
        report = PACKET.validate(*self.documents(), ROOT, COMMIT, TREE)
        self.assertTrue(report['preparation_complete'])
        self.assertTrue(report['operations'])
        self.assertTrue(all(not operation['available'] for operation in report['operations'].values()))
        self.assertFalse(report['execution_authorized'])

    def qualified_documents(self):
        # Synthetic evidence exercises readiness logic; it is never a live receipt.
        plan, cases = self.documents()
        plan['worksheet'] = json.loads((Path(__file__).parent / 'fixtures/synthetic-worksheet.json').read_text())
        revision = {'commit': COMMIT, 'tree': TREE}
        for name, item in plan['prerequisites'].items():
            if name in ('broad-fault-campaign', 'capacity-one-trial'):
                continue
            item['status'] = 'satisfied'
            item['evidence'] = [{'scope': PACKET.PREREQUISITES[name], 'source_revision': revision,
                                 'reference': 'records/offline-synthetic-fixture'}]
        return plan, cases

    def test_normal_qualified_fixture_is_reported_available_without_authorizing_execution(self):
        report = PACKET.validate(*self.qualified_documents(), ROOT, COMMIT, TREE)
        self.assertTrue(report['preparation_complete'])
        self.assertTrue(all(operation['available'] for operation in report['operations'].values()))
        self.assertFalse(report['execution_authorized'])

    def test_unused_identity_values_may_be_null_but_schema_keys_must_remain(self):
        plan, cases = self.qualified_documents()
        plan['worksheet']['identities']['function_build_service_account'] = None
        report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertTrue(report['preparation_complete'])
        self.assertTrue(report['operations']['image-build']['available'])
        self.assertTrue(report['operations']['job']['available'])
        self.assertFalse(report['operations']['controller-install']['available'])
        self.assertIn('worksheet:identities.function_build_service_account',
                      report['operations']['controller-install']['blockers'])
        self.assertFalse(report['execution_authorized'])

        del plan['worksheet']['identities']['function_build_service_account']
        report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertFalse(report['preparation_complete'])
        self.assertIn('packet-shape-or-input-invalid', report['issues'])
        self.assertTrue(all(not operation['available'] for operation in report['operations'].values()))
        self.assertFalse(report['execution_authorized'])

    def test_placeholders_missing_identities_and_limits_cannot_report_job_ready(self):
        for field, value in [('project_id', 'YOUR_PROJECT'), ('repository.id', None),
                             ('limits.cost_ceiling', 0), ('artifacts.worker_image_resource', 'TODO')]:
            with self.subTest(field=field):
                plan, cases = self.qualified_documents()
                parts = field.split('.')
                target = plan['worksheet']
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = value
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                self.assertFalse(report['operations']['job']['available'])

    def test_evidence_must_exist_match_revision_and_have_the_right_scope(self):
        for mutate in [lambda row: row.update(evidence=[]),
                       lambda row: row['evidence'][0].update(reference='TODO'),
                       lambda row: row['evidence'][0].update(source_revision={'commit': 'a' * 40, 'tree': TREE}),
                       lambda row: row['evidence'][0].update(scope='source')]:
            plan, cases = self.qualified_documents()
            mutate(plan['prerequisites']['firestore-transactions'])
            report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
            self.assertFalse(report['preparation_complete'])
            self.assertFalse(report['operations']['job']['available'])

    def test_required_prerequisites_stay_unavailable_when_held_pending_or_deferred(self):
        # The separately deferred broad campaign is never mistaken for required evidence.
        untouched = PACKET.validate(*self.qualified_documents(), ROOT, COMMIT, TREE)
        self.assertTrue(untouched['operations']['job']['available'])
        for status in ('held', 'pending', 'deferred'):
            plan, cases = self.qualified_documents()
            plan['prerequisites']['firestore-transactions']['status'] = status
            report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
            self.assertTrue(report['preparation_complete'])
            self.assertFalse(report['operations']['job']['available'])
            self.assertIn('prerequisite:firestore-transactions', report['operations']['job']['blockers'])

    def test_revision_source_bytes_and_manifest_set_are_bound(self):
        self.assertFalse(PACKET.validate(*self.qualified_documents(), ROOT, 'a' * 40, TREE)['preparation_complete'])
        self.assertFalse(PACKET.validate(*self.qualified_documents(), ROOT, COMMIT, 'b' * 40)['preparation_complete'])
        plan, cases = self.qualified_documents()
        plan['selected_source']['sha256']['deployment/archive-manifest.json'] = 'c' * 64
        self.assertFalse(PACKET.validate(plan, cases, ROOT, COMMIT, TREE)['preparation_complete'])
        plan, cases = self.qualified_documents()
        del plan['selected_source']['sha256']['packaging/worker-image-source.json']
        self.assertFalse(PACKET.validate(plan, cases, ROOT, COMMIT, TREE)['preparation_complete'])

    def test_refused_source_binding_is_not_followed_by_a_symlink_read(self):
        from unittest.mock import patch
        plan, cases = self.documents()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in plan['selected_source']['sha256']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            adapter = root / 'cloud-functions/webhook-handler/deployment-runtime.js'
            adapter.unlink()
            canary = root / 'unrelated.txt'
            canary.write_text('UNRELATED_FIXTURE')
            adapter.symlink_to(canary)
            original = Path.read_text
            def refuse_alias(file, *args, **kwargs):
                if file == adapter:
                    raise AssertionError('refused alias was read')
                return original(file, *args, **kwargs)
            with patch('pathlib.Path.read_text', refuse_alias):
                report = PACKET.validate(plan, cases, root, COMMIT, TREE)
            self.assertFalse(report['preparation_complete'])

    def test_symlinked_intermediate_source_directory_is_refused_without_reading_it(self):
        from unittest.mock import patch
        plan, cases = self.documents()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in plan['selected_source']['sha256']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            relocated = root / 'relocated-deployment'
            (root / 'deployment').rename(relocated)
            (root / 'deployment').symlink_to(relocated, target_is_directory=True)
            original = Path.read_bytes
            def refuse_symlinked_read(file, *args, **kwargs):
                if file.parent.is_symlink():
                    raise AssertionError('symlinked source directory was read')
                return original(file, *args, **kwargs)
            with patch('pathlib.Path.read_bytes', refuse_symlinked_read):
                report = PACKET.validate(plan, cases, root, COMMIT, TREE)
            self.assertFalse(report['preparation_complete'])
            self.assertIn('source-bytes-mismatch:deployment/archive-manifest.json', report['issues'])

    def test_missing_required_gate_case_or_flag_cannot_make_preparation_complete(self):
        for mutate in [lambda plan, cases: plan['operations']['job']['requires'].clear(),
                       lambda plan, cases: plan['flag_requirements']['WEBHOOK_ENABLED'].clear(),
                       lambda plan, cases: plan['worksheet']['runtime_flags'].pop('DISPATCH_ENABLED'),
                       lambda plan, cases: cases['cases'].pop(),
                       lambda plan, cases: cases.update(source_revision={'commit': 'd' * 40, 'tree': TREE})]:
            plan, cases = self.qualified_documents()
            mutate(plan, cases)
            report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
            self.assertFalse(report['preparation_complete'])
            self.assertTrue(all(not row['available'] for row in report['operations'].values()))

    def test_capacity_two_requires_the_capacity_one_result_and_cleanup_evidence(self):
        plan, cases = self.qualified_documents()
        plan['worksheet']['capacity_stage'] = 2
        plan['worksheet']['limits'].update(max_jobs=2, max_builds=2)
        report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertFalse(report['operations']['job']['available'])
        trial = plan['prerequisites']['capacity-one-trial']
        trial.update(status='satisfied', evidence=[{'scope': 'live', 'source_revision': {'commit': COMMIT, 'tree': TREE},
                                                  'reference': 'records/offline-synthetic-capacity-one-cleanup'}])
        self.assertTrue(PACKET.validate(plan, cases, ROOT, COMMIT, TREE)['operations']['job']['available'])

    def test_validator_is_read_only_and_never_executes_or_opens_network_connections(self):
        import builtins
        import os
        import urllib.request
        from unittest.mock import patch
        plan, cases = self.qualified_documents()
        original = copy.deepcopy((plan, cases))
        real_open, real_os_open, real_path_open = builtins.open, os.open, Path.open

        def refuse_writes_open(file, mode='r', *args, **kwargs):
            if any(flag in mode for flag in 'wax+'):
                raise AssertionError('write')
            return real_open(file, mode, *args, **kwargs)

        def refuse_writes_os_open(path, flags, *args, **kwargs):
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC):
                raise AssertionError('write')
            return real_os_open(path, flags, *args, **kwargs)

        def refuse_writes_path_open(file, mode='r', *args, **kwargs):
            if any(flag in mode for flag in 'wax+'):
                raise AssertionError('write')
            return real_path_open(file, mode, *args, **kwargs)

        with patch('pathlib.Path.write_text', side_effect=AssertionError('write')), \
                patch('pathlib.Path.write_bytes', side_effect=AssertionError('write')), \
                patch('pathlib.Path.open', refuse_writes_path_open), \
                patch('builtins.open', refuse_writes_open), \
                patch('os.open', refuse_writes_os_open), \
                patch('subprocess.Popen', side_effect=AssertionError('execute')), \
                patch('subprocess.run', side_effect=AssertionError('execute')), \
                patch('subprocess.call', side_effect=AssertionError('execute')), \
                patch('subprocess.check_call', side_effect=AssertionError('execute')), \
                patch('subprocess.check_output', side_effect=AssertionError('execute')), \
                patch('os.system', side_effect=AssertionError('execute')), \
                patch('os.popen', side_effect=AssertionError('execute')), \
                patch('os.fork', side_effect=AssertionError('execute')), \
                patch('os.posix_spawn', side_effect=AssertionError('execute')), \
                patch('os.execv', side_effect=AssertionError('execute')), \
                patch('os.execve', side_effect=AssertionError('execute')), \
                patch('urllib.request.urlopen', side_effect=AssertionError('network')), \
                patch('socket.socket', side_effect=AssertionError('network')):
            report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertTrue(report['preparation_complete'])
        self.assertEqual((plan, cases), original)
        self.assertFalse(report['execution_authorized'])
        # The validator module must not even carry execution or network clients.
        for name in ('subprocess', 'socket', 'urllib', 'http'):
            self.assertNotIn(name, vars(PACKET))

    def test_binary_plan_input_reports_invalid_json_and_exits_cleanly_in_operation_ready_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            plan_file = directory / 'plan.json'
            plan_file.write_bytes(b'\x89PNG\r\n\x1a\n' + bytes(range(256)))
            arguments = ['--plan', str(plan_file), '--source-commit', COMMIT, '--source-tree', TREE,
                         '--mode', 'operation-ready', '--operation', 'job']
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = PACKET.main(arguments)
            report = json.loads(output.getvalue())
            self.assertEqual(result, 1)
            self.assertIn('plan-path-invalid-json', report['issues'])
            self.assertEqual(report['operations'], {})
            self.assertIn('--plan', ' '.join(report['guidance']))
            self.assertFalse(report['execution_authorized'])

    def test_wrong_schema_versions_fail_closed_with_named_document_issues(self):
        for document, issue in [('plan', 'plan-schema-version'), ('cases', 'cases-schema-version')]:
            with self.subTest(document=document):
                plan, cases = self.qualified_documents()
                (plan if document == 'plan' else cases)['schema_version'] = 3
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                self.assertFalse(report['preparation_complete'])
                self.assertIn(issue, report['issues'])
                self.assertTrue(all(not row['available'] for row in report['operations'].values()))

    def test_non_object_plan_or_cases_fail_closed_with_named_document_issues(self):
        for replacement, issue in (([], 'plan-shape-invalid'), ('text', 'cases-shape-invalid')):
            with self.subTest(issue=issue):
                plan, cases = self.qualified_documents()
                if issue == 'plan-shape-invalid':
                    plan = replacement
                else:
                    cases = replacement
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                self.assertFalse(report['preparation_complete'])
                self.assertIn(issue, report['issues'])
                self.assertEqual(report['operations'], {})
                self.assertEqual(report['flags'], {})
                self.assertFalse(report['execution_authorized'])

    def test_a_single_satisfied_prerequisite_on_the_checked_in_plan_unlocks_nothing(self):
        plan, cases = self.documents()
        plan['prerequisites']['runner-maintenance'].update(
            status='satisfied',
            evidence=[{'scope': 'live', 'source_revision': {'commit': COMMIT, 'tree': TREE},
                       'reference': 'records/offline-synthetic-single-satisfied-prerequisite'}])
        report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertTrue(report['preparation_complete'])
        self.assertTrue(all(not operation['available'] for operation in report['operations'].values()))

    def test_cli_distinguishes_preparation_from_operation_ready_and_has_no_execute_mode(self):
        plan, cases = self.documents()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            plan_file, cases_file = directory / 'plan.json', directory / 'cases.json'
            plan_file.write_text(json.dumps(plan))
            cases_file.write_text(json.dumps(cases))
            arguments = ['--plan', str(plan_file), '--cases', str(cases_file), '--source-root', str(ROOT),
                         '--source-commit', COMMIT, '--source-tree', TREE]
            for mode, exit_code in [('preparation', 0), ('operation-ready', 1)]:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = PACKET.main(arguments + ['--mode', mode, '--operation', 'job'])
                self.assertEqual(result, exit_code)
                self.assertFalse(json.loads(output.getvalue())['execution_authorized'])
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                PACKET.main(arguments + ['--execute'])
            self.assertEqual(error.exception.code, 2)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                PACKET.main(arguments + ['--mode', 'operation-ready', '--operation', 'unknown'])
            self.assertEqual(error.exception.code, 2)

    def test_supplied_parent_symlinks_have_actionable_errors_before_any_input_read(self):
        from unittest.mock import patch
        plan, cases = self.documents()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            actual = directory / 'actual'
            actual.mkdir()
            (actual / 'source').mkdir()
            (actual / 'plan.json').write_text(json.dumps(plan))
            (actual / 'cases.json').write_text(json.dumps(cases))
            alias = directory / 'alias'
            alias.symlink_to(actual, target_is_directory=True)
            canonical = {'--source-root': str(ROOT), '--plan': str(actual / 'plan.json'),
                         '--cases': str(actual / 'cases.json')}
            for option, name, issue in [('--source-root', 'source', 'source-root-symlinked-ancestry'),
                                         ('--plan', 'plan.json', 'plan-path-symlinked-ancestry'),
                                         ('--cases', 'cases.json', 'cases-path-symlinked-ancestry')]:
                with self.subTest(option=option):
                    paths = {**canonical, option: str(alias / name)}
                    arguments = ['--source-commit', COMMIT, '--source-tree', TREE]
                    for flag, value in paths.items():
                        arguments.extend([flag, value])
                    output = io.StringIO()
                    with patch('pathlib.Path.read_text', side_effect=AssertionError('input read')), \
                            patch('pathlib.Path.read_bytes', side_effect=AssertionError('input read')), \
                            contextlib.redirect_stdout(output):
                        result = PACKET.main(arguments)
                    report = json.loads(output.getvalue())
                    self.assertEqual(result, 1)
                    self.assertIn(issue, report['issues'])
                    self.assertIn('canonical', ' '.join(report['guidance']))
                    self.assertFalse(report['execution_authorized'])
            # The same contents under explicitly supplied canonical paths are accepted.
            arguments = ['--source-commit', COMMIT, '--source-tree', TREE]
            for flag, value in canonical.items():
                arguments.extend([flag, value])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(PACKET.main(arguments), 0)
            with patch('pathlib.Path.read_text', side_effect=AssertionError('source read')), \
                    patch('pathlib.Path.read_bytes', side_effect=AssertionError('source read')):
                report = PACKET.validate(plan, cases, alias / 'source', COMMIT, TREE)
            self.assertIn('source-root-symlinked-ancestry', report['issues'])

    def test_unknown_field_names_fail_closed_without_restricting_evidence_locations(self):
        for name, value in [('unexpected', 'concrete-value'), ('limits.future_bound', 1),
                            ('artifacts.future_sha256', 'a' * 64),
                            ('identities.future_service_account',
                             'worker-service-account@fixture-project.iam.gserviceaccount.com'),
                            ('references.future', 'projects/fixture-project/secrets/key/versions/1')]:
            worksheet = self.qualified_documents()[0]['worksheet']
            parts = name.split('.')
            target = worksheet
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = value
            self.assertFalse(PACKET.field_valid(worksheet, name), name)
        for name in ['cleanup.evidence_location', 'retention.approved_location',
                     'runner_maintenance.observations_reference']:
            for value in ['records/private-run', 'https://records.invalid/run/42', 'urn:qualified:evidence:42']:
                worksheet = self.qualified_documents()[0]['worksheet']
                target, key = name.split('.')
                worksheet[target][key] = value
                self.assertTrue(PACKET.field_valid(worksheet, name), (name, value))

    def test_private_repository_labels_pinned_images_roles_and_numbered_references_are_required(self):
        for field, value in [('repository.private', False), ('repository.all_writers_trusted', False),
                             ('routing.required_labels', ['self-hosted']),
                             ('artifacts.provisioner_builder_image', 'registry/image:latest'),
                             ('artifacts.worker_image_resource', 'projects/other-project/global/images/worker'),
                             ('identities.scheduler_subject', '1002'),
                             ('references.webhook_secret_version', 'projects/fixture-project/secrets/webhook/versions/latest'),
                             ('cleanup.deadline_utc', '2026-99-99T00:00:00Z'),
                             ('retention.no_new_export_authority', False)]:
            with self.subTest(field=field):
                plan, cases = self.qualified_documents()
                parts = field.split('.')
                target = plan['worksheet']
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = value
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                self.assertFalse(report['operations']['job']['available'])

    def test_runtime_service_accounts_are_distinct_in_every_affected_operation_report(self):
        from itertools import combinations
        roles = ['controller_service_account', 'provisioner_service_account',
                 'scheduler_service_account', 'worker_service_account']
        for left, right in combinations(roles, 2):
            with self.subTest(left=left, right=right):
                plan, cases = self.qualified_documents()
                plan['worksheet']['identities'][left] = plan['worksheet']['identities'][right]
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                for operation in ['controller-install', 'job', 'cancellation-recovery', 'cleanup']:
                    self.assertFalse(report['operations'][operation]['available'], operation)
                self.assertTrue(report['operations']['image-build']['available'])
        for role in ['provisioner_service_account', 'scheduler_service_account']:
            with self.subTest(missing=role):
                plan, cases = self.qualified_documents()
                plan['worksheet']['identities'][role] = None
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                for operation in ['controller-install', 'job', 'cancellation-recovery', 'cleanup']:
                    self.assertFalse(report['operations'][operation]['available'], operation)

    def test_worker_never_shares_build_or_management_authority(self):
        for role in ['image_build_service_account', 'function_build_service_account']:
            with self.subTest(role=role):
                plan, cases = self.qualified_documents()
                identities = plan['worksheet']['identities']
                identities[role] = identities['worker_service_account']
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                for operation in ['controller-install', 'job', 'cancellation-recovery', 'cleanup']:
                    self.assertFalse(report['operations'][operation]['available'], operation)
                if role == 'image_build_service_account':
                    self.assertFalse(report['operations']['image-build']['available'])
        for role in ['admin_subject', 'scheduler_subject']:
            with self.subTest(role=role):
                plan, cases = self.qualified_documents()
                plan['worksheet']['identities'][role] = plan['worksheet']['identities']['worker_unique_id']
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                for operation in ['controller-install', 'job', 'cancellation-recovery', 'cleanup']:
                    self.assertFalse(report['operations'][operation]['available'], operation)

    def test_exact_approved_cross_project_source_image_is_accepted_for_image_build(self):
        plan, cases = self.qualified_documents()
        plan['worksheet']['artifacts']['source_image_resource'] = 'projects/debian-cloud/global/images/debian-12-fixed'
        report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertTrue(report['preparation_complete'])
        self.assertTrue(report['operations']['image-build']['available'])
        self.assertFalse(report['execution_authorized'])

    def test_moving_image_families_and_cross_project_output_images_are_rejected(self):
        for value in ['projects/debian-cloud/global/images/family/debian-12',
                      'projects/debian-cloud/global/images/debian-12?latest=true',
                      'debian-cloud/debian-12', 'projects/debian-cloud/global/images/',
                      'projects/123/global/images/debian-12-fixed',
                      'projects/debian-cloud/global/images/123']:
            with self.subTest(source=value):
                plan, cases = self.qualified_documents()
                plan['worksheet']['artifacts']['source_image_resource'] = value
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                self.assertFalse(report['operations']['image-build']['available'])
        for value in ['projects/other-project/global/images/worker-fixed',
                      'projects/fixture-project/global/images/family/worker']:
            with self.subTest(output=value):
                plan, cases = self.qualified_documents()
                plan['worksheet']['artifacts']['worker_image_resource'] = value
                report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
                for operation in ['controller-install', 'job', 'cancellation-recovery', 'cleanup']:
                    self.assertFalse(report['operations'][operation]['available'], operation)

    def test_checked_in_source_and_eight_flags_preserve_historical_and_unobserved_boundaries(self):
        plan, cases = self.documents()
        report = PACKET.validate(plan, cases, ROOT, COMMIT, TREE)
        self.assertEqual(set(report['flags']), {'WEBHOOK_ENABLED', 'MANAGEMENT_ENABLED', 'SCHEDULED_ENABLED',
            'JIT_PROVIDER_LIFETIME_QUALIFIED', 'APPROVED_QUIESCENCE', 'DISPATCH_ENABLED',
            'WORKER_DRAIN_QUALIFIED', 'WORKER_STOP_QUALIFIED'})
        self.assertTrue(all(row['declared_value'] is False for row in report['flags'].values()))
        self.assertEqual(plan['selected_source']['commit'], COMMIT)
        self.assertEqual(plan['unmerged_evidence'], [])
        self.assertTrue(all(row['historical_only'] for row in plan['prior_pr_states']))
        self.assertEqual([row['pull_request'] for row in plan['prior_pr_states']], [62])
        historical = plan['historical_source_evidence'][0]
        self.assertEqual(historical['commit'], 'bd70066435c399695b7c8186015c24f39d6fad66')
        self.assertFalse(historical['included_in_selected_source'])
        self.assertNotEqual(historical['sha256']['deployment/dependency-inventory.json'],
                            plan['selected_source']['sha256']['deployment/dependency-inventory.json'])
        merged = plan['subsequent_merged_evidence'][0]
        self.assertEqual(merged['pull_request'], 61)
        self.assertEqual(merged['merge_commit'], 'e77f1d092e2011b238fd51232ef29162a1c8f021')
        self.assertTrue(merged['included_in_selected_source'])
        self.assertEqual(plan['subsequent_merged_evidence'][1]['pull_request'], 62)
        self.assertTrue(plan['subsequent_merged_evidence'][1]['included_in_selected_source'])
        self.assertTrue(all(row['source_revision'] == {'commit': COMMIT, 'tree': TREE}
                            for row in plan['prerequisites']['source-contracts']['evidence']))
        self.assertEqual(plan['prerequisites']['dependency-disposition']['status'], 'pending')
        self.assertIsNone(plan['worksheet']['artifacts']['worker_image_resource'])
        self.assertIsNone(plan['worksheet']['runner_maintenance']['post_start_version'])
        cases_text = json.dumps(cases)
        for distinction in ['upstream', 'acknowledgement', 'exact absence']:
            self.assertIn(distinction, cases_text)

    def test_packet_document_links_resolve_to_existing_instructions(self):
        document = ROOT / 'docs/QUALIFICATION.md'
        text = document.read_text()
        for target in re.findall(r'\[[^\]]+\]\(([^)]+)\)', text):
            if target.startswith('https://') or target.startswith('#'):
                continue
            self.assertTrue((document.parent / target.split('#')[0]).is_file(), target)


if __name__ == '__main__':
    unittest.main()
