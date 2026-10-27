'use strict';

// Presentation only. The Python engine owns plans, rehearsal, checks, freshness and exports;
// this file displays what the local API returns and never decides whether a repair is valid.
const $ = (selector) => document.querySelector(selector);
const PAGE = 200;      // server maximum lines per evidence request
const MAX_PAGES = 50;  // bounds one evidence file at 10,000 lines
const TABS = ['investigation', 'evidence', 'changes', 'checks', 'sql'];
const state = {
  // runs: the full run record shown for each case. history: server run summaries per case, newest first.
  incident: null, run: null, cases: [], runs: new Map(), history: new Map(), views: new Map(),
  tab: 'investigation', busy: false, switching: null, version: 0,
  files: new Map(), ev: {name: 'events.jsonl', query: '', citedOnly: false, activeRef: null},
  selection: null, sheet: false, lastFocus: null, filter: '', changeQuery: '',
  runMeta: new Map(), exportChecks: new Map(), sql: new Map(), rechecking: null,
};
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = (value) => escape(value);
const badge = (value, tone = '') => `<span class="pill ${tone === true ? 'warn' : tone || ''}">${text(value)}</span>`;
const metric = (value, label) => `<div class="metric"><strong>${text(value)}</strong><span>${text(label)}</span></div>`;
const table = (headers, rows, rowAttrs = []) => `<div class="scroll-table"><table><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row,i)=>`<tr ${rowAttrs[i]||''}>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const pad = (n) => String(n).padStart(2, '0');
const time = (d) => d ? d.toLocaleTimeString() : '';

// Labels for run states reported by the server; unknown states are shown as-is.
const RUN_STATUS = {
  proposed: ['Proposal ready', ''],
  stopped: ['Stopped · evidence needed', 'warn'],
  ready_for_review: ['Ready for review', 'ok'],
  failed_checks: ['Checks failed', 'danger'],
  blocked: ['Export blocked', 'warn'],
};
const MODE_LABELS = {offline_deterministic_engine_demo_NOT_a_model_run: 'Offline deterministic script · no model'};
// Display grouping only; unknown check names fall into "Other checks".
const CHECK_GROUPS = [
  ['Database', ['database_integrity']],
  ['Preserved work', ['unaffected_orders_preserved', 'order_history_preserved', 'original_movements_preserved']],
  ['Stock', ['stock_matches_movement_ledger', 'stock_matches_active_orders']],
  ['Source evidence', ['source_evidence_complete', 'source_events_applied_once']],
  ['Freshness', ['source_snapshot_unchanged', 'evidence_snapshot_unchanged']],
];
const DOWNLOAD_NOTES = {
  'repair.sql': 'Guarded SQLite script. Rolls back if table state differs.',
  'plan.json': 'Cancellation plan with evidence citations.',
  'report.json': 'Checks, plan and before/after summary counts.',
  'report.html': 'Readable review report.',
};
const SQL_WORDS = /\b(PRAGMA|BEGIN|IMMEDIATE|COMMIT|ROLLBACK|CREATE|TEMP|TABLE|AS|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|AND|OR|NOT|NULL|IS|IN|EXISTS|CASE|WHEN|THEN|ELSE|END|CHECK|INTEGER|ON|DROP|COUNT|UNION|ALL|EXCEPT|LIMIT)\b/g;

async function api(path, post = false) {
  const response = await fetch(path, post ? {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'} : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The local request failed.');
  return value;
}

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }

const statusOf = (run) => run ? (RUN_STATUS[run.status] || [run.status.replaceAll('_', ' '), '']) : ['Not started', ''];
const modeLabel = (mode) => MODE_LABELS[mode] || String(mode || '').replaceAll('_', ' ');
const groupOf = (name) => (CHECK_GROUPS.find(([, names]) => names.includes(name)) || ['Other checks'])[0];
const lineOf = (ref) => Number(String(ref).split(':L')[1]);
const fileOf = (ref) => String(ref).split(':L')[0];
const purchase = (o) => o ? `${text(o.customer)} · ${text(o.sku)} × ${text(o.quantity)}` : '—';
const purchaseCell = (o) => o ? `<span class="purchase-cell"><strong>${text(o.customer)}</strong><span>${text(o.sku)} × ${text(o.quantity)}</span></span>` : '—';
const compactId = (id) => String(id).length > 14 ? `${String(id).slice(0,8)}…${String(id).slice(-4)}` : String(id);
const orderButton = (id, tone = '') => `<button class="id-link mono ${tone}" data-key="order:${escape(id)}" title="${escape(id)}" aria-label="Inspect order ${escape(id)}">${text(compactId(id))}</button>`;
const ordersById = () => new Map((state.incident?.orders || []).map(o => [o.id, o]));
const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
const isNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
const SUMMARY_FIELDS = ['id', 'incident_id', 'status', 'summary', 'mode', 'created_at'];
const shortId = (id) => String(id).replace(/^run-/, '').slice(0, 8);
const started = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'}) : ''; };
// Later purchases come from the server's review (checkout_order_ids); the UI applies no rule of its own.
const laterIds = (review) => new Set(review?.checkout_order_ids || []);

/* ---------- Case navigation ---------- */

// A case's sidebar status is its newest run's last recorded state (not a fresh export check).
function caseStatus(id) {
  if (state.switching === id) return ['Loading…', 'loading'];
  return statusOf(state.history.get(id)?.[0] || state.runs.get(id));
}

async function refreshHistory(caseId) {
  const value = await api(`/api/runs?incident=${encodeURIComponent(caseId)}`);
  const runs = Array.isArray(value.runs) ? value.runs : [];
  state.history.set(caseId, runs);
  return runs;
}

// Keeps the sidebar in step with a run record the server just returned, without another request.
function upsertHistory(run) {
  if (!run?.id || !run.incident_id) return;
  const list = state.history.get(run.incident_id);
  if (!list) return;
  const summary = Object.fromEntries(SUMMARY_FIELDS.filter(f => f in run).map(f => [f, run[f]]));
  const index = list.findIndex(r => r.id === run.id);
  if (index === -1) list.unshift(summary); else list[index] = {...list[index], ...summary};
}

async function loadRun(runId) {
  const caseId = state.incident.id, version = state.version;
  const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (version !== state.version || state.incident?.id !== caseId) return;
  state.runs.set(caseId, run);
  upsertHistory(run);
  Object.assign(state, {run, selection: null, sheet: false, filter: '', changeQuery: ''});
  if (!run.review && ['changes', 'checks', 'sql'].includes(state.tab)) state.tab = 'investigation';
  render();
}

function renderCases() {
  $('#case-count').textContent = String(state.cases.length).padStart(2, '0');
  $('#cases').innerHTML = state.cases.map((c, i) => {
    const active = c.id === (state.switching || state.incident?.id);
    const [label, tone] = caseStatus(c.id);
    return `<button class="case ${active?'active':''}" data-case="${escape(c.id)}" ${state.busy?'disabled':''} ${active?'aria-current="page"':''}><span class="case-top"><span class="case-no">${pad(i + 1)}</span><strong>${text(c.title)}</strong></span><span class="case-status ${tone}">${text(label)}</span></button>`;
  }).join('');
}

function renderRuns() {
  const card = $('#run-card'), runs = state.history.get(state.incident?.id) || [], shown = state.run?.id;
  card.hidden = !state.incident;
  card.innerHTML = `<div class="side-label">Runs <span>${pad(runs.length)}</span></div>
    ${runs.length ? `<ol class="run-list">${runs.map(r => {
      const [label, tone] = statusOf(r), current = r.id === shown;
      return `<li><button class="run-item ${current?'current':''}" data-run="${escape(r.id)}" aria-current="${current?'true':'false'}" title="${escape(r.id)} · started ${escape(r.created_at || '')}"><span class="case-status ${tone}">${text(label)}</span><span class="run-meta"><span class="mono">${text(shortId(r.id))}</span><time datetime="${escape(r.created_at || '')}">${text(started(r.created_at))}</time></span></button></li>`;
    }).join('')}</ol>` : '<p class="run-empty">No runs yet in this server session.</p>'}
    <p class="run-note">Last recorded status · this server session · newest first</p>`;
}

