'use strict';

// Presentation only. The Python engine owns plans, rehearsal, checks, freshness and exports;
// this file displays what the local API returns and never decides whether a repair is valid.
const $ = (selector) => document.querySelector(selector);
const PAGE = 200;      // server maximum lines per evidence request
const MAX_PAGES = 50;  // bounds one evidence file at 10,000 lines
const TABS = ['investigation', 'evidence', 'changes', 'checks', 'sql'];
const TAB_META = {investigation: ['scan-search', 'Investigation'], evidence: ['file-text', 'Evidence'], changes: ['git-compare', 'Changes'], checks: ['shield-check', 'Checks'], sql: ['database', 'SQL']};
const state = {
  // runs: the full run record shown for each case. history: server run summaries per case, newest first.
  incident: null, run: null, cases: [], runs: new Map(), history: new Map(), views: new Map(),
  tab: 'investigation', busy: false, switching: null, version: 0,
  files: new Map(), ev: {name: 'events.jsonl', query: '', citedOnly: false, activeRef: null},
  // sheet: the narrow-screen details sheet is open (a selection, or the guide). nav: the phone case drawer.
  selection: null, sheet: false, lastFocus: null, filter: '', changeQuery: '', nav: false, guide: false,
  // rechecking: run IDs with an explicit export recheck in flight (one per run, never a global lock).
  runMeta: new Map(), exportChecks: new Map(), sql: new Map(), rechecking: new Set(),
  // Recorded model runs (read-only history). source is per case: 'script' (offline) or 'recorded'.
  // Recording IDs are kept apart from run IDs and never reach rehearse, SQL or download helpers.
  source: 'script', recordings: new Map(), recId: null, recording: null, recSeq: 0, stepFilter: 'all',
  // recDetails: full recordings fetched for the run comparison, keyed by case and recording ID.
  recDetails: new Map(),
  // reconWaiting: cases whose timeline evidence is being read; each case starts and repaints its own.
  reconWaiting: new Set(),
  // sourceChosen: the person picked script or recorded; until then each case opens on its recorded Meta run.
  // replay: {recId, cursor, playing} while the saved steps of the open recording are being replayed.
  // demo: the public read-only demo's dataset defaults and evaluation notes (see staticContract).
  sourceChosen: false, replay: null, demo: null,
};
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = (value) => escape(value);
const badge = (value, tone = '') => `<span class="pill ${tone === true ? 'warn' : tone || ''}">${text(value)}</span>`;
const metric = (value, label) => `<div class="metric"><strong>${text(value)}</strong><span>${text(label)}</span></div>`;
// Lucide icons from the inline sprite in index.html (lucide-static 1.55.0, ISC; notice kept there).
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const skeleton = (lines = 6) => `<div class="skeleton-stack" aria-hidden="true">${'<span class="skeleton"></span>'.repeat(lines)}</div><span class="sr-only">Loading</span>`;
const table = (headers, rows, rowAttrs = []) => `<div class="scroll-table"><table><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row,i)=>`<tr ${rowAttrs[i]||''}>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const pad = (n) => String(n).padStart(2, '0');
const fmtBytes = (n) => !Number.isFinite(n) ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
const time = (d) => d ? d.toLocaleTimeString() : '';

// Labels for run states reported by the server; unknown states are shown as-is.
const RUN_STATUS = {
  proposed: ['Proposal ready', ''],
  stopped: ['Stopped · evidence needed', 'warn'],
  ready_for_review: ['Ready for review', 'ok'],
  failed_checks: ['Checks failed', 'danger'],
  blocked: ['Export blocked', 'warn'],
};
// What the UI may claim about each server-reported mode. An unknown mode is shown as reported,
// with no offline or no-model claim, so a future recorded or live mode cannot be mislabelled.
const MODE_INFO = {
  offline_deterministic_engine_demo_NOT_a_model_run: {
    short: 'Offline demo · No model', long: 'Offline deterministic script · no model',
    method: 'Actual local function calls, without model or API calls. Recorded Meta runs are shown separately as read-only history.',
  },
};
// Display grouping only; unknown check names fall into "Other checks".
const CHECK_GROUPS = [
  ['Database', ['database_integrity']],
  ['Preserved work', ['unaffected_orders_preserved', 'order_history_preserved', 'original_movements_preserved']],
  ['Stock', ['stock_matches_movement_ledger', 'stock_matches_active_orders']],
  ['Source evidence', ['source_evidence_complete', 'source_events_applied_once']],
  ['Files unchanged', ['source_snapshot_unchanged', 'evidence_snapshot_unchanged']],
];
const DOWNLOAD_NOTES = {
  'repair.sql': 'Guarded SQLite script. Rolls back if table state differs.',
  'plan.json': 'Cancellation plan with evidence citations.',
  'report.json': 'Checks, plan and before/after summary counts.',
  'report.html': 'Readable review report.',
};
const SQL_WORDS = /\b(PRAGMA|BEGIN|IMMEDIATE|COMMIT|ROLLBACK|CREATE|TEMP|TABLE|AS|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|AND|OR|NOT|NULL|IS|IN|EXISTS|CASE|WHEN|THEN|ELSE|END|CHECK|INTEGER|ON|DROP|COUNT|UNION|ALL|EXCEPT|LIMIT)\b/g;

// A thin top progress bar while any local request is in flight (CSS delays it so quick requests never flash).
let loadingCount = 0;
function setLoading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  const bar = $('#progress');
  if (bar) bar.hidden = loadingCount === 0;
}

/* ---------- Public read-only demo (RR_STATIC_DEMO_V1) ---------- */

// A generated public copy of index.html carries <html data-demo-mode="read-only">. The page then reads
// ./demo-data.json once, refuses it unless it is schema version 1, read-only and turns every capability off,
// and answers each GET from it by exact path. Nothing reaches an API and nothing falls back to one. Without
// the attribute (the local workbench) startup is unchanged. RR_STATIC_DEMO_V1 marks this adapter.
const STATIC_DEMO = document.documentElement?.dataset?.demoMode === 'read-only';
const STATIC_LABEL = 'Recorded demo · No live API calls';
const STATIC_CAPABILITIES = ['investigate', 'rehearse', 'export', 'live_model'];
const READ_ONLY_NOTE = 'This recorded demo is read-only: it cannot investigate, test on a copy, check files, copy SQL or export.';
const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, key) => plainObject(o) && Object.prototype.hasOwnProperty.call(o, key);
const copyJson = (v) => JSON.parse(JSON.stringify(v));
const demoError = (message, status) => Object.assign(new Error(message), {status, demo: true});
let staticData = null;

function checkStaticData(d) {
  const refuse = (why) => { throw demoError(`The recorded demo data was refused: ${why}`, 0); };
  if (!plainObject(d)) refuse('it is not a JSON object.');
  if (d.schema_version !== 1) refuse('only schema version 1 is supported.');
  if (d.read_only !== true) refuse('it is not marked read-only.');
  const caps = d.capabilities;
  if (!plainObject(caps) || STATIC_CAPABILITIES.some(k => caps[k] !== false) || Object.values(caps).some(v => v !== false))
    refuse('it must turn off investigation, testing, export and live model calls.');
  const index = plainObject(d.api_get) ? d.api_get['/api/incidents'] : null;
  if (!plainObject(index) || !Array.isArray(index.incidents) || !index.incidents.length || !plainObject(d.artifacts))
    refuse('its recorded responses are missing.');
  return d;
}

// Fetched at most once. A refusal is kept too, so a missing or invalid dataset is never retried elsewhere.
function staticDataset() {
  staticData ||= (async () => {
    let response, value;
    try { response = await fetch('./demo-data.json'); } catch (_) { throw demoError('The recorded demo data could not be read.', 0); }
    if (!response.ok) throw demoError(`The recorded demo data is missing (HTTP ${response.status}).`, response.status);
    try { value = await response.json(); } catch (_) { throw demoError('The recorded demo data is not valid JSON.', 0); }
    return checkStaticData(value);
  })();
  return staticData;
}

const STATIC_PAGE = /^\/api\/incidents\/([^/?#]+)\/artifacts\/([^/?#]+)\?([^#]*)$/;
async function staticGet(path) {
  const d = await staticDataset(), page = STATIC_PAGE.exec(path);
  if (page) return staticPage(d, page[1], page[2], page[3]);
  if (!own(d.api_get, path)) throw demoError('Not part of the recorded demo.', 404);
  return copyJson(d.api_get[path]);
}

// Evidence pages keep the local server's shape and bounds: start_line from 1, max_lines 1 to 200, and
// next_line or null. Unknown cases, files or arguments fail.
function staticPage(d, rawCase, rawName, query) {
  let caseId, name;
  try { caseId = decodeURIComponent(rawCase); name = decodeURIComponent(rawName); } catch (_) { throw demoError('Not part of the recorded demo.', 404); }
  const file = own(d.artifacts, caseId) && own(d.artifacts[caseId], name) ? d.artifacts[caseId][name] : null;
  if (!plainObject(file) || !Array.isArray(file.lines) || file.total_lines !== file.lines.length) throw demoError('Not part of the recorded demo.', 404);
  const args = {};
  for (const part of query.split('&')) {
    const [key, value, extra] = part.split('=');
    if (extra !== undefined || !['start_line', 'max_lines'].includes(key) || own(args, key) || !/^[1-9]\d{0,6}$/.test(value || ''))
      throw demoError('Unknown, repeated or invalid evidence pagination argument.', 400);
    args[key] = Number(value);
  }
  const start = args.start_line ?? 1, max = args.max_lines ?? 80;
  if (max > 200) throw demoError('max_lines must be from 1 to 200.', 400);
  const lines = file.lines.slice(start - 1, start - 1 + max);
  return {name, total_lines: file.total_lines, lines: copyJson(lines), next_line: start - 1 + lines.length < file.total_lines ? start + lines.length : null};
}

// Read-only history: everything in the public demo, and any run the server marks read_only (a recorded
// offline baseline). Its status is as recorded; it grants no new investigation, test, file check, SQL or export.
const historicalRun = (run) => STATIC_DEMO || run?.read_only === true;

async function api(path, post = false) {
  setLoading(true);
  try {
    // The public demo answers recorded GETs only; a write is refused before any request is made.
    if (STATIC_DEMO) {
      if (post) throw demoError(READ_ONLY_NOTE, 405);
      return await staticGet(path);
    }
    const response = await fetch(path, post ? {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'} : {});
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'The local request failed.'), {status: response.status});
    return value;
  } finally { setLoading(false); }
}

// Errors stay on screen until the next action; confirmations go to transient toasts.
function notice(message = '') {
  $('#notice').innerHTML = message ? `${icon('circle-alert')}<span>${text(message)}</span>` : '';
  $('#notice').hidden = !message;
}

let toastSeq = 0;
function toast(message, tone = 'ok') {
  const host = $('#toasts');
  if (!host || typeof host.insertAdjacentHTML !== 'function') return;
  const icons = {ok: 'circle-check', info: 'info', warn: 'triangle-alert', error: 'circle-x'}, id = `toast-${++toastSeq}`;
  host.insertAdjacentHTML('beforeend', `<div class="toast ${tone}" id="${id}">${icon(icons[tone] || 'info')}<span>${text(message)}</span><button class="icon-button" data-dismiss-toast="${id}" aria-label="Dismiss notification">${icon('x')}</button></div>`);
  while (host.children.length > 3) host.firstElementChild.remove();
  const el = document.getElementById(id);
  let timer = setTimeout(() => dismissToast(el), 4000);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(() => dismissToast(el), 1800); });
}
function dismissToast(el) {
  if (!el?.isConnected || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 180);
}

/* ---------- Motion ---------- */

const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Commit immediately; a short, cancellable entrance is presentation only.
function transition(update, kind = 'swap') {
  // Commit state immediately. A short entrance belongs to the new content only;
  // old and new tables must never overlap or delay a keyboard action.
  update();
  const panel = $('#content');
  if (kind === 'swap' || prefersReducedMotion() || typeof panel?.animate !== 'function') return;
  panel.getAnimations().forEach(animation => animation.cancel());
  panel.animate([{opacity: .7, transform: 'translateY(3px)'}, {opacity: 1, transform: 'none'}],
    {duration: 140, easing: 'ease-out'});
}

function positionTabIndicator() {
  const ind = $('.tab-ind'), tab = $(`#tab-${state.tab}`);
  if (!ind?.style || !tab || typeof tab.offsetLeft !== 'number') return;
  ind.style.setProperty('--x', `${tab.offsetLeft}px`);
  ind.style.setProperty('--w', `${tab.offsetWidth}px`);
}

// A recorded baseline's "ready for review" was true when it was built; it is not a current export check.
const statusOf = (run) => !run ? ['Not started', ''] : historicalRun(run) && run.status === 'ready_for_review' ? ['Checks passed · recorded', 'ok']
  : (RUN_STATUS[run.status] || [run.status.replaceAll('_', ' '), '']);
