// Dependency-free frontend state tests. No browser, server or model calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../recovery_room/web/app.js'), 'utf8');

function harness(handler, options = {}) {
  const nodes = new Map(), intervals = [], cleared = [];
  const element = () => ({addEventListener() {}, setAttribute() {}, removeAttribute() {},
    focus() {}, scrollIntoView() {}, textContent: '', innerHTML: '', value: '', hidden: false});
  const context = {
    document: {
      // options.static: the generated public copy of index.html, <html data-demo-mode="read-only">.
      documentElement: {dataset: options.static ? {demoMode: 'read-only'} : {}},
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    window: {addEventListener() {}, ...(options.reducedMotion ? {matchMedia: (q) => ({matches: q.includes('reduce')})} : {})},
    location: {hash: ''}, history: {replaceState() {}},
    // Local startup's own index request never settles here, so each test drives the state it needs.
    fetch: (url, opts) => !options.static && url === '/api/incidents' ? new Promise(() => {}) : handler(url, opts),
    setTimeout, clearTimeout, URL, renderCalls: 0,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: (id) => { cleared.push(id); }, intervals, cleared,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nrender = () => { globalThis.renderCalls++; };\nrenderPanel = () => {};\nglobalThis.subject = {gitSegments, attemptsTree, caseStrip, renderCases, setBranch, state, download, reviewView, exportStatus, recheckExport, act, changesView, checksTab, sqlView, modeInfo, repairFlow, stockVisual, transition, packageView, lineContext, evidenceWrites, reconstructionView, runsCompare, checkContext, checksTab, demoDefault, staticContract, demoStartCase, guardrailMoment, guardrailView, timelineItems, displayedSteps, evaluationData, evaluationView, renderActions, replayControls, startReplay, playReplay, pauseReplay, nextReplay, sqlView, paletteCommands, loadSql, copySql, api, statusOf, stepsView, recCitations, recordedConclusion, recordedChangesView, recordedChecksView, startup, timerOn: () => replayTimer !== null};', context);
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
  assert.match(rendered, /earlier test on a copy/);
});

test('a current review preserves observed counts and qualifies its earlier source check', () => {
  const app = harness();
  app.state.run = reviewRun('ready_for_review');
  const rendered = app.reviewView();
  assert.match(rendered, /80 → 60/);
  assert.match(rendered, /20 orders cancelled/); // not called repeats: this review lists no changes to show it
  assert.match(rendered, /10 of 10 intact/);
  assert.match(rendered, /Source unchanged during the test/);
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
  assert.equal(app.exportStatus(current).label, 'Tested on a copy · check files before export');
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
  assert.equal(app.exportStatus(current).label, 'Checking files…');
  await app.recheckExport(); // duplicate clicks cannot create another request
  assert.equal(requests.length, 1);
  delayed.resolve({ok: true, text: async () => '{}'});
  await pending;
  assert.equal(app.state.rechecking.size, 0);
  assert.equal(app.exportStatus(current).label, 'Files unchanged since testing');
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
  assert.equal(app.exportStatus(reviewed).label, 'Tested on a copy · check files before export');
});

test('a network failure during recheck cannot retain a previous green freshness label', async () => {
  const app = harness(async () => { throw new Error('Network unavailable'); });
  const current = reviewRun('ready_for_review');
  app.state.incident = {id: 'case-a'}; app.state.run = current;
  app.state.exportChecks.set(current.id, {ok: true, at: new Date(), artifact: 'report.json'});
  await app.recheckExport();
  assert.equal(app.state.rechecking.size, 0);
  assert.equal(app.state.exportChecks.has(current.id), false);
  assert.equal(app.exportStatus(current).label, 'Tested on a copy · check files before export');
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
  assert.equal(app.exportStatus(first).label, 'Checking files…');
  assert.equal(app.exportStatus(second).label, 'Checking files…');
  for (const d of pending.values()) d.resolve({ok: true, text: async () => '{}'});
  await Promise.all([a, b]);
  assert.equal(app.state.rechecking.size, 0);
  assert.equal(app.exportStatus(second).label, 'Files unchanged since testing');
});

test('a run blocked before rehearsal points to a new investigation, never to rehearsing', () => {
  const app = harness();
  app.state.run = {id: 'run-a', incident_id: 'case-a', status: 'blocked', review: null, downloads: [],
    summary: 'The source changed since investigation. Start a new investigation and rehearsal.'};
  for (const view of [app.changesView, app.checksTab, app.sqlView]) {
    const rendered = view();
    assert.match(rendered, /Test on a copy refused/);
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

// The five blocks before a summary row's "N of M" label, as letters: a amber, g green, r red, - empty.
const fiveMarks = (html, label) => {
  const m = html.match(new RegExp(`<span class="cmp-blocks" aria-hidden="true">((?:<i[^>]*></i>){5})</span>${label}`));
  return m && [...m[1].matchAll(/<i(?: class="(\w)")?><\/i>/g)].map(x => x[1] || '-').join('');
};

test('summary shares use observed counts in the compared runs\' five blocks, under the existing style policy', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  for (const [cancelled, preserved, marks] of [[20, 60, 'a----'], [40, 60, 'aa---'], [0, 60, '-----'], [1, 99, 'a----'], [99, 1, 'aaaa-'], [60, 0, 'aaaaa']]) {
    const rendered = app.repairFlow({...review, cancellations: cancelled, untargeted_preserved: preserved,
      before_active: cancelled + preserved, after_active: preserved});
    assert.equal(fiveMarks(rendered, `${cancelled} of ${cancelled + preserved} changed`), marks, `${cancelled}/${preserved}`);
    assert.doesNotMatch(rendered, /\bstyle=|data-count/);
  }
  // Later purchases: green for intact, red for any that were not.
  assert.equal(fiveMarks(app.repairFlow(review), '10 of 10 intact'), 'ggggg');
  assert.equal(fiveMarks(app.repairFlow({...review, checkout_preserved: 8}), '8 of 10 intact'), 'ggggr');
  assert.equal(fiveMarks(app.repairFlow({...review, checkout_preserved: 0}), '0 of 10 intact'), 'rrrrr');
});

test('missing or invalid counts never become an invented repair proportion', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  for (const [cancellations, untargeted_preserved] of [[null, 60], [20, undefined], [-1, 60], [0, 0], [NaN, 60]]) {
    assert.doesNotMatch(app.repairFlow({...review, cancellations, untargeted_preserved}), / of \d+ changed/);
  }
});

test('a recorded outcome cannot imply a currently exportable package', () => {
  const app = harness();
  const rendered = app.repairFlow(reviewRun('ready_for_review').review,
    {recorded: true, run: reviewRun('ready_for_review')});
  assert.match(rendered, /passed on the recorded copy/);
  assert.match(rendered, /Read-only recording · no downloads/);
  assert.doesNotMatch(rendered, /For human review|refused if files changed since testing/);
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
  assert.match(card, /Tested on a copy · check files before export/);
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
  assert.match(unavailable, /Checks failed on the copy/);
});

test('missing fingerprints are omitted rather than shown as placeholders', () => {
  const app = harness();
  const current = packageRun('ready_for_review');
  delete current.source_fingerprint;
  app.state.run = current;
  const card = app.packageView(current);
  assert.doesNotMatch(card, /File hashes from the investigation/);
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
  assert.match(linked, /The proposal would cancel 1 repeated write and keep the first write of each source event\. 2 other writes would stay untouched\. Nothing is cancelled until it is tested on a copy\./);
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

test('the real inbox timelines include forwarded receipts, recorded sequences and all reviewed cancellations', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/public-demo/demo-data.json'), 'utf8'));
  for (const [caseId, expectedWrites, expectedFirst] of [['inbox-evidence', 80, 20], ['inbox-ambiguous', 78, 19]]) {
    const app = harness();
    const files = Object.fromEntries(Object.entries(data.artifacts[caseId]).map(([name, f]) => [name, f.lines.map(l => l.text)]));
    evidenceState(app, files, {incident: caseId, orders: data.api_get[`/api/incidents/${caseId}`].orders});
    const model = app.evidenceWrites();
    assert.equal(model.error, undefined);
    assert.equal(model.writes.length, expectedWrites);
    assert.equal(model.writes.filter(w => w.attempt === 'import-first').length, expectedFirst);
    assert.equal(model.writes.filter(w => w.ref.startsWith('inbox_receipts.txt:')).length, expectedFirst);
    assert.equal(model.writes[0].commitLabel, caseId === 'inbox-ambiguous' ? 2 : 1);
    if (caseId === 'inbox-evidence') {
      app.state.source = 'recorded';
      app.state.recording = data.api_get[`/api/recordings/${data.defaults.recording_id}`];
      const pairs = app.state.recording.review.changes.map(c => ({order_id: c.before.id, duplicate_of: c.duplicate_of}));
      const view = app.reconstructionView(pairs, {recorded: true});
      assert.equal((view.match(/class="recon-tick repeat"/g) || []).length, 20);
      assert.equal((view.match(/class="recon-tick kept"/g) || []).length, 20);
      assert.match(view, /cancels 20 repeated writes/);
      assert.doesNotMatch(view, /cancels 0 repeated writes/);
    }
  }
});

test('inbox narrative never draws a commit or authorizes a cancellation', () => {
  const app = harness();
  const receipt = {...write('import-first', 'ord_a', {commit_seq: 1}), movement_id: 'mv-a'};
  evidenceState(app, {'events.jsonl': [{type: 'receipt_inbox', name: 'inbox_receipts.txt', count: 1, format: 'embedded-commit-v1'}, write('import-retry', 'ord_b', {commit_seq: 2})],
    'inbox_receipts.txt': ['Customer says these purchases repeat.', JSON.stringify(write('import-first', 'invented-order')), '[RR-COMMIT v1] ' + JSON.stringify(receipt)]});
  const model = app.evidenceWrites();
  assert.deepEqual(Array.from(model.writes, w => w.order_id), ['ord_a', 'ord_b']);
  assert.equal(model.writes[0].ref, 'inbox_receipts.txt:L3');
  assert.doesNotMatch(app.reconstructionView(), /class="recon-tick repeat"/);
});

test('missing, undeclared or malformed inbox receipts withhold the partial timeline', () => {
  for (const variant of ['missing', 'undeclared', 'count', 'marker']) {
    const app = harness();
    const declaration = {type: 'receipt_inbox', name: 'inbox_receipts.txt', count: variant === 'count' ? 2 : 1, format: 'embedded-commit-v1'};
    const receipt = {...write('import-first', 'ord_a', {commit_seq: 1}), movement_id: 'mv-a'};
    const files = {'events.jsonl': [...(variant === 'undeclared' ? [] : [declaration]), write('import-retry', 'ord_b', {commit_seq: 2})]};
    if (variant !== 'missing') files['inbox_receipts.txt'] = [(variant === 'marker' ? '[RR-COMMIT v2] ' : '[RR-COMMIT v1] ') + JSON.stringify(receipt)];
    evidenceState(app, files);
    const view = app.reconstructionView([{order_id: 'ord_b', duplicate_of: 'ord_a'}]);
    assert.match(view, /no partial timeline is shown/, variant);
    assert.doesNotMatch(view, /class="recon-tick/, variant);
  }
});

test('the real stopped inbox recording keeps its failed checks visible without claiming no test occurred', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/public-demo/demo-data.json'), 'utf8'));
  const app = harness(), caseId = 'inbox-ambiguous';
  app.state.incident = data.api_get[`/api/incidents/${caseId}`];
  app.state.source = 'recorded';
  const id = data.api_get[`/api/incidents/${caseId}/recordings`][0].id;
  const r = app.state.recording = data.api_get[`/api/recordings/${id}`];
  const conclusion = app.recordedConclusion(r, r.steps.filter(s => s.kind === 'tool_result' && s.error));
  assert.match(conclusion, /No repair was selected for review/);
  assert.match(conclusion, /last test on a copy did not pass: 8 of 10 checks passed/);
  assert.doesNotMatch(conclusion, /nothing was rehearsed|without proposing|source_fingerprint|rehearsal_id/);
  assert.match(app.recordedChangesView(), /saved results are in Checks/);
  const checks = app.recordedChecksView();
  assert.match(checks, /2 of 10 checks failed on the recorded copy/);
  // The two failures lead the list, marked failed; saved results outside a review are not selectable.
  const rows = checks.match(/<li class="[^"]*">.*?<\/li>/g) || [];
  assert.equal(rows.length, 10);
  assert.match(rows[0], /class=" fail".*Source evidence complete.*failed/);
  assert.match(rows[1], /class=" fail".*Source events applied once.*failed/);
  assert.ok(rows.slice(2).every(row => /✓/.test(row) && !/fail/.test(row)));
  assert.doesNotMatch(checks, /data-key="check:/);
  assert.match(checks, /Not available for recordings/);
  assert.doesNotMatch(checks, /No checks in this recording|data-download|data-recheck-export/);
  assert.equal(app.guardrailView(r), '');
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
  assert.match(view, /Script baseline<\/strong><span class="cmp-long">cancels 2</);
  assert.match(view, /Meta run 4<\/strong><span class="cmp-long">same 2 as the script</);
  assert.match(view, /Meta run 3<\/strong><span class="cmp-long">1 of 2 match · misses 1 · 1 not in the script</);
  assert.match(view, /Meta run 2<\/strong><span class="cmp-long">stopped · no repair</);
  assert.match(view, /Meta run 1<\/strong><span class="cmp-long">inputs differ · not compared</);
  assert.equal((view.match(/class="cmp-plus"/g) || []).length, 1); // ord_b, which the script keeps
  assert.equal((view.match(/class="cmp-minus"/g) || []).length, 1); // ord_d, which the differing run keeps
  assert.match(view, /<li class="cmp-plus"><span aria-hidden="true">\+<\/span><span class="mono">#2<\/span><span class="mono">ord_b<\/span><span>Meta run 3 cancels it; the script keeps it<\/span><\/li>/);
  assert.match(view, /<li class="cmp-minus"><span aria-hidden="true">−<\/span><span class="mono">#4<\/span><span class="mono">ord_d<\/span><span>the script cancels it; Meta run 3 keeps it<\/span><\/li>/);
  assert.match(view, /<details class="cmp-diff"><summary>2 differences<\/summary>/);
  assert.match(view, /class="cmp-row same"><button[^>]*>.*?<span class="cmp-blocks" aria-hidden="true">(<i class="g"><\/i>){5}<\/span>2 of 2 match/);
  assert.match(view, /class="cmp-row differ"><button[^>]*>.*?(<i class="g"><\/i>){3}(<i class="a"><\/i>){2}<\/span>1 of 2 match/);
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
  // Nothing is compared, so there is no diffstat and no difference list.
  assert.doesNotMatch(view, /cmp-blocks|cmp-plus|cmp-minus/);
  assert.match(view, /The recorded Meta run was not compared\./);
});

test('without a script run the rows show each recording and invite an investigation', () => {
  const app = harness();
  const view = compareState(app, {engine: null, run: null,
    recs: [{id: 'rec-a', outcome: 'repair', fixture_matches: true}, {id: 'rec-b', outcome: 'repair', fixture_matches: true}],
    details: {'rec-a': recording('rec-a', ['ord_c', 'ord_d']), 'rec-b': recording('rec-b', ['ord_c', 'ord_d'])}});
  assert.match(view, /Script baseline<\/strong><span class="cmp-long">not investigated yet</);
  assert.doesNotMatch(view, /cmp-plus|cmp-minus|cmp-blocks/);
  assert.match(view, /All 2 recorded Meta runs cancel 2 writes each\. Investigate the incident to compare them with the script\./);
});

test('stops on both sides read as agreement, not as missing repairs', () => {
  const app = harness();
  const view = compareState(app, {engine: null, run: 'stopped', recs: [{id: 'rec-a', outcome: 'stop', fixture_matches: true}, {id: 'rec-b', outcome: 'stop', fixture_matches: true}]});
  assert.match(view, /Script baseline<\/strong><span class="cmp-long">stopped · 2 events unmatched</);
  assert.match(view, /All 2 recorded Meta runs stopped instead of repairing, as the script did\./);
  assert.equal((view.match(/class="cmp-row [^"]*\bstop\b/g) || []).length, 3);
  app.state.run.missing_event_ids = ['evt-1']; // one unmatched event is singular
  assert.match(app.runsCompare(app.evidenceWrites()), /Script baseline<\/strong><span class="cmp-long">stopped · 1 event unmatched</);
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
  assert.match(view, /Script baseline<\/strong><span class="cmp-long">targets 2</);
  assert.match(view, /Script baseline<\/strong><span class="cmp-long">targets 2<\/span><span class="cmp-sub">not tested on a copy yet<\/span>/);
  assert.match(view, /The recorded Meta run cancels the same 2 writes the script targets\./);
  assert.match(view, /the script shows its proposal/);
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
  assert.match(view, /1 listed product breaks the rule\. The repair added 2 compensating movements\./);
  assert.match(view, /data-key="product:KEYBOARD">Keyboard</);
  assert.doesNotMatch(view, /Derived from the test’s before and after records/);
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
  assert.match(app.checkContext('stock_matches_movement_ledger'), /Derived from the test’s before and after records/);

  app.state.source = 'recorded';
  app.state.recording = {incident_id: 'case-a', citations_enabled: false, review: {...diagnosedRun([ledger(0)]).review}};
  const view = app.checkContext('stock_matches_movement_ledger');
  assert.match(view, /What the checker computed/);
  assert.doesNotMatch(view, /data-key=/);
});

test('a partial stock list never claims every product matches, and names where the failure is', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: []};
  const items = Array.from({length: 20}, (_, i) => ({entity: {table: 'products', sku: `SKU_${String(i).padStart(2, '0')}`},
    parts: {opening: 10, movements: 0}, expected: 10, observed: 10, difference: 0}));
  const failed = {name: 'stock_matches_movement_ledger', passed: false, detail: 'Opening stock plus all recorded movements equals current stock.',
    diagnostics: {rule: 'r', listing: 'all', items, total: 21, truncated: true}};
  app.state.run = diagnosedRun([failed]);
  const view = app.checkContext('stock_matches_movement_ledger');
  assert.doesNotMatch(view, /Every product matches/);
  assert.match(view, /The 20 listed products match the rule, so the failure is among the 1 not listed\./);
  assert.match(app.checksTab(), /Not among the 20 listed; 1 more was not listed/);

  const passed = {...failed, passed: true};
  app.state.run = diagnosedRun([passed]);
  assert.match(app.checkContext('stock_matches_movement_ledger'), /The 20 listed products match the rule; 1 more was not listed\./);
});

test('a product whose expected stock is unavailable counts as breaking the rule', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: []};
  app.state.run = diagnosedRun([{name: 'stock_matches_active_orders', passed: false, detail: 'd', diagnostics: {rule: 'r', listing: 'all', total: 2, truncated: false, items: [
    {entity: {table: 'products', sku: 'ZZZ_EXTRA'}, parts: {opening: null, active_quantity: 0}, expected: 'unavailable: no opening stock for this product', observed: 3},
    {entity: {table: 'products', sku: 'MOUSE'}, parts: {opening: 5, active_quantity: 0}, expected: 5, observed: 5, difference: 0}]}}]);
  assert.match(app.checkContext('stock_matches_active_orders'), /1 listed product breaks the rule\./);
  assert.match(app.checksTab(), /ZZZ_EXTRA: expected unavailable: no opening stock for this product, observed 3/);
});

test('shortened related ID lists say so', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: []};
  const ids = Array.from({length: 20}, (_, i) => `ord_${i}`);
  app.state.run = diagnosedRun([{name: 'source_events_applied_once', passed: false, detail: 'd', diagnostics: {rule: 'r', listing: 'exceptions', total: 1, truncated: false,
    items: [{entity: {event_id: 'evt-1'}, expected: 1, observed: 25, related: {active_order_ids: ids}, related_truncated: true}]}}]);
  assert.match(app.checkContext('source_events_applied_once'), /Lists shortened to their first 20 IDs/);
});

