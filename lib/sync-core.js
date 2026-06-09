// Pure (no-network) helpers for Gmail sync — unit-testable.

const AUTO_SUBJECT = /^(automatic reply|auto[\s-]?svar|autosvar|out of office|absence|automatisk svar|automatis(k|ke) svar|réponse automatique|abwesenheit)/i;
const AUTO_SNIPPET = /(out of office|ikke på kontoret|holder ferie|på ferie|on (vacation|leave|holiday)|maternity leave|barsel|er tilbage|will be back|back on|automatisk svar|no longer working|har begrænset adgang)/i;

// Headers Gmail may expose that mark machine-generated mail.
export function isAutoReply({ subject = '', snippet = '', headers = {} }) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  if (h['auto-submitted'] && /auto-(replied|generated)/i.test(h['auto-submitted'])) return true;
  if (h['x-autoreply'] || h['x-autorespond'] || h['precedence'] === 'auto_reply') return true;
  if (AUTO_SUBJECT.test(subject.trim())) return true;
  // Subject + body both look like an absence note.
  if (AUTO_SNIPPET.test(snippet) && /\b(reply|svar|office|kontor|ferie|tilbage|back|absence|barsel)\b/i.test(subject + ' ' + snippet)) {
    // Avoid flagging a genuine reply that merely mentions a holiday in passing:
    // require the auto pattern to dominate (short snippet or explicit "automatic").
    if (AUTO_SUBJECT.test(subject) || snippet.length < 320) return true;
  }
  return false;
}

const STOP = new Set(['as','aps','plc','group','danmark','denmark','international','holding','the','co','company','gruppen','gruppe','dk','com','a/s']);

export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' og ')
    .replace(/[æ]/g, 'ae').replace(/[ø]/g, 'oe').replace(/[å]/g, 'aa')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .join('');
}

// Second-level domain label, e.g. "mail.power.co.uk" -> "power".
export function domainRoot(email) {
  const at = String(email || '').toLowerCase().split('@');
  const host = (at[1] || at[0] || '').trim();
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const twoLevelTld = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  let i = parts.length - 2;
  if (twoLevelTld.has(parts[parts.length - 2]) && parts.length >= 3) i = parts.length - 3;
  return parts[i] || '';
}

// Generic mailbox/agency domains we should never match to a brand by name.
const GENERIC = new Set(['gmail','outlook','hotmail','yahoo','icloud','live','me','protonmail','dentsu','omd','omc','groupm','mediacom','wavemaker','mindshare','initiative','kunde','google','microsoft']);

// Match a reply's sender to a company. Returns {company, how} or null.
export function matchCompany(email, companies, metaMap = {}) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr) return null;

  // 1) exact stored email / domain override
  for (const [company, meta] of Object.entries(metaMap)) {
    if (meta?.email && meta.email.toLowerCase() === addr) return { company, how: 'email' };
    if (meta?.domain && addr.endsWith('@' + meta.domain.toLowerCase())) return { company, how: 'domain-override' };
  }

  const root = domainRoot(addr);
  if (!root || root.length < 3 || GENERIC.has(root)) return null;

  // 2) fuzzy: domain root vs normalized company name (inclusion, length-guarded)
  let best = null;
  for (const c of companies) {
    const n = normName(c.company);
    if (!n) continue;
    if (n === root) return { company: c.company, how: 'domain-exact' };
    const short = root.length <= n.length ? root : n;
    const long = root.length <= n.length ? n : root;
    if (short.length >= 4 && long.includes(short)) {
      const score = short.length / long.length;
      if (!best || score > best.score) best = { company: c.company, how: 'domain-fuzzy', score };
    }
  }
  return best ? { company: best.company, how: best.how } : null;
}