const modeInfo = (mode) => MODE_INFO[mode] || {
  short: `Mode: ${String(mode || 'unknown').replaceAll('_', ' ')}`, long: String(mode || 'unknown').replaceAll('_', ' '),
  method: 'Reported by the server. This page makes no offline or no-model claim for this mode.', unverified: true,
};
const modeLabel = (mode) => modeInfo(mode).long;
// Check names read as sentences: database_integrity → Database integrity.
const checkName = (name) => { const words = String(name).replaceAll('_', ' '); return words.charAt(0).toUpperCase() + words.slice(1); };
const groupOf = (name) => (CHECK_GROUPS.find(([, names]) => names.includes(name)) || ['Other checks'])[0];
const lineOf = (ref) => Number(String(ref).split(':L')[1]);
const fileOf = (ref) => String(ref).split(':L')[0];
const purchase = (o) => o ? `${text(o.customer)} · ${text(o.sku)} × ${text(o.quantity)}` : '—';
const purchaseCell = (o) => o ? `<span class="purchase-cell"><strong>${text(o.customer)}</strong><span>${text(o.sku)} × ${text(o.quantity)}</span></span>` : '—';
const compactId = (id) => String(id).length > 14 ? `${String(id).slice(0,8)}…${String(id).slice(-4)}` : String(id);
// A clickable order ID inside a selectable row. It is not a tab stop: the row is the keyboard target and the
// details panel links onward. A search match shows the full ID with the match marked, so hits stay visible.
const idRef = (id, tone = '', query = '') => {
  const full = String(id), q = query.trim();
  const shown = q && full.toLowerCase().includes(q.toLowerCase()) ? highlight(full, q) : '';
  const label = shown || `<span aria-hidden="true">${text(compactId(full))}</span><span class="sr-only">${text(full)}</span>`;
  if (!active().selectable) return `<span class="mono ${tone}" title="${escape(full)}">${label}</span>`;
  return `<span class="id-link mono ${tone}" data-key="order:${escape(full)}" title="${escape(full)}">${label}</span>`;
};
const ordersById = () => new Map((state.incident?.orders || []).map(o => [o.id, o]));
const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
const isNarrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
const SUMMARY_FIELDS = ['id', 'incident_id', 'status', 'summary', 'mode', 'created_at'];
const shortId = (id) => String(id).replace(/^run-/, '').slice(0, 8);
// Recordings are historical, so they always show their date. recordedAt: full; recordedShort: list entries.
const asDate = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const recordedAt = (iso) => { const d = asDate(iso); return d ? `${d.toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'})}, ${d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'})}` : ''; };
const recordedShort = (iso) => { const d = asDate(iso); return d ? `${d.toLocaleDateString([], {month: 'short', day: 'numeric'})}, ${d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : 'time not recorded'; };
const started = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'}) : ''; };
// Later purchases come from the server's review (checkout_order_ids); the UI applies no rule of its own.
const laterIds = (review) => new Set(review?.checkout_order_ids || []);

/* ---------- Active source: offline script run or recorded model run ---------- */

const recordedMode = () => state.source === 'recorded';
const REC_OUTCOME = {repair: ['Repair recorded', 'ok', 'circle-check'], stop: ['Stopped · recorded', 'warn', 'ban'], error: ['Error · recorded', 'danger', 'circle-x'], incomplete: ['Incomplete · recorded', 'warn', 'triangle-alert']};
const recOutcome = (r) => REC_OUTCOME[r?.outcome] || [String(r?.outcome || 'unknown').replaceAll('_', ' '), '', 'info'];
const REC_LABEL = 'Recorded model run, not live'; // the server's fixed provenance label; always shown from provenance when present
const TIMESTAMP_SOURCE = {result_file_mtime: 'time from the saved result file', agent_result: 'time recorded by the agent'};
const INPUT_PROVENANCE = {verified_legacy_file_manifest: 'inputs verified against a saved file manifest', native_capture: 'inputs fingerprinted before the first model call'};
// A recording may link into the current evidence and records only when the server enables citations
// for it AND it belongs to the case on screen.
const recCitations = (r) => !!r && r.citations_enabled === true && r.incident_id === state.incident?.id;

// Where review, plan and citations come from right now. Recorded data is historical and read-only.
function active() {
  if (recordedMode()) {
    const r = state.recording, review = r?.review || null, allowed = recCitations(r);
    const plan = review ? {cancellations: review.changes.map(c => ({order_id: c.before.id, duplicate_of: c.duplicate_of,
      evidence_refs: c.evidence_refs || [], recorded_evidence_refs_text: c.recorded_evidence_refs_text}))} : null;
    return {recorded: true, review, plan, citations: allowed, selectable: allowed};
  }
  return {recorded: false, review: state.run?.review || null, plan: state.run?.plan || null, citations: true, selectable: true};
}
// Row attributes for a selectable record; none when a mismatched recording must not link to current records.
const selAttrs = (key) => active().selectable ? `class="sel" tabindex="0" data-key="${escape(key)}" aria-selected="false"` : '';

/* ---------- Case navigation ---------- */

// A case's sidebar status describes the source on screen. Script mode: its newest script run's last
// recorded state (not a fresh export check). Recorded mode: how many recorded model runs it has and the
// newest one's outcome, so a script status never sits beside a recording as if they were one thing.
function caseStatus(id) {
  if (state.switching === id) return ['Loading…', 'loading'];
  if (state.source === 'recorded') {
    const list = state.recordings.get(id);
    if (list?.status !== 'ok') return ['Recorded runs', 'rec'];
    if (!list.list.length) return ['No recorded runs', ''];
    const latest = {repair: 'repair', stop: 'stopped', error: 'error', incomplete: 'incomplete'}[list.list[0].outcome] || String(list.list[0].outcome || 'unknown');
    return [`${list.list.length} recorded · latest ${latest}`, 'rec'];
  }
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
  transition(() => {
    if (version !== state.version || state.incident?.id !== caseId) return;
    Object.assign(state, {run, selection: null, sheet: false, filter: '', changeQuery: ''});
    if (!run.review && ['changes', 'checks', 'sql'].includes(state.tab)) state.tab = 'investigation';
    render();
  }, 'case');
}

// A case's progress ring describes its newest script run: one quarter per completed step (investigate,
// rehearse); a mark when it stopped or was refused (amber) or failed checks (red); dashed when not started.
const RING_WEDGE = (i, r = 3.6, c = 7.5) => {
  const a0 = -Math.PI / 2 + i * Math.PI / 2, a1 = a0 + Math.PI / 2, f = (n) => n.toFixed(2);
  return `<path d="M${c} ${c} L${f(c + r * Math.cos(a0))} ${f(c + r * Math.sin(a0))} A${r} ${r} 0 0 1 ${f(c + r * Math.cos(a1))} ${f(c + r * Math.sin(a1))} Z"/>`;
};
function ringSvg(status) {
  const tone = !status ? 'none' : status === 'failed_checks' ? 'danger' : ['stopped', 'blocked'].includes(status) ? 'warn' : 'ok';
  const done = status === 'proposed' ? 1 : status === 'ready_for_review' ? 2 : 0;
  const inner = tone === 'warn' || tone === 'danger' ? '<rect x="6.75" y="3.9" width="1.5" height="4.7" rx=".6"/><circle cx="7.5" cy="10.7" r=".9"/>'
    : Array.from({length: done}, (_, i) => RING_WEDGE(i)).join('');
  return `<svg class="ring ${tone}" viewBox="0 0 15 15" width="15" height="15" aria-hidden="true" focusable="false"><circle class="ring-track" cx="7.5" cy="7.5" r="6.2"/>${inner}</svg>`;
}

// The open case lists its attempts on one thread: script runs (newest three) and recorded Meta runs,
// each with its own outcome icon. Choosing one opens it in its source.
const clockShort = (iso) => { const d = asDate(iso); return d ? d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : ''; };
const dayShort = (iso) => { const d = asDate(iso); return d ? d.toLocaleDateString([], {month: 'short', day: 'numeric'}) : 'no date'; };

function attemptsTree(caseId) {
  const runs = (state.history.get(caseId) || []).slice(0, 3), recs = state.recordings.get(caseId)?.list || [];
  const item = (attrs, current, iconHtml, label, meta, title, warn = false) =>
    `<button class="run-item attempt${current ? ' current' : ''}" ${attrs} aria-current="${current ? 'true' : 'false'}" title="${escape(title)}">${iconHtml}<span class="attempt-label">${text(label)}</span><span class="attempt-meta${warn ? ' warn' : ''}">${text(meta)}</span></button>`;
  const script = runs.length
    ? runs.map(r => item(`data-source="script" data-run="${escape(r.id)}"`, !recordedMode() && r.id === state.run?.id, icon('git-compare', 'attempt-icon'),
        'Script baseline', clockShort(r.created_at), `Script baseline ${shortId(r.id)} · ${statusOf(r)[0]} · started ${started(r.created_at) || 'time not recorded'} · offline, no model`))
    : [item('data-source="script"', !recordedMode(), icon('git-compare', 'attempt-icon'), 'Script baseline', 'not run', 'Offline script baseline · not run yet')];
  const meta = recs.map((r, i) => {
    const n = recs.length - i, [label, tone, iconName] = recOutcome(r), differs = r.fixture_matches === false;
    return item(`data-source="recorded" data-recording="${escape(r.id)}"`, recordedMode() && r.id === state.recId, icon(iconName, `attempt-icon tone-${tone}`),
      `Meta run ${n}`, differs ? 'inputs differ' : dayShort(r.recorded_at), `Meta run ${n} · ${label} · ${recordedAt(r.recorded_at) || 'time not recorded'} · recorded, not live${differs ? ' · inputs differ from this case' : ''}`, differs);
  });
  return `<div class="tree" role="group" aria-label="Attempts on this case">${meta.join('')}${script.join('')}</div>`;
}

function renderCases() {
  $('#case-count').textContent = String(state.cases.length);
  $('#cases-label').textContent = 'Incidents';
  const at = state.cases.findIndex(c => c.id === (state.switching || state.incident?.id));
  const where = at >= 0 ? `Case ${pad(at + 1)} of ${pad(state.cases.length)}` : 'Cases';
  $('#nav-toggle-label').textContent = where;
  $('#nav-toggle').setAttribute('aria-label', `Cases · ${where}`);
  $('#cases').innerHTML = state.cases.map((c, i) => {
    const active = c.id === (state.switching || state.incident?.id);
    const newest = state.history.get(c.id)?.[0], shown = state.runs.get(c.id);
    const run = shown && (!newest || shown.id === newest.id) ? shown : newest || null;
    const loading = state.switching === c.id;
    const [label] = loading ? ['Loading…'] : statusOf(run);
    const repeats = ['proposed', 'ready_for_review', 'blocked', 'failed_checks'].includes(run?.status) ? run?.plan?.cancellations?.length : undefined;
    const name = `${pad(i + 1)} ${c.title} · ${label}${Number.isInteger(repeats) ? ` · ${repeats} repeats` : ''}`;
    const row = `<button class="case${active ? ' active' : ''}${loading ? ' loading' : ''}" data-case="${escape(c.id)}" ${state.busy ? 'disabled' : ''} ${active ? 'aria-current="page"' : ''} aria-label="${escape(name)}" title="${escape(name)}">${ringSvg(run?.status)}<span class="case-title">${text(c.title)}</span>${Number.isInteger(repeats) ? `<span class="case-count">${repeats}</span>` : ''}</button>`;
    return active && state.incident?.id === c.id ? row + attemptsTree(c.id) : row;
  }).join('');
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
  state.views.set(state.incident.id, {tab: state.tab, ev: {...state.ev}, selection: state.selection, filter: state.filter, changeQuery: state.changeQuery, source: state.source, recId: state.recId});
}

async function selectCase(identifier, tab = null) {
  const version = ++state.version;
  saveView();
  state.switching = identifier;
  state.recSeq += 1; // drop any recording response still in flight for the previous case
  notice(); renderCases();
  $('#content').setAttribute('aria-busy', 'true');
  try {
    const [incident] = await Promise.all([
      api(`/api/incidents/${encodeURIComponent(identifier)}`),
      refreshHistory(identifier).catch(error => { notice(`Run history unavailable: ${error.message}`); return []; }),
      refreshRecordings(identifier),
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
    transition(() => {
      if (version !== state.version) return; // a newer case switch started before this frame
      const list = state.recordings.get(identifier)?.list || [];
      const restoredRec = view?.recId && list.some(r => r.id === view.recId) ? view.recId : null;
      // A case seen before keeps its own source. Until the person picks one, a case opens on its recorded
      // Meta run when one with matching inputs exists, and on the script baseline otherwise.
      const source = view?.source || (state.sourceChosen ? state.source : demoDefault(identifier) ? 'recorded' : 'script');
      resetReplay();
      Object.assign(state, {
        incident, run, switching: null, sheet: false,
        tab: tab || view?.tab || (source === 'script' && run?.review ? 'changes' : 'investigation'),
        ev: view?.ev ? {...view.ev} : {name: 'events.jsonl', query: '', citedOnly: false, activeRef: null},
        selection: view?.selection || null, filter: view?.filter || '', changeQuery: view?.changeQuery || '', reconActive: null,
        source, recId: null, recording: null, stepFilter: 'all',
      });
      // A recording selection is refetched (never reused from memory) so its fixture match is current.
      if (state.source === 'recorded') {
        const pick = restoredRec || demoDefault(identifier)?.id || recordedList().list[0]?.id;
        if (pick) loadRecording(pick, {renderNow: false});
      }
      render();
      $('#content').focus({preventScroll: true});
    }, 'case');
  } finally {
    if (version === state.version) { state.switching = null; $('#content').removeAttribute('aria-busy'); renderCases(); }
  }
}

/* ---------- Shell ---------- */

// Re-rendering replaces the focused control. For these controls, put keyboard focus back on the
// replacement (same data attribute and value) so keyboard users don't drop to the top of the page.
const FOCUS_KEYS = ['recording', 'run', 'source', 'stepFilter', 'refreshRecordings', 'navRail'];
function holdFocus(update) {
  const el = document.activeElement, key = el?.dataset ? FOCUS_KEYS.find(k => k in el.dataset) : null;
  update();
  const now = document.activeElement;
  if (!key || (now && now !== document.body && now.isConnected)) return;
  const attr = key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), value = el.dataset[key];
  [...document.querySelectorAll(`[data-${attr}]`)].find(n => n.dataset[key] === value)?.focus({preventScroll: true});
}

function render() {
  if (!state.incident) return;
  holdFocus(() => {
    renderWelcome();
    renderCases();
    renderHeader();
    renderTabs();
    renderPanel();
    renderContext();
  });
  updateHash();
}

function renderSourceSwitch() {
  const list = recordedList(), count = list.status === 'ok' ? String(list.list.length) : list.status === 'error' ? '!' : '…';
  $('#source-switch').innerHTML = `<button data-source="recorded" aria-pressed="${recordedMode()}">${icon('history')}<span>Meta runs</span><span class="count">${count}</span></button>
    <button data-source="script" aria-pressed="${!recordedMode()}">${icon('git-compare')}<span>Script baseline</span></button>`;
}

// Recorded mode header: the fixed provenance label is prominent; no rehearse, SQL or download action exists.
function renderRecordedHeader() {
  const r = state.recording, list = recordedList();
  $('#mode-indicator').textContent = r ? recordingLabel(r) : 'Recorded model runs · not live';
  $('#mode-indicator').classList.remove('unverified');
  $('#mode-indicator').classList.add('recorded');
  if (r) {
    const [label, tone] = recOutcome(r), p = r.provenance || {};
    $('#title-status').innerHTML = `<span class="status ${tone}">${text(label)}</span>`;
    $('#incident-meta').innerHTML = `<span class="chip mono">${text(p.model || 'model not recorded')}</span>
      <span class="chip">${text(`Recorded ${recordedShort(p.recorded_at)}`)}</span><span class="chip">${text(`${r.tool_calls} tool results`)}</span>
      ${r.fixture_matches === false ? '<span class="chip warn-chip">Inputs differ from this case</span>' : ''}`;
    $('#run-details').hidden = false;
    $('#run-details-body').innerHTML = `<dl class="run-facts">
      <dt>Recording ID</dt><dd><span class="mono">${text(r.id)}</span> <button class="link" data-copy-value="${escape(r.id)}" data-copy-what="Recording ID">${icon('copy')}<span>Copy recording ID</span></button></dd>
      <dt>Label</dt><dd>${text(recordingLabel(r))}</dd>
      <dt>Model and mode</dt><dd class="mono">${text(`${p.model || 'not recorded'} · ${p.mode || 'not recorded'}`)}</dd>
      <dt>Recorded</dt><dd>${text(recordedAt(p.recorded_at) || 'Not recorded')}${p.timestamp_source ? ` · ${text(TIMESTAMP_SOURCE[p.timestamp_source] || p.timestamp_source)}` : ''}</dd>
      <dt>Inputs</dt><dd>${text(INPUT_PROVENANCE[p.input_provenance] || p.input_provenance || 'Not recorded')}${r.fixture_matches ? ' · match this case now' : ' · do not match this case'}</dd>
      <dt>Boundary</dt><dd>Read-only history. Nothing here calls a model, tests a repair or exports.</dd>
    </dl>`;
  } else {
    $('#title-status').innerHTML = `<span class="status">${text(list.status === 'ok' ? `${list.list.length} recorded runs` : 'Loading recorded runs…')}</span>`;
    $('#incident-meta').innerHTML = '';
    $('#run-details').hidden = true;
    $('#run-details-body').innerHTML = '';
  }
}

function renderHeader() {
  const {incident, run, busy} = state;
  const [label, tone] = statusOf(run);
  $('#title').textContent = incident.title;
  renderSourceSwitch();
  renderActions();
  if (recordedMode()) { renderRecordedHeader(); return; }
  $('#mode-indicator').classList.remove('recorded');
  const mode = run?.mode || incident.mode, info = modeInfo(mode);
  $('#mode-indicator').textContent = info.short;
  $('#mode-indicator').classList.toggle('unverified', !!info.unverified);
  $('#title-status').innerHTML = `<span class="status ${tone}">${text(label)}</span>${olderRunNote(run)}`;
  $('#incident-meta').innerHTML = stepsView(run);
  $('#run-details').hidden = !run;
  $('#run-details-body').innerHTML = run ? `<dl class="run-facts">
      <dt>Run ID</dt><dd><span class="mono">${text(run.id)}</span> <button class="link" data-copy-value="${escape(run.id)}" data-copy-what="Run ID">${icon('copy')}<span>Copy run ID</span></button></dd>
      <dt>Started</dt><dd>${text(started(run.created_at)) || 'Not recorded'}</dd>
      <dt>Method</dt><dd>${text(info.long)}. ${text(info.method)}</dd>
      <dt>Review boundary</dt><dd>${historicalRun(run) ? 'Recorded offline baseline. Nothing runs again here, and nothing can be exported.' : 'The source stays unchanged. The repair is tested on a disposable copy. Human review is required before using exported SQL.'}</dd>
    </dl>` : '';

}

// One obvious primary action for the state on screen, beside the mode label; "New offline investigation"
// stays secondary. It follows the tab where the next step depends on it (review, then download), so
// setTab re-renders only these buttons. Busy buttons keep their place and show the work in progress.
function renderActions() {
  if (!state.incident) return;
  const {run, busy, tab} = state;
  const button = (cls, attrs, iconName, label) => `<button class="${cls}" ${attrs}>${icon(iconName)}<span>${text(label)}</span></button>`;
  if (recordedMode()) {
    // A recording replays its saved steps; there is no rehearse, SQL or download action.
    const replay = state.recording && displayedSteps(state.recording).length ? button('primary', 'data-replay-start', 'play', 'Replay recorded steps') : '';
    $('#header-actions').innerHTML = `${button('secondary', 'data-source="script"', 'git-compare', 'Script baseline')}${replay}`;
    return;
  }
  if (historicalRun(run)) {
    // A recorded baseline offers navigation only: no new investigation, test or download from history.
    const go = !run ? '' : run.status === 'stopped' ? button('primary', 'data-view-missing', 'file-search', 'View missing evidence')
      : run.status === 'failed_checks' ? (tab === 'checks' ? '' : button('primary', 'data-tab="checks"', 'shield-check', 'Review failed checks'))
      : run.review && !['changes', 'checks'].includes(tab) ? button('primary', 'data-review-repair', 'git-compare', 'Review repair') : '';
    const meta = recordedList().list.length ? button('secondary', 'data-source="recorded"', 'history', 'Meta runs') : '';
    $('#header-actions').innerHTML = `${meta}${go}`;
    return;
  }
  const working = (label) => `${icon('loader-circle', 'spin')}<span>${label}</span>`;
  const hold = busy ? 'disabled aria-busy="true"' : '';
  const investigate = (primary) => `<button class="${primary ? 'primary' : 'secondary'}" data-action="investigate" ${run && !primary ? 'title="New offline investigation"' : ''} ${hold}>${busy && state.busyAction === 'investigate' ? working('Reading local evidence…') : `${icon(run ? 'refresh-cw' : 'play')}<span>${run ? 'New offline investigation' : 'Investigate incident'}</span>`}</button>`;
  let primary = '', secondary = run ? investigate(false) : '';
  if (!run) primary = investigate(true);
  else if (run.status === 'proposed') primary = `<button class="primary" data-action="rehearse" ${hold}>${busy && state.busyAction === 'rehearse' ? working('Testing on a copy…') : `${icon('flask-conical')}<span>Test repair on a copy</span>`}</button>`;
  else if (run.status === 'stopped') primary = button('primary', 'data-view-missing', 'file-search', 'View missing evidence');
  else if (run.status === 'ready_for_review') primary = ['changes', 'checks', 'sql'].includes(tab)
    ? button('primary', 'data-download="repair.sql"', 'download', 'Download repair SQL')
    : button('primary', 'data-review-repair', 'git-compare', 'Review repair');
  else if (run.status === 'failed_checks') primary = tab === 'checks' ? '' : button('primary', 'data-tab="checks"', 'shield-check', 'Review failed checks');
  // Blocked: recovery is a new investigation. Only a run that was rehearsed has a repair to review.
  else if (run.status === 'blocked') { primary = investigate(true); secondary = run.review ? button('secondary', 'data-review-repair', 'git-compare', 'Review blocked repair') : ''; }
  $('#header-actions').innerHTML = `${secondary}${primary}`;
}

function olderRunNote(run) {
  const newest = state.history.get(state.incident?.id)?.[0];
  if (!run || !newest || newest.id === run.id) return '';
  return `<span class="chip warn-chip">Older run</span><button class="link small" data-run="${escape(newest.id)}">Open newest run</button>`;
}

// The four steps of the offline repair, from the server's run status only. A step is "done" only when
// the server reported it (a run exists; a rehearsal review exists), so nothing here claims that a person
// reviewed or exported anything. Reachable steps open their tab; Export opens the guarded downloads.
const STEP_SR = {done: 'done', current: 'current step', open: 'available', warn: 'needs attention', danger: 'failed', upcoming: 'not reached yet', off: 'not available here'};
function stepsView(run) {
  const s = run?.status, rehearsed = !!run?.review, working = state.busy ? state.busyAction : null;
  const steps = [
    {label: 'Investigate', sub: 'read-only', tab: 'investigation'},
    {label: 'Test on a copy', sub: 'changes made only on a copy', tab: rehearsed ? 'changes' : 'investigation'},
    {label: 'Review', sub: 'changes and checks', tab: s === 'failed_checks' ? 'checks' : 'changes'},
    {label: 'Export', sub: 'guarded SQL', tab: 'sql'},
  ];
  const plan = !run ? ['current', 'upcoming', 'upcoming', 'upcoming']
    : s === 'proposed' ? ['done', 'current', 'upcoming', 'upcoming']
    : s === 'stopped' ? ['warn', 'upcoming', 'upcoming', 'upcoming']
    : s === 'ready_for_review' ? ['done', 'done', 'current', 'open']
    : s === 'failed_checks' ? ['done', 'done', 'danger', 'upcoming']
    : s === 'blocked' ? (rehearsed ? ['done', 'done', 'open', 'warn'] : ['done', 'warn', 'upcoming', 'upcoming'])
    : ['done', 'upcoming', 'upcoming', 'upcoming'];
  const subs = {0: s === 'stopped' ? 'evidence needed' : null, 1: s === 'blocked' && !rehearsed ? 'refused' : null,
    2: s === 'failed_checks' ? 'checks failed' : null, 3: s === 'blocked' && rehearsed ? 'blocked' : null};
  if (run && historicalRun(run)) { plan[3] = 'off'; subs[3] = 'not in this demo'; }
  const items = steps.map((step, i) => {
    const st = plan[i], spinning = (working === 'investigate' && i === 0) || (working === 'rehearse' && i === 1);
    const dot = spinning ? icon('loader-circle', 'spin') : st === 'done' ? icon('check') : st === 'warn' ? '!' : st === 'danger' ? '×' : String(i + 1);
    const flag = spinning ? (i === 0 ? 'reading evidence…' : 'testing on a copy…') : subs[i];
    const inner = `<span class="step-dot" aria-hidden="true">${dot}</span><span class="step-label">${step.label}</span>${flag ? `<span class="step-sub">${text(flag)}</span>` : `<span class="sr-only"> · ${text(step.sub)}</span>`}<span class="sr-only"> · ${STEP_SR[st]}</span>`;
    const attrs = `class="step ${st}" title="${escape(`${step.label} · ${flag || step.sub}`)}"${st === 'current' ? ' aria-current="step"' : ''}`;
    const target = st === 'upcoming' || st === 'off' || (i === 0 && !run) ? '' : i === 3 && st === 'open' ? 'data-review-downloads' : `data-tab="${step.tab}"`;
    return `<li class="${st}">${target ? `<button ${attrs} ${target}>${inner}</button>` : `<span ${attrs}>${inner}</span>`}</li>`;
  });
  return `<nav class="steps-nav" aria-label="Repair progress"><ol class="steps">${items.join('')}</ol></nav>`;
}

function renderTabs() {
  const review = active().review;
  const counts = {
    evidence: state.incident.artifacts.length,
    changes: review ? review.changes.length : '',
    checks: review ? `${review.checks.filter(c => c.passed).length}/${review.checks.length}` : '',
    sql: recordedMode() || historicalRun(state.run) ? 'n/a' : review && state.run.status !== 'ready_for_review' ? 'unavailable' : '',
  };
  for (const tab of TABS) {
    const button = $(`#tab-${tab}`), selected = tab === state.tab, [iconName, label] = TAB_META[tab];
    button.setAttribute('aria-selected', String(selected));
    button.setAttribute('tabindex', selected ? '0' : '-1');
    const failed = tab === 'checks' && review && !review.passed;
    button.innerHTML = `${icon(iconName)}<span>${label}</span>${counts[tab] !== '' && counts[tab] !== undefined ? `<span class="count ${failed?'bad':''}">${text(counts[tab])}</span>` : ''}`;
  }
  $('#content').setAttribute('aria-labelledby', `tab-${state.tab}`);
  positionTabIndicator();
}

function setTab(tab, focusTab = false) {
  if (!TABS.includes(tab)) return;
  if (tab !== 'investigation' && state.replay?.playing) { stopReplayTimer(); state.replay.playing = false; }
  const changed = tab !== state.tab;
  const direction = TABS.indexOf(tab) >= TABS.indexOf(state.tab) ? 'forward' : 'back';
  transition(() => {
    state.tab = tab;
    renderTabs(); renderPanel(); renderActions(); updateHash();
    if (changed) {
      $('#content').scrollTop = 0;
      // Phones scroll the page instead of the panel: start the new tab right under the sticky tab bar.
      const top = $('.workspace').getBoundingClientRect().top + window.scrollY - $('.tabs').offsetHeight;
      if (window.scrollY > top) window.scrollTo({top});
    }
    if (!state.selection) renderContext(); // the guide's shortcut follows the tab
    if (focusTab) $(`#tab-${tab}`).focus();
  }, tab === state.tab ? 'swap' : direction);
}

function renderPanel() {
  // Recorded mode has its own read-only views; offline rehearse, SQL and download helpers are never reached.
  const views = recordedMode()
    ? {investigation: recordedInvestigationView, evidence: evidenceView, changes: recordedChangesView, checks: recordedChecksView, sql: recordedSqlView}
    : {investigation: investigationView, evidence: evidenceView, changes: changesView, checks: checksTab, sql: sqlView};
  $('#content').innerHTML = views[state.tab]();
  if (state.tab === 'evidence') renderEvidence();
  if (state.tab === 'sql' && !recordedMode()) maybeLoadSql();
  markSelection();
}

function viewMissing() {
  const go = () => { const target = $('#missing-events'); target?.scrollIntoView({block: 'center'}); target?.focus({preventScroll: true}); };
  if (state.tab === 'investigation') { go(); return; }
  setTab('investigation');
  const ready = (tries) => { if (state.tab === 'investigation' && $('#missing-events')) go(); else if (tries) setTimeout(() => ready(tries - 1), 50); };
  ready(12);
}

function reviewRepair(downloads = false) {
  const go = () => {
    const target = downloads ? $('#repair-package') : $('#content');
    target?.scrollIntoView({block: 'start'});
    target?.focus({preventScroll: true});
  };
  if (state.tab === 'changes') { go(); return; }
  setTab('changes');
  // setTab applies inside a view transition (at most 250 ms later), so scroll once the new panel exists.
  const ready = (tries) => { if (state.tab === 'changes' && $('#repair-package')) go(); else if (tries) setTimeout(() => ready(tries - 1), 50); };
  ready(12);
}

const emptyState = (title, body, iconName = 'info') => `<div class="empty">${icon(iconName, 'empty-icon')}<h2>${text(title)}</h2><p>${text(body)}</p></div>`;

// Why a run has no rehearsal review, from its server status. A run blocked before rehearsal cannot be
// rehearsed again (the server only rehearses proposed runs), so it points to a new investigation instead.
function noReview(run, what) {
  if (!run) return emptyState(`No ${what} yet`, 'Start the offline investigation, then test its proposal on a copy.', 'play');
  if (run.status === 'stopped') return emptyState('No repair was proposed', 'The investigation stopped because evidence is missing. Nothing was changed.', 'ban');
  if (run.status === 'blocked') return `<div class="section-heading"><h2>Test on a copy refused</h2></div>
    <div class="callout stop">${text(run.summary)}</div>
    <p class="small muted">Nothing was rehearsed or changed. Start a new offline investigation from the header to work from the current source and evidence.</p>`;
  return emptyState('Not tested on a copy yet', `Test the proposal on a copy to see ${what}.`, 'flask-conical');
}

/* ---------- Investigation ---------- */

const STORY_TITLE = {'multiple-retries': 'Two partial imports. Two retries.', 'split-evidence': 'A retry, with its evidence split across two files.'};
// The case's own incident note, minus its instructions to the investigator.
function caseStory() {
  const sentences = (state.incident.note?.lines || []).map(l => l.text).join(' ').split(/(?<=\.)\s+/);
  return sentences.filter(s => s && !/^(Investigate|Join|Do not|Only|Preserve|If |This fixture)/.test(s)).slice(0, 5).join(' ');
}

function incidentOverview() {
  const {incident} = state;
  return `<section class="incident-brief"><span class="eyebrow">The incident</span>
    <h2>${text(STORY_TITLE[incident.scenario] || 'A partial import. A full retry.')}</h2>
    <p class="lede">${text(caseStory() || 'An import was retried after a partial failure while customers kept buying.')} Similar-looking purchases may be legitimate.</p>
    <div class="incident-facts"><span><strong>${text(incident.active_orders)}</strong> active orders</span><span><strong>${text(incident.artifacts.length)}</strong> evidence files</span><span><strong>${text(incident.products.length)}</strong> products</span></div>
    <p class="incident-question">Find the repeated writes. Keep the legitimate purchases.</p></section>`;
}

function sourceRecords() {
  const {incident} = state;
  return `<details class="fold"><summary>Source inventory, incident note and schema</summary>
      <h3>Current inventory · source database</h3>${table(['Product','Available stock'],incident.products.map(p=>[text(p.name),`<span class="num">${text(p.on_hand)}</span>`]))}
      <p class="small">${text(incident.note.lines.map(l=>l.text).join('\n'))}</p><pre>${text(incident.schema.map(s=>s.sql).join('\n\n'))}</pre></details>
    <details class="fold"><summary>Source orders · ${incident.orders.length} records</summary><p class="caption fold-note">Select an order to inspect it.</p>${orderTable(incident.orders)}</details>`;
}

function callsView(trace) {
  return `<div class="row-head"><h3>Script trace</h3><span class="caption">${trace.length} local function calls, in order. Not model reasoning, and not a replay of a model run.</span></div>
    <ol class="calls">${trace.map((step,i)=>{
      const a = step.arguments || {};
      const arg = a.name ? `${a.name}${a.start_line ? ` · from L${a.start_line}` : ''}` : step.tool === 'query_database' ? (a.sql || '') : 'no arguments';
      return `<li><details class="call"><summary><span class="idx">${pad(i+1)}</span><span class="tool mono">${text(step.tool)}</span><span class="arg mono">${text(arg)}</span><span class="ok">observed</span></summary><pre>${text(JSON.stringify({arguments:step.arguments,result:step.result},null,2))}</pre></details></li>`;
    }).join('')}</ol>`;
}

/* ---------- What happened: the incident, reconstructed from the evidence ---------- */

// Lane names for the attempts in the synthetic evidence; an unknown attempt is shown as written.
const ATTEMPT_LABEL = {'import-first': 'First import', 'import-retry-partial': 'Partial retry', 'import-retry': 'Retry', 'web-checkout': 'Customer checkouts'};
const RECON_FILES = ['events.jsonl', 'commit_receipts.csv', 'inbox_receipts.txt'];
const RECON_LANE = 30; // px per lane; the SVG uses the same units vertically

// One CSV record per evidence line, read the way the engine reads receipts (Python's csv module,
// strict): a quoted value keeps its commas, "" inside quotes is one quote, and only a comma may follow
// a closing quote. A line the engine would reject returns null and draws no write.
function csvCells(line) {
  const cells = [];
  let cell = '', mode = 'start'; // start of a field, inside an unquoted field, inside quotes, after quotes
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (mode === 'quoted') {
      if (ch !== '"') cell += ch;
      else if (line[i + 1] === '"') { cell += '"'; i++; }
      else mode = 'closed';
    } else if (ch === ',') { cells.push(cell); cell = ''; mode = 'start'; }
    else if (mode === 'closed') return null;
    else if (ch === '"' && mode === 'start') mode = 'quoted';
    else { cell += ch; mode = 'field'; }
  }
  if (mode === 'quoted') return null; // a record must end on its own line
  cells.push(cell);
  return cells;
}

// The committed writes and incident markers in the evidence files, in commit order: commit_seq when
// every write records one (split, out-of-order exports), otherwise file order. Nothing here decides what
// repeats: that comes only from the engine's plan or a recording's review, passed in as pairs.
function evidenceWrites() {
  const names = new Set(state.incident.artifacts.map(a => a.name));
  const files = RECON_FILES.filter(n => names.has(n));
  if (!files.length) return {writes: [], marks: [], lanes: []};
  const data = files.map(n => [n, fileData(n)]);
  if (data.some(([, d]) => !d)) {
    const caseId = state.incident.id;
    if (!state.reconWaiting.has(caseId)) {
      state.reconWaiting.add(caseId);
      Promise.all(files.map(ensureFile)).then(() => {
        state.reconWaiting.delete(caseId);
        if (state.incident?.id === caseId && state.tab === 'investigation') renderPanel();
      }, () => { state.reconWaiting.delete(caseId); });
    }
    return null;
  }
  const writes = [], marks = [], inboxDeclarations = [];
  let inboxCount = 0, inboxInvalid = false;
  let seen = 0, lastAttempt = '';
  for (const [name, d] of data) {
    let header = null;
    for (const line of d.lines) {
      let row = null;
      if (name.endsWith('.csv')) {
        const cells = csvCells(line.text.replace(/\r$/, ''));
        if (!header) { header = cells || []; continue; }
        if (!cells || cells.length !== header.length) continue;
        row = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
      } else if (name === 'inbox_receipts.txt') {
        // Presentation of copied service receipts only. Narrative messages never draw a write;
        // the engine's plan/review remains the sole source of cancellation/retention pairs.
        if (!line.text.startsWith('[RR-COMMIT v1] ')) {
          if (line.text.startsWith('[RR-COMMIT')) inboxInvalid = true;
          continue;
        }
        try { row = JSON.parse(line.text.slice('[RR-COMMIT v1] '.length)); } catch (_) { inboxInvalid = true; continue; }
        const fields = ['type', 'attempt', 'event_id', 'order_id', 'movement_id', 'commit_seq'];
        if (!plainObject(row) || row.type !== 'write_committed' || Object.keys(row).length !== fields.length
          || !fields.every(k => own(row, k)) || !['attempt', 'event_id', 'order_id', 'movement_id'].every(k => typeof row[k] === 'string' && row[k].length > 0 && row[k].length <= 80)
          || !Number.isInteger(row.commit_seq) || row.commit_seq < 1 || row.commit_seq > 10000) {
          inboxInvalid = true; continue;
        }
        inboxCount++;
      } else {
        try { row = JSON.parse(line.text); } catch (_) { continue; }
      }
      if (!row || typeof row !== 'object') continue;
      if (name === 'events.jsonl' && row.type === 'receipt_inbox') inboxDeclarations.push(row);
      const at = seen++;
      if (row.type === 'write_committed' && row.order_id) {
        const seq = row.commit_seq === undefined || row.commit_seq === '' ? null : Number(row.commit_seq);
        writes.push({ref: line.ref, at, attempt: String(row.attempt || 'unknown'), order_id: String(row.order_id), event_id: String(row.event_id || ''), seq: Number.isFinite(seq) ? seq : null});
        lastAttempt = String(row.attempt || lastAttempt);
      } else if (row.type === 'connection_lost' || row.type === 'log_gap') {
        const attempt = String(row.attempt || (row.type === 'log_gap' ? '' : lastAttempt) || '');
        marks.push({ref: line.ref, at, type: row.type, attempt, detail: String(row.detail || '')});
        if (row.attempt) lastAttempt = String(row.attempt);
      }
    }
  }
  if (names.has('inbox_receipts.txt') || inboxDeclarations.length) {
    const declared = inboxDeclarations[0];
    if (inboxInvalid || !names.has('inbox_receipts.txt') || inboxDeclarations.length !== 1
      || Object.keys(declared).length !== 4 || declared.name !== 'inbox_receipts.txt'
      || declared.format !== 'embedded-commit-v1' || !Number.isInteger(declared.count)
      || declared.count < 1 || declared.count > 200 || declared.count !== inboxCount
      || writes.some(w => !Number.isInteger(w.seq) || w.seq < 1 || w.seq > 10000)
      || new Set(writes.map(w => w.seq)).size !== writes.length) {
      return {writes: [], marks: [], lanes: [], error: 'The inbox receipts could not be reconstructed completely. Inspect the evidence and recorded review; no partial timeline is shown.'};
    }
  }
  const bySeq = writes.length > 0 && writes.every(w => w.seq !== null);
  writes.sort((a, b) => bySeq ? a.seq - b.seq : a.at - b.at);
  writes.forEach((w, i) => { w.x = i; w.commitLabel = bySeq ? w.seq : i + 1; });
  // A marker sits after the last write before it (file order), or after its attempt's last write (commit order).
  for (const m of marks) {
    const own = writes.filter(w => w.attempt === m.attempt);
    m.x = bySeq ? (own.length ? Math.max(...own.map(w => w.x)) + 1 : 0) : writes.filter(w => w.at < m.at).length;
  }
  const first = new Map();
  for (const item of [...writes, ...marks]) if (item.attempt && (!first.has(item.attempt) || item.x < first.get(item.attempt))) first.set(item.attempt, item.x);
  const lanes = [...first.keys()].sort((a, b) => first.get(a) - first.get(b) || a.localeCompare(b));
  for (const m of marks) if (!m.attempt && lanes.length) m.attempt = lanes[0];
  return {writes, marks, lanes, bySeq, files};
}

