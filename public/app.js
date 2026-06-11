/* Hyde Media — Outreach (Vercel edition)
 * Data + status come from the API (/api/data, /api/state). Status is stored
 * server-side in Redis and shared across devices. The Opfølgning tab shows
 * rule-based "win the customer" tips plus an on-demand Claude suggestion.
 */

const STATUSES = ['Ikke kontaktet','Sendt','Opfølgning sendt','Svar modtaget','Booket','Nej tak'];

let DATA = { contacts: [], placements: {}, followupDaysDefault: 5 };
let STATE = {};            // { company: {status, date, note} }
let LOGS = {};             // { company: [{who, text, ts}] }
let THREADS = {};          // { company: {subject, from, date, snippet, auto} }
let GMAIL = { configured:false, connected:false, lastSync:null };
let PLACEMENT_IMAGES = new Set();   // placement names that have a mockup
let MOCK_BUST = 0;                  // bumped after upload/delete to bust <img> cache
let HAS_AI = false;
let curTab = 'kold';

const $ = (id) => document.getElementById(id);
const el = (sel, root=document) => root.querySelector(sel);

/* ---------- api ---------- */
async function api(path, opts){
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  return res;
}
function rec(c){ return STATE[c] || {}; }
// Optimistic local update + server persist.
async function setRec(c, patch){
  const next = Object.assign({}, STATE[c]);
  for(const [k,v] of Object.entries(patch)){
    if(v === undefined || v === null || v === '') delete next[k]; else next[k] = v;
  }
  STATE[c] = next;
  try {
    const res = await api('/api/state', { method:'POST', body: JSON.stringify({ company:c, patch }) });
    if(res.status === 401){ showGate(); }
  } catch(e){ console.error('save failed', e); }
}

/* ---------- dates ---------- */
function today(){ return new Date().toLocaleDateString('da-DK'); }      // e.g. "3.6.2026"
function parseDate(s){
  if(!s) return null;
  const p = s.split(/[.\-\/]/).map(Number);
  if(p.length < 3) return null;
  return new Date(p[2], p[1]-1, p[0]);   // day-first
}
function daysSince(s){ const d = parseDate(s); return d ? Math.floor((Date.now()-d)/86400000) : 0; }
function followupDays(){ return parseInt($('thr').value) || DATA.followupDaysDefault || 5; }
function isDue(c){
  const r = rec(c.company);
  return (r.status === 'Sendt' || r.status === 'Opfølgning sendt') && daysSince(r.date) >= followupDays();
}
// Follow-up radar: days since the last mail + an urgency tier.
function fuTier(days){
  const t = followupDays();
  if(days >= t * 2) return 'hot';   // way overdue
  if(days >= t)     return 'due';   // due now
  return '';
}

/* ---------- helpers ---------- */
function statusClass(st){
  if(st === 'Booket') return 'book';
  if(st === 'Nej tak') return 'no';
  if(st === 'Opfølgning sendt') return 'fup';
  if(st === 'Sendt' || st === 'Svar modtaget') return 'done';
  return '';
}
function copyText(text, btn){
  const ok = () => { const o = btn.dataset.lbl || btn.textContent; btn.dataset.lbl = o; btn.textContent='✓ Kopieret'; btn.classList.add('ok'); setTimeout(()=>{btn.textContent=o;btn.classList.remove('ok');},1200); };
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(text).then(ok).catch(()=>fallbackCopy(text, ok));
  } else fallbackCopy(text, ok);
}
function fallbackCopy(text, ok){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); ok(); } catch(e){ alert('Markér teksten og kopiér manuelt.'); }
  document.body.removeChild(ta);
}

/* ---------- win-the-customer rules ---------- */
function placementData(c){ return (c.placement && DATA.placements[c.placement]) || null; }
function discountLine(c){
  const p = placementData(c);
  if(!p || !p.price || !p.list) return null;
  const norm = parseInt(String(p.list).replace(/\D/g,''));
  const now  = parseInt(String(p.price).replace(/\D/g,''));
  if(!norm || !now || norm <= now) return `Late sale-pris ${p.price} på ${c.placement}.`;
  const pct = Math.round((1 - now/norm) * 100);
  return `Late sale: ${p.price} mod normalt ${p.list} (~${pct}% under listepris) på ${c.placement}.`;
}
// Tactic per segment/type from the CRM export.
const SEGMENT_TACTIC = {
  'Første kontakt': 'Hold første mail kort: én placering, ét tal (eksponeringer), én pris. Bed om et ja/nej, ikke et møde.',
  'Følg op': 'Henvis til jeres sidste dialog og giv en ny grund til at handle nu (late sale-vinduet).',
  'Nudge / opfølg': 'Lille, venlig nudge — tilbyd at holde pladsen et par dage, så der er en deadline.',
  'Re-aktivér': 'Bring noget nyt: ny placering, ny pris eller ny periode — ikke bare “følger lige op”.',
  'Genåbn': 'Anerkend pausen og åbn med en konkret anledning (sommerkampagne / late sale).',
  'Gensend (var fraværende)': 'De var ude sidst — gensend kort og spørg om timingen passer bedre nu.',
  'Ny kontaktperson': 'Præsentér dig kort for den nye kontakt og opsummér værdien på 2 linjer.',
  'Nurtur (sagde nej)': 'De sagde nej før — pres ikke. Del værdi/cases og plant næste sæson.',
  'Luk / fremryk': 'Gå efter en beslutning: tilbyd en klar deadline eller et lille incitament for at lukke nu.',
};
function ruleTips(c){
  const r = rec(c.company);
  const tips = [];
  const seg = c.segment && SEGMENT_TACTIC[c.segment];
  if(seg) tips.push(seg);
  const disc = discountLine(c);
  if(disc) tips.push(disc);
  if(c.temp === 'varm') tips.push('Varm kontakt: referér konkret til den tidligere relation/dialog.');
  if(r.status === 'Sendt'){
    const d = daysSince(r.date);
    tips.push(`Sendt for ${d} dage siden uden svar — send opfølgningen og foreslå en kort snak.`);
  } else if(r.status === 'Opfølgning sendt'){
    tips.push('Allerede fulgt op — prøv en anden kanal (ring/LinkedIn) eller en sidste “lukker”-mail før du parkerer.');
  }
  const p = placementData(c);
  if(p && p.period) tips.push(`Skab knaphed: perioden er ${p.period} — pladsen forsvinder efter late sale-vinduet.`);
  return tips.slice(0,5);
}
function angleFor(c){
  const p = placementData(c);
  const where = p && p.area ? `${c.placement} (${p.area})` : (c.placement || 'en stærk placering');
  return `${c.company}: synlighed på ${where}${p && p.impr ? ` med ${p.impr} eksponeringer/uge` : ''} — i et tidsbegrænset late sale-vindue.`;
}

