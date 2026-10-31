// Dependency-free frontend state tests. No browser, server or model calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../recovery_room/web/app.js'), 'utf8');

function harness(handler) {
  const nodes = new Map();
  const element = () => ({addEventListener() {}, setAttribute() {}, removeAttribute() {},
    focus() {}, scrollIntoView() {}, textContent: '', innerHTML: '', value: '', hidden: false});
  const context = {
    document: {
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      addEventListener() {},
    },
    window: {addEventListener() {}}, location: {hash: ''}, history: {replaceState() {}},
    fetch: (url, options) => url === '/api/incidents' ? new Promise(() => {}) : handler(url, options),
    setTimeout, clearTimeout, URL, renderCalls: 0,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nrender = () => { globalThis.renderCalls++; };\nrenderPanel = () => {};\nglobalThis.subject = {state, download, reviewView, exportStatus, recheckExport, act, changesView, checksTab, sqlView, modeInfo, repairFlow, stockVisual, transition, packageView, lineContext, evidenceWrites, reconstructionView, runsCompare, checkContext, checksTab};', context);
  return {context, nodes, ...context.subject};
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function json(ok, value) { return {ok, json: async () => value}; }
function run(id, incident, status = 'ready_for_review') { return {id, incident_id: incident, status}; }

function delayedFailure() {
  const delayed = deferred(), requests = [];
  const app = harness(async url => {
    requests.push(url);
    if (url.endsWith('/artifacts/repair.sql')) return delayed.promise;
    const id = url.split('/').pop();
    return json(true, run(id, id.startsWith('run-a') ? 'case-a' : 'case-b', 'blocked'));
  });
  return {app, delayed, requests};
}

test('a delayed export failure updates its original case without overwriting another case', async () => {
  const {app, delayed, requests} = delayedFailure();
  const first = run('run-a', 'case-a'), second = run('run-b', 'case-b');
  app.state.incident = {id: 'case-a', title: 'First case'}; app.state.run = first; app.state.runs.set('case-a', first);
  const pending = app.download('repair.sql');
  app.state.incident = {id: 'case-b', title: 'Second case'}; app.state.run = second; app.state.runs.set('case-b', second);
  delayed.resolve(json(false, {error: 'Source changed since rehearsal.'}));
  await assert.rejects(pending, /First case.*Source changed/);
  assert.equal(requests[1], '/api/runs/run-a');
  assert.equal(app.state.run, second);
  assert.equal(app.state.runs.get('case-b'), second);
  assert.equal(app.state.runs.get('case-a').status, 'blocked');
  assert.equal(app.context.renderCalls, 0);
});

test('an older export failure cannot replace a newer investigation in the same case', async () => {
  const {app, delayed, requests} = delayedFailure();
  const first = run('run-a', 'case-a'), newer = run('run-a-new', 'case-a');
  app.state.incident = {id: 'case-a'}; app.state.run = first; app.state.runs.set('case-a', first);
  const pending = app.download('repair.sql');
  app.state.run = newer; app.state.runs.set('case-a', newer);
  delayed.resolve(json(false, {error: 'Evidence changed since rehearsal.'}));
  await assert.rejects(pending, /Evidence changed/);
  assert.equal(requests[1], '/api/runs/run-a');
  assert.equal(app.state.run, newer);
  assert.equal(app.state.runs.get('case-a'), newer);
  assert.equal(app.context.renderCalls, 0);
});

test('a failure for the currently selected run still renders its blocked state', async () => {
  const {app, delayed} = delayedFailure();
  const current = run('run-a', 'case-a');
  app.state.incident = {id: 'case-a'}; app.state.run = current; app.state.runs.set('case-a', current);
  const pending = app.download('repair.sql');
  delayed.resolve(json(false, {error: 'Candidate changed since rehearsal.'}));
  await assert.rejects(pending, /Candidate changed/);
  assert.equal(app.state.run.status, 'blocked');
  assert.equal(app.state.runs.get('case-a').status, 'blocked');
  assert.equal(app.context.renderCalls, 1);
});

function reviewRun(status) {
  return {
    ...run('run-a', 'case-a', status), summary: 'Source changed since rehearsal.', downloads: [],
    review: {
      passed: true, before_active: 80, after_active: 60, cancellations: 20,
      checkout_preserved: 10, checkout_total: 10, untargeted_preserved: 60,
      changes: [], preserved_orders: [], stock: [],
      checks: [{name: 'source_snapshot_unchanged', passed: true, detail: 'Source matched at rehearsal.'}],
    },
  };
}

test('a blocked export does not claim that its source still matches the old snapshot', () => {
  const app = harness();
  app.state.run = reviewRun('blocked');
  const rendered = app.reviewView();
  assert.match(rendered, /Export unavailable/);
  assert.match(rendered, /Export is blocked/);
  assert.doesNotMatch(rendered, />Source matches the rehearsed snapshot</);
  assert.match(rendered, /rehearsal snapshot/);
});

test('a current review preserves observed counts and qualifies its earlier source check', () => {
  const app = harness();
  app.state.run = reviewRun('ready_for_review');
  const rendered = app.reviewView();
  assert.match(rendered, /80 → 60/);
  assert.match(rendered, /20<\/strong>/);
  assert.match(rendered, /10 \/ 10/);
  assert.match(rendered, /Source unchanged at rehearsal/);
});

test('an unknown failed check remains visible rather than being dropped by grouping', () => {
  const app = harness();
  app.state.run = reviewRun('failed_checks');
  app.state.run.review.checks.push({name: 'additional_business_rule', passed: false, detail: 'Observed failure'});
  const rendered = app.reviewView();
  assert.match(rendered, /Other checks/);
  assert.match(rendered, /Additional business rule/);
  assert.match(rendered, /Observed failure/);
});

test('a passing rehearsal does not claim current export availability', () => {
  const app = harness();
  const current = reviewRun('ready_for_review');
  app.state.run = current;
  assert.equal(app.exportStatus(current).label, 'Passed at rehearsal · Recheck required');
  assert.notEqual(app.exportStatus(current).tone, 'ok');
  // Even a remembered successful check cannot override a server refusal.
  app.state.exportChecks.set(current.id, {ok: true, at: new Date(), artifact: 'report.json'});
  current.status = 'blocked';
  assert.equal(app.exportStatus(current).label, 'Refused');
});

test('explicit recheck waits for the guarded artifact route before showing a passed check', async () => {
  const delayed = deferred(), requests = [];
  const app = harness(async url => { requests.push(url); return delayed.promise; });
  const current = reviewRun('ready_for_review');
  app.state.incident = {id: 'case-a', title: 'First case'};
  app.state.run = current; app.state.runs.set('case-a', current);
  const pending = app.recheckExport();
  assert.equal(requests.length, 1);
  assert.equal(requests[0], '/api/runs/run-a/artifacts/report.json');
  assert.equal(app.exportStatus(current).label, 'Rechecking current files…');
  await app.recheckExport(); // duplicate clicks cannot create another request
  assert.equal(requests.length, 1);
  delayed.resolve({ok: true, text: async () => '{}'});
  await pending;
  assert.equal(app.state.rechecking.size, 0);
  assert.equal(app.exportStatus(current).label, 'Freshness check passed');
  assert.match(app.exportStatus(current).detail, /Every export is checked again/);
  assert.equal(app.state.run, current);
});

test('a refused explicit recheck blocks the current run using the server record', async () => {
  const requests = [], blocked = {...reviewRun('blocked'), summary: 'Evidence changed since rehearsal.'};
  const app = harness(async url => {
    requests.push(url);
    return url.endsWith('/artifacts/report.json') ? json(false, {error: blocked.summary}) : json(true, blocked);
  });
  const current = reviewRun('ready_for_review');
  app.state.incident = {id: 'case-a', title: 'First case'};
  app.state.run = current; app.state.runs.set('case-a', current);
  await app.recheckExport();
  assert.equal(requests[1], '/api/runs/run-a');
  assert.equal(app.state.run, blocked);
  assert.equal(app.exportStatus(blocked).label, 'Refused');
  assert.deepEqual(app.state.run.downloads, []);
  assert.equal(app.state.rechecking.size, 0);
});

test('a delayed explicit recheck never replaces a different case on screen', async () => {
  const delayed = deferred();
  const app = harness(async url => url.endsWith('/artifacts/report.json') ? delayed.promise : json(true, reviewRun('blocked')));
  const first = reviewRun('ready_for_review'), second = run('run-b', 'case-b');
  app.state.incident = {id: 'case-a', title: 'First case'};
  app.state.run = first; app.state.runs.set('case-a', first);
  const pending = app.recheckExport();
  app.state.incident = {id: 'case-b', title: 'Second case'};
  app.state.run = second; app.state.runs.set('case-b', second);
  delayed.resolve(json(false, {error: 'Source changed since rehearsal.'}));
  await pending;
  assert.equal(app.state.run, second);
  assert.equal(app.state.runs.get('case-b'), second);
  assert.equal(app.state.runs.get('case-a').status, 'blocked');
  assert.equal(app.state.rechecking.size, 0);
});

test('a new rehearsal invalidates the previous freshness observation and cached SQL', async () => {
  const reviewed = reviewRun('ready_for_review');
  const app = harness(async () => json(true, reviewed));
  app.state.incident = {id: 'case-a'}; app.state.run = reviewed;
  app.state.exportChecks.set(reviewed.id, {ok: true, at: new Date(), artifact: 'report.json'});
  app.state.sql.set(reviewed.id, {status: 'ok', text: 'old SQL'});
  await app.act('rehearse');
  assert.equal(app.state.exportChecks.has(reviewed.id), false);
  assert.equal(app.state.sql.has(reviewed.id), false);
  assert.equal(app.exportStatus(reviewed).label, 'Passed at rehearsal · Recheck required');
});

test('a network failure during recheck cannot retain a previous green freshness label', async () => {
  const app = harness(async () => { throw new Error('Network unavailable'); });
  const current = reviewRun('ready_for_review');
  app.state.incident = {id: 'case-a'}; app.state.run = current;
  app.state.exportChecks.set(current.id, {ok: true, at: new Date(), artifact: 'report.json'});
  await app.recheckExport();
  assert.equal(app.state.rechecking.size, 0);
  assert.equal(app.state.exportChecks.has(current.id), false);
  assert.equal(app.exportStatus(current).label, 'Passed at rehearsal · Recheck required');
});

test('rechecks for different runs proceed independently instead of sharing one lock', async () => {
  const pending = new Map(), requests = [];
  const app = harness(url => { requests.push(url); const d = deferred(); pending.set(url, d); return d.promise; });
  const first = reviewRun('ready_for_review');
  const second = {...reviewRun('ready_for_review'), id: 'run-b', incident_id: 'case-b'};
  app.state.incident = {id: 'case-a', title: 'First case'}; app.state.run = first; app.state.runs.set('case-a', first);
  const a = app.recheckExport();
  app.state.incident = {id: 'case-b', title: 'Second case'}; app.state.run = second; app.state.runs.set('case-b', second);
  const b = app.recheckExport();
  assert.deepEqual(requests, ['/api/runs/run-a/artifacts/report.json', '/api/runs/run-b/artifacts/report.json']);
  assert.equal(app.exportStatus(first).label, 'Rechecking current files…');
  assert.equal(app.exportStatus(second).label, 'Rechecking current files…');
  for (const d of pending.values()) d.resolve({ok: true, text: async () => '{}'});
  await Promise.all([a, b]);
  assert.equal(app.state.rechecking.size, 0);
  assert.equal(app.exportStatus(second).label, 'Freshness check passed');
});

test('a run blocked before rehearsal points to a new investigation, never to rehearsing', () => {
  const app = harness();
  app.state.run = {id: 'run-a', incident_id: 'case-a', status: 'blocked', review: null, downloads: [],
    summary: 'The source changed since investigation. Start a new investigation and rehearsal.'};
  for (const view of [app.changesView, app.checksTab, app.sqlView]) {
    const rendered = view();
    assert.match(rendered, /Rehearsal refused/);
    assert.match(rendered, /The source changed since investigation/);
    assert.match(rendered, /new offline investigation/);
    assert.doesNotMatch(rendered, /Rehearse the proposal/);
  }
});

test('an unrecognised mode is shown as reported and never labelled offline or no-model', () => {
  const app = harness();
  const offline = app.modeInfo('offline_deterministic_engine_demo_NOT_a_model_run');
  assert.equal(offline.short, 'Offline demo · No model');
  const other = app.modeInfo('live_meta_agent');
  assert.equal(other.unverified, true);
  assert.match(other.short, /live meta agent/);
  for (const value of [other.short, other.long, other.method]) assert.doesNotMatch(value, /offline demo|without model|no model\b(?!-)/i);
});

test('repair proportions use observed counts and work under the existing style policy', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  for (const [cancelled, preserved, width] of [[20, 60, 25], [40, 60, 40], [0, 60, 0]]) {
    const rendered = app.repairFlow({...review, cancellations: cancelled, untargeted_preserved: preserved});
    const changed = Number(rendered.match(/class="impact-changed"[^>]+width="([^"]+)"/)[1]);
    const unchanged = Number(rendered.match(/class="impact-preserved"[^>]+width="([^"]+)"/)[1]);
    assert.equal(changed, width);
    assert.equal(changed + unchanged, 100);
    assert.match(rendered, new RegExp(`${cancelled} cancelled orders and ${preserved} unchanged orders`));
    assert.doesNotMatch(rendered, /\bstyle=|data-count/);
  }
});

test('missing or invalid counts never become an invented repair proportion', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  for (const [cancellations, untargeted_preserved] of [[null, 60], [20, undefined], [-1, 60], [0, 0], [NaN, 60]]) {
    assert.doesNotMatch(app.repairFlow({...review, cancellations, untargeted_preserved}), /class="impact"/);
  }
});

