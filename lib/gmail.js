const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function searchMessages(token, q, max = 120) {
  const ids = [];
  let page = '';
  while (ids.length < max) {
    const u = new URL(API + '/messages');
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', String(Math.min(100, max - ids.length)));
    if (page) u.searchParams.set('pageToken', page);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('gmail_list:' + r.status);
    const j = await r.json();
    (j.messages || []).forEach((m) => ids.push(m.id));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return ids;
}

function b64(s) {
  return Buffer.from((s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  let plain = '';
  let html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) plain += b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  const t = plain || html.replace(/<[^>]+>/g, ' ');
  return t.replace(/\r/g, '').replace(/ /g, ' ').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/ /g, ' ');
}

const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond'];

export async function getMessage(token, id, format = 'full') {
  let url = `${API}/messages/${id}?format=${format}`;
  if (format === 'metadata') {
    for (const h of META_HEADERS) url += `&metadataHeaders=${encodeURIComponent(h)}`;
  }
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('gmail_get:' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
  const m = await r.json();
  const headers = {};
  (m.payload?.headers || []).forEach((h) => { headers[h.name.toLowerCase()] = h.value; });
  return {
    id: m.id,
    threadId: m.threadId,
    snippet: decodeEntities(m.snippet || ''),
    headers,
    date: Number(m.internalDate) || 0,
    body: extractBody(m.payload),
    labelIds: m.labelIds || [],
  };
}

// Fetch many messages concurrently in bounded chunks (Gmail-friendly).
export async function fetchMessages(token, ids, format = 'metadata', concurrency = 12) {
  const out = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const res = await Promise.all(chunk.map((id) => getMessage(token, id, format).catch(() => null)));
    for (const m of res) if (m) out.push(m);
  }
  return out;
}

export function parseFrom(headers) {
  const f = headers.from || '';
  const m = f.match(/<([^>]+)>/);
  return (m ? m[1] : f).trim().toLowerCase();
}

export function parseRecipients(headers) {
  const out = [];
  for (const k of ['to', 'cc']) {
    const v = headers[k];
    if (!v) continue;
    v.split(',').forEach((part) => {
      const m = part.match(/<([^>]+)>/);
      const addr = (m ? m[1] : part).trim().toLowerCase();
      if (addr) out.push(addr);
    });
  }
  return out;
}

// RFC 2047 encoded-word so Danish characters survive in the Subject header.
function encodeSubject(s) {
  return '=?UTF-8?B?' + Buffer.from(String(s || ''), 'utf8').toString('base64') + '?=';
}

// Build + send a plain-text UTF-8 mail via the Gmail API.
// Pass threadId to keep a reply in the same conversation.
export async function sendMessage(token, { to, subject, body, threadId } = {}) {
  const b64body = Buffer.from(String(body || ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n'); // wrap so the MIME body stays standards-friendly
  const mime = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64body,
  ].join('\r\n');
  const raw = Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = threadId ? { raw, threadId } : { raw };
  const r = await fetch(API + '/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    const err = new Error('gmail_send:' + r.status);
    err.status = r.status;
    err.detail = detail.slice(0, 200);
    throw err;
  }
  return r.json();
}
