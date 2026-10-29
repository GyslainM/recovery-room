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
  vm.runInContext(source + '\nrender = () => { globalThis.renderCalls++; };\nrenderPanel = () => {};\nglobalThis.subject = {state, download, reviewView, exportStatus, recheckExport, act, changesView, checksTab, sqlView, modeInfo, repairFlow, stockVisual, transition};', context);
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
  assert.match(rendered, /additional business rule/);
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