/* ---------- rendering ---------- */
function hasReply(company){ const t=THREADS[company]; const st=rec(company).status||''; return (t && !t.auto) || st==='Svar modtaget'; }
function replyTime(company){ const t=THREADS[company]; if(t && t.date) return t.date; const d=parseDate(rec(company).date); return d?d.getTime():0; }
function contactEmail(c){ return c.email || ''; }
function contactsForTab(){
  if(curTab === 'opfolg') return DATA.contacts.filter(isDue).sort((a,b)=>daysSince(rec(b.company).date)-daysSince(rec(a.company).date));
  if(curTab === 'svar') return DATA.contacts.filter(c=>hasReply(c.company)).sort((a,b)=>replyTime(b.company)-replyTime(a.company));
  return DATA.contacts.filter(c => c.temp === curTab).sort((a,b)=>a.order-b.order);
}
function gmailComposeUrlRaw(to, su, body){
  return 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(to||'')
    + '&su=' + encodeURIComponent(su||'')
    + '&body=' + encodeURIComponent(body||'');
}
function gmailComposeUrl(c){
  return gmailComposeUrlRaw(contactEmail(c), c.subject || ('Hyde Media — ' + c.company), c.body || '');
}

/* ---------- mail generator ---------- */
const SCEN = [
  ['open','Åbning (kold)'],['reopen','Genåbning af dialog'],['followup','Opfølgning'],
  ['nudge','Nudge'],['after_no','Efter et nej'],['close','Luk handlen'],['reply','Svar på kundens mail'],
];
function defaultScenario(c){
  if(hasReply(c.company)) return 'reply';
  const s = (c.segment||'').toLowerCase();
  if(s.includes('første')) return 'open';
  if(s.includes('re-aktiv')||s.includes('genåbn')||s.includes('gensend')||s.includes('ny kontakt')) return 'reopen';
  if(s.includes('nudge')) return 'nudge';
  if(s.includes('følg op')||s.includes('opfølg')) return 'followup';
  if(s.includes('nurtur')||s.includes('nej')) return 'after_no';
  if(s.includes('luk')||s.includes('fremryk')) return 'close';
  return c.temp==='varm' ? 'followup' : 'open';
}
function draftPanelHTML(c){
  const def = defaultScenario(c);
  const scen = SCEN.map(([v,l])=>`<option value="${v}" ${v===def?'selected':''}>${l}</option>`).join('');
  const plac = Object.keys(DATA.placements||{}).map(p=>`<option ${p===c.placement?'selected':''}>${esc(p)}</option>`).join('');
  return `<div class="draftbox">
    <div class="drafthead">✍️ Generér mailudkast — 3 forslag i din tone</div>
    <div class="draftctrls">
      <label class="dlab">Scenarie<select class="d-scenario">${scen}</select></label>
      <label class="dlab">Placering<select class="d-placement">${plac}</select></label>
      <label class="dlab">Sprog<select class="d-lang"><option value="da">Dansk</option><option value="en">English</option></select></label>
      <button class="btn small act-draft-gen">✍️ Generér 3 forslag</button>
    </div>
    <div class="draft-out"></div>
  </div>`;
}
function variantHTML(v, i, sendable){
  const sendBtn = sendable ? `<button class="btn small act-vsend" title="Send dette udkast direkte via Gmail">📤 Send</button>` : '';
  return `<div class="variant" data-i="${i}">
    <div class="vhead"><span class="vangle">${esc(v.angle)}</span></div>
    <div class="vsubrow"><span class="sublbl">Emne</span><span class="v-subj subtxt">${esc(v.subject)}</span>
      <button class="btn small act-vcopysub">Kopiér emne</button></div>
    <div class="v-body">${esc(v.body)}</div>
    <div class="vacts">
      <button class="btn small act-vcopy">📋 Kopiér mail</button>
      ${sendBtn}
      <button class="btn small act-vgmail">✉️ Skriv i Gmail</button>
      <button class="btn small act-vsave">💾 Gem som udkast</button>
    </div>
  </div>`;
}
function bindVariants(company, card){
  const c = DATA.contacts.find(x=>x.company===company);
  card.querySelectorAll('.variant').forEach(v=>{
    const subj = el('.v-subj', v).textContent;
    const bodyt = el('.v-body', v).textContent;
    const markSent = ()=>{ const r=rec(company); if(!r.status||r.status==='Ikke kontaktet') setRec(company,{status:'Sendt',date:today()}).then(render); };
    el('.act-vcopysub', v).addEventListener('click', e=>copyText(subj, e.target));
    el('.act-vcopy', v).addEventListener('click', e=>{ copyText(bodyt, e.target); markSent(); });
    const vsend = el('.act-vsend', v);
    if(vsend) vsend.addEventListener('click', e=>{
      const threadId = hasReply(company) ? (THREADS[company] && THREADS[company].threadId) : null;
      const plac = (el('.d-placement', card) || {}).value || c.placement;
      const attachPlacement = hasMockup(plac) ? plac : null;
      sendMail(company, { to:contactEmail(c), subject:subj, body:bodyt, status:'Sendt', threadId, attachPlacement }, e.target);
    });
    el('.act-vgmail', v).addEventListener('click', ()=>{ window.open(gmailComposeUrlRaw(contactEmail(c), subj, bodyt), '_blank'); markSent(); });
    el('.act-vsave', v).addEventListener('click', async (e)=>{
      e.target.disabled = true;
      const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'update', company, patch:{ subject:subj, body:bodyt } }) });
      if(res.status===401){ showGate(); return; }
      const j = await res.json();
      if(j.ok){ DATA.contacts = j.contacts; toast('💾 Gemt som udkast for '+company, true); }
      e.target.disabled = false;
    });
  });
}
async function generateDrafts(company, card){
  const out = el('.draft-out', card);
  if(!HAS_AI){ out.innerHTML='<div class="ai-err">AI er slået fra — tilføj ANTHROPIC_API_KEY.</div>'; return; }
  const scenario = el('.d-scenario', card).value;
  const placement = el('.d-placement', card).value;
  const lang = el('.d-lang', card).value;
  const btn = el('.act-draft-gen', card); btn.disabled=true; const lbl=btn.textContent; btn.textContent='✍️ Skriver…';
  out.innerHTML = '<div class="ai-loading">✍️ Claude skriver 3 forslag i din tone…</div>';
  try{
    const res = await api('/api/draft', { method:'POST', body: JSON.stringify({ company, scenario, placement, lang }) });
    if(res.status===401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ out.innerHTML='<div class="ai-err">'+esc(j.message||'Kunne ikke generere.')+'</div>'; return; }
    const c = DATA.contacts.find(x=>x.company===company);
    const sendable = canSend(c);
    out.innerHTML = j.variants.map((v,i)=>variantHTML(v,i,sendable)).join('');
    bindVariants(company, card);
  }catch(e){ out.innerHTML='<div class="ai-err">Netværksfejl.</div>'; }
  finally{ btn.disabled=false; btn.textContent=lbl; }
}
function logEntriesHTML(company){
  const seen = new Set();
  const entries = (LOGS[company] || []).filter(e=>{ const k=e.who+'|'+e.text; if(seen.has(k)) return false; seen.add(k); return true; });
  if(!entries.length) return '<div class="logempty">Ingen dialog gemt endnu.</div>';
  return entries.map(e=>`<div class="logmsg ${e.who==='kunde'?'fromkunde':'frommig'}"><span class="logwho">${e.who==='kunde'?'Kunde':'Mig'}</span>${esc(e.text)}</div>`).join('');
}
function winboxHTML(c){
  const tips = ruleTips(c);
  const aiBtn = HAS_AI
    ? `<button class="btn small act-ai">🤖 Spørg Claude</button>`
    : `<span class="ai-off" title="Tilføj ANTHROPIC_API_KEY i Vercel">🤖 AI slået fra</span>`;
  return `<div class="winbox">
    <div class="wintitle">🎯 Sådan vinder du dem ${aiBtn}</div>
    <div class="winangle">${esc(angleFor(c))}</div>
    <ul class="wintips">${tips.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>
    <div class="ai-out" style="display:none"></div>
    <div class="logbox">
      <div class="logtitle">💬 Dialog &amp; læring</div>
      <div class="logentries">${logEntriesHTML(c.company)}</div>
      <textarea class="loginput" placeholder="Indsæt kundens svar — eller dit eget svar. Dine egne svar lærer Claude din tone."></textarea>
      <div class="logbtns">
        <button class="btn small act-log-mig">Gem mit svar</button>
        <button class="btn small act-log-kunde">Gem kundens svar</button>
      </div>
    </div>
  </div>`;
}
function threadHTML(company){
  const t = THREADS[company];
  if(!t) return '';
  const when = t.date ? new Date(t.date).toLocaleDateString('da-DK') : '';
  if(t.auto){
    return `<div class="thread auto">🤖 Auto-svar (${esc(when)}): <span class="thsnip">${esc(t.snippet||'')}</span></div>`;
  }
  return `<div class="thread real">📨 Svar fra kunden (${esc(when)}): <span class="thsnip">${esc(t.snippet||'')}</span></div>`;
}
function contactMetaHTML(c){
  const bits = [c.person && esc(c.person), c.email && esc(c.email), c.phone && esc(c.phone)].filter(Boolean);
  return bits.length ? `<div class="cmeta">${bits.join(' · ')}</div>` : '';
}
const BUYER = { bureau:'🏢 Bureau', selv:'🤝 Selv', ukendt:'❓ Indkøb?' };
const BUYER_CYCLE = { ukendt:'bureau', bureau:'selv', selv:'ukendt' };
function buyerVal(c){ return c.buyer || 'ukendt'; }
function buyerChip(c){
  const b = buyerVal(c);
  const t = c.buyerReason ? esc(c.buyerReason) + ' — klik for at skifte' : 'Klik for at skifte: Ukendt → Bureau → Selv';
  return `<button class="buyertag ${b} act-buyer" title="${t}">${BUYER[b]}</button>`;
}
function buyerReasonHTML(c){
  if(!c.buyerReason) return '';
  return `<div class="buyerwhy">🏷️ <b>${BUYER[buyerVal(c)].replace(/^.. /,'')}:</b> ${esc(c.buyerReason)}</div>`;
}
function cardHTML(c){
  const r = rec(c.company);
  const st = r.status || 'Ikke kontaktet';
  const isFu = curTab === 'opfolg';
  const openPanel = isFu || curTab === 'svar';
  const subject = isFu ? c.fuSubject : c.subject;
  const body = isFu ? c.fuBody : c.body;
  const fuDays = daysSince(r.date);
  const fuT = isFu ? fuTier(fuDays) : '';
  let badge;
  if(curTab === 'svar') badge = `<span class="badge reply">💬 ${esc(st)}${r.date?' · '+esc(r.date):''}</span>`;
  else if(isFu){
    const flag = fuT === 'hot' ? '🔴' : '🟠';
    const ctx = st === 'Opfølgning sendt' ? 'opfulgt' : 'sendt';
    badge = `<span class="badge due ${fuT}">${flag} ${ctx} for ${fuDays} dage siden</span>`;
  }
  else badge = `<span class="badge">${esc(c.segment||'')}${c.placement ? ' · '+esc(c.placement) : ''}</span>`;
  const opts = STATUSES.map(s => `<option ${s===st?'selected':''}>${s}</option>`).join('');
  const copyLabel = isFu ? '📋 Kopiér opfølgning' : '📋 Kopiér mail';
  const gmailBtn = contactEmail(c)
    ? `<button class="btn small act-gmail" title="Åbn i Gmail med modtager udfyldt">✉️ Skriv i Gmail</button>` : '';
  const sendBtn = (body && canSend(c))
    ? `<button class="btn small act-send" title="Send mailen direkte via Gmail og sæt status">📤 Send</button>` : '';
  const mock = hasMockup(c.placement);
  const attachChk = (mock && canSend(c))
    ? `<label class="attachchk" title="Vedhæft mockup af ${esc(c.placement)} når du sender"><input type="checkbox" class="act-attach" checked> 📎 Mockup</label>` : '';
  const mockThumb = mock
    ? `<a class="mockchip" href="${mockUrl(c.placement)}" target="_blank" title="Mockup: ${esc(c.placement)}"><img src="${mockUrl(c.placement)}" alt=""></a>` : '';
  return `<div class="card ${statusClass(st)}${fuT ? ' fu-'+fuT : ''}" data-company="${esc(c.company)}">
    <div class="chead">
      <div class="cbrand"><span class="brand">${esc(c.company)}</span>${c.custom?'<span class="tagcustom">egen</span>':''}${contactMetaHTML(c)}</div>
      <div class="chead-r">${buyerChip(c)}${badge}
        <button class="iconbtn act-edit" title="Rediger kunde">✏️</button>
        <button class="iconbtn act-del" title="Slet kunde">🗑️</button>
      </div>
    </div>
    ${buyerReasonHTML(c)}
    ${subject ? `<div class="subrow"><span class="sublbl">Emne</span><span class="subtxt subj">${esc(subject)}</span>
      <button class="btn small act-copysub">Kopiér emne</button></div>` : ''}
    ${body ? `<div class="body">${esc(body)}</div>` : ''}
    ${mockThumb}
    ${threadHTML(c.company)}
    <div class="row2">
      ${body ? `<button class="btn act-copy" data-fu="${isFu?1:0}">${copyLabel}</button>` : ''}
      ${sendBtn}
      ${attachChk}
      ${gmailBtn}
      <select class="st">${opts}</select>
      ${(isFu||curTab==='svar') ? '' : '<input class="note" placeholder="Note…" value="'+esc(r.note||'')+'">'}
      <button class="btn small act-draft-toggle">✍️ Skriv mail</button>
      <button class="btn small act-win">🎯 ${openPanel?'Skjul hjælp':'Vind kunden'}</button>
      <span class="when">${r.date ? '· '+r.date : ''}</span>
    </div>
    <div class="winwrap"${openPanel?'':' style="display:none"'}>${winboxHTML(c)}</div>
    <div class="draftwrap" style="display:none">${draftPanelHTML(c)}</div>
  </div>`;
}
function render(){
  const q = $('q').value.toLowerCase();
  const f = $('fil').value;
  const fb = ($('fbuyer') && $('fbuyer').value) || '';
  let items = contactsForTab().filter(c=>{
    const hay = (c.company+' '+(c.subject||'')+' '+(c.segment||'')+' '+(c.person||'')+' '+(c.email||'')).toLowerCase();
    const st = rec(c.company).status || 'Ikke kontaktet';
    return hay.includes(q) && (!f || st === f) && (!fb || buyerVal(c) === fb);
  });
  $('list').innerHTML = items.map(cardHTML).join('');
  $('empty').style.display = items.length ? 'none' : '';
  $('empty').textContent = curTab==='opfolg' ? 'Ingen opfølgninger er forfaldne lige nu 🎉'
    : (curTab==='svar' ? 'Ingen svar endnu — kør “Synk Gmail”.' : 'Ingen kontakter matcher.');
  bindCards();
  renderBar();
}
function bindCards(){
  document.querySelectorAll('.card').forEach(card=>{
    const company = card.dataset.company;
    el('.st', card).addEventListener('change', e=>{
      const v = e.target.value;
      const patch = {status:v};
      if(v !== 'Ikke kontaktet' && !rec(company).date) patch.date = today();
      if(v === 'Ikke kontaktet') patch.date = null;
      setRec(company, patch).then(render);
    });
    const note = el('.note', card);
    if(note) note.addEventListener('change', e=>setRec(company,{note:e.target.value}));
    const copysub = el('.act-copysub', card);
    if(copysub) copysub.addEventListener('click', e=>copyText(el('.subj',card).textContent, e.target));
    const copy = el('.act-copy', card);
    if(copy) copy.addEventListener('click', e=>{
      const isFu = e.target.dataset.fu === '1';
      copyText(el('.body',card).textContent, e.target);
      if(isFu){ setRec(company,{status:'Opfølgning sendt', date:today()}).then(render); }
      else { const r = rec(company); if(!r.status || r.status==='Ikke kontaktet') setRec(company,{status:'Sendt', date:today()}).then(render); }
    });
    const gmail = el('.act-gmail', card);
    if(gmail) gmail.addEventListener('click', ()=>{
      const c = DATA.contacts.find(x=>x.company===company);
      window.open(gmailComposeUrl(c), '_blank');
      const r = rec(company); if(!r.status || r.status==='Ikke kontaktet') setRec(company,{status:'Sendt', date:today()}).then(render);
    });
    const sendb = el('.act-send', card);
    if(sendb) sendb.addEventListener('click', e=>{
      const c = DATA.contacts.find(x=>x.company===company);
      const isFu = curTab === 'opfolg';
      const subject = isFu ? c.fuSubject : c.subject;
      const body = isFu ? c.fuBody : c.body;
      const status = isFu ? 'Opfølgning sendt' : 'Sendt';
      const threadId = hasReply(company) ? (THREADS[company] && THREADS[company].threadId) : null;
      const chk = el('.act-attach', card);
      const attachPlacement = (chk && chk.checked && hasMockup(c.placement)) ? c.placement : null;
      sendMail(company, { to:contactEmail(c), subject, body, status, threadId, attachPlacement }, e.target);
    });
    const editb = el('.act-edit', card);
    if(editb) editb.addEventListener('click', ()=>openContactModal(company));
    const delb = el('.act-del', card);
    if(delb) delb.addEventListener('click', ()=>deleteContact(company));
    const buyerb = el('.act-buyer', card);
    if(buyerb) buyerb.addEventListener('click', async ()=>{
      const c = DATA.contacts.find(x=>x.company===company);
      const next = BUYER_CYCLE[buyerVal(c)];
      buyerb.className = 'buyertag '+next+' act-buyer'; buyerb.textContent = BUYER[next]; // optimistic
      const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'update', company, patch:{ buyer:next, buyerReason:'Manuelt valgt af dig' } }) });
      if(res.status===401){ showGate(); return; }
      const j = await res.json();
      if(j.ok){
        DATA.contacts = j.contacts;
        const c2 = DATA.contacts.find(x=>x.company===company);
        const html = buyerReasonHTML(c2);
        const why = el('.buyerwhy', card);
        if(why){ if(html) why.outerHTML = html; else why.remove(); }
        else if(html){ el('.chead', card).insertAdjacentHTML('afterend', html); }
      }
    });
    const ai = el('.act-ai', card);
    if(ai) ai.addEventListener('click', ()=>askClaude(company, card, ai));

    const win = el('.act-win', card);
    if(win) win.addEventListener('click', ()=>{
      const wrap = el('.winwrap', card);
      const open = wrap.style.display === 'none';
      wrap.style.display = open ? '' : 'none';
      win.textContent = open ? '🎯 Skjul hjælp' : '🎯 Vind kunden';
    });

    const dtog = el('.act-draft-toggle', card);
    if(dtog) dtog.addEventListener('click', ()=>{
      const w = el('.draftwrap', card);
      const open = w.style.display === 'none';
      w.style.display = open ? '' : 'none';
      dtog.textContent = open ? '✍️ Skjul mail' : '✍️ Skriv mail';
    });
    const dgen = el('.act-draft-gen', card);
    if(dgen) dgen.addEventListener('click', ()=>generateDrafts(card.dataset.company, card));

    const saveLog = (who) => {
      const ta = el('.loginput', card);
      const text = (ta.value || '').trim();
      if(!text) return;
      api('/api/log', { method:'POST', body: JSON.stringify({ company, who, text }) })
        .then(async res=>{
          if(res.status === 401){ showGate(); return; }
          const j = await res.json();
          if(j.ok){ LOGS[company] = j.entries; el('.logentries', card).innerHTML = logEntriesHTML(company); ta.value=''; }
        }).catch(e=>console.error('log failed', e));
    };
    const bm = el('.act-log-mig', card);   if(bm) bm.addEventListener('click', ()=>saveLog('mig'));
    const bk = el('.act-log-kunde', card); if(bk) bk.addEventListener('click', ()=>saveLog('kunde'));
  });
}

