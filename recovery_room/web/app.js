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
  selection: null, sheet: false, lastFocus: null, filter: '', changeQuery: '',
  // rechecking: run IDs with an explicit export recheck in flight (one per run, never a global lock).
  runMeta: new Map(), exportChecks: new Map(), sql: new Map(), rechecking: new Set(),
};
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = (value) => escape(value);
const badge = (value, tone = '') => `<span class="pill ${tone === true ? 'warn' : tone || ''}">${text(value)}</span>`;
// count: optional {from, to, prefix, suffix} for a one-time count-up after a fresh rehearsal.
// The rendered text is always the final value, so the page is correct even without animation.
const metric = (value, label, count = null) => {
  const attrs = count ? ` data-count-from="${count.from}" data-count-to="${count.to}" data-count-prefix="${escape(count.prefix || '')}" data-count-suffix="${escape(count.suffix || '')}"` : '';
  return `<div class="metric"><strong${attrs}>${text(value)}</strong><span>${text(label)}</span></div>`;
};
// Lucide icons from the inline sprite in index.html (lucide-static 1.55.0, ISC; notice kept there).
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const skeleton = (lines = 6) => `<div class="skeleton-stack" aria-hidden="true">${'<span class="skeleton"></span>'.repeat(lines)}</div><span class="sr-only">Loading</span>`;
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
// What the UI may claim about each server-reported mode. An unknown mode is shown as reported,
// with no offline or no-model claim, so a future recorded or live mode cannot be mislabelled.
const MODE_INFO = {
  offline_deterministic_engine_demo_NOT_a_model_run: {
    short: 'Offline demo · No model', long: 'Offline deterministic script · no model',
    method: 'Actual local function calls, without model or API calls. Meta credits pending.',
  },
};
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

// A thin top progress bar while any local request is in flight (CSS delays it so quick requests never flash).
let loadingCount = 0;
function setLoading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  const bar = $('#progress');
  if (bar) bar.hidden = loadingCount === 0;
}