test('a recorded outcome cannot imply a currently exportable package', () => {
  const app = harness();
  const rendered = app.repairFlow(reviewRun('ready_for_review').review,
    {recorded: true, run: reviewRun('ready_for_review')});
  assert.match(rendered, /at recorded rehearsal/);
  assert.match(rendered, /Read-only recording · no downloads/);
  assert.doesNotMatch(rendered, /Package for human review|freshness checked on download/);
});

test('stock marks share a zero baseline and show the direction of observed changes', () => {
  const app = harness();
  const gain = app.stockVisual({before: 40, after: 60}, 100);
  assert.match(gain, /class="stock-base"[^>]+x="0"[^>]+width="40"/);
  assert.match(gain, /class="stock-delta "[^>]+x="40"[^>]+width="20"/);
  assert.match(gain, /<line x1="60" x2="60"/);
  const loss = app.stockVisual({before: 60, after: 40}, 100);
  assert.match(loss, /class="stock-delta negative"[^>]+x="40"[^>]+width="20"/);
  assert.match(loss, /<line x1="40" x2="40"/);
  const zero = app.stockVisual({before: 0, after: 10}, 100);
  assert.match(zero, /class="stock-base"[^>]+width="0"/);
  assert.doesNotMatch(gain + loss + zero, /\bstyle=/);
});