const reconLabel = (w, lane, role) => {
  const o = ordersById().get(w.order_id);
  return `Commit ${w.commitLabel} · ${ATTEMPT_LABEL[lane] || lane}${o ? ` · ${o.customer} ${o.sku} × ${o.quantity}` : ''} · ${w.order_id}${role ? ` · ${role}` : ''}`;
};

// The graph's columns: one per source event, in the order each event was first committed, so every write of
// the same event lines up across the attempt lanes, like the same change on two branches. Columns come only
// from the evidence's event IDs; which write repeats still comes only from the plan or review (pairs).
// A write without an event ID, or a second write of an event in the same lane, gets a column of its own.
const GRAPH_STEP = 11, GRAPH_PAD = 24;
function graphColumns(model) {
  const byEvent = new Map(), taken = new Set();
  let count = 0;
  for (const w of model.writes) {
    const prior = w.event_id ? byEvent.get(w.event_id) : undefined;
    w.col = prior !== undefined && !taken.has(`${prior}:${w.attempt}`) ? prior : count++;
    if (w.event_id && prior === undefined) byEvent.set(w.event_id, w.col);
    taken.add(`${w.col}:${w.attempt}`);
  }
  count = Math.max(count, 1);
  return {count, width: GRAPH_PAD + count * GRAPH_STEP + GRAPH_STEP, cx: (col) => GRAPH_PAD + col * GRAPH_STEP + GRAPH_STEP / 2};
}

// The last graph drawn, so pointer and keyboard can update its column highlight and log without a repaint.
let reconCtx = null;

// Every write of the highlighted commit's source event, newest attempt last, like a short git log.
function columnLog(active) {
  const ctx = reconCtx;
  if (!ctx || !active) return '<p class="caption">Point at a commit, or use the arrow keys, to list every write of its source event.</p>';
  active = ctx.writes.find(w => w.x === active.x) || active;
  const same = ctx.writes.filter(w => w.col === active.col).sort((a, b) => ctx.laneOf.get(a.attempt) - ctx.laneOf.get(b.attempt));
  const o = ordersById().get(same[0].order_id);
  const head = `${active.event_id ? `Source event <span class="mono">${text(active.event_id)}</span>` : 'No source event recorded'}${o ? ` · ${text(`${o.customer} · ${o.sku} × ${o.quantity}`)}` : ''} · ${same.length} ${same.length === 1 ? 'write' : 'writes'}`;
  const rows = same.map(w => {
    const role = ctx.role(w), tone = ctx.repeat.has(w.x) ? 'repeat' : ctx.kept.has(w.x) ? 'kept' : '';
    const attrs = ctx.selectable ? ` data-key="order:${escape(w.order_id)}"` : '';
    return `<li class="${tone}${w.x === active.x ? ' current' : ''}"${attrs}><i aria-hidden="true"></i><span class="mono">#${text(w.commitLabel)}</span><span class="mono">${text(compactId(w.order_id))}</span><span>${text(ATTEMPT_LABEL[w.attempt] || w.attempt)}</span><span class="mono faint">${text(w.ref)}</span><span>${text(role || 'committed write')}</span></li>`;
  }).join('');
  return `<p class="recon-log-head">${head}</p><ol class="recon-log-list">${rows}</ol>`;
}

// Highlight one commit's column and list its writes, in place.
function showColumn(i) {
  const svg = $('#content .recon-svg'), w = reconCtx?.writes.find(x => x.x === i);
  if (!w) return;
  state.reconActive = i;
  if (!svg?.querySelector) return;
  const col = svg.querySelector('.recon-col'), ring = svg.querySelector('.recon-ring'), dot = svg.querySelector(`[data-i="${i}"]`);
  if (col) { col.setAttribute('x', String(reconCtx.cx(w.col) - GRAPH_STEP / 2)); col.removeAttribute('visibility'); }
  if (ring && dot) { ring.setAttribute('cx', dot.getAttribute('cx')); ring.setAttribute('cy', dot.getAttribute('cy')); ring.removeAttribute('visibility'); }
  const log = $('#recon-log');
  if (log) log.innerHTML = columnLog(w);
}

// pairs: [{order_id: the repeated (cancelled) order, duplicate_of: the first write that stays}].
// rehearsed: a rehearsal review exists, so the marked repeats were cancelled on the copy; otherwise they
// are the proposal's targets and nothing has been cancelled yet.
function reconstructionView(pairs = null, {recorded = false, stopped = null, rehearsed = false} = {}) {
  const model = evidenceWrites();
  const head = `<div class="recon-head"><h3 id="recon-title">What happened</h3><span class="caption">Each attempt is a branch and each column one source event, read from the evidence files</span></div>`;
  if (model === null) return `<section class="recon" aria-labelledby="recon-title">${head}${skeleton(3)}</section>`;
  if (model.error) return `<section class="recon" aria-labelledby="recon-title">${head}<p class="callout stop">${text(model.error)}</p></section>`;
  const {writes, marks, lanes} = model;
  if (!writes.length && !marks.length) return '';
  const cols = graphColumns(model), laneOf = new Map(lanes.map((l, i) => [l, i]));
  const byOrder = new Map(writes.map(w => [w.order_id, w]));
  const kept = new Set(), repeat = new Set(), arcs = [];
  for (const p of pairs || []) {
    const r = byOrder.get(p.order_id), k = byOrder.get(p.duplicate_of);
    if (!r || !k) continue;
    repeat.add(r.x); kept.add(k.x); arcs.push([k, r]);
  }
  // The copy branch appears only once a test on a copy exists (this run's review or the recording's).
  const found = pairs && (rehearsed || recorded) && arcs.length ? active().review : null;
  const review = found && Array.isArray(found.checks) && Number.isFinite(found.before_active) && Number.isFinite(found.after_active) ? found : null;
  const laneCount = Math.max(lanes.length, 1), height = (laneCount + (review ? 2 : 0)) * RECON_LANE;
  const ly = (lane) => laneOf.get(lane) * RECON_LANE + RECON_LANE / 2, cx = (w) => cols.cx(w.col);
  const repeatRole = recorded ? 'Repeat · cancelled in this recording' : rehearsed ? 'Repeat · cancelled on the copy' : 'Repeat · proposed to cancel';
  const role = (w) => repeat.has(w.x) ? repeatRole.toLowerCase() : kept.has(w.x) ? 'first write · stays' : pairs ? 'untouched' : '';
  const selectable = active().selectable;
  const branches = lanes.map(l => {
    const xs = writes.filter(w => w.attempt === l).map(cx);
    return xs.length > 1 ? `<line class="recon-branch" x1="${Math.min(...xs)}" x2="${Math.max(...xs)}" y1="${ly(l)}" y2="${ly(l)}"/>` : '';
  }).join('');
  const curves = arcs.map(([k, r]) => {
    const x1 = cx(k), x2 = cx(r), y1 = ly(k.attempt), y2 = ly(r.attempt);
    if (x1 === x2) { const dir = Math.sign(y2 - y1) || 1; return `<line class="recon-arc" x1="${x1}" x2="${x2}" y1="${y1 + dir * 5}" y2="${y2 - dir * 5}"/>`; }
    if (y1 === y2) return `<path class="recon-arc" d="M${x1} ${y1 - 5} C${x1} ${y1 - 14}, ${x2} ${y1 - 14}, ${x2} ${y1 - 5}"/>`;
    const mid = (y1 + y2) / 2;
    return `<path class="recon-arc" d="M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}"/>`;
  }).join('');
  const ticks = writes.map(w => `<circle class="recon-tick${repeat.has(w.x) ? ' repeat' : kept.has(w.x) ? ' kept' : ''}" data-i="${w.x}" ${selectable ? `data-key="order:${escape(w.order_id)}"` : ''} cx="${cx(w)}" cy="${ly(w.attempt)}" r="3.5"><title>${text(reconLabel(w, w.attempt, role(w)))}</title></circle>`).join('');
  const lost = marks.filter(m => m.type === 'connection_lost' && laneOf.has(m.attempt)).map(m => {
    const own = writes.filter(w => w.attempt === m.attempt), before = own.filter(w => w.x < m.x);
    const x = before.length ? Math.max(...before.map(cx)) + GRAPH_STEP : own.length ? Math.min(...own.map(cx)) - GRAPH_STEP : GRAPH_PAD, y = ly(m.attempt);
    return `<path class="recon-lost" d="M${x + 2} ${y - 7}l-4 7h5l-4 7"><title>Connection lost · ${text(ATTEMPT_LABEL[m.attempt] || m.attempt)}</title></path>`;
  }).join('');
  const gaps = marks.filter(m => m.type === 'log_gap');
  const activeW = Number.isInteger(state.reconActive) ? writes.find(w => w.x === state.reconActive) || null : null;
  const hidden = activeW ? '' : ' visibility="hidden"';
  const highlight = `<rect class="recon-col" x="${activeW ? cx(activeW) - GRAPH_STEP / 2 : 0}" y="0" width="${GRAPH_STEP}" height="${laneCount * RECON_LANE}"${hidden}/>`;
  const ring = `<circle class="recon-ring" cx="${activeW ? cx(activeW) : 0}" cy="${activeW ? ly(activeW.attempt) : 0}" r="6"${hidden}/>`;
  let copy = '', copyRows = '';
  if (review) {
    const top = laneCount * RECON_LANE, y0 = top + RECON_LANE / 2, y1 = y0 + RECON_LANE, end = cols.cx(cols.count - 1);
    const passed = review.checks.filter(ch => ch.passed).length, ok = review.passed === true && review.checks.length > 0 && passed === review.checks.length;
    const src = review.checks.find(ch => ch.name === 'source_snapshot_unchanged');
    const reverts = [...new Set(arcs.map(([, r]) => cx(r)))].map(x => `<path class="recon-revert" d="M${x - 3} ${y1 - 3}l6 6m0 -6l-6 6"/>`).join('');
    copy = `<line class="recon-divider" x1="0" x2="${cols.width}" y1="${top}" y2="${top}"/>
      <line class="recon-branch" x1="6" x2="${end}" y1="${y0}" y2="${y0}"/><circle class="recon-node" cx="6" cy="${y0}" r="3.5"/><circle class="recon-node" cx="${end}" cy="${y0}" r="4"/>
      <path class="recon-branch" d="M6 ${y0} C16 ${y0}, 10 ${y1}, 22 ${y1} L${end} ${y1}"/>${reverts}<circle class="recon-node ${ok ? 'ok' : 'danger'}" cx="${end}" cy="${y1}" r="4"/>`;
    const where = recorded || historicalRun(state.run) ? 'Recorded test copy' : 'Tested copy';
    copyRows = `<li class="copy-first" title="${escape(`Original database · ${src ? (src.passed ? 'unchanged during the test' : 'changed during the test') : 'opened read-only'}`)}"><strong class="lane-long">Original database</strong><strong class="lane-short">Original</strong><span>${text(src ? (src.passed ? 'unchanged during the test' : 'changed during the test') : 'opened read-only')}</span></li>
      <li title="${escape(`${where} · ${review.before_active} → ${review.after_active} active · ${passed}/${review.checks.length} checks`)}"><strong class="lane-long">${text(where)}</strong><strong class="lane-short">Copy</strong><span>${text(`${review.before_active} → ${review.after_active} · ${passed}/${review.checks.length} checks`)}</span></li>`;
  }
  const laneRows = lanes.map(l => {
    const count = writes.filter(w => w.attempt === l).length;
    const notes = [count ? `${count} write${count === 1 ? '' : 's'}` : 'no commit records',
      marks.some(m => m.type === 'connection_lost' && m.attempt === l) ? 'connection lost' : '',
      gaps.some(m => m.attempt === l) ? 'log gap' : ''].filter(Boolean).join(' · ');
    const short = l === 'web-checkout' ? 'Checkouts' : ATTEMPT_LABEL[l] || l;
    return `<li title="${escape(`${ATTEMPT_LABEL[l] || l} · ${notes}`)}"><strong class="lane-long">${text(ATTEMPT_LABEL[l] || l)}</strong><strong class="lane-short">${text(short)}</strong><span>${text(notes)}</span></li>`;
  }).join('');
  const legend = pairs
    ? `<span><i class="kept"></i>First write · stays</span><span><i class="repeat"></i>${repeatRole}</span><span><i></i>Untouched</span>${arcs.length ? '<span><i class="tie"></i>Same source event</span>' : ''}`
    : '<span><i></i>Committed write</span>';
  const lostKey = marks.some(m => m.type === 'connection_lost') ? '<span><svg class="legend-bolt" viewBox="0 0 8 16" aria-hidden="true"><path d="M5 1l-4 7h5l-4 7"/></svg>Connection lost</span>' : '';
  const copyKey = review ? `<span><svg class="legend-revert" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6m0 -6l-6 6"/></svg>Cancelled on the ${recorded || historicalRun(state.run) ? 'recorded ' : ''}copy</span>` : '';
  const untouched = writes.length - repeat.size - kept.size;
  const lostCount = marks.filter(m => m.type === 'connection_lost').length;
  const summary = stopped ? `The script stopped instead of guessing: ${stopped} source events have no commit record${gaps.length ? ', where the log has a gap' : ''}.`
    : recorded && !pairs ? `This recording has no selected repair, so no writes are marked. ${writes.length} committed writes across ${lanes.length} ${lanes.length === 1 ? 'attempt' : 'attempts'}.`
    : pairs && !recorded && !rehearsed ? `The proposal would cancel ${repeat.size} repeated write${repeat.size === 1 ? '' : 's'} and keep the first write of each source event. ${untouched} other write${untouched === 1 ? '' : 's'} would stay untouched. Nothing is cancelled until it is tested on a copy.`
    : pairs ? `${recorded ? 'This recording’s review cancels' : 'On the copy, the repair cancelled'} ${repeat.size} repeated write${repeat.size === 1 ? '' : 's'} and ${recorded ? 'keeps' : 'kept'} the first write of each source event. ${untouched} other write${untouched === 1 ? ' is' : 's are'} untouched.`
    : `${writes.length} committed writes across ${lanes.length} ${lanes.length === 1 ? 'attempt' : 'attempts'}${lostCount ? `, with ${lostCount === 1 ? 'a lost connection' : `${lostCount} lost connections`}` : ''}${gaps.length ? ' and a gap in the commit log' : ''}. The investigation decides which writes repeat.`;
  const described = `${summary} Use the left and right arrow keys to move between writes, up and down to move between writes of the same source event${selectable ? ', and Enter to open one' : ''}.`;
  reconCtx = {writes, laneOf, repeat, kept, role, selectable, cx: cols.cx};
  return `<section class="recon" aria-labelledby="recon-title">${head}
    <div class="recon-body"><ol class="recon-lanes" aria-hidden="true">${laneRows}${copyRows}</ol>
      <div class="recon-scroll"><svg class="recon-svg" data-count="${writes.length}" viewBox="0 0 ${cols.width} ${height}" width="${cols.width}" height="${height}" tabindex="0" role="group" aria-roledescription="commit graph" aria-label="${escape(`Committed writes, ${lanes.length} attempt lanes, one column per source event`)}" aria-describedby="recon-summary">${highlight}${branches}${curves}${ticks}${lost}${copy}${ring}</svg></div></div>
    <div class="recon-log" id="recon-log">${columnLog(activeW)}</div>
    <div class="recon-legend graph-legend" aria-hidden="true">${legend}${lostKey}${copyKey}</div>
    <p class="recon-summary" id="recon-summary">${text(summary)}<span class="sr-only"> ${text(described.slice(summary.length + 1))}</span></p>
    <p class="sr-only" id="recon-live" aria-live="polite"></p>${runsCompare(model)}</section>`;
}

// Compared runs, under the timeline: one row per run on this case (the offline script, then each
// recorded Meta run), marking the writes that run cancels in the same columns as the writes above.
// The rows compare sets of order IDs taken only from the engine's plan and from each recording's own
// verified review; nothing here decides what repeats. A recording whose inputs differ from this case,
// or that has no verified review, is listed but never compared.
function recDetail(caseId, id) {
  const key = `${caseId}:${id}`;
  if (!state.recDetails.has(key)) {
    const entry = {status: 'loading', data: null};
    state.recDetails.set(key, entry);
    api(`/api/recordings/${encodeURIComponent(id)}`).then(data => { entry.status = 'ok'; entry.data = data; }, () => { entry.status = 'error'; })
      .then(() => {
        const pending = [...state.recDetails].some(([k, e]) => k.startsWith(`${caseId}:`) && e.status === 'loading');
        if (!pending && state.incident?.id === caseId && state.tab === 'investigation') renderPanel();
      });
  }
  return state.recDetails.get(key);
}

const CMP_PHRASE = {
  same: (e, rehearsed) => rehearsed ? [`cancels the same ${e} writes as the script`, `cancel the same ${e} writes as the script`]
    : [`cancels the same ${e} writes the script targets`, `cancel the same ${e} writes the script targets`],
  differ: () => ['differs from the script', 'differ from the script'],
  stop: (asScript) => [`stopped instead of repairing${asScript}`, `stopped instead of repairing${asScript}`],
  incomplete: () => ['did not finish', 'did not finish'],
  error: () => ['ended with an error', 'ended with an error'],
  skipped: () => ['was not compared', 'were not compared'],
  loading: () => ['is still loading', 'are still loading'],
};

function runsCompare(model) {
  const list = recordedList();
  if (list.status !== 'ok' || !list.list.length || !model?.writes?.length) return '';
  const caseId = state.incident.id, recs = list.list;
  const byOrder = new Map(model.writes.map(w => [w.order_id, w]));
  const run = state.run?.incident_id === caseId ? state.run : null;
  const engine = run?.plan ? new Set(run.plan.cancellations.map(a => a.order_id)) : null, rehearsed = !!run?.review;
  const rows = [{label: 'Script baseline', current: !recordedMode(), attrs: 'data-source="script"', set: engine, script: true,
    line: engine ? '' : run?.status === 'stopped' ? 'stop' : '',
    note: engine ? `${rehearsed ? 'cancels' : 'targets'} ${engine.size}` : run?.status === 'stopped' ? `stopped · ${run.missing_event_ids?.length ?? 0} events unmatched` : run ? statusOf(run)[0] : 'not investigated yet',
    short: engine ? `× ${engine.size}` : run?.status === 'stopped' ? 'stopped' : run ? statusOf(run)[0] : 'not run'}];
  const tally = {same: 0, differ: 0, repair: 0, stop: 0, incomplete: 0, error: 0, skipped: 0, loading: 0}, sizes = new Set();
  recs.forEach((r, i) => {
    const row = {label: `Meta run ${recs.length - i}`, current: recordedMode() && r.id === state.recId, attrs: `data-source="recorded" data-recording="${escape(r.id)}"`, set: null, line: ''};
    rows.push(row);
    row.short = 'not compared';
    if (r.fixture_matches === false) { row.note = 'inputs differ · not compared'; tally.skipped++; return; }
    if (r.outcome === 'stop') { Object.assign(row, {line: 'stop', note: 'stopped · no repair', short: 'stopped'}); tally.stop++; return; }
    if (r.outcome === 'error') { Object.assign(row, {line: 'error', note: 'error · no repair', short: 'error'}); tally.error++; return; }
    if (r.outcome === 'incomplete') { Object.assign(row, {line: 'error', note: 'did not finish', short: 'unfinished'}); tally.incomplete++; return; }
    if (r.outcome !== 'repair') { row.note = `${recOutcome(r)[0]} · not compared`; tally.skipped++; return; }
    const entry = recDetail(caseId, r.id), d = entry.data;
    if (entry.status === 'loading') { Object.assign(row, {note: 'loading…', short: '…'}); tally.loading++; return; }
    if (!d || !d.review || d.citations_enabled !== true || d.incident_id !== caseId || d.fixture_matches !== true) {
      row.note = !d ? 'unavailable · not compared' : !d.review ? 'no verified review' : 'inputs differ · not compared'; tally.skipped++; return;
    }
    row.set = new Set(d.review.changes.map(c => c.before.id));
    sizes.add(row.set.size);
    const outside = [...row.set].filter(id => !byOrder.has(id)).length;
    if (engine) {
      const agree = [...row.set].filter(id => engine.has(id)).length, extra = row.set.size - agree, missed = engine.size - agree;
      row.note = !extra && !missed ? `same ${row.set.size} as the script`
        : [`${agree} of ${engine.size} match`, missed ? `misses ${missed}` : '', extra ? `${extra} not in the script` : ''].filter(Boolean).join(' · ');
      row.short = !extra && !missed ? '= script' : 'differs';
      tally[!extra && !missed ? 'same' : 'differ']++;
    } else { Object.assign(row, {note: `cancels ${row.set.size}`, short: `× ${row.set.size}`}); tally.repair++; }
    if (outside) row.note += ` · ${outside} outside the evidence`;
  });

  // One sentence that says what the rows show.
  const asScript = run?.status === 'stopped' ? ', as the script did' : '';
  const parts = [];
  if (tally.same) parts.push([tally.same, ...CMP_PHRASE.same(engine.size, rehearsed)]);
  if (tally.differ) parts.push([tally.differ, ...CMP_PHRASE.differ()]);
  if (tally.repair) parts.push(sizes.size === 1
    ? [tally.repair, `cancels ${[...sizes][0]} writes`, `cancel ${[...sizes][0]} writes each`]
    : [tally.repair, 'proposes a repair', 'propose a repair']);
  for (const key of ['stop', 'incomplete', 'error', 'skipped', 'loading']) if (tally[key]) parts.push([tally[key], ...CMP_PHRASE[key](asScript)]);
  const total = recs.length;
  let headline;
  if (parts.length === 1 && parts[0][0] === total) headline = total === 1 ? `The recorded Meta run ${parts[0][1]}.` : `All ${total} recorded Meta runs ${parts[0][2]}.`;
  else {
    const phrases = parts.map(([k, one, many]) => `${k} ${k === 1 ? one : many}`);
    headline = `${total} recorded Meta ${total === 1 ? 'run' : 'runs'}: ${phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : phrases[0]}.`;
  }
  if (!run && tally.repair) headline += ' Investigate the incident to compare them with the script.';

  const H = RECON_LANE, cols = graphColumns(model), n = cols.width;
  let anyMissed = false, anyExtra = false, anyPlanned = false;
  const svgRows = rows.map((row, i) => {
    const y = i * H, band = `<rect class="recon-band${i % 2 ? ' alt' : ''}${row.current ? ' current' : ''}" x="0" y="${y}" width="${n}" height="${H}"/>`;
    if (!row.set) return `${band}<line class="cmp-line${row.line ? ` ${row.line}` : ''}" x1="0" x2="${n}" y1="${y + H / 2}" y2="${y + H / 2}"/>`;
    const marks = model.writes.map(w => {
      const mine = row.set.has(w.order_id), base = engine?.has(w.order_id);
      if (mine) {
        const extra = !row.script && engine && !base, planned = row.script && !rehearsed;
        anyExtra = anyExtra || extra; anyPlanned = anyPlanned || planned;
        const says = planned ? 'the script targets it · not rehearsed yet' : `${row.label} cancels it${row.script || !engine ? '' : base ? (rehearsed ? ' · so does the script' : ' · the script targets it too') : ' · the script keeps it'}`;
        return `<rect class="cmp-mark${extra ? ' extra' : ''}${planned ? ' planned' : ''}" x="${cols.cx(w.col) - 3}" y="${y + 5}" width="6" height="${H - 10}" rx="1"><title>${text(`${w.order_id} · ${says}`)}</title></rect>`;
      }
      if (!row.script && engine && base) {
        anyMissed = true;
        return `<rect class="cmp-missed" x="${cols.cx(w.col) - 2.5}" y="${y + 6}" width="5" height="${H - 12}" rx="1"><title>${text(`${w.order_id} · the script ${rehearsed ? 'cancels' : 'targets'} it · ${row.label} keeps it`)}</title></rect>`;
      }
      return '';
    }).join('');
    return band + marks;
  }).join('');
  const labels = rows.map(row => `<li><button class="compare-run${row.current ? ' current' : ''}" ${row.attrs} ${row.current ? 'aria-current="true"' : ''} title="${escape(`${row.label} · ${row.note}`)}"><strong>${text(row.label)}</strong><span class="cmp-long">${text(row.note)}</span><span class="cmp-short" aria-hidden="true">${text(row.short)}</span></button></li>`).join('');
  const legend = `<span><i class="repeat"></i>Cancelled by that run</span>${anyPlanned ? '<span><i class="planned"></i>Script’s target · not rehearsed yet</span>' : ''}${anyMissed ? `<span><i class="missed"></i>${rehearsed ? 'Cancelled' : 'Targeted'} by the script, kept by that run</span>` : ''}${anyExtra ? '<span><i class="extra"></i>Not in the script’s plan</span>' : ''}<span><i class="line"></i>No repair</span>`;
  return `<div class="recon-compare">
    <div class="recon-head"><h4 id="compare-title">Compared runs</h4><span class="caption">In the same columns as the graph above. Recordings show their verified reviews; the script shows its ${rehearsed ? 'test on a copy' : 'proposal'}.</span></div>
    <div class="recon-body"><ol class="recon-lanes compare-lanes" aria-labelledby="compare-title">${labels}</ol>
      <div class="recon-scroll"><svg class="compare-svg" viewBox="0 0 ${n} ${rows.length * H}" width="${n}" height="${rows.length * H}" aria-hidden="true" focusable="false">${svgRows}</svg></div></div>
    <div class="recon-legend" aria-hidden="true">${legend}</div>
    <p class="recon-summary">${text(headline)}</p>
  </div>`;
}