async function api(path, post = false) {
  setLoading(true);
  try {
    const response = await fetch(path, post ? {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'} : {});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The local request failed.');
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
// Runs a DOM update inside a same-document view transition where supported (Chromium); otherwise immediately.
// kind selects the CSS choreography: 'forward' / 'back' for tabs, 'case' for case and run switches.
// Motion must never block state: if the browser is not producing frames (background tab, hidden window),
// the update is applied after a short timeout and the transition's own call becomes a no-op.
function transition(update, kind = 'swap') {
  if (typeof document.startViewTransition !== 'function' || prefersReducedMotion() || document.visibilityState === 'hidden') { update(); return; }
  let applied = false;
  const once = () => { if (!applied) { applied = true; update(); } };
  const root = document.documentElement;
  root.dataset.vt = kind;
  try {
    document.startViewTransition(once).finished.catch(() => {}).finally(() => { if (root.dataset.vt === kind) delete root.dataset.vt; });
  } catch (_) { once(); delete root.dataset.vt; }
  setTimeout(once, 250);
}

// One-time count-up for metrics rendered with data-count-* after a fresh rehearsal.
function animateCounts() {
  if (prefersReducedMotion()) return;
  document.querySelectorAll('#content [data-count-to]').forEach(el => {
    const from = Number(el.dataset.countFrom), to = Number(el.dataset.countTo), final = el.textContent;
    const {countPrefix: prefix = '', countSuffix: suffix = ''} = el.dataset, start = performance.now(), duration = 650;
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - p, 3);
      el.textContent = p < 1 ? `${prefix}${Math.round(from + (to - from) * eased)}${suffix}` : final;
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function positionTabIndicator() {
  const ind = $('.tab-ind'), tab = $(`#tab-${state.tab}`);
  if (!ind?.style || !tab || typeof tab.offsetLeft !== 'number') return;
  ind.style.setProperty('--x', `${tab.offsetLeft}px`);
  ind.style.setProperty('--w', `${tab.offsetWidth}px`);
}

const statusOf = (run) => run ? (RUN_STATUS[run.status] || [run.status.replaceAll('_', ' '), '']) : ['Not started', ''];
const modeInfo = (mode) => MODE_INFO[mode] || {
  short: `Mode: ${String(mode || 'unknown').replaceAll('_', ' ')}`, long: String(mode || 'unknown').replaceAll('_', ' '),
  method: 'Reported by the server. This page makes no offline or no-model claim for this mode.', unverified: true,
};
const modeLabel = (mode) => modeInfo(mode).long;
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
  return `<span class="id-link mono ${tone}" data-key="order:${escape(full)}" title="${escape(full)}">${shown || `<span aria-hidden="true">${text(compactId(full))}</span><span class="sr-only">${text(full)}</span>`}</span>`;
};
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
  transition(() => {
    if (version !== state.version || state.incident?.id !== caseId) return;
    Object.assign(state, {run, selection: null, sheet: false, filter: '', changeQuery: ''});
    if (!run.review && ['changes', 'checks', 'sql'].includes(state.tab)) state.tab = 'investigation';
    render();
  }, 'case');
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
    transition(() => {
      if (version !== state.version) return; // a newer case switch started before this frame
      Object.assign(state, {
        incident, run, switching: null, sheet: false,
        tab: tab || view?.tab || (run?.review ? 'changes' : 'investigation'),
        ev: view?.ev ? {...view.ev} : {name: 'events.jsonl', query: '', citedOnly: false, activeRef: null},
        selection: view?.selection || null, filter: view?.filter || '', changeQuery: view?.changeQuery || '',
      });
      render();
      $('#content').focus({preventScroll: true});
    }, 'case');
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
  const mode = run?.mode || incident.mode, info = modeInfo(mode);
  $('#mode-indicator').textContent = info.short;
  $('#mode-indicator').classList.toggle('unverified', !!info.unverified);
  $('#incident-meta').innerHTML = `<span class="status ${tone}">${text(label)}</span>
    <span class="chip">Source read-only · Rehearsal on a copy</span>${olderRunNote(run)}`;
  $('#run-details').hidden = !run;
  $('#run-details-body').innerHTML = run ? `<dl class="run-facts">
      <dt>Run ID</dt><dd><span class="mono">${text(run.id)}</span> <button class="link" data-copy-value="${escape(run.id)}" data-copy-what="Run ID">${icon('copy')}<span>Copy run ID</span></button></dd>
      <dt>Started</dt><dd>${text(started(run.created_at)) || 'Not recorded'}</dd>
      <dt>Method</dt><dd>${text(info.long)}. ${text(info.method)}</dd>
      <dt>Review boundary</dt><dd>The source stays unchanged. Rehearsal uses a disposable copy. Human review is required before using exported SQL.</dd>
    </dl>` : '';
  // A new investigation is always one click away: the server's refusal messages tell the user to start one.
  // Busy buttons keep their place and show a spinner with the work in progress.
  const working = (label) => `${icon('loader-circle', 'spin')}<span>${label}</span>`;
  const investigate = (primary) => `<button class="${primary?'primary':'secondary'}" data-action="investigate" ${busy?'disabled aria-busy="true"':''}>${busy && state.busyAction === 'investigate' ? working('Reading local evidence…') : `${icon(run?'refresh-cw':'play')}<span>${run?'New offline investigation':'Start offline investigation'}</span>`}</button>`;
  let actions = '';
  if (!run) actions = investigate(true);
  else if (run.status === 'proposed') actions = `${investigate(false)}<button class="primary" data-action="rehearse" ${busy?'disabled aria-busy="true"':''}>${busy && state.busyAction === 'rehearse' ? working('Rehearsing on a copy…') : `${icon('flask-conical')}<span>Rehearse on a disposable copy</span>`}</button>`;
  else if (run.status === 'ready_for_review') actions = `${investigate(false)}<button class="primary" data-review-repair>${icon('git-compare')}<span>Review repair</span></button>`;
  else if (run.status === 'failed_checks') actions = `${investigate(false)}<button class="primary" data-tab="checks">${icon('shield-check')}<span>Review failed checks</span></button>`;
  // Blocked: recovery is a new investigation. Only a run that was rehearsed has a repair to review.
  else if (run.status === 'blocked') actions = `${run.review ? `<button class="secondary" data-review-repair>${icon('git-compare')}<span>Review blocked repair</span></button>` : ''}${investigate(true)}`;
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
  const direction = TABS.indexOf(tab) >= TABS.indexOf(state.tab) ? 'forward' : 'back';
  transition(() => {
    state.tab = tab;
    renderTabs(); renderPanel(); updateHash();
    if (focusTab) $(`#tab-${tab}`).focus();
  }, tab === state.tab ? 'swap' : direction);
}

function renderPanel() {
  const views = {investigation: investigationView, evidence: evidenceView, changes: changesView, checks: checksTab, sql: sqlView};
  const reviewing = state.run?.review && ['changes', 'checks', 'sql'].includes(state.tab);
  $('#content').innerHTML = `${reviewing ? reviewJump() : ''}${views[state.tab]()}`;
  if (state.tab === 'evidence') renderEvidence();
  if (state.tab === 'sql') maybeLoadSql();
  markSelection();
  if (state.countUp && state.countUp === state.run?.id && state.tab === 'changes') { state.countUp = null; animateCounts(); }
}

// The tab bar already moves between Changes, Checks and SQL; this only adds the jump to the artifacts.
function reviewJump() {
  return `<div class="review-jump"><span class="caption">Review the changes, checks and SQL, then the artifacts.</span><button class="link small" data-review-downloads>${icon('arrow-down')}Jump to review artifacts</button></div>`;
}

function reviewRepair(downloads = false) {
  setTab('changes');
  const target = downloads ? $('#repair-package') : $('#content');
  target?.scrollIntoView({block: 'start'});
  target?.focus({preventScroll: true});
}

const emptyState = (title, body, iconName = 'info') => `<div class="empty">${icon(iconName, 'empty-icon')}<h2>${text(title)}</h2><p>${text(body)}</p></div>`;

// Why a run has no rehearsal review, from its server status. A run blocked before rehearsal cannot be
// rehearsed again (the server only rehearses proposed runs), so it points to a new investigation instead.
function noReview(run, what) {
  if (!run) return emptyState(`No ${what} yet`, 'Start the offline investigation, then rehearse its proposal on a disposable copy.', 'play');
  if (run.status === 'stopped') return emptyState('No repair was proposed', 'The investigation stopped because evidence is missing. Nothing was changed.', 'ban');
  if (run.status === 'blocked') return `<div class="section-heading"><h2>Rehearsal refused</h2>${badge('Export blocked', true)}</div>
    <div class="callout stop">${text(run.summary)}</div>
    <p class="small muted">Nothing was rehearsed or changed. Start a new offline investigation from the header to work from the current source and evidence.</p>`;
  return emptyState('Not rehearsed yet', `Rehearse the proposal on a disposable copy to see ${what}.`, 'flask-conical');
}

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
    rows.map(o=>[purchaseCell(o),idRef(o.id),text(o.status),`<span class="mono">${text(o.source_reference||'—')}</span>`]),
    rows.map(o=>`class="sel" tabindex="0" data-key="order:${escape(o.id)}" aria-selected="false"`));
}

// Citation shortcuts inside a selectable row. Keyboard users select the row (one tab stop per row);
// the details panel then lists the same citations with links into Evidence.
function citations(action) {
  return `<span class="citations">${action.evidence_refs.map(ref=>`<button class="citation" tabindex="-1" data-key="order:${escape(action.order_id)}" data-focus-ref="${escape(ref)}">${text(ref)}</button>`).join('')}</span>`;
}

function planTable(plan) {
  const orders = ordersById();
  return table(['Purchase','Cancel duplicate','Keep original','Evidence'],
    plan.cancellations.map(a=>[purchaseCell(orders.get(a.order_id)),idRef(a.order_id,'cancelled'),idRef(a.duplicate_of),citations(a)]),
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
      <label class="search">${icon('search')}<span class="sr-only">Search lines</span><input id="ev-search" type="search" placeholder="Search lines" value="${escape(ev.query)}" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label>
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
  return `${reviewSummary(run, review)}${diffView(review)}${artifactsView(run)}`;
}

function reviewSummary(run, review) {
  const ready = run.status === 'ready_for_review';
  const passed = review.checks.filter(c => c.passed).length;
  const source = review.checks.find(c => c.name === 'source_snapshot_unchanged');
  const failed = review.checks.filter(c => !c.passed);
  return `<div class="section-heading"><h2>${ready?'Rehearsed. Ready for your review.':'Export unavailable'}</h2>${badge(ready?'Rehearsal snapshot':statusOf(run)[0],!ready)}</div>
    <div class="callout ${ready?'success':'stop'}">${text(run.summary)}</div>
    <div class="metrics four">${metric(`${review.before_active} → ${review.after_active}`,'active records',{from:review.before_active,to:review.after_active,prefix:`${review.before_active} → `})}${metric(review.cancellations,'duplicate orders cancelled',{from:0,to:review.cancellations})}${metric(`${review.checkout_preserved} / ${review.checkout_total}`,'later checkout purchases intact',{from:0,to:review.checkout_preserved,suffix:` / ${review.checkout_total}`})}${metric(`${passed} / ${review.checks.length}`,'independent checks passed',{from:0,to:passed,suffix:` / ${review.checks.length}`})}</div>
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
      <label class="search">${icon('search')}<span class="sr-only">Search changed records</span><input id="change-search" type="search" placeholder="Search order, customer or product" value="${escape(state.changeQuery)}" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label>
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
    return [purchaseCell(c.before),`<span class="sym mod" title="${escape(changed.join(', '))} changed">~</span> ${idRef(c.before.id,'cancelled',q)}`,`<span class="before">${text(c.before.status)}</span> → <span class="after">${text(c.after.status)}</span>`,idRef(c.duplicate_of,'',q),citations({order_id:c.before.id,evidence_refs:c.evidence_refs})];
  }),rows.map(c=>`class="sel" tabindex="0" data-key="order:${escape(c.before.id)}" aria-selected="false"`));
}

function artifactsView(run) {
  const check = state.exportChecks.get(run.id);
  return `<section class="artifacts" id="repair-package" tabindex="-1"><h3>Review artifacts</h3>
    <p class="small muted">Each download rechecks source, evidence and candidate freshness. Guarded SQL also rejects changed table state when applied. Human review is required.${check?` Last check: ${check.ok?'passed':'refused'} at ${time(check.at)}.`:''}</p>
    <div class="download-row">${run.downloads.map(name=>`<button class="download" data-download="${escape(name)}">${icon('download')}<span class="download-text"><strong>${text(name)}</strong><span>${text(DOWNLOAD_NOTES[name]||'')}</span></span></button>`).join('')||'<span class="caption">No artifacts available for export.</span>'}</div>
    <p class="caption">Source database untouched.</p></section>`;
}

/* ---------- Checks ---------- */

function exportStatus(run) {
  const check = state.exportChecks.get(run.id);
  if (run.status === 'ready_for_review') {
    if (state.rechecking.has(run.id)) return {label: 'Rechecking current files…', tone: '', detail: 'The server is checking source, evidence and candidate freshness.'};
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
  if (!review) return noReview(run, 'independent checks');
  const passed = review.checks.filter(c => c.passed).length, meta = state.runMeta.get(run.id) || {}, exp = exportStatus(run);
  return `<div class="section-heading"><h2>Independent operational checks</h2>${badge(`${passed} / ${review.checks.length} passed`,!review.passed)}</div>
    <div class="status-cards">
      <div class="status-card ${review.passed?'ok':'danger'}"><span class="eyebrow">At rehearsal</span><strong>${passed} / ${review.checks.length} checks passed</strong><span class="caption">Observed on the rehearsal snapshot${meta.rehearsedAt?` · result received ${time(meta.rehearsedAt)} on this page`:''}</span></div>
      <div class="status-card ${exp.tone}"><span class="eyebrow">Export freshness</span><strong>${text(exp.label)}</strong><span class="caption">${text(exp.detail)}</span>${run.status==='ready_for_review'?`<button class="secondary" data-recheck-export ${state.rechecking.has(run.id)?'disabled aria-busy="true"':''}>${state.rechecking.has(run.id)?`${icon('loader-circle','spin')}<span>Rechecking…</span>`:`${icon('refresh-cw')}<span>Recheck for export</span>`}</button>`:''}</div>
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
  if (!run?.review) return noReview(run, 'the guarded repair script');
  if (run.status !== 'ready_for_review') return `<div class="section-heading"><h2>Export unavailable</h2>${badge(statusOf(run)[0], true)}</div>
    <div class="callout stop">${text(run.summary)}</div>
    <p class="small muted">The server only serves SQL for a current, passing rehearsal. Every request rechecks source and evidence first.</p>`;
  const entry = state.sql.get(run.id) || {status: 'loading'};
  const body = entry.status === 'ok'
    ? `<div class="code" role="region" aria-label="repair.sql, read-only" tabindex="0">${entry.text.replace(/\r?\n$/, '').split(/\r?\n/).map((l,i)=>`<div class="code-line"><span class="ln">${i+1}</span><span class="lt">${sqlTint(l)}</span></div>`).join('')}</div>`
    : entry.status === 'error' ? `<div class="callout stop">${text(entry.message)}</div>` : `<div class="code code-loading"><p class="caption">${icon('loader-circle','spin')} Rechecking freshness and loading repair.sql…</p>${skeleton(12)}</div>`;
  return `<div class="sql-head"><div><span class="eyebrow">repair.sql · read-only</span><h2>Guarded repair script</h2></div>
      <div class="sql-actions"><button class="secondary" data-copy-sql ${entry.status!=='ok'?'disabled':''}>${icon('copy')}<span>Copy</span></button><button class="secondary" data-reload-sql>${icon('refresh-cw')}<span>Recheck and reload</span></button><button class="secondary" data-download="repair.sql">${icon('download')}<span>Download</span></button></div></div>
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
    ${line?`<pre class="cite-line">${tint(line.text)}</pre>`:data?'<pre class="cite-line">Line not found in the loaded evidence.</pre>':`<div class="cite-line">${skeleton(2)}</div>`}</div>`;
}

function orderContext(id, focusRef) {
  const review = state.run?.review;
  const change = review?.changes.find(c => c.before.id === id);
  const planned = !change && state.run?.plan?.cancellations.find(a => a.order_id === id);
  const record = change?.before || ordersById().get(id) || review?.preserved_orders.find(o => o.id === id);
  if (!record) return `<p class="muted">This record is not in the selected incident.</p>`;
  let html = `<h2 class="mono ctx-title">${text(id)}</h2><p class="small muted">${purchase(record)}</p><button class="link small" data-copy-value="${escape(id)}" data-copy-what="Order ID">${icon('copy')}<span>Copy order ID</span></button>`;
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

function renderContext() {
  const box = $('#context'), sel = state.selection;
  // Wide screens keep a fixed details column, so selecting or closing never reflows the tables.
  // Narrow screens show it as a sliding sheet that opens only on an explicit selection.
  box.classList.toggle('open', !!sel && !!state.incident && state.sheet);
  if (!sel || !state.incident) {
    state.ctxKey = null;
    box.innerHTML = `<div class="ctx-head"><span class="eyebrow">Details</span></div><div class="ctx-empty">${icon('info', 'empty-icon')}<h2>Nothing selected</h2>
      <p class="small muted">Select a record, evidence line, check or citation to see exact values here. Press <kbd>${paletteKeyLabel()}</kbd> to jump anywhere.</p></div>`;
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
  Object.assign(state, {busy: true, busyAction: action}); notice(); render();
  try {
    const path = action === 'investigate' ? `/api/incidents/${id}/investigate` : `/api/runs/${state.run.id}/rehearse`;
    const run = await api(path, true);
    state.runs.set(id, run);
    upsertHistory(run);
    if (action === 'rehearse') {
      state.runMeta.set(run.id, {rehearsedAt: new Date()});
      state.exportChecks.delete(run.id); state.sql.delete(run.id);
      if (run.review) state.countUp = run.id;
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
      toast(run.status === 'ready_for_review' ? `Rehearsed on a copy · ${passed}/${run.review.checks.length} checks passed` : `Checks failed at rehearsal · ${passed}/${run.review.checks.length} passed`, run.status === 'ready_for_review' ? 'ok' : 'error');
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

async function download(name) {
  const runId = state.run.id, button = $(`[data-download="${name}"]`);
  button?.setAttribute?.('aria-busy', 'true');
  try {
    const response = await fetchArtifact(name);
    const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
    toast(`${name} downloaded · freshness check passed`);
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
  const entry = state.sql.get(state.run?.id);
  if (entry?.status !== 'ok') return;
  await copyText(button, entry.text, 'repair.sql');
}

async function recheckExport() {
  const runId = state.run?.id;
  if (state.run?.status !== 'ready_for_review' || state.rechecking.has(runId)) return;
  state.rechecking.add(runId);
  state.exportChecks.delete(runId);
  renderPanel();
  try {
    const response = await fetchArtifact('report.json');
    await response.text();
    toast('Freshness check passed · source, evidence and candidate unchanged');
  } catch (error) { notice(error.message); }
  finally {
    state.rechecking.delete(runId);
    if (state.run?.id === runId) render();
  }
}

/* ---------- Command palette ---------- */

const palette = {items: [], active: 0, ran: false, returnFocus: null};
const paletteKeyLabel = () => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')) ? '⌘K' : 'Ctrl K';

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
  if (state.incident && !state.busy) {
    add('Actions', run ? 'New offline investigation' : 'Start offline investigation', 'Offline script · no model', run ? 'refresh-cw' : 'play', () => act('investigate'), 'investigate run start');
    if (run?.status === 'proposed') add('Actions', 'Rehearse on a disposable copy', 'Copy only', 'flask-conical', () => act('rehearse'), 'rehearse');
    if (run?.status === 'ready_for_review') {
      add('Actions', 'Recheck for export', 'Freshness check', 'refresh-cw', () => { setTab('checks'); return recheckExport(); }, 'recheck freshness');
      for (const name of run.downloads) add('Actions', `Download ${name}`, 'Rechecks freshness first', 'download', () => download(name), 'export artifact');
    }
    if (run) add('Actions', 'Copy run ID', run.id, 'copy', () => copyText(null, run.id, 'Run ID'));
  }
  for (const tab of TABS) add('Go to', TAB_META[tab][1], 'Tab', TAB_META[tab][0], () => setTab(tab, true), 'tab');
  state.cases.forEach(c => add('Cases', c.title, caseStatus(c.id)[0], 'folder-open', () => goToCase(c.id), 'case incident'));
  for (const r of state.history.get(state.incident?.id) || []) add('Runs', `Run ${shortId(r.id)}`, `${statusOf(r)[0]} · started ${started(r.created_at)}`, 'history', () => loadRun(r.id), r.id);
  // "L28", "line 28" or "events.jsonl:L28" opens that exact evidence line.
  const line = /^(?:([\w-]+\.(?:jsonl|json|txt)):)?l(?:ine)?\s*(\d{1,5})$/.exec(q);
  if (line && state.incident) {
    const name = line[1] || state.ev.name, ref = `${name}:L${Number(line[2])}`;
    if (state.incident.artifacts.some(a => a.name === name)) add('Evidence', `Open ${ref}`, 'Exact evidence line', 'file-text', () => { openInEvidence(ref); select(`line:${ref}`, {keepFocus: true}); }, q);
  }
  if (q.length >= 3) {
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
  if (event.target.id === 'palette') { event.target.close(); return; } // backdrop click
  const option = event.target.closest?.('[data-palette-index]');
  if (option) { runPaletteItem(Number(option.dataset.paletteIndex)); return; }
  const el = event.target.closest('button, [data-key]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  let task;
  if (d.palette !== undefined) openPalette();
  if (d.dismissToast) dismissToast(document.getElementById(d.dismissToast));
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
  if (event.target.id === 'palette-input') { palette.active = 0; renderPalette(); return; }
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

// The palette returns focus to where it was opened unless a command moved it on purpose.
$('#palette').addEventListener('close', () => { if (!palette.ran && palette.returnFocus?.isConnected) palette.returnFocus.focus(); });
window.addEventListener('resize', positionTabIndicator);

api('/api/incidents').then(async data => {
  $('#palette-key').textContent = paletteKeyLabel();
  state.cases = data.incidents;
  // Restore each case's last recorded status from this server session before showing the sidebar.
  await Promise.all(state.cases.map(c => refreshHistory(c.id).catch(() => null)));
  const target = parseHash();
  await selectCase(target?.id || data.incidents[0].id, target?.tab || null);
}).catch(error => notice(error.message));
