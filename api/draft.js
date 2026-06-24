import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../lib/auth.js';
import { DATA } from '../lib/data.js';
import { contactByCompany } from '../lib/contacts.js';
import { loadTone, loadLogs } from '../lib/log.js';
import { loadHistory } from '../lib/sync.js';
import { getAccessToken } from '../lib/google.js';
import { getThread } from '../lib/gmail.js';

// Sebastian's own address(es) — used to label who wrote each message in a thread.
const SELF_DOMAIN = /hydemedia\.dk/i;

// Strip quoted history / signatures-of-prior-mails so each turn reads cleanly.
function cleanMail(t) {
  if (!t) return '';
  const out = [];
  for (const ln of String(t).split('\n')) {
    if (/^\s*>/.test(ln)) break;
    if (/^\s*(On .+wrote:|Den .+skrev:|Fra:\s|From:\s|-{3,}\s*Original|Sendt fra min|Get Outlook)/i.test(ln)) break;
    out.push(ln);
  }
  return out.join('\n').trim();
}

// Pull the real Gmail thread into a clean transcript the model can reply to.
async function threadTranscript(threadId) {
  if (!threadId) return null;
  let token;
  try { token = await getAccessToken(); } catch { return null; }
  let msgs;
  try { msgs = await getThread(token, threadId); } catch { return null; }
  const turns = [];
  for (const m of msgs) {
    const who = SELF_DOMAIN.test(m.headers.from || '') ? 'Sebastian' : 'Kunde';
    const text = cleanMail(m.body || m.snippet);
    if (text) turns.push({ who, text: text.slice(0, 2000) });
  }
  return turns.length ? turns : null;
}

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

// How the media-buying setup shifts WHAT we emphasise (tone stays soft/warm).
const BUYER_ANGLE = {
  bureau: 'Køber via MEDIEBUREAU — modtageren tænker som indkøber. Læg (blødt) vægt på det kommercielle: hele måneden til prisen for kun 2 uger, eksponeringer/rækkevidde, fleksibilitet, og at det er nemt at regne på. Spar på brand-poesien.',
  selv: 'Står SELV for medieindkøb (brand in-house) — modtageren tænker brand. Læg (blødt) vægt på synlighed, hvordan placeringen klæder netop deres brand, og sommer-eksponeringen. Tallene er stadig med, men vinklen er brand/synlighed frem for indkøbs-jargon.',
};

function placementBlock(name) {
  const want = String(name || '').normalize('NFC');
  let key = name;
  let p = DATA.placements[name];
  if (!p) {
    for (const k of Object.keys(DATA.placements)) {
      if (k.normalize('NFC') === want) { p = DATA.placements[k]; key = k; break; }
    }
  }
  if (!p) return null;
  name = key;
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

Grunden til jeg skriver: vi har en ledig plads på Nørrebrogade 195 hele juli. Den er 180 m², 385.000+ eksponeringer om ugen, og hele juli koster 135.331 — prisen for kun 2 uger.

Jeg har vedhæftet vores sommer-oplæg med alle placeringerne i juni & juli.
Er det noget, der kunne passe ind i jeres planer hen over sommeren?

Bedste hilsner
Sebastian
---

GØR:
- Start varmt og personligt. Brug fornavn hvis du har det ("Hej Dorthe,"), ellers "Hej,". Ved genåbning: "Lang tid siden — håber alt er godt hos jer."
- Sig grunden ligefremt: "Grunden til jeg skriver: …"
- HVER variant SKAL selv indeholde tallene i én rolig sætning — brug denne form med de RIGTIGE tal for placeringen: "Den er [m²] m², [eksponeringer]+ eksponeringer om ugen, og hele juli koster [pris] — prisen for kun 2 uger." Skriv tallene DIREKTE i mailen. ALDRIG procenter.
- Nævn gerne (når det passer): "Jeg har vedhæftet vores sommer-oplæg med alle placeringerne i juni & juli."
- Slut med en BLØD, åben invitation: "Er det noget, der kunne passe ind i jeres planer hen over sommeren?" / "Sig endelig til — også hvis det først er aktuelt senere."
- Signatur: "Bedste hilsner" og så "Sebastian".

GØR ALDRIG:
- INGEN knaphed eller pres: ikke "går hurtigt", "first come, first served", "jeg holder pladsen til på fredag", "skal jeg sætte navn på?".
- INGEN procent-rabat ("54% under listepris"), ingen udråbstegn-salg, ingen buzzwords.
- Ingen hårde lukkere som "skal jeg det?". Hold det åbent og uforpligtende.
- ALDRIG udskyde tallene: skriv IKKE "jeg sender/vender gerne tilbage med størrelse, tal, pris eller detaljer hvis det har interesse". Tallene SKAL stå i selve mailen — ligesom i guldstandarden.
- Henvis ALDRIG tallene til oplægget: skriv IKKE "jeg har vedhæftet oplægget med detaljerne / tallene / størrelse, eksponeringer og pris". Oplægget må KUN nævnes som "vores sommer-oplæg med alle placeringerne i juni & juli". Tallene for DENNE plads SKAL stå som tekst i mailen — i sætningen ovenfor.

De 3 varianter skal alle være BLØDE, men variere let:
1) Varm & personlig — relations-åbneren, tæt på guldstandarden.
2) Kort & rolig — endnu kortere, stadig venlig, ren fakta uden pynt.
3) Synlighed, blødt — fremhæv eksponeringen/placeringen lidt mere, men stadig roligt og uden pres.

