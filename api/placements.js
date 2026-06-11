import { requireAuth } from '../lib/auth.js';
import { loadPlacementImage, savePlacementImage, deletePlacementImage, loadImageIndex } from '../lib/placements.js';

function getQuery(req) {
  if (req.query) return req.query;
  try {
    const u = new URL(req.url, 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    const q = getQuery(req);
    // Stream a single placement's mockup so <img src> can render it.
    if (q.img) {
      const rec = await loadPlacementImage(q.img);
      const m = rec && rec.dataUrl ? DATA_URL.exec(rec.dataUrl) : null;
      if (!m) return res.status(404).end();
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Cache-Control', 'private, max-age=120');
      return res.status(200).end(Buffer.from(m[2], 'base64'));
    }
    return res.status(200).json({ withImage: await loadImageIndex() });
  }

  if (req.method === 'POST') {
    const { action, placement, image } = req.body || {};
    if (!placement) return res.status(400).json({ error: 'bad_request' });

    if (action === 'delete') {
      await deletePlacementImage(placement);
      return res.status(200).json({ ok: true, withImage: await loadImageIndex() });
    }

    const dataUrl = image && image.dataUrl;
    const m = dataUrl ? DATA_URL.exec(dataUrl) : null;
    if (!m) return res.status(400).json({ error: 'bad_image', message: 'Ugyldigt billede.' });
    // Guard against blowing past the Upstash request-size limit (~1 MB).
    if (dataUrl.length > 1_300_000) {
      return res.status(413).json({ error: 'too_large', message: 'Billedet er for stort — prøv et mindre.' });
    }
    await savePlacementImage(placement, {
      dataUrl,
      filename: image.filename || 'mockup.jpg',
      mime: m[1],
    });
    return res.status(200).json({ ok: true, withImage: await loadImageIndex() });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}