/* ---------- AI suggestion ---------- */
async function askClaude(company, card, btn){
  const out = el('.ai-out', card);
  const c = DATA.contacts.find(x=>x.company===company);
  const r = rec(company);
  out.style.display='';
  out.innerHTML = '<span class="ai-loading">🤖 Claude tænker…</span>';
  btn.disabled = true;
  try {
    const res = await api('/api/suggest', { method:'POST', body: JSON.stringify({
      company, status: r.status || 'Ikke kontaktet',
      daysSince: r.date ? daysSince(r.date) : null
    })});
    if(res.status === 401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ out.innerHTML = `<span class="ai-err">${esc(j.message || 'Kunne ikke hente forslag.')}</span>`; return; }
    out.innerHTML = `<div class="ai-card">${mdLite(j.text)}</div>`;
  } catch(e){
    out.innerHTML = '<span class="ai-err">Netværksfejl.</span>';
  } finally { btn.disabled = false; }
}
// very small markdown renderer (bold + bullets + line breaks)
function mdLite(t){
  const lines = esc(t).split(/\r?\n/);
  let html=''; let inList=false;
  for(let line of lines){
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if(/^\s*[-*]\s+/.test(line)){
      if(!inList){ html+='<ul>'; inList=true; }
      html += '<li>'+line.replace(/^\s*[-*]\s+/, '')+'</li>';
    } else {
      if(inList){ html+='</ul>'; inList=false; }
      if(line.trim()==='') html+='<br>'; else html += '<p>'+line+'</p>';
    }
  }
  if(inList) html+='</ul>';
  return html;
}