function parseHash() {
  const match = /^#case=([\w-]+)(?:&tab=(\w+))?$/.exec(location.hash);
  if (!match || !state.cases.some(c => c.id === match[1])) return null;
  return {id: match[1], tab: TABS.includes(match[2]) ? match[2] : null};
}

function updateHash() {
  if (!state.incident) return;
  const hash = `#case=${state.incident.id}&tab=${state.tab}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function saveView() {
  if (!state.incident) return;
  state.views.set(state.incident.id, {tab: state.tab, ev: {...state.ev}, selection: state.selection, filter: state.filter, changeQuery: state.changeQuery});
}

async function selectCase(identifier, tab = null) {
  const version = ++state.version;
  saveView();
  state.switching = identifier;
  notice(); renderCases();
  $('#content').setAttribute('aria-busy', 'true');
  try {
    const [incident] = await Promise.all([
      api(`/api/incidents/${encodeURIComponent(identifier)}`),
      refreshHistory(identifier).catch(error => { notice(`Run history unavailable: ${error.message}`); return []; }),
    ]);
    if (version !== state.version) return;
    let run = state.runs.get(identifier) || null;
    // After a reload the page holds no runs: restore the newest one this server session recorded.
    const newest = state.history.get(identifier)?.[0];
    if (!run && newest) {
      run = await api(`/api/runs/${encodeURIComponent(newest.id)}`);
      if (version !== state.version) return;
      state.runs.set(identifier, run);
    }
    const view = state.views.get(identifier);
    Object.assign(state, {
      incident, run, switching: null, sheet: false,
      tab: tab || view?.tab || (run?.review ? 'changes' : 'investigation'),
      ev: view?.ev ? {...view.ev} : {name: 'events.jsonl', query: '', citedOnly: false, activeRef: null},
      selection: view?.selection || null, filter: view?.filter || '', changeQuery: view?.changeQuery || '',
    });
    render();
    $('#content').focus({preventScroll: true});
  } finally {
    if (version === state.version) { state.switching = null; $('#content').removeAttribute('aria-busy'); renderCases(); }
  }
}

/* ---------- Shell ---------- */

function render() {
  if (!state.incident) return;
  renderCases();
  renderRuns();
  renderHeader();
  renderTabs();
  renderPanel();
  renderContext();
  updateHash();
}

function renderHeader() {
  const {incident, run, busy} = state;
  const [label, tone] = statusOf(run);
  $('#title').textContent = incident.title;
  $('#crumb-case').textContent = incident.title;
  const mode = run?.mode || incident.mode;
  $('#mode-indicator').textContent = MODE_LABELS[mode] ? 'Offline demo · No model' : modeLabel(mode);
  $('#incident-meta').innerHTML = `<span class="status ${tone}">${text(label)}</span>
    <span class="chip">Source read-only · Rehearsal on a copy</span>${olderRunNote(run)}`;
  $('#run-details').hidden = !run;
  $('#run-details-body').innerHTML = run ? `<dl class="run-facts">
      <dt>Run ID</dt><dd><span class="mono">${text(run.id)}</span> <button class="link" data-copy-value="${escape(run.id)}" aria-label="Copy full run ID">Copy ID</button></dd>
      <dt>Started</dt><dd>${text(started(run.created_at)) || 'Not recorded'}</dd>
      <dt>Method</dt><dd>${text(modeLabel(mode))}. Actual local function calls, without model or API calls. Meta credits pending.</dd>
      <dt>Review boundary</dt><dd>The source stays unchanged. Rehearsal uses a disposable copy. Human review is required before using exported SQL.</dd>
    </dl><button class="secondary" data-action="investigate" ${busy?'disabled':''}>New offline investigation</button>` : '';
  const investigate = (primary) => `<button class="${primary?'primary':'secondary'} ${busy?'busy':''}" data-action="investigate" ${busy?'disabled':''}>${busy?'Working…':run?'New offline investigation':'Start offline investigation'}</button>`;
  let actions = '';
  if (!run) actions = investigate(true);
  else if (run.status === 'proposed') actions = `<button class="primary ${busy?'busy':''}" data-action="rehearse" ${busy?'disabled':''}>${busy?'Rehearsing on a copy…':'Rehearse on a disposable copy'}</button>`;
  else if (run.status === 'ready_for_review') actions = '<button class="primary" data-review-repair>Review repair</button>';
  else if (run.status === 'failed_checks') actions = '<button class="primary" data-tab="checks">Review failed checks</button>';
  else if (run.status === 'blocked') actions = '<button class="secondary" data-review-repair>Review blocked repair</button>';
  else actions = investigate(false);
  $('#header-actions').innerHTML = actions;
}

function olderRunNote(run) {
  const newest = state.history.get(state.incident?.id)?.[0];
  if (!run || !newest || newest.id === run.id) return '';
  return `<span class="chip warn-chip">Older run</span><button class="link small" data-run="${escape(newest.id)}">Open newest run</button>`;
}

function renderTabs() {
  const review = state.run?.review;
  const counts = {
    evidence: state.incident.artifacts.length,
    changes: review ? review.changes.length : '',
    checks: review ? `${review.checks.filter(c => c.passed).length}/${review.checks.length}` : '',
    sql: review && state.run.status !== 'ready_for_review' ? 'unavailable' : '',
  };
  const labels = {investigation: 'Investigation', evidence: 'Evidence', changes: 'Changes', checks: 'Checks', sql: 'SQL'};
  for (const tab of TABS) {
    const button = $(`#tab-${tab}`), selected = tab === state.tab;
    button.setAttribute('aria-selected', String(selected));
    button.setAttribute('tabindex', selected ? '0' : '-1');
    const failed = tab === 'checks' && review && !review.passed;
    button.innerHTML = `${labels[tab]}${counts[tab] !== '' && counts[tab] !== undefined ? `<span class="count ${failed?'bad':''}">${text(counts[tab])}</span>` : ''}`;
  }
  $('#content').setAttribute('aria-labelledby', `tab-${state.tab}`);
}

function setTab(tab, focusTab = false) {
  if (!TABS.includes(tab)) return;
  state.tab = tab;
  renderTabs(); renderPanel(); updateHash();
  if (focusTab) $(`#tab-${tab}`).focus();
}

function renderPanel() {
  const views = {investigation: investigationView, evidence: evidenceView, changes: changesView, checks: checksTab, sql: sqlView};
  const reviewing = state.run?.review && ['changes', 'checks', 'sql'].includes(state.tab);
  $('#content').innerHTML = `${reviewing ? reviewSteps() : ''}${views[state.tab]()}`;
  if (state.tab === 'evidence') renderEvidence();
  if (state.tab === 'sql') maybeLoadSql();
  markSelection();
}

function reviewSteps() {
  return `<nav class="review-steps" aria-label="Repair review">${[['changes','1 · Inspect changes'],['checks','2 · Review checks'],['sql','3 · Inspect SQL']].map(([tab,label])=>`<button data-tab="${tab}" ${state.tab===tab?'aria-current="step"':''}>${label}</button>`).join('')}
    <button data-review-downloads>4 · Download artifacts</button></nav>`;
}

function reviewRepair(downloads = false) {
  setTab('changes');
  const target = downloads ? $('#repair-package') : $('#content');
  target?.scrollIntoView({block: 'start'});
  target?.focus({preventScroll: true});
}

