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

// Full conversation: every message in a thread, oldest first, with body + headers.
export async function getThread(token, threadId) {
  const r = await fetch(`${API}/threads/${threadId}?format=full`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('gmail_thread:' + r.status);
  const j = await r.json();
  return (j.messages || [])
    .map((m) => {
      const headers = {};
      (m.payload?.headers || []).forEach((h) => { headers[h.name.toLowerCase()] = h.value; });
      return { id: m.id, date: Number(m.internalDate) || 0, headers, snippet: decodeEntities(m.snippet || ''), body: extractBody(m.payload) };
    })
    .sort((a, b) => a.date - b.date);
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

// Display name from a From header: '"Pernille Hansen" <p@x.dk>' -> 'Pernille Hansen'.
// Returns '' when the header carries only a bare address.
export function parseFromName(headers) {
  const f = String(headers.from || '').trim();
  if (!f) return '';
  const lt = f.indexOf('<');
  let name = lt > 0 ? f.slice(0, lt) : '';
  name = name.replace(/^["']|["']$/g, '').replace(/["']/g, '').trim();
  // A "name" that is actually the email address is not a name.
  if (!name || name.includes('@')) return '';
  return name;
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

// Wrap base64 at 76 chars so the MIME body stays standards-friendly.
function b64wrap(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

// Build + send a UTF-8 mail via the Gmail API. Pass threadId to keep a reply
// in the same conversation, and attachments [{filename, mime, base64}] to
// attach files (e.g. a placement mockup) as a multipart/mixed message.
export async function sendMessage(token, { to, subject, body, threadId, attachments } = {}) {
  const bodyB64 = b64wrap(Buffer.from(String(body || ''), 'utf8'));
  const head = [`To: ${to}`, `Subject: ${encodeSubject(subject)}`, 'MIME-Version: 1.0'];
  let mime;
  if (attachments && attachments.length) {
    const boundary = 'hyde_boundary_' + Buffer.from(String(to) + '|' + subject).toString('hex').slice(0, 20);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
    ];
    for (const a of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${a.mime || 'application/octet-stream'}; name="${a.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${a.filename}"`,
        '',
        String(a.base64 || '').replace(/(.{76})/g, '$1\r\n'),
      );
    }
    parts.push(`--${boundary}--`);
    mime = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', parts.join('\r\n')].join('\r\n');
  } else {
    mime = [...head, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', bodyB64].join('\r\n');
  }
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
