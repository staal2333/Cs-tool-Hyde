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
let HISTORY = {};          // { company: {events:[{dir,date,ts,subject,snippet,placements,auto}], placements:[], sentCount, replied, lastReplyTs, lastTs} }
let GMAIL = { configured:false, connected:false, lastSync:null };
let PLACEMENT_IMAGES = new Set();   // placement names that have a mockup
let MOCK_BUST = 0;                  // bumped after upload/delete to bust <img> cache
let HAS_AI = false;
let curTab = 'dash';
let histMode = 'timeline';   // Historik view: 'timeline' (by time) | 'contacts' (per customer)

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
  const st = rec(c.company).status || 'Ikke kontaktet';
  if(st !== 'Sendt' && st !== 'Opfølgning sendt') return false; // excludes replies, Booket, Nej tak
  return daysSinceTouch(c) >= fuCadence(c);
}
// Sent but not yet due — queued for an upcoming follow-up.
function fuWaiting(c){
  const st = rec(c.company).status || '';
  return (st === 'Sendt' || st === 'Opfølgning sendt') && daysSinceTouch(c) < fuCadence(c);
}
// How many mails we've sent this contact so far (from the Gmail history).
function sentCountOf(company){ const h = HISTORY[company]; return (h && h.sentCount) || 0; }
// Touch count = mails we've sent. Falls back to status when there's no Gmail history yet.
function touchCount(c){
  const n = sentCountOf(c.company);
  if(n) return n;
  const st = rec(c.company).status;
  if(st === 'Opfølgning sendt') return 2;
  if(st === 'Sendt') return 1;
  return 0;
}
// Timestamp of the last mail WE sent (from history), else the stored status date.
function lastTouchTs(c){
  const h = HISTORY[c.company];
  if(h && h.events){
    const outs = h.events.filter(e=>e.dir==='out');
    if(outs.length) return outs[outs.length-1].ts;
  }
  const d = parseDate(rec(c.company).date);
  return d ? d.getTime() : 0;
}
function daysSinceTouch(c){ const ts = lastTouchTs(c); return ts ? Math.floor((Date.now()-ts)/86400000) : 0; }
// Follow-up stage drives grouping, the recommended scenario AND the cadence.
function fuStage(c){ const n = touchCount(c); return n>=3 ? 'last' : (n===2 ? 'second' : 'first'); }
function fuScenario(c){ return ({ first:'followup', second:'nudge', last:'after_no' })[fuStage(c)]; }
// Increasing cadence: wait longer between each touch so you don't over-chase.
// Base = the "dage" field; +3 before the 2nd follow-up, +6 before the last.
function fuCadence(c){ const t = followupDays(); return ({ first:t, second:t+3, last:t+6 })[fuStage(c)]; }
function dueIn(c){ return fuCadence(c) - daysSinceTouch(c); } // days until due (negative = overdue)
// If the latest inbound was an auto-reply (out-of-office), surface why they're quiet.
function autoReplyNote(c){
  const h = HISTORY[c.company];
  if(!h || !h.events) return '';
  const ins = h.events.filter(e=>e.dir==='in');
  const last = ins[ins.length-1];
  return (last && last.auto) ? (last.snippet||'').slice(0,90) : '';
}
// The status a contact should land on right after you send them a mail.
// A 2nd+ mail (or sending from the follow-up tab) is a follow-up; the first is "Sendt".
function statusAfterSend(company, isFu){
  if(isFu) return 'Opfølgning sendt';
  const cur = rec(company).status || 'Ikke kontaktet';
  const alreadyContacted = cur !== 'Ikke kontaktet' || sentCountOf(company) >= 1;
  return alreadyContacted ? 'Opfølgning sendt' : 'Sendt';
}
// Persist a send: advance status + stamp today's date so the pipeline reflects it now.
function registerSend(company, isFu){
  return setRec(company, { status: statusAfterSend(company, isFu), date: today() }).then(render);
}
// Follow-up radar: days since the last mail + an urgency tier.
function fuTier(days, base){
  const t = base || followupDays();
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
  if(!p || !p.price) return null;
  if(p.type === 'dooh') return `${c.placement}: 4 uger til 1 uges pris (${p.price} mod normalt ${p.list||''}) — de første 8 annoncører, 12% share of voice, ${p.period||''}.`;
  return `Hele juli til ${p.price} på ${c.placement} — prisen for kun 2 uger.`;
}
// Tactic per segment/type from the CRM export.
const SEGMENT_TACTIC = {
  'Første kontakt': 'Hold første mail kort: én placering, ét tal (eksponeringer), én pris. Bed om et ja/nej, ikke et møde.',
  'Følg op': 'Henvis til jeres sidste dialog og giv en ny grund til at handle nu (juli-tilbuddet: hele måneden til prisen for 2 uger).',
  'Nudge / opfølg': 'Lille, venlig nudge — tilbyd at holde pladsen et par dage, så der er en deadline.',
  'Re-aktivér': 'Bring noget nyt: ny placering, ny pris eller ny periode — ikke bare “følger lige op”.',
  'Genåbn': 'Anerkend pausen og åbn med en konkret anledning (sommerkampagnen — hele juli til prisen for 2 uger).',
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
  if(p && p.type === 'dooh') tips.push(`Skab knaphed: kun de første 8 annoncører får lanceringstilbuddet (4 uger til 1 uges pris) — og skærmen går live ${p.live||'snart'}.`);
  else if(p && p.period) tips.push(`Skab knaphed: ${p.period} kan kun sælges én gang — book hele måneden mens den er ledig.`);
  return tips.slice(0,5);
}
function angleFor(c){
  const p = placementData(c);
  const where = p && p.area ? `${c.placement} (${p.area})` : (c.placement || 'en stærk placering');
  if(p && p.type === 'dooh') return `${c.company}: digital skærm på ${where} med ${p.daily||''} forbipasserende i døgnet — lanceringstilbud: 4 uger til 1 uges pris (kun de første 8 annoncører).`;
  return `${c.company}: synlighed på ${where}${p && p.impr ? ` med ${p.impr} eksponeringer/uge` : ''} — hele juli til prisen for kun 2 uger.`;
}

