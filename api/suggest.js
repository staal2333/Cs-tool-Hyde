import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { DATA, contactByCompany, placementFor } from '../lib/data.js';
import { loadLogs, loadTone } from '../lib/log.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

function placementsOverview() {
  const p = DATA.placements || {};
  return Object.entries(p)
    .map(([name, d]) => {
      const bits = [
        d.area && `område: ${d.area}`,
        d.sqm && `${d.sqm} m²`,
        d.impr && `${d.impr} eksponeringer/uge`,
        d.price && `late sale-pris: ${d.price}`,
        d.list && `listepris: ${d.list}`,
        d.period && `periode: ${d.period}`,
      ].filter(Boolean);
      return `- ${name} (${bits.join(', ')})`;
    })
    .join('\n');
}

// Stable across requests → good cache prefix.
const SYSTEM = `Du er en skarp B2B-salgssparringspartner for Hyde Media, et dansk out-of-home/DOOH-mediebureau, der sælger storformat-facadereklame (bannere/wraps) på attraktive adresser i København og på Frederiksberg.

Sælgeren hedder Sebastian. Han laver kold og varm outreach til marketing-/brand-ansvarlige og vil have konkrete, handlingsorienterede forslag til at vinde den enkelte kunde — ikke generiske floskler.

Aktuelle placeringer (sommerkampagne):
${placementsOverview()}

Sådan svarer du ALTID:
- Skriv kort, konkret og på dansk. Ingen indledning, ingen disclaimers.
- Tag udgangspunkt i netop denne kundes branche, segment-status og den anbefalede placering.
- Brug "late sale"-vinklen (rabat ift. listepris) og synlighed/eksponering som løftestang, når det giver mening.
- Vær ærlig om realistiske indvendinger og hvordan de håndteres.
- Hvis du får eksempler på Sebastians egne tidligere beskeder, så MATCH hans tone, ordvalg, længde og signatur. Han skriver varmt, direkte og uformelt.
- Hvis du får en hidtidig dialog inkl. kundens svar, så tag højde for den og foreslå konkret, hvad Sebastian skal svare nu.

Svar i præcis dette format (brug Markdown):

**Vinkel:** <én sætning der rammer netop denne kunde>

**Gør sådan her:**
- <konkret handling 1>
- <konkret handling 2>
- <konkret handling 3>
(3-5 punkter i alt, prioriteret)

**Mulig indvending:** <den mest sandsynlige indvending> → <kort svar på den>

**Forslag til svar:** "<en færdig besked Sebastian kan sende — matcher hans tone; svarer direkte på kundens seneste svar hvis der er et>"`;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'ai_disabled',
      message: 'ANTHROPIC_API_KEY er ikke sat. Tilføj den i Vercel for at aktivere AI-forslag.',
    });
  }

  const body = req.body || {};
  const company = body.company;
  const contact = company ? contactByCompany(company) : null;
  if (!contact) return res.status(404).json({ error: 'unknown_company' });

  const pl = placementFor(contact);
  const status = body.status || 'Ikke kontaktet';
  const daysSince = Number.isFinite(body.daysSince) ? body.daysSince : null;

  // Learning context: this contact's dialogue + Sebastian's tone examples.
  const [logs, tone] = await Promise.all([loadLogs(), loadTone()]);
  const dialogue = (logs[company] || [])
    .map((e) => `${e.who === 'kunde' ? 'Kunde' : 'Sebastian'}: ${e.text}`)
    .join('\n');
  const toneExamples = tone
    .slice(-6)
    .map((e, i) => `${i + 1}. ${e.text}`)
    .join('\n\n');

  const userMsg = [
    `Kunde: ${contact.company}`,
    `Temperatur: ${contact.temp === 'varm' ? 'varm (har haft kontakt før)' : 'kold'}`,
    `Segment / type: ${contact.segment || '—'}`,
    `Anbefalet placering: ${contact.placement || '—'}`,
    pl
      ? `Placeringsdata: ${[
          pl.area && `område ${pl.area}`,
          pl.sqm && `${pl.sqm} m²`,
          pl.impr && `${pl.impr} eksponeringer/uge`,
          pl.price && `late sale ${pl.price}`,
          pl.list && `normalt ${pl.list}`,
          pl.period && pl.period,
        ]
          .filter(Boolean)
          .join(', ')}`
      : null,
    `Nuværende status: ${status}`,
    daysSince != null ? `Sendt for ${daysSince} dage siden uden svar.` : null,
    dialogue ? `\nHidtidig dialog:\n${dialogue}` : null,
    toneExamples ? `\nSebastians egne tidligere beskeder (match denne tone):\n${toneExamples}` : null,
    '',
    'Giv mig konkrete forslag til at vinde denne kunde.',
  ]
    .filter((x) => x !== null)
    .join('\n');

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    });

    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ ok: true, company, text, model: MODEL });
  } catch (err) {
    console.error('suggest error', err?.status, err?.message);
    const status = err?.status === 401 ? 401 : 502;
    return res.status(status).json({
      error: 'ai_error',
      message: err?.status === 401 ? 'Ugyldig ANTHROPIC_API_KEY.' : 'Kunne ikke hente AI-forslag lige nu.',
    });
  }
}