// ---------- Meta first: default run, replay, guardrail moment, evaluation ----------

const steps = {
  call: (id, name, args = {}) => ({kind: 'tool_call', call_id: id, name, arguments: args, has_result: true}),
  ok: (id, result = {}) => ({kind: 'tool_result', call_id: id, result, error: false}),
  bad: (id, message) => ({kind: 'tool_result', call_id: id, result: {error: message}, error: true}),
  say: (words) => ({kind: 'assistant', text: words}),
};
const checksResult = {passed: true, checks: Array.from({length: 10}, (_, i) => ({name: `check_${i}`, passed: true}))};
function recordedRun(list, extra = {}) {
  return {id: 'rec-a', incident_id: 'case-a', outcome: 'repair', fixture_matches: true, citations_enabled: true, steps: list,
    provenance: {model: 'muse-spark-1.3'}, review: null, ...extra};
}

test('a case opens on its newest recorded Meta run with matching inputs, and a dataset default only if it is usable', () => {
  const app = harness();
  app.state.cases = [{id: 'case-a'}, {id: 'case-b'}];
  app.state.recordings.set('case-a', {status: 'ok', list: [
    {id: 'rec-new-other', fixture_matches: false}, {id: 'rec-mid', fixture_matches: true}, {id: 'rec-old', fixture_matches: true}]});
  assert.equal(app.demoDefault('case-a').id, 'rec-mid');
  assert.equal(app.demoStartCase(), null);
  const pick = (recording_id, incident_id = 'case-a', source = 'recorded') => { app.state.demo = app.staticContract({defaults: {incident_id, source, recording_id}}); };
  pick('rec-old');
  assert.equal(app.demoDefault('case-a').id, 'rec-old');
  assert.equal(app.demoStartCase(), 'case-a');
  pick('rec-new-other'); // inputs differ: neither the recording nor its case is forced
  assert.equal(app.demoDefault('case-a').id, 'rec-mid');
  assert.equal(app.demoStartCase(), null);
  pick('rec-unknown');
  assert.equal(app.demoDefault('case-a').id, 'rec-mid');
  assert.equal(app.demoStartCase(), null);
  pick('rec-old', 'case-missing');
  assert.equal(app.demoStartCase(), null);
  pick('rec-old', 'case-a', 'script'); // only a recorded default is understood
  assert.equal(app.state.demo.defaults, null);
  assert.equal(app.demoDefault('case-none'), null);
  assert.equal(app.staticContract('nonsense').defaults, null);
  app.state.recordings.set('case-b', {status: 'ok', list: [{id: 'rec-b'}]}); // an unknown match is not a match
  assert.equal(app.demoDefault('case-b'), null);
});