const emptyState = (title, body) => `<div class="empty"><h2>${text(title)}</h2><p>${text(body)}</p></div>`;

/* ---------- Investigation ---------- */

function incidentOverview() {
  const {incident} = state;
  const multipleRetries = incident.scenario === 'multiple-retries';
  return `<div class="section-heading"><h2>${multipleRetries?'Two partial imports. Two retries.':'A partial import. A full retry.'}</h2>${badge('Open incident',true)}</div>
    <p class="lede">${multipleRetries?'Two attempts lost their connections after partial writes. A final retry completed, then customers made genuine purchases.':'The importer lost its connection after some writes. It retried the source file while customers continued buying.'} Similar-looking purchases may be legitimate.</p>
    <div class="metrics">${metric(incident.active_orders,'active order records')}${metric(incident.artifacts.length,'evidence files')}${metric(incident.products.length,'products affected')}</div>
    <div class="callout"><strong>The question to resolve</strong><br>Which records repeat the same source action, and which later purchases must stay? A stock correction also needs a compensating ledger entry.</div>`;
}

function sourceRecords() {
  const {incident} = state;
  return `<h3>Current inventory · source database</h3>${table(['Product','Available stock'],incident.products.map(p=>[text(p.name),`<span class="num">${text(p.on_hand)}</span>`]))}
    <details class="fold"><summary>Incident note and supported schema</summary><p class="small">${text(incident.note.lines.map(l=>l.text).join('\n'))}</p><pre>${text(incident.schema.map(s=>s.sql).join('\n\n'))}</pre></details>
    <div class="row-head"><h3>Order records</h3><span class="caption">${incident.orders.length} observed records · select one for details</span></div>
    ${orderTable(incident.orders)}`;
}

function callsView(trace) {
  return `<div class="row-head"><h3>${trace.length} local function calls · deterministic script</h3><span class="caption">Actual calls, in order</span></div>
    <p class="small muted">The steps below are actual local function calls made by the deterministic script. They are not model reasoning or a replay of a model run.</p>
    <ol class="calls">${trace.map((step,i)=>{
      const a = step.arguments || {};
      const arg = a.name ? `${a.name}${a.start_line ? ` · from L${a.start_line}` : ''}` : step.tool === 'query_database' ? (a.sql || '') : 'no arguments';
      return `<li><details class="call"><summary><span class="idx">${pad(i+1)}</span><span class="tool mono">${text(step.tool)}</span><span class="arg mono">${text(arg)}</span><span class="ok">observed</span></summary><pre>${text(JSON.stringify({arguments:step.arguments,result:step.result},null,2))}</pre></details></li>`;
    }).join('')}</ol>`;
}

function investigationView() {
  const {run} = state;
  if (!run) return `${incidentOverview()}<p class="small muted">Start the offline investigation from the header. It reads the evidence with bounded, read-only tools.</p>${sourceRecords()}`;
  const stopped = run.status === 'stopped';
  const result = `<div class="section-heading"><h2>${stopped?'Evidence needed to continue':run.plan?'A bounded proposal':'Investigation result'}</h2>${badge(stopped?'Stopped':'Script observations',stopped)}</div>
    <div class="callout ${stopped?'stop':''}"><strong>${stopped?'No repair exported.':'Investigation result'}</strong><br>${text(run.summary)}</div>`;
  const plan = run.plan ? `<div class="row-head"><h3>Proposed cancellations</h3>${badge(`${run.plan.cancellations.length} targets`)}</div>
    <p class="small muted">Keep the first recorded write for each source event. Each target cites both committed writes; select a row to inspect them.${run.status==='proposed'?' Next: rehearse on a disposable copy from the header.':''}</p>${planTable(run.plan)}` : '';
  const stop = stopped ? `<h3>Next useful step</h3><p class="small">Recover the committed-write logs for the missing source events, then investigate again. The source has not been changed.</p>
    <div class="row-head"><h4>${run.missing_event_ids.length} source events without commit evidence</h4><span class="caption">Select one to find it in the evidence</span></div>
    <div class="id-grid">${run.missing_event_ids.map(id=>`<button class="id-chip mono" data-key="event:${escape(id)}" aria-selected="false">${text(id)}</button>`).join('')}</div>` : '';
  return `${result}${plan}${stop}${callsView(run.trace)}<details class="fold"><summary>Incident overview and source records</summary>${incidentOverview()}${sourceRecords()}</details>`;
}

function orderTable(rows) {
  return table(['Purchase','Order','Status','Source reference'],
    rows.map(o=>[purchaseCell(o),orderButton(o.id),text(o.status),`<span class="mono">${text(o.source_reference||'—')}</span>`]),
    rows.map(o=>`class="sel" tabindex="0" data-key="order:${escape(o.id)}" aria-selected="false"`));
}

function citations(action) {
  return `<span class="citations">${action.evidence_refs.map(ref=>`<button class="citation" data-key="order:${escape(action.order_id)}" data-focus-ref="${escape(ref)}">${text(ref)}</button>`).join('')}</span>`;
}

function planTable(plan) {
  const orders = ordersById();
  return table(['Purchase','Cancel duplicate','Keep original','Evidence'],
    plan.cancellations.map(a=>[purchaseCell(orders.get(a.order_id)),orderButton(a.order_id,'cancelled'),orderButton(a.duplicate_of),citations(a)]),
    plan.cancellations.map(a=>`class="sel" tabindex="0" data-key="order:${escape(a.order_id)}" aria-selected="false"`));
}

/* ---------- Evidence ---------- */

function fileKey(name) { return `${state.incident.id}:${name}`; }
function fileData(name) { return state.files.get(fileKey(name))?.data || null; }

function ensureFile(name) {
  const key = fileKey(name), incident = state.incident.id;
  if (!state.files.has(key)) {
    const entry = {data: null};
    entry.promise = (async () => {
      const lines = []; let start = 1, total = 0, pages = 0;
      while (start && pages < MAX_PAGES) {
        const page = await api(`/api/incidents/${encodeURIComponent(incident)}/artifacts/${encodeURIComponent(name)}?start_line=${start}&max_lines=${PAGE}`);
        lines.push(...page.lines); total = page.total_lines; start = page.next_line; pages += 1;
      }
      entry.data = {lines, total, truncated: !!start};
      return entry.data;
    })();
    entry.promise.catch(() => state.files.delete(key));
    state.files.set(key, entry);
  }
  return state.files.get(key).promise;
}

function citedRefs() {
  const cited = new Map();
  for (const action of state.run?.plan?.cancellations || []) {
    for (const ref of action.evidence_refs) {
      if (!cited.has(ref)) cited.set(ref, []);
      cited.get(ref).push(action.order_id);
    }
  }
  return cited;
}

// Tints JSON keys and strings for readability; every character of the evidence is kept.
function tint(raw) {
  const pattern = /"(?:[^"\\]|\\.)*"(\s*:)?/g;
  let out = '', last = 0, match;
  while ((match = pattern.exec(raw))) {
    out += escape(raw.slice(last, match.index)) + `<span class="${match[1]?'tok-key':'tok-str'}">${escape(match[0])}</span>`;
    last = pattern.lastIndex;
  }
  return out + escape(raw.slice(last));
}

function highlight(raw, query) {
  const lower = raw.toLowerCase(), q = query.toLowerCase();
  let out = '', last = 0, at = lower.indexOf(q);
  while (q && at !== -1) { out += escape(raw.slice(last, at)) + `<mark>${escape(raw.slice(at, at + q.length))}</mark>`; last = at + q.length; at = lower.indexOf(q, last); }
  return out + escape(raw.slice(last));
}

