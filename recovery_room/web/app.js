'use strict';

// Presentation only. The Python engine owns plans, rehearsal, checks, freshness and exports;
// this file displays what the local API returns and never decides whether a repair is valid.
const $ = (selector) => document.querySelector(selector);
const PAGE = 40;
const state = {
  incident: null, run: null, stage: 'incident', cases: [], runs: new Map(), views: new Map(),
  artifact: 'events.jsonl', page: 1, next: null, total: 0, lines: null, positions: {},
  focus: null, back: null, filter: '', busy: false, switching: null, version: 0, evidenceVersion: 0,
};
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = (value) => escape(value);
const badge = (value, warn = false) => `<span class="pill${warn ? ' warn' : ''}">${text(value)}</span>`;
const metric = (value, label) => `<div class="metric"><strong>${text(value)}</strong><span>${text(label)}</span></div>`;
const table = (headers, rows, rowAttrs = []) => `<div class="scroll-table"><table><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row,i)=>`<tr ${rowAttrs[i]||''}>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// Labels for run states reported by the server; unknown states are shown as-is.
const RUN_STATUS = {
  proposed: ['Proposal ready', ''],
  stopped: ['Stopped · evidence needed', 'warn'],
  ready_for_review: ['Ready for review', 'ok'],
  failed_checks: ['Checks failed', 'warn'],
  blocked: ['Export blocked', 'warn'],
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
  'report.json': 'Checks and before/after state.',
  'report.html': 'Readable review report.',
};
const REVIEW_SECTIONS = [['rv-stock','Inventory'],['rv-checks','Checks'],['rv-changes','Changed records'],['rv-preserved','Preserved work'],['rv-artifacts','Artifacts']];