test('the guardrail moment is the recorded rejection, the verbatim message and the accepted retry', () => {
  const app = harness();
  const r = recordedRun([steps.call('c1', 'read_artifact'), steps.ok('c1'),
    steps.call('c2', 'rehearse_repair', {plan: {}}), steps.bad('c2', 'An order cannot duplicate itself.'),
    steps.say('That draft was invalid; fixing the linkage.'),
    steps.call('c3', 'rehearse_repair', {plan: {}}), steps.bad('c3', 'Evidence reference is not a committed-write record: source_orders.json:L15'),
    steps.call('c4', 'query_database'), steps.ok('c4'),
    steps.call('c5', 'rehearse_repair', {plan: {}}), steps.ok('c5', checksResult)]);
  const m = app.guardrailMoment(r);
  assert.equal(m.bad.n, 2);
  assert.equal(m.fixed.n, 6);
  assert.equal(m.between.length, 2);
  assert.equal(m.others, 1);
  const view = app.guardrailView(r);
  assert.match(view, /Step 2<\/span><div><strong>Proposed repair rejected by the local runtime<\/strong><blockquote class="g-quote">An order cannot duplicate itself\.<\/blockquote>/);
  assert.match(view, /The model’s next message, verbatim<\/strong><p class="g-text">That draft was invalid; fixing the linkage\.<\/p>/);
  assert.match(view, /Rejected again<\/strong><blockquote class="g-quote">Evidence reference is not a committed-write record: source_orders\.json:L15/);
  assert.match(view, /Next proposed repair accepted<\/strong><p class="g-text">Tested on a copy: 10 of 10 checks passed\.<\/p>/);
  assert.match(view, /data-replay-from="2"/);
  assert.match(view, /with 1 other step in between/);
});

test('no correction means no guardrail card, and nothing is invented', () => {
  const app = harness();
  const unresolved = recordedRun([steps.call('c1', 'rehearse_repair'), steps.bad('c1', 'Rejected.'), steps.say('Stopping.')]);
  assert.equal(app.guardrailMoment(unresolved), null);
  assert.equal(app.guardrailView(unresolved), '');
  assert.equal(app.guardrailView(recordedRun([steps.call('c1', 'read_artifact'), steps.ok('c1')])), '');
});

test('a replay reveals saved steps up to its cursor in recorded order, ignoring filters', () => {
  const app = harness();
  const r = recordedRun([steps.call('c1', 'read_artifact'), steps.ok('c1'), steps.say('Reading.'), steps.call('c2', 'rehearse_repair'), steps.bad('c2', 'No.')]);
  assert.equal(app.displayedSteps(r).length, 3);
  app.state.stepFilter = 'messages';
  app.state.replay = {recId: 'rec-a', cursor: 2, playing: false};
  const listed = app.timelineItems(r);
  assert.equal((listed.match(/<li data-seq=/g) || []).length, 3);
  assert.match(listed, /<li data-seq="1" class=/);
  assert.match(listed, /<li data-seq="2" aria-current="step" class=/);
  assert.match(listed, /<li data-seq="3" hidden class=/);
  app.state.replay = {recId: 'another', cursor: 1, playing: false}; // a replay of another recording does not apply
  assert.equal((app.timelineItems(r).match(/<li data-seq=/g) || []).length, 1);
});

test('How we evaluated counts every recorded outcome, keeps failures and states the limitation', () => {
  const app = harness();
  app.state.cases = [{id: 'case-a', title: 'Case A'}, {id: 'case-b', title: 'Case B'}];
  app.state.recordings.set('case-a', {status: 'ok', list: [{id: 'r2', outcome: 'repair', fixture_matches: true, model: 'muse-spark-1.3'}, {id: 'r1', outcome: 'error', fixture_matches: true, model: 'muse-spark-1.3'}]});
  app.state.recordings.set('case-b', {status: 'ok', list: [{id: 'r4', outcome: 'stop', fixture_matches: true}, {id: 'r3', outcome: 'incomplete', fixture_matches: false}]});
  const e = app.evaluationData();
  assert.deepEqual([e.total, e.repairs, e.stops, e.errors, e.incomplete, e.mismatched], [4, 1, 1, 1, 1, 1]);
  const view = app.evaluationView();
  assert.match(view, /<strong>4<\/strong> recorded runs on 2 cases/);
  assert.match(view, /Run 1 · Error/);
  assert.match(view, /Run 1 · Did not finish · inputs differ/);
  assert.match(view, /The offline script solves the supported cases: it proposes a repair where the evidence allows one/);
  assert.match(view, /saved observations on authored development cases, not a success rate/);
  assert.doesNotMatch(view, /all four|New format|frozen parser/);
  assert.match(view, /Failed runs stay in the count and in the list/);
  assert.match(view, /1 recording was made on inputs that differ/);
  assert.match(view, /Not run in this session/);
});

test('a recording offers its replay and the script baseline, never a test, SQL or download', () => {
  const app = harness();
  app.state.incident = {id: 'case-a'};
  app.state.source = 'recorded';
  app.state.recording = recordedRun([steps.say('Hello.')]);
  app.state.run = {id: 'run-a', incident_id: 'case-a', status: 'ready_for_review', downloads: ['repair.sql']};
  app.renderActions();
  const html = app.nodes.get('#header-actions').innerHTML;
  assert.match(html, /data-replay-start/);
  assert.match(html, /Replay recorded steps/);
  assert.match(html, /data-source="script"/);
  assert.doesNotMatch(html, /data-download|data-action|data-recheck/);
});

// ---------- Codex review 3: replay completion, passing corrections, the public read-only demo ----------

const tick = () => new Promise(done => setTimeout(done, 0));
const plain = (v) => JSON.parse(JSON.stringify(v));
const failing = (passedCount = 8) => ({passed: false, checks: Array.from({length: 10}, (_, i) => ({name: `check_${i}`, passed: i < passedCount}))});

function replayApp(list, options) {
  const app = harness(() => {}, options);
  Object.assign(app.state, {source: 'recorded', tab: 'investigation', incident: {id: 'case-a'}, recording: recordedRun(list)});
  return app;
}
const replayState = (app) => app.state.replay && plain(app.state.replay);

test('a one-step replay completes at once, without a timer or recursion, and Play again and Restart repeat it', () => {
  const app = replayApp([steps.say('The only saved step.')]);
  app.startReplay(1, true);
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 1, playing: false});
  assert.equal(app.context.intervals.length, 0);
  assert.equal(app.timerOn(), false);
  const controls = app.replayControls(app.state.recording);
  assert.match(controls, /Play again/);
  assert.match(controls, /data-replay="next" disabled/);
  assert.match(controls, /Step 1 of 1/);
  app.playReplay(); // Play again
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 1, playing: false});
  app.startReplay(1, true); // Restart
  app.nextReplay();
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 1, playing: false});
  assert.equal(app.context.intervals.length, 0);
});

test('a recording with no displayed steps offers no replay and starting one does nothing', () => {
  const app = replayApp([]);
  app.startReplay(1, true);
  app.playReplay();
  assert.equal(app.state.replay, null);
  assert.equal(app.context.intervals.length, 0);
  const controls = app.replayControls(app.state.recording);
  assert.match(controls, /No saved steps/);
  assert.doesNotMatch(controls, /data-replay=/);
  app.renderActions();
  assert.doesNotMatch(app.nodes.get('#header-actions').innerHTML, /data-replay-start/);
});

test('a multi-step replay advances one saved step per tick, ends, and plays again or restarts from step 1', () => {
  const app = replayApp([steps.say('One.'), steps.call('c1', 'read_artifact'), steps.ok('c1'), steps.say('Three.')]);
  app.startReplay(1, true);
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 1, playing: true});
  assert.equal(app.context.intervals.length, 1);
  app.context.intervals[0]();
  assert.equal(app.state.replay.cursor, 2);
  app.context.intervals[0]();
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 3, playing: false});
  assert.equal(app.timerOn(), false);
  assert.match(app.replayControls(app.state.recording), /Play again/);
  app.playReplay(); // Play again: from step 1, playing
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 1, playing: true});
  app.pauseReplay();
  app.nextReplay();
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 2, playing: false});
  app.playReplay(); // Play continues from the cursor
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 2, playing: true});
  app.startReplay(1, true); // Restart
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 1, playing: true});
  app.startReplay(9, false); // Replay from a step past the end stops at the last one
  assert.deepEqual(replayState(app), {recId: 'rec-a', cursor: 3, playing: false});
});

test('replay controls are labelled buttons, and the replay scrolls without animation under reduced motion', () => {
  for (const reduced of [true, false]) {
    const app = replayApp([steps.say('One.'), steps.say('Two.')], {reducedMotion: reduced});
    const behaviors = [];
    app.context.document.querySelector('#recorded-steps').scrollIntoView = (o) => behaviors.push(o.behavior);
    app.startReplay(1, false);
    assert.deepEqual(behaviors, [reduced ? 'auto' : 'smooth']);
    const controls = app.replayControls(app.state.recording);
    assert.match(controls, /role="group" aria-label="Replay of the saved steps"/);
    assert.match(controls, /<button class="secondary" data-replay="toggle" aria-pressed="false">.*<span>Play<\/span><\/button>/);
    assert.match(controls, /<button class="secondary" data-replay="restart" >/);
    assert.match(controls, /Not live: nothing runs again/);
  }
});