test('stock values remain readable when a meaningful shared scale is unavailable', () => {
  const app = harness();
  for (const [before, after, maximum] of [[-2, 4, 10], [0, 0, 0], [4, 8, 5], [4, 8, NaN]]) {
    const rendered = app.stockVisual({before, after}, maximum);
    assert.match(rendered, new RegExp(`>${before}</span>`));
    assert.match(rendered, new RegExp(`>${after}</strong>`));
    assert.doesNotMatch(rendered, /<svg/);
  }
});

test('navigation commits synchronously and cancels a previous entrance animation', () => {
  const app = harness(), events = [];
  app.context.document.querySelector('#content');
  const panel = app.nodes.get('#content');
  panel.getAnimations = () => [{cancel: () => events.push('cancel')}];
  panel.animate = () => events.push('animate');
  app.transition(() => events.push('update'), 'case');
  assert.deepEqual(events, ['update', 'cancel', 'animate']);
  app.context.window.matchMedia = () => ({matches: true});
  app.transition(() => events.push('reduced-motion update'), 'case');
  assert.equal(events.at(-1), 'reduced-motion update');
  assert.equal(events.length, 4);
});

// ---------- Repair package ----------

function packageRun(status) {
  const current = reviewRun(status);
  Object.assign(current, {
    source_fingerprint: 'f00d97029ad379dc0552277062a761534e4393b6aceb8fbab1eef9b0a5a23d50',
    evidence_fingerprint: 'dfab8cd5b0ddbf5375e36e73cf8c4f9bdd48617dd1fdb16ae739d8715ab311ff',
    downloads: status === 'ready_for_review' ? ['repair.sql', 'plan.json', 'report.json', 'report.html'] : [],
  });
  current.review.changes = [
    {before: {id: 'ord_b', sku: 'MUG'}, after: {id: 'ord_b', sku: 'MUG'}, duplicate_of: 'ord_a', evidence_refs: ['events.jsonl:L2', 'events.jsonl:L5']},
    {before: {id: 'ord_d', sku: 'MUG'}, after: {id: 'ord_d', sku: 'MUG'}, duplicate_of: 'ord_c', evidence_refs: ['events.jsonl:L3', 'events.jsonl:L6']},
  ];
  current.review.stock = [{sku: 'MUG', before: 4, after: 7}, {sku: 'CAP', before: 2, after: 2}];
  return current;
}