// Keyboard: one tab stop. Left and right move through the commits in order, up and down between writes
// of the same source event; Enter opens the order (same as clicking a commit).
function moveRecon(svg, key) {
  const writes = reconCtx?.writes || [], n = writes.length;
  if (!n) return false;
  const moves = {ArrowRight: 1, ArrowLeft: -1, PageDown: 10, PageUp: -10};
  const cur = Number.isInteger(state.reconActive) && state.reconActive < n ? state.reconActive : -1;
  let next;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = n - 1;
  else if (key in moves) next = Math.max(0, Math.min(n - 1, cur < 0 && moves[key] < 0 ? 0 : cur + moves[key]));
  else if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (cur < 0) return false;
    const w = writes[cur], same = writes.filter(x => x.col === w.col).sort((a, b) => reconCtx.laneOf.get(a.attempt) - reconCtx.laneOf.get(b.attempt));
    const to = same[same.indexOf(w) + (key === 'ArrowDown' ? 1 : -1)];
    next = to ? to.x : cur;
  } else return false;
  showColumn(next);
  const live = $('#recon-live'), dot = svg.querySelector?.(`[data-i="${next}"]`);
  if (live && dot) live.textContent = dot.querySelector('title')?.textContent || '';
  return true;
}

function investigationView() {
  const {run} = state;
  if (!run) return `${incidentOverview()}${reconstructionView()}${sourceRecords()}`;
  const stopped = run.status === 'stopped';
  // With a plan, the timeline below states the finding; only a stop or a run without a plan needs a heading.
  const result = stopped || !run.plan ? `<div class="section-heading"><h2>${stopped ? 'Evidence needed to continue' : 'Investigation result'}</h2></div>
    <div class="callout ${stopped?'stop':''}"><strong>${stopped?'No repair exported.':'What the script found'}</strong><br>${text(run.summary)}</div>` : '';
  const plan = run.plan ? `<div class="row-head"><h3>Proposed cancellations</h3>${badge(`${run.plan.cancellations.length} targets`)}</div>
    <p class="small muted">Keep the first recorded write for each source event. Each target cites both committed writes; select a row to inspect them.${run.status==='proposed'?' Next: test it on a copy.':''}</p>${planTable(run.plan)}` : '';
  const stop = stopped ? `<h3>Next useful step</h3><p class="small">Recover the committed-write logs for the missing source events, then investigate again. The source has not been changed.</p>
    <div class="row-head" id="missing-events" tabindex="-1"><h4>${run.missing_event_ids.length} source events without commit evidence</h4><span class="caption">Select one to find it in the evidence</span></div>
    <div class="id-grid">${run.missing_event_ids.map(id=>`<button class="id-chip mono" data-key="event:${escape(id)}" aria-selected="false">${text(id)}</button>`).join('')}</div>` : '';
  const recon = reconstructionView(run.plan ? run.plan.cancellations : null, {stopped: stopped ? run.missing_event_ids.length : null, rehearsed: !!run.review});
  return `${result}${recon}${plan}${stop}${callsView(run.trace)}<details class="fold"><summary>Incident overview and source records</summary>${incidentOverview()}${sourceRecords()}</details>`;
}

function orderTable(rows) {
  return table(['Purchase','Order','Status','Source reference'],
    rows.map(o=>[purchaseCell(o),idRef(o.id),text(o.status),`<span class="mono">${text(o.source_reference||'—')}</span>`]),
    rows.map(o=>selAttrs(`order:${o.id}`)));
}

// Citation shortcuts inside a selectable row. Keyboard users select the row (one tab stop per row);
// the details panel then lists the same citations with links into Evidence. When a recording's
// citations are disabled, the server's recorded text is shown as plain text and never linkified.
function citations(action) {
  if (!active().citations) return `<span class="mono ref-text">${text(action.recorded_evidence_refs_text || action.evidence_refs.join(', ') || '—')}</span>`;
  return `<span class="citations">${action.evidence_refs.map(ref=>`<button class="citation" tabindex="-1" data-key="order:${escape(action.order_id)}" data-focus-ref="${escape(ref)}">${text(ref)}</button>`).join('')}</span>`;
}

function planTable(plan) {
  const orders = ordersById();
  return table(['Purchase','Cancel duplicate','Original order','Evidence'],
    plan.cancellations.map(a=>[purchaseCell(orders.get(a.order_id)),idRef(a.order_id,'cancelled'),idRef(a.duplicate_of),citations(a)]),
    plan.cancellations.map(a=>selAttrs(`order:${a.order_id}`)));
}

/* ---------- Recorded model runs (read-only history) ---------- */

const fmtNum = (n) => Number.isFinite(n) ? n.toLocaleString() : '—';
const recordingLabel = (r) => r?.provenance?.label || REC_LABEL;
const recordedList = () => state.recordings.get(state.incident?.id) || {status: 'loading', list: []};

// The public demo's choices from its checked dataset: the case and recording it opens on, and its evaluation
// notes. The local workbench has none of these. Defaults never name a recording directly: they are used only
// where the recording is listed for that case with inputs that match it.
function staticContract(d) {
  const def = plainObject(d?.defaults) ? d.defaults : null;
  const defaults = def && def.source === 'recorded' && typeof def.incident_id === 'string' && typeof def.recording_id === 'string'
    ? {incident_id: def.incident_id, recording_id: def.recording_id} : null;
  return {defaults, evaluation: plainObject(d?.evaluation) ? d.evaluation : null};
}

// The recorded Meta run a case opens on: the dataset's default for this case if it is listed with matching
// inputs, otherwise the newest recording whose inputs match. A case without one opens on the script baseline.
function demoDefault(caseId) {
  const usable = (state.recordings.get(caseId)?.list || []).filter(r => r.fixture_matches === true);
  const def = state.demo?.defaults;
  return (def?.incident_id === caseId && usable.find(r => r.id === def.recording_id)) || usable[0] || null;
}

// The case the public demo opens on: the dataset's default case, only while its default recording is usable.
function demoStartCase() {
  const def = state.demo?.defaults;
  return def && state.cases.some(c => c.id === def.incident_id) && demoDefault(def.incident_id)?.id === def.recording_id ? def.incident_id : null;
}

async function refreshRecordings(caseId) {
  const previous = state.recordings.get(caseId);
  if (!previous) state.recordings.set(caseId, {status: 'loading', list: []});
  try {
    const list = await api(`/api/incidents/${encodeURIComponent(caseId)}/recordings`);
    state.recordings.set(caseId, {status: 'ok', list: Array.isArray(list) ? list : []});
    for (const key of [...state.recDetails.keys()]) if (key.startsWith(`${caseId}:`)) state.recDetails.delete(key);
  } catch (error) {
    state.recordings.set(caseId, {status: 'error', list: previous?.list || [], error: error.message});
  }
  return state.recordings.get(caseId);
}

// Loads one recording for the case on screen. Every request refetches, because the server rechecks the
// fixture match each time. A late response for another case or selection is dropped.
async function loadRecording(id, {renderNow = true} = {}) {
  const caseId = state.incident.id, seq = ++state.recSeq;
  resetReplay();
  Object.assign(state, {recId: id, recording: null, selection: null, sheet: false, stepFilter: 'all'});
  if (renderNow) render();
  try {
    const detail = await api(`/api/recordings/${encodeURIComponent(id)}`);
    if (seq !== state.recSeq || state.incident?.id !== caseId) return;
    state.recDetails.set(`${caseId}:${id}`, {status: 'ok', data: detail});
    transition(() => { if (seq === state.recSeq && state.incident?.id === caseId) { state.recording = detail; render(); } }, 'case');
  } catch (error) {
    if (seq !== state.recSeq || state.incident?.id !== caseId) return;
    Object.assign(state, {recId: null, recording: null});
    if (error.status === 404) {
      notice('That recording is no longer available in this server session, for example after a server restart. Choose one from the refreshed list.');
      await refreshRecordings(caseId);
    } else notice(`Recording unavailable: ${error.message}`);
    if (state.incident?.id === caseId) render();
  }
}

// pick: a recording to open (from the sidebar's attempt list); otherwise the newest, if none is open.
function setSource(source, pick = null) {
  if (!['script', 'recorded'].includes(source) || !state.incident) return;
  state.sourceChosen = true;
  if (source === state.source) { if (source === 'recorded' && pick && pick !== state.recId) loadRecording(pick); return; }
  resetReplay();
  Object.assign(state, {source, selection: null, sheet: false});
  const target = pick || (!state.recId && (demoDefault(state.incident.id)?.id || recordedList().list[0]?.id));
  if (source === 'recorded' && target) loadRecording(target, {renderNow: false});
  transition(() => render(), 'case');
}

function recordedPending() {
  const list = recordedList();
  if (list.status === 'loading') return `<div class="rec-loading">${skeleton(8)}</div>`;
  if (list.status === 'error') return `<div class="callout stop">${text(`Recorded runs could not be loaded: ${list.error}`)}</div><button class="secondary" data-refresh-recordings>${icon('refresh-cw')}<span>Try again</span></button>`;
  if (!list.list.length) return emptyState('No recorded model runs for this case', 'Recordings are imported from saved command-line agent runs. This page never starts a live model run.', 'history');
  if (!state.recId) return emptyState('Choose a recorded run', 'Pick a recording from the list in the sidebar.', 'history');
  return `<div class="rec-loading">${skeleton(10)}</div>`;
}

function recBanner(r, compact = false, observation = false) {
  const p = r.provenance || {};
  const when = recordedAt(p.recorded_at) || 'time not recorded';
  const source = p.timestamp_source ? ` (${TIMESTAMP_SOURCE[p.timestamp_source] || p.timestamp_source.replaceAll('_', ' ')})` : '';
  const line = compact
    ? `<span>${text(`${p.model || 'Model not recorded'} · recorded ${recordedShort(p.recorded_at)}`)}</span>`
    : `<span>${text(`${p.model || 'Model not recorded'} · recorded ${when}${source}`)}</span>`;
  return `<div class="rec-banner${compact ? ' compact' : ''}">${icon('history')}<div><strong>${text(recordingLabel(r))}</strong>${line}</div></div>
    ${observation ? `<p class="rec-observation">${icon('history')}<span>${text(r.review_observation || 'Recorded in the test on a copy; not a current export check.')}</span></p>` : ''}
    ${r.fixture_matches === false || r.fixture_warning ? `<div class="callout stop rec-warning">${icon('triangle-alert')}<span>${text(r.fixture_warning || 'Recording inputs do not match the served case. Current-case citations are disabled.')}</span></div>` : ''}
    ${r.incident_id !== state.incident?.id ? `<div class="callout stop rec-warning">${icon('triangle-alert')}<span>${text(`This recording belongs to another case (${r.incident_id}). Links into the current case are disabled.`)}</span></div>` : ''}`;
}

// Evidence references: links into the current inspector only when allowed; otherwise plain recorded text.
function refsView(refs, recordedText) {
  if (active().citations && Array.isArray(refs) && refs.length) return `<span class="citations">${refs.map(ref => `<button class="citation" data-open-ref="${escape(ref)}">${text(ref)}</button>`).join('')}</span>`;
  return `<span class="mono ref-text">${text(recordedText || (Array.isArray(refs) ? refs.join(', ') : '') || '—')}</span>`;
}

function argSummary(call) {
  const a = call.arguments;
  if (call.name === 'read_artifact' && a && typeof a === 'object') return `${a.name ?? ''}${a.start_line ? ` · from L${a.start_line}` : ''}${a.max_lines ? ` · up to ${a.max_lines} lines` : ''}`;
  if (call.name === 'query_database' && a?.sql) return String(a.sql).replace(/\s+/g, ' ').slice(0, 96);
  if (call.name === 'rehearse_repair' && a?.plan) return `${(a.plan.cancellations || []).length} proposed cancellations`;
  if (a && typeof a === 'object' && !Array.isArray(a) && !Object.keys(a).length) return 'no arguments';
  return JSON.stringify(a ?? null).slice(0, 96);
}

const argsTitle = (call) => call.name === 'rehearse_repair' && call.arguments?.plan ? 'Proposed plan' : call.name === 'query_database' && call.arguments?.sql ? 'Read-only SQL' : 'Arguments';

function argsView(call, heading = true) {
  const a = call.arguments, h = heading ? `<h4>${argsTitle(call)}</h4>` : '';
  if (call.name === 'rehearse_repair' && a?.plan) {
    const rows = a.plan.cancellations || [];
    return `${h}${a.plan.rationale ? `<p class="tl-text">${text(a.plan.rationale)}</p>` : ''}
      ${rows.length ? table(['Cancel', 'Original order', 'Cited evidence'], rows.map(c => [`<span class="mono cancelled">${text(c.order_id)}</span>`, `<span class="mono">${text(c.duplicate_of)}</span>`, refsView(c.evidence_refs, c.recorded_evidence_refs_text)])) : '<p class="caption">No cancellations in this plan.</p>'}`;
  }
  if (call.name === 'query_database' && a?.sql) return `${h}<pre class="tl-sql">${String(a.sql).split(/\r?\n/).map(sqlTint).join('\n')}</pre>`;
  return `${h}<pre>${text(JSON.stringify(a ?? null, null, 2))}</pre>`;
}

function resultView(call, res) {
  const v = res.result;
  if (res.error) return `<div class="tl-error">${icon('circle-x')}<div><strong>Rejected by the local runtime</strong><p>${text(v && typeof v === 'object' && 'error' in v ? v.error : JSON.stringify(v))}</p></div></div>`;
  if (call.name === 'rehearse_repair' && v && Array.isArray(v.checks)) {
    const ok = v.checks.filter(c => c.passed).length;
    return `<h4>Test result on a copy</h4><p class="small">${v.passed ? 'Passed' : 'Did not pass'} · ${ok}/${v.checks.length} checks${v.status ? ` · ${text(v.status)}` : ''}</p>
      <ul class="tl-checks">${v.checks.map(c => `<li class="${c.passed ? '' : 'fail'}">${icon(c.passed ? 'check' : 'x')}<span>${text(checkName(c.name))}</span></li>`).join('')}</ul>`;
  }
  if (call.name === 'read_artifact' && v && Array.isArray(v.lines)) {
    const shown = v.lines.slice(0, 12);
    return `<h4>Lines returned</h4><p class="caption">${text(`${v.lines.length} of ${v.total_lines ?? '?'} lines from ${v.name ?? 'the file'}`)}</p>
      <div class="tl-lines">${shown.map(l => `<div class="tl-line">${refsView(l.ref ? [l.ref] : [], l.recorded_ref_text)}<span class="lt">${text(l.text)}</span></div>`).join('')}</div>
      ${v.lines.length > shown.length ? `<p class="caption">${text(`${v.lines.length - shown.length} more lines are in this recording.`)}</p>` : ''}`;
  }
  if (call.name === 'query_database' && v && Array.isArray(v.rows)) {
    const cols = Array.isArray(v.columns) ? v.columns : Object.keys(v.rows[0] || {});
    return `<h4>Rows returned · ${v.rows.length}${v.truncated ? '+' : ''}</h4>${v.rows.length ? table(cols.map(text), v.rows.slice(0, 6).map(row => cols.map(c => `<span class="mono">${text(row[c] ?? 'NULL')}</span>`))) : '<p class="caption">No rows.</p>'}${v.rows.length > 6 ? `<p class="caption">${text(`${v.rows.length - 6} more rows are in this recording.`)}</p>` : ''}`;
  }
  return `<h4>Result</h4><pre>${text(JSON.stringify(v ?? null, null, 2))}</pre>`;
}

// Conclusions before detail: the runtime's rejection (or the rehearsal result) leads, and the proposed
// arguments follow behind a disclosure. Other calls read naturally as arguments, then result.
function callDetail(call, res, executed) {
  if (!executed) return `${argsView(call)}<p class="caption">This call was recorded without an executed result, so it is not shown as completed.</p>`;
  if (res.error || call.name === 'rehearse_repair') return `${resultView(call, res)}<details class="tl-args"><summary>${res.error ? `Rejected ${argsTitle(call).toLowerCase()}` : argsTitle(call)}</summary>${argsView(call, false)}</details>`;
  return `${argsView(call)}${resultView(call, res)}`;
}

function callItem(call, res, n) {
  const executed = call.has_result !== false && !!res;
  const [status, tone] = !executed ? ['Requested · no result recorded', ''] : res.error ? ['Rejected', 'danger'] : ['Result recorded', 'ok'];
  const open = !!res?.error || call.name === 'rehearse_repair';
  return `<li class="tl-item tl-call${res?.error ? ' rejected' : ''}${executed ? '' : ' pending'}"><span class="tl-dot">${icon(res?.error ? 'circle-x' : 'wrench')}</span>
    <details class="tl-card"${open ? ' open' : ''}><summary class="tl-head"><span class="tl-no">${pad(n)}</span><span class="tool mono">${text(call.name)}</span><span class="tl-arg mono">${text(argSummary(call))}</span>${call.truncated || res?.truncated ? badge('Truncated preview') : ''}${badge(status, tone)}</summary>
      <div class="tl-detail">${callDetail(call, res, executed)}</div></details></li>`;
}

function assistantItem(step, n) {
  return `<li class="tl-item tl-assistant"><span class="tl-dot">${icon('bot')}</span><div class="tl-card"><div class="tl-head"><span class="tl-no">${pad(n)}</span><span class="tl-kind">Model message</span></div>
    <p class="tl-text">${step.text ? text(step.text) : '<span class="faint">No text in this response.</span>'}</p></div></li>`;
}

// The steps as listed, in recorded order: each result sits inside its call, so a call and its result are one
// numbered step. The list, the replay and the guardrail card all use this numbering.
function displayedSteps(r) {
  const results = new Map(r.steps.filter(s => s.kind === 'tool_result').map(s => [s.call_id, s]));
  const callIds = new Set(r.steps.filter(s => s.kind === 'tool_call').map(s => s.call_id));
  const out = [];
  for (const step of r.steps) {
    if (step.kind === 'tool_result' && callIds.has(step.call_id)) continue; // shown inside its call
    out.push({step, res: step.kind === 'tool_call' ? results.get(step.call_id) || null : null, n: out.length + 1});
  }
  return out;
}

function timelineItems(r) {
  const replay = replayFor(r), out = [];
  for (const {step, res, n} of displayedSteps(r)) {
    const rejected = step.kind === 'tool_call' ? !!res?.error : step.kind === 'tool_result' && step.error;
    // A replay shows every step in order; the filters apply only outside a replay.
    if (!replay && state.stepFilter === 'tools' && step.kind === 'assistant') continue;
    if (!replay && state.stepFilter === 'messages' && step.kind !== 'assistant') continue;
    if (!replay && state.stepFilter === 'rejected' && !rejected) continue;
    const item = step.kind === 'assistant' ? assistantItem(step, n) : step.kind === 'tool_call' ? callItem(step, res, n)
      : `<li class="tl-item tl-call${step.error ? ' rejected' : ''}"><span class="tl-dot">${icon('info')}</span><div class="tl-card"><div class="tl-head"><span class="tl-no">${pad(n)}</span><span class="tl-kind">Result without a matching call</span></div><div class="tl-detail"><pre>${text(JSON.stringify(step.result ?? null, null, 2))}</pre></div></div></li>`;
    const attrs = ` data-seq="${n}"${replay && n > replay.cursor ? ' hidden' : ''}${replay && n === replay.cursor ? ' aria-current="step"' : ''}`;
    out.push(item.replace('<li ', `<li${attrs} `));
  }
  return out.join('') || '<li class="tl-empty">No steps match this filter.</li>';
}

// One plain line for a listed step, for announcements and the guardrail card.
const TOOL_PLAIN = {rehearse_repair: 'Proposed repair', read_artifact: 'File read', query_database: 'Database query', get_schema: 'Schema read', list_artifacts: 'File list'};
function stepSummary({step, res}) {
  if (step.kind === 'assistant') return 'Model message';
  if (step.kind !== 'tool_call') return 'Result without a matching call';
  const what = TOOL_PLAIN[step.name] || step.name;
  return `${what} (${step.name}): ${!res || step.has_result === false ? 'no result recorded' : res.error ? 'rejected by the local runtime' : 'result recorded'}`;
}

/* ---------- The guardrail moment: a recorded rejection and the correction that followed ---------- */

// From the saved steps only: a call the local runtime rejected (a proposed repair first, if there is one),
// the model's messages that followed, verbatim, any further rejections of the same tool, and the next call
// of that tool the runtime accepted. Nothing is inferred about the model's reasoning.
// A test on a copy is accepted only when its saved result says it passed and lists checks that all passed;
// any other rehearsal result is a failed attempt, whatever its error flag. Reads and queries are accepted
// when the local runtime did not mark them as errors.
const rehearsalPassed = (res) => {
  const v = res?.result;
  return !!res && !res.error && plainObject(v) && v.passed === true && Array.isArray(v.checks) && v.checks.length > 0 && v.checks.every(c => c?.passed === true);
};
const answered = (i) => i.step.kind === 'tool_call' && i.step.has_result !== false && !!i.res;
const acceptedCall = (i) => answered(i) && (i.step.name === 'rehearse_repair' ? rehearsalPassed(i.res) : !i.res.error);
const failedCall = (i) => answered(i) && !acceptedCall(i);

// The first failed attempt (repairs first) that a later call of the same tool corrected, with the model's
// messages and the further failed attempts in between. No accepted correction, no moment.
function guardrailMoment(r) {
  if (!r?.steps) return null;
  const items = displayedSteps(r), failed = items.filter(failedCall);
  const ordered = [...failed.filter(i => i.step.name === 'rehearse_repair'), ...failed.filter(i => i.step.name !== 'rehearse_repair')];
  for (const bad of ordered) {
    const fixed = items.find(i => i.n > bad.n && i.step.name === bad.step.name && acceptedCall(i));
    if (!fixed) continue;
    const between = items.filter(i => i.n > bad.n && i.n < fixed.n);
    const shown = (i) => i.step.kind === 'assistant' || (i.step.name === bad.step.name && failedCall(i));
    return {bad, fixed, between: between.filter(shown), others: between.filter(i => !shown(i)).length};
  }
  return null;
}

// What a failed attempt's saved result says: the runtime's rejection message, or how many checks passed.
function attemptText(res) {
  const v = res?.result;
  if (plainObject(v) && !('error' in v) && Array.isArray(v.checks) && v.checks.length) {
    const ok = v.checks.filter(c => c?.passed === true).length;
    return {quote: false, words: `Tested on a copy: ${ok} of ${v.checks.length} checks passed, so the test did not pass.`};
  }
  return {quote: true, words: rejectionText(res)};
}

function guardrailView(r) {
  const m = guardrailMoment(r);
  if (!m) return '';
  const what = TOOL_PLAIN[m.bad.step.name] || m.bad.step.name;
  const quote = (i) => { const a = attemptText(i.res); return a.quote ? `<blockquote class="g-quote">${text(a.words)}</blockquote>` : `<p class="g-text">${text(a.words)}</p>`; };
  const failedTitle = (i, again) => i.res.error ? (again ? 'Rejected again' : `${what} rejected by the local runtime`) : (again ? 'Checks failed again' : `${what} failed its checks on a copy`);
  const message = (i) => {
    const words = String(i.step.text || '');
    if (!words) return '<p class="caption">No text in this response.</p>';
    return words.length > 280 ? `<details class="g-more"><summary>${text(words.slice(0, 280))}…</summary><p class="g-text">${text(words)}</p></details>` : `<p class="g-text">${text(words)}</p>`;
  };
  const checks = m.fixed.step.name === 'rehearse_repair' ? m.fixed.res.result.checks : null;
  const accepted = checks ? `Tested on a copy: ${checks.length} of ${checks.length} checks passed.` : 'Accepted by the local runtime; its result is in the recorded steps.';
  const rows = [`<li class="g-step bad"><span class="g-no">Step ${m.bad.n}</span><div><strong>${text(failedTitle(m.bad, false))}</strong>${quote(m.bad)}</div></li>`,
    ...m.between.map(i => i.step.kind === 'assistant'
      ? `<li class="g-step msg"><span class="g-no">Step ${i.n}</span><div><strong>The model’s next message, verbatim</strong>${message(i)}</div></li>`
      : `<li class="g-step bad"><span class="g-no">Step ${i.n}</span><div><strong>${text(failedTitle(i, true))}</strong>${quote(i)}</div></li>`),
    `<li class="g-step good"><span class="g-no">Step ${m.fixed.n}</span><div><strong>Next ${text(what.toLowerCase())} accepted</strong><p class="g-text">${text(accepted)}</p></div></li>`];
  return `<section class="guardrail" aria-labelledby="guardrail-title">
    <div class="guardrail-head"><h3 id="guardrail-title">Caught by the guardrail</h3><span class="caption">From this recording’s saved steps${m.others ? `, with ${m.others} other ${m.others === 1 ? 'step' : 'steps'} in between` : ''}.</span></div>
    <ol class="guardrail-steps">${rows.join('')}</ol>
    <button class="secondary" data-replay-from="${m.bad.n}">${icon('play')}<span>Replay from step ${m.bad.n}</span></button>
  </section>`;
}