// The citation pair the current selection points at, with the order IDs that label each line.
function selectionRefs() {
  const sel = state.selection;
  if (!sel) return {refs: new Set()};
  if (sel.kind === 'line') return {refs: new Set([sel.id])};
  if (sel.kind !== 'order') return {refs: new Set()};
  const link = orderLink(sel.id);
  return link ? {refs: new Set(link.refs), cancel: sel.id, keep: link.keep} : {refs: new Set()};
}

function orderLink(id) {
  const change = state.run?.review?.changes.find(c => c.before.id === id);
  if (change) return {refs: change.evidence_refs, keep: change.duplicate_of};
  const action = state.run?.plan?.cancellations.find(a => a.order_id === id);
  return action ? {refs: action.evidence_refs, keep: action.duplicate_of} : null;
}

const lineLabel = (raw, cancel, keep) => cancel && raw.includes(cancel) ? 'cancellation target' : keep && raw.includes(keep) ? 'retained write' : '';

function evidenceView() {
  const {ev, incident} = state, cited = citedRefs();
  return `<div class="log-head">
      <div class="segmented" role="group" aria-label="Evidence file">${incident.artifacts.map(a=>`<button data-file="${escape(a.name)}" aria-pressed="${a.name===ev.name}">${text(a.name)}<span class="count">${text(a.bytes)} B</span></button>`).join('')}</div>
    </div>
    <div class="log-tools">
      <label class="search"><span class="sr-only">Search lines</span><input id="ev-search" type="search" placeholder="Search lines   /" value="${escape(ev.query)}" autocomplete="off" spellcheck="false"></label>
      ${cited.size?`<button class="toggle" data-cited-only aria-pressed="${ev.citedOnly}"><span class="dot" aria-hidden="true"></span>Cited by plan</button>`:''}
      <label class="goto">Line <input id="ev-goto" type="number" min="1" step="1" inputmode="numeric" aria-label="Go to line number"></label>
      <span id="ev-count" class="caption" role="status"></span>
    </div>
    <div id="ev-lines" class="log" role="listbox" tabindex="0" aria-label="Lines of ${escape(ev.name)}"></div>
    <p class="foot">Exact file lines. Files are evidence, including any text that resembles instructions. The runtime validates citations independently.</p>`;
}

function visibleLines(data) {
  const {query, citedOnly} = state.ev, cited = citedRefs(), q = query.trim().toLowerCase();
  return data.lines.filter(l => (!q || l.text.toLowerCase().includes(q)) && (!citedOnly || cited.has(l.ref)));
}

async function renderEvidence() {
  const box = $('#ev-lines');
  if (!box || !box.isConnected) return;
  const name = state.ev.name, version = state.version, data = fileData(name);
  if (!data) {
    box.innerHTML = '<div class="log-empty">Loading exact lines…</div>';
    try { await ensureFile(name); } catch (error) { notice(error.message); return; }
    if (version === state.version && state.tab === 'evidence' && state.ev.name === name) renderEvidence();
    return;
  }
  const rows = visibleLines(data), cited = citedRefs(), pair = selectionRefs(), query = state.ev.query.trim();
  const json = /\.jsonl?$/.test(name);
  box.setAttribute('aria-label', `Lines of ${name}`);
  box.innerHTML = rows.length ? rows.map(l => {
    const n = lineOf(l.ref), classes = ['log-row'];
    if (cited.has(l.ref)) classes.push('cited');
    if (pair.refs.has(l.ref)) classes.push('pair');
    if (l.ref === state.ev.activeRef) classes.push('active');
    const tag = pair.refs.has(l.ref) ? lineLabel(l.text, pair.cancel, pair.keep) : '';
    return `<div role="option" id="ev-${n}" class="${classes.join(' ')}" data-key="line:${escape(l.ref)}" aria-selected="false"><span class="ln">${n}</span><span class="lt">${query?highlight(l.text, query):json?tint(l.text):text(l.text)}</span>${tag?`<span class="line-tag">${text(tag)}</span>`:''}</div>`;
  }).join('') : `<div class="log-empty">No lines match${query?` “${text(query)}”`:''}${state.ev.citedOnly?' among cited lines':''}.</div>`;
  $('#ev-count').textContent = `${rows.length} of ${data.total} lines${data.truncated ? ' · first 10,000 loaded' : ''}`;
  const active = state.ev.activeRef && document.getElementById(`ev-${lineOf(state.ev.activeRef)}`);
  if (active) {
    box.setAttribute('aria-activedescendant', active.id);
    const top = active.offsetTop, bottom = top + active.offsetHeight;
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  } else box.removeAttribute('aria-activedescendant');
  markSelection();
}

function moveActive(step, edge = null) {
  const data = fileData(state.ev.name); if (!data) return;
  const rows = visibleLines(data); if (!rows.length) return;
  let index = rows.findIndex(l => l.ref === state.ev.activeRef);
  if (edge === 'start') index = 0; else if (edge === 'end') index = rows.length - 1;
  else index = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step));
  state.ev.activeRef = rows[index].ref;
  renderEvidence();
}

function openInEvidence(ref, query = '', name = null) {
  Object.assign(state.ev, {name: name || (ref ? fileOf(ref) : state.ev.name), query, citedOnly: false, activeRef: ref || null});
  setTab('evidence');
  const settle = () => { const box = $('#ev-lines'); if (box) box.focus({preventScroll: true}); };
  ensureFile(state.ev.name).then(() => { if (state.tab === 'evidence') { renderEvidence(); settle(); } }).catch(error => notice(error.message));
}

function gotoLine() {
  const input = $('#ev-goto'), data = fileData(state.ev.name), n = Number(input?.value);
  if (!data) return;
  if (!Number.isInteger(n) || n < 1 || n > data.total) { $('#ev-count').textContent = `Choose a line from 1 to ${data.total}`; return; }
  const ref = `${state.ev.name}:L${n}`;
  if (!visibleLines(data).some(l => l.ref === ref)) Object.assign(state.ev, {query: '', citedOnly: false});
  state.ev.activeRef = ref;
  renderPanel();
  select(`line:${ref}`, {keepFocus: true});
  $('#ev-lines').focus({preventScroll: true});
}

/* ---------- Changes (review) ---------- */

function changesView() {
  const run = state.run;
  if (!run) return emptyState('No changes yet', 'Start the offline investigation, then rehearse its proposal on a disposable copy.');
  if (!run.review) return emptyState(run.status === 'stopped' ? 'No repair was proposed' : 'Not rehearsed yet',
    run.status === 'stopped' ? 'The investigation stopped because evidence is missing. Nothing was changed.' : 'Rehearse the proposal on a disposable copy to see field-level changes.');
  return reviewView();
}

function reviewView() {
  const run = state.run, review = run.review;
  return `${reviewSummary(run, review)}${diffView(review)}${artifactsView(run)}`;
}