test('the repair package describes its files from the run and shows the pinned fingerprints', () => {
  const app = harness();
  const current = packageRun('ready_for_review');
  app.state.run = current;
  const card = app.packageView(current);
  for (const name of current.downloads) assert.match(card, new RegExp(`data-download="${name.replace('.', '\\.')}"`));
  assert.match(card, /Cancels 20 orders and returns stock on 1 product\./);
  assert.match(card, /2 cancellations, citing 4 evidence lines\./);
  assert.match(card, /1 \/ 1 checks · active orders 80 → 60\./);
  assert.match(card, />f00d97029ad3</);
  assert.match(card, />dfab8cd5b0dd</);
  assert.match(card, /title="f00d97029ad379dc/);
  assert.match(card, /Passed at rehearsal · Recheck required/);
  assert.match(card, /data-recheck-export/);
  assert.doesNotMatch(card, /\bstyle=/);
});

test('a refused or failed package offers no downloads and keeps the server reason', () => {
  const app = harness();
  const blocked = packageRun('blocked');
  blocked.downloads = ['repair.sql']; // even a stale list must not become a download control
  app.state.run = blocked;
  const refused = app.packageView(blocked);
  assert.doesNotMatch(refused, /data-download|data-recheck-export/);
  assert.match(refused, /Refused/);
  assert.match(refused, /Source changed since rehearsal\./);
  assert.match(refused, /Nothing is served for this run\./);

  const failed = packageRun('failed_checks');
  app.state.run = failed;
  const unavailable = app.packageView(failed);
  assert.doesNotMatch(unavailable, /data-download|data-recheck-export/);
  assert.match(unavailable, /Unavailable/);
  assert.match(unavailable, /Operational checks failed at rehearsal/);
});

test('missing fingerprints are omitted rather than shown as placeholders', () => {
  const app = harness();
  const current = packageRun('ready_for_review');
  delete current.source_fingerprint;
  app.state.run = current;
  const card = app.packageView(current);
  assert.doesNotMatch(card, /Pinned at investigation/);
  assert.match(card, /data-recheck-export/);
});

// ---------- Evidence lines and the incident timeline ----------

function evidenceState(app, files, {incident = 'case-a', orders = []} = {}) {
  app.state.incident = {id: incident, artifacts: Object.keys(files).map(name => ({name})), orders};
  for (const [name, rows] of Object.entries(files)) {
    const lines = rows.map((row, i) => ({ref: `${name}:L${i + 1}`, text: typeof row === 'string' ? row : JSON.stringify(row)}));
    app.state.files.set(`${incident}:${name}`, {data: {lines, total: lines.length}});
  }
}
const write = (attempt, order_id, extra = {}) => ({type: 'write_committed', attempt, event_id: `evt-${order_id}`, order_id, ...extra});

test('a selected line from another evidence file names its file and offers to show it', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a')], 'commit_receipts.csv': ['type,attempt,event_id,order_id']});
  app.state.tab = 'evidence';
  app.state.ev.name = 'commit_receipts.csv';
  const other = app.lineContext('events.jsonl:L1');
  assert.match(other, /From <span class="mono">events\.jsonl<\/span>\. The log is showing <span class="mono">commit_receipts\.csv<\/span>/);
  assert.match(other, /data-open-ref="events\.jsonl:L1">Show in events\.jsonl/);
  app.state.ev.name = 'events.jsonl';
  const same = app.lineContext('events.jsonl:L1');
  assert.doesNotMatch(same, /The log is showing|data-open-ref/);
});

