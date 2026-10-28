"""Recording-file/API fixtures, never live provider calls or model evaluations."""
from __future__ import annotations

import copy
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.agent import run_agent
from recovery_room.baselines import event_aware_plan
from recovery_room.db import fingerprint, snapshot
from recovery_room.fixtures import create_incident
from recovery_room.recordings import LABEL, MAX_BUNDLE_BYTES, RecordingCatalog, export_recording
from recovery_room.repairs import evidence_fingerprint
from recovery_room.workbench import MODE, Workbench


def completion(content=None, calls=None):
    return {"choices":[{"message":{"role":"assistant","content":content,"tool_calls":calls or []},
                        "finish_reason":"tool_calls" if calls else "stop"}]}


def call(identifier, name, arguments):
    return {"id":identifier,"type":"function","function":{"name":name,"arguments":json.dumps(arguments)}}


class FileFixtureTransport:
    model = "file-fixture-NOT-a-provider-call"

    def __init__(self, plan, outcome, reject_first=False):
        self.plan, self.outcome, self.reject_first, self.step = plan,outcome,reject_first,0

    def complete(self,messages):
        self.step += 1
        if self.outcome == "error":
            raise ValueError('Unavailable C:\\private\\incident.db Authorization: Bearer sample-secret')
        if self.outcome == "stop":
            return completion(json.dumps({"outcome":"stop","summary":"Missing commit mappings for 20 source events; events.jsonl:L42 records the gap.","rehearsal_id":None}))
        if self.step == 1:
            return completion(calls=[call("schema","get_schema",{}), call("note","read_artifact",{"name":"incident_note.txt"})])
        if self.step == 2 and self.reject_first:
            bad = copy.deepcopy(self.plan)
            bad["cancellations"][0]["duplicate_of"] = bad["cancellations"][0]["order_id"]
            return completion(calls=[call("rejected","rehearse_repair",{"plan":bad})])
        if self.step == (3 if self.reject_first else 2):
            return completion(calls=[call("repair","rehearse_repair",{"plan":self.plan})])
        observed = json.loads(messages[-1]["content"])
        return completion(json.dumps({"outcome":"repair","summary":"Fixture-only recorded repair with events.jsonl:L1 citations.","rehearsal_id":observed["rehearsal_id"]}))


class RecordingCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root/"library"
        self.serial = 0

    def fixture(self, outcome="repair", *, scenario="complete", reject_first=False, legacy=False):
        self.serial += 1
        case_root = self.root/f"case-{self.serial}"
        incident = create_incident(case_root,scenario,23)
        manifest = case_root/"source-before.json"
        manifest.write_text(json.dumps([{"path":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in incident.rglob('*') if path.is_file()]))
        client = FileFixtureTransport(event_aware_plan(incident),outcome,reject_first)
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("No provider calls in file-fixture tests")):
            result = run_agent(incident,case_root/"agent-runs",client)
        self.assertEqual(result["mode"],"test_transport")
        self.assertTrue(result["inputs_unchanged"])
        self.assertEqual(result["input_fingerprints"], {"source":fingerprint(snapshot(incident/'orders.db')),"evidence":evidence_fingerprint(incident)})
        session = Path(result["session"])
        # Explicit synthetic FILE fixture for the loader, not a claimed live test result.
        result["mode"] = "live_meta_agent"
        result["recorded_at"] = "2026-10-20T12:00:00+00:00"
        result["usage"] = [{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,
                            "prompt_tokens_details":{"cached_tokens":50},"completion_tokens_details":{"reasoning_tokens":5}}
                           for _ in result["usage"]]
        if legacy:
            for field in ("input_fingerprints","inputs_unchanged","recorded_at"):
                result.pop(field)
        (session/'result.json').write_text(json.dumps(result),encoding='utf-8')
        return incident,session,result,manifest

    def publish(self, fixture, case="import-retry", *, legacy=False):
        incident,session,_,manifest = fixture
        return export_recording(incident,session,case,self.library,input_manifest=manifest if legacy else None)

    def app(self, *, seed=23, case_ids=None):
        self.serial += 1
        return Workbench(self.root/f"app-{self.serial}",seed,recordings=self.library,case_ids=case_ids)