async function api(path, post = false) {
  const response = await fetch(path, post ? {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'} : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The local request failed.');
  return value;
}

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function focusWorkspace() { $('#workspace').focus({preventScroll:true}); $('#workspace').scrollIntoView({block:'start'}); }

const stageAvailable = (stage, run = state.run) => stage === 'incident' || (stage === 'investigate' && !!run) || (stage === 'review' && !!run?.review);
const defaultStage = (run) => run?.review ? 'review' : run ? 'investigate' : 'incident';
const lineOf = (ref) => Number(String(ref).split(':L')[1]);
const fileOf = (ref) => String(ref).split(':L')[0];
const pageStart = (line) => Math.floor((line - 1) / PAGE) * PAGE + 1;
const purchase = (o) => o ? `${text(o.customer)} · ${text(o.sku)} × ${text(o.quantity)}` : '—';
// Same rule the server uses for its checkout_preserved count (workbench._review).
const isCheckout = (o) => (o.source_reference || '').startsWith('checkout-');

/* ---------- Case navigation ---------- */

function caseStatus(id) {
  if (state.switching === id) return ['Loading…', 'loading'];
  const run = state.runs.get(id);
  if (!run) return ['Not started', ''];
  return RUN_STATUS[run.status] || [run.status.replaceAll('_', ' '), ''];
}

function renderCases() {
  $('#case-count').textContent = String(state.cases.length).padStart(2,'0');
  $('#cases').innerHTML = state.cases.map((c,i)=>{
    const active = c.id === (state.switching || state.incident?.id);
    const [label, tone] = caseStatus(c.id);
    return `<button class="case ${active?'active':''}" data-case="${escape(c.id)}" ${state.busy?'disabled':''} ${active?'aria-current="page"':''}><small>Case ${String(i+1).padStart(2,'0')} · synthetic</small><strong>${text(c.title)}</strong><span class="case-status ${tone}">${text(label)}</span></button>`;
  }).join('');
}

function caseFromHash() {
  const match = /^#case=([\w-]+)$/.exec(location.hash);
  return match && state.cases.some(c => c.id === match[1]) ? match[1] : null;
}

function saveView() {
  if (!state.incident) return;
  state.views.set(state.incident.id, {stage: state.stage, artifact: state.artifact, positions: {...state.positions}, focus: state.focus, filter: state.filter});
}

async function selectCase(identifier) {
  const version = ++state.version;
  saveView();
  state.switching = identifier;
  notice(); renderCases();
  $('#workspace').setAttribute('aria-busy', 'true');
  try {
    const incident = await api(`/api/incidents/${encodeURIComponent(identifier)}`);
    if (version !== state.version) return;
    const run = state.runs.get(identifier) || null, view = state.views.get(identifier);
    Object.assign(state, {
      incident, run, switching: null, back: null, lines: null, page: 1, next: null, total: 0,
      stage: view && stageAvailable(view.stage, run) ? view.stage : defaultStage(run),
      artifact: view?.artifact || 'events.jsonl', positions: {...(view?.positions || {})},
      focus: view?.focus || null, filter: view?.filter || '',
    });
    $('#artifact').innerHTML = incident.artifacts.map(a=>`<option value="${escape(a.name)}">${text(a.name)} · ${text(a.bytes)} B</option>`).join('');
    $('#artifact').value = state.artifact;
    $('#goto-line').value = '';
    if (location.hash !== `#case=${identifier}`) history.replaceState(null, '', `#case=${identifier}`);
    render();
    focusWorkspace();
    const ref = state.focus?.refs[state.focus.index];
    await evidence(state.artifact, state.positions[state.artifact] || 1, {scrollTo: ref && fileOf(ref) === state.artifact ? ref : null});
  } finally {
    if (version === state.version) { state.switching = null; $('#workspace').removeAttribute('aria-busy'); renderCases(); }
  }
}

/* ---------- Main content ---------- */

function render() {
  if (!state.incident) return;
  renderCases();
  $('#title').textContent = state.incident.title;
  document.querySelectorAll('[data-stage]').forEach(button=>{
    button.disabled = state.busy || !stageAvailable(button.dataset.stage);
    button.classList.toggle('selected', button.dataset.stage===state.stage);
    button.setAttribute('aria-current', button.dataset.stage===state.stage ? 'step' : 'false');
  });
  const {stage, run} = state;
  $('#content').innerHTML = stage === 'incident' ? incidentView() : stage === 'investigate' ? investigateView() : run?.review ? reviewView() : '';
  renderLines();
}

function incidentView() {
  const {incident, busy} = state;
  const multipleRetries = incident.scenario === 'multiple-retries';
  return `<div class="section-heading"><h2>${multipleRetries?'Two partial imports. Two retries.':'A partial import. A full retry.'}</h2>${badge('Open incident',true)}</div>
    <p class="incident-note">${multipleRetries?'Two attempts lost their connections after partial writes. A final retry completed, then customers made genuine purchases.':'The importer lost its connection after some writes. It retried the source file while customers continued buying.'} Similar-looking purchases may be legitimate.</p>
    <div class="metrics">${metric(incident.active_orders,'active order records')}${metric(incident.artifacts.length,'evidence files')}${metric(incident.products.length,'products affected')}</div>
    <div class="callout"><strong>The question to resolve</strong><br>Which records repeat the same source action, and which later purchases must stay? A stock correction also needs a compensating ledger entry.</div>
    <div class="action-row"><button class="primary ${busy?'busy':''}" data-action="investigate" ${busy?'disabled':''}>${busy?'Reading local evidence…':'Start offline investigation →'}</button><span class="caption">Event-aware script · no model calls</span></div>
    <h3>Current inventory · source database</h3>${table(['Product','Available stock'],incident.products.map(p=>[text(p.name),text(p.on_hand)]))}
    <details><summary class="small muted">Incident note and supported schema</summary><p class="small">${text(incident.note.lines.map(l=>l.text).join('\n'))}</p><pre>${text(incident.schema.map(s=>s.sql).join('\n\n'))}</pre></details>
    <div class="order-toggle"><h3>Order records</h3><span class="caption">${incident.orders.length} observed records</span></div>
    ${orderTable(incident.orders)}`;
}

function investigateView() {
  const {run, busy} = state;
  const stopped = run.status === 'stopped';
  return `<div class="section-heading"><h2>${stopped?'Evidence needed to continue':'A bounded proposal'}</h2>${badge(stopped?'Stopped':'Script observations',stopped)}</div>
    <div class="callout ${stopped?'stop':''}"><strong>${stopped?'No repair exported.':'Investigation result'}</strong><br>${text(run.summary)}</div>
    <p class="small muted">The steps below are actual local function calls made by the deterministic script. They are not model reasoning or a replay of a model run.</p>
    <details class="trace-wrap"><summary>${run.trace.length} local function calls · deterministic script</summary><ol class="trace">${run.trace.map((step,i)=>`<li><details><summary>${String(i+1).padStart(2,'0')} ${text(step.tool)}<span>${text(step.arguments.name|| (step.tool==='query_database'?'read-only SQLite':'observed result'))}</span></summary><pre>${text(JSON.stringify({arguments:step.arguments,result:step.result},null,2))}</pre></details></li>`).join('')}</ol></details>
    ${run.plan?`<div class="section-heading"><h3>Proposed cancellations</h3>${badge(`${run.plan.cancellations.length} targets`)}</div><p class="small muted">Keep the first recorded write for each source event. Each target cites both committed writes; select one to inspect them side by side.</p>${planTable(run.plan)}
    <div class="action-row"><button class="primary ${busy?'busy':''}" data-action="rehearse" ${busy?'disabled':''}>${busy?'Rehearsing on a copy…':'Rehearse on a disposable copy →'}</button><span class="caption">Engine validates evidence and resulting state</span></div>`:
    `<h3>Next useful step</h3><p class="small">Recover the committed-write logs for the missing source events, then investigate again. The source has not been changed.</p><details><summary class="small">${run.missing_event_ids.length} source events without commit evidence</summary><pre>${text(run.missing_event_ids.join('\n'))}</pre></details>`}
    <button class="secondary" data-action="investigate" ${busy?'disabled':''}>Start a fresh offline investigation</button>`;
}

function reviewView() {
  const {run, busy} = state, review = run.review, ready = run.status === 'ready_for_review';
  const passed = review.checks.filter(c => c.passed).length;
  const source = review.checks.find(c => c.name === 'source_snapshot_unchanged');
  const skus = [...new Set(review.changes.map(c => c.before.sku))].sort();
  const checkout = review.preserved_orders.filter(isCheckout);
  const others = review.preserved_orders.filter(o => !isCheckout(o));
  const fromCancellations = new Map();
  for (const change of review.changes) {
    const entry = fromCancellations.get(change.before.sku) || {orders: 0, units: 0};
    entry.orders += 1; entry.units += change.before.quantity;
    fromCancellations.set(change.before.sku, entry);
  }
  return `<div class="section-heading"><h2>${ready?'Rehearsed. Ready for your review.':'Export unavailable'}</h2>${badge(ready?'Copy only':(RUN_STATUS[run.status]?.[0]||run.status.replaceAll('_',' ')),!ready)}</div>
    <div class="callout ${ready?'success':'stop'}">${text(run.summary)}</div>
    <div class="metrics four">${metric(`${review.before_active} → ${review.after_active}`,'active records')}${metric(review.cancellations,'duplicate orders cancelled')}${metric(`${review.checkout_preserved} / ${review.checkout_total}`,'later checkout purchases intact')}${metric(`${passed} / ${review.checks.length}`,'independent checks passed')}</div>
    <ul class="assurance" aria-label="Review boundaries">
      <li>Offline script · no model</li>
      <li>Changes exist only on a disposable copy</li>
      ${source?`<li class="${source.passed?'':'fail'}">${source.passed?'Source matches the rehearsed snapshot':'Source changed since rehearsal'}</li>`:''}
      <li>${text(review.untargeted_preserved)} untargeted records match the source</li>
    </ul>
    <nav class="review-nav" aria-label="Review sections">${REVIEW_SECTIONS.map(([id,label])=>`<button data-jump="${id}">${label}</button>`).join('')}</nav>

    <section id="rv-stock" class="review-section"><h3>Inventory before and after</h3>
      ${table(['Product','Before','After','Change','From cancellations'],review.stock.map(p=>{
        const delta = p.after - p.before, entry = fromCancellations.get(p.sku);
        return [text(p.name),text(p.before),text(p.after),`<span class="${delta>0?'positive':delta<0?'cancelled':''}">${delta>0?'+':''}${text(delta)}</span>`,entry?`${entry.orders} orders · +${entry.units} units`:'—'];
      }))}
    </section>

    <section id="rv-checks" class="review-section"><div class="section-heading"><h3>Independent operational checks</h3>${badge(`${passed} / ${review.checks.length} passed`,!review.passed)}</div>
      ${checksView(review.checks)}
    </section>

    <section id="rv-changes" class="review-section"><div class="section-heading"><h3>Changed records & supporting evidence</h3>
      <div class="filter"><label for="change-filter">Product</label><select id="change-filter"><option value="">All products (${review.changes.length})</option>${skus.map(sku=>`<option value="${escape(sku)}" ${sku===state.filter?'selected':''}>${text(sku)} (${review.changes.filter(c=>c.before.sku===sku).length})</option>`).join('')}</select></div></div>
      <p class="small muted">Original orders and sale movements remain in the candidate; cancellations add compensating stock entries. Select a citation to inspect both committed writes.</p>
      <div id="change-table">${changesTable(review.changes)}</div>
    </section>

    <section id="rv-preserved" class="review-section"><h3>Preserved work</h3>
      <p class="small muted">All ${review.preserved_orders.length} untargeted orders match their original records.</p>
      <h4>Later checkout purchases · ${checkout.length}</h4>
      <p class="small muted">Checkout references identify the supplied fixture’s later purchases. ${text(review.checkout_preserved)} of ${text(review.checkout_total)} remain unchanged.</p>
      ${orderTable(checkout)}
      <details class="preserved-more"><summary class="small">Other untouched records · ${others.length}</summary>${orderTable(others)}</details>
    </section>

    <section id="rv-artifacts" class="review-section"><h3>Review artifacts</h3>
      <p class="small muted">Each download rechecks source, evidence and candidate freshness. Guarded SQL also rejects changed table state when applied. Human review is required.</p>
      <div class="download-row">${run.downloads.map(name=>`<button class="download" data-download="${escape(name)}"><strong>↓ ${text(name)}</strong><span>${text(DOWNLOAD_NOTES[name]||'')}</span></button>`).join('')||'<span class="caption">No artifacts available for export.</span>'}</div>
      <div class="action-row"><button class="secondary" data-action="investigate" ${busy?'disabled':''}>Start a fresh investigation</button><span class="caption">Source database untouched</span></div>
    </section>`;
}

function checksView(checks) {
  const known = new Set(CHECK_GROUPS.flatMap(([, names]) => names));
  const groups = [...CHECK_GROUPS.map(([label, names]) => [label, checks.filter(c => names.includes(c.name))]),
    ['Other checks', checks.filter(c => !known.has(c.name))]].filter(([, list]) => list.length);
  return `<div class="check-groups">${groups.map(([label, list]) => {
    const ok = list.filter(c => c.passed).length;
    return `<div class="check-group ${ok<list.length?'has-fail':''}"><div class="check-group-head"><h4>${text(label)}</h4><span class="caption">${ok} / ${list.length} passed</span></div>
      <ul class="checks">${list.map(c=>`<li class="${c.passed?'':'fail'}"><span class="check-icon ${c.passed?'':'cancelled'}" aria-hidden="true">${c.passed?'✓':'×'}</span><div><strong>${text(c.name.replaceAll('_',' '))}</strong><span class="sr-only"> ${c.passed?'passed':'failed'}</span><div class="check-detail">${text(c.detail)}</div></div></li>`).join('')}</ul></div>`;
  }).join('')}</div>`;
}

function orderTable(rows) {
  return table(['Order ID','Customer','Product','Qty','Status','Source reference'],rows.map(o=>[`<span class="mono">${text(o.id)}</span>`,text(o.customer),text(o.sku),text(o.quantity),text(o.status),text(o.source_reference||'—')]));
}

function citations(action) {
  const refs = action.evidence_refs.join(' ');
  return `<div class="citations">${action.evidence_refs.map(ref=>`<button class="citation" data-ref="${escape(ref)}" data-refs="${escape(refs)}" data-cancel="${escape(action.order_id)}" data-keep="${escape(action.duplicate_of)}">${text(ref)}</button>`).join('')}</div>`;
}

function planTable(plan) {
  const orders = new Map(state.incident.orders.map(o => [o.id, o]));
  return table(['Cancel duplicate','Purchase','Keep original','Evidence'],plan.cancellations.map(a=>[`<span class="mono cancelled">${text(a.order_id)}</span>`,purchase(orders.get(a.order_id)),`<span class="mono">${text(a.duplicate_of)}</span>`,citations(a)]),
    plan.cancellations.map(a=>`id="row-${escape(a.order_id)}"`));
}

function changesTable(changes) {
  const rows = changes.filter(c => !state.filter || c.before.sku === state.filter);
  return table(['Cancelled on copy','Status','Purchase','Keeps original','Evidence'],rows.map(c=>[`<span class="mono cancelled">${text(c.before.id)}</span>`,`${text(c.before.status)} → <strong>${text(c.after.status)}</strong>`,purchase(c.before),`<span class="mono">${text(c.duplicate_of)}</span>`,citations({order_id:c.before.id,duplicate_of:c.duplicate_of,evidence_refs:c.evidence_refs})]),
    rows.map(c=>`id="row-${escape(c.before.id)}"`));
}

/* ---------- Evidence inspector ---------- */

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

async function evidence(name, line = 1, {scrollTo = null, reveal = false} = {}) {
  const version = ++state.evidenceVersion, incidentVersion = state.version;
  const page = await api(`/api/incidents/${encodeURIComponent(state.incident.id)}/artifacts/${encodeURIComponent(name)}?start_line=${line}&max_lines=${PAGE}`);
  if (version !== state.evidenceVersion || incidentVersion !== state.version) return;
  Object.assign(state, {artifact: name, page: line, next: page.next_line, total: page.total_lines, lines: page.lines});
  state.positions[name] = line;
  $('#artifact').value = name;
  renderLines();
  const box = $('#lines');
  box.scrollTop = 0;
  const target = scrollTo && document.getElementById(`line-${lineOf(scrollTo)}`);
  if (target) box.scrollTop = target.offsetTop - box.offsetTop - 24;
  if (reveal) { $('.evidence').scrollIntoView({block:'nearest'}); box.focus({preventScroll:true}); }
}

function renderLines() {
  const lines = state.lines, focus = state.focus;
  const focusRefs = new Set(focus?.refs || []), current = focus?.refs[focus.index];
  const cited = citedRefs(), json = /\.jsonl?$/.test(state.artifact);
  $('#prev').disabled = !lines || state.page === 1;
  $('#next').disabled = !lines || !state.next;
  if (!lines) { $('#evidence-range').textContent = 'Loading…'; $('#lines').innerHTML = ''; renderFocus(); return; }
  $('#evidence-range').textContent = lines.length ? `Lines ${state.page}–${state.page + lines.length - 1} of ${state.total}` : 'No lines';
  $('#lines').innerHTML = lines.map(l=>{
    const n = lineOf(l.ref), classes = ['evidence-line'], orders = cited.get(l.ref);
    if (focusRefs.has(l.ref)) classes.push('highlight');
    if (l.ref === current) classes.push('current');
    if (orders) classes.push('cited');
    let tag = '';
    if (focusRefs.has(l.ref) && focus.cancel) {
      tag = l.text.includes(focus.cancel) ? `${focus.cancel} · cancellation target` : l.text.includes(focus.keep) ? `${focus.keep} · retained write` : '';
    }
    const title = orders ? ` title="Cited for cancelling ${escape(orders.join(', '))}"` : '';
    return `<div class="${classes.join(' ')}" id="line-${n}"><span class="line-no"${title}>${n}</span><span class="line-text">${json?tint(l.text):text(l.text)}</span>${tag?`<span class="line-tag">${text(tag)}</span>`:''}</div>`;
  }).join('');
  $('#evidence-legend').hidden = !lines.some(l => cited.has(l.ref));
  renderFocus();
}

function renderFocus() {
  const box = $('#evidence-focus'), focus = state.focus, back = state.back;
  if (!focus && !back) { box.hidden = true; box.innerHTML = ''; return; }
  const rowShown = focus?.cancel && document.getElementById(`row-${focus.cancel}`);
  box.hidden = false;
  box.innerHTML = `${focus?`<div class="focus-head"><span>${focus.cancel?`Citations for cancelling <span class="mono">${text(focus.cancel)}</span>, keeping <span class="mono">${text(focus.keep)}</span>`:`Line ${text(lineOf(focus.refs[0]))} of ${text(fileOf(focus.refs[0]))}`}</span><button class="link-button" data-focus-clear>Clear</button></div>
    <div class="focus-refs">${focus.refs.map((ref,i)=>`<button class="ref-chip" data-focus-index="${i}" ${i===focus.index?'aria-current="true"':''}>${text(ref)}</button>`).join('')}${rowShown?`<button class="link-button" data-show-row="${escape(focus.cancel)}">Show in table</button>`:''}</div>`:''}
    ${back?`<button class="link-button" data-back>↩ Back to ${text(back.name)}, line ${text(back.page)}</button>`:''}`;
}

function showRef(ref) {
  const name = fileOf(ref), start = pageStart(lineOf(ref));
  // Remember where the reader was before following citations, once.
  if (!state.back && (name !== state.artifact || start !== state.page)) state.back = {name: state.artifact, page: state.page};
  return evidence(name, start, {scrollTo: ref, reveal: true});
}

function gotoLine() {
  const n = Number($('#goto-line').value);
  if (!Number.isInteger(n) || n < 1 || (state.total && n > state.total)) {
    $('#evidence-range').textContent = `Choose a line from 1 to ${state.total || 1}`;
    return null;
  }
  const ref = `${state.artifact}:L${n}`;
  state.focus = {refs: [ref], index: 0};
  return showRef(ref);
}

/* ---------- Actions ---------- */

async function act(action) {
  if (state.busy) return;
  const id = state.incident.id;
  state.busy = true; notice(); render();
  try {
    const path = action==='investigate'?`/api/incidents/${id}/investigate`:`/api/runs/${state.run.id}/rehearse`;
    const run = await api(path, true);
    state.runs.set(id, run);
    if (state.incident.id === id) {
      state.run = run; state.stage = defaultStage(run); state.filter = '';
      if (action === 'investigate') { state.focus = null; state.back = null; }
    }
    if (run.status==='blocked') notice(run.summary);
  } catch(error) { notice(error.message); }
  finally { state.busy = false; render(); focusWorkspace(); }
}

async function download(name) {
  const response = await fetch(`/api/runs/${state.run.id}/artifacts/${encodeURIComponent(name)}`);
  if (!response.ok) {
    const value = await response.json();
    state.run = await api(`/api/runs/${state.run.id}`); state.runs.set(state.incident.id, state.run); render();
    throw new Error(value.error || 'Download blocked.');
  }
  const url = URL.createObjectURL(await response.blob()), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

document.addEventListener('click', event=>{
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  const d = target.dataset;
  let task;
  if (d.case && d.case !== (state.switching || state.incident?.id)) {
    // The hash gives each case a link and browser back/forward; hashchange performs the switch.
    if (location.hash === `#case=${d.case}`) task = selectCase(d.case); else location.hash = `case=${d.case}`;
  }
  if (d.stage) { state.stage = d.stage; render(); focusWorkspace(); }
  if (d.action) task = act(d.action);
  if (d.download) task = download(d.download);
  if (d.ref) {
    const refs = (d.refs || d.ref).split(' ');
    state.focus = {refs, index: Math.max(0, refs.indexOf(d.ref)), cancel: d.cancel, keep: d.keep};
    task = showRef(d.ref);
  }
  if (d.focusIndex !== undefined && state.focus) { state.focus.index = Number(d.focusIndex); task = showRef(state.focus.refs[state.focus.index]); }
  if (d.focusClear !== undefined) { state.focus = null; renderLines(); }
  if (d.back !== undefined && state.back) { const back = state.back; state.back = null; task = evidence(back.name, back.page); }
  if (d.showRow) {
    const row = document.getElementById(`row-${d.showRow}`);
    if (row) { row.scrollIntoView({block:'center'}); row.classList.add('flash'); setTimeout(()=>row.classList.remove('flash'), 1600); }
  }
  if (d.jump) document.getElementById(d.jump)?.scrollIntoView({block:'start'});
  if (task) task.catch(error=>notice(error.message));
});
document.addEventListener('change', event=>{
  if (event.target.id !== 'change-filter' || !state.run?.review) return;
  state.filter = event.target.value;
  $('#change-table').innerHTML = changesTable(state.run.review.changes);
  renderFocus();
});
window.addEventListener('hashchange', ()=>{
  const id = caseFromHash();
  if (!id || id === (state.switching || state.incident?.id)) return;
  if (state.busy) { if (state.incident) history.replaceState(null, '', `#case=${state.incident.id}`); return; }
  selectCase(id).catch(error=>notice(error.message));
});
$('#artifact').addEventListener('change', ()=>{ const name = $('#artifact').value; evidence(name, state.positions[name] || 1).catch(e=>notice(e.message)); });
$('#prev').addEventListener('click', ()=>evidence(state.artifact, Math.max(1, state.page - PAGE)).catch(e=>notice(e.message)));
$('#next').addEventListener('click', ()=>{ if (state.next) evidence(state.artifact, state.next).catch(e=>notice(e.message)); });
$('#goto').addEventListener('click', ()=>gotoLine()?.catch(e=>notice(e.message)));
$('#goto-line').addEventListener('keydown', event=>{ if (event.key === 'Enter') { event.preventDefault(); gotoLine()?.catch(e=>notice(e.message)); } });
api('/api/incidents').then(async data=>{ state.cases = data.incidents; await selectCase(caseFromHash() || data.incidents[0].id); }).catch(error=>notice(error.message));