/* ---------- How we evaluated: every recorded outcome, the failures kept, and the limits ---------- */

const wordsOf = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const JUDGMENT = {correct_repair: 'Correct repair', justified_stop: 'Justified stop', unsupported_format: 'Refused: unsupported format'};
const judged = (v) => JUDGMENT[v] || String(v || 'not recorded').replaceAll('_', ' ');

// The public dataset's locked new-format attempts, as recorded: each attempt's outcome, its independent
// judgment and what the adapted and frozen scripts did on the same case. Nothing is derived beyond counts.
function storyData(s) {
  if (!plainObject(s) || !Array.isArray(s.attempts)) return null;
  const attempts = s.attempts.filter(plainObject).map(a => ({incident: String(a.incident_id || ''), seed: Number.isInteger(a.seed) ? a.seed : null,
    outcome: String(a.outcome || 'unknown'), judgment: String(a.judgment || ''), adapted: String(a.adapted_parser || ''), frozen: String(a.frozen_parser || '')}));
  return {attempts, model: wordsOf(s.configuration?.model), scope: wordsOf(s.scope),
    planned: Number.isInteger(s.planned_attempts) ? s.planned_attempts : attempts.length, unattempted: Array.isArray(s.unattempted) ? s.unattempted.length : 0,
    tokens: Number.isInteger(s.usage?.total_tokens) ? s.usage.total_tokens : null,
    repairs: attempts.filter(a => a.judgment === 'correct_repair').length, stops: attempts.filter(a => a.judgment === 'justified_stop').length,
    sameAsScript: attempts.length > 0 && attempts.every(a => a.adapted === a.judgment),
    frozenRefused: attempts.filter(a => a.frozen === 'unsupported_format').length};
}

// Counts come only from the recording lists on screen (the server's, or the public dataset's), never from a
// stated total. The public dataset adds its scope wording and its locked new-format attempts.
function evaluationData() {
  const cases = state.cases.map(c => {
    const list = state.recordings.get(c.id)?.list || [];
    const newest = state.history.get(c.id)?.[0];
    return {id: c.id, title: c.title, baseline: newest ? statusOf(newest)[0] : null,
      runs: list.map((r, i) => ({n: list.length - i, id: r.id, outcome: r.outcome, inputsMatch: r.fixture_matches !== false, model: r.model}))};
  });
  const runs = cases.flatMap(c => c.runs), count = (o) => runs.filter(r => r.outcome === o).length;
  const ev = state.demo?.evaluation;
  return {cases, total: runs.length, repairs: count('repair'), stops: count('stop'), errors: count('error'), incomplete: count('incomplete'),
    other: runs.filter(r => !['repair', 'stop', 'error', 'incomplete'].includes(r.outcome)).length,
    mismatched: runs.filter(r => !r.inputsMatch).length, models: [...new Set(runs.map(r => r.model).filter(Boolean))],
    scope: wordsOf(ev?.scope), interpretation: wordsOf(ev?.interpretation), story: storyData(ev?.story)};
}

const RUN_CHIP = {repair: ['Repair, checks passed', 'ok'], stop: ['Stopped', 'warn'], error: ['Error', 'danger'], incomplete: ['Did not finish', 'danger']};
function evaluationView() {
  const e = evaluationData();
  const chip = (r) => { const [label, tone] = RUN_CHIP[r.outcome] || [String(r.outcome || 'unknown').replaceAll('_', ' '), '']; return `<span class="pill ${tone}">Run ${r.n} · ${text(label)}${r.inputsMatch ? '' : ' · inputs differ'}</span>`; };
  const parts = [[e.repairs, 'ended with a repair that passed its checks on a copy'], [e.stops, 'stopped without repairing'],
    [e.errors, 'ended with an error'], [e.incomplete, 'did not finish'], [e.other, 'ended another way']].filter(([n]) => n);
  return `<div class="eval-head"><h2 id="evaluation-title">How we evaluated</h2><button class="icon-button" data-close-evaluation aria-label="Close">${icon('x')}</button></div>
    <p class="eval-lede">Every saved Meta run is listed, including the ones that failed. ${e.models.length ? text(`They were recorded from the command line with ${e.models.join(', ')}.`) : ''} This page shows saved results; it never calls a model.</p>
    <p class="eval-totals"><strong>${text(e.total)}</strong> recorded runs on ${text(e.cases.length)} cases: ${parts.map(([n, what]) => `<strong>${text(n)}</strong> ${text(what)}`).join('; ')}.</p>
    ${table(['Case', 'Recorded Meta runs', 'Script baseline'], e.cases.map(c => [text(c.title), c.runs.length ? `<div class="eval-runs">${c.runs.map(chip).join('')}</div>` : '<span class="caption">No recordings</span>', text(c.baseline || 'Not run in this session')]))}
    ${storyView(e.story)}
    <h3>What this does not show</h3>
    <ul class="eval-limits">
      <li>The offline script solves the supported cases${e.story ? ', the inbox format included once adapted' : ''}: it proposes a repair where the evidence allows one and stops where evidence is missing. The recordings show the model reaching correct outcomes, not doing better than the script.</li>
      ${e.story ? '<li>The frozen parser refusing the new format does not show that a model is needed. These are authored development cases, not blind holdouts.</li>' : '<li>These are saved observations on authored development cases, not a success rate.</li>'}
      <li>Failed runs stay in the count and in the list. None is hidden, and none was replaced by a retry.</li>
      <li>Recorded runs are saved results, not live. Usage is shown per run as reported, and no cost is shown.</li>
      ${e.mismatched ? `<li>${text(`${e.mismatched} ${e.mismatched === 1 ? 'recording was' : 'recordings were'} made on inputs that differ from these case files. They are listed, but not compared.`)}</li>` : ''}
    </ul>
    ${e.scope || e.interpretation ? `<p class="caption">${text(['Dataset scope, as published:', e.scope, e.interpretation].filter(Boolean).join(' '))}</p>` : ''}
    <p class="caption">The note at the foot of every screen says the same: no AI advantage has been demonstrated on these cases.</p>`;
}

function storyView(s) {
  if (!s) return '';
  const n = s.attempts.length, titleOf = (id) => state.cases.find(c => c.id === id)?.title || id;
  const rows = s.attempts.map(a => [text(`${titleOf(a.incident)}${a.seed === null ? '' : ` · seed ${a.seed}`}`), text((RUN_CHIP[a.outcome] || [a.outcome])[0]),
    text(judged(a.judgment)), text(judged(a.adapted)), text(judged(a.frozen))]);
  const sentence = [`${s.planned} locked ${s.planned === 1 ? 'attempt' : 'attempts'}${s.model ? ` with ${s.model}` : ''}${s.unattempted ? `, ${s.unattempted} not attempted` : ''}.`,
    `Judged independently: ${s.repairs} correct ${s.repairs === 1 ? 'repair' : 'repairs'} and ${s.stops} justified ${s.stops === 1 ? 'stop' : 'stops'}.`,
    n ? (s.sameAsScript ? 'The adapted script reached the same result in every attempt.' : 'The adapted script did not reach the same result in every attempt.') : '',
    n && s.frozenRefused ? `The frozen parser refused the format in ${s.frozenRefused === n ? `all ${n}` : `${s.frozenRefused} of ${n}`}.` : ''].filter(Boolean).join(' ');
  return `<h3>New format: receipts in an inbox</h3>
    <p class="eval-story">${text(sentence)}</p>
    ${n ? table(['Attempt', 'Meta run', 'Independent judgment', 'Adapted script', 'Frozen parser'], rows) : ''}
    ${s.tokens !== null ? `<p class="caption">${text(`Usage for these attempts, as reported by the provider: ${s.tokens.toLocaleString('en-US')} tokens. No cost is inferred.`)}</p>` : ''}
    ${s.scope ? `<p class="caption">${text(s.scope)}</p>` : ''}`;
}

function openEvaluation() {
  const dialog = $('#evaluation');
  if (!dialog?.showModal) return;
  $('#evaluation-body').innerHTML = evaluationView();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-close-evaluation]')?.focus();
}

/* ---------- Replay: the saved steps, in recorded order, at a fixed pace ---------- */

// Recordings carry no per-step timing, so a replay reveals one saved step per REPLAY_MS and says so. Nothing
// runs again: each revealed step is the same recorded call, result or message as in the full list.
const REPLAY_MS = 1000;
let replayTimer = null;
const replayFor = (r) => (state.replay && r && state.replay.recId === r.id ? state.replay : null);
const replayTotal = () => (state.recording ? displayedSteps(state.recording).length : 0);
function stopReplayTimer() { if (replayTimer) { clearInterval(replayTimer); replayTimer = null; } }
function resetReplay() { stopReplayTimer(); state.replay = null; }

function replayControls(r) {
  const rp = replayFor(r), total = displayedSteps(r).length, playing = !!rp?.playing, ended = !!rp && rp.cursor >= total;
  if (!total) return '<div class="replay" id="replay-controls" role="group" aria-label="Replay of the saved steps"><span class="replay-status"><strong>No saved steps</strong><span>This recording has nothing to replay.</span></span></div>';
  return `<div class="replay" id="replay-controls" role="group" aria-label="Replay of the saved steps">
    <button class="secondary" data-replay="toggle" aria-pressed="${playing}">${icon(playing ? 'pause' : 'play')}<span>${playing ? 'Pause' : ended ? 'Play again' : 'Play'}</span></button>
    <button class="secondary" data-replay="next" ${ended ? 'disabled' : ''}>${icon('skip-forward')}<span>Next step</span></button>
    <button class="secondary" data-replay="restart" ${rp ? '' : 'disabled'}>${icon('rotate-ccw')}<span>Restart</span></button>
    <span class="replay-status"><strong>${rp ? `Step ${rp.cursor} of ${total}` : `${total} saved steps`}</strong><span>Replay of saved steps, one per second. Not live: nothing runs again.</span></span>
    ${rp ? '<button class="link small" data-replay="exit">Show all steps</button>' : ''}
  </div>`;
}

