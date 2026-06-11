import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { contactByCompany } from '../lib/contacts.js';
import { loadTone, loadLogs } from '../lib/log.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

const SCENARIOS = {
  open:     'ÅBNING / første kontakt — kunden har ikke hørt fra os før. Præsentér dig varmt og kort, og nævn roligt den ledige plads som noget der måske kunne passe dem.',
  reopen:   'GENÅBNING af dialog — vi har haft kontakt før, men der er gået tid. Åbn varmt: "Lang tid siden — håber alt er godt hos jer." Nævn så roligt den ledige plads. Ingen undskyldninger, intet pres.',
  followup: 'OPFØLGNING — vi har skrevet før uden svar. En venlig, afslappet lille opfølgning. Gentag ikke hele mailen — bare et blødt "ville lige høre om det kunne være noget".',
  nudge:    'NUDGE — et let, venligt vink. Helt kort og afslappet. Ingen deadline, intet pres — bare en åben invitation.',
  after_no: 'EFTER ET NEJ — kunden sagde nej før. Vær afslappet og imødekommende, ingen pres overhovedet. Del kort hvad der er ledigt, og lad døren stå åben til senere.',
  close:    'TAG NÆSTE SKRIDT — kunden er varm. Gør det nemt og uforpligtende at gå videre (fx "skal vi tage en kort snak?"). Bliv varm og rolig — ALDRIG pres eller deadline.',
  reply:    'SVAR PÅ KUNDENS BESKED — tag afsæt i hvad de skrev, svar venligt og konkret på deres spørgsmål, og foreslå blødt næste skridt.',
};

function placementBlock(name) {
  const p = DATA.placements[name];
  if (!p) return null;
  const list = parseInt(String(p.list || '').replace(/\D/g, ''));
  const price = parseInt(String(p.price || '').replace(/\D/g, ''));
  const pct = list && price && list > price ? Math.round((1 - price / list) * 100) : null;
  return { name, ...p, pct };
}