/* ---------- rendering ---------- */
function hasReply(company){ const t=THREADS[company]; const st=rec(company).status||''; return (t && !t.auto) || st==='Svar modtaget'; }
function replyTime(company){ const t=THREADS[company]; if(t && t.date) return t.date; const d=parseDate(rec(company).date); return d?d.getTime():0; }
function contactEmail(c){ return c.email || ''; }
/* ---------- tags & area segmentation ---------- */
function areaOf(c){ const p = c.placement && DATA.placements[c.placement]; return (p && p.area) || ''; }
function allAreas(){ return [...new Set(Object.values(DATA.placements||{}).map(p=>p.area).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'da')); }
function allTags(){ const s=new Set(); DATA.contacts.forEach(c=>(c.tags||[]).forEach(t=>s.add(t))); return [...s].sort((a,b)=>a.localeCompare(b,'da')); }
function tagsHTML(c){ const t=c.tags||[]; if(!t.length) return ''; return `<div class="tagrow">${t.map(x=>`<span class="ctag">${esc(x)}</span>`).join('')}</div>`; }
/* ---------- lead scoring ---------- */
// 📅 Booking-sandsynlighed (1–5) — rule-based from engagement signals.
function crmHeat(c){ const s=(c.crmStatus||'').toLowerCase(); if(s.includes('hot')) return 2; if(s.includes('warm')||s.includes('varm')) return 1; return 0; }
function bookingScore(c){
  const r = rec(c.company); const st = r.status || 'Ikke kontaktet';
  if(st === 'Booket') return 5;
  if(st === 'Nej tak') return 1;
  let p = st==='Svar modtaget' ? 55 : st==='Opfølgning sendt' ? 30 : st==='Sendt' ? 20 : 10;
  if(hasReply(c.company)) p += 25;
  if(c.temp === 'varm') p += 15;
  p += crmHeat(c) * 8;
  if((LOGS[c.company]||[]).some(e=>e.who==='kunde')) p += 10;
  if(st !== 'Ikke kontaktet' && r.date){ const d=daysSince(r.date), t=followupDays(); if(d<=t) p+=10; else if(d<=t*2) p+=5; }
  const th = THREADS[c.company]; if(th && th.auto && !hasReply(c.company)) p -= 15;
  p = Math.max(0, Math.min(100, p));
  return Math.max(1, Math.min(5, Math.ceil(p/20)));
}
function moneyScore(c){ const n = Number(c.moneyScore); return n>=1 && n<=5 ? n : 0; }
function stars(n){ n=Math.max(0,Math.min(5,n|0)); return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n); }
function scoreChips(c){
  const b = bookingScore(c);
  const m = moneyScore(c);
  const bChip = `<span class="scorechip s${b}" title="📅 Booking-sandsynlighed (auto): ${b}/5">📅 <span class="stars">${stars(b)}</span></span>`;
  const mChip = m
    ? `<span class="scorechip s${m}" title="💰 Budget/outdoor-match (Claude): ${m}/5${c.moneyReason?' — '+esc(c.moneyReason):''}">💰 <span class="stars">${stars(m)}</span></span>`
    : `<span class="scorechip none" title="Budget ikke vurderet endnu — tryk 💰 Vurder budget">💰 <span class="stars">– – – – –</span></span>`;
  return `<div class="scorerow">${bChip}${mChip}</div>`;
}
function populateFilters(){
  const fa=$('farea'), ft=$('ftag');
  if(fa){ const cur=fa.value; fa.innerHTML='<option value="">📍 Alle områder</option>'+allAreas().map(a=>`<option ${a===cur?'selected':''}>${esc(a)}</option>`).join(''); }
  if(ft){ const cur=ft.value; const tags=allTags();
    ft.innerHTML='<option value="">🏷️ Alle tags</option>'+tags.map(t=>`<option ${t===cur?'selected':''}>${esc(t)}</option>`).join('');
    ft.style.display = tags.length ? '' : 'none';
  }
}
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
  const def = curTab === 'opfolg' ? fuScenario(c) : defaultScenario(c);
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
    const markSent = ()=> registerSend(company, false);
    el('.act-vcopysub', v).addEventListener('click', e=>copyText(subj, e.target));
    el('.act-vcopy', v).addEventListener('click', e=>{ copyText(bodyt, e.target); markSent(); });
    const vsend = el('.act-vsend', v);
    if(vsend) vsend.addEventListener('click', e=>{
      const threadId = (THREADS[company] && THREADS[company].threadId) || (HISTORY[company] && HISTORY[company].threadId) || null;
      const plac = (el('.d-placement', card) || {}).value || c.placement;
      const attachPlacement = hasMockup(plac) ? plac : null;
      const scenario = (el('.d-scenario', card) || {}).value || defaultScenario(c);
      sendMail(company, { to:contactEmail(c), subject:subj, body:bodyt, status:statusAfterSend(company,false), threadId, attachPlacement, scenario }, e.target);
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
function placementChips(list){
  if(!list || !list.length) return '';
  return `<span class="plchips">${list.map(p=>`<span class="plchip">📍 ${esc(p)}</span>`).join('')}</span>`;
}
// Per-contact, Gmail-aligned timeline: every mail (out/in), date, subject + which placement was offered.
function historyHTML(company){
  const h = HISTORY[company];
  if(!h || !h.events || !h.events.length) return '';
  const offered = h.placements && h.placements.length
    ? `<div class="hist-offered">Tilbudt: ${placementChips(h.placements)}</div>` : '';
  const evs = h.events.slice(-8); // newest 8, oldest first within that window
  const hidden = h.events.length - evs.length;
  const rows = evs.slice().reverse().map(e=>{
    const icon = e.dir==='out' ? '📤' : (e.auto ? '🤖' : '📨');
    const who = e.dir==='out' ? 'Sendt' : (e.auto ? 'Auto-svar' : 'Svar');
    const pl = e.dir==='out' ? placementChips(e.placements) : '';
    return `<div class="hist-row ${e.dir}${e.auto?' auto':''}">
      <span class="hist-ic">${icon}</span>
      <span class="hist-meta"><b>${who}</b> · ${esc(e.date||'')}</span>
      <span class="hist-subj">${esc(e.subject||'')}</span>
      ${pl}
      <span class="hist-snip">${esc((e.snippet||'').slice(0,140))}</span>
    </div>`;
  }).join('');
  const more = hidden>0 ? `<div class="hist-more">+${hidden} ældre mails i tråden</div>` : '';
  return `<div class="histbox">
    <div class="hist-title">📜 Gmail-historik (${h.sentCount||0} sendt${h.replied?' · svar modtaget':''})</div>
    ${offered}
    <div class="hist-rows">${rows}</div>
    ${more}
  </div>`;
}
// Kept for any legacy callers; the card now uses historyHTML.
function threadHTML(company){ return historyHTML(company); }

/* ---------- Historik tab: per-contact overview of sends + placements ---------- */
function histList(){
  return Object.entries(HISTORY)
    .map(([company,h])=>({ company, h, c: DATA.contacts.find(x=>x.company===company) }))
    .filter(x=>x.h && x.h.events && x.h.events.length);
}
function personOf(company, c){
  const h = HISTORY[company];
  return (h && h.person) || (c && c.person) || '';
}
function lastReplySnippet(h){
  const ins = (h.events||[]).filter(e=>e.dir==='in' && !e.auto);
  const last = ins[ins.length-1];
  return last ? (last.snippet||'') : '';
}
function historyTableHTML(q){
  let rows = histList();
  if(q) rows = rows.filter(x=> (x.company+' '+personOf(x.company,x.c)+' '+((x.c&&x.c.email)||'')+' '+(x.h.placements||[]).join(' ')).toLowerCase().includes(q));
  rows.forEach(x=>{
    x.st = rec(x.company).status || 'Ikke kontaktet';
    x.closed = x.st==='Booket' || x.st==='Nej tak';
    x.hot = x.h.replied && !x.closed;     // replied & still open → needs you now
  });
  // Hot first, then newest activity.
  rows.sort((a,b)=> (b.hot-a.hot) || (b.h.lastTs||0)-(a.h.lastTs||0));
  const totSent = rows.reduce((s,x)=>s+(x.h.sentCount||0),0);
  const hot = rows.filter(x=>x.hot).length;
  if(!rows.length) return '<div class="histempty">Ingen Gmail-historik endnu — tryk “Synk Gmail” øverst for at hente hvad hver kunde har modtaget.</div>';
  const row = ({company,h,c,st,hot})=>{
    const person = personOf(company,c);
    const last = h.events[h.events.length-1];
    const lastTxt = last ? `${last.dir==='out'?'📤 sendt':(last.auto?'🤖 auto':'📨 svar')} · ${esc(last.date||'')}` : '';
    const snip = hot ? lastReplySnippet(h) : '';
    return `<tr class="${hot?'ht-hot':''}" data-company="${esc(company)}">
      <td class="ht-co">
        ${person?`<div class="ht-name">${esc(person)}</div>`:'<div class="ht-name muted">— navn ukendt —</div>'}
        <div class="ht-comp">${esc(company)}</div>
      </td>
      <td class="ht-pl">${placementChips(h.placements)||'<span class="muted">—</span>'}</td>
      <td class="ht-last">${lastTxt}<div class="ht-sent2">${h.sentCount||0} sendt${h.replied?' · svar':''}</div></td>
      <td class="ht-st"><span class="badge ${hot?'reply':''}">${hot?'🔥 ':''}${esc(st)}</span>${snip?`<div class="ht-snip">“${esc(snip.slice(0,120))}”</div>`:''}</td>
      <td><button class="btn small act-open" title="Åbn kunden og svar">${hot?'Svar ›':'Åbn ›'}</button></td>
    </tr>`;
  };
  return `<div class="histwrap">
    <div class="hist-sum">📜 ${rows.length} kunder i dialog · ${totSent} mails sendt · <b class="hist-hot">${hot} venter på dig</b></div>
    <table class="histtable">
      <thead><tr><th>Person / kunde</th><th>Placeringer tilbudt</th><th>Seneste</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table></div>`;
}
/* ---------- Opfølgning: touch-based, Gmail-synced follow-up queue ---------- */
function followupHTML(){
  const q = $('q').value.toLowerCase();
  const f = $('fil').value;
  const fb = ($('fbuyer')&&$('fbuyer').value)||'';
  const fa = ($('farea')&&$('farea').value)||'';
  const ft = ($('ftag')&&$('ftag').value)||'';
  const match = c=>{
    const hay = (c.company+' '+(c.person||'')+' '+(c.email||'')+' '+areaOf(c)+' '+(c.tags||[]).join(' ')).toLowerCase();
    const st = rec(c.company).status||'';
    return hay.includes(q) && (!f||st===f) && (!fb||buyerVal(c)===fb) && (!fa||areaOf(c)===fa) && (!ft||(c.tags||[]).includes(ft));
  };
  const due = DATA.contacts.filter(c=>isDue(c)&&match(c));
  const waiting = DATA.contacts.filter(c=>fuWaiting(c)&&match(c));
  const val = c=>priceKr(c.placement);
  const sortDue = (a,b)=> (daysSinceTouch(b)-daysSinceTouch(a)) || (val(b)-val(a)); // most overdue, then most valuable
  const t = followupDays();
  const groups = [
    { key:'first',  icon:'🟢', title:'Klar til 1. opfølgning', hint:`Sendt én mail uden svar (${t}+ dage) — send en blød, kort opfølgning.` },
    { key:'second', icon:'🟡', title:'Klar til 2. opfølgning', hint:`Fulgt op én gang, stadig tavse (${t+3}+ dage) — kom med en NY vinkel (fx Gothersgade-skærmen eller en anden placering).` },
    { key:'last',   icon:'🔴', title:'Sidste forsøg', hint:`3+ mails uden svar (${t+6}+ dage) — ét sidste let touch, ellers park dem (sæt “Nej tak”).` },
  ];
  const total = due.length;
  let html = `<div class="fu-top">⏰ <b>${total}</b> klar til opfølgning nu${waiting.length?` · ${waiting.length} kommer i kø`:''}</div>`;
  let any = false;
  for(const g of groups){
    const list = due.filter(c=>fuStage(c)===g.key).sort(sortDue);
    if(!list.length) continue;
    any = true;
    html += `<div class="fu-group"><div class="fu-gtitle">${g.icon} ${g.title} <span class="fu-gcount">${list.length}</span></div><div class="fu-ghint">${g.hint}</div></div>`;
    html += list.map(cardHTML).join('');
  }
  if(!any) html += '<div class="fu-none">Ingen forfaldne opfølgninger lige nu 🎉</div>';
  if(waiting.length){
    const soon = waiting.sort((a,b)=> dueIn(a) - dueIn(b));
    html += `<div class="fu-group waiting"><div class="fu-gtitle">⏳ Kommer i kø <span class="fu-gcount">${waiting.length}</span></div>`+
      `<div class="fu-ghint">Sendt, men endnu ikke forfaldne efter cadencen — vises med dage til de er klar.</div>`+
      `<div class="fu-waitlist">${soon.slice(0,50).map(c=>{const left=Math.max(0,dueIn(c));return `<span class="fu-waitchip" title="${esc(c.company)} · ${touchCount(c)}. mail · ${daysSinceTouch(c)} dage siden">${esc(personOf(c.company,c)||c.company)} <b>${left}d</b></span>`;}).join('')}</div></div>`;
  }
  return html;
}
// Human day label for the timeline ("I dag" / "I går" / weekday / date).
const DK_DAYS = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
function dayLabel(ts){
  const d = new Date(ts);
  const startOf = (x)=> new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if(diff === 0) return 'I dag';
  if(diff === 1) return 'I går';
  if(diff > 1 && diff < 7) return DK_DAYS[d.getDay()];
  return d.toLocaleDateString('da-DK', { day:'numeric', month:'short', year:'numeric' });
}
// Chronological feed across all customers: who received / replied, and when.
function historyTimelineHTML(q){
  const rows = [];
  for(const [co, h] of Object.entries(HISTORY)){
    if(!h || !h.events) continue;
    const c = DATA.contacts.find(x=>x.company===co);
    const person = personOf(co, c);
    if(q && !((co+' '+person+' '+(h.placements||[]).join(' ')).toLowerCase().includes(q))) continue;
    for(const e of h.events) if(e && e.ts) rows.push({ co, person, e });
  }
  if(!rows.length) return '<div class="histempty">Ingen aktivitet endnu — tryk “Synk Gmail”.</div>';
  rows.sort((a,b)=> (b.e.ts||0) - (a.e.ts||0));
  const cap = rows.slice(0, 300);
  const sent = rows.filter(r=>r.e.dir==='out').length;
  let html = `<div class="hist-sum">📅 ${sent} mails sendt · ${rows.length-sent} svar — nyeste først</div>`;
  let curDay = null;
  for(const { co, person, e } of cap){
    const day = dayLabel(e.ts);
    if(day !== curDay){ curDay = day; html += `<div class="tl-day">${esc(day)}</div>`; }
    const out = e.dir === 'out';
    const icon = out ? '📤' : (e.auto ? '🤖' : '📨');
    const label = out ? 'Sendt til' : (e.auto ? 'Autosvar fra' : 'Svar fra');
    const time = new Date(e.ts).toLocaleTimeString('da-DK', { hour:'2-digit', minute:'2-digit' });
    const pl = out ? placementChips(e.placements) : '';
    html += `<div class="tl-row ${out?'out':(e.auto?'auto':'in')}" data-company="${esc(co)}">
      <span class="tl-ic">${icon}</span>
      <div class="tl-main">
        <div class="tl-top"><b>${esc(label)} ${esc(person||co)}</b>${person?` · ${esc(co)}`:''}<span class="tl-time">${time}</span></div>
        ${e.subject?`<div class="tl-subj">${esc(e.subject)}</div>`:''}
        ${pl?`<div class="tl-pl">${pl}</div>`:''}
      </div>
    </div>`;
  }
  if(rows.length > cap.length) html += `<div class="hist-more">+${rows.length-cap.length} ældre hændelser</div>`;
  return html;
}
function bindHistRows(){
  document.querySelectorAll('.histtable tr[data-company]').forEach(tr=>{
    const company = tr.dataset.company;
    const open = tr.querySelector('.act-open');
    if(open) open.addEventListener('click', ()=>openContact(company));
  });
}
function openContact(company){
  const c = DATA.contacts.find(x=>x.company===company); if(!c) return;
  curTab = c.temp==='varm' ? 'varm' : 'kold';
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active', x.dataset.tab===curTab));
  $('q').value = company;
  render();
  setTimeout(()=>{ const card=[...document.querySelectorAll('.card')].find(x=>x.dataset.company===company); if(card) card.scrollIntoView({behavior:'smooth',block:'center'}); }, 60);
}
function contactMetaHTML(c){
  const who = [c.person && esc(c.person), c.title && esc(c.title)].filter(Boolean).join(', ');
  const bits = [who, c.email && esc(c.email), c.phone && esc(c.phone)].filter(Boolean);
  return bits.length ? `<div class="cmeta">${bits.join(' · ')}</div>` : '';
}
function guessHTML(c){
  if(!c.companyGuess) return '';
  return `<div class="guesswhy">🔎 <b>Gæt:</b> ${esc(c.companyGuess)}</div>`;
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
  const fuDays = daysSinceTouch(c);
  const fuT = isFu ? fuTier(fuDays, fuCadence(c)) : '';
  let badge;
  if(curTab === 'svar') badge = `<span class="badge reply">💬 ${esc(st)}${r.date?' · '+esc(r.date):''}</span>`;
  else if(isFu){
    const flag = fuT === 'hot' ? '🔴' : '🟠';
    const n = touchCount(c);
    const ord = n>=2 ? `${n}. mail` : '1. mail';
    badge = `<span class="badge due ${fuT}">${flag} ${ord} · ${fuDays} dage siden</span>`;
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
    ${guessHTML(c)}
    ${(isFu && autoReplyNote(c)) ? `<div class="fu-auto">🤖 Autosvar sidst: <span>${esc(autoReplyNote(c))}</span></div>` : ''}
    ${scoreChips(c)}
    ${tagsHTML(c)}
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
      ${hasReply(c.company) ? '<button class="btn small act-reply" title="Generér et svar der besvarer kundens mail">✉️ Besvar mail</button>' : ''}
      <button class="btn small act-draft-toggle">✍️ Skriv mail</button>
      <button class="btn small act-win">🎯 ${openPanel?'Skjul hjælp':'Vind kunden'}</button>
      <span class="when">${r.date ? '· '+r.date : ''}</span>
    </div>
    <div class="winwrap"${openPanel?'':' style="display:none"'}>${winboxHTML(c)}</div>
    <div class="draftwrap" style="display:none">${draftPanelHTML(c)}</div>
  </div>`;
}
const VIEW_TITLES = { dash:'Overblik', kold:'Kolde leads', varm:'Varme leads', opfolg:'Opfølgning', svar:'Svar fra kunder', hist:'Historik', kort:'Placeringskort' };
function render(){
  const vt = $('viewTitle'); if(vt) vt.textContent = VIEW_TITLES[curTab] || '';
  const isDash = curTab === 'dash';
  const isMap = curTab === 'kort';
  const ctrls = document.querySelector('.controls');
  if(ctrls) ctrls.style.display = (isDash||isMap) ? 'none' : '';
  $('bar').style.display = (isDash||isMap) ? 'none' : '';
  $('list').style.display = isMap ? 'none' : '';
  $('mapview').style.display = isMap ? '' : 'none';
  if(isMap){ $('empty').style.display='none'; renderCounts(); showMap(); return; }
  if(isDash){
    $('list').innerHTML = dashboardHTML();
    $('empty').style.display = 'none';
    renderCounts();
    return;
  }
  if(curTab === 'hist'){
    const hq = $('q').value.toLowerCase();
    const toggle = `<div class="hist-modes">`+
      `<button class="hist-mode ${histMode==='timeline'?'active':''}" data-hm="timeline">📅 Tidslinje</button>`+
      `<button class="hist-mode ${histMode==='contacts'?'active':''}" data-hm="contacts">👤 Pr. kunde</button>`+
      `</div>`;
    $('list').innerHTML = toggle + (histMode==='timeline' ? historyTimelineHTML(hq) : historyTableHTML(hq));
    $('empty').style.display = 'none';
    renderCounts();
    document.querySelectorAll('.hist-mode').forEach(b=>b.addEventListener('click', ()=>{ histMode = b.dataset.hm; render(); }));
    if(histMode==='contacts') bindHistRows();
    else document.querySelectorAll('.tl-row[data-company]').forEach(r=>r.addEventListener('click', ()=>openContact(r.dataset.company)));
    renderBar();
    return;
  }
  if(curTab === 'opfolg'){
    populateFilters();
    $('list').innerHTML = followupHTML();
    $('empty').style.display = 'none';
    bindCards();
    renderBar();
    return;
  }
  populateFilters();
  const q = $('q').value.toLowerCase();
  const f = $('fil').value;
  const fb = ($('fbuyer') && $('fbuyer').value) || '';
  const fa = ($('farea') && $('farea').value) || '';
  const ft = ($('ftag') && $('ftag').value) || '';
  const hideRecent = (curTab==='kold'||curTab==='varm') && $('hideSent') && $('hideSent').checked;
  let items = contactsForTab().filter(c=>{
    const hay = (c.company+' '+(c.subject||'')+' '+(c.segment||'')+' '+(c.person||'')+' '+(c.email||'')+' '+areaOf(c)+' '+(c.tags||[]).join(' ')).toLowerCase();
    const st = rec(c.company).status || 'Ikke kontaktet';
    // Hide contacts you've just sent to / followed up (still in the cadence window),
    // so you don't keep seeing the same ones — they return when due for follow-up.
    if(hideRecent && fuWaiting(c)) return false;
    return hay.includes(q) && (!f || st === f) && (!fb || buyerVal(c) === fb)
      && (!fa || areaOf(c) === fa) && (!ft || (c.tags||[]).includes(ft));
  });
  const sort = ($('sort') && $('sort').value) || '';
  if(sort === 'booking') items.sort((a,b)=>bookingScore(b)-bookingScore(a));
  else if(sort === 'money') items.sort((a,b)=>moneyScore(b)-moneyScore(a));
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
      copyText(el('.body',card).textContent, e.target);
      registerSend(company, e.target.dataset.fu === '1');
    });
    const gmail = el('.act-gmail', card);
    if(gmail) gmail.addEventListener('click', ()=>{
      const c = DATA.contacts.find(x=>x.company===company);
      window.open(gmailComposeUrl(c), '_blank');
      registerSend(company, curTab === 'opfolg');
    });
    const sendb = el('.act-send', card);
    if(sendb) sendb.addEventListener('click', e=>{
      const c = DATA.contacts.find(x=>x.company===company);
      const isFu = curTab === 'opfolg';
      const subject = isFu ? c.fuSubject : c.subject;
      const body = isFu ? c.fuBody : c.body;
      const status = statusAfterSend(company, isFu);
      const threadId = (THREADS[company] && THREADS[company].threadId) || (HISTORY[company] && HISTORY[company].threadId) || null;
      const chk = el('.act-attach', card);
      const attachPlacement = (chk && chk.checked && hasMockup(c.placement)) ? c.placement : null;
      sendMail(company, { to:contactEmail(c), subject, body, status, threadId, attachPlacement, scenario: defaultScenario(c) }, e.target);
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

    const replyb = el('.act-reply', card);
    if(replyb) replyb.addEventListener('click', ()=>{
      const w = el('.draftwrap', card);
      w.style.display = '';                       // open the mail panel
      const dt = el('.act-draft-toggle', card); if(dt) dt.textContent = '✍️ Skjul mail';
      const sc = el('.d-scenario', card); if(sc) sc.value = 'reply';   // force "reply" scenario
      generateDrafts(company, card);              // and answer the customer's mail right away
    });

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
  if($('c-hist')) $('c-hist').textContent = '('+Object.values(HISTORY).filter(h=>h&&h.events&&h.events.length).length+')';
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
    const hot = due.filter(c=>fuTier(daysSinceTouch(c), fuCadence(c))==='hot').length;
    const t = followupDays();
    $('bar').innerHTML =
      `<span><b>${due.length}</b> klar til opfølgning · cadence ${t}/${t+3}/${t+6} dage (1./2./sidste touch)</span>`+
      (hot ? `<span class="bar-hot">🔴 <b>${hot}</b> for længe siden — tag dem først</span>` : '');
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

/* ---------- dashboard (overblik) ---------- */
function priceKr(name){ const p = DATA.placements[name]; if(!p) return 0; return parseInt(String(p.price||'').replace(/\D/g,''))||0; }
function fmtKr(n){ return Math.round(n).toLocaleString('da-DK') + ' kr.'; }
const SCEN_LABEL = Object.fromEntries(SCEN);
function scenarioFor(c){ return rec(c.company).scenario || defaultScenario(c); }
function dashboardHTML(){
  const cs = DATA.contacts;
  const statusOf = c => rec(c.company).status || 'Ikke kontaktet';
  const counts = {}; STATUSES.forEach(s=>counts[s]=0);
  cs.forEach(c=>{ counts[statusOf(c)]++; });
  const total = cs.length;
  const contacted = total - counts['Ikke kontaktet'];
  const responded = cs.filter(c=> hasReply(c.company) || statusOf(c)==='Booket').length;
  const booked = counts['Booket'];
  const replyRate = contacted ? Math.round(responded/contacted*100) : 0;
  const bookRate  = contacted ? Math.round(booked/contacted*100) : 0;

  // Pipeline value: open opportunities vs. won.
  const open = new Set(['Sendt','Opfølgning sendt','Svar modtaget']);
  let pipeline=0, wonVal=0;
  cs.forEach(c=>{ const st=statusOf(c), v=priceKr(c.placement);
    if(open.has(st)) pipeline+=v; else if(st==='Booket') wonVal+=v; });

  // Conversion per mail scenario (tracked scenario, else recommended one).
  const scen = {}; SCEN.forEach(([v,l])=>scen[v]={label:l,sent:0,svar:0,book:0});
  cs.forEach(c=>{ const st=statusOf(c); if(st==='Ikke kontaktet') return;
    const s=scenarioFor(c); if(!scen[s]) scen[s]={label:SCEN_LABEL[s]||s,sent:0,svar:0,book:0};
    scen[s].sent++; if(hasReply(c.company)||st==='Booket') scen[s].svar++; if(st==='Booket') scen[s].book++; });
  const scenRows = Object.values(scen).filter(s=>s.sent>0).sort((a,b)=>b.sent-a.sent);

  // Lead scoring summary.
  const hotLeads = cs.filter(c=>bookingScore(c)>=4).length;
  const moneyRated = cs.filter(c=>moneyScore(c)>0);
  const avgMoney = moneyRated.length ? (moneyRated.reduce((s,c)=>s+moneyScore(c),0)/moneyRated.length) : 0;

  const kpi = (num, lbl, sub, cls='') => `<div class="kpi ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div>${sub?`<div class="ksub">${sub}</div>`:''}</div>`;

  const stageMax = Math.max(1, ...STATUSES.map(s=>counts[s]));
  const stageColor = { 'Ikke kontaktet':'#c2c8d2','Sendt':'#5b8def','Opfølgning sendt':'#e0892b','Svar modtaget':'#23a96c','Booket':'#b8860b','Nej tak':'#9aa3b5' };
  const stages = STATUSES.map(s=>{
    const n = counts[s]; const w = Math.round(n/stageMax*100);
    const pct = total ? Math.round(n/total*100) : 0;
    return `<div class="stagerow"><span class="stagelbl">${esc(s)}</span>
      <span class="stagetrack"><span class="stagebar" style="width:${w}%;background:${stageColor[s]}"></span></span>
      <span class="stagenum">${n} <small>· ${pct}%</small></span></div>`;
  }).join('');

  const scenTable = scenRows.length ? `<table class="scentable">
    <thead><tr><th>Scenarie</th><th>Sendt</th><th>Svar</th><th>Booket</th><th>Svar%</th><th>Booket%</th></tr></thead>
    <tbody>${scenRows.map(r=>`<tr>
      <td>${esc(r.label)}</td><td>${r.sent}</td><td>${r.svar}</td><td>${r.book}</td>
      <td><b>${Math.round(r.svar/r.sent*100)}%</b></td><td>${Math.round(r.book/r.sent*100)}%</td>
    </tr>`).join('')}</tbody></table>`
    : '<div class="logempty">Ingen sendte mails endnu — send nogle mails for at se konvertering pr. scenarie.</div>';

  return `<div class="dash">
    <div class="kpis">
      ${kpi(replyRate+'%', 'Svarprocent', `${responded} svar af ${contacted} kontaktet`, 'kpi-green')}
      ${kpi(bookRate+'%', 'Booket-rate', `${booked} booket`, 'kpi-gold')}
      ${kpi(fmtKr(pipeline), 'Pipeline-værdi', 'åbne muligheder (juli)', 'kpi-blue')}
      ${kpi(fmtKr(wonVal), 'Booket-værdi', 'vundet (juli)', 'kpi-gold')}
      ${kpi(contacted+'/'+total, 'Kontaktet', `${counts['Ikke kontaktet']} mangler`)}
      ${kpi('🔥 '+hotLeads, 'Hot leads', '≥4★ booking-sandsynlighed', 'kpi-green')}
      ${kpi(moneyRated.length ? avgMoney.toFixed(1)+'★' : '–', 'Snit-budget', moneyRated.length ? `${moneyRated.length} vurderet af Claude` : 'tryk 💰 Vurder budget', 'kpi-gold')}
    </div>
    <div class="dashgrid">
      <div class="dashcard">
        <div class="dashtitle">Kunder pr. stadie</div>
        <div class="stagebars">${stages}</div>
      </div>
      <div class="dashcard">
        <div class="dashtitle">Konvertering pr. mail-scenarie</div>
        ${scenTable}
        <div class="dashnote">Scenarie = det sendte scenarie (spores ved 📤 Send) eller det anbefalede ud fra segmentet.</div>
      </div>
    </div>
  </div>`;
}

/* ---------- placement map ---------- */
let MAP = null;
function mapPopupHTML(name){
  const p = DATA.placements[name];
  const n = DATA.contacts.filter(c=>c.placement===name).length;
  const img = hasMockup(name) ? `<img class="mappop-img" src="${mockUrl(name)}" alt="">` : '';
  const bits = p.type === 'dooh'
    ? ['📺 Digital DOOH', p.daily && p.daily+'/døgn', p.sov && p.sov+' SOV', p.price && '4 uger '+p.price].filter(Boolean).join(' · ')
    : [p.sqm && p.sqm+' m²', p.impr && p.impr+' eksp./uge', p.price && p.price].filter(Boolean).join(' · ');
  return `<div class="mappop">${img}<b>${esc(name)}</b>`+
    `<div class="mappop-area">${esc(p.area||'')}</div>`+
    (bits?`<div class="mappop-row">${esc(bits)}</div>`:'')+
    (p.period?`<div class="mappop-row">${esc(p.period)}</div>`:'')+
    `<div class="mappop-cnt">${n} kunde${n===1?'':'r'} anbefalet her</div></div>`;
}
function initMap(){
  if(typeof L === 'undefined'){ $('map').innerHTML = '<div class="ai-err" style="padding:16px">Kortet kunne ikke indlæses (ingen forbindelse).</div>'; return; }
  MAP = L.map('map', { scrollWheelZoom:false }).setView([55.69,12.57], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(MAP);
  const pts = [];
  Object.keys(DATA.placements||{}).forEach(name=>{
    const p = DATA.placements[name];
    if(typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
    L.marker([p.lat, p.lng]).addTo(MAP).bindPopup(mapPopupHTML(name));
    pts.push([p.lat, p.lng]);
  });
  if(pts.length) MAP.fitBounds(pts, { padding:[40,40], maxZoom:13 });
}
function showMap(){
  if(!MAP) initMap();
  // Leaflet needs a sized, visible container — recompute after it's shown.
  if(MAP) setTimeout(()=>MAP.invalidateSize(), 60);
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
    await api('/api/login', { method:'POST', body: JSON.stringify({ action:'logout' }) }); location.reload();
  });
  $('btnClassify').addEventListener('click', classifyContacts);
  $('fbuyer').addEventListener('change', render);
  $('farea').addEventListener('change', render);
  $('ftag').addEventListener('change', render);
  $('sort').addEventListener('change', render);
  if($('hideSent')){
    try{ if(localStorage.getItem('hideSent')==='0') $('hideSent').checked = false; }catch(e){}
    $('hideSent').addEventListener('change', e=>{
      try{ localStorage.setItem('hideSent', e.target.checked ? '1' : '0'); }catch(_){}
      render();
    });
  }
  $('btnScore').addEventListener('click', scoreContacts);
  $('btnEnrich').addEventListener('click', enrichContacts);
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
  const { to, subject, body, status, threadId, attachPlacement, scenario } = opts;
  if(!to){ toast('Ingen email på kunden — tilføj en email først (✏️).', false); return; }
  if(!body){ toast('Intet mailudkast at sende — skriv en mail først.', false); return; }
  const attachNote = attachPlacement ? ' (mockup vedhæftes)' : '';
  if(!confirm('Send mailen direkte til '+to+' nu?'+attachNote)) return;
  const o = btn.textContent; btn.disabled = true; btn.textContent = '📤 Sender…';
  try{
    const res = await api('/api/send', { method:'POST', body: JSON.stringify({ company, to, subject, body, status, threadId, attachPlacement, scenario }) });
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
  $('f-money').value   = c && c.moneyScore ? String(c.moneyScore) : '';
  $('f-segment').value = c ? (c.segment||'') : '';
  $('f-tags').value    = c ? (c.tags||[]).join(', ') : '';
  $('f-person').value  = c ? (c.person||'')  : '';
  $('f-title').value   = c ? (c.title||'')   : '';
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
  const tags = $('f-tags').value.split(',').map(s=>s.trim()).filter(Boolean);
  const moneyVal = $('f-money').value;
  const prev = editingCompany ? DATA.contacts.find(x=>x.company===editingCompany) : null;
  const fields = {
    temp:$('f-temp').value, buyer:$('f-buyer').value, placement:$('f-placement').value, segment:$('f-segment').value,
    person:$('f-person').value, title:$('f-title').value, email:$('f-email').value.trim(), phone:$('f-phone').value,
    subject:$('f-subject').value, body:$('f-body').value, tags,
    moneyScore: moneyVal ? Number(moneyVal) : null,
  };
  // Only mark the reason "Manuelt sat" if the budget rating actually changed,
  // so an existing Claude reason survives an unrelated edit.
  if(String((prev && prev.moneyScore) || '') !== moneyVal){
    fields.moneyReason = moneyVal ? 'Manuelt sat' : null;
  }
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

async function scoreContacts(){
  if(!HAS_AI){ toast('AI er slået fra — tilføj ANTHROPIC_API_KEY.', false); return; }
  if(!confirm('Lad Claude vurdere alle kunders budget/match for outdoor (1–5 ⭐)?\n\nDet er et kvalificeret gæt ud fra virksomhedstype + jeres dialog. Du kan rette manuelt bagefter (rediger kunden).')) return;
  const btn = $('btnScore'); if(btn){ btn.disabled=true; btn.textContent='💰 Vurderer…'; }
  toast('💰 Claude vurderer budget for alle dine kunder…', true);
  try{
    const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'scoreMoney' }) });
    if(res.status===401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ toast(j.message || 'Kunne ikke vurdere.', false); return; }
    DATA.contacts = j.contacts; render();
    toast(`💰 Færdig: budget vurderet for ${j.scored} kunder. Sortér på 💰 Budget for at se de bedste.`, true);
  }catch(e){ toast('Netværksfejl.', false); }
  finally{ if($('btnScore')){ $('btnScore').disabled=false; $('btnScore').textContent='💰 Vurder budget'; } }
}
async function enrichContacts(){
  if(!HAS_AI){ toast('AI er slået fra — tilføj ANTHROPIC_API_KEY.', false); return; }
  if(!confirm('Berig kontakterne ud fra jeres mail-dialoger?\n\nClaude udtrækker FAKTA (navn, titel, direkte telefon og e-mail) fra kundernes egne signaturer/mails — og tilføjer et kort, tydeligt markeret GÆT om virksomheden. Eksisterende felter overskrives ikke.')) return;
  const btn = $('btnEnrich'); if(btn){ btn.disabled=true; btn.textContent='🔎 Beriger…'; }
  toast('🔎 Claude beriger kontakter ud fra dialogerne…', true);
  try{
    const res = await api('/api/contacts', { method:'POST', body: JSON.stringify({ action:'enrich' }) });
    if(res.status===401){ showGate(); return; }
    const j = await res.json();
    if(!res.ok){ toast(j.message || 'Kunne ikke berige.', false); return; }
    DATA.contacts = j.contacts; render();
    const c = j.counts || {};
    toast(`🔎 Færdig: udfyldt ${c.person||0} navne · ${c.title||0} titler · ${c.phone||0} tlf · ${c.email||0} e-mails (på ${c.contacts||0} kunder).`, true);
  }catch(e){ toast('Netværksfejl.', false); }
  finally{ if($('btnEnrich')){ $('btnEnrich').disabled=false; $('btnEnrich').textContent='🔎 Berig kontakter'; } }
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
  HISTORY = d.history || {};
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