test('the timeline keeps file order, lanes by first appearance, and places incident markers', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [
    write('import-first', 'ord_a'), write('import-first', 'ord_b'),
    {type: 'connection_lost', detail: 'timeout'},
    write('import-retry', 'ord_c'), {type: 'log_gap'}, write('web-checkout', 'ord_d'),
  ]});
  const model = app.evidenceWrites();
  assert.deepEqual(Array.from(model.writes, w => w.order_id), ['ord_a', 'ord_b', 'ord_c', 'ord_d']);
  assert.deepEqual(Array.from(model.lanes), ['import-first', 'import-retry', 'web-checkout']);
  assert.equal(model.bySeq, false);
  const lost = model.marks.find(m => m.type === 'connection_lost'), gap = model.marks.find(m => m.type === 'log_gap');
  assert.equal(lost.attempt, 'import-first'); // the attempt that was writing when the connection dropped
  assert.equal(lost.x, 2);
  assert.equal(gap.attempt, 'import-first'); // a gap with no attempt is noted on the first lane
});

test('commit sequence orders split evidence only when every write records one', () => {
  const app = harness();
  evidenceState(app, {
    'events.jsonl': [write('import-retry', 'ord_c', {commit_seq: 3}), write('import-first', 'ord_a', {commit_seq: 1})],
    'commit_receipts.csv': ['type,attempt,event_id,order_id,movement_id,commit_seq', 'write_committed,import-first,evt-b,ord_b,mv-b,2'],
  });
  const merged = app.evidenceWrites();
  assert.equal(merged.bySeq, true);
  assert.deepEqual(Array.from(merged.writes, w => w.order_id), ['ord_a', 'ord_b', 'ord_c']);
  assert.equal(merged.writes[1].ref, 'commit_receipts.csv:L2');

  const partial = harness();
  evidenceState(partial, {'events.jsonl': [write('import-retry', 'ord_c', {commit_seq: 3}), write('import-first', 'ord_a')]});
  const fileOrder = partial.evidenceWrites();
  assert.equal(fileOrder.bySeq, false);
  assert.deepEqual(Array.from(fileOrder.writes, w => w.order_id), ['ord_c', 'ord_a']);
});