class RecordingTests(RecordingCase):
    def test_native_repair_projects_actual_rejection_and_exact_review_without_replaying(self):
        fixture = self.fixture(reject_first=True)
        before = snapshot(fixture[0]/'orders.db')
        self.publish(fixture)
        app = self.app()
        with patch("recovery_room.agent.AgentTools.call",side_effect=AssertionError("Replay forbidden")), \
                patch("recovery_room.agent.MetaClient.complete",side_effect=AssertionError("Model call forbidden")):
            listing = app.list_recordings('import-retry')
            detail = app.recording(listing[0]['id'])
        self.assertTrue(detail['fixture_matches'])
        self.assertTrue(detail['citations_enabled'])
        self.assertEqual(detail['provenance']['label'],LABEL)
        self.assertEqual(detail['provenance']['input_provenance'],'native_capture')
        self.assertEqual(detail['review']['cancellations'],20)
        self.assertEqual(detail['review']['checkout_preserved'],10)
        self.assertEqual(len(detail['review']['checkout_order_ids']),10)
        self.assertTrue(all(check['passed'] for check in detail['review']['checks']))
        self.assertEqual(detail['downloads'],[])
        self.assertTrue(detail['read_only'])
        errors = [step for step in detail['steps'] if step['kind']=='tool_result' and step['error']]
        self.assertEqual(len(errors),1)
        self.assertIn('duplicate itself',errors[0]['result']['error'])
        self.assertEqual(snapshot(fixture[0]/'orders.db'),before)
        self.assertEqual(app.list_runs('import-retry'),[])
        serialized = json.dumps(detail)
        for private in ('candidate_path','report_path','responses_path',str(self.root).replace('\\','\\\\')):
            self.assertNotIn(private,serialized)
        self.assertEqual(detail['usage']['input_tokens'],400)
        self.assertEqual(detail['usage']['output_tokens'],80)
        self.assertEqual(detail['usage']['reasoning_tokens'],20)
        self.assertTrue(detail['usage']['reasoning_included_in_output'])

    def test_stops_and_errors_have_native_provenance_and_no_recorded_review(self):
        for outcome,scenario,case in (('stop','missing-evidence','missing-evidence'),('error','complete','import-retry')):
            with self.subTest(outcome=outcome):
                fixture = self.fixture(outcome,scenario=scenario)
                self.publish(fixture,case)
                app = self.app()
                detail = app.recording(app.list_recordings(case)[0]['id'])
                self.assertEqual(detail['outcome'],outcome)
                self.assertIsNone(detail['review'])
                self.assertTrue(detail['fixture_matches'])
                self.assertEqual(detail['downloads'],[])
                self.assertNotIn('sample-secret',json.dumps(detail))
                self.assertNotIn('private',json.dumps(detail))

    def test_legacy_import_requires_and_verifies_every_original_file(self):
        fixture = self.fixture(legacy=True)
        with self.assertRaisesRegex(ValueError,'pre-run input manifest'):
            self.publish(fixture)
        self.publish(fixture,legacy=True)
        app = self.app()
        detail = app.recording(app.list_recordings('import-retry')[0]['id'])
        self.assertEqual(detail['provenance']['input_provenance'],'verified_legacy_file_manifest')
        self.assertEqual(detail['provenance']['timestamp_source'],'result_file_mtime')
        (fixture[0]/'evidence/incident_note.txt').write_text('changed',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'no longer match'):
            self.publish(fixture,legacy=True)

    def test_legacy_manifest_cannot_select_a_file_outside_the_incident(self):
        fixture = self.fixture(legacy=True)
        incident,_,_,manifest = fixture
        items = json.loads(manifest.read_text())
        items[0]['path'] = str(self.root/'outside-secret.txt')
        manifest.write_text(json.dumps(items))
        with self.assertRaisesRegex(ValueError,'exactly this incident'):
            self.publish(fixture,legacy=True)
        self.assertFalse(self.library.exists())

    def test_legacy_recording_cannot_borrow_another_incidents_manifest(self):
        first = self.fixture('stop',scenario='missing-evidence',legacy=True)
        second = self.fixture('stop',scenario='missing-evidence',legacy=True)
        with self.assertRaisesRegex(ValueError,'original incident root'):
            export_recording(second[0],first[1],'missing-evidence',self.library,input_manifest=second[3])

    def test_catalog_rejects_bad_modes_case_assignments_and_orphan_results(self):
        fixture = self.fixture()
        folder = Path(self.publish(fixture)['recording_folder'])
        path = folder/'recording.json'
        original = json.loads(path.read_text())
        changes = [lambda b:b['provenance'].update(mode='test_transport'),
                   lambda b:b.update(schema_version=True),
                   lambda b:b['provenance'].update(input_provenance='unknown'),
                   lambda b:b.update(incident_id='missing-evidence'),
                   lambda b:b.update(steps=[{'kind':'tool_result','call_id':'call-1','result':{},'error':False}]),
                   lambda b:b['review'].update(changes=[{}]*41),
                   lambda b:b['review'].update(checks=[None]),
                   lambda b:b.update(review=None),
                   lambda b:b['usage'].update(response_count=25)]
        for modify in changes:
            modified = copy.deepcopy(original)
            modify(modified)
            path.write_text(json.dumps(modified))
            with self.assertRaises(ValueError):
                self.app()
        path.write_text(json.dumps(original))

    def test_native_changed_inputs_or_damaged_candidate_cannot_be_published(self):
        fixture = self.fixture()
        (fixture[0]/'evidence/incident_note.txt').write_text('changed')
        with self.assertRaisesRegex(ValueError,'changed or mismatched'):
            self.publish(fixture)
        fixture = self.fixture()
        with closing(sqlite3.connect(fixture[2]['candidate_path'])) as conn:
            conn.execute("UPDATE products SET on_hand=on_hand+1 WHERE sku='MOUSE'")
            conn.commit()
        with self.assertRaisesRegex(ValueError,'independent read-only validation'):
            self.publish(fixture)

    def test_fixture_mismatch_disables_link_fields_and_rechecks_each_request(self):
        fixture = self.fixture()
        self.publish(fixture)
        app = self.app(seed=41)
        listed = app.list_recordings('import-retry')
        self.assertFalse(listed[0]['fixture_matches'])
        detail = app.recording(listed[0]['id'])
        self.assertFalse(detail['citations_enabled'])
        self.assertIn('disabled',detail['fixture_warning'])
        self.assertTrue(all(not row['evidence_refs'] for row in detail['review']['changes']))
        app = self.app()
        identifier = app.list_recordings('import-retry')[0]['id']
        self.assertTrue(app.recording(identifier)['fixture_matches'])
        note = app.incident('import-retry')/'evidence/incident_note.txt'
        note.write_text(note.read_text()+'\nnew evidence')
        self.assertFalse(app.recording(identifier)['fixture_matches'])
        self.assertFalse(app.recording(identifier)['citations_enabled'])
        # Recorded snapshots never become normal offline runs with download/rehearse access.
        with self.assertRaises(KeyError):
            app.rehearse(identifier)

    def test_sensitive_fields_strings_and_large_payloads_are_sanitized(self):
        fixture = self.fixture()
        path = fixture[1]/'transcript.json'
        messages = json.loads(path.read_text())
        tool = next(message for message in messages if message.get('role')=='tool')
        tool['content'] = json.dumps({'COUNT(*)':80,'apiKey':'secret-one','api-key':'secret-five','headers':{'Authorization':'Bearer secret-two'},
            'candidate_path':'C:\\private\\source.db','text':'"api_key": "secret-three" /home/person/key.txt LLM|123|secret-four',
            'rows':[{'v':'X'*1000} for _ in range(200)]})
        path.write_text(json.dumps(messages))
        self.publish(fixture)
        app = self.app()
        detail = app.recording(app.list_recordings('import-retry')[0]['id'])
        serialized = json.dumps(detail)
        for value in ('secret-one','secret-two','secret-three','secret-four','secret-five','/home/person','C:\\\\private'):
            self.assertNotIn(value,serialized)
        self.assertIn('COUNT(*)',serialized)
        step = next(row for row in detail['steps'] if row['kind']=='tool_result')
        self.assertTrue(step['truncated'])
        self.assertLess(len(json.dumps(step['result']).encode()),16384)

    def test_test_transport_cannot_be_labelled_as_a_recorded_model_by_import(self):
        fixture = self.fixture()
        fixture[2]['mode'] = 'test_transport'
        (fixture[1]/'result.json').write_text(json.dumps(fixture[2]))
        with self.assertRaisesRegex(ValueError,'Only recorded live Meta'):
            self.publish(fixture)

    def test_library_is_session_scoped_sorted_and_isolated_from_disk_changes(self):
        fixture = self.fixture()
        first = self.publish(fixture)
        fixture[2]['recorded_at'] = '2026-10-21T12:00:00Z'
        (fixture[1]/'result.json').write_text(json.dumps(fixture[2]))
        self.publish(fixture)
        app = self.app()
        listing = app.list_recordings('import-retry')
        self.assertEqual(len(listing),2)
        self.assertGreater(listing[0]['recorded_at'],listing[1]['recorded_at'])
        self.assertEqual(app.list_recordings('missing-evidence'),[])
        Path(first['recording_folder'],'recording.json').write_text('changed after startup')
        self.assertTrue(app.recording(listing[1]['id'])['fixture_matches'])
        with self.assertRaises(ValueError):
            self.app()

    def test_library_links_size_limits_and_recording_cap_fail_closed(self):
        fixture = self.fixture()
        published = self.publish(fixture)
        folder = Path(published['recording_folder'])
        with patch('recovery_room.recordings._linked',side_effect=lambda path: path==folder):
            with self.assertRaisesRegex(ValueError,'links and junctions'):
                self.app()
        original = (folder/'recording.json').read_bytes()
        (folder/'recording.json').write_bytes(b'X'*(MAX_BUNDLE_BYTES+1))
        with self.assertRaisesRegex(ValueError,'size limit'):
            self.app()
        (folder/'recording.json').write_bytes(original)
        self.publish(fixture)
        with patch('recovery_room.recordings.MAX_RECORDINGS',1):
            with self.assertRaisesRegex(ValueError,'limits'):
                self.app()

    def test_disabled_recordings_keep_offline_behavior_and_server_owned_ids(self):
        app = Workbench(self.root/'no-recordings')
        self.assertEqual(app.list_recordings('import-retry'),[])
        self.assertEqual(app.overview('import-retry')['mode'],MODE)
        for value in ('../result.json',str(self.root),'recording-not-in-session'):
            with self.subTest(value=value), self.assertRaises(KeyError):
                app.recording(value)

    def test_native_provenance_marks_midrun_input_changes_even_on_error(self):
        incident = create_incident(self.root/'mutating-case',seed=23)
        initial = evidence_fingerprint(incident)

        class MutatingTransport:
            def complete(self,messages):
                note = incident/'evidence/incident_note.txt'
                note.write_text(note.read_text()+'\nchanged mid-run')
                raise ValueError('Offline test failure after evidence changed')

        result = run_agent(incident,self.root/'mutating-runs',MutatingTransport())
        self.assertEqual(result['input_fingerprints']['evidence'],initial)
        self.assertFalse(result['inputs_unchanged'])
        self.assertEqual(result['final']['outcome'],'error')
        self.assertIn('+00:00',result['recorded_at'])
