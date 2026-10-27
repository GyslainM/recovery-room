'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { incident: null, run: null, stage: 'incident', cases: [], runs: new Map(), page: 1, next: null, busy: false, version: 0, evidenceVersion: 0 };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = (value) => escape(value);
const badge = (value, warn = false) => `<span class="pill${warn ? ' warn' : ''}">${text(value)}</span>`;
const metric = (value, label) => `<div class="metric"><strong>${text(value)}</strong><span>${text(label)}</span></div>`;
const citation = (ref) => `<button class="citation" data-ref="${escape(ref)}">${text(ref)}</button>`;
const table = (headers, rows) => `<div class="scroll-table"><table><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

async function api(path, post = false) {
  const response = await fetch(path, post ? {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'} : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The local request failed.');
  return value;
}

function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function focusWorkspace() { $('#workspace').focus({preventScroll:true}); $('#workspace').scrollIntoView({block:'start'}); }

function render() {
  if (!state.incident) return;
  const { incident, run, stage, busy } = state;
  const multipleRetries = incident.scenario === 'multiple-retries';
  $('#case-count').textContent = String(state.cases.length).padStart(2,'0');
  $('#title').textContent = incident.title;
  $('#cases').innerHTML = state.cases.map((c,i)=>`<button class="case ${c.id===incident.id?'active':''}" data-case="${escape(c.id)}" ${busy?'disabled':''} ${c.id===incident.id?'aria-current="page"':''}><small>CASE 0${i+1} / SYNTHETIC</small><strong>${text(c.title)}</strong></button>`).join('');
  document.querySelectorAll('[data-stage]').forEach(button=>{
    button.disabled = busy || (button.dataset.stage==='investigate' && !run) || (button.dataset.stage==='review' && !run?.review);
    button.classList.toggle('selected', button.dataset.stage===stage);
    button.setAttribute('aria-current', button.dataset.stage===stage ? 'step' : 'false');
  });
  let html = '';
  if (stage === 'incident') {
    html = `<div class="section-heading"><h2>${multipleRetries?'Two partial imports. Two retries.':'A partial import. A full retry.'}</h2>${badge('OPEN INCIDENT',true)}</div>
      <p class="incident-note">${multipleRetries?'Two attempts lost their connections after partial writes. A final retry completed, then customers made genuine purchases.':'The importer lost its connection after some writes. It retried the source file while customers continued buying.'} Similar-looking purchases may be legitimate.</p>
      <div class="metrics">${metric(incident.active_orders,'active order records')}${metric(incident.artifacts.length,'evidence files')}${metric(incident.products.length,'products affected')}</div>
      <div class="callout"><strong>The question to resolve</strong><br>Which records repeat the same source action, and which later purchases must stay? A stock correction also needs a compensating ledger entry.</div>
      <div class="action-row"><button class="primary ${busy?'busy':''}" data-action="investigate" ${busy?'disabled':''}>${busy?'Reading local evidence…':'Start offline investigation →'}</button><span class="caption">Event-aware script · no model calls</span></div>
      <h3>Current inventory · source database</h3>${table(['Product','Available stock'],incident.products.map(p=>[text(p.name),text(p.on_hand)]))}
      <details><summary class="small muted">Incident note and supported schema</summary><p class="small">${text(incident.note.lines.map(l=>l.text).join('\n'))}</p><pre>${text(incident.schema.map(s=>s.sql).join('\n\n'))}</pre></details>
      <div class="order-toggle"><h3>Order records</h3><span class="caption">${incident.orders.length} observed records</span></div>
      ${orderTable(incident.orders)}`;
  } else if (stage === 'investigate') {
    const stopped = run.status === 'stopped';
    html = `<div class="section-heading"><h2>${stopped?'Evidence needed to continue':'A bounded proposal'}</h2>${badge(stopped?'STOPPED':'SCRIPT OBSERVATIONS',stopped)}</div>
      <div class="callout ${stopped?'stop':''}"><strong>${stopped?'No repair exported.':'Investigation result'}</strong><br>${text(run.summary)}</div>
      <p class="small muted">The steps below are actual local function calls made by the deterministic script. They are not model reasoning or a replay of a model run.</p>
      <ol class="trace">${run.trace.map((step,i)=>`<li><details><summary>${String(i+1).padStart(2,'0')} ${text(step.tool)}<span>${text(step.arguments.name|| (step.tool==='query_database'?'read-only SQLite':'observed result'))}</span></summary><pre>${text(JSON.stringify({arguments:step.arguments,result:step.result},null,2))}</pre></details></li>`).join('')}</ol>
      ${run.plan?`<div class="section-heading"><h3>Proposed cancellations</h3>${badge(`${run.plan.cancellations.length} targets`)}</div><p class="small muted">Keep the first recorded write for each source event. Each target cites both committed writes.</p>${planTable(run.plan)}
      <div class="action-row"><button class="primary ${busy?'busy':''}" data-action="rehearse" ${busy?'disabled':''}>${busy?'Rehearsing on a copy…':'Rehearse on a disposable copy →'}</button><span class="caption">Engine validates evidence and resulting state</span></div>`:
      `<h3>Next useful step</h3><p class="small">Recover the committed-write logs for the missing source events, then investigate again. The source has not been changed.</p><details><summary class="small">${run.missing_event_ids.length} source events without commit evidence</summary><pre>${text(run.missing_event_ids.join('\n'))}</pre></details>`}
      <button class="secondary" data-action="investigate" ${busy?'disabled':''}>Start a fresh offline investigation</button>`;
  } else if (run?.review) {
    const review = run.review, ready = run.status==='ready_for_review';
    html = `<div class="section-heading"><h2>${ready?'Rehearsed. Ready for your review.':'Export unavailable'}</h2>${badge(ready?'COPY ONLY':run.status.toUpperCase(),!ready)}</div>
      <div class="callout ${ready?'success':'stop'}">${text(run.summary)}</div>
      <div class="metrics">${metric(`${review.before_active} → ${review.after_active}`,'active records')}${metric(review.cancellations,'duplicate orders cancelled')}${metric(`${review.checkout_preserved} / ${review.checkout_total}`,'later checkout purchases intact')}</div>
      <p class="small muted">${review.untargeted_preserved} untargeted records match the source exactly. Original orders and sale movements remain in the candidate; cancellations add compensating stock entries.</p>
      <h3>Inventory before and after</h3>${table(['Product','Before','After','Restored'],review.stock.map(p=>[text(p.name),text(p.before),text(p.after),`<span class="positive">+${text(p.after-p.before)}</span>`]))}
      <div class="section-heading"><h3>Independent operational checks</h3>${badge(`${review.checks.filter(c=>c.passed).length} / ${review.checks.length} passed`,!review.passed)}</div>
      <ul class="checks">${review.checks.map(c=>`<li><span class="check-icon ${c.passed?'':'cancelled'}">${c.passed?'✓':'×'}</span><div><strong>${text(c.name.replaceAll('_',' '))}</strong><div class="check-detail">${text(c.detail)}</div></div></li>`).join('')}</ul>
      <h3>Changed records & supporting evidence</h3>${planTable(run.plan,true)}
      <h3>Preserved work</h3><p class="small muted">All ${review.preserved_orders.length} untargeted orders below match their original records. Checkout references identify the supplied fixture’s later purchases.</p>${orderTable(review.preserved_orders)}
      <h3>Review artifacts</h3><p class="small muted">Each download rechecks source, evidence and candidate freshness. Guarded SQL also rejects changed table state when applied. Human review is required.</p>
      <div class="download-row">${run.downloads.map(name=>`<button class="download" data-download="${escape(name)}">↓ ${text(name)}</button>`).join('')||'<span class="caption">No artifacts available for export.</span>'}</div>
      <div class="action-row"><button class="secondary" data-action="investigate" ${busy?'disabled':''}>Start a fresh investigation</button><span class="caption">Source database untouched</span></div>`;
  }
  $('#content').innerHTML = html;
}

function orderTable(rows) {
  return table(['Order ID','Customer','Product','Qty','Status','Source reference'],rows.map(o=>[`<span class="mono">${text(o.id)}</span>`,text(o.customer),text(o.sku),text(o.quantity),text(o.status),text(o.source_reference||'—')]));
}

function planTable(plan, reviewed=false) {
  return table([reviewed?'Cancelled on copy':'Cancel duplicate','Keep original','Evidence'],plan.cancellations.map(a=>[`<span class="mono cancelled">${text(a.order_id)}</span>`,`<span class="mono">${text(a.duplicate_of)}</span>`,a.evidence_refs.map(citation).join('')]));
}

async function selectCase(identifier) {
  const version = ++state.version;
  notice();
  const incident = await api(`/api/incidents/${encodeURIComponent(identifier)}`);
  if (version!==state.version) return;
  state.incident = incident;
  state.run = state.runs.get(identifier)||null;
  state.stage = state.run?.review?'review':state.run?'investigate':'incident';
  $('#artifact').innerHTML = incident.artifacts.map(a=>`<option value="${escape(a.name)}">${text(a.name)} · ${text(a.bytes)} B</option>`).join('');
  $('#artifact').value = 'events.jsonl';
  render();
  focusWorkspace();
  await evidence('events.jsonl',1);
}

async function evidence(name, line=1, highlight=null) {
  const version=++state.evidenceVersion, incidentVersion=state.version;
  const page=await api(`/api/incidents/${encodeURIComponent(state.incident.id)}/artifacts/${encodeURIComponent(name)}?start_line=${line}&max_lines=40`);
  if(version!==state.evidenceVersion||incidentVersion!==state.version) return;
  state.page=line; state.next=page.next_line;
  $('#artifact').value=name;
  $('#evidence-range').textContent=`Lines ${line}–${line+page.lines.length-1} of ${page.total_lines}`;
  $('#prev').disabled=line===1; $('#next').disabled=!page.next_line;
  $('#lines').innerHTML=page.lines.map(l=>`<div class="evidence-line ${l.ref===highlight?'highlight':''}" id="line-${text(l.ref.split(':L')[1])}"><span class="line-no">${text(l.ref.split(':L')[1])}</span><span class="line-text">${text(l.text)}</span></div>`).join('');
  $('#lines').scrollTop=0;
  if(highlight){const target=document.getElementById(`line-${highlight.split(':L')[1]}`);if(target)$('#lines').scrollTop=target.offsetTop-$('#lines').offsetTop;}
  if(highlight){$('.evidence').scrollIntoView({block:'nearest'});$('#lines').focus({preventScroll:true});}
}

async function act(action) {
  if (state.busy) return;
  state.busy=true; notice(); render();
  try {
    const path=action==='investigate'?`/api/incidents/${state.incident.id}/investigate`:`/api/runs/${state.run.id}/rehearse`;
    state.run=await api(path,true);
    state.runs.set(state.incident.id,state.run);
    state.stage=state.run.review?'review':'investigate';
    if(state.run.status==='blocked')notice(state.run.summary);
  } catch(error){notice(error.message);}
  finally{state.busy=false;render();focusWorkspace();}
}

async function download(name) {
  const response=await fetch(`/api/runs/${state.run.id}/artifacts/${encodeURIComponent(name)}`);
  if(!response.ok){
    const value=await response.json();
    state.run=await api(`/api/runs/${state.run.id}`);state.runs.set(state.incident.id,state.run);render();
    throw new Error(value.error||'Download blocked.');
  }
  const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target||target.disabled)return;
  let task;
  if(target.dataset.case)task=selectCase(target.dataset.case);
  if(target.dataset.stage){state.stage=target.dataset.stage;render();focusWorkspace();}
  if(target.dataset.action)task=act(target.dataset.action);
  if(target.dataset.download)task=download(target.dataset.download);
  if(target.dataset.ref){const [name,number]=target.dataset.ref.split(':L');task=evidence(name,Math.floor((Number(number)-1)/40)*40+1,target.dataset.ref);}
  if(task)task.catch(error=>notice(error.message));
});
$('#artifact').addEventListener('change',()=>evidence($('#artifact').value,1).catch(e=>notice(e.message)));
$('#prev').addEventListener('click',()=>evidence($('#artifact').value,Math.max(1,state.page-40)).catch(e=>notice(e.message)));
$('#next').addEventListener('click',()=>evidence($('#artifact').value,state.next).catch(e=>notice(e.message)));
api('/api/incidents').then(async data=>{state.cases=data.incidents;await selectCase(data.incidents[0].id);}).catch(error=>notice(error.message));