function reviewSummary(run, review) {
  const ready = run.status === 'ready_for_review';
  const passed = review.checks.filter(c => c.passed).length;
  const source = review.checks.find(c => c.name === 'source_snapshot_unchanged');
  const failed = review.checks.filter(c => !c.passed);
  return `<div class="section-heading"><h2>${ready?'Rehearsed. Ready for your review.':'Export unavailable'}</h2>${badge(ready?'Rehearsal snapshot':statusOf(run)[0],!ready)}</div>
    <div class="callout ${ready?'success':'stop'}">${text(run.summary)}</div>
    <div class="metrics four">${metric(`${review.before_active} → ${review.after_active}`,'active records')}${metric(review.cancellations,'duplicate orders cancelled')}${metric(`${review.checkout_preserved} / ${review.checkout_total}`,'later checkout purchases intact')}${metric(`${passed} / ${review.checks.length}`,'independent checks passed')}</div>
    <ul class="assurance" aria-label="Rehearsal observations">
      ${run.status==='blocked'?'<li class="fail">Export is blocked; see the reason above</li>':source?`<li class="${source.passed?'':'fail'}">${source.passed?'At rehearsal: source matched the snapshot':'At rehearsal: source differed from the snapshot'}</li>`:''}
      <li>At rehearsal: ${text(review.untargeted_preserved)} untargeted records matched the source</li>
    </ul>
    <p class="small muted">Counts, changes and checks describe the rehearsal snapshot. Export status is shown above and rechecked on every download.</p>
    ${failed.length?`<div class="failed"><h3>Failed checks at rehearsal</h3><ul>${failed.map(c=>`<li><span class="group">${text(groupOf(c.name))}</span><strong>${text(c.name.replaceAll('_',' '))}</strong><div class="check-detail">${text(c.detail)}</div></li>`).join('')}</ul></div>`:''}`;
}

function diffView(review) {
  const skus = [...new Set(review.changes.map(c => c.before.sku))].sort();
  const stockChanged = review.stock.filter(p => p.after !== p.before);
  const later = laterIds(review);
  const checkout = review.preserved_orders.filter(o => later.has(o.id)), others = review.preserved_orders.filter(o => !later.has(o.id));
  const byProduct = new Map();
  for (const change of review.changes) {
    const entry = byProduct.get(change.before.sku) || {orders: 0, units: 0};
    entry.orders += 1; entry.units += change.before.quantity;
    byProduct.set(change.before.sku, entry);
  }
  return `<section class="diff" aria-labelledby="diff-title">
    <div class="diff-head"><div><span class="eyebrow">Rehearsal diff</span><h3 id="diff-title">Source snapshot → disposable copy</h3></div>
      <div class="diff-counts"><span class="mod">~${review.changes.length} orders</span><span class="mod">~${stockChanged.length} products</span><span class="same">=${review.preserved_orders.length} orders unchanged</span></div></div>
    <div class="diff-tools">
      <label class="search"><span class="sr-only">Search changed records</span><input id="change-search" type="search" placeholder="Search order, customer or product   /" value="${escape(state.changeQuery)}" autocomplete="off" spellcheck="false"></label>
      <label class="filter">Product <select id="change-filter"><option value="">All (${review.changes.length})</option>${skus.map(sku=>`<option value="${escape(sku)}" ${sku===state.filter?'selected':''}>${text(sku)} (${review.changes.filter(c=>c.before.sku===sku).length})</option>`).join('')}</select></label>
    </div>
    <div class="group-head"><h4>orders</h4><span class="caption">Only <span class="mono">status</span> changes. Original rows and sale movements are kept; cancellations add compensating stock entries.</span></div>
    <div id="change-table">${changesTable(review.changes)}</div>
    <div class="group-head"><h4>products</h4><span class="caption"><span class="mono">on_hand</span> before and after rehearsal</span></div>
    ${table(['','Product','on_hand','Change','From cancellations'],review.stock.map(p=>{
      const delta = p.after - p.before, entry = byProduct.get(p.sku);
      return [`<span class="sym ${delta?'mod':'same'}">${delta?'~':'='}</span>`,`${text(p.name)} <span class="mono faint">${text(p.sku)}</span>`,`<span class="before num">${text(p.before)}</span> → <span class="after num">${text(p.after)}</span>`,`<span class="${delta>0?'positive':delta<0?'cancelled':''} num">${delta>0?'+':''}${text(delta)}</span>`,entry?`${entry.orders} orders · +${entry.units} units`:'—'];
    }),review.stock.map(p=>`class="sel" tabindex="0" data-key="product:${escape(p.sku)}" aria-selected="false"`))}
    <div class="group-head"><h4>preserved work</h4><span class="caption">Later purchases in this synthetic case. At rehearsal, ${text(review.checkout_preserved)} of ${text(review.checkout_total)} remained unchanged.</span></div>
    ${orderTable(checkout)}
    <details class="fold"><summary>Other untouched records · ${others.length}</summary>${orderTable(others)}</details>
  </section>`;
}

function changesTable(changes) {
  const q = state.changeQuery.trim().toLowerCase();
  const rows = changes.filter(c => (!state.filter || c.before.sku === state.filter) &&
    (!q || [c.before.id, c.before.customer, c.before.sku, c.duplicate_of].some(v => String(v).toLowerCase().includes(q))));
  if (!rows.length) return `<div class="log-empty">No changed records match.</div>`;
  return table(['Purchase','Cancelled order','Status on copy','Keeps original','Evidence'],rows.map(c=>{
    const changed = Object.keys(c.before).filter(k => c.before[k] !== c.after[k]);
    return [purchaseCell(c.before),`<span class="sym mod" title="${escape(changed.join(', '))} changed">~</span> ${orderButton(c.before.id,'cancelled')}`,`<span class="before">${text(c.before.status)}</span> → <span class="after">${text(c.after.status)}</span>`,orderButton(c.duplicate_of),citations({order_id:c.before.id,evidence_refs:c.evidence_refs})];
  }),rows.map(c=>`class="sel" tabindex="0" data-key="order:${escape(c.before.id)}" aria-selected="false"`));
}

function artifactsView(run) {
  const check = state.exportChecks.get(run.id);
  return `<section class="artifacts" id="repair-package" tabindex="-1"><h3>Review artifacts</h3>
    <p class="small muted">Each download rechecks source, evidence and candidate freshness. Guarded SQL also rejects changed table state when applied. Human review is required.${check?` Last check: ${check.ok?'passed':'refused'} at ${time(check.at)}.`:''}</p>
    <div class="download-row">${run.downloads.map(name=>`<button class="download" data-download="${escape(name)}"><strong>↓ ${text(name)}</strong><span>${text(DOWNLOAD_NOTES[name]||'')}</span></button>`).join('')||'<span class="caption">No artifacts available for export.</span>'}</div>
    <p class="caption">Source database untouched.</p></section>`;
}

/* ---------- Checks ---------- */

function exportStatus(run) {
  const check = state.exportChecks.get(run.id);
  if (run.status === 'ready_for_review') {
    if (state.rechecking === run.id) return {label: 'Rechecking current files…', tone: '', detail: 'The server is checking source, evidence and candidate freshness.'};
    if (check?.ok) return {label: 'Freshness check passed', tone: 'ok', detail: `Verified at ${time(check.at)} for ${check.artifact}. Every export is checked again.`};
    if (check && !check.ok) return {label: 'Refused', tone: 'warn', detail: check.message};
    return {label: 'Passed at rehearsal · Recheck required', tone: 'warn', detail: 'Current source, evidence and candidate freshness has not been rechecked. Recheck before export.'};
  }
  if (run.status === 'blocked') return {label: 'Refused', tone: 'warn', detail: `${run.summary}${check && !check.ok ? ` Checked at ${time(check.at)}.` : ''}`};
  if (run.status === 'failed_checks') return {label: 'Unavailable', tone: 'danger', detail: 'Operational checks failed at rehearsal, so nothing can be exported.'};
  return {label: statusOf(run)[0], tone: '', detail: run.summary};
}

