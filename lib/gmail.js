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

export async function getMessage(token, id) {
  const r = await fetch(`${API}/messages/${id}?format=full`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error('gmail_get:' + r.status);
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