test('the timeline links repeats only from the given pairs and never invents one', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-first', 'ord_b'), write('import-retry', 'ord_c'), write('import-retry', 'ord_d')]});
  const plain = app.reconstructionView();
  assert.doesNotMatch(plain, /recon-tick (repeat|kept)|recon-arc/);
  assert.match(plain, /4 committed writes across 2 attempts\. The investigation decides which writes repeat\./);

  const linked = app.reconstructionView([{order_id: 'ord_c', duplicate_of: 'ord_a'}, {order_id: 'ord_x', duplicate_of: 'ord_b'}]);
  assert.equal((linked.match(/class="recon-tick repeat"/g) || []).length, 1);
  assert.equal((linked.match(/class="recon-tick kept"/g) || []).length, 1);
  assert.equal((linked.match(/class="recon-arc"/g) || []).length, 1); // the pair naming an unknown order is skipped
  assert.match(linked, /The proposal would cancel 1 repeated write and keep the first write of each source event\. 2 other writes would stay untouched\. Nothing is cancelled until the rehearsal\./);
  assert.match(linked, /data-key="order:ord_c"/);
  assert.doesNotMatch(linked, /\bstyle=/);

  const stopped = app.reconstructionView(null, {stopped: 20});
  assert.match(stopped, /The script stopped instead of guessing: 20 source events have no commit record\./);
});

test('a recording whose inputs differ draws the timeline without links to current records', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-retry', 'ord_b')]});
  app.state.source = 'recorded';
  app.state.recording = {incident_id: 'case-a', citations_enabled: false, review: {changes: []}};
  const view = app.reconstructionView([{order_id: 'ord_b', duplicate_of: 'ord_a'}], {recorded: true});
  assert.doesNotMatch(view, /data-key=/);
  assert.doesNotMatch(view, /Enter to open one/);
});

// ---------- Compared runs ----------

function compareState(app, {engine = ['ord_c', 'ord_d'], recs = [], details = {}, run = 'ready_for_review'} = {}) {
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-first', 'ord_b'), write('import-retry', 'ord_c'), write('import-retry', 'ord_d')]});
  app.state.run = run ? {id: 'run-a', incident_id: 'case-a', status: run, missing_event_ids: ['evt-1', 'evt-2'], review: ['ready_for_review', 'failed_checks', 'blocked'].includes(run) ? {changes: []} : null,
    plan: engine ? {cancellations: engine.map(order_id => ({order_id, duplicate_of: 'ord_a', evidence_refs: []}))} : null} : null;
  app.state.recordings.set('case-a', {status: 'ok', list: recs});
  for (const [id, data] of Object.entries(details)) app.state.recDetails.set(`case-a:${id}`, {status: 'ok', data});
  return app.runsCompare(app.evidenceWrites());
}
const recording = (id, cancelled, extra = {}) => ({id, incident_id: 'case-a', fixture_matches: true, citations_enabled: true,
  review: {changes: cancelled.map(order => ({before: {id: order}, after: {id: order}, duplicate_of: 'ord_a', evidence_refs: []}))}, ...extra});

test('compared runs mark each run against the script only from plans and verified reviews', () => {
  const app = harness();
  const view = compareState(app, {
    recs: [
      {id: 'rec-same', outcome: 'repair', fixture_matches: true},
      {id: 'rec-diff', outcome: 'repair', fixture_matches: true},
      {id: 'rec-stop', outcome: 'stop', fixture_matches: true},
      {id: 'rec-other', outcome: 'repair', fixture_matches: false},
    ],
    details: {'rec-same': recording('rec-same', ['ord_c', 'ord_d']), 'rec-diff': recording('rec-diff', ['ord_c', 'ord_b'])},
  });
  assert.match(view, /Script run<\/strong><span class="cmp-long">cancels 2</);
  assert.match(view, /Meta run 4<\/strong><span class="cmp-long">same 2 as the script</);
  assert.match(view, /Meta run 3<\/strong><span class="cmp-long">1 of 2 match · misses 1 · 1 not in the script</);
  assert.match(view, /Meta run 2<\/strong><span class="cmp-long">stopped · no repair</);
  assert.match(view, /Meta run 1<\/strong><span class="cmp-long">inputs differ · not compared</);
  assert.equal((view.match(/class="cmp-mark extra"/g) || []).length, 1); // ord_b, which the script keeps
  assert.equal((view.match(/class="cmp-missed"/g) || []).length, 1); // ord_d, which the differing run keeps
  assert.match(view, /4 recorded Meta runs: 1 cancels the same 2 writes as the script, 1 differs from the script, 1 stopped instead of repairing and 1 was not compared\./);
  assert.match(view, /data-recording="rec-other"/); // listed, so it can still be opened
  assert.doesNotMatch(view, /\bstyle=/);
});

test('a recording is not compared when its own record says the inputs differ', () => {
  const app = harness();
  const view = compareState(app, {
    recs: [{id: 'rec-a', outcome: 'repair', fixture_matches: true}],
    details: {'rec-a': recording('rec-a', ['ord_c', 'ord_d'], {citations_enabled: false})},
  });
  assert.match(view, /Meta run 1<\/strong><span class="cmp-long">inputs differ · not compared</);
  // Only the script's own two marks are drawn.
  assert.equal((view.match(/class="cmp-mark"/g) || []).length, 2);
  assert.match(view, /The recorded Meta run was not compared\./);
});