const SYSTEM = `Du er tekstforfatter for Sebastian fra Hyde Media (out-of-home facadereklame i København, på Frederiksberg og i Aarhus). Du laver 3 mailudkast til ÉN kunde, så Sebastian kan vælge.

ALLERVIGTIGST — tonen skal være BLØD, varm og afslappet. Sebastian sælger ALDRIG hårdt. Han skriver som en flink fyr der lige rækker ud — ikke en der presser eller "lukker".

GULDSTANDARD (ram præcis denne følelse — varm, rolig, uden pres):
---
Hej Dorthe,

Lang tid siden — håber alt er godt hos jer.

Grunden til jeg skriver: vi har en ledig plads på Nørrebrogade 195 i uge 26+27. Den er 180 m², 385.000+ eksponeringer om ugen, og prisen er 90.000 i stedet for 135.331.

Jeg har vedhæftet vores sommer-oplæg med alle placeringerne i juni & juli.
Er det noget, der kunne passe ind i jeres planer hen over sommeren?

Bedste hilsner
Sebastian
---

GØR:
- Start varmt og personligt. Brug fornavn hvis du har det ("Hej Dorthe,"), ellers "Hej,". Ved genåbning: "Lang tid siden — håber alt er godt hos jer."
- Sig grunden ligefremt: "Grunden til jeg skriver: …"
- HVER variant SKAL selv indeholde tallene i én rolig sætning — brug denne form med de RIGTIGE tal for placeringen: "Den er [m²] m², [eksponeringer]+ eksponeringer om ugen, og prisen er [pris] i stedet for [normalpris]." Skriv tallene DIREKTE i mailen. ALDRIG procenter.
- Nævn gerne (når det passer): "Jeg har vedhæftet vores sommer-oplæg med alle placeringerne i juni & juli."
- Slut med en BLØD, åben invitation: "Er det noget, der kunne passe ind i jeres planer hen over sommeren?" / "Sig endelig til — også hvis det først er aktuelt senere."
- Signatur: "Bedste hilsner" og så "Sebastian".

GØR ALDRIG:
- INGEN knaphed eller pres: ikke "går hurtigt", "first come, first served", "jeg holder pladsen til på fredag", "skal jeg sætte navn på?".
- INGEN procent-rabat ("54% under listepris"), ingen udråbstegn-salg, ingen buzzwords.
- Ingen hårde lukkere som "skal jeg det?". Hold det åbent og uforpligtende.
- ALDRIG udskyde tallene: skriv IKKE "jeg sender/vender gerne tilbage med størrelse, tal, pris eller detaljer hvis det har interesse". Tallene SKAL stå i selve mailen — ligesom i guldstandarden.

De 3 varianter skal alle være BLØDE, men variere let:
1) Varm & personlig — relations-åbneren, tæt på guldstandarden.
2) Kort & rolig — endnu kortere, stadig venlig, ren fakta uden pynt.
3) Synlighed, blødt — fremhæv eksponeringen/placeringen lidt mere, men stadig roligt og uden pres.

Selv ved "tag næste skridt" forbliver du varm og uforpligtende — en mild invitation, aldrig pres. Match sproget (dansk/engelsk). Hold mails korte (5-9 linjer).

Svar i PRÆCIS dette format — intet andet, ingen indledning:

###VARIANT###
ANGLE: <kort vinkel-navn, fx "Kort & direkte">
SUBJECT: <emnelinje>
BODY:
<brødtekst med linjeskift, inkl. "Bedste hilsner / Best" + Sebastian>
###END###
###VARIANT###
ANGLE: ...
SUBJECT: ...
BODY:
...
###END###
###VARIANT###
ANGLE: ...
SUBJECT: ...
BODY:
...
###END###`;

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_disabled', message: 'ANTHROPIC_API_KEY er ikke sat.' });
  }

  const body = req.body || {};
  const contact = body.company ? await contactByCompany(body.company) : null;
  if (!contact) return res.status(404).json({ error: 'unknown_company' });

  const scenarioKey = SCENARIOS[body.scenario] ? body.scenario : 'open';
  const lang = body.lang === 'en' ? 'en' : 'da';
  const placName = body.placement || contact.placement;
  const pl = placementBlock(placName);

  const [tone, logs] = await Promise.all([loadTone(), loadLogs()]);
  const toneExamples = tone.slice(-6).map((e, i) => `${i + 1}. ${e.text}`).join('\n\n');
  const dialogue = (logs[contact.company] || [])
    .map((e) => `${e.who === 'kunde' ? 'Kunde' : 'Sebastian'}: ${e.text}`)
    .join('\n');

  const userMsg = [
    `Kunde: ${contact.company}${contact.person ? ' (kontakt: ' + contact.person + ')' : ''}`,
    `Temperatur: ${contact.temp === 'varm' ? 'varm (tidligere relation)' : 'kold'}`,
    `Sprog: ${lang === 'en' ? 'ENGELSK' : 'DANSK'}`,
    '',
    `SCENARIE: ${SCENARIOS[scenarioKey]}`,
    '',
    pl
      ? `PLACERING: ${pl.name} (${pl.area}) — ${pl.sqm} m², ${pl.impr} eksponeringer/uge, late sale ${pl.price}${pl.list ? ' mod normalt ' + pl.list : ''}${pl.pct ? ' (~' + pl.pct + '% under listepris)' : ''}, periode ${pl.period}.`
      : `PLACERING: ${placName} (ingen detaljer — hold pris/tal ude).`,
    dialogue && scenarioKey === 'reply' ? `\nHIDTIDIG DIALOG (svar konkret på kundens seneste):\n${dialogue}` : '',
    toneExamples ? `\nSEBASTIANS EGNE BESKEDER (match denne tone):\n${toneExamples}` : '',
    '',
    'Lav de 3 varianter nu.',
  ].filter(Boolean).join('\n');

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2600,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const variants = parseVariants(text);
    if (!variants.length) return res.status(502).json({ error: 'parse_failed', message: 'Kunne ikke tolke svaret.' });
    return res.status(200).json({ ok: true, variants, placement: placName, scenario: scenarioKey });
  } catch (err) {
    console.error('draft error', err?.status, err?.message);
    return res.status(err?.status === 401 ? 401 : 502).json({ error: 'ai_error', message: 'Kunne ikke generere udkast lige nu.' });
  }
}

function parseVariants(text) {
  const parts = String(text).split(/###\s*VARIANT\s*###/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const angle = (part.match(/ANGLE:\s*(.+)/i) || [])[1]?.trim() || 'Forslag';
    const subject = (part.match(/SUBJECT:\s*(.+)/i) || [])[1]?.trim() || '';
    const bm = part.match(/BODY:\s*([\s\S]*?)(?:###\s*END\s*###|$)/i);
    const body = (bm ? bm[1] : '').replace(/###\s*END\s*###/gi, '').trim();
    if (subject || body) out.push({ angle, subject, body });
  }
  return out.slice(0, 3);
}