/* ---------- counts / bar ---------- */
function renderCounts(){
  $('c-kold').textContent   = '('+DATA.contacts.filter(c=>c.temp==='kold').length+')';
  $('c-varm').textContent   = '('+DATA.contacts.filter(c=>c.temp==='varm').length+')';
  $('c-opfolg').textContent = '('+DATA.contacts.filter(isDue).length+')';
  $('c-svar').textContent   = '('+DATA.contacts.filter(c=>hasReply(c.company)).length+')';
}
function renderBar(){
  renderCounts();
  if(curTab === 'svar'){
    const n = DATA.contacts.filter(c=>hasReply(c.company)).length;
    $('bar').innerHTML = `<span><b>${n}</b> kunder har svaret — nyeste øverst. Klik 🤖 Spørg Claude for et svarforslag i din tone.</span>`;
    return;
  }
  if(curTab === 'opfolg'){
    const due = DATA.contacts.filter(isDue);
    const hot = due.filter(c=>fuTier(daysSince(rec(c.company).date))==='hot').length;
    $('bar').innerHTML =
      `<span><b>${due.length}</b> klar til opfølgning (≥ ${followupDays()} dage siden sidste mail, intet svar)</span>`+
      (hot ? `<span class="bar-hot">🔴 <b>${hot}</b> for længe siden (≥ ${followupDays()*2} dage) — tag dem først</span>` : '');
    return;
  }
  const pool = DATA.contacts.filter(c=>c.temp===curTab);
  const n = {}; pool.forEach(c=>{ const st = rec(c.company).status || 'Ikke kontaktet'; n[st]=(n[st]||0)+1; });
  const contacted = (n['Sendt']||0)+(n['Opfølgning sendt']||0)+(n['Svar modtaget']||0)+(n['Booket']||0)+(n['Nej tak']||0);
  $('bar').innerHTML =
    `<span><b>${contacted}/${pool.length}</b> kontaktet</span>`+
    `<span>📤 Sendt: <b>${n['Sendt']||0}</b></span>`+
    `<span>🔁 Opfulgt: <b>${n['Opfølgning sendt']||0}</b></span>`+
    `<span>💬 Svar: <b>${n['Svar modtaget']||0}</b></span>`+
    `<span>✅ Booket: <b>${n['Booket']||0}</b></span>`+
    `<span>⬜ Mangler: <b>${n['Ikke kontaktet']||0}</b></span>`;
}