function checksTab() {
  const run = state.run, review = run?.review;
  if (!review) return emptyState(run?.status === 'stopped' ? 'No checks ran' : 'Not rehearsed yet',
    run?.status === 'stopped' ? 'The investigation stopped before any repair, so there was nothing to check.' : 'Independent checks run when a proposal is rehearsed on a disposable copy.');
  const passed = review.checks.filter(c => c.passed).length, meta = state.runMeta.get(run.id) || {}, exp = exportStatus(run);
  return `<div class="section-heading"><h2>Independent operational checks</h2>${badge(`${passed} / ${review.checks.length} passed`,!review.passed)}</div>
    <div class="status-cards">
      <div class="status-card ${review.passed?'ok':'danger'}"><span class="eyebrow">At rehearsal</span><strong>${passed} / ${review.checks.length} checks passed</strong><span class="caption">Observed on the rehearsal snapshot${meta.rehearsedAt?` · result received ${time(meta.rehearsedAt)} on this page`:''}</span></div>
      <div class="status-card ${exp.tone}"><span class="eyebrow">Export freshness</span><strong>${text(exp.label)}</strong><span class="caption">${text(exp.detail)}</span>${run.status==='ready_for_review'?`<button class="secondary" data-recheck-export ${state.rechecking===run.id?'disabled':''}>${state.rechecking===run.id?'Rechecking…':'Recheck for export'}</button>`:''}</div>
    </div>
    <p class="small muted">These checks describe the rehearsal snapshot. Export status is shown above and rechecked on every download.</p>
    ${checksView(review.checks)}`;
}

function checksView(checks) {
  const known = new Set(CHECK_GROUPS.flatMap(([, names]) => names));
  const groups = [...CHECK_GROUPS.map(([label, names]) => [label, checks.filter(c => names.includes(c.name))]),
    ['Other checks', checks.filter(c => !known.has(c.name))]].filter(([, list]) => list.length);
  return `<div class="check-groups">${groups.map(([label, list]) => {
    const ok = list.filter(c => c.passed).length;
    return `<div class="check-group ${ok<list.length?'has-fail':''}"><div class="check-group-head"><h4>${text(label)}</h4><span class="caption">${ok} / ${list.length} passed</span></div>
      <ul class="checks">${list.map(c=>`<li class="sel ${c.passed?'':'fail'}" tabindex="0" data-key="check:${escape(c.name)}" aria-selected="false"><span class="check-icon ${c.passed?'':'cancelled'}" aria-hidden="true">${c.passed?'✓':'×'}</span><div><strong>${text(c.name.replaceAll('_',' '))}</strong><span class="sr-only"> ${c.passed?'passed':'failed'}</span><div class="check-detail">${text(c.detail)}</div></div></li>`).join('')}</ul></div>`;
  }).join('')}</div>`;
}

/* ---------- SQL ---------- */