test('without a script run the rows show each recording and invite an investigation', () => {
  const app = harness();
  const view = compareState(app, {engine: null, run: null,
    recs: [{id: 'rec-a', outcome: 'repair', fixture_matches: true}, {id: 'rec-b', outcome: 'repair', fixture_matches: true}],
    details: {'rec-a': recording('rec-a', ['ord_c', 'ord_d']), 'rec-b': recording('rec-b', ['ord_c', 'ord_d'])}});
  assert.match(view, /Script run<\/strong><span class="cmp-long">not investigated yet</);
  assert.doesNotMatch(view, /cmp-missed|cmp-mark extra/);
  assert.match(view, /All 2 recorded Meta runs cancel 2 writes each\. Investigate the incident to compare them with the script\./);
});

test('stops on both sides read as agreement, not as missing repairs', () => {
  const app = harness();
  const view = compareState(app, {engine: null, run: 'stopped', recs: [{id: 'rec-a', outcome: 'stop', fixture_matches: true}, {id: 'rec-b', outcome: 'stop', fixture_matches: true}]});
  assert.match(view, /Script run<\/strong><span class="cmp-long">stopped · 2 events unmatched</);
  assert.match(view, /All 2 recorded Meta runs stopped instead of repairing, as the script did\./);
  assert.equal((view.match(/class="cmp-line stop"/g) || []).length, 3);
});

test('no recordings means no comparison', () => {
  const app = harness();
  assert.equal(compareState(app, {recs: []}), '');
});

// ---------- Review fixes: case-scoped loading, proposals, quoted CSV ----------

test('switching cases while the timeline evidence loads reads and repaints the new case', async () => {
  const slowA = deferred(), requests = [];
  const page = (lines) => json(true, {lines: lines.map((row, i) => ({ref: `events.jsonl:L${i + 1}`, text: JSON.stringify(row)})), total_lines: lines.length, next_line: null});
  const app = harness(async url => {
    requests.push(url);
    return url.includes('/incidents/case-a/') ? slowA.promise : page([write('import-first', 'ord_b')]);
  });
  let painted = 0;
  app.context.renderPanel = () => { painted++; };
  app.state.tab = 'investigation';
  app.state.incident = {id: 'case-a', artifacts: [{name: 'events.jsonl'}], orders: []};
  assert.equal(app.evidenceWrites(), null);
  app.state.incident = {id: 'case-b', artifacts: [{name: 'events.jsonl'}], orders: []};
  assert.equal(app.evidenceWrites(), null);
  assert.ok(requests.some(url => url.includes('/incidents/case-b/')), 'case B starts its own read while case A is still loading');
  await new Promise(done => setTimeout(done, 0));
  assert.equal(painted, 1, 'case B repaints when its evidence arrives');
  assert.deepEqual(Array.from(app.evidenceWrites().writes, w => w.order_id), ['ord_b']);
  slowA.resolve(page([write('import-first', 'ord_a')]));
  await new Promise(done => setTimeout(done, 0));
  assert.equal(painted, 1, 'a late case A response does not repaint case B');
});

test('a proposal shows targets; only a rehearsal shows cancellations on the copy', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-retry', 'ord_c')]});
  const pairs = [{order_id: 'ord_c', duplicate_of: 'ord_a'}];
  const proposed = app.reconstructionView(pairs);
  assert.match(proposed, /Repeat · proposed to cancel/);
  assert.doesNotMatch(proposed, /cancelled on the copy/);
  const rehearsed = app.reconstructionView(pairs, {rehearsed: true});
  assert.match(rehearsed, /Repeat · cancelled on the copy/);
  assert.match(rehearsed, /On the copy, the repair cancelled 1 repeated write and kept the first write of each source event\./);

  // Compared runs keep the script's unrehearsed targets apart from recordings' verified cancellations.
  const view = compareState(harness(), {run: 'proposed', recs: [{id: 'rec-a', outcome: 'repair', fixture_matches: true}],
    details: {'rec-a': recording('rec-a', ['ord_c', 'ord_d'])}});
  assert.match(view, /Script run<\/strong><span class="cmp-long">targets 2</);
  assert.equal((view.match(/class="cmp-mark planned"/g) || []).length, 2);
  assert.match(view, /Script’s target · not rehearsed yet/);
  assert.match(view, /The recorded Meta run cancels the same 2 writes the script targets\./);
  assert.match(view, /the script from its proposal/);
});