/* ---------- export / summary ---------- */
function exportCSV(){
  const rows = [['Kunde','Temp','Anbefalet placering','Segment','Status','Dato','Note']];
  DATA.contacts.forEach(c=>{ const r = rec(c.company);
    rows.push([c.company,c.temp,c.placement,c.segment,r.status||'Ikke kontaktet',r.date||'',r.note||'']); });
  const csv = rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'hyde_status.csv'; a.click();
}
function summary(btn){
  const g = {}; DATA.contacts.forEach(c=>{ const st = rec(c.company).status || 'Ikke kontaktet'; (g[st]=g[st]||[]).push(c); });
  const fmt = c => c.company + (c.placement?(' ['+c.placement+']'):'') + (rec(c.company).date?(' '+rec(c.company).date):'');
  let out = 'Hyde outreach-status pr. '+today()+'\n';
  ['Sendt','Opfølgning sendt','Svar modtaget','Booket','Nej tak'].forEach(k=>{
    if(g[k]) out += `\n${k} (${g[k].length}):\n` + g[k].map(fmt).map(x=>'- '+x).join('\n') + '\n';
  });
  out += `\nKlar til opfølgning: ${DATA.contacts.filter(isDue).length} · Mangler: ${(g['Ikke kontaktet']||[]).length}`;
  copyText(out, btn);
}

