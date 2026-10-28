"""Loopback integration of the approved read-only C contract; no provider calls."""
import http.client
import json
import threading
from unittest.mock import patch

from tests.test_recordings import RecordingCase
from recovery_room.workbench import MODE, Workbench, make_server


class RecordingHTTPTests(RecordingCase):
    def setUp(self):
        super().setUp()
        self.fixture_data = self.fixture(reject_first=True)
        self.publish(self.fixture_data)
        self.workbench = self.app()
        self.server = self.start_server(self.workbench)

    def start_server(self,app):
        server = make_server(app,0)
        server.RequestHandlerClass.log_message = lambda *args: None
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(self.close_server,server,thread)
        return server

    @staticmethod
    def close_server(server,thread):
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)

    def request(self,path,method='GET',body=None,headers=None,server=None):
        server = server or self.server
        conn = http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
        try:
            conn.request(method,path,body=body,headers=headers or {})
            response = conn.getresponse()
            return response.status,dict(response.getheaders()),response.read()
        finally:
            conn.close()

    def test_list_detail_shapes_guards_and_existing_offline_mode(self):
        with patch('recovery_room.agent.AgentTools.call',side_effect=AssertionError('No tool replay')), \
                patch('recovery_room.agent.MetaClient.complete',side_effect=AssertionError('No model call')):
            status,headers,body = self.request('/api/incidents/import-retry/recordings')
            self.assertEqual(status,200)
            listed = json.loads(body)
            self.assertEqual(set(listed[0]),{'id','model','mode','outcome','summary','tool_calls','elapsed_seconds','recorded_at','fixture_matches'})
            self.assertTrue(listed[0]['fixture_matches'])
            identifier = listed[0]['id']
            self.assertRegex(identifier,r'^recording-[0-9a-f]{12}$')
            status,_,body = self.request('/api/recordings/'+identifier)
            detail = json.loads(body)
            self.assertEqual(status,200)
            self.assertEqual(detail['provenance']['label'],'Recorded model run, not live')
            self.assertEqual(detail['review']['cancellations'],20)
            self.assertEqual(detail['downloads'],[])
            self.assertTrue(detail['read_only'])
            self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
            self.assertEqual(headers['Cache-Control'],'no-store')
            self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
            self.assertNotIn(str(self.root).replace('\\','\\\\'),json.dumps(detail))
            self.assertEqual(self.request('/api/recordings/'+identifier,'POST','{}',{'Content-Type':'application/json'})[0],404)
            self.assertEqual(self.request('/api/recordings/'+identifier+'/artifacts/repair.sql')[0],404)
            self.assertEqual(self.request('/api/runs/'+identifier+'/rehearse','POST','{}',{'Content-Type':'application/json'})[0],404)
            self.assertEqual(json.loads(self.request('/api/incidents')[2])['mode'],MODE)
            self.assertIn(b'Offline demo',self.request('/')[2])

    def test_exact_recording_routes_reject_queries_paths_and_unknown_ids(self):
        identifier = json.loads(self.request('/api/incidents/import-retry/recordings')[2])[0]['id']
        for path in ('/api/incidents/import-retry/recordings?path=result.json',
                     '/api/incidents/import-retry/recordings?',
                     '/api/recordings/'+identifier+'?raw=true',
                     '/api/recordings/'+identifier+'/'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0],400)
        for path in ('/api/recordings/result.json','/api/recordings/..%5c..%5c.env',
                     '/api/recordings/'+identifier+'/result.json',
                     '/api/incidents/unknown/recordings'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0],404)

    def test_recording_routes_keep_host_origin_and_fetch_site_checks(self):
        for headers in ({'Host':'attacker.example'}, {'Origin':'https://attacker.example'}, {'Sec-Fetch-Site':'cross-site'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request('/api/incidents/import-retry/recordings',headers=headers)[0],403)

    def test_current_case_drift_disables_citations_but_keeps_historical_review(self):
        identifier = json.loads(self.request('/api/incidents/import-retry/recordings')[2])[0]['id']
        note = self.workbench.incident('import-retry')/'evidence/incident_note.txt'
        note.write_text(note.read_text()+'\nchanged after launch')
        status,_,body = self.request('/api/recordings/'+identifier)
        detail = json.loads(body)
        self.assertEqual(status,200)
        self.assertFalse(detail['fixture_matches'])
        self.assertFalse(detail['citations_enabled'])
        self.assertEqual(detail['review']['cancellations'],20)
        self.assertEqual(detail['downloads'],[])
        self.assertTrue(all(row['evidence_refs']==[] for row in detail['review']['changes']))
        self.assertIn('recorded_evidence_refs_text',detail['review']['changes'][0])

    def test_missing_library_keeps_empty_lists_without_changing_offline_actions(self):
        app = Workbench(self.root/'empty-library-app')
        server = self.start_server(app)
        status,_,body = self.request('/api/incidents/import-retry/recordings',server=server)
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body),[])
        status,_,body = self.request('/api/incidents/import-retry/investigate','POST','{}',{'Content-Type':'application/json'},server=server)
        self.assertEqual(status,201)
        self.assertEqual(json.loads(body)['mode'],MODE)