test('a failed-check test on a copy is never the correction: the later passing test is, after it as a failed attempt', () => {
  const app = harness();
  const r = recordedRun([steps.call('c1', 'rehearse_repair'), steps.bad('c1', 'An order cannot duplicate itself.'),
    steps.say('Fixing the linkage.'),
    steps.call('c2', 'rehearse_repair'), steps.ok('c2', failing(8)),
    steps.say('Two checks failed; retrying.'),
    steps.call('c3', 'rehearse_repair'), steps.ok('c3', checksResult)]);
  const m = app.guardrailMoment(r);
  assert.equal(m.bad.n, 1);
  assert.equal(m.fixed.n, 5);
  assert.deepEqual(Array.from(m.between, i => i.n), [2, 3, 4]);
  const view = app.guardrailView(r);
  assert.match(view, /Proposed repair rejected by the local runtime<\/strong><blockquote class="g-quote">An order cannot duplicate itself\./);
  assert.match(view, /Step 3<\/span><div><strong>Checks failed again<\/strong><p class="g-text">Tested on a copy: 8 of 10 checks passed, so the test did not pass\.<\/p>/);
  assert.match(view, /Step 5<\/span><div><strong>Next proposed repair accepted<\/strong><p class="g-text">Tested on a copy: 10 of 10 checks passed\.<\/p>/);
  // A failed-check result can itself be the first failure, even when its error flag is false.
  const first = recordedRun([steps.call('c1', 'rehearse_repair'), steps.ok('c1', failing(9)), steps.call('c2', 'rehearse_repair'), steps.ok('c2', checksResult)]);
  assert.match(app.guardrailView(first), /Step 1<\/span><div><strong>Proposed repair failed its checks on a copy<\/strong><p class="g-text">Tested on a copy: 9 of 10 checks passed/);
  // A real recording's shape: an error-flagged rehearsal that lists checks reads as its check count.
  const flagged = recordedRun([steps.call('c1', 'rehearse_repair'), {kind: 'tool_result', call_id: 'c1', result: failing(8), error: true},
    steps.call('c2', 'rehearse_repair'), steps.ok('c2', checksResult)]);
  assert.match(app.guardrailView(flagged), /rejected by the local runtime<\/strong><p class="g-text">Tested on a copy: 8 of 10 checks passed/);
});

test('without a passing test on a copy there is no success card, whatever the error flags say', () => {
  const app = harness();
  const never = recordedRun([steps.call('c1', 'rehearse_repair'), steps.bad('c1', 'Rejected.'),
    steps.call('c2', 'rehearse_repair'), steps.ok('c2', failing(8)),
    steps.call('c3', 'rehearse_repair'), steps.ok('c3', {passed: true, checks: []}),
    steps.call('c4', 'rehearse_repair'), steps.ok('c4', {passed: true, checks: [{name: 'a', passed: true}, {name: 'b', passed: false}]}),
    steps.call('c5', 'rehearse_repair'), steps.ok('c5', {checks: checksResult.checks}),
    steps.call('c6', 'rehearse_repair'), steps.ok('c6', null)]);
  assert.equal(app.guardrailMoment(never), null);
  assert.equal(app.guardrailView(never), '');
  assert.equal(app.guardrailMoment(recordedRun([steps.call('c1', 'rehearse_repair'), steps.ok('c1', failing(8))])), null);
  // Reads and queries keep the error flag: a rejected read and its accepted retry are a moment.
  const read = recordedRun([steps.call('c1', 'read_artifact'), steps.bad('c1', 'Unknown artifact.'), steps.call('c2', 'read_artifact'), steps.ok('c2', {lines: []})]);
  assert.match(app.guardrailView(read), /File read rejected by the local runtime.*Next file read accepted<\/strong><p class="g-text">Accepted by the local runtime/);
});

// ---------- the public read-only demo (RR_STATIC_DEMO_V1) ----------

const CAPS_OFF = {investigate: false, rehearse: false, export: false, live_model: false};
const OFFLINE = 'offline_deterministic_engine_demo_NOT_a_model_run';
function demoData(extra = {}) {
  const listed = (id, incident, outcome, matches) => ({id, model: 'muse-spark-1.3', mode: 'live_meta_agent', recorded_at: '2026-10-31T19:54:54.905197Z',
    outcome, summary: 'Saved summary.', tool_calls: 2, elapsed_seconds: 1.5, fixture_matches: matches});
  const detail = (item, incident, list) => ({...item, incident_id: incident, citations_enabled: item.fixture_matches, steps: list, review: null,
    provenance: {model: item.model, mode: item.mode, recorded_at: item.recorded_at, label: 'Recorded model run, not live'}});
  const review = {passed: true, checks: checksResult.checks.map(c => ({...c, detail: 'ok'})), changes: [], preserved_orders: [], stock: [], cancellations: 0, before_active: 5, after_active: 5};
  const baseline = (id, incident, status) => ({id, incident_id: incident, status, mode: OFFLINE, created_at: '2026-10-31T19:58:46.322584+00:00',
    summary: 'Recorded.', plan: status === 'ready_for_review' ? {cancellations: []} : null, review: status === 'ready_for_review' ? review : null,
    trace: [], downloads: [], read_only: true, review_observation: 'Recorded offline baseline; exports are disabled in the public demo.'});
  const incident = (id, title) => ({id, title, scenario: id, mode: OFFLINE, artifacts: [{name: 'events.jsonl', bytes: 3}], orders: [], products: [], schema: [], note: {}, active_orders: 0});
  const a1 = listed('rec-a1', 'case-a', 'stop', true), b1 = listed('rec-b1', 'case-b', 'repair', true), b2 = listed('rec-b2', 'case-b', 'repair', false);
  return {
    schema_version: 1, read_only: true, label: 'Recorded demo · No live API calls', capabilities: {...CAPS_OFF},
    defaults: {incident_id: 'case-b', source: 'recorded', recording_id: 'rec-b1'},
    api_get: {
      '/api/incidents': {mode: 'recorded_read_only_demo', incidents: [{id: 'case-a', title: 'Case A', synthetic: true}, {id: 'case-b', title: 'Case B', synthetic: true}]},
      '/api/incidents/case-a': incident('case-a', 'Case A'), '/api/incidents/case-b': incident('case-b', 'Case B'),
      '/api/incidents/case-a/recordings': [a1], '/api/incidents/case-b/recordings': [b2, b1],
      '/api/recordings/rec-a1': detail(a1, 'case-a', [steps.say('Stopping: evidence is missing.')]),
      '/api/recordings/rec-b1': detail(b1, 'case-b', [steps.call('c1', 'rehearse_repair'), steps.bad('c1', 'Rejected.'), steps.call('c2', 'rehearse_repair'), steps.ok('c2', checksResult)]),
      '/api/recordings/rec-b2': detail(b2, 'case-b', [steps.say('Other seed.')]),
      '/api/runs?incident=case-a': {runs: [baseline('run-a', 'case-a', 'stopped')]}, '/api/runs?incident=case-b': {runs: [baseline('run-b', 'case-b', 'ready_for_review')]},
      '/api/runs/run-a': baseline('run-a', 'case-a', 'stopped'), '/api/runs/run-b': baseline('run-b', 'case-b', 'ready_for_review'),
    },
    artifacts: {
      'case-a': {'events.jsonl': {name: 'events.jsonl', total_lines: 3, lines: ['a', 'b', 'c'].map((t, i) => ({ref: `events.jsonl:L${i + 1}`, text: t}))}},
      'case-b': {'events.jsonl': {name: 'events.jsonl', total_lines: 5, lines: [{ref: 'events.jsonl:L1', text: 'short'}]}},
    },
    evaluation: {scope: 'Public synthetic cases.', recording_count: 3, outcomes: {repair: 2, stop: 1}, interpretation: 'Observed outcomes, not a general success rate.',
      story: {scope: 'Authored experiments, not blind holdouts.', configuration: {model: 'muse-spark-1.3'}, planned_attempts: 3, unattempted: [],
        judgments: {correct_repair: 2, justified_stop: 1}, usage: {total_tokens: 805943},
        attempts: [
          {id: 'b-101', incident_id: 'case-b', seed: 101, outcome: 'repair', judgment: 'correct_repair', frozen_parser: 'unsupported_format', adapted_parser: 'correct_repair'},
          {id: 'b-103', incident_id: 'case-b', seed: 103, outcome: 'repair', judgment: 'correct_repair', frozen_parser: 'unsupported_format', adapted_parser: 'correct_repair'},
          {id: 'a-107', incident_id: 'case-a', seed: 107, outcome: 'stop', judgment: 'justified_stop', frozen_parser: 'unsupported_format', adapted_parser: 'justified_stop'}]}},
    ...extra,
  };
}
async function publicDemo(data = demoData()) {
  const fetches = [];
  const app = harness(async url => { fetches.push(url); return url === './demo-data.json' ? json(true, data) : json(false, {error: 'live API'}); }, {static: true});
  await app.startup; await tick(); await tick();
  return {app, fetches};
}

test('local startup is unchanged: no dataset is read and no demo label is shown', async () => {
  const fetches = [];
  const app = harness(async url => { fetches.push(url); return json(true, {}); });
  await tick();
  assert.deepEqual(fetches, []);
  assert.equal(app.nodes.has('#demo-label'), false);
  assert.equal(app.state.demo, null);
});

test('the public demo reads demo-data.json once and opens on its default case and matched recording, with no API request', async () => {
  const {app, fetches} = await publicDemo();
  assert.deepEqual(fetches, ['./demo-data.json']);
  assert.equal(app.state.cases.length, 2);
  assert.equal(app.state.incident.id, 'case-b');
  assert.equal(app.state.source, 'recorded');
  assert.equal(app.state.recId, 'rec-b1');
  assert.equal(app.state.recording.id, 'rec-b1');
  assert.equal(app.nodes.get('#demo-label').hidden, false);
  assert.equal(app.nodes.get('.side-footer-text').textContent, 'Recorded demo · No live API calls');
  assert.equal(app.nodes.get('#notice').hidden, true);
});

test('the public demo keeps a mismatched recording listed, warned and without current-case links', async () => {
  const {app} = await publicDemo();
  const listed = plain(app.state.recordings.get('case-b').list).map(r => [r.id, r.fixture_matches]);
  assert.deepEqual(listed, [['rec-b2', false], ['rec-b1', true]]);
  const other = await app.api('/api/recordings/rec-b2'), matched = await app.api('/api/recordings/rec-b1');
  assert.equal(app.recCitations(other), false);
  assert.equal(app.recCitations(matched), true);
  assert.match(app.evaluationView(), /Run 2 · Repair, checks passed · inputs differ/);
  // A default whose recording does not match is ignored: the first case opens on its own newest matching run.
  const {app: second} = await publicDemo(demoData({defaults: {incident_id: 'case-b', source: 'recorded', recording_id: 'rec-b2'}}));
  assert.equal(second.state.incident.id, 'case-a');
  assert.equal(second.state.recording.id, 'rec-a1');
});

