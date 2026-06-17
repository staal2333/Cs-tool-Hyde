// Detect which placement(s) a piece of mail text offers, so we can track
// exactly what each contact was pitched — straight from the real Gmail body.

// Canonical placement key -> regexes that identify it in free text.
// Order matters only for readability; every match is collected.
const ALIASES = {
  'Gothersgade × Grønnegade': [/gothersgade/i, /gr[øo]nnegade/i],
  'Nørrebrogade 195': [/n[øo]rrebrogade(\s*195)?/i],
  'Gammel Kongevej 49': [/gammel\s*kongevej\s*49/i, /\bgk\s*49\b/i],
  'Gammel Kongevej 33B': [/gammel\s*kongevej\s*33/i, /\bgk\s*33/i],
  'Prinsessegade': [/prinsessegade/i],
  'Bredgade 71': [/bredgade(\s*71)?/i],
  'Silkeborgvej': [/silkeborgvej/i],
};

// Returns the canonical placement keys mentioned in the text. `known` (the live
// DATA.placements keys) gates the result so we never invent a retired placement.
export function detectPlacements(text, known) {
  const t = String(text || '').normalize('NFC');
  if (!t) return [];
  const allow = known ? new Set(known.map((k) => k.normalize('NFC'))) : null;
  const hits = [];
  for (const [name, res] of Object.entries(ALIASES)) {
    if (allow && !allow.has(name.normalize('NFC'))) continue;
    if (res.some((re) => re.test(t))) hits.push(name);
  }
  // Also catch any live placement whose exact key appears verbatim but isn't aliased.
  if (known) {
    for (const k of known) {
      if (!hits.includes(k) && k.length > 3 && t.toLowerCase().includes(k.toLowerCase())) hits.push(k);
    }
  }
  return hits;
}