function sqlTint(line) {
  if (line.trimStart().startsWith('--')) return `<span class="tok-comment">${escape(line)}</span>`;
  return escape(line).replace(SQL_WORDS, '<span class="tok-kw">$1</span>').replace(/&#39;(.*?)&#39;/g, '<span class="tok-str">&#39;$1&#39;</span>');
}

function sqlView() {
  const run = state.run;
  if (!run?.review) return emptyState('No SQL yet', run?.status === 'stopped' ? 'The investigation stopped, so no repair script was generated.' : 'Rehearse a proposal on a disposable copy to generate the guarded script.');
  if (run.status !== 'ready_for_review') return `<div class="section-heading"><h2>Export unavailable</h2>${badge(statusOf(run)[0], true)}</div>
    <div class="callout stop">${text(run.summary)}</div>
    <p class="small muted">The server only serves SQL for a current, passing rehearsal. Every request rechecks source and evidence first.</p>`;
  const entry = state.sql.get(run.id) || {status: 'loading'};
  const body = entry.status === 'ok'
    ? `<div class="code" role="region" aria-label="repair.sql, read-only" tabindex="0">${entry.text.replace(/\r?\n$/, '').split(/\r?\n/).map((l,i)=>`<div class="code-line"><span class="ln">${i+1}</span><span class="lt">${sqlTint(l)}</span></div>`).join('')}</div>`
    : entry.status === 'error' ? `<div class="callout stop">${text(entry.message)}</div>` : '<div class="log-empty">Rechecking freshness and loading repair.sql…</div>';
  return `<div class="sql-head"><div><span class="eyebrow">repair.sql · read-only</span><h2>Guarded repair script</h2></div>
      <div class="sql-actions"><button class="secondary" data-copy-sql ${entry.status!=='ok'?'disabled':''}>Copy</button><button class="secondary" data-reload-sql>Recheck and reload</button><button class="secondary" data-download="repair.sql">↓ Download</button></div></div>
    <p class="small muted">Not applied by this workbench. Loaded through the freshness-gated download route${entry.at?` at ${time(entry.at)}`:''}. The script uses <span class="mono">BEGIN IMMEDIATE</span> and rolls back if table state differs from the rehearsal. Human review is required.</p>
    ${body}`;
}

function maybeLoadSql() {
  const run = state.run;
  if (run?.status === 'ready_for_review' && !state.sql.has(run.id)) loadSql();
}

async function loadSql() {
  const runId = state.run.id;
  state.sql.set(runId, {status: 'loading'});
  if (state.tab === 'sql') renderPanel();
  try {
    const response = await fetchArtifact('repair.sql');
    state.sql.set(runId, {status: 'ok', text: await response.text(), at: new Date()});
  } catch (error) {
    state.sql.set(runId, {status: 'error', message: error.message});
    notice(error.message);
  }
  if (state.run?.id === runId) render();
}

/* ---------- Context panel ---------- */

function fieldTable(before, after) {
  const keys = Object.keys(before);
  if (!after) return `<table class="fields"><tbody>${keys.map(k=>`<tr><th scope="row">${text(k)}</th><td class="mono">${text(before[k] ?? 'NULL')}</td></tr>`).join('')}</tbody></table>`;
  return `<table class="fields diffs"><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${keys.map(k=>{
    const changed = before[k] !== after[k];
    if (!changed) return `<tr><th scope="row">${text(k)}</th><td class="mono same" colspan="2">${text(before[k] ?? 'NULL')}<span class="sr-only"> unchanged</span></td></tr>`;
    return `<tr class="changed"><th scope="row">${text(k)}<span class="sr-only"> changed</span></th><td class="mono before">${text(before[k] ?? 'NULL')}</td><td class="mono after">${text(after[k] ?? 'NULL')}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function citeBlock(ref, cancel, keep, focus) {
  const data = fileData(fileOf(ref)), line = data?.lines.find(l => l.ref === ref);
  if (!data) ensureFile(fileOf(ref)).then(() => renderContext()).catch(error => notice(error.message));
  const label = line ? lineLabel(line.text, cancel, keep) : '';
  return `<div class="cite ${ref===focus?'focus':''}"><div class="cite-head"><button class="citation" data-open-ref="${escape(ref)}" title="Open in Evidence">${text(ref)}</button>${label?`<span class="line-tag">${text(label)}</span>`:''}</div>
    <pre class="cite-line">${line?tint(line.text):data?'Line not found in the loaded evidence.':'Loading exact line…'}</pre></div>`;
}

function orderContext(id, focusRef) {
  const review = state.run?.review;
  const change = review?.changes.find(c => c.before.id === id);
  const planned = !change && state.run?.plan?.cancellations.find(a => a.order_id === id);
  const record = change?.before || ordersById().get(id) || review?.preserved_orders.find(o => o.id === id);
  if (!record) return `<p class="muted">This record is not in the selected incident.</p>`;
  let html = `<h2 class="mono ctx-title">${text(id)}</h2><p class="small muted">${purchase(record)}</p><button class="link small" data-copy-value="${escape(id)}" aria-label="Copy full order ID">Copy full ID</button>`;
  if (change) html += `<div class="ctx-status">${badge('Changed on the copy', true)}<span class="caption">Engine before/after at rehearsal</span></div>${fieldTable(change.before, change.after)}`;
  else if (planned) html += `<div class="ctx-status">${badge('Proposed cancellation')}<span class="caption">Not rehearsed yet · current source values</span></div>${fieldTable(record)}`;
  else if (review) html += `<div class="ctx-status">${badge('Unchanged at rehearsal', 'ok')}${laterIds(review).has(id)?badge('Later purchase'):''}</div>${fieldTable(record)}`;
  else html += `<div class="ctx-status">${badge('Source record')}</div>${fieldTable(record)}`;
  const link = change ? {refs: change.evidence_refs, keep: change.duplicate_of} : planned ? {refs: planned.evidence_refs, keep: planned.duplicate_of} : null;
  if (link) {
    html += `<div class="ctx-keep"><h3>Retained purchase</h3><button class="link mono" data-key="order:${escape(link.keep)}">${text(link.keep)}</button><p>${purchase(ordersById().get(link.keep))}</p></div>`;
    html += `<h3>Supporting evidence</h3>${link.refs.map(ref => citeBlock(ref, id, link.keep, focusRef)).join('')}`;
  }
  const citedBy = (state.run?.plan?.cancellations || []).filter(a => a.duplicate_of === id);
  if (citedBy.length) html += `<h3>Retained for</h3><div class="id-grid">${citedBy.map(a=>`<button class="id-chip mono" data-key="order:${escape(a.order_id)}">${text(a.order_id)}</button>`).join('')}</div>`;
  return html;
}

function productContext(sku) {
  const review = state.run?.review, row = review?.stock.find(p => p.sku === sku);
  if (!row) return `<p class="muted">No rehearsal data for this product.</p>`;
  const changes = review.changes.filter(c => c.before.sku === sku);
  return `<h2 class="ctx-title">${text(row.name)} <span class="mono faint">${text(sku)}</span></h2>
    <div class="ctx-status">${badge(row.after !== row.before ? 'Changed on the copy' : 'Unchanged', row.after !== row.before)}<span class="caption">Engine before/after at rehearsal</span></div>
    ${fieldTable({sku, name: row.name, on_hand: row.before}, {sku, name: row.name, on_hand: row.after})}
    ${changes.length?`<h3>From ${changes.length} cancellations</h3><div class="id-grid">${changes.map(c=>`<button class="id-chip mono" data-key="order:${escape(c.before.id)}">${text(c.before.id)} · +${text(c.before.quantity)}</button>`).join('')}</div>`:''}`;
}

function checkContext(name) {
  const check = state.run?.review?.checks.find(c => c.name === name);
  if (!check) return `<p class="muted">This check is not in the current review.</p>`;
  return `<h2 class="ctx-title">${text(name.replaceAll('_', ' '))}</h2>
    <div class="ctx-status">${badge(check.passed ? 'Passed' : 'Failed', check.passed ? 'ok' : 'danger')}<span class="caption">${text(groupOf(name))} · observed at rehearsal</span></div>
    <p class="small">${text(check.detail)}</p><p class="caption mono">${text(name)}</p>
    <p class="small muted">Checks run on the rehearsal snapshot and cannot be edited by the plan. Export status is rechecked separately on every download.</p>`;
}

function lineContext(ref) {
  const data = fileData(fileOf(ref)), line = data?.lines.find(l => l.ref === ref);
  if (!data) ensureFile(fileOf(ref)).then(() => renderContext()).catch(error => notice(error.message));
  let fields = '';
  try { const parsed = line && JSON.parse(line.text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = `<h3>Fields</h3>${fieldTable(parsed)}`; } catch (_) { /* not JSON */ }
  const citedBy = citedRefs().get(ref) || [];
  return `<h2 class="mono ctx-title">${text(ref)}</h2><div class="ctx-status">${badge('Exact evidence line')}${citedBy.length?badge(`Cited by ${citedBy.length}`, 'ok'):''}</div>
    <pre class="cite-line">${line?tint(line.text):'Loading exact line…'}</pre>${fields}
    ${citedBy.length?`<h3>Cited for cancelling</h3><div class="id-grid">${citedBy.map(id=>`<button class="id-chip mono" data-key="order:${escape(id)}">${text(id)}</button>`).join('')}</div>`:''}
    ${state.tab!=='evidence'?`<button class="secondary" data-open-ref="${escape(ref)}">Open in Evidence</button>`:''}`;
}

function eventContext(id) {
  const data = fileData('source_orders.json');
  if (!data) ensureFile('source_orders.json').then(() => renderContext()).catch(error => notice(error.message));
  const hits = data ? data.lines.filter(l => l.text.includes(id)) : [];
  return `<h2 class="mono ctx-title">${text(id)}</h2><div class="ctx-status">${badge('No commit evidence', true)}</div>
    <p class="small">This imported source event has no committed-write record linking it to an order ID, so the script stopped instead of guessing.</p>
    ${data?(hits.length?`<h3>In source_orders.json</h3>${hits.map(l=>`<div class="cite"><div class="cite-head"><button class="citation" data-open-ref="${escape(l.ref)}">${text(l.ref)}</button></div><pre class="cite-line">${tint(l.text)}</pre></div>`).join('')}`:'<p class="small muted">Not found in source_orders.json.</p>'):'<p class="small muted">Loading source_orders.json…</p>'}
    <button class="secondary" data-search-event="${escape(id)}">Search events.jsonl for this event</button>`;
}

function renderContext() {
  const box = $('#context'), sel = state.selection;
  const open = !!sel && !!state.incident && (!isNarrow() || state.sheet);
  box.hidden = !open;
  box.classList.toggle('open', open);
  $('.workspace').classList.toggle('has-context', open);
  if (!open) {
    box.innerHTML = '';
    return;
  }
  const kinds = {order: ['Record', orderContext], product: ['Product', productContext], check: ['Check', checkContext], line: ['Evidence line', lineContext], event: ['Missing evidence', eventContext]};
  const [label, view] = kinds[sel.kind] || ['Details', () => ''];
  box.innerHTML = `<div class="ctx-head"><span class="eyebrow">${label}</span><button class="icon-button" data-close-context aria-label="Close details">×</button></div><div class="ctx-body">${view(sel.id, sel.focusRef)}</div>`;
}

function select(key, {focusRef = null, keepFocus = false} = {}) {
  const at = key.indexOf(':'), kind = key.slice(0, at), id = key.slice(at + 1);
  if (!keepFocus) state.lastFocus = document.activeElement;
  state.selection = {kind, id, focusRef};
  state.sheet = true;
  if (kind === 'line') state.ev.activeRef = id;
  if (state.tab === 'evidence') renderEvidence(); else markSelection();
  renderContext();
  if (isNarrow() && !keepFocus) $('#context').focus();
}

function closeContext() {
  state.selection = null; state.sheet = false;
  renderContext(); markSelection();
  if (state.tab === 'evidence') renderEvidence();
  if (state.lastFocus?.isConnected) state.lastFocus.focus();
}

function markSelection() {
  const sel = state.selection, key = sel ? `${sel.kind}:${sel.id}` : null;
  document.querySelectorAll('#content [data-key]').forEach(el => {
    const on = el.dataset.key === key;
    if (el.hasAttribute('aria-selected')) el.setAttribute('aria-selected', String(on));
    el.classList.toggle('selected', on);
  });
}

/* ---------- Actions ---------- */

async function act(action) {
  if (state.busy) return;
  const id = state.incident.id;
  state.busy = true; notice(); render();
  try {
    const path = action === 'investigate' ? `/api/incidents/${id}/investigate` : `/api/runs/${state.run.id}/rehearse`;
    const run = await api(path, true);
    state.runs.set(id, run);
    upsertHistory(run);
    if (action === 'rehearse') {
      state.runMeta.set(run.id, {rehearsedAt: new Date()});
      state.exportChecks.delete(run.id); state.sql.delete(run.id);
    }
    if (state.incident.id === id) {
      Object.assign(state, {run, filter: '', changeQuery: ''});
      if (action === 'investigate') Object.assign(state, {selection: null, tab: 'investigation'});
      else state.tab = run.review ? 'changes' : 'investigation';
    }
    if (run.status === 'blocked') notice(run.summary);
  } catch (error) { notice(error.message); }
  finally { state.busy = false; render(); $('#content').focus({preventScroll: true}); }
}

// Every artifact request goes through the server's freshness gate. A delayed failure updates
// only the case and run it was started for, and names that case in the error.
async function fetchArtifact(name) {
  const incidentId = state.incident.id, runId = state.run.id;
  const incidentTitle = state.incident.title || incidentId;
  const response = await fetch(`/api/runs/${runId}/artifacts/${encodeURIComponent(name)}`);
  if (!response.ok) {
    const value = await response.json();
    const updated = await api(`/api/runs/${runId}`);
    state.exportChecks.set(runId, {at: new Date(), ok: false, artifact: name, message: value.error || 'Download blocked.'});
    if (state.runs.get(incidentId)?.id === runId) state.runs.set(incidentId, updated);
    upsertHistory(updated);
    if (state.incident.id === incidentId && state.run?.id === runId) { state.run = updated; render(); }
    else renderCases(); // another case is on screen: refresh only the sidebar status
    throw new Error(`Export check for ${incidentTitle}: ${value.error || 'Download blocked.'}`);
  }
  state.exportChecks.set(runId, {at: new Date(), ok: true, artifact: name});
  return response;
}

async function download(name) {
  const runId = state.run.id;
  const response = await fetchArtifact(name);
  const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
  if (state.run?.id === runId && (state.tab === 'checks' || state.tab === 'changes')) renderPanel();
}

async function copySql(button) {
  const entry = state.sql.get(state.run?.id);
  if (entry?.status !== 'ok') return;
  try { await navigator.clipboard.writeText(entry.text); button.textContent = 'Copied'; }
  catch (_) { button.textContent = 'Copy unavailable'; }
  setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1500);
}

async function copyValue(button, value) {
  try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; }
  catch (_) { button.textContent = 'Copy unavailable'; }
  setTimeout(() => { if (button.isConnected) button.textContent = button.dataset.copyLabel || 'Copy ID'; }, 1500);
}

async function recheckExport() {
  const runId = state.run?.id;
  if (state.run?.status !== 'ready_for_review' || state.rechecking) return;
  state.rechecking = runId;
  state.exportChecks.delete(runId);
  renderPanel();
  try {
    const response = await fetchArtifact('report.json');
    await response.text();
  } catch (error) { notice(error.message); }
  finally {
    if (state.rechecking === runId) state.rechecking = null;
    if (state.run?.id === runId) render();
  }
}

/* ---------- Events ---------- */

document.addEventListener('click', event => {
  const el = event.target.closest('button, [data-key]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  let task;
  if (d.case && d.case !== (state.switching || state.incident?.id)) {
    // The hash gives each case a link and browser back/forward; hashchange performs the switch.
    const hash = `#case=${d.case}`;
    if (location.hash.startsWith(`${hash}&`) || location.hash === hash) task = selectCase(d.case); else location.hash = hash.slice(1);
  }
  if (d.run && d.run !== state.run?.id && !state.busy) task = loadRun(d.run);
  if (d.tab) setTab(d.tab);
  if (d.reviewRepair !== undefined) reviewRepair();
  if (d.reviewDownloads !== undefined) reviewRepair(true);
  if (d.action) task = act(d.action);
  if (d.download) task = download(d.download);
  if (d.file) { Object.assign(state.ev, {name: d.file, activeRef: null}); renderPanel(); }
  if (d.citedOnly !== undefined) { state.ev.citedOnly = !state.ev.citedOnly; el.setAttribute('aria-pressed', String(state.ev.citedOnly)); renderEvidence(); }
  if (d.openRef) openInEvidence(d.openRef);
  if (d.searchEvent) openInEvidence(null, d.searchEvent, 'events.jsonl');
  if (d.closeContext !== undefined) closeContext();
  if (d.copySql !== undefined) task = copySql(el);
  if (d.copyValue !== undefined) { el.dataset.copyLabel ||= el.textContent; task = copyValue(el, d.copyValue); }
  if (d.recheckExport !== undefined) task = recheckExport();
  if (d.reloadSql !== undefined) task = loadSql();
  if (d.key) select(d.key, {focusRef: d.focusRef || null});
  if (task) task.catch(error => notice(error.message));
});

document.addEventListener('keydown', event => {
  const t = event.target, key = event.key;
  if (t.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
    event.preventDefault();
    const index = TABS.indexOf(state.tab);
    const next = key === 'Home' ? 0 : key === 'End' ? TABS.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next], true);
    return;
  }
  const list = t.closest?.('#cases, #run-card');
  if (list && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
    event.preventDefault();
    const items = [...list.querySelectorAll('.case, .run-item')], index = items.indexOf(t.closest('.case, .run-item'));
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, index + (key === 'ArrowDown' ? 1 : -1)));
    items[next]?.focus();
    return;
  }
  if (t.id === 'ev-lines') {
    const moves = {ArrowDown: 1, ArrowUp: -1, PageDown: 15, PageUp: -15};
    if (key in moves) { event.preventDefault(); moveActive(moves[key]); return; }
    if (key === 'Home' || key === 'End') { event.preventDefault(); moveActive(0, key === 'Home' ? 'start' : 'end'); return; }
    if ((key === 'Enter' || key === ' ') && state.ev.activeRef) { event.preventDefault(); select(`line:${state.ev.activeRef}`, {keepFocus: true}); return; }
  }
  if (t.id === 'ev-goto' && key === 'Enter') { event.preventDefault(); gotoLine(); return; }
  if (t.dataset?.key && t.tagName !== 'BUTTON') {
    if (key === 'Enter' || key === ' ') { event.preventDefault(); select(t.dataset.key); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const items = [...t.parentElement.querySelectorAll(':scope > [data-key]')], index = items.indexOf(t);
      const next = items[index + (key === 'ArrowDown' ? 1 : -1)];
      if (next) { event.preventDefault(); next.focus(); }
      return;
    }
  }
  if (key === '/' && !isTyping(t)) {
    const search = $('#ev-search') || $('#change-search');
    if (search) { event.preventDefault(); search.focus(); search.select(); }
    return;
  }
  if (key === 'Escape' && state.selection && !isTyping(t)) { event.preventDefault(); closeContext(); }
});