test('quoted CSV receipts keep their writes, commas and escaped quotes, with original line references', () => {
  const app = harness();
  evidenceState(app, {
    'events.jsonl': [write('import-retry', 'ord_c', {commit_seq: 3})],
    'commit_receipts.csv': [
      '"type","attempt","event_id","order_id","movement_id","commit_seq"',
      '"write_committed","import-first","evt-a","ord_a","mv ""a"", first",1',
      'write_committed,import-first,evt-b,ord_b,"mv-b",2',
      '"write_committed","import-first","evt-x","ord_x","mv-x"oops,4', // text after a closing quote: rejected
      '"write_committed","import-first","evt-y","ord_y","unterminated,5', // unterminated quote: rejected
    ],
  });
  const model = app.evidenceWrites();
  assert.equal(model.bySeq, true);
  assert.deepEqual(Array.from(model.writes, w => w.order_id), ['ord_a', 'ord_b', 'ord_c']);
  assert.deepEqual(Array.from(model.writes, w => w.ref), ['commit_receipts.csv:L2', 'commit_receipts.csv:L3', 'events.jsonl:L1']);
  assert.equal(model.writes[0].event_id, 'evt-a');
});

// ---------- Check diagnostics ----------

function diagnosedRun(checks) {
  const current = reviewRun('failed_checks');
  current.review.passed = false;
  current.review.checks = checks;
  return current;
}
const ledger = (keyboard) => ({name: 'stock_matches_movement_ledger', passed: keyboard === 0, detail: 'Opening stock plus all recorded movements equals current stock.',
  diagnostics: {rule: 'Stock on hand = opening stock + the sum of recorded movements', listing: 'all', total: 2, truncated: false, items: [
    {entity: {table: 'products', sku: 'KEYBOARD'}, parts: {opening: 162, movements: 10}, expected: 172, observed: 172 + keyboard, difference: keyboard, related: {added_movement_ids: ['mov_1', 'mov_2']}},
    {entity: {table: 'products', sku: 'MOUSE'}, parts: {opening: 164, movements: 0}, expected: 164, observed: 164, difference: 0}]}});

test('a check with diagnostics shows what the checker computed, not a derived view', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: [{sku: 'KEYBOARD', name: 'Keyboard'}, {sku: 'MOUSE', name: 'Mouse'}]};
  app.state.run = diagnosedRun([ledger(2)]);
  const view = app.checkContext('stock_matches_movement_ledger');
  assert.match(view, /What the checker computed/);
  assert.match(view, /Stock on hand = opening stock \+ the sum of recorded movements/);
  assert.match(view, /<th scope="col">Product<\/th><th scope="col">Expected<\/th><th scope="col">Observed<\/th><th scope="col">Difference<\/th>/);
  assert.match(view, /<small class="diag-sum">162 \+ 10<\/small>/);
  assert.match(view, /<span class="num cancelled">\+2<\/span>/);
  assert.match(view, /1 product differs from the rule\. The repair added 2 compensating movements\./);
  assert.match(view, /data-key="product:KEYBOARD">Keyboard</);
  assert.doesNotMatch(view, /Derived from the rehearsal review/);
});

test('failed checks state their first exception in one line', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: []};
  app.state.run = diagnosedRun([ledger(2), {name: 'unaffected_orders_preserved', passed: false, detail: 'Every untargeted order matches.',
    diagnostics: {rule: 'r', listing: 'exceptions', total: 60, truncated: true, items: Array.from({length: 20}, (_, i) =>
      ({entity: {table: 'orders', id: `ord_${i}`, field: 'customer'}, expected: `customer-${i}`, observed: 'someone-else'}))}}]);
  const review = app.reviewView(), checks = app.checksTab();
  for (const view of [review, checks]) {
    assert.match(view, /KEYBOARD: expected 172, observed 174 \(\+2\)/);
    assert.match(view, /ord_0 · customer: expected customer-0, observed someone-else · 59 more/);
  }
  const details = app.checkContext('unaffected_orders_preserved');
  assert.match(details, /What the checker found/);
  assert.match(details, /Showing 20 of 60/);
  assert.match(details, /data-key="order:ord_0"/);
});

test('a recording without diagnostics keeps the derived view, and mismatched inputs get no links', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: [{sku: 'KEYBOARD', name: 'Keyboard'}]};
  app.state.run = diagnosedRun([{name: 'stock_matches_movement_ledger', passed: true, detail: 'Opening stock plus all recorded movements equals current stock.'}]);
  app.state.run.review.stock = [{sku: 'KEYBOARD', name: 'Keyboard', before: 162, after: 172}];
  assert.match(app.checkContext('stock_matches_movement_ledger'), /Derived from the rehearsal review/);

  app.state.source = 'recorded';
  app.state.recording = {incident_id: 'case-a', citations_enabled: false, review: {...diagnosedRun([ledger(0)]).review}};
  const view = app.checkContext('stock_matches_movement_ledger');
  assert.match(view, /What the checker computed/);
  assert.doesNotMatch(view, /data-key=/);
});