for (const [why, respond, pattern] of [
  ['missing', async () => ({ok: false, status: 404, json: async () => ({})}), /The recorded demo data is missing \(HTTP 404\)/],
  ['unreachable', async () => { throw new TypeError('offline'); }, /could not be read/],
  ['not JSON', async () => ({ok: true, json: async () => { throw new SyntaxError('bad'); }}), /not valid JSON/],
  ['not an object', async () => json(true, [1, 2]), /not a JSON object/],
  ['another schema version', async () => json(true, demoData({schema_version: 2})), /only schema version 1/],
  ['not read-only', async () => json(true, demoData({read_only: false})), /not marked read-only/],
  ['granting a capability', async () => json(true, demoData({capabilities: {...CAPS_OFF, rehearse: true}})), /must turn off/],
  ['granting an unknown capability', async () => json(true, demoData({capabilities: {...CAPS_OFF, upload: true}})), /must turn off/],
  ['missing a capability', async () => json(true, demoData({capabilities: {investigate: false, rehearse: false, export: false}})), /must turn off/],
  ['without responses', async () => json(true, demoData({api_get: {}})), /recorded responses are missing/],
  ['without evidence', async () => json(true, demoData({artifacts: null})), /recorded responses are missing/],
]) {
  test(`the public demo refuses a dataset that is ${why}, once, with no other request`, async () => {
    const fetches = [];
    const app = harness(async url => { fetches.push(url); return respond(); }, {static: true});
    await app.startup;
    assert.deepEqual(fetches, ['./demo-data.json']);
    assert.match(app.nodes.get('#notice').innerHTML, pattern);
    assert.equal(app.nodes.get('#title').textContent, 'Recorded demo unavailable');
    assert.match(app.nodes.get('#content').innerHTML, /made no API call and has no live fallback/);
    assert.equal(app.state.cases.length, 0);
    await assert.rejects(app.api('/api/incidents'), pattern); // the refusal is kept, never refetched
    assert.deepEqual(fetches, ['./demo-data.json']);
  });
}

test('the public demo answers exact recorded GETs and bounded evidence pages, and fails everything else', async () => {
  const {app, fetches} = await publicDemo();
  const copy = await app.api('/api/runs?incident=case-a');
  copy.runs[0].status = 'changed'; // a copy: the page cannot change the dataset
  assert.equal((await app.api('/api/runs?incident=case-a')).runs[0].status, 'stopped');
  const status = (code) => (error) => error.status === code;
  for (const path of ['/api/runs?incident=case-z', '/api/runs?incident=case-a&x=1', '/api/runs/run-b/artifacts/repair.sql', '/api/incidents/__proto__',
    '/api/incidents/case-a/', '/api/recordings/rec-zz', '/api/incidents/case-a/artifacts/events.jsonl'])
    await assert.rejects(app.api(path), status(404), path);
  await assert.rejects(app.api('/api/incidents/case-a/investigate', true), (e) => e.status === 405 && /read-only/.test(e.message));
  await assert.rejects(app.api('/api/runs/run-b/rehearse', true), status(405));
  const page = (q, file = 'events.jsonl', c = 'case-a') => app.api(`/api/incidents/${c}/artifacts/${file}?${q}`);
  assert.deepEqual(plain(await page('start_line=1&max_lines=2')),
    {name: 'events.jsonl', total_lines: 3, lines: [{ref: 'events.jsonl:L1', text: 'a'}, {ref: 'events.jsonl:L2', text: 'b'}], next_line: 3});
  assert.deepEqual(plain(await page('start_line=3&max_lines=200')), {name: 'events.jsonl', total_lines: 3, lines: [{ref: 'events.jsonl:L3', text: 'c'}], next_line: null});
  assert.deepEqual(plain(await page('start_line=9&max_lines=5')).lines, []); // past the end: an empty last page, as locally
  for (const bad of ['', 'start_line=0&max_lines=5', 'start_line=1&max_lines=201', 'start_line=1&max_lines=0', 'start_line=1&start_line=2',
    'start_line=1&max_lines=5&x=1', 'start_line=-1', 'start_line=1.5', 'start_line=1&max_lines=', 'start_line=1&max_lines=5=6'])
    await assert.rejects(page(bad), status(400), bad);
  await assert.rejects(page('start_line=1&max_lines=5', 'repair.sql'), status(404));
  await assert.rejects(page('start_line=1&max_lines=5', 'events.jsonl', 'case-z'), status(404));
  await assert.rejects(page('start_line=1&max_lines=5', '%E0%A4%A'), status(404));
  await assert.rejects(page('start_line=1&max_lines=5', 'events.jsonl', 'case-b'), status(404)); // stored lines incomplete
  assert.deepEqual(fetches, ['./demo-data.json']);
});

test('the public demo blocks every test, file check, SQL, copy and download path, including direct helper calls', async () => {
  const {app, fetches} = await publicDemo();
  app.state.source = 'script';
  const run = app.state.run;
  assert.equal(run.id, 'run-b');
  assert.equal(run.status, 'ready_for_review');
  for (const call of [() => app.act('investigate'), () => app.act('rehearse'), () => app.download('repair.sql'), () => app.recheckExport(),
    () => app.loadSql(), () => app.copySql(null)]) {
    app.nodes.get('#notice').innerHTML = '';
    await call();
    assert.match(app.nodes.get('#notice').innerHTML, /read-only: it cannot investigate, test on a copy, check files, copy SQL or export/);
  }
  assert.deepEqual(fetches, ['./demo-data.json']);
  assert.equal(app.state.busy, false);
  assert.equal(app.state.sql.size, 0);
  assert.equal(app.state.exportChecks.size, 0);
  app.renderActions();
  const head = app.nodes.get('#header-actions').innerHTML;
  assert.doesNotMatch(head, /data-action|data-download|data-recheck/);
  assert.match(head, /data-review-repair/);
  assert.match(head, /data-source="recorded"/);
  const labels = app.paletteCommands('').map(i => i.label);
  assert.ok(!labels.some(l => /investigation|Test repair|Check files|Download/.test(l)), labels.join(' | '));
  assert.ok(labels.includes('Copy run ID'));
  assert.match(app.sqlView(), /No SQL in this demo/);
  assert.doesNotMatch(app.sqlView(), /data-copy-sql|data-reload-sql/);
  assert.doesNotMatch(app.checksTab(), /data-recheck-export/);
  assert.match(app.checksTab(), /Recorded when this baseline was built, not a current check/);
  assert.doesNotMatch(app.packageView(run), /data-download|data-recheck-export/);
  assert.equal(app.exportStatus(run).label, 'No export in this demo');
  assert.deepEqual(Array.from(app.statusOf(run)), ['Checks passed · recorded', 'ok']);
  assert.match(app.stepsView(run), /not in this demo/);
  assert.doesNotMatch(app.stepsView(run), /data-review-downloads/);
  // A recording stays a replay with the script baseline beside it.
  app.state.source = 'recorded';
  app.renderActions();
  assert.match(app.nodes.get('#header-actions').innerHTML, /data-replay-start/);
});

test('a server-marked read-only baseline is history in the local workbench too', async () => {
  const requests = [];
  const app = harness(async url => { requests.push(url); return json(true, {}); });
  const past = {id: 'run-h', incident_id: 'case-a', status: 'ready_for_review', read_only: true, downloads: ['repair.sql'], review: null};
  app.state.incident = {id: 'case-a'}; app.state.run = past;
  await app.download('repair.sql');
  await app.recheckExport();
  await app.act('rehearse');
  assert.deepEqual(requests, []);
  assert.equal(app.exportStatus(past).label, 'No export in this demo');
  assert.equal(app.statusOf({...past, read_only: false})[0], 'Ready for review'); // an ordinary local run keeps its label
});

test('How we evaluated reads the public dataset: listed outcomes, the locked inbox attempts and their limits', async () => {
  const {app} = await publicDemo();
  const e = app.evaluationData();
  assert.deepEqual([e.total, e.repairs, e.stops, e.mismatched], [3, 2, 1, 1]);
  const view = app.evaluationView();
  assert.match(view, /<strong>3<\/strong> recorded runs on 2 cases/);
  assert.match(view, /3 locked attempts with muse-spark-1\.3\. Judged independently: 2 correct repairs and 1 justified stop\. The adapted script reached the same result in every attempt\. The frozen parser refused the format in all 3\./);
  assert.match(view, /<td>Case B · seed 101<\/td><td>Repair, checks passed<\/td><td>Correct repair<\/td><td>Correct repair<\/td><td>Refused: unsupported format<\/td>/);
  assert.match(view, /805,943 tokens\. No cost is inferred\./);
  assert.match(view, /the inbox format included once adapted/);
  assert.match(view, /does not show that a model is needed\. These are authored development cases, not blind holdouts\./);
  assert.match(view, /Dataset scope, as published: Public synthetic cases\. Observed outcomes, not a general success rate\./);
  assert.match(view, /Checks passed · recorded/); // the baseline is historical, not "ready for review"
  assert.doesNotMatch(view, /all four|Ready for review|\$/);
});

// The committed six-case dataset, when this checkout has it (or RR_DEMO_DATA names it).
const demoFile = process.env.RR_DEMO_DATA ? path.resolve(process.env.RR_DEMO_DATA) : path.join(__dirname, '../examples/public-demo/demo-data.json');
test('the published dataset opens on its matched inbox repair and keeps all 16 recordings and every outcome',
  {skip: fs.existsSync(demoFile) ? false : 'no public dataset in this checkout'}, async () => {
    const data = JSON.parse(fs.readFileSync(demoFile, 'utf8'));
    const {app, fetches} = await publicDemo(data);
    assert.deepEqual(fetches, ['./demo-data.json']);
    assert.equal(app.state.cases.length, 6);
    assert.equal(app.state.incident.id, data.defaults.incident_id);
    assert.equal(app.state.recording.id, data.defaults.recording_id);
    const e = app.evaluationData();
    assert.deepEqual([e.total, e.repairs, e.stops, e.errors, e.incomplete, e.other], [16, 9, 4, 2, 1, 0]);
    assert.ok(e.mismatched >= 1);
    assert.match(app.evaluationView(), /2 correct repairs and 1 justified stop/);
    const moment = app.guardrailMoment(app.state.recording);
    assert.equal(moment.bad.step.name, 'rehearse_repair');
    assert.equal(moment.fixed.res.result.passed, true);
    for (const c of app.state.cases) {
      for (const listed of app.state.recordings.get(c.id).list) {
        const r = await app.api(`/api/recordings/${listed.id}`);
        assert.ok(app.displayedSteps(r).length > 0, r.id);
        if (r.fixture_matches !== true) assert.equal(app.recCitations({...r, incident_id: app.state.incident.id}), false, r.id);
        const m = app.guardrailMoment(r);
        if (m?.fixed.step.name === 'rehearse_repair') assert.equal(m.fixed.res.result.checks.every(x => x.passed === true), true, r.id);
      }
      for (const past of app.state.history.get(c.id)) assert.notEqual(app.statusOf(past)[0], 'Ready for review');
    }
    for (const [caseId, files] of Object.entries(data.artifacts)) for (const [name, file] of Object.entries(files)) {
      let start = 1, lines = 0;
      while (start) { const pg = await app.api(`/api/incidents/${caseId}/artifacts/${encodeURIComponent(name)}?start_line=${start}&max_lines=200`); lines += pg.lines.length; start = pg.next_line; }
      assert.equal(lines, file.total_lines, `${caseId}/${name}`);
    }
    assert.deepEqual(fetches, ['./demo-data.json']);
  });