document.addEventListener('input', event => {
  if (event.target.id === 'ev-search') { state.ev.query = event.target.value; renderEvidence(); }
  if (event.target.id === 'change-search' && state.run?.review) { state.changeQuery = event.target.value; $('#change-table').innerHTML = changesTable(state.run.review.changes); markSelection(); }
});

document.addEventListener('change', event => {
  if (event.target.id !== 'change-filter' || !state.run?.review) return;
  state.filter = event.target.value;
  $('#change-table').innerHTML = changesTable(state.run.review.changes);
  markSelection();
});

window.addEventListener('hashchange', () => {
  const target = parseHash();
  if (!target) return;
  const shown = state.switching || state.incident?.id;
  if (target.id === shown) { if (target.tab && target.tab !== state.tab) setTab(target.tab); return; }
  if (state.busy) { updateHash(); return; }
  selectCase(target.id, target.tab).catch(error => notice(error.message));
});

api('/api/incidents').then(async data => {
  state.cases = data.incidents;
  // Restore each case's last recorded status from this server session before showing the sidebar.
  await Promise.all(state.cases.map(c => refreshHistory(c.id).catch(() => null)));
  const target = parseHash();
  await selectCase(target?.id || data.incidents[0].id, target?.tab || null);
}).catch(error => notice(error.message));