/* ---------- misc ---------- */
function esc(s){ return String(s).replace(/[&<>"]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

function bindGlobal(){
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>{
    curTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active', x===t));
    render();
  }));
  $('q').addEventListener('input', render);
  $('fil').addEventListener('change', render);
  $('thr').addEventListener('change', render);
  $('btnExport').addEventListener('click', exportCSV);
  $('btnSummary').addEventListener('click', e=>summary(e.target));
  $('btnReset').addEventListener('click', async ()=>{
    if(confirm('Nulstil al status til den importerede CSV?')){
      const res = await api('/api/state', { method:'POST', body: JSON.stringify({ reset:true }) });
      const j = await res.json(); STATE = j.state || {}; render();
    }
  });
  $('btnLogout').addEventListener('click', async ()=>{
    await api('/api/logout', { method:'POST' }); location.reload();
  });
  $('btnClassify').addEventListener('click', classifyContacts);
  $('fbuyer').addEventListener('change', render);
  $('btnBrief').addEventListener('click', openBriefing);
  $('btnMockups').addEventListener('click', openMockups);
  $('mockupsClose').addEventListener('click', closeMockups);
  $('mockups').addEventListener('click', e=>{ if(e.target===$('mockups')) closeMockups(); });
  $('briefClose').addEventListener('click', closeBriefing);
  $('briefRefresh').addEventListener('click', loadBriefing);
  $('brief').addEventListener('click', e=>{ if(e.target===$('brief')) closeBriefing(); });
  $('btnAdd').addEventListener('click', ()=>openContactModal(null));
  $('modalClose').addEventListener('click', closeModal);
  $('modalCancel').addEventListener('click', closeModal);
  $('modalSave').addEventListener('click', saveContact);
  $('modal').addEventListener('click', e=>{ if(e.target===$('modal')) closeModal(); });
}

/* ---------- gmail ---------- */
function fmtSync(ts){ if(!ts) return 'aldrig'; const d=new Date(ts); return d.toLocaleString('da-DK',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); }
function renderGmailBox(){
  const box = $('gmailbox'); if(!box) return;
  if(!GMAIL.configured){ box.innerHTML = '<span class="gmail-hint" title="Sæt GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET i Vercel">📧 Gmail ikke opsat</span>'; return; }
  if(!GMAIL.connected){ box.innerHTML = '<button class="hbtn gmail-connect" id="btnGmailConnect">🔗 Forbind Gmail</button>'; el('#btnGmailConnect').addEventListener('click', ()=>{ window.location='/api/google/auth'; }); return; }
  box.innerHTML = `<button class="hbtn" id="btnSync">🔄 Synk Gmail</button><span class="gmail-last">sidst: ${fmtSync(GMAIL.lastSync)}</span>`;
  el('#btnSync').addEventListener('click', runSync);
}
function toast(msg, ok=true, action){
  const t = $('synctoast'); if(!t) return;
  t.className = 'synctoast ' + (ok?'ok':'err'); t.style.display='';
  t.innerHTML = '';
  const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  if(action){
    const b = document.createElement('button'); b.className='toastbtn'; b.textContent=action.label;
    b.onclick = ()=>{ t.style.display='none'; action.fn(); };
    t.appendChild(b);
  }
  clearTimeout(toast._t); toast._t = setTimeout(()=>{ t.style.display='none'; }, action?9000:6000);
}
async function runSync(){
  const btn = $('btnSync'); if(btn){ btn.disabled=true; btn.textContent='🔄 Synkroniserer…'; }
  try {
    const res = await api('/api/sync', { method:'POST' });
    if(res.status === 401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ toast(j.message || 'Synk fejlede.', false); return; }
    const s = j.summary;
    toast(`✅ Synk færdig: ${s.sent} sendt-opdateret, ${s.replies} ægte svar, ${s.autoreplies} auto-svar filtreret.`, true);
    if(await loadData()) render();
  } catch(e){ toast('Netværksfejl under synk.', false); }
  finally { if($('btnSync')){ $('btnSync').disabled=false; $('btnSync').textContent='🔄 Synk Gmail'; } }
}
/* ---------- send directly via Gmail ---------- */
function canSend(c){ return GMAIL.connected && !!contactEmail(c); }
async function sendMail(company, opts, btn){
  const { to, subject, body, status, threadId, attachPlacement } = opts;
  if(!to){ toast('Ingen email på kunden — tilføj en email først (✏️).', false); return; }
  if(!body){ toast('Intet mailudkast at sende — skriv en mail først.', false); return; }
  const attachNote = attachPlacement ? ' (mockup vedhæftes)' : '';
  if(!confirm('Send mailen direkte til '+to+' nu?'+attachNote)) return;
  const o = btn.textContent; btn.disabled = true; btn.textContent = '📤 Sender…';
  try{
    const res = await api('/api/send', { method:'POST', body: JSON.stringify({ company, to, subject, body, status, threadId, attachPlacement }) });
    if(res.status === 401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ toast(j.message || 'Kunne ikke sende.', false); btn.disabled=false; btn.textContent=o; return; }
    if(j.rec) STATE[company] = j.rec;
    toast('📤 Sendt til '+to+' — status sat til “'+((j.rec&&j.rec.status)||status||'Sendt')+'”.', true);
    render();
  }catch(e){ toast('Netværksfejl under afsendelse.', false); btn.disabled=false; btn.textContent=o; }
}

// strip ?gmail=… from URL after handling
function handleGmailReturn(){
  const p = new URLSearchParams(location.search);
  if(p.get('gmail')==='connected'){ history.replaceState({}, '', location.pathname); toast('✅ Gmail forbundet! Kører første synk…', true); runSync(); }
  else if(p.get('gmail')==='error'){ history.replaceState({}, '', location.pathname); toast('Gmail-forbindelse mislykkedes. Prøv igen.', false); }
}

/* ---------- contacts CRUD ---------- */
let editingCompany = null;
function fillPlacementSelect(sel, val){
  const opts = ['<option value="">— ingen —</option>'].concat(
    Object.keys(DATA.placements||{}).map(p=>`<option ${p===val?'selected':''}>${esc(p)}</option>`));
  sel.innerHTML = opts.join('');
}
function openContactModal(company){
  editingCompany = company || null;
  const c = company ? DATA.contacts.find(x=>x.company===company) : null;
  $('modalTitle').textContent = c ? 'Rediger kunde' : 'Tilføj kunde';
  $('modalErr').textContent = '';
  $('f-company').value = c ? c.company : '';
  $('f-company').disabled = !!c;
  $('f-temp').value = c ? (c.temp||'kold') : 'kold';
  $('f-buyer').value = c ? (c.buyer||'ukendt') : 'ukendt';
  fillPlacementSelect($('f-placement'), c ? (c.placement||'') : '');
  $('f-segment').value = c ? (c.segment||'') : '';
  $('f-person').value  = c ? (c.person||'')  : '';
  $('f-email').value   = c ? (c.email||'')   : '';
  $('f-phone').value   = c ? (c.phone||'')   : '';
  $('f-subject').value = c ? (c.subject||'') : '';
  $('f-body').value    = c ? (c.body||'')    : '';
  $('modal').style.display = 'flex';
  setTimeout(()=>{ const f=$('f-company'); if(f && !f.disabled) f.focus(); }, 40);
}
function closeModal(){ $('modal').style.display='none'; }
async function saveContact(){
  const company = $('f-company').value.trim();
  if(!company){ $('modalErr').textContent = 'Firma er påkrævet.'; return; }
  const fields = {
    temp:$('f-temp').value, buyer:$('f-buyer').value, placement:$('f-placement').value, segment:$('f-segment').value,
    person:$('f-person').value, email:$('f-email').value.trim(), phone:$('f-phone').value,
    subject:$('f-subject').value, body:$('f-body').value,
  };
  const btn = $('modalSave'); btn.disabled = true;
  try{
    const payload = editingCompany
      ? { action:'update', company:editingCompany, patch:fields }
      : { action:'add', contact:{ company, ...fields } };
    const res = await api('/api/contacts', { method:'POST', body: JSON.stringify(payload) });
    if(res.status === 401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ $('modalErr').textContent = j.message || 'Kunne ikke gemme.'; return; }
    DATA.contacts = j.contacts;
    closeModal(); render();
    toast(editingCompany ? '✏️ Kunde opdateret.' : '➕ Kunde tilføjet.', true);
  }catch(e){ $('modalErr').textContent = 'Netværksfejl.'; }
  finally{ btn.disabled = false; }
}
async function deleteContact(company){
  if(!confirm('Skjul "'+company+'" fra listen? Du kan fortryde bagefter.')) return;
  const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'delete', company }) });
  if(res.status === 401){ showGate(); return; }
  const j = await res.json();
  if(j.ok){ DATA.contacts = j.contacts; render(); toast('🗑️ "'+company+'" skjult.', true, { label:'Fortryd', fn:()=>restoreContact(company) }); }
}
async function restoreContact(company){
  const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'restore', company }) });
  const j = await res.json();
  if(j.ok){ DATA.contacts = j.contacts; render(); toast('↩️ "'+company+'" gendannet.', true); }
}
async function classifyContacts(){
  if(!HAS_AI){ toast('AI er slået fra — tilføj ANTHROPIC_API_KEY.', false); return; }
  if(!confirm('Lad Claude analysere alle kunder og sætte 🏢 Bureau / 🤝 Selv / ❓ Ukendt?\n\nDet er et kvalificeret gæt ud fra virksomhedstype — du kan rette manuelt bagefter (klik på en markering for at skifte).')) return;
  const btn = $('btnClassify'); if(btn){ btn.disabled=true; btn.textContent='🏷️ Analyserer…'; }
  toast('🏷️ Claude analyserer alle dine kunder…', true);
  try{
    const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'classify' }) });
    if(res.status===401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ toast(j.message || 'Kunne ikke analysere.', false); return; }
    DATA.contacts = j.contacts; render();
    toast(`🏷️ Færdig: ${j.counts.bureau} bureau · ${j.counts.selv} selv · ${j.counts.ukendt} ukendt. Ret frit ved at klikke på en markering.`, true);
  }catch(e){ toast('Netværksfejl.', false); }
  finally{ if($('btnClassify')){ $('btnClassify').disabled=false; $('btnClassify').textContent='🏷️ Auto-tag indkøb'; } }
}