// ---------- Changes and Checks as review boxes ----------

const publicData = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/public-demo/demo-data.json'), 'utf8'));
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the Changes summary and sections take every count from the review, including the 40-cancellation case', () => {
  const data = publicData();
  for (const caseId of ['multiple-retries', 'import-retry']) {
    const app = harness();
    const runId = data.api_get[`/api/runs?incident=${caseId}`].runs[0].id, run = data.api_get[`/api/runs/${runId}`], review = run.review;
    app.state.incident = data.api_get[`/api/incidents/${caseId}`];
    app.state.run = run;
    const view = app.reviewView(), words = strip(view);
    const cancelled = review.changes.length, moved = review.stock.filter(p => p.after !== p.before).length;
    assert.match(words, new RegExp(`All ${review.checks.length} checks passed on the copy`));
    const whole = review.cancellations + review.untargeted_preserved;
    const units = review.stock.reduce((n, p) => n + p.after - p.before, 0), sum = (k) => review.stock.reduce((n, p) => n + p[k], 0);
    assert.match(words, new RegExp(`Active orders ${review.before_active} → ${review.after_active} ${review.cancellations} repeats cancelled history kept ${review.cancellations} of ${whole} changed`));
    assert.match(words, new RegExp(`Later purchases ${review.checkout_preserved} of ${review.checkout_total} intact`));
    assert.match(words, new RegExp(`Stock ${sum('before')} → ${sum('after')} ${moved} products restocked by the cancelled orders \\+${units} units`));
    assert.match(words, new RegExp(`Cancelled on the copy ${cancelled} orders`));
    assert.match(words, new RegExp(`Stock ${moved} of ${review.stock.length} products changed`));
    assert.match(words, new RegExp(`Kept ${review.preserved_orders.length} orders unchanged`));
    assert.equal((app.reviewView().match(/<tr [^>]*data-key="order:[^"]*"/g) || []).length, cancelled + review.preserved_orders.length);
    // A historical baseline says so; nothing offers a download.
    assert.match(words, /Recorded when this baseline was built, not a current check/);
    assert.doesNotMatch(view, /data-download|data-recheck-export/);
    if (caseId === 'multiple-retries') assert.deepEqual([cancelled, review.cancellations, review.before_active, review.after_active], [40, 40, 100, 60]);
  }
});

test('the checks list puts failures first in one flat list, under one summary with the export state', () => {
  const app = harness();
  app.state.incident = {id: 'case-a', products: []};
  app.state.run = diagnosedRun([{name: 'database_integrity', passed: true, detail: 'ok'}, ledger(2),
    {name: 'source_events_applied_once', passed: true, detail: 'ok'}, {name: 'zzz_custom_rule', passed: false, detail: 'Custom failure'}]);
  app.state.run.status = 'failed_checks';
  const view = app.checksTab();
  assert.match(view, /<h2 id="checks-title">2 of 4 checks failed on the copy<\/h2>/);
  assert.match(strip(view), /Files since testing Unavailable Checks failed on the copy, so nothing can be exported\./);
  assert.equal((view.match(/<ul class="checks check-list">/g) || []).length, 1);
  const names = [...view.matchAll(/<strong>([^<]+)<\/strong><span class="sr-only"> (passed|failed)<\/span><span class="check-tag">([^<]+)</g)].map(m => `${m[2]}:${m[1]}:${m[3]}`);
  assert.deepEqual(names, ['failed:Stock matches movement ledger:Stock', 'failed:Zzz custom rule:Other checks',
    'passed:Database integrity:Database', 'passed:Source events applied once:Source evidence']);
  assert.match(view, /KEYBOARD: expected 172, observed 174 \(\+2\)/);
  assert.doesNotMatch(view, /data-recheck-export/);
  // The failures also lead the Changes summary, selectable for their details.
  assert.match(app.reviewView(), /<div class="rv-fails"><h3>Failed on the copy<\/h3><ul class="checks check-list"><li class="sel fail" tabindex="0" data-key="check:stock_matches_movement_ledger"/);
});

test('kept orders state a shared status once instead of repeating it in a column', () => {
  const data = publicData(), app = harness();
  const runId = data.api_get['/api/runs?incident=multiple-retries'].runs[0].id;
  app.state.incident = data.api_get['/api/incidents/multiple-retries'];
  app.state.run = data.api_get[`/api/runs/${runId}`];
  const kept = app.reviewView().split('id="rv-kept"')[1];
  assert.match(kept, /Every order here is active after the test\./);
  assert.doesNotMatch(kept, /<th scope="col">Status<\/th>/);
  app.state.run = {...app.state.run, review: {...app.state.run.review, preserved_orders: [
    {...app.state.run.review.preserved_orders[0]}, {...app.state.run.review.preserved_orders[1], status: 'cancelled'}]}};
  assert.match(app.reviewView().split('id="rv-kept"')[1], /<th scope="col">Status<\/th>/);
});

test('a mismatched recording keeps its recorded review without current-case links', () => {
  const data = publicData(), app = harness();
  const listed = data.api_get['/api/incidents/inbox-evidence/recordings'].find(r => r.fixture_matches === false);
  app.state.incident = data.api_get['/api/incidents/inbox-evidence'];
  app.state.source = 'recorded';
  app.state.recording = data.api_get[`/api/recordings/${listed.id}`];
  const view = app.recordedChangesView();
  assert.match(view, /passed on the recorded copy/);
  assert.match(view, /Read-only recording · no downloads/);
  assert.doesNotMatch(view, /class="citation"|data-download/);
  assert.match(view, /class="mono ref-text"/);
});

// ---------- What happened as a git log ----------

const branchHeads = (view) => [...view.matchAll(/<span class="gl-tag">([\w-]+)<\/span><strong>([^<]+)<\/strong><span class="muted">([^<]+)<\/span>/g)].filter(m => m[1] !== "main").map(m => `${m[1]}:${m[3]}`);

test('each run of an attempt is a branch, a lost connection ends it, and an attempt with no commits is an empty branch', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-first', 'ord_b'), {type: 'connection_lost', detail: 'timeout'},
    write('import-retry', 'ord_c'), write('import-retry', 'ord_d'), {type: 'log_gap', attempt: 'import-retry'}, write('web-checkout', 'ord_e')]});
  const segs = app.gitSegments(app.evidenceWrites());
  assert.deepEqual(plain(segs.map(s => s.gap ? 'gap' : `${s.attempt}:${s.writes.map(w => w.order_id).join(',')}:${s.lost.length}:${s.gaps.length}`)),
    ['import-first:ord_a,ord_b:1:0', 'import-retry:ord_c,ord_d:0:1', 'web-checkout:ord_e:0:0']); // the gap sits on the attempt it names
  const view = app.reconstructionView();
  assert.deepEqual(branchHeads(view), ['import-first:2 writes', 'import-retry:2 writes', 'web-checkout:1 write']);
  assert.match(view, /<li class="gl-row gl-main first">.*?before the first committed write in the evidence/);
  assert.match(view, /<span class="gl-tag">import-first<\/span><span>ended<\/span><span class="muted">2 recorded writes<\/span>/);
  assert.match(view, /<span class="gl-tag">web-checkout<\/span><span>ended<\/span><span class="muted">1 recorded write<\/span><span class="gl-tag head">latest<\/span><span class="muted">5 recorded writes in the evidence<\/span>/);
  assert.doesNotMatch(view, />(main|HEAD|Merge)</); // the database never had branches: no git labels
  assert.match(view, /class="gl-row gl-on gl-lost">.*?<strong>Connection lost<\/strong><span class="muted">timeout<\/span>/);
  assert.match(view, /<div class="gl-row gl-on gl-gap"><i class="gl-dot" aria-hidden="true"><\/i><span class="gl-msg"><strong>Gap in the commit log<\/strong>/);
  assert.doesNotMatch(view, /recon-arc|recon-tick (repeat|kept)|gl-pill/); // nothing is marked without a plan or review
  assert.doesNotMatch(view, /<details[^>]* open/); // without repeats every branch starts folded
  assert.doesNotMatch(view, /\bstyle=/);

  const empty = harness();
  evidenceState(empty, {'events.jsonl': [{type: 'connection_lost', attempt: 'import-first'}, write('import-retry', 'ord_c')]});
  const stopped = empty.reconstructionView(null, {stopped: 1});
  assert.match(stopped, /<div class="gl-row gl-on gl-head">.*?<span class="gl-tag">import-first<\/span><strong>First import<\/strong><span class="muted">no commit records<\/span>/);
  assert.match(stopped, /class="gl-row gl-on gl-lost stop"/); // nothing committed, so the branch stops at the lost connection
  // Missing commit records do not show that nothing was written: the outcome is unknown, and totals count recorded writes only.
  assert.match(stopped, /<li class="gl-row gl-main">.*?<strong>orders-db<\/strong><span class="gl-tag">import-first<\/span><span class="muted">Commit records unavailable · outcome unknown<\/span>/);
  assert.match(stopped, /<span class="gl-tag">import-retry<\/span><span>ended<\/span><span class="muted">1 recorded write<\/span><span class="gl-tag head">latest<\/span><span class="muted">1 recorded write in the evidence · some outcomes unknown<\/span>/);
  assert.doesNotMatch(stopped, /no writes from/);
  assert.match(stopped, /The script stopped instead of guessing: 1 source events have no commit record\./);
});

test('repeats name the commit they repeat, both rows know each other, and their branch opens by default', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-first', 'ord_b'), write('import-retry', 'ord_c'), write('import-retry', 'ord_d'), write('import-retry', 'ord_e')]},
    {orders: [{id: 'ord_c', customer: 'customer-000', sku: 'MOUSE', quantity: 2}]});
  const pairs = [{order_id: 'ord_c', duplicate_of: 'ord_a'}, {order_id: 'ord_d', duplicate_of: 'ord_b'}];
  const view = app.reconstructionView(pairs);
  assert.match(view, /<li class="recon-tick repeat" data-i="2" data-pair="0" data-key="order:ord_c"[^>]*><i class="gl-dot" aria-hidden="true"><\/i><span class="mono">#3<\/span><span class="mono gl-id">ord_c<\/span><span class="muted">customer-000 · MOUSE × 2<\/span><span class="recon-arc" title="Same source event as commit 1, ord_a, which stays">repeat of #1<\/span>/);
  assert.match(view, /<li class="recon-tick kept" data-i="0" data-pair="2"/);
  assert.match(view, /<li class="recon-tick" data-i="4"[^>]*>.*?<span class="gl-pill">untouched<\/span>/);
  assert.match(view, /<span class="gl-pill repeat">2 repeats of #1–2<\/span><span class="gl-pill">1 untouched<\/span>/);
  assert.match(view, /<span class="gl-pill kept">2 first writes kept<\/span>/);
  assert.match(view, /<details class="gl-group" data-group="case-a:script:3" open>/); // the retry branch, which has the repeats
  assert.match(view, /<details class="gl-group" data-group="case-a:script:1">/);
  // A proposal: no copy branch, and nothing described as cancelled.
  assert.match(view, /<span class="gl-tag">proposal<\/span><strong>Would cancel 2 repeated writes<\/strong><span class="muted">Not tested on a copy yet<\/span>/);
  assert.doesNotMatch(view, /test-copy|Not applied/);
  // A branch the person folded stays folded.
  app.state.reconOpen.set('case-a:script:3', false);
  assert.match(app.reconstructionView(pairs), /<details class="gl-group" data-group="case-a:script:3">/);
});