// Reveal up to the cursor without rebuilding the list (open cards stay open); keep focus on the control used.
function applyReplay(scroll = true) {
  const rp = state.replay, list = $('#content .timeline');
  if (!list?.querySelectorAll) return;
  for (const li of list.querySelectorAll('li[data-seq]')) {
    const n = Number(li.dataset.seq);
    li.hidden = !!rp && n > rp.cursor;
    if (rp && n === rp.cursor) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  }
  const box = $('#replay-controls');
  if (box && state.recording) {
    const focused = document.activeElement?.dataset?.replay, holder = document.createElement('div');
    holder.innerHTML = replayControls(state.recording);
    box.replaceWith(holder.firstElementChild);
    const again = focused && $(`#replay-controls [data-replay="${focused}"]`);
    if (again && !again.disabled) again.focus({preventScroll: true});
    else if (focused) $('#replay-controls [data-replay="toggle"]')?.focus({preventScroll: true});
  }
  const current = rp && list.querySelector(`li[data-seq="${rp.cursor}"]`);
  if (current) {
    if (scroll) current.scrollIntoView({block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth'});
    const live = $('#replay-live'), item = displayedSteps(state.recording)[rp.cursor - 1];
    if (live && item) live.textContent = `Step ${rp.cursor} of ${replayTotal()}: ${stepSummary(item)}`;
  }
}

function startReplay(from = 1, play = true) {
  const r = state.recording, total = r ? displayedSteps(r).length : 0;
  if (!r || !recordedMode() || !total) return;
  stopReplayTimer();
  state.replay = {recId: r.id, cursor: Math.max(1, Math.min(from, total)), playing: false};
  state.stepFilter = 'all';
  if (state.tab !== 'investigation') setTab('investigation'); else renderPanel();
  $('#recorded-steps')?.scrollIntoView({block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth'});
  if (play) advanceReplay(); else applyReplay(false);
}

// Plays on from the cursor. With nothing left to reveal (a one-step recording, or the last step) the replay
// is complete at once: no timer starts and nothing calls back into startReplay.
function advanceReplay() {
  const rp = state.replay;
  stopReplayTimer();
  if (!rp) return;
  rp.playing = rp.cursor < replayTotal();
  if (rp.playing) replayTimer = setInterval(() => {
    const now = state.replay;
    if (!now || state.recording?.id !== now.recId || state.tab !== 'investigation') { stopReplayTimer(); if (now) now.playing = false; return; }
    now.cursor = Math.min(replayTotal(), now.cursor + 1);
    if (now.cursor >= replayTotal()) { stopReplayTimer(); now.playing = false; }
    applyReplay();
  }, REPLAY_MS);
  applyReplay(false);
}

// Play continues a paused replay; Play again (after the last step) starts over from step 1.
function playReplay() {
  const rp = replayFor(state.recording);
  if (!rp || rp.cursor >= replayTotal()) startReplay(1, true); else advanceReplay();
}

function pauseReplay() { stopReplayTimer(); if (state.replay) { state.replay.playing = false; applyReplay(false); } }
function nextReplay() {
  if (!state.replay) return startReplay(1, false);
  stopReplayTimer();
  Object.assign(state.replay, {playing: false, cursor: Math.min(replayTotal(), state.replay.cursor + 1)});
  applyReplay();
}
function exitReplay() { resetReplay(); renderPanel(); }

// Agreement between a recording and this session's offline script run for the same case: which orders
// each would cancel, and which original each keeps. Shown only while the recording's inputs match the
// case now, so its order IDs refer to the same records. It is kept apart from the historical review,
// adds nothing to it, and does not rank either method.
function compareView(r) {
  const run = state.run;
  const box = (tone, verdict, body) => `<details class="compare"><summary><span class="compare-verdict ${tone}">${icon(tone === 'ok' ? 'circle-check' : tone === 'differ' ? 'triangle-alert' : 'git-compare')}<span><span class="compare-label">Compared with the offline script · </span>${verdict}</span></span></summary><div class="compare-body">${body}</div></details>`;
  if (r.incident_id !== state.incident?.id) return box('', 'not compared', '<p class="small muted">This recording belongs to another case.</p>');
  if (!recCitations(r)) return box('', 'not compared', '<p class="small muted">This recording’s inputs differ from the case now, so its order IDs may not refer to the same records.</p>');
  if (!run || run.incident_id !== r.incident_id) return box('', 'no script run yet', `<p class="small muted">Run the offline script on this case to compare which orders each one would cancel.</p><button class="secondary" data-source="script">${icon('play')}<span>Go to the script run</span></button>`);
  const source = `<p class="caption">Compares order IDs with script run ${text(shortId(run.id))} from this server session (${text(statusOf(run)[0].toLowerCase())}). It checks agreement only, not which is better.</p>`;
  const model = r.review?.changes || null, plan = run.plan;
  if (!plan) {
    if (run.status !== 'stopped') return box('', 'nothing to compare', `<p class="small muted">Script run ${text(shortId(run.id))} has no proposal to compare.</p>`);
    return r.outcome === 'stop'
      ? box('ok', 'same outcome: the script also stopped without proposing a repair', source)
      : box('differ', text(`different outcome: the script stopped without proposing a repair${model ? `, while this recording cancelled ${model.length} orders` : ''}`), source);
  }
  const ended = {stop: 'stopped', error: 'ended with an error', incomplete: 'did not finish'}[r.outcome] || `ended as ${r.outcome}`;
  if (!model) return box('differ', text(`different outcome: this recording ${ended} with no verified repair; the script proposed ${plan.cancellations.length} cancellations`), source);
  const byScript = new Map(plan.cancellations.map(c => [c.order_id, c.duplicate_of]));
  const byModel = new Map(model.map(c => [c.before.id, c.duplicate_of]));
  const both = [...byModel.keys()].filter(id => byScript.has(id));
  const onlyModel = [...byModel.keys()].filter(id => !byScript.has(id)), onlyScript = [...byScript.keys()].filter(id => !byModel.has(id));
  const keepDiffers = both.filter(id => byScript.get(id) !== byModel.get(id));
  if (!onlyModel.length && !onlyScript.length && !keepDiffers.length) {
    return box('ok', text(`same ${both.length} cancellations, keeping the same original orders`), source);
  }
  const ids = (list) => `<span class="compare-ids">${list.map(id => `<span class="mono">${text(compactId(id))}</span>`).join('')}</span>`;
  return box('differ', 'disagrees on some orders', `<div class="metrics">${metric(both.length, 'cancelled by both')}${metric(onlyModel.length, 'only in this recording')}${metric(onlyScript.length, 'only in the script run')}</div>
    ${keepDiffers.length ? `<p class="small">${text(keepDiffers.length === 1 ? '1 shared cancellation keeps a different original order.' : `${keepDiffers.length} shared cancellations keep a different original order.`)}</p>` : ''}
    ${onlyModel.length ? `<details class="fold"><summary>Only in this recording · ${onlyModel.length}</summary>${ids(onlyModel)}</details>` : ''}
    ${onlyScript.length ? `<details class="fold"><summary>Only in the script run · ${onlyScript.length}</summary>${ids(onlyScript)}</details>` : ''}
    ${source}`);
}

// The runtime's own error text for a rejected step (never the model's wording).
const rejectionText = (res) => {
  const v = res?.result;
  if (plainObject(v) && v.passed === false && Array.isArray(v.checks) && v.checks.length)
    return `Tested on a copy: ${v.checks.filter(c => c?.passed === true).length} of ${v.checks.length} checks passed, so the test did not pass.`;
  return v && typeof v === 'object' && 'error' in v ? String(v.error) : JSON.stringify(v ?? null);
};

// A stopped/unfinished run may still contain an attempted test. Keep its observed checks visible
// without manufacturing a selected repair review or a downloadable package.
function lastRecordedTest(r) {
  return displayedSteps(r).reverse().find(i => i.step.kind === 'tool_call' && i.step.name === 'rehearse_repair'
    && plainObject(i.res?.result) && typeof i.res.result.passed === 'boolean'
    && Array.isArray(i.res.result.checks) && i.res.result.checks.length > 0
    && i.res.result.checks.every(c => plainObject(c) && typeof c.name === 'string' && typeof c.passed === 'boolean' && typeof c.detail === 'string')) || null;
}

// A short conclusion built only from validated data: the server's outcome, the recorded rehearsal review
// and the runtime's rejection messages. It never paraphrases the model's summary.
function recordedConclusion(r, rejected) {
  const review = r.review, last = rejected[rejected.length - 1];
  const along = rejected.length ? ` The local runtime rejected ${rejected.length} tool call${rejected.length === 1 ? '' : 's'} along the way.` : '';
  const reason = last ? ` Last rejection: “${rejectionText(last)}”` : '';
  if (r.outcome === 'repair' && review) {
    const passed = review.checks.filter(c => c.passed).length;
    return `Tested on a disposable copy, ${review.passed ? 'passing' : 'not passing'} ${passed} of ${review.checks.length} checks: ${review.cancellations} orders cancelled, active orders ${review.before_active} → ${review.after_active}, ${review.checkout_preserved} of ${review.checkout_total} later purchases unchanged.${along}`;
  }
  if (r.outcome === 'repair') return `The recording reports a repair, but no verified test on a copy was recorded.${along}`;
  if (r.outcome === 'stop') {
    const test = lastRecordedTest(r), v = test?.res.result;
    const observed = v ? ` Its last test on a copy ${v.passed ? 'passed' : 'did not pass'}: ${v.checks.filter(c => c.passed).length} of ${v.checks.length} checks passed.` : '';
    return `The model stopped. No repair was selected for review.${observed}${test && last?.call_id === test.res.call_id ? '' : reason}`;
  }
  if (r.outcome === 'error') return `The attempt ended with an error after ${r.tool_calls} tool results. No verified repair was recorded.${reason}`;
  if (r.outcome === 'incomplete') return `The attempt did not finish after ${r.tool_calls} tool results. No verified repair was recorded.${reason}`;
  return `Outcome recorded as ${r.outcome}.`;
}

function recordedInvestigationView() {
  const r = state.recording;
  if (!r) return recordedPending();
  const [label, tone] = recOutcome(r), usage = r.usage || {};
  const results = new Map(r.steps.filter(s => s.kind === 'tool_result').map(s => [s.call_id, s]));
  const calls = r.steps.filter(s => s.kind === 'tool_call');
  const rejected = calls.filter(c => results.get(c.call_id)?.error).length + r.steps.filter(s => s.kind === 'tool_result' && s.error && !calls.some(c => c.call_id === s.call_id)).length;
  const messages = r.steps.filter(s => s.kind === 'assistant').length;
  const rejectedResults = r.steps.filter(s => s.kind === 'tool_result' && s.error);
  const heading = {repair: 'A recorded repair', stop: 'The model stopped', error: 'The attempt ended with an error', incomplete: 'The attempt did not finish'}[r.outcome] || 'Recorded attempt';
  // Counts match the list below, where each result is shown inside its call.
  const callIds = new Set(calls.map(c => c.call_id));
  const shown = r.steps.filter(s => !(s.kind === 'tool_result' && callIds.has(s.call_id))).length;
  const filters = [['all', `All · ${shown}`], ['tools', `Tool calls · ${shown - messages}`], ['messages', `Model messages · ${messages}`], ['rejected', `Rejected · ${rejected}`]];
  return `${recBanner(r)}
    <div class="section-heading"><h2>${heading}</h2></div>
    <div class="callout ${tone === 'ok' ? 'success' : 'stop'}"><strong>Outcome</strong><br>${text(recordedConclusion(r, rejectedResults))}</div>
    ${guardrailView(r)}
    ${compareView(r)}
    ${recCitations(r) ? reconstructionView(r.review ? r.review.changes.map(c => ({order_id: c.before.id, duplicate_of: c.duplicate_of})) : null, {recorded: true}) : ''}
    <div class="incident-facts run-numbers"><span><strong>${text(Number.isFinite(r.elapsed_seconds) ? `${Math.round(r.elapsed_seconds)} s` : '—')}</strong> elapsed, as reported</span><span><strong>${text(rejected)}</strong> rejected tool ${rejected === 1 ? 'result' : 'results'}</span><span><strong>${text(messages)}</strong> model ${messages === 1 ? 'message' : 'messages'}</span></div>
    <div class="folds">
      <details class="fold"><summary>${usage.available ? text(`Usage: ${fmtNum(usage.total_tokens)} tokens, as reported`) : 'Usage not recorded'}</summary><p class="small muted">${usage.available ? text(`Input ${fmtNum(usage.input_tokens)} (cached ${fmtNum(usage.cached_input_tokens)}) · output ${fmtNum(usage.output_tokens)}, which already includes ${fmtNum(usage.reasoning_tokens)} reasoning · ${fmtNum(usage.response_count)} responses with usage. No cost is shown.`) : 'This recording did not include usage totals.'}</p></details>
      <details class="fold model-summary"><summary>Model’s final summary · verbatim</summary><p class="tl-text">${text(r.final?.summary || r.summary || 'No summary recorded.')}</p></details>
    </div>
    <h3 class="tl-title" id="recorded-steps" tabindex="-1">Recorded steps <span class="caption">In order. Nothing here runs again.</span></h3>
    ${replayControls(r)}<p class="sr-only" id="replay-live" aria-live="polite"></p>
    ${replayFor(r) ? '' : `<div class="tl-tools"><div class="segmented" role="group" aria-label="Filter steps">${filters.map(([key, name]) => `<button data-step-filter="${key}" aria-pressed="${state.stepFilter === key}">${text(name)}</button>`).join('')}</div><button class="link small" data-expand-steps>Expand all</button></div>`}
    <ol class="timeline">${timelineItems(r)}</ol>`;
}

function recordedChangesView() {
  const r = state.recording;
  if (!r) return recordedPending();
  if (!r.review) return `${recBanner(r, true)}${emptyState('No repair selected for review', lastRecordedTest(r)
    ? 'This recording includes an attempted test on a copy. Its saved results are in Checks and the recorded steps; no repair package was selected.'
    : `This attempt ended as ${r.outcome}; no repair package was selected.`, r.outcome === 'stop' ? 'ban' : 'circle-x')}`;
  const review = r.review;
  return `${recBanner(r, true, true)}
    <div class="section-heading"><h2>Recorded repair review</h2></div>
    ${repairFlow(review, {recorded: true})}
    ${diffView(review)}
    <p class="caption">Read-only history. To produce exportable SQL, run the offline script and test its repair on a copy.</p>`;
}

function recordedChecksView() {
  const r = state.recording;
  if (!r) return recordedPending();
  if (!r.review) {
    const test = lastRecordedTest(r);
    if (!test) return `${recBanner(r, true)}${emptyState('No recorded check results available', 'This recording has no selected repair review or complete test results to display. Its saved steps remain available.', 'shield-check')}`;
    const v = test.res.result, passed = v.checks.filter(c => c.passed).length;
    return `${recBanner(r, true)}<div class="section-heading"><h2>Recorded checks from an attempted repair</h2></div>
      <div class="callout ${v.passed ? 'success' : 'stop'}"><strong>${passed} / ${v.checks.length} checks passed</strong><br>Saved results from step ${test.n}. No repair was selected for review; these results provide no export.</div>
      ${table(['Check', 'Recorded result', 'Explanation'], v.checks.map(c => [text(c.name.replaceAll('_', ' ')), c.passed ? 'Passed' : 'Failed', text(c.detail)]))}`;
  }
  const review = r.review, passed = review.checks.filter(c => c.passed).length;
  return `${recBanner(r, true, true)}
    <div class="section-heading"><h2>Recorded operational checks</h2></div>
    <div class="status-cards">
      <div class="status-card ${review.passed ? 'ok' : 'danger'}"><span class="eyebrow">In the recorded test</span><strong>${passed} / ${review.checks.length} checks passed</strong><span class="caption">${text(r.review_observation || '')}</span></div>
      <div class="status-card"><span class="eyebrow">Export</span><strong>Not available for recordings</strong><span class="caption">Recordings have no downloads. Exports come only from a current offline test, and each one is refused if files changed since testing.</span></div>
    </div>
    ${checksView(review.checks)}`;
}

function recordedSqlView() {
  return `${state.recording ? recBanner(state.recording, true) : ''}${emptyState('No SQL for recorded runs', 'Recordings are read-only history with no downloads. Guarded SQL comes only from a current offline test, and it is refused if files changed since testing.', 'database')}`;
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
  const cited = new Map(), source = active();
  if (!source.citations) return cited;
  for (const action of source.plan?.cancellations || []) {
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
  const source = active();
  const change = source.review?.changes.find(c => c.before.id === id);
  if (change) return {refs: source.citations ? change.evidence_refs : [], keep: change.duplicate_of};
  const action = source.plan?.cancellations.find(a => a.order_id === id);
  return action ? {refs: source.citations ? action.evidence_refs : [], keep: action.duplicate_of} : null;
}

const lineLabel = (raw, cancel, keep) => cancel && raw.includes(cancel) ? 'cancellation target' : keep && raw.includes(keep) ? 'retained write' : '';

function evidenceView() {
  const {ev, incident} = state, cited = citedRefs();
  return `<div class="log-head">
      <div class="segmented" role="group" aria-label="Evidence file">${incident.artifacts.map(a=>`<button data-file="${escape(a.name)}" aria-pressed="${a.name===ev.name}">${text(a.name)}<span class="count" title="${escape(`${a.bytes} bytes`)}">${text(fmtBytes(a.bytes))}</span></button>`).join('')}</div>
    </div>
    <div class="log-tools">
      <label class="search">${icon('search')}<span class="sr-only">Search lines</span><input id="ev-search" type="search" placeholder="Search lines" value="${escape(ev.query)}" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label>
      ${cited.size?`<button class="toggle" data-cited-only aria-pressed="${ev.citedOnly}"><span class="dot" aria-hidden="true"></span>${recordedMode()?'Cited by recording':'Cited by plan'}</button>`:''}
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
    box.innerHTML = `<div class="log-loading">${skeleton(14)}</div>`;
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
  if (state.selection?.kind === 'line') renderContext(); // its "from another file" note may no longer apply
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
  if (!run?.review) return noReview(run, 'field-level changes');
  return reviewView();
}

function reviewView() {
  const run = state.run, review = run.review;
  return `${reviewSummary(run, review)}${diffView(review)}${packageView(run)}`;
}

function reviewSummary(run, review) {
  const ready = run.status === 'ready_for_review';
  const failed = review.checks.filter(c => !c.passed);
  return `<div class="section-heading"><h2>${ready?'Test result on a copy':'Export unavailable'}</h2></div>
    ${ready?'':`<div class="callout stop">${text(run.summary)}</div>`}
    ${repairFlow(review, {run})}
    ${run.status==='blocked'?'<p class="caption">Export is blocked. Counts describe the earlier test on a copy; see the server’s reason above.</p>':''}
    ${failed.length?`<div class="failed"><h3>Checks that failed on the copy</h3><ul>${failed.map(c=>`<li><span class="group">${text(groupOf(c.name))}</span><strong>${text(checkName(c.name))}</strong><div class="check-detail">${text(c.detail)}${diagSummary(c)?`<span class="check-diag">${text(diagSummary(c))}</span>`:''}</div></li>`).join('')}</ul></div>`:''}`;
}

// A quiet outcome graphic, built from the selected rehearsal's observations.
// The bar counts changed and preserved records, not deleted orders or a live source.
function repairFlow(review, {run = null, recorded = false} = {}) {
  const passed = review.checks.filter(c => c.passed).length, total = review.checks.length;
  const sourceCheck = review.checks.find(c => c.name === 'source_snapshot_unchanged');
  const sourceNote = sourceCheck ? (sourceCheck.passed ? 'Source unchanged during the test' : 'Source changed during the test') : 'Source opened read-only';
  const changed = review.cancellations, preserved = review.untargeted_preserved;
  const known = [changed, preserved].every(n => Number.isSafeInteger(n) && n >= 0) && changed + preserved > 0;
  const portion = known ? changed / (changed + preserved) * 100 : 0;
  const pkg = recorded ? 'Read-only recording · no downloads'
    : run?.status === 'ready_for_review' ? 'For human review · refused if files changed since testing'
    : run?.status === 'blocked' ? 'Export blocked' : 'Export unavailable · checks failed';
  const pkgTone = recorded ? '' : run?.status === 'ready_for_review' ? 'ok' : run?.status === 'blocked' ? 'warn' : 'danger';
  return `<section class="repair-outcome" aria-label="${recorded ? 'Recorded outcome of the test on a copy' : 'Outcome of the test on a copy'}">
    <div class="outcome-numbers"><div><span class="eyebrow">Active orders on the ${recorded ? 'recorded ' : ''}copy</span>
      <strong class="outcome-total">${text(review.before_active)} → ${text(review.after_active)}</strong>
      <p><strong>${text(changed)}</strong> duplicate orders cancelled. Order history retained.</p></div>
      <div class="outcome-preserved"><strong>${text(preserved)}</strong><span>orders left untouched</span><small>including ${text(`${review.checkout_preserved} / ${review.checkout_total}`)} later purchases intact</small></div></div>
    ${known ? `<figure class="impact" aria-label="${text(`${changed} cancelled orders and ${preserved} unchanged orders in the test on a copy`)}">
      <svg class="impact-track" viewBox="0 0 100 7" preserveAspectRatio="none" aria-hidden="true"><rect class="impact-changed" x="0" y="0" width="${portion}" height="7"/><rect class="impact-preserved" x="${portion}" y="0" width="${100 - portion}" height="7"/></svg></figure>` : ''}
    <ol class="outcome-path" aria-label="${recorded ? 'Recorded repair path' : 'Repair path'}">
      <li class="path-step src">${icon('database')}<span><strong>Source database</strong><small>${text(sourceNote)}</small></span></li>
      <li class="path-step copy">${icon('flask-conical')}<span><strong>${recorded ? 'Recorded test copy' : 'Disposable copy'}</strong><small>${recorded ? 'changes were made only here' : 'changes are made only here'}</small></span></li>
      <li class="path-step ${review.passed ? 'ok' : 'danger'}">${icon(review.passed ? 'shield-check' : 'circle-x')}<span><strong>Independent checks</strong><small>${passed} / ${total} passed ${recorded ? 'in the recorded test' : 'on the copy'}</small></span></li>
      <li class="path-step pkg ${pkgTone}">${icon(recorded ? 'history' : 'package')}<span><strong>${recorded ? 'No repair package' : 'Repair package'}</strong><small>${text(pkg)}</small></span></li>
    </ol>
  </section>`;
}

// Zero-based stock marks are an alternative view of the displayed before/after values.
function stockVisual(product, maximum) {
  const numeric = `<span class="stock-values"><span>${text(product.before)}</span><span aria-hidden="true">→</span><strong>${text(product.after)}</strong></span>`;
  if (![product.before, product.after, maximum].every(Number.isFinite) || Math.min(product.before, product.after) < 0 || maximum <= 0 || maximum < Math.max(product.before, product.after)) return numeric;
  const before = product.before / maximum * 100, after = product.after / maximum * 100;
  return `<div class="stock-visual">${numeric}<svg class="stock-track" viewBox="0 0 100 7" preserveAspectRatio="none" aria-hidden="true"><rect class="stock-base" x="0" y="0" width="${Math.min(before, after)}" height="7"/><rect class="stock-delta ${after < before ? 'negative' : ''}" x="${Math.min(before, after)}" y="0" width="${Math.abs(after - before)}" height="7"/><line x1="${after}" x2="${after}" y1="0" y2="7"/></svg></div>`;
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
    <div class="diff-head"><h3 id="diff-title">Order changes</h3><span class="caption">On the disposable copy</span></div>
    <div class="diff-tools">
      <div class="diff-counts"><span>${review.changes.length} orders</span><span>${stockChanged.length} stock rows</span><span>${review.preserved_orders.length} preserved</span></div>
      <label class="search">${icon('search')}<span class="sr-only">Search changed records</span><input id="change-search" type="search" placeholder="Search order, customer or product" value="${escape(state.changeQuery)}" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label>
      <label class="filter">Product <select id="change-filter"><option value="">All (${review.changes.length})</option>${skus.map(sku=>`<option value="${escape(sku)}" ${sku===state.filter?'selected':''}>${text(sku)} (${review.changes.filter(c=>c.before.sku===sku).length})</option>`).join('')}</select></label>
    </div>
    <p class="table-note">${uniformStatus(review.changes) ? 'Each order below goes from active to cancelled on the copy. ' : ''}The original purchase stays. Only the retry is cancelled; stock is returned with a compensating entry.</p>
    <div id="change-table">${changesTable(review.changes)}</div>
    <div class="group-head"><h4>Stock reconciliation</h4><span class="caption">Before and after the test on a copy. Bars start at zero.</span></div>
    ${table(['','Product','Stock on hand','Change','From cancellations'],review.stock.map(p=>{
      const delta = p.after - p.before, entry = byProduct.get(p.sku);
      return [`<span class="sym ${delta?'mod':'same'}">${delta?'~':'='}</span>`,`${text(p.name)} <span class="mono faint">${text(p.sku)}</span>`,stockVisual(p, Math.max(0, ...review.stock.flatMap(row => [row.before, row.after]))),`<span class="${delta>0?'positive':delta<0?'cancelled':''} num">${delta>0?'+':''}${text(delta)}</span>`,entry?`${entry.orders} orders · +${entry.units} units`:'—'];
    }),review.stock.map(p=>selAttrs(`product:${p.sku}`)))}
    <div class="group-head"><h4>preserved work</h4><span class="caption">Later purchases in this synthetic case. On the copy, ${text(review.checkout_preserved)} of ${text(review.checkout_total)} remained unchanged.</span></div>
    ${orderTable(checkout)}
    <details class="fold"><summary>Other untouched records · ${others.length}</summary>${orderTable(others)}</details>
  </section>`;
}

// Every cancellation normally goes from active to cancelled; then that fact is one sentence above the table
// instead of a column that repeats on every row. Any other change keeps the column.
const uniformStatus = (changes) => changes.every(c => c.before.status === 'active' && c.after.status === 'cancelled');

function changesTable(changes) {
  const q = state.changeQuery.trim().toLowerCase(), uniform = uniformStatus(changes);
  const rows = changes.filter(c => (!state.filter || c.before.sku === state.filter) &&
    (!q || [c.before.id, c.before.customer, c.before.sku, c.duplicate_of].some(v => String(v).toLowerCase().includes(q))));
  if (!rows.length) return `<div class="log-empty">No changed records match.</div>`;
  return table(['Purchase','Cancelled order',...(uniform ? [] : ['Status on copy']),'Original order','Evidence'],rows.map(c=>{
    const changed = Object.keys(c.before).filter(k => c.before[k] !== c.after[k]);
    return [purchaseCell(c.before),`<span class="sym mod" title="${escape(changed.join(', '))} changed">~</span> ${idRef(c.before.id,'cancelled',q)}`,
      ...(uniform ? [] : [`<span class="before">${text(c.before.status)}</span> → <span class="after">${text(c.after.status)}</span>`]),
      idRef(c.duplicate_of,'',q),citations({order_id:c.before.id,evidence_refs:c.evidence_refs||[],recorded_evidence_refs_text:c.recorded_evidence_refs_text})];
  }),rows.map(c=>selAttrs(`order:${c.before.id}`)));
}

// The repair package: what a reviewer downloads, described from this run's own records. The workbench
// never applies it. The server pins the source and evidence fingerprints at investigation and refuses a
// download if either, or the rehearsed copy, has changed since.
const shortHash = (hash) => /^[0-9a-f]{12,}$/i.test(String(hash || '')) ? String(hash).slice(0, 12) : '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function packageNotes(review) {
  const passed = review.checks.filter(c => c.passed).length, moved = review.stock.filter(p => p.after !== p.before).length;
  const cited = new Set(review.changes.flatMap(c => c.evidence_refs || [])).size;
  return {
    'repair.sql': `Cancels ${plural(review.cancellations, 'order')}${moved ? ` and returns stock on ${plural(moved, 'product')}` : ''}. Rolls back if table state differs.`,
    'plan.json': `${plural(review.changes.length, 'cancellation')}${cited ? `, citing ${plural(cited, 'evidence line')}` : ''}.`,
    'report.json': `${passed} / ${review.checks.length} checks · active orders ${review.before_active} → ${review.after_active}.`,
  };
}
function packageView(run) {
  const review = run.review, exp = exportStatus(run), ready = run.status === 'ready_for_review' && !historicalRun(run);
  const notes = packageNotes(review), files = ready ? run.downloads || [] : [];
  const busy = state.rechecking.has(run.id);
  const list = files.length
    ? `<ul class="package-files">${files.map(name => `<li><button class="package-file" data-download="${escape(name)}"><span class="package-name mono">${text(name)}</span><span class="package-note">${text(notes[name] || DOWNLOAD_NOTES[name] || '')}</span>${icon('download')}<span class="sr-only"> · download</span></button></li>`).join('')}</ul>`
    : `<p class="package-empty">${text(ready ? 'No artifacts available for export.' : exp.detail)}</p>`;
  const source = shortHash(run.source_fingerprint), evidence = shortHash(run.evidence_fingerprint);
  const pinned = source && evidence
    ? `<p class="package-pin">File hashes from the investigation: source <span class="mono" title="${escape(run.source_fingerprint)}">${text(source)}</span> and evidence <span class="mono" title="${escape(run.evidence_fingerprint)}">${text(evidence)}</span>. ${ready ? 'Each download checks both again, and the rehearsed copy; a change refuses it.' : 'Nothing is served for this run.'}</p>`
    : '';
  const recheck = ready ? `<button class="secondary" data-recheck-export ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? `${icon('loader-circle', 'spin')}<span>Checking files…</span>` : `${icon('refresh-cw')}<span>Check files again</span>`}</button>` : '';
  return `<section class="package" id="repair-package" tabindex="-1" aria-labelledby="package-title">
    <div class="package-head"><div><h3 id="package-title">${icon('package')}Repair package</h3><p>For human review. This workbench never applies it.</p></div>${badge(exp.label, exp.tone)}</div>
    ${list}
    ${pinned || recheck ? `<div class="package-foot">${pinned}${recheck}</div>` : ''}
  </section>`;
}

/* ---------- Checks ---------- */

function exportStatus(run) {
  if (historicalRun(run)) return {label: 'No export in this demo', tone: '', detail: 'Recorded offline baseline. An export needs a current local test on a copy, so nothing is served here.'};
  const check = state.exportChecks.get(run.id);
  if (run.status === 'ready_for_review') {
    if (state.rechecking.has(run.id)) return {label: 'Checking files…', tone: '', detail: 'The server is checking whether the source, evidence or tested copy changed since testing.'};
    if (check?.ok) return {label: 'Files unchanged since testing', tone: 'ok', detail: `Checked at ${time(check.at)} for ${check.artifact}. Every export is checked again.`};
    if (check && !check.ok) return {label: 'Refused', tone: 'warn', detail: check.message};
    return {label: 'Tested on a copy · check files before export', tone: 'warn', detail: 'Not yet checked whether files changed since testing. Each download checks again.'};
  }
  if (run.status === 'blocked') return {label: 'Refused', tone: 'warn', detail: `${run.summary}${check && !check.ok ? ` Checked at ${time(check.at)}.` : ''}`};
  if (run.status === 'failed_checks') return {label: 'Unavailable', tone: 'danger', detail: 'Checks failed on the copy, so nothing can be exported.'};
  return {label: statusOf(run)[0], tone: '', detail: run.summary};
}

function checksTab() {
  const run = state.run, review = run?.review;
  if (!review) return noReview(run, 'independent checks');
  const passed = review.checks.filter(c => c.passed).length, meta = state.runMeta.get(run.id) || {}, exp = exportStatus(run), past = historicalRun(run);
  return `<div class="section-heading"><h2>Independent operational checks</h2></div>
    <div class="status-cards">
      <div class="status-card ${review.passed?'ok':'danger'}"><span class="eyebrow">On the copy</span><strong>${passed} / ${review.checks.length} checks passed</strong><span class="caption">${past ? 'Recorded when this baseline was built, not a current check' : `Observed on the tested copy${meta.rehearsedAt?` · result received ${time(meta.rehearsedAt)} on this page`:''}`}</span></div>
      <div class="status-card ${exp.tone}"><span class="eyebrow">${past ? 'Export' : 'Files since testing'}</span><strong>${text(exp.label)}</strong><span class="caption">${text(exp.detail)}</span>${run.status==='ready_for_review' && !past?`<button class="secondary" data-recheck-export ${state.rechecking.has(run.id)?'disabled aria-busy="true"':''}>${state.rechecking.has(run.id)?`${icon('loader-circle','spin')}<span>Checking files…</span>`:`${icon('refresh-cw')}<span>Check files again</span>`}</button>`:''}</div>
    </div>
    ${checksView(review.checks)}`;
}

function checksView(checks) {
  const known = new Set(CHECK_GROUPS.flatMap(([, names]) => names));
  const groups = [...CHECK_GROUPS.map(([label, names]) => [label, checks.filter(c => names.includes(c.name))]),
    ['Other checks', checks.filter(c => !known.has(c.name))]].filter(([, list]) => list.length);
  return `<div class="check-groups">${groups.map(([label, list]) => {
    const ok = list.filter(c => c.passed).length;
    return `<div class="check-group ${ok<list.length?'has-fail':''}"><div class="check-group-head"><h4>${text(label)}</h4><span class="caption">${ok} / ${list.length} passed</span></div>
      <ul class="checks">${list.map(c=>`<li class="sel ${c.passed?'':'fail'}" tabindex="0" data-key="check:${escape(c.name)}" aria-selected="false"><span class="check-icon ${c.passed?'':'cancelled'}" aria-hidden="true">${c.passed?'✓':'×'}</span><div><strong>${text(checkName(c.name))}</strong><span class="sr-only"> ${c.passed?'passed':'failed'}</span><div class="check-detail">${text(c.detail)}${diagSummary(c)?`<span class="check-diag">${text(diagSummary(c))}</span>`:''}</div></div></li>`).join('')}</ul></div>`;
  }).join('')}</div>`;
}

/* ---------- SQL ---------- */

function sqlTint(line) {
  if (line.trimStart().startsWith('--')) return `<span class="tok-comment">${escape(line)}</span>`;
  return escape(line).replace(SQL_WORDS, '<span class="tok-kw">$1</span>').replace(/&#39;(.*?)&#39;/g, '<span class="tok-str">&#39;$1&#39;</span>');
}

function sqlView() {
  const run = state.run;
  if (!run?.review) return noReview(run, 'the guarded repair script');
  if (historicalRun(run)) return `<div class="section-heading"><h2>No SQL in this demo</h2>${badge('Read-only', true)}</div>
    <div class="callout">A repair package needs a current local test on a copy, which this recorded demo does not run. No SQL file is included, so there is nothing to copy or download.</div>
    <p class="small muted">In the local workbench the server serves repair.sql only for a current, passing test on a copy, and refuses it if files changed since testing.</p>`;
  if (run.status !== 'ready_for_review') return `<div class="section-heading"><h2>Export unavailable</h2>${badge(statusOf(run)[0], true)}</div>
    <div class="callout stop">${text(run.summary)}</div>
    <p class="small muted">The server only serves SQL for a current, passing test on a copy. Every request is refused if files changed since testing.</p>`;
  const entry = state.sql.get(run.id) || {status: 'loading'};
  const body = entry.status === 'ok'
    ? `<div class="code" role="region" aria-label="repair.sql, read-only" tabindex="0">${entry.text.replace(/\r?\n$/, '').split(/\r?\n/).map((l,i)=>`<div class="code-line"><span class="ln">${i+1}</span><span class="lt">${sqlTint(l)}</span></div>`).join('')}</div>`
    : entry.status === 'error' ? `<div class="callout stop">${text(entry.message)}</div>` : `<div class="code code-loading"><p class="caption">${icon('loader-circle','spin')} Checking files and loading repair.sql…</p>${skeleton(12)}</div>`;
  return `<div class="sql-head"><div><span class="eyebrow">repair.sql · read-only</span><h2>Guarded repair script</h2></div>
      <div class="sql-actions"><button class="secondary" data-copy-sql ${entry.status!=='ok'?'disabled':''}>${icon('copy')}<span>Copy</span></button><button class="secondary" data-reload-sql>${icon('refresh-cw')}<span>Check files and reload</span></button></div></div>
    <p class="small muted">Not applied by this workbench. Loaded through the download route that refuses changed files${entry.at?` at ${time(entry.at)}`:''}. The script uses <span class="mono">BEGIN IMMEDIATE</span> and rolls back if table state differs from the tested copy. Human review is required.</p>
    ${body}`;
}

function maybeLoadSql() {
  const run = state.run;
  if (run?.status === 'ready_for_review' && !historicalRun(run) && !state.sql.has(run.id)) loadSql();
}

async function loadSql() {
  if (historicalRun(state.run)) { notice(READ_ONLY_NOTE); return; }
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
    ${line?`<pre class="cite-line">${tint(line.text)}</pre>`:data?'<pre class="cite-line">Line not found in the loaded evidence.</pre>':`<div class="cite-line">${skeleton(2)}</div>`}</div>`;
}

function orderContext(id, focusRef) {
  const source = active(), review = source.review, recorded = source.recorded;
  const change = review?.changes.find(c => c.before.id === id);
  const planned = !change && source.plan?.cancellations.find(a => a.order_id === id);
  // A recording's details come only from its own historical review, never from current-case records.
  const findIn = (oid) => review?.changes.find(c => c.before.id === oid)?.before || review?.preserved_orders.find(o => o.id === oid);
  const record = change?.before || (recorded ? findIn(id) : ordersById().get(id) || findIn(id));
  if (!record) return `<p class="muted">This record is not in the selected ${recorded ? 'recording' : 'incident'}.</p>`;
  const when = recorded ? 'Recorded in the test, not a current export check' : 'Engine before and after the test on a copy';
  let html = `<h2 class="mono ctx-title">${text(id)}</h2><p class="small muted">${purchase(record)}</p><button class="link small" data-copy-value="${escape(id)}" data-copy-what="Order ID">${icon('copy')}<span>Copy order ID</span></button>`;
  if (change) html += `<div class="ctx-status">${badge(recorded ? 'Changed on the recorded copy' : 'Changed on the copy', true)}<span class="caption">${when}</span></div>${fieldTable(change.before, change.after)}`;
  else if (planned) html += `<div class="ctx-status">${badge('Proposed cancellation')}<span class="caption">Not rehearsed yet. Current source values.</span></div>${fieldTable(record)}`;
  else if (review) html += `<div class="ctx-status">${badge('Unchanged on the copy', 'ok')}${laterIds(review).has(id)?badge('Later purchase'):''}</div>${fieldTable(record)}`;
  else html += `<div class="ctx-status">${badge('Source record')}</div>${fieldTable(record)}`;
  const link = change ? {refs: change.evidence_refs || [], text: change.recorded_evidence_refs_text, keep: change.duplicate_of} : planned ? {refs: planned.evidence_refs, keep: planned.duplicate_of} : null;
  if (link) {
    const kept = recorded ? findIn(link.keep) : ordersById().get(link.keep);
    html += `<div class="ctx-keep"><h3>Retained purchase</h3>${source.selectable ? `<button class="link mono" data-key="order:${escape(link.keep)}">${text(link.keep)}</button>` : `<span class="mono">${text(link.keep)}</span>`}<p>${purchase(kept)}</p></div>`;
    html += source.citations
      ? `<h3>Supporting evidence</h3>${link.refs.map(ref => citeBlock(ref, id, link.keep, focusRef)).join('')}`
      : `<h3>Recorded evidence references</h3><p class="mono ref-text">${text(link.text || '—')}</p><p class="caption">Historical text only. Citations are disabled because the recording's inputs do not match this case.</p>`;
  }
  const citedBy = (source.plan?.cancellations || []).filter(a => a.duplicate_of === id);
  if (citedBy.length && source.selectable) html += `<h3>Retained for</h3><div class="id-grid">${citedBy.map(a=>`<button class="id-chip mono" data-key="order:${escape(a.order_id)}">${text(a.order_id)}</button>`).join('')}</div>`;
  return html;
}

function productContext(sku) {
  const source = active(), review = source.review, row = review?.stock.find(p => p.sku === sku);
  if (!row) return `<p class="muted">No test data for this product.</p>`;
  const changes = review.changes.filter(c => c.before.sku === sku);
  return `<h2 class="ctx-title">${text(row.name)} <span class="mono faint">${text(sku)}</span></h2>
    <div class="ctx-status">${badge(row.after !== row.before ? 'Changed on the copy' : 'Unchanged', row.after !== row.before)}<span class="caption">${source.recorded ? 'Recorded in the test, not a current export check' : 'Engine before and after the test on a copy'}</span></div>
    ${fieldTable({sku, name: row.name, on_hand: row.before}, {sku, name: row.name, on_hand: row.after})}
    ${changes.length?`<h3>From ${changes.length} cancellations</h3><div class="id-grid">${changes.map(c=>`<button class="id-chip mono" data-key="order:${escape(c.before.id)}">${text(c.before.id)} · +${text(c.before.quantity)}</button>`).join('')}</div>`:''}`;
}

// "Show me" for a check: the related records from the same rehearsal review (current or recorded). The
// server reports each check as pass/fail with one sentence, so these rows are derived in the browser from
// the review's before/after records and say so; they are not the check's own computation.
// The checker's own explanation of a check (bounded server data). Older recordings have none; their
// checks fall back to the view derived from the review's before/after records.
const hasDiagnostics = (check) => !!check?.diagnostics && Array.isArray(check.diagnostics.items);
// How each part adds up to the expected value: opening + movements, or opening − active order quantity.
const DIAG_PART_SIGN = {opening: 1, movements: 1, active_quantity: -1};
const DIAG_RELATED = {active_order_ids: 'Active orders', recorded_order_ids: 'Recorded orders', added_movement_ids: 'Movements added', order_ids: 'Orders', movement_ids: 'Movements'};
const signedNum = (n) => typeof n === 'number' ? `${n > 0 ? '+' : ''}${n}` : text(n ?? '—');
const diagValue = (v) => v === null || v === undefined ? '—' : String(v);
const productName = (sku) => state.incident?.products?.find(p => p.sku === sku)?.name || sku;

function diagEntityText(e) {
  if (e.table === 'products' && e.sku) return String(e.sku);
  if (e.id) return `${e.id}${e.field ? ` · ${e.field}` : ''}`;
  if (e.event_id) return String(e.event_id);
  if (e.file) return String(e.file);
  if (e.table) return String(e.table);
  return Object.entries(e).map(([k, v]) => `${k} ${v}`).join(' · ');
}

function diagEntity(e) {
  const link = (key, label) => active().selectable ? `<button class="link small mono" data-key="${escape(key)}">${text(label)}</button>` : `<span class="mono">${text(label)}</span>`;
  const field = e.field ? ` <span class="caption">· ${text(e.field)}</span>` : '';
  if (e.table === 'orders' && e.id) return `${link(`order:${e.id}`, e.id)}${field}`;
  if (e.table === 'products' && e.sku) return active().selectable ? `<button class="link small" data-key="${escape(`product:${e.sku}`)}">${text(productName(e.sku))}</button>` : text(e.sku);
  if (e.id) return `<span class="mono">${text(e.id)}</span>${field}`;
  if (e.event_id || e.file) return `<span class="mono">${text(e.event_id || e.file)}</span>`;
  return text(diagEntityText(e));
}

// One line for a failed check: its first exception (or product off by a difference), and how many more.
// A listed row breaks the rule unless it shows a zero difference; a row whose expected value could not be
// computed cannot be shown to match. A partial list never supports a claim about the rows it leaves out.
const offRow = (i) => !(typeof i.difference === 'number' && i.difference === 0);
const unlisted = (d) => Math.max(0, (Number.isInteger(d.total) ? d.total : 0) - d.items.length);
const wasWere = (n) => `${n} more ${n === 1 ? 'was' : 'were'} not listed`;

function diagSummary(check) {
  if (check.passed || !hasDiagnostics(check)) return '';
  const d = check.diagnostics, hidden = unlisted(d);
  const off = d.listing === 'all' ? d.items.filter(offRow) : d.items;
  if (!off.length) return hidden ? `Not among the ${d.items.length} listed; ${wasWere(hidden)}` : '';
  const first = off[0], more = d.listing === 'all' ? off.length - 1 : d.total - 1;
  const diff = typeof first.difference === 'number' ? ` (${signedNum(first.difference)})` : '';
  const tail = [more > 0 ? `${more} more` : '', d.listing === 'all' && hidden ? `${hidden} not listed` : ''].filter(Boolean).join(' · ');
  return `${diagEntityText(first.entity)}: expected ${diagValue(first.expected)}, observed ${diagValue(first.observed)}${diff}${tail ? ` · ${tail}` : ''}`;
}

function diagnosticsView(check) {
  const d = check.diagnostics, items = d.items;
  const rule = `<p class="diag-rule">${icon('shield-check')}<span>${text(d.rule)}</span></p>`;
  const more = d.truncated ? `<p class="caption">Showing ${items.length} of ${text(d.total)}; the checker lists at most ${items.length}.</p>` : '';
  if (d.listing === 'all') {
    const added = items.reduce((n, i) => n + (i.related?.added_movement_ids?.length || 0), 0), hidden = unlisted(d);
    const atLeast = hidden > 0 || items.some(i => i.related_truncated) ? 'at least ' : '';
    // The parts behind each expected value, as a small sum under it (the rule above names them).
    const sum = (parts) => {
      const known = Object.entries(parts || {}).filter(([k, v]) => k in DIAG_PART_SIGN && typeof v === 'number');
      if (!known.length) return '';
      return known.map(([k, v], n) => { const value = v * DIAG_PART_SIGN[k]; return n === 0 ? String(value) : `${value < 0 ? '−' : '+'} ${Math.abs(value)}`; }).join(' ');
    };
    const rows = items.map(i => [diagEntity(i.entity),
      `<span class="num">${text(diagValue(i.expected))}</span>${sum(i.parts) ? `<small class="diag-sum">${text(sum(i.parts))}</small>` : ''}`,
      `<span class="num">${text(diagValue(i.observed))}</span>`, `<span class="num${offRow(i) ? ' cancelled' : ''}">${signedNum(i.difference)}</span>`]);
    const off = items.filter(offRow).length;
    const verdict = off ? `${off} listed product${off === 1 ? ' breaks' : 's break'} the rule${hidden ? `; ${wasWere(hidden)}` : ''}.`
      : !hidden ? (check.passed ? 'Every product matches the rule.' : 'No listed product breaks the rule, yet the check failed.')
      : check.passed ? `The ${items.length} listed products match the rule; ${wasWere(hidden)}.`
      : `The ${items.length} listed products match the rule, so the failure is among the ${hidden} not listed.`;
    return `<h3>What the checker computed</h3>${rule}
      ${table(['Product', 'Expected', 'Observed', 'Difference'], rows)}${more}
      <p class="small">${text(verdict)}${added ? text(` The repair added ${atLeast}${added} compensating movement${added === 1 && !atLeast ? '' : 's'}.`) : ''}</p>`;
  }
  if (!items.length) return `<h3>What the checker computed</h3>${rule}<p class="small">No exceptions: nothing broke this rule.</p>`;
  const withDiff = items.some(i => typeof i.difference === 'number'), withRelated = items.some(i => i.related);
  const related = (r, cut) => r ? Object.entries(r).map(([k, ids]) => `<div class="diag-related"><span class="caption">${text(DIAG_RELATED[k] || k)}</span> ${ids.length ? ids.map(id => /order/.test(k) && active().selectable ? `<button class="link small mono" data-key="${escape(`order:${id}`)}">${text(id)}</button>` : `<span class="mono">${text(id)}</span>`).join(' ') : '<span class="caption">none</span>'}</div>`).join('')
    + (cut ? `<div class="caption">Lists shortened to their first ${Math.max(...Object.values(r).map(ids => ids.length))} IDs</div>` : '') : '';
  const rows = items.map(i => [diagEntity(i.entity), text(diagValue(i.expected)), `<span class="cancelled">${text(diagValue(i.observed))}</span>`,
    ...(withDiff ? [`<span class="num">${signedNum(i.difference)}</span>`] : []), ...(withRelated ? [related(i.related, i.related_truncated)] : [])]);
  return `<h3>What the checker found</h3>${rule}
    ${table(['Record', 'Expected', 'Observed', ...(withDiff ? ['Difference'] : []), ...(withRelated ? ['Related'] : [])], rows)}${more}`;
}

function checkEvidence(name, review) {
  const derived = '<p class="caption">Derived from the test’s before and after records, not from the check’s own computation.</p>';
  const link = (key, label) => active().selectable ? `<button class="link small" data-key="${escape(key)}">${text(label)}</button>` : text(label);
  const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
  if (name === 'stock_matches_movement_ledger' || name === 'stock_matches_active_orders') {
    const returned = new Map();
    for (const c of review.changes) returned.set(c.before.sku, (returned.get(c.before.sku) || 0) + c.before.quantity);
    let differs = 0;
    const rows = review.stock.map(p => {
      const observed = p.after - p.before, expected = returned.get(p.sku) || 0;
      if (observed !== expected) differs += 1;
      return [link(`product:${p.sku}`, p.name), `<span class="num">${text(p.before)} → ${text(p.after)}</span>`,
        `<span class="num">${signed(expected)}</span>`, `<span class="num${observed === expected ? '' : ' cancelled'}">${signed(observed)}</span>`];
    });
    return `<h3>Stock on the tested copy</h3>${table(['Product', 'on_hand', 'Returned by cancellations', 'Observed change'], rows)}
      <p class="small">${differs ? text(`${differs} product${differs === 1 ? '' : 's'} changed by a different amount than ${differs === 1 ? 'its' : 'their'} cancelled orders returned.`) : 'Each product changed by exactly the units its cancelled orders returned.'}</p>${derived}`;
  }
  if (name === 'unaffected_orders_preserved') {
    return `<h3>Preserved records</h3><dl class="run-facts"><dt>Records left untouched</dt><dd>${text(review.untargeted_preserved)}</dd>
      <dt>Later purchases unchanged</dt><dd>${text(`${review.checkout_preserved} of ${review.checkout_total}`)}</dd></dl>
      <button class="secondary" data-tab="changes">${icon('git-compare')}<span>Show preserved work</span></button>${derived}`;
  }
  if (name === 'order_history_preserved') {
    const other = review.changes.filter(c => Object.keys(c.before).some(k => k !== 'status' && c.before[k] !== c.after[k]));
    return `<h3>Cancelled orders</h3><p class="small">${text(other.length
      ? `${other.length} of ${review.changes.length} cancelled orders changed more than their status.`
      : `Only the status changed on all ${review.changes.length} cancelled orders; IDs, customers, products and quantities are unchanged.`)}</p>
      ${other.length ? `<div class="id-grid">${other.map(c => link(`order:${c.before.id}`, c.before.id)).join('')}</div>` : ''}${derived}`;
  }
  if (name === 'source_evidence_complete' || name === 'source_events_applied_once') {
    const refs = review.changes.flatMap(c => c.evidence_refs || []);
    if (!refs.length) return '';
    return `<h3>Cited evidence</h3><p class="small">${text(`${review.changes.length} cancellations make ${refs.length} citations to ${new Set(refs).size} distinct committed-write lines.`)}</p>
      <button class="secondary" data-tab="evidence">${icon('file-text')}<span>Open Evidence</span></button>${derived}`;
  }
  return '';
}

function checkContext(name) {
  const source = active(), check = source.review?.checks.find(c => c.name === name);
  if (!check) return `<p class="muted">This check is not in the current review.</p>`;
  return `<h2 class="ctx-title">${text(checkName(name))}</h2>
    <div class="ctx-status">${badge(check.passed ? 'Passed' : 'Failed', check.passed ? 'ok' : 'danger')}<span class="caption">${text(groupOf(name))} · ${source.recorded ? 'recorded in the test on a copy' : 'observed on the copy'}</span></div>
    <p class="small">${text(check.detail)}</p><p class="caption mono">${text(name)}</p>
    ${hasDiagnostics(check) ? diagnosticsView(check) : checkEvidence(name, source.review)}
    <p class="small muted">${source.recorded ? text(state.recording?.review_observation || 'Recorded in the test on a copy; not a current export check.') : 'Checks run on the tested copy and cannot be edited by the plan. Every download separately checks whether files changed since testing.'}</p>`;
}

function lineContext(ref) {
  const data = fileData(fileOf(ref)), line = data?.lines.find(l => l.ref === ref);
  if (!data) ensureFile(fileOf(ref)).then(() => renderContext()).catch(error => notice(error.message));
  let fields = '';
  try { const parsed = line && JSON.parse(line.text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = `<h3>Fields</h3>${fieldTable(parsed)}`; } catch (_) { /* not JSON */ }
  const citedBy = citedRefs().get(ref) || [];
  // Switching files keeps the selection (to compare a write with its receipt), so say which file it is from.
  const elsewhere = state.tab === 'evidence' && fileOf(ref) !== state.ev.name;
  return `<h2 class="mono ctx-title">${text(ref)}</h2><div class="ctx-status">${badge('Exact evidence line')}${citedBy.length?badge(`Cited by ${citedBy.length}`, 'ok'):''}</div>
    ${elsewhere?`<p class="ctx-note">${icon('file-text')}<span>From <span class="mono">${text(fileOf(ref))}</span>. The log is showing <span class="mono">${text(state.ev.name)}</span>. <button class="link" data-open-ref="${escape(ref)}">Show in ${text(fileOf(ref))}</button></span></p>`:''}
    ${line?`<pre class="cite-line">${tint(line.text)}</pre>`:`<div class="cite-line">${skeleton(2)}</div>`}${fields}
    ${citedBy.length?`<h3>Cited for cancelling</h3><div class="id-grid">${citedBy.map(id=>`<button class="id-chip mono" data-key="order:${escape(id)}">${text(id)}</button>`).join('')}</div>`:''}
    ${state.tab!=='evidence'?`<button class="secondary" data-open-ref="${escape(ref)}">Open in Evidence</button>`:''}`;
}

function eventContext(id) {
  const data = fileData('source_orders.json');
  if (!data) ensureFile('source_orders.json').then(() => renderContext()).catch(error => notice(error.message));
  const hits = data ? data.lines.filter(l => l.text.includes(id)) : [];
  return `<h2 class="mono ctx-title">${text(id)}</h2><div class="ctx-status">${badge('No commit evidence', true)}</div>
    <p class="small">This imported source event has no committed-write record linking it to an order ID, so the script stopped instead of guessing.</p>
    ${data?(hits.length?`<h3>In source_orders.json</h3>${hits.map(l=>`<div class="cite"><div class="cite-head"><button class="citation" data-open-ref="${escape(l.ref)}">${text(l.ref)}</button></div><pre class="cite-line">${tint(l.text)}</pre></div>`).join('')}`:'<p class="small muted">Not found in source_orders.json.</p>'):skeleton(3)}
    <button class="secondary" data-search-event="${escape(id)}">${icon('file-search')}<span>Search events.jsonl for this event</span></button>`;
}

/* ---------- Guide (the details column when nothing is selected) ---------- */

// The next step for the case on screen, from the server's run status. [eyebrow, title, body, cta, tone]
function nextStep(run) {
  const review = run?.review, total = review?.checks.length, passed = review?.checks.filter(c => c.passed).length;
  if (state.busy) return ['Working', state.busyAction === 'rehearse' ? 'Testing the repair on a copy…' : 'Reading the evidence…',
    state.busyAction === 'rehearse' ? 'The proposal is applied to a disposable copy and checked. The source database is not touched.' : 'The offline script reads the evidence files and order records with read-only tools.', null];
  if (!run) return ['Next step', 'Investigate the incident', `The script reads the ${state.incident.artifacts.length} evidence files and the order records with read-only tools, then proposes which repeated orders to cancel. It calls no model.`, 'investigate'];
  switch (run.status) {
    case 'proposed': return ['Next step', 'Test the repair on a copy', `The script proposes ${run.plan.cancellations.length} cancellations, each citing its evidence. Testing applies them to a copy and runs independent checks.`, 'rehearse'];
    case 'stopped': return ['Stopped', 'Evidence is missing', `${run.missing_event_ids?.length ?? 'Some'} source events have no commit record, so the script stopped instead of guessing. Nothing was changed.`, null, 'warn'];
    case 'ready_for_review': return ['Next step', 'Review, then export', `Check the ${review.cancellations} cancellations in Changes and the ${passed} / ${total} checks in Checks. Each download rechecks that the source and evidence are unchanged.`, 'review'];
    case 'failed_checks': return ['Checks failed', 'Nothing can be exported', `${total - passed} of ${total} checks failed on the copy. Open Checks to see which.`, 'checks', 'warn'];
    case 'blocked': return ['Export blocked', 'Start a new investigation', run.summary, 'investigate', 'warn'];
    default: return ['Status', statusOf(run)[0], run.summary || '', null];
  }
}

// Actions stay in the header (one primary button); the guide only adds shortcuts to the right tab.
const GUIDE_CTA = {
  review: () => state.tab === 'changes' ? `<button class="secondary" data-tab="checks">${icon('shield-check')}<span>Open Checks</span></button>`
    : `<button class="secondary" data-tab="changes">${icon('git-compare')}<span>Open Changes</span></button>`,
  checks: () => `<button class="secondary" data-tab="checks">${icon('shield-check')}<span>Open Checks</span></button>`,
};

const guideItem = (iconName, body) => `<li>${icon(iconName)}<span>${body}</span></li>`;

function guideView() {
  const close = `<button class="icon-button" data-close-context aria-label="Close guide">${icon('x')}</button>`;
  const head = `<div class="ctx-head"><span class="eyebrow">${icon('book-open')}Guide</span>${close}</div>`;
  const keys = `<h3>Shortcuts</h3><dl class="guide-keys"><dt><kbd>${paletteKeyLabel()}</kbd></dt><dd>Jump to a case, tab, order or evidence line</dd><dt><kbd>/</kbd></dt><dd>Search the evidence or changes</dd><dt><kbd>Esc</kbd></dt><dd>Close details</dd></dl>`;
  if (recordedMode()) {
    const r = state.recording, matched = recCitations(r);
    return `${head}<div class="guide">
      <div class="guide-next rec"><span class="eyebrow">Read-only history</span><h2>${text(r ? recordingLabel(r) : 'Recorded model runs')}</h2>
        <p>${r ? text(`A saved run of ${r.provenance?.model || 'a model'} on this case, recorded from the command line. Nothing here calls the model again.`) : 'Choose a recording from the list to see its steps.'}</p></div>
      <h3>How to read it</h3><ul class="guide-list">
        ${guideItem('bot', 'Investigation lists the recorded model messages and tool calls in order. Rejected steps show where the local runtime refused a call.')}
        ${guideItem('git-compare', 'The comparison on Investigation shows whether the model cancelled the same orders as the offline script. It checks agreement, not which is better.')}
        ${guideItem('shield-check', 'Changes and Checks show the review recorded in the test on a copy, not a current export check.')}
        ${guideItem('file-text', r && !matched ? 'This recording’s inputs differ from the case now, so links into the evidence are off.' : 'Evidence links work only while the recording’s inputs match this case.')}
      </ul>
      <p class="guide-note">Recordings cannot be tested again, exported or downloaded. Exports come only from a current offline test on a copy.</p>
      ${keys}</div>`;
  }
  const [eyebrow, title, body, cta, tone = ''] = nextStep(state.run), recs = recordedList().list;
  return `${head}<div class="guide">
    <div class="guide-next ${tone}"><span class="eyebrow">${text(eyebrow)}</span><h2>${text(title)}</h2><p>${text(body)}</p>${cta && GUIDE_CTA[cta] && !state.busy ? GUIDE_CTA[cta]() : ''}</div>
    <p class="caption guide-hint">Select any record, evidence line or check to see its exact values here.</p>
    <h3>What keeps this safe</h3><ul class="guide-list">
      ${guideItem('database', 'The source database is only read. Nothing here writes to it.')}
      ${guideItem('flask-conical', 'Every fix is rehearsed on a disposable copy and checked independently.')}
      ${guideItem('shield-check', 'Each download rechecks the source and evidence. The SQL rolls back if the tables changed.')}
      ${guideItem('circle-check', 'A person reviews the SQL before anyone applies it. This workbench never applies it.')}
    </ul>
    ${recs.length ? `<h3>Recorded model runs</h3><p class="small muted">${text(`${recs.length} saved Meta model runs exist for this case. They are read-only history; open one to compare it with this script run.`)}</p><button class="link small" data-source="recorded">${icon('history')}<span>Show recorded model runs</span></button>` : ''}
    ${keys}
    <p class="guide-note">Synthetic cases with no real people or transactions. The offline script calls no model.</p></div>`;
}

/* ---------- First-visit introduction ---------- */

// Shown until dismissed. Remembered in this browser only; if storage is unavailable it simply shows again.
const WELCOME_KEY = 'recovery-room.welcome-dismissed';
function welcomeDismissed() {
  try { return window.localStorage?.getItem(WELCOME_KEY) === '1'; } catch (_) { return false; }
}

function renderWelcome() {
  const box = $('#welcome');
  if (STATIC_DEMO || state.welcomeHidden || welcomeDismissed() || !state.cases.length || state.run || recordedMode()) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="welcome-text"><p><strong>Sample workspace.</strong> <span>${state.cases.length} synthetic incidents. Repairs are tested on disposable copies.</span></p>
    <details><summary>How it works</summary><p>It finds orders the retry wrote twice, proposes which to cancel with cited evidence, tests the fix on a disposable copy, and exports guarded SQL for a person to review. The source database is never changed.</p></details></div>
    <div class="welcome-actions"><button class="icon-button" data-dismiss-welcome aria-label="Dismiss introduction">${icon('x')}</button></div>`;
}

function dismissWelcome() {
  state.welcomeHidden = true;
  try { window.localStorage?.setItem(WELCOME_KEY, '1'); } catch (_) { /* storage unavailable: hide for this page only */ }
  const box = $('#welcome');
  box.hidden = true; box.innerHTML = '';
}

// Wide screens remember whether the guide was left open; it starts closed so the workspace is wide.
const GUIDE_KEY = 'recovery-room.guide-open';
function guidePreferred() {
  try { return window.localStorage?.getItem(GUIDE_KEY) === '1'; } catch (_) { return false; }
}
function rememberGuide(open) {
  if (isNarrow()) return;
  try { if (open) window.localStorage?.setItem(GUIDE_KEY, '1'); else window.localStorage?.removeItem(GUIDE_KEY); } catch (_) { /* per-page only */ }
}
const guideShowing = () => !!state.incident && !state.selection && state.guide && (!isNarrow() || state.sheet);

// The Guide button opens the guide (replacing any selected details) or, if it is showing, closes it.
function toggleGuide(trigger = null) {
  if (guideShowing()) { closeContext(); return; }
  state.lastFocus = trigger || document.activeElement; // closing returns focus to the Guide button
  Object.assign(state, {selection: null, sheet: true, guide: true});
  rememberGuide(true);
  renderContext(); markSelection();
  if (state.tab === 'evidence') renderEvidence();
  $('#context').focus();
}

function renderContext() {
  const box = $('#context'), sel = state.selection;
  // Wide screens show the details column only while something is selected or the guide is open, so the
  // workspace is full width otherwise. Narrow screens show it as a sheet opened by a selection or the
  // Guide button.
  box.classList.toggle('open', !!state.incident && state.sheet);
  const workspace = $('.workspace'), wasClosed = workspace.classList.contains('ctx-closed');
  workspace.classList.toggle('ctx-closed', !state.incident || (!sel && !state.guide));
  $('[data-open-guide]').setAttribute('aria-expanded', String(guideShowing()));
  // Opening the column narrows the tables; keep the selected row in view.
  if (wasClosed && sel && !isNarrow()) requestAnimationFrame(() => $('#content .selected')?.scrollIntoView({block: 'nearest'}));
  if (!sel || !state.incident) {
    state.ctxKey = null;
    box.innerHTML = state.incident ? guideView() : `<div class="ctx-head"><span class="eyebrow">Details</span></div>`;
    return;
  }
  const kinds = {order: ['hash', 'Record', orderContext], product: ['package', 'Product', productContext], check: ['shield-check', 'Check', checkContext], line: ['file-text', 'Evidence line', lineContext], event: ['file-search', 'Missing evidence', eventContext]};
  const [iconName, label, view] = kinds[sel.kind] || ['info', 'Details', () => ''];
  // Animate only when the selection changes, not when a cited line finishes loading into the same view.
  const key = `${sel.kind}:${sel.id}`, entering = state.ctxKey !== key;
  state.ctxKey = key;
  box.innerHTML = `<div class="ctx-head"><span class="eyebrow">${icon(iconName)}${label}</span><button class="icon-button" data-close-context aria-label="Close details">${icon('x')}</button></div><div class="ctx-body${entering ? ' enter' : ''}">${view(sel.id, sel.focusRef)}</div>`;
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
  // Closing details returns to the guide if it was open; closing the guide closes the column.
  if (state.selection) state.selection = null;
  else { state.guide = false; rememberGuide(false); }
  state.sheet = false;
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
  if (STATIC_DEMO || historicalRun(state.run)) { notice(READ_ONLY_NOTE); return; }
  const id = state.incident.id;
  Object.assign(state, {busy: true, busyAction: action}); notice(); render();
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
    // Confirmations are transient; a refusal stays on screen as a notice.
    if (run.status === 'blocked') notice(run.summary);
    else if (action === 'investigate') toast(run.status === 'stopped' ? 'Investigation stopped · evidence needed' : run.plan ? `Proposal ready · ${run.plan.cancellations.length} cancellations` : statusOf(run)[0], run.status === 'stopped' ? 'warn' : 'ok');
    else if (run.review) {
      const passed = run.review.checks.filter(c => c.passed).length;
      toast(run.status === 'ready_for_review' ? `Tested on a copy · ${passed}/${run.review.checks.length} checks passed` : `Checks failed on the copy · ${passed}/${run.review.checks.length} passed`, run.status === 'ready_for_review' ? 'ok' : 'error');
    }
  } catch (error) { notice(error.message); }
  finally {
    Object.assign(state, {busy: false, busyAction: null});
    transition(() => { render(); $('#content').focus({preventScroll: true}); }, 'case');
  }
}

// Every artifact request goes through the server's freshness gate. A delayed failure updates
// only the case and run it was started for, and names that case in the error.
async function fetchArtifact(name) {
  if (historicalRun(state.run)) throw demoError(READ_ONLY_NOTE, 405);
  const incidentId = state.incident.id, runId = state.run.id;
  const incidentTitle = state.incident.title || incidentId;
  setLoading(true);
  let response;
  try { response = await fetch(`/api/runs/${runId}/artifacts/${encodeURIComponent(name)}`); }
  finally { setLoading(false); }
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

async function download(name, button = $(`[data-download="${name}"]`)) {
  if (historicalRun(state.run)) { notice(READ_ONLY_NOTE); return; }
  const runId = state.run.id;
  button?.setAttribute?.('aria-busy', 'true');
  try {
    const response = await fetchArtifact(name);
    const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
    toast(`${name} downloaded · files unchanged since testing`);
    if (state.run?.id === runId && (state.tab === 'checks' || state.tab === 'changes')) renderPanel();
  } finally { button?.removeAttribute?.('aria-busy'); }
}

// Copy feedback: the button briefly confirms in place, and a toast (a polite live region) announces the result.
const copyLabels = new WeakMap();
async function copyText(button, value, what) {
  if (button && !copyLabels.has(button)) copyLabels.set(button, button.innerHTML);
  try {
    await navigator.clipboard.writeText(value);
    if (button) button.innerHTML = `${icon('check')}<span>Copied</span>`;
    toast(`${what} copied`);
  } catch (_) {
    if (button) button.innerHTML = `${icon('circle-x')}<span>Copy unavailable</span>`;
    toast(`${what} could not be copied`, 'warn');
  }
  if (button) setTimeout(() => { if (button.isConnected) button.innerHTML = copyLabels.get(button); }, 1500);
}

async function copySql(button) {
  if (historicalRun(state.run)) { notice(READ_ONLY_NOTE); return; }
  const entry = state.sql.get(state.run?.id);
  if (entry?.status !== 'ok') return;
  await copyText(button, entry.text, 'repair.sql');
}

async function recheckExport() {
  if (historicalRun(state.run)) { notice(READ_ONLY_NOTE); return; }
  const runId = state.run?.id;
  if (state.run?.status !== 'ready_for_review' || state.rechecking.has(runId)) return;
  // The button is replaced while the check runs; give focus back to it afterwards.
  const refocus = !!document.activeElement?.matches?.('[data-recheck-export]');
  state.rechecking.add(runId);
  state.exportChecks.delete(runId);
  renderPanel();
  try {
    const response = await fetchArtifact('report.json');
    await response.text();
    toast('Files unchanged since testing: source, evidence and tested copy');
  } catch (error) { notice(error.message); }
  finally {
    state.rechecking.delete(runId);
    if (state.run?.id === runId) render();
    const now = document.activeElement;
    if (refocus && (!now || now === document.body || !now.isConnected)) $('#content [data-recheck-export]')?.focus({preventScroll: true});
  }
}

/* ---------- Command palette ---------- */

const palette = {items: [], active: 0, ran: false, returnFocus: null};
const paletteKeyLabel = () => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')) ? '⌘K' : 'Ctrl K';

/* ---------- Sidebar rail ---------- */

// Wide screens can fold the sidebar to a rail of progress rings. It folds by default at 1200px and
// below; an explicit choice is remembered in this browser. Phones use the drawer instead.
const RAIL_KEY = 'recovery-room.sidebar';
function railPreference() {
  try { return window.localStorage?.getItem(RAIL_KEY) || ''; } catch (_) { return ''; }
}
function applyRail() {
  const app = $('.app');
  if (!app?.classList) return;
  const pref = state.railPref ?? railPreference();
  const rail = !isNarrow() && (pref ? pref === 'rail' : typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1200px)').matches);
  app.classList.toggle('nav-rail', rail);
  const button = $('.rail-toggle');
  if (button) {
    button.setAttribute('aria-label', rail ? 'Expand sidebar' : 'Collapse sidebar');
    button.setAttribute('title', rail ? 'Expand sidebar · [' : 'Collapse sidebar · [');
    button.innerHTML = icon(rail ? 'panel-left-open' : 'panel-left-close');
  }
  applyWidth();
  positionTabIndicator();
}
// The open sidebar can be dragged between 200px and 400px (less on small screens). Dragging past its
// narrowest width folds it to the rail and dragging out of the rail opens it again; double-click resets
// it. The splitter also works from the keyboard. The width is remembered in this browser.
const WIDTH_KEY = 'recovery-room.sidebar-width';
const SIDE = {min: 200, max: 400, rail: 56, fold: 140, step: 16, bigStep: 48};
const sideDefault = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1200px)').matches ? 228 : 240;
// Leave the workspace at least about 700px; never below the default width.
const sideMax = () => Math.max(sideDefault(), Math.min(SIDE.max, (window.innerWidth || 1280) - 700));
const clampSide = (px) => Math.round(Math.min(sideMax(), Math.max(SIDE.min, px)));
function storedWidth() {
  try { const n = Number(window.localStorage?.getItem(WIDTH_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch (_) { return null; }
}
const sideWidth = () => { const w = state.sideWidth === undefined ? storedWidth() : state.sideWidth; return w == null ? sideDefault() : clampSide(w); };
function applyWidth() {
  const app = $('.app');
  if (!app?.style || !app.classList) return;
  const custom = state.sideWidth === undefined ? storedWidth() : state.sideWidth;
  if (custom == null) app.style.removeProperty('--side-w'); else app.style.setProperty('--side-w', `${clampSide(custom)}px`);
  const handle = $('.resizer'), rail = app.classList.contains('nav-rail'), w = rail ? SIDE.rail : sideWidth();
  if (!handle?.setAttribute) return;
  handle.setAttribute('aria-valuemax', String(sideMax()));
  handle.setAttribute('aria-valuenow', String(w));
  handle.setAttribute('aria-valuetext', rail ? 'Folded to icons' : `${w} pixels wide`);
}
function saveSidebar() {
  try {
    window.localStorage?.setItem(RAIL_KEY, state.railPref);
    if (state.sideWidth == null) window.localStorage?.removeItem(WIDTH_KEY); else window.localStorage?.setItem(WIDTH_KEY, String(state.sideWidth));
  } catch (_) { /* this page only */ }
}
// One sidebar layout for a drag step or key press: open at a width, or folded.
function setSidebar({rail, width}) {
  state.railPref = rail ? 'rail' : 'full';
  if (width !== undefined) state.sideWidth = width == null ? null : clampSide(width);
  applyRail();
}
function resetSidebar() {
  if (isNarrow()) return;
  setSidebar({rail: false, width: null});
  saveSidebar();
}
function resizeKey(event) {
  const rail = $('.app').classList.contains('nav-rail'), w = sideWidth();
  const step = event.shiftKey ? SIDE.bigStep : SIDE.step;
  let next = null;
  if (event.key === 'ArrowLeft') next = rail ? null : w <= SIDE.min ? {rail: true} : {rail: false, width: w - step};
  else if (event.key === 'ArrowRight') next = rail ? {rail: false} : {rail: false, width: w + step};
  else if (event.key === 'Home') next = {rail: false, width: SIDE.min};
  else if (event.key === 'End') next = {rail: false, width: sideMax()};
  else if (event.key === 'Enter') next = {rail: !rail};
  else return false;
  event.preventDefault();
  if (next) { setSidebar(next); saveSidebar(); }
  return true;
}

let sideDrag = null, sideFrame = 0;
function startSideDrag(event, handle) {
  if (event.button !== 0 || isNarrow()) return;
  event.preventDefault();
  const app = $('.app');
  sideDrag = {id: event.pointerId, x: event.clientX, from: $('#sidebar').getBoundingClientRect().width, moved: false,
    // keep: the open width before this drag, so folding and opening again comes back to it.
    keep: state.sideWidth === undefined ? storedWidth() : state.sideWidth, undo: {pref: state.railPref, width: state.sideWidth}};
  try { handle.setPointerCapture(event.pointerId); } catch (_) { /* a mouse without capture still works */ }
  app.classList.add('resizing');
}
function moveSideDrag(event) {
  if (!sideDrag || event.pointerId !== sideDrag.id) return;
  const dx = event.clientX - sideDrag.x;
  if (!sideDrag.moved && Math.abs(dx) < 3) return;
  sideDrag.moved = true;
  const raw = sideDrag.from + dx;
  sideDrag.next = raw < SIDE.fold ? {rail: true, width: sideDrag.keep} : {rail: false, width: raw};
  if (!sideFrame) sideFrame = requestAnimationFrame(() => { sideFrame = 0; if (sideDrag?.next) setSidebar(sideDrag.next); });
}
function endSideDrag(event, cancel = false) {
  if (!sideDrag || (event && event.pointerId !== sideDrag.id)) return;
  const drag = sideDrag;
  sideDrag = null;
  if (sideFrame) { cancelAnimationFrame(sideFrame); sideFrame = 0; }
  try { $('.resizer').releasePointerCapture(drag.id); } catch (_) { /* already released */ }
  $('.app').classList.remove('resizing');
  if (cancel) { state.railPref = drag.undo.pref; state.sideWidth = drag.undo.width; applyRail(); return; }
  if (!drag.moved) return;
  if (drag.next) setSidebar(drag.next);
  saveSidebar();
}

function toggleRail() {
  if (isNarrow()) return;
  state.railPref = $('.app').classList.contains('nav-rail') ? 'full' : 'rail';
  try { window.localStorage?.setItem(RAIL_KEY, state.railPref); } catch (_) { /* this page only */ }
  applyRail();
}

/* ---------- Phone case drawer ---------- */

// On narrow screens the sidebar (cases and runs) is a drawer opened from the top bar.
function setNav(open) {
  const app = $('.app'), scrim = $('.scrim');
  if (!app?.classList) return;
  state.nav = !!open && isNarrow();
  app.classList.toggle('nav-open', state.nav);
  $('#nav-toggle').setAttribute('aria-expanded', String(state.nav));
  scrim.hidden = !state.nav;
  if (state.nav) ($('#cases .case.active') || $('#cases .case'))?.focus({preventScroll: true});
}

function closeNav() {
  if (!state.nav) return;
  setNav(false);
  $('#nav-toggle').focus();
}

function goToCase(id) {
  if (id !== (state.switching || state.incident?.id)) location.hash = `case=${id}`;
}

function inspectOrder(id) {
  const review = state.run?.review;
  const inReview = review && (review.changes.some(c => c.before.id === id) || review.preserved_orders.some(o => o.id === id));
  setTab(inReview ? 'changes' : 'investigation');
  select(`order:${id}`);
}

// Every command calls an existing local action; the palette adds navigation, not new capability.
function paletteCommands(query) {
  const q = query.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean), items = [];
  const add = (group, label, hint, iconName, run, extra = '') => items.push({group, label, hint, icon: iconName, run, hay: `${group} ${label} ${hint} ${extra}`.toLowerCase()});
  const run = state.run;
  if (state.incident) {
    const recs = recordedList().list;
    if (recordedMode()) add('Actions', 'Show script run', 'Offline script · no model', 'play', () => setSource('script'), 'script offline');
    else if (recs.length) add('Actions', 'Show recorded model runs', `${recs.length} recorded · not live`, 'history', () => setSource('recorded'), 'recorded model meta');
    for (const r of recs) add('Recorded runs', `${recOutcome(r)[0]} · ${recordedShort(r.recorded_at)}`, `${r.model} · ${r.tool_calls} tool results`, 'history',
      () => { if (!recordedMode()) setSource('recorded'); return loadRecording(r.id); }, `recording ${r.outcome}`);
  }
  // Offline actions exist only in script mode, and never for read-only history (the public demo, or a recorded
  // baseline). Recordings are never rehearsed, exported or rechecked.
  if (state.incident && !state.busy && !recordedMode()) {
    if (!historicalRun(run)) {
      add('Actions', run ? 'New offline investigation' : 'Start offline investigation', 'Offline script · no model', run ? 'refresh-cw' : 'play', () => act('investigate'), 'investigate run start');
      if (run?.status === 'proposed') add('Actions', 'Test repair on a copy', 'Copy only', 'flask-conical', () => act('rehearse'), 'rehearse test');
      if (run?.status === 'ready_for_review') {
        add('Actions', 'Check files again', 'Files changed since testing?', 'refresh-cw', () => { setTab('checks'); return recheckExport(); }, 'recheck freshness');
        for (const name of run.downloads) add('Actions', `Download ${name}`, 'Refused if files changed since testing', 'download', () => download(name), 'export artifact');
      }
    }
    if (run) add('Actions', 'Copy run ID', run.id, 'copy', () => copyText(null, run.id, 'Run ID'));
  }
  for (const tab of TABS) add('Go to', TAB_META[tab][1], 'Tab', TAB_META[tab][0], () => setTab(tab, true), 'tab');
  add('Go to', 'How we evaluated', 'Every recorded outcome and the limits', 'info', openEvaluation, 'evaluation results recorded runs failures limits');
  state.cases.forEach(c => add('Cases', c.title, caseStatus(c.id)[0], 'folder-open', () => goToCase(c.id), 'case incident'));
  if (!recordedMode()) for (const r of state.history.get(state.incident?.id) || []) add('Runs', `Run ${shortId(r.id)}`, `${statusOf(r)[0]} · started ${started(r.created_at)}`, 'history', () => loadRun(r.id), r.id);
  // "L28", "line 28" or "events.jsonl:L28" opens that exact evidence line.
  const line = /^(?:([\w-]+\.(?:jsonl|json|txt)):)?l(?:ine)?\s*(\d{1,5})$/.exec(q);
  if (line && state.incident) {
    const name = line[1] || state.ev.name, ref = `${name}:L${Number(line[2])}`;
    if (state.incident.artifacts.some(a => a.name === name)) add('Evidence', `Open ${ref}`, 'Exact evidence line', 'file-text', () => { openInEvidence(ref); select(`line:${ref}`, {keepFocus: true}); }, q);
  }
  // Order search reads current-case records, so it is offered only in script mode.
  if (q.length >= 3 && !recordedMode()) {
    (state.incident?.orders || []).filter(o => o.id.toLowerCase().includes(q) || o.customer.toLowerCase().includes(q)).slice(0, 6)
      .forEach(o => add('Orders', o.id, `${o.customer} · ${o.sku} × ${o.quantity}`, 'hash', () => inspectOrder(o.id), q));
  }
  return words.length ? items.filter(i => words.every(w => i.hay.includes(w))).slice(0, 30) : items.filter(i => i.group !== 'Orders');
}

function renderPalette() {
  const input = $('#palette-input'), list = $('#palette-list');
  palette.items = paletteCommands(input.value);
  palette.active = Math.min(palette.active, Math.max(0, palette.items.length - 1));
  let group = '';
  list.innerHTML = palette.items.length ? palette.items.map((item, i) => {
    const head = item.group !== group ? `<li class="palette-group" role="presentation">${text(group = item.group)}</li>` : '';
    return `${head}<li class="palette-item" role="option" id="pal-${i}" data-palette-index="${i}" aria-selected="${i === palette.active}">${icon(item.icon)}<span class="palette-label">${text(item.label)}</span><span class="palette-hint">${text(item.hint)}</span></li>`;
  }).join('') : '<li class="palette-empty" role="presentation">No matches. Try a case, a tab, an order ID or L28.</li>';
  if (palette.items.length) input.setAttribute('aria-activedescendant', `pal-${palette.active}`); else input.removeAttribute('aria-activedescendant');
  list.querySelector(`#pal-${palette.active}`)?.scrollIntoView({block: 'nearest'});
}

function openPalette() {
  const dialog = $('#palette');
  if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;
  Object.assign(palette, {returnFocus: document.activeElement, ran: false, active: 0});
  $('#palette-input').value = '';
  renderPalette();
  dialog.showModal();
  $('#palette-input').focus();
}

function runPaletteItem(index) {
  const item = palette.items[index];
  if (!item) return;
  palette.ran = true;
  $('#palette').close();
  Promise.resolve().then(item.run).catch(error => notice(error.message));
}

/* ---------- Events ---------- */

document.addEventListener('click', event => {
  const details = $('#run-details');
  if (details?.open && !event.target.closest?.('#run-details')) details.open = false;
  if (event.target.id === 'palette' || event.target.id === 'evaluation') { event.target.close(); return; } // backdrop click
  if (event.target.closest?.('[data-close-nav]')) { closeNav(); return; } // drawer backdrop
  const option = event.target.closest?.('[data-palette-index]');
  if (option) { runPaletteItem(Number(option.dataset.paletteIndex)); return; }
  const el = event.target.closest('button, [data-key]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  let task;
  if (d.navToggle !== undefined) { if (state.nav) closeNav(); else setNav(true); return; }
  // Choosing a case, run or recording in the phone drawer closes it.
  if (state.nav && (d.case || d.run || d.recording)) setNav(false);
  if (d.openGuide !== undefined) toggleGuide(el);
  if (d.dismissWelcome !== undefined) dismissWelcome();
  if (d.palette !== undefined) openPalette();
  if (d.source) setSource(d.source, d.recording || null);
  else if (d.recording && d.recording !== state.recId) task = loadRecording(d.recording);
  if (d.navRail !== undefined) toggleRail();
  if (d.stepFilter) { resetReplay(); state.stepFilter = d.stepFilter; holdFocus(renderPanel); }
  if (d.replayStart !== undefined) startReplay(1, true);
  if (d.openEvaluation !== undefined) openEvaluation();
  if (d.closeEvaluation !== undefined) $('#evaluation')?.close();
  if (d.replayFrom) startReplay(Number(d.replayFrom), false);
  if (d.replay === 'toggle') { if (state.replay?.playing) pauseReplay(); else playReplay(); }
  if (d.replay === 'next') nextReplay();
  if (d.replay === 'restart') startReplay(1, true);
  if (d.replay === 'exit') exitReplay();
  if (d.expandSteps !== undefined) {
    const items = [...document.querySelectorAll('#content .timeline details')], open = items.some(x => !x.open);
    items.forEach(x => { x.open = open; });
    el.textContent = open ? 'Collapse all' : 'Expand all';
  }
  if (d.refreshRecordings !== undefined) { const caseId = state.incident.id; task = refreshRecordings(caseId).then(() => { if (state.incident?.id === caseId) render(); }); }
  if (d.dismissToast) dismissToast(document.getElementById(d.dismissToast));
  if (d.case && d.case !== (state.switching || state.incident?.id)) {
    // The hash gives each case a link and browser back/forward; hashchange performs the switch.
    const hash = `#case=${d.case}`;
    if (location.hash.startsWith(`${hash}&`) || location.hash === hash) task = selectCase(d.case); else location.hash = hash.slice(1);
  }
  if (d.run && d.run !== state.run?.id && !state.busy) task = loadRun(d.run);
  if (d.tab) setTab(d.tab);
  if (d.reviewRepair !== undefined) reviewRepair();
  if (d.viewMissing !== undefined) viewMissing();
  if (d.reviewDownloads !== undefined) reviewRepair(true);
  if (d.action) task = act(d.action);
  if (d.download) task = download(d.download, el);
  if (d.file) {
    // Returning to the selected line's own file highlights it again; Details notes when it is from another file.
    const line = state.selection?.kind === 'line' ? state.selection.id : null;
    Object.assign(state.ev, {name: d.file, activeRef: line && fileOf(line) === d.file ? line : null});
    renderPanel();
    if (line) renderContext();
  }
  if (d.citedOnly !== undefined) { state.ev.citedOnly = !state.ev.citedOnly; el.setAttribute('aria-pressed', String(state.ev.citedOnly)); renderEvidence(); }
  if (d.openRef) openInEvidence(d.openRef);
  if (d.searchEvent) openInEvidence(null, d.searchEvent, 'events.jsonl');
  if (d.closeContext !== undefined) closeContext();
  if (d.copySql !== undefined) task = copySql(el);
  if (d.copyValue !== undefined) task = copyText(el, d.copyValue, d.copyWhat || 'ID');
  if (d.recheckExport !== undefined) task = recheckExport();
  if (d.reloadSql !== undefined) task = loadSql();
  if (d.key) select(d.key, {focusRef: d.focusRef || null});
  if (task) task.catch(error => notice(error.message));
});

document.addEventListener('keydown', event => {
  const t = event.target, key = event.key;
  if ((event.ctrlKey || event.metaKey) && String(key).toLowerCase() === 'k') {
    event.preventDefault();
    if ($('#palette')?.open) $('#palette').close(); else openPalette();
    return;
  }
  if (t.id === 'palette-input') {
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const n = palette.items.length;
      if (n) palette.active = (palette.active + (key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderPalette();
    } else if (key === 'Enter') { event.preventDefault(); runPaletteItem(palette.active); }
    return; // Escape is handled by the native <dialog>
  }
  if ($('#palette')?.open) return;
  if (key === 'Escape' && $('#run-details')?.open && t.closest?.('#run-details')) { event.preventDefault(); $('#run-details').open = false; $('#run-details>summary').focus(); return; }
  if (key === 'Escape' && sideDrag) { event.preventDefault(); endSideDrag(null, true); return; }
  if (t.classList?.contains('resizer') && !isNarrow() && resizeKey(event)) return;
  if (key === 'Escape' && state.nav) { event.preventDefault(); closeNav(); return; }
  if ((key === '[' || event.code === 'BracketLeft') && !event.shiftKey && !isTyping(t) && !event.ctrlKey && !event.metaKey && !event.altKey && !isNarrow()) { event.preventDefault(); toggleRail(); return; }
  if (t.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
    event.preventDefault();
    const index = TABS.indexOf(state.tab);
    const next = key === 'Home' ? 0 : key === 'End' ? TABS.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next], true);
    return;
  }
  const list = t.closest?.('#cases');
  if (list && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
    event.preventDefault();
    const items = [...list.querySelectorAll('.case, .run-item')].filter(el => el.offsetParent !== null), index = items.indexOf(t.closest('.case, .run-item'));
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, index + (key === 'ArrowDown' ? 1 : -1)));
    items[next]?.focus();
    return;
  }
  if (t.classList?.contains('recon-svg')) {
    if (moveRecon(t, key)) { event.preventDefault(); return; }
    if ((key === 'Enter' || key === ' ') && Number.isInteger(state.reconActive)) {
      const tick = t.querySelector(`[data-i="${state.reconActive}"]`);
      if (tick?.dataset.key) { event.preventDefault(); select(tick.dataset.key, {keepFocus: true}); }
      return;
    }
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
  if (key === 'Escape' && (state.selection || state.sheet || guideShowing()) && !isTyping(t)) { event.preventDefault(); closeContext(); }
});

document.addEventListener('input', event => {
  if (event.target.id === 'palette-input') { palette.active = 0; renderPalette(); return; }
  if (event.target.id === 'ev-search') { state.ev.query = event.target.value; renderEvidence(); }
  if (event.target.id === 'change-search' && active().review) { state.changeQuery = event.target.value; $('#change-table').innerHTML = changesTable(active().review.changes); markSelection(); }
});

document.addEventListener('change', event => {
  if (event.target.id !== 'change-filter' || !active().review) return;
  state.filter = event.target.value;
  $('#change-table').innerHTML = changesTable(active().review.changes);
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

// The palette returns focus to where it was opened unless a command moved it on purpose.
$('#palette').addEventListener('close', () => { if (!palette.ran && palette.returnFocus?.isConnected) palette.returnFocus.focus(); });
window.addEventListener('resize', () => { positionTabIndicator(); applyRail(); if (state.nav && !isNarrow()) setNav(false); });
document.addEventListener('pointerdown', event => { const handle = event.target.closest?.('.resizer'); if (handle) startSideDrag(event, handle); });
document.addEventListener('pointermove', moveSideDrag);
// Pointing at a commit highlights its column and lists its writes.
document.addEventListener('pointerover', event => { const dot = event.target.closest?.('.recon-svg .recon-tick'); if (dot) showColumn(Number(dot.dataset.i)); });
// On narrow screens the graph and the compared runs scroll sideways together, so their columns stay aligned.
document.addEventListener('scroll', event => {
  const box = event.target;
  if (!box?.classList?.contains('recon-scroll')) return;
  box.closest('.recon')?.querySelectorAll('.recon-scroll').forEach(o => { if (o !== box && o.scrollLeft !== box.scrollLeft) o.scrollLeft = box.scrollLeft; });
}, true);
document.addEventListener('pointerup', event => endSideDrag(event));
document.addEventListener('pointercancel', event => endSideDrag(event, true));
document.addEventListener('dblclick', event => { if (event.target.closest?.('.resizer')) resetSidebar(); });

// The public demo says so from the first paint, before its data loads: in the footer note at every width,
// in the sidebar, and in the phone top bar.
function showStaticLabel() {
  const label = $('#demo-label');
  if (label) label.hidden = false;
  const foot = $('.side-footer-text');
  if (foot) foot.textContent = STATIC_LABEL;
  $('.side-footer')?.setAttribute('title', 'Synthetic cases and saved runs. Nothing runs again, nothing is exported, and no API is called.');
  const note = $('.disclosure');
  if (typeof note?.insertAdjacentHTML === 'function' && !note.querySelector('.demo-note')) note.insertAdjacentHTML('afterbegin', `<strong class="demo-note">${text(STATIC_LABEL)}.</strong> `);
}

// A refused or missing public dataset leaves a plain refusal on screen; nothing else is tried.
function showStartFailure(error) {
  notice(error.message);
  if (!STATIC_DEMO) return;
  $('#title').textContent = 'Recorded demo unavailable';
  $('#content').removeAttribute('aria-busy');
  $('#content').innerHTML = `<div class="callout stop">${text(error.message)}</div>
    <p class="small muted">This page shows only its bundled recorded data. It made no API call and has no live fallback.</p>`;
}

if (STATIC_DEMO) showStaticLabel();
const startup = api('/api/incidents').then(async data => {
  document.querySelectorAll('.palette-key').forEach(k => { k.textContent = paletteKeyLabel(); });
  state.cases = data.incidents;
  if (STATIC_DEMO) state.demo = staticContract(await staticDataset());
  state.guide = !isNarrow() && guidePreferred();
  applyRail();
  // Restore each case's last recorded status from this server session, and each case's recording list
  // (so the sidebar can describe recordings in recorded mode), before showing the sidebar.
  await Promise.all(state.cases.flatMap(c => [
    refreshHistory(c.id).then(runs => runs[0] && !state.runs.has(c.id) ? api(`/api/runs/${encodeURIComponent(runs[0].id)}`).then(run => { state.runs.set(c.id, run); }) : null).catch(() => null),
    refreshRecordings(c.id)]));
  const target = parseHash();
  await selectCase(target?.id || demoStartCase() || data.incidents[0].id, target?.tab || null);
}).catch(showStartFailure);