/* ---------- daily briefing ---------- */
async function loadBriefing(){
  const b = $('briefBody');
  if(!HAS_AI){ b.innerHTML = '<div class="ai-err">AI er slået fra — tilføj ANTHROPIC_API_KEY i Vercel.</div>'; return; }
  b.innerHTML = '<div class="ai-loading">☀️ Claude læser hele din pipeline og prioriterer din dag…</div>';
  try{
    const res = await api('/api/briefing', { method:'POST', body: JSON.stringify({ followupDays: followupDays() }) });
    if(res.status === 401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ b.innerHTML = '<div class="ai-err">'+esc(j.message||'Kunne ikke lave briefing.')+'</div>'; return; }
    b.innerHTML = '<div class="ai-card brief-card">'+mdLite(j.text)+'</div>';
  }catch(e){ b.innerHTML = '<div class="ai-err">Netværksfejl.</div>'; }
}
function openBriefing(){ $('brief').style.display='flex'; loadBriefing(); }
function closeBriefing(){ $('brief').style.display='none'; }

/* ---------- placement mockups ---------- */
function hasMockup(name){ return !!name && PLACEMENT_IMAGES.has(name); }
function mockUrl(name){ return '/api/placements?img=' + encodeURIComponent(name) + '&v=' + MOCK_BUST; }
// Downscale a picked image to keep it well under the storage size limit.
function downscaleImage(file, maxW=1280, quality=0.82){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>{
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width*scale), h = Math.round(img.height*scale);
      const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', quality));
    };
    img.onerror = ()=>reject(new Error('billede kunne ikke læses'));
    const fr = new FileReader();
    fr.onload = ()=>{ img.src = fr.result; };
    fr.onerror = ()=>reject(new Error('fil kunne ikke læses'));
    fr.readAsDataURL(file);
  });
}
function renderMockupList(){
  const box = $('mockupList'); if(!box) return;
  const names = Object.keys(DATA.placements||{});
  box.innerHTML = names.map(name=>{
    const p = DATA.placements[name];
    const has = hasMockup(name);
    const thumb = has
      ? `<img class="mockprev" src="${mockUrl(name)}" alt="">`
      : `<div class="mockprev empty">Ingen mockup</div>`;
    return `<div class="mockrow" data-name="${esc(name)}">
      ${thumb}
      <div class="mockinfo"><b>${esc(name)}</b><span>${esc(p.area||'')}</span></div>
      <div class="mockacts">
        <label class="btn small mockup-pick">${has?'Skift':'Upload'}<input type="file" accept="image/*" class="act-mock-file" hidden></label>
        ${has?`<button class="btn small act-mock-del">Fjern</button>`:''}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.mockrow').forEach(row=>{
    const name = row.dataset.name;
    const file = el('.act-mock-file', row);
    if(file) file.addEventListener('change', e=>uploadMockup(name, e.target.files[0], row));
    const del = el('.act-mock-del', row);
    if(del) del.addEventListener('click', ()=>removeMockup(name, row));
  });
}
async function uploadMockup(name, file, row){
  if(!file) return;
  const pick = el('.mockup-pick', row); const lbl = pick ? pick.firstChild.textContent : '';
  if(pick) pick.firstChild.textContent = 'Uploader…';
  try{
    const dataUrl = await downscaleImage(file);
    const res = await api('/api/placements', { method:'POST', body: JSON.stringify({ action:'set', placement:name, image:{ dataUrl, filename: (name.replace(/[^\w]+/g,'_')||'mockup')+'.jpg' } }) });
    if(res.status===401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ toast(j.message || 'Kunne ikke gemme billedet.', false); if(pick) pick.firstChild.textContent=lbl; return; }
    PLACEMENT_IMAGES = new Set(j.withImage || []);
    MOCK_BUST++;
    renderMockupList(); render();
    toast('🖼️ Mockup gemt for '+name+'.', true);
  }catch(e){ toast('Billedet kunne ikke behandles.', false); if(pick) pick.firstChild.textContent=lbl; }
}
async function removeMockup(name, row){
  if(!confirm('Fjern mockup for "'+name+'"?')) return;
  const res = await api('/api/placements', { method:'POST', body: JSON.stringify({ action:'delete', placement:name }) });
  if(res.status===401){ showGate(); return; }
  const j = await res.json();
  if(j.ok){ PLACEMENT_IMAGES = new Set(j.withImage || []); MOCK_BUST++; renderMockupList(); render(); toast('🗑️ Mockup fjernet for '+name+'.', true); }
}
function openMockups(){ $('mockups').style.display='flex'; renderMockupList(); }
function closeMockups(){ $('mockups').style.display='none'; }

/* ---------- auth / boot ---------- */
function showGate(){ $('gate').style.display='flex'; $('app').style.display='none'; const pw=$('pw'); if(pw) pw.focus(); }
function showApp(){ $('gate').style.display='none'; $('app').style.display=''; }

async function loadData(){
  const res = await api('/api/data');
  if(res.status === 401){ showGate(); return false; }
  if(!res.ok){ alert('Kunne ikke loade data.'); return false; }
  const d = await res.json();
  DATA = { contacts:d.contacts, placements:d.placements||{}, followupDaysDefault:d.followupDaysDefault||5 };
  STATE = d.state || {};
  LOGS = d.logs || {};
  THREADS = d.threads || {};
  GMAIL = d.gmail || { configured:false, connected:false, lastSync:null };
  PLACEMENT_IMAGES = new Set(d.placementImages || []);
  HAS_AI = !!d.hasAI;
  renderGmailBox();
  if(DATA.followupDaysDefault) $('thr').value = DATA.followupDaysDefault;
  return true;
}

async function boot(){
  if(await loadData()){
    showApp();
    bindGlobal();
    render();
    handleGmailReturn();
  }
}

$('loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  $('loginErr').textContent = '';
  const res = await api('/api/login', { method:'POST', body: JSON.stringify({ password: $('pw').value }) });
  if(res.ok){
    showApp();
    if(await loadData()){ bindGlobal(); render(); }
  } else {
    $('loginErr').textContent = 'Forkert adgangskode.';
  }
});

boot();