test('after a test on a copy, a copy branch forks from the latest state with the observed result and is never applied', () => {
  const app = harness();
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), write('import-retry', 'ord_c'), write('import-retry', 'ord_d')]});
  const pairs = [{order_id: 'ord_c', duplicate_of: 'ord_a'}];
  app.state.run = {id: 'run-a', incident_id: 'case-a', status: 'ready_for_review', plan: {cancellations: []},
    review: {passed: true, before_active: 3, after_active: 2, checks: [{name: 'source_snapshot_unchanged', passed: true, detail: ''}, {name: 'database_integrity', passed: true, detail: ''}]}};
  const view = app.reconstructionView(pairs, {rehearsed: true});
  assert.match(view, /<span class="gl-tag">import-retry<\/span><span>ended<\/span><span class="muted">2 recorded writes<\/span><span class="gl-tag head">latest<\/span><span class="muted">3 active orders<\/span>/);
  assert.match(view, /<span class="gl-tag">test-copy<\/span><strong>Cancel 1 repeated write<\/strong><span class="muted">on a disposable copy<\/span>/);
  assert.match(view, /<li class="gl-row gl-on stop gl-result ok">.*?<strong>3 → 2 active orders<\/strong><span class="gl-checks">2 of 2 checks passed<\/span><span class="muted">Not applied to orders-db<\/span>/);
  assert.match(view, /<li class="gl-row gl-main last">.*?<strong>orders-db<\/strong><span class="muted">Unchanged during the test<\/span>/);
  assert.doesNotMatch(view, /proposal/);
  app.state.run.review.checks[1].passed = false;
  assert.match(app.reconstructionView(pairs, {rehearsed: true}), /gl-result danger">.*?1 of 2 checks passed/);
  app.state.run.review = {changes: []}; // a review without checks or counts draws no copy branch
  assert.doesNotMatch(app.reconstructionView(pairs, {rehearsed: true}), /test-copy/);
  // A recording's review is a recorded test.
  app.state.source = 'recorded';
  app.state.recording = {incident_id: 'case-a', citations_enabled: true, review: {passed: true, before_active: 3, after_active: 2, changes: [], checks: [{name: 'database_integrity', passed: true, detail: ''}]}};
  const rec = app.reconstructionView(pairs, {recorded: true});
  assert.match(rec, /<span class="gl-tag">recorded-test-copy<\/span><strong>Cancel 1 repeated write<\/strong><span class="muted">in the recorded test on a copy<\/span>/);
  assert.match(rec, /<span class="muted">Opened read-only<\/span>/); // no source check recorded: no claim it stayed unchanged
});

test('compared runs read as one line per run, and open that run', () => {
  const app = harness();
  app.state.source = 'recorded'; app.state.recId = 'rec-a';
  const view = compareState(app, {details: {'rec-a': recording('rec-a', ['ord_c', 'ord_d'])}, recs: [{id: 'rec-a', outcome: 'repair', fixture_matches: true}]});
  assert.match(view, /<p class="cmp-headline">The recorded Meta run cancels the same 2 writes as the script\.<\/p>/);
  assert.match(view, /<li class="cmp-row script"><button class="cmp-open" data-source="script"/);
  assert.match(view, /<li class="cmp-row same current"><button class="cmp-open" data-source="recorded" data-recording="rec-a" aria-current="true"/);
  assert.match(view, /<span class="cmp-here">on screen<\/span>/);
  assert.match(view, /Each run against the script\./);
  assert.doesNotMatch(view, /<svg class="compare-svg"|recon-scroll|cmp-mark/); // the old strip is gone
});

