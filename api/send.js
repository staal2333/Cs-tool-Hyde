import { requireAuth } from '../lib/auth.js';
import { getAccessToken } from '../lib/google.js';
import { sendMessage } from '../lib/gmail.js';
import { contactByCompany } from '../lib/contacts.js';
import { applyPatch } from '../lib/state.js';
import { appendLog } from '../lib/log.js';
import { loadPlacementImage } from '../lib/placements.js';

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;

function todayDK() {
  return new Date().toLocaleDateString('da-DK');
}

// One-click send: deliver the draft through Gmail, then set status + date
// server-side so the change is authoritative (the mail really went out).
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { company, to, subject, body, threadId, status, attachPlacement, scenario } = req.body || {};
  if (!company || !to || !body) {
    return res.status(400).json({ error: 'bad_request', message: 'Mangler modtager, emne eller tekst.' });
  }

  const contact = await contactByCompany(company);
  if (!contact) return res.status(404).json({ error: 'unknown_company' });

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return res.status(409).json({ error: 'not_connected', message: 'Gmail er ikke forbundet. Tryk “Forbind Gmail”.' });
  }

  // Optionally attach the placement's mockup image.
  let attachments;
  if (attachPlacement) {
    const img = await loadPlacementImage(attachPlacement);
    const m = img && img.dataUrl ? DATA_URL.exec(img.dataUrl) : null;
    if (m) attachments = [{ filename: img.filename || 'mockup.jpg', mime: m[1], base64: m[2] }];
  }

  try {
    await sendMessage(token, { to, subject, body, threadId, attachments });
  } catch (err) {
    console.error('send error', err?.status, err?.detail);
    if (err?.status === 403) {
      return res.status(403).json({
        error: 'insufficient_scope',
        message: 'Gmail mangler tilladelse til at sende. Tryk “Forbind Gmail” igen for at give send-adgang.',
      });
    }
    return res.status(502).json({ error: 'send_failed', message: 'Kunne ikke sende mailen lige nu.' });
  }

  const newStatus = status || 'Sendt';
  const patch = { status: newStatus, date: todayDK() };
  if (scenario) patch.scenario = scenario; // tracked for per-scenario conversion stats
  const rec = await applyPatch(company, patch);
  // Log the outgoing mail so it feeds dialogue history + tone learning.
  try { await appendLog(company, 'mig', String(body).slice(0, 1500)); } catch {}

  return res.status(200).json({ ok: true, company, rec });
}