Selv ved "tag næste skridt" forbliver du varm og uforpligtende — en mild invitation, aldrig pres. Match sproget (dansk/engelsk). Hold mails korte (5-9 linjer).

Hvis der står "VINKEL (medieindkøb)", så tilpas HVAD du fremhæver derefter — men behold den bløde, varme tone og guldstandard-strukturen helt uændret. Det er kun fokus der skifter, ikke stilen eller presniveauet.

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
  const isReply = scenarioKey === 'reply';
  const lang = body.lang === 'en' ? 'en' : 'da';
  const placName = body.placement || contact.placement;
  const pl = placementBlock(placName);

  // Build the exact "numbers" sentence from real data so the model can't dodge it.
  const stripKr = (s) => String(s || '').replace(/\s*kr\.?\s*$/i, '').trim();
  const imprFmt = (s) => String(s || '').replace('K+', '.000+').replace('K', '.000');
  const isDooh = pl && pl.type === 'dooh';

  // For digital DOOH screens the figures, the offer and the whole tone differ
  // from facade banners — we override the banner rules with a launch-offer block.
  // (Skipped when replying: a reply must answer the mail, not pitch the screen.)
  let doohBrief = null;
  if (isDooh && !isReply) {
    const vid = pl.video || '';
    doohBrief = lang === 'en'
      ? `\n⚠️ THIS PLACEMENT IS A DIGITAL DOOH SCREEN — NOT a facade banner. IGNORE the "whole of July … the price of just two weeks" line and the "m² / impressions a week" sentence above. Follow EXACTLY this launch-offer template and tone instead.\n\nGOLD STANDARD (DOOH) — match this feeling precisely:\n---\nHi [first name],\n\nWe've just secured a new placement on the corner of Gothersgade and Grønnegade — right in the heart of Copenhagen. It's a digital screen (DOOH) at eye level with 40,000 passers-by a day from both streets, and it goes live Monday 6 July.\n\nTo mark the launch we're offering the first 8 advertisers on the screen 4 weeks for the price of 1, at 12% share of voice.\n\nWe've made an AI-generated video showing the screen and how an ad could look — see it here: ${vid}\n\nPrices, traffic figures and other practical info are in the attached document.\n\nCould this be of interest to you in weeks 28–31?\n\nBest\nSebastian\n---\n\nDOOH RULES (these OVERRIDE the banner rules above):\n- EVERY variant MUST mention: the new digital screen on the corner of Gothersgade & Grønnegade, ~40,000 passers-by a day, live Monday 6 July, the offer "the first 8 advertisers get 4 weeks for the price of 1 at 12% share of voice", the video link (${vid}), and weeks 28–31.\n- Here you MAY point prices/traffic figures to the attached document — that is intended; do NOT invent exact kr. figures in the body.\n- Keep the soft, warm, no-pressure tone and the "Best / Sebastian" signature.`
      : `\n⚠️ DENNE PLACERING ER EN DIGITAL DOOH-SKÆRM — IKKE et facadebanner. SE BORT FRA "hele juli koster X — prisen for kun 2 uger" og fra "m² / eksponeringer om ugen"-sætningen ovenfor. Følg i stedet PRÆCIS denne lancerings-skabelon og tone.\n\nGULDSTANDARD (DOOH) — ram præcis denne følelse:\n---\nHej [fornavn],\n\nVi har netop fået en ny placering på hjørnet af Gothersgade og Grønnegade — midt i hjertet af København. Det er en digital skærm (DOOH) i øjenhøjde med 40.000 forbipasserende i døgnet fra begge gader, og den går live mandag den 6. juli.\n\nI den anledning tilbyder vi de første 8 annoncører på skærmen at booke 4 uger til 1 uges pris, ved 12% share of voice.\n\nVi har lavet en AI-genereret video, der illustrerer skærmen og hvordan en reklame kunne se ud — se den her: ${vid}\n\nPriser, trafiktal og øvrig praktisk info finder du i det vedhæftede dokument.\n\nKunne det være interessant for jer i uge 28–31?\n\nBedste hilsner\nSebastian\n---\n\nDOOH-REGLER (overstyrer banner-reglerne ovenfor):\n- HVER variant SKAL nævne: den nye digitale skærm på hjørnet af Gothersgade og Grønnegade, ~40.000 forbipasserende i døgnet, live mandag 6. juli, tilbuddet "de første 8 annoncører booker 4 uger til 1 uges pris ved 12% share of voice", videolinket (${vid}), og perioden uge 28–31.\n- Her MÅ du gerne henvise priser/trafiktal til det vedhæftede dokument — det er meningen; opfind IKKE eksakte kr.-tal i brødteksten.\n- Behold den bløde, varme, uforpligtende tone og signaturen "Bedste hilsner / Sebastian".`;
  }

  let numbersSentence = null;
  if (pl && pl.sqm && !isDooh && !isReply) {
    const price = stripKr(pl.price), list = stripKr(pl.list);
    numbersSentence = lang === 'en'
      ? `It's ${pl.sqm} m², ${imprFmt(pl.impr)} impressions a week, and the whole of July is ${price} — the price of just two weeks.`
      : `Den er ${pl.sqm} m², ${imprFmt(pl.impr)} eksponeringer om ugen, og hele juli koster ${price} — prisen for kun 2 uger.`;
  }

  const [tone, logs, history] = await Promise.all([loadTone(), loadLogs(), loadHistory()]);
  const toneExamples = tone.slice(-6).map((e, i) => `${i + 1}. ${e.text}`).join('\n\n');

  // Prefer the REAL Gmail thread (full back-and-forth) over the partial log, so a
  // reply is grounded in the actual conversation — including mails sent in Gmail.
  let turns = (logs[contact.company] || []).map((e) => ({ who: e.who === 'kunde' ? 'Kunde' : 'Sebastian', text: e.text }));
  if (isReply) {
    const threadId = history[contact.company]?.threadId;
    const fromThread = await threadTranscript(threadId);
    if (fromThread && fromThread.length) turns = fromThread; // the full thread wins
  }
  const dialogue = turns.map((e) => `${e.who}: ${e.text}`).join('\n');
  const lastKunde = [...turns].reverse().find((e) => e.who === 'Kunde');

  // When replying, override the outreach template entirely: answer the mail.
  let replyBrief = null;
  if (isReply) {
    const placeInfo = pl
      ? (isDooh
          ? `${pl.name}: digital DOOH-skærm, ~${pl.daily} forbipasserende/døgn, lanceringstilbud 4 uger til 1 uges pris (${pl.price}), ${pl.period}.`
          : `${pl.name} (${pl.area}): ${pl.sqm} m², ${imprFmt(pl.impr)} eksponeringer/uge, hele juli ${stripKr(pl.price)} kr. (prisen for 2 uger).`)
      : '';
    replyBrief = lang === 'en'
      ? `\n⚠️ THIS IS A REPLY TO THE CUSTOMER'S EMAIL — NOT a new sales mail. IGNORE the outreach gold standard ("we have a placement available…") and the required numbers sentence.\n\nWrite a reply that:\n- Reads the customer's latest message carefully and ANSWERS exactly what they wrote/asked — point by point.\n- Is warm, helpful and human, in Sebastian's tone. No pressure, no boilerplate.\n- Only brings up price / placement / figures IF the customer asked or it's the natural answer. Facts you may use if relevant: ${placeInfo || '(none)'}\n- If you don't know something the customer asks, say you'll check and come back — never invent details.\n- Suggests a soft next step when it fits (a short call, sending the deck, holding a spot).\n- Ends with "Best / Sebastian".\n\nTHE CUSTOMER'S LATEST MESSAGE (answer THIS precisely):\n"""${(lastKunde && lastKunde.text) || (dialogue || '(no message text found — base it on the dialogue)')}"""`
      : `\n⚠️ DETTE ER ET SVAR PÅ KUNDENS MAIL — ikke en ny salgsmail. SE BORT FRA outreach-guldstandarden ("vi har en ledig plads…") og fra kravet om tal-sætningen.\n\nSkriv et svar der:\n- Læser kundens seneste besked grundigt og BESVARER præcis det, de skriver/spørger om — punkt for punkt.\n- Er varmt, hjælpsomt og menneskeligt, i Sebastians tone. Ingen pres, ingen skabelon-floskler.\n- Kun nævner pris / placering / tal HVIS kunden spørger til det, eller det er det naturlige svar. Fakta du må bruge hvis relevant: ${placeInfo || '(ingen)'}\n- Hvis kunden spørger om noget du ikke ved, så skriv at du lige tjekker og vender tilbage — opfind ALDRIG detaljer.\n- Foreslår blødt næste skridt når det passer (en kort snak, sende oplæg, holde en plads).\n- Slutter med "Bedste hilsner / Sebastian".\n\nKUNDENS SENESTE BESKED (besvar PRÆCIS denne):\n"""${(lastKunde && lastKunde.text) || (dialogue || '(ingen beskedtekst fundet — tag afsæt i dialogen)')}"""`;
  }

  const userMsg = [
    `Kunde: ${contact.company}${contact.person ? ' (kontakt: ' + contact.person + ')' : ''}`,
    `Temperatur: ${contact.temp === 'varm' ? 'varm (tidligere relation)' : 'kold'}`,
    `Sprog: ${lang === 'en' ? 'ENGELSK' : 'DANSK'}`,
    '',
    `SCENARIE: ${SCENARIOS[scenarioKey]}`,
    BUYER_ANGLE[contact.buyer] && !isReply ? `\nVINKEL (medieindkøb): ${BUYER_ANGLE[contact.buyer]}` : '',
    '',
    replyBrief || (pl
      ? `PLACERING: ${pl.name} (${pl.area}), periode ${pl.period}.`
      : `PLACERING: ${placName} (ingen detaljer — hold pris/tal ude).`),
    isReply ? '' : (doohBrief || ''),
    numbersSentence
      ? `\nPÅKRÆVET: Hver af de 3 mails SKAL indeholde denne sætning (placér den naturligt i teksten, gerne ordret) — den ER tallene, og en henvisning til vedhæftet oplæg erstatter den ALDRIG:\n"${numbersSentence}"`
      : '',
    dialogue
      ? `\nHIDTIDIG DIALOG MED KUNDEN (brug den AKTIVT — referér konkret til hvad der er sagt, så mailen bliver personlig og dynamisk frem for skabelon-agtig${scenarioKey === 'reply' ? '; svar direkte og specifikt på kundens seneste besked' : ''}):\n${dialogue}`
      : '',
    toneExamples ? `\nSEBASTIANS EGNE BESKEDER (match denne tone):\n${toneExamples}` : '',
    '',
    isReply
      ? 'VIGTIGT: Alle 3 varianter SKAL besvare kundens seneste besked konkret — men variér dem: én kort og imødekommende, én lidt mere uddybende, én der tydeligt foreslår næste skridt. Aldrig tre omskrivninger af samme sætning, ingen generiske floskler.'
      : 'VIGTIGT: De 3 varianter skal være tydeligt FORSKELLIGE — forskellig åbning, forskellig længde og forskellig vinkel (ikke tre omskrivninger af samme sætning). Hvis der er en dialog, så lad mindst én variant tage afsæt i noget konkret derfra. Undgå generiske floskler.',
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

    // Guarantee the key content is in every body — insert it if the model dropped it.
    // Banners: the m²/price sentence. DOOH: the launch-offer + video paragraph.
    const priceKey = pl && pl.price ? stripKr(pl.price) : null;
    const vid = isDooh ? (pl.video || '') : null;
    const doohPara = isDooh
      ? (lang === 'en'
          ? `The first 8 advertisers can book 4 weeks for the price of 1, at 12% share of voice. We've made an AI-generated video showing the screen — see it here: ${vid} Prices and traffic figures are in the attached document.`
          : `De første 8 annoncører kan booke 4 uger til 1 uges pris, ved 12% share of voice. Vi har lavet en AI-genereret video, der viser skærmen — se den her: ${vid} Priser og trafiktal finder du i det vedhæftede dokument.`)
      : null;
    const insertAfterPlacement = (body, sentence) => {
      const paras = body.split(/\n\s*\n/);
      let idx = paras.findIndex((p) => (pl && pl.name && p.includes(pl.name)) || /ledig plads|available|skærm|screen|Gothersgade/i.test(p));
      if (idx === -1) idx = 0;
      paras.splice(idx + 1, 0, sentence);
      return paras.join('\n\n');
    };
    const variants = parseVariants(text).map((v) => {
      if (isReply) return v; // a reply answers the mail — never force the sales sentence
      if (isDooh) {
        if (vid && !v.body.includes('W0HtCeyOdDo')) v.body = insertAfterPlacement(v.body, doohPara);
      } else if (numbersSentence && priceKey && !v.body.includes(priceKey)) {
        v.body = insertAfterPlacement(v.body, numbersSentence);
      }
      return v;
    });
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