test('in the published cases every repeat names the commit it repeats, and the latest state carries the tested counts', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/public-demo/demo-data.json'), 'utf8'));
  for (const [caseId, branches, repeats] of [['import-retry', 3, 20], ['multiple-retries', 4, 40], ['split-evidence', 3, 20], ['inbox-evidence', 3, 20]]) {
    const app = harness();
    const files = Object.fromEntries(Object.entries(data.artifacts[caseId]).map(([name, f]) => [name, f.lines.map(l => l.text)]));
    evidenceState(app, files, {incident: caseId, orders: data.api_get[`/api/incidents/${caseId}`].orders});
    const runId = data.api_get[`/api/runs?incident=${caseId}`].runs[0].id;
    app.state.run = data.api_get[`/api/runs/${runId}`];
    const review = app.state.run.review, pairs = review.changes.map(c => ({order_id: c.before.id, duplicate_of: c.duplicate_of}));
    const model = app.evidenceWrites(), label = new Map(model.writes.map(w => [w.order_id, w.commitLabel]));
    const view = app.reconstructionView(pairs, {rehearsed: true});
    assert.equal((view.match(/class="gl-row gl-on gl-head/g) || []).length, branches, caseId);
    assert.equal((view.match(/class="recon-tick repeat"/g) || []).length, repeats, caseId);
    for (const p of pairs) {
      const row = view.match(new RegExp(`data-key="order:${p.order_id}"[^>]*>.*?repeat of #(\\d+)<`));
      assert.ok(row, `${caseId} ${p.order_id}`);
      assert.equal(Number(row[1]), label.get(p.duplicate_of), `${caseId} ${p.order_id}`);
    }
    assert.match(view, new RegExp(`<span class="gl-tag head">latest<\\/span><span class="muted">${review.before_active} active orders`), caseId);
    assert.match(view, new RegExp(`${review.before_active} → ${review.after_active} active orders<\\/strong><span class="gl-checks">10 of 10 checks passed`), caseId);
  }
});

test('in a branch with repeats, runs of unmarked commits fold into one row and stay in the list', () => {
  const app = harness();
  const retry = ['ord_c', 'ord_d', 'ord_e', 'ord_f', 'ord_g', 'ord_h'].map(id => write('import-retry', id));
  evidenceState(app, {'events.jsonl': [write('import-first', 'ord_a'), ...retry]});
  const view = app.reconstructionView([{order_id: 'ord_c', duplicate_of: 'ord_a'}]);
  assert.match(view, /<summary class="gl-fold">.*?<span>5 untouched commits<\/span><span class="gl-meta mono">#3–7<\/span><\/summary>/);
  assert.equal((view.match(/class="recon-tick"/g) || []).length, 5); // folded, not dropped
  assert.match(view, /<li class="recon-tick repeat" data-i="1"/);
  // Without marks nothing folds: the branch itself starts folded instead.
  assert.doesNotMatch(app.reconstructionView(), /gl-fold/);
});

// ---------- Sidebar spine: the open case's attempts branch off the case line; closed cases show a strip ----------

test('folding preserves the displayed script history and its square-to-dot mapping', () => {
  const app = harness();
  sidebarState(app);
  const runs = [
    {id: 'run-new', status: 'failed_checks'},
    {id: 'run-selected', status: 'ready_for_review'},
    {id: 'run-old', status: 'blocked'},
    {id: 'run-outside-window', status: 'stopped'},
  ].map(r => ({...r, incident_id: 'case-a'}));
  app.state.history.set('case-a', runs);
  app.state.source = 'script';
  app.state.run = runs[1];
  const dots = html => [...html.matchAll(/class="att-dot (t-[a-z]+)" data-flip="([^"]+)"/g)].map(m => [m[1], m[2]]);
  const squares = html => [...html.matchAll(/<i class="(t-[a-z]+)" data-flip="([^"]+)"/g)].map(m => [m[1], m[2]]);
  const tree = app.attemptsTree('case-a');
  const strip = app.caseStrip('case-a', runs[0]);
  assert.equal(dots(tree).length, 6); // three Meta runs and the three displayed script runs
  assert.deepEqual(squares(strip), dots(tree));
  assert.deepEqual(squares(strip).slice(3).map(([tone]) => tone), ['t-danger', 't-ok', 't-warn']);
  assert.doesNotMatch(tree, /run-outside-window/);
  app.renderCases();
  app.setBranch(false);
  const folded = app.nodes.get('#cases').innerHTML.match(/data-case="case-a".*?<\/button>/)[0];
  assert.deepEqual(squares(folded), dots(tree));
});

function sidebarState(app) {
  app.state.cases = [{id: 'case-a', title: 'Case A'}, {id: 'case-b', title: 'Case B'}, {id: 'case-c', title: 'Case C'}];
  app.state.recordings.set('case-a', {status: 'ok', list: [
    {id: 'r3', outcome: 'repair', fixture_matches: true, recorded_at: '2026-10-28T15:25:38Z'},
    {id: 'r2', outcome: 'stop', fixture_matches: false, recorded_at: '2026-10-28T15:22:43Z'},
    {id: 'r1', outcome: 'error', fixture_matches: true, recorded_at: '2026-10-28T14:21:56Z'}]});
  app.state.recordings.set('case-b', {status: 'ok', list: [{id: 'b1', outcome: 'incomplete', fixture_matches: true}]});
  app.state.incident = {id: 'case-a', title: 'Case A'};
}
const classes = (html) => [...html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(' '));
const attempts = (html) => [...html.matchAll(/<button class="run-item attempt([^"]*)"[^>]*>(.*?)<\/button>/g)].map(m => ({cls: m[1].trim(), body: m[2]}));

test('the open case branches off the spine and lights the rail down to the attempt on screen', () => {
  const app = harness();
  sidebarState(app);
  app.state.source = 'recorded'; app.state.recId = 'r2';
  const tree = app.attemptsTree('case-a');
  assert.match(tree, /^<div class="tree has-current" id="case-attempts" data-tree="case-a" role="group" aria-label="Attempts on this case"><svg class="tree-fork"/);
  assert.match(tree, /<svg class="tree-merge"[^>]*>.*<\/svg><\/div>$/);
  const items = attempts(tree);
  assert.deepEqual(items.map(i => i.cls), ['lit', 'current', '', '']); // lit above the current run, plain below it
  assert.deepEqual(items.map(i => i.body.match(/class="att-dot ([^"]+)"/)[1]), ['t-ok', 't-warn', 't-danger', 't-empty']);
  assert.deepEqual(items.map(i => i.body.match(/class="attempt-label">([^<]+)/)[1]), ['Meta run 3', 'Meta run 2', 'Meta run 1', 'Script baseline']);
  // The outcome word is in the name, not on screen; a recording on different inputs says so.
  assert.deepEqual(items.map(i => i.body.match(/class="sr-only"> · ([^<]+)/)[1]), ['repair', 'stopped', 'error', 'not run']);
  assert.match(items[1].body, /<span class="attempt-meta warn">inputs differ<\/span>/);
  assert.match(tree, /aria-current="true" title="Meta run 2 · Stopped · recorded · [^"]+ · recorded, not live · inputs differ from this case"/);
  assert.equal((tree.match(/aria-current="true"/g) || []).length, 1);
  assert.doesNotMatch(items[3].body, /attempt-meta/); // a script that has not run has no time
  // Tone classes never collide with the app's own .empty panel.
  assert.ok(!classes(tree).includes('empty'));
  assert.doesNotMatch(tree, /att-tag/);
});

test('a script run on screen lights every recording above it and shows its own outcome', () => {
  const app = harness();
  sidebarState(app);
  const runs = [{id: 'run-new', incident_id: 'case-a', status: 'failed_checks', created_at: '2026-11-02T23:57:51Z'}, {id: 'run-old', incident_id: 'case-a', status: 'ready_for_review'}];
  app.state.history.set('case-a', runs);
  app.state.source = 'script'; app.state.run = runs[0];
  const items = attempts(app.attemptsTree('case-a'));
  assert.deepEqual(items.map(i => i.cls), ['lit', 'lit', 'lit', 'current', '']);
  assert.deepEqual(items.slice(3).map(i => i.body.match(/class="att-dot ([^"]+)"/)[1]), ['t-danger', 't-ok']);
  assert.deepEqual(items.slice(3).map(i => i.body.match(/class="sr-only"> · ([^<]+)/)[1]), ['failed', 'passed']);
  assert.match(items[3].body, /<span class="attempt-meta">[^<]+<\/span>/);
  // With nothing of this case on screen the fork stays unlit.
  app.state.run = {id: 'elsewhere'};
  assert.match(app.attemptsTree('case-a'), /^<div class="tree" id="case-attempts"/);
});

test('closed cases show one square per outcome, hollow while the script has not run', () => {
  const app = harness();
  sidebarState(app);
  const cells = (html) => [...html.matchAll(/<i class="([^"]+)" data-flip="([^"]+)"><\/i>/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(cells(app.caseStrip('case-a', null)), ['t-ok case-a:0', 't-warn case-a:1', 't-danger case-a:2', 't-empty case-a:3']);
  assert.deepEqual(cells(app.caseStrip('case-b', {status: 'stopped'})), ['t-warn case-b:0', 't-warn case-b:1']);
  assert.deepEqual(cells(app.caseStrip('case-c', {status: 'proposed'})), ['t-plain case-c:0']);
  assert.match(app.caseStrip('case-c', null), /^<span class="case-strip" aria-hidden="true"><i /);
  app.renderCases();
  const html = app.nodes.get('#cases').innerHTML;
  const rows = [...html.matchAll(/<button class="case[^"]*" data-case="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*>(.*?)<\/button>/g)];
  assert.deepEqual(rows.map(r => r[1]), ['case-a', 'case-b', 'case-c']);
  assert.deepEqual(rows.map(r => r[2]), ['01 Case A · Not started · 3 recorded runs', '02 Case B · Not started · 1 recorded run', '03 Case C · Not started']);
  assert.deepEqual(rows.map(r => r[3].match(/<span class="case-ix" aria-hidden="true">(\d+)<\/span>/)[1]), ['01', '02', '03']);
  assert.doesNotMatch(rows[0][3], /case-strip/); // the open case shows its attempts instead
  assert.match(rows[1][3], /<span class="case-strip" aria-hidden="true"><i class="t-warn" data-flip="case-b:0"><\/i><i class="t-empty" data-flip="case-b:1"><\/i><\/span>/);
  assert.match(html, /<\/button><div class="tree/); // the attempts follow the open case's row
  assert.doesNotMatch(html, /case-count/);
  assert.ok(!classes(html).includes('empty'));
});

test('the open case folds its attempts into its strip and unfolds them, square by square', () => {
  const app = harness();
  sidebarState(app);
  app.renderCases();
  const open = app.nodes.get('#cases').innerHTML;
  assert.match(open, /data-case="case-a"[^>]*aria-current="page" aria-expanded="true" aria-controls="case-attempts"/);
  assert.doesNotMatch(open.match(/data-case="case-a".*?<\/button>/)[0], /case-strip/);
  const dots = [...open.matchAll(/class="att-dot [^"]+" data-flip="([^"]+)"/g)].map(m => m[1]);
  app.setBranch(false);
  assert.equal(app.state.sideFolded, true);
  const folded = app.nodes.get('#cases').innerHTML;
  assert.doesNotMatch(folded, /class="tree|aria-controls/);
  const row = folded.match(/data-case="case-a".*?<\/button>/)[0];
  assert.match(row, /aria-current="page" aria-expanded="false" aria-label/);
  const squares = [...row.matchAll(/<i class="t-[a-z]+" data-flip="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(squares, ['case-a:0', 'case-a:1', 'case-a:2', 'case-a:3']);
  assert.deepEqual(dots, squares); // each square unfolds into its own dot
  app.setBranch(false); // already folded: nothing changes
  assert.equal(app.state.sideFolded, true);
  app.setBranch(true);
  assert.equal(app.state.sideFolded, false);
  assert.match(app.nodes.get('#cases').innerHTML, /<\/button><div class="tree has-current|<\/button><div class="tree"/);
  // Nothing folds while a case is loading; a closed case has no expanded state.
  app.state.switching = 'case-b';
  app.setBranch(false);
  assert.equal(app.state.sideFolded, false);
  // While case B loads, case A keeps its attempts (disabled), so both change in the same later render.
  app.renderCases();
  const loading = app.nodes.get('#cases').innerHTML;
  assert.match(loading, /data-case="case-a"[^>]*>.*?<\/button><div class="tree/);
  assert.equal((loading.match(/class="run-item attempt[^"]*"[^>]*\sdisabled /g) || []).length, 4);
  assert.doesNotMatch(loading.match(/data-case="case-a"[^>]*>/)[0], /aria-expanded/);
  assert.match(loading, /<button class="case active loading" data-case="case-b"/);
  assert.doesNotMatch(loading.match(/data-case="case-b"[^>]*>/)[0], /aria-expanded/);
  assert.match(loading.match(/data-case="case-b".*?<\/button>/)[0], /case-strip/);
});

// ---------- Changes summary rows ----------

test('the active-order share excludes already-cancelled history', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  const rendered = app.repairFlow({...review, untargeted_preserved: 61});
  assert.match(strip(rendered), /Active orders 80 → 60/);
  assert.equal(fiveMarks(rendered, '20 of 80 changed'), 'a----');
  assert.doesNotMatch(rendered, /20 of 81 changed/);
  const withoutActiveCounts = app.repairFlow({...review, before_active: null, after_active: null, untargeted_preserved: 61});
  assert.match(strip(withoutActiveCounts), /Orders 20 orders cancelled/);
  assert.equal(fiveMarks(withoutActiveCounts, '20 of 81 changed'), 'a----');
  assert.doesNotMatch(withoutActiveCounts, />Active orders</);
});

test('unknown stock values and cancelled quantities do not produce a preservation or restock claim', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  for (const stock of [
    [{sku: 'A'}], [{sku: 'A', before: null, after: null}],
    [{sku: 'A', before: 10}], [{sku: 'A', before: '10', after: 12}],
    [{sku: 'A', before: Number.MAX_SAFE_INTEGER, after: Number.MAX_SAFE_INTEGER}, {sku: 'B', before: 1, after: 2}],
  ]) assert.doesNotMatch(app.repairFlow({...review, stock}), /data-open-file="rv-stock"/);
  const unknownQuantity = app.repairFlow({...review,
    cancellations: 2,
    stock: [{sku: 'A', before: 10, after: 10}, {sku: 'B', before: 10, after: 11}],
    changes: [{before: {sku: 'A'}}, {before: {sku: 'B', quantity: 1}}],
  });
  assert.match(strip(unknownQuantity), /Stock 20 → 21 1 of 2 products changed \+1 units/);
  assert.doesNotMatch(unknownQuantity, /restocked by the cancelled orders/);
  // Signed inventory quantities remain legitimate observations.
  assert.match(strip(app.repairFlow({...review, stock: [{sku: 'A', before: -3, after: -1}]})), /Stock -3 → -1/);
});

test('history kept is shown only when the preservation check confirms it', () => {
  const app = harness(), review = reviewRun('ready_for_review').review;
  assert.doesNotMatch(app.repairFlow(review), />history kept</);
  for (const passed of [true, false]) {
    const result = app.repairFlow({...review, passed,
      checks: [...review.checks, {name: 'order_history_preserved', passed, detail: 'Recorded history result.'}],
    });
    assert.equal(result.includes('>history kept<'), passed);
  }
});

test('each summary row opens its own section below, and stock credits the cancellations only when the units match', () => {
  const data = publicData();
  const app = harness();
  const runId = data.api_get['/api/runs?incident=import-retry'].runs[0].id, run = data.api_get[`/api/runs/${runId}`];
  app.state.incident = data.api_get['/api/incidents/import-retry'];
  app.state.run = run;
  const view = app.reviewView();
  const targets = [...view.matchAll(/<button class="rv-row" type="button" data-open-file="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(targets, ['rv-cancelled', 'rv-kept', 'rv-stock']);
  for (const id of targets) assert.match(view, new RegExp(`<details class="rv-box rv-file" id="${id}"`));
  assert.match(view, /<ul class="rv-rows" aria-label="What the test changed">/);
  assert.equal((view.match(/, show this section below/g) || []).length, 3);
  assert.match(view, /<span class="gl-pill repeat">20 repeats cancelled<\/span><span class="gl-pill">history kept<\/span>/);
  // One product's change no longer matches its cancelled units: the row only says what changed.
  const stock = run.review.stock.map((p, i) => i === 0 ? {...p, after: p.after + 1} : p);
  const words = strip(app.repairFlow({...run.review, stock}));
  assert.match(words, /Stock \d+ → \d+ 4 of 4 products changed \+40 units/);
  assert.doesNotMatch(words, /restocked by the cancelled orders/);
  // No stock change, and a review without stock rows.
  const flat = run.review.stock.map(p => ({...p, after: p.before}));
  assert.match(strip(app.repairFlow({...run.review, stock: flat})), /no product changed ±0 units/);
  assert.doesNotMatch(app.repairFlow({...run.review, stock: []}), /data-open-file="rv-stock"/);
});
