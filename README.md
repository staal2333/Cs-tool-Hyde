# Hyde Media — Outreach (Vercel)

Outreach-værktøj til kold/varm outreach + opfølgninger. Funktioner:

- **📊 Overblik (forside)** — KPI'er: svarprocent, booket-rate, pipeline- & booket-værdi, kunder pr. stadie og konvertering pr. mail-scenarie.
- **AI-mailudkast** — 3 forslag i din tone pr. kunde (scenarie/placering/sprog), via Claude.
- **📤 Send direkte via Gmail** — ét klik sender udkastet, sætter status + dato automatisk og tråder svar.
- **⏰ Opfølgnings-radar** — flagger hvor længe siden sidste mail (🟠 forfalden / 🔴 for længe) og sorterer de mest forsinkede øverst.
- **🖼️ Mockups pr. placering** — upload ét foto pr. placering; vises på kort og vedhæftes mailen.
- **🗺️ Kort** — de 6 placeringer på et OpenStreetMap-kort med detaljer pr. markør.
- **📍 Område- og 🏷️ tag-filtre** — segmentér kunder på placeringsområde eller frie tags.
- **🏷️ Auto-tag medieindkøb** — Claude klassificerer Bureau / Selv / Ukendt.
- **Gmail-sync** — henter svar (auto-svar filtreres fra), opdaterer status og logger dialog.
- **Win-the-customer-agent** + **☀️ Dagens plan** — regelbaserede forslag + Claude-prioritering.
- **Server-side lagring** (Upstash Redis), delt på tværs af enheder, bag en **adgangskode**.
- **CSV-status importeret** fra `hyde_status.csv` som udgangspunkt (`seed.json`).

> **Gmail-afsendelse kræver send-scope.** Efter denne version skal du trykke **"🔗 Forbind Gmail"** igen én gang, så appen får tilladelse til at *sende* (ikke kun læse). OAuth-scope er nu `gmail.readonly` + `gmail.send`.

## Struktur

```
public/            statiske filer (login + app) — serveres af Vercel
  index.html, app.js, styles.css
api/               serverless functions
  login logout data state suggest draft send sync google
  contacts briefing log placements
lib/               delt kode (auth, redis, state, data, contacts, log,
  gmail, google, sync, sync-core, placements)
data.json          kontakter + mailudkast + placeringer m. koordinater (IKKE offentlig)
seed.json          startstatus fra CSV (IKKE offentlig)
```

## Deploy (du har en Vercel-konto)

1. **Læg koden på GitHub.** I denne mappe:
   ```bash
   git init && git add -A && git commit -m "Hyde outreach v2"
   gh repo create hyde-outreach --private --source=. --push
   # eller opret repo manuelt på github.com og: git remote add origin <url> && git push -u origin main
   ```

2. **Importér i Vercel.** vercel.com → **Add New… → Project** → vælg repo'et → **Deploy**.
   (Framework: *Other*. Ingen build-kommando nødvendig.)

3. **Opret database (Upstash Redis).** I projektet: **Storage → Create Database → Upstash for Redis** (gratis tier).
   Forbind den til projektet — så injicerer Vercel automatisk `KV_REST_API_URL` og `KV_REST_API_TOKEN`.

4. **Sæt miljøvariabler.** Projekt → **Settings → Environment Variables**:
   | Navn | Værdi |
   |------|-------|
   | `APP_PASSWORD` | din adgangskode |
   | `ANTHROPIC_API_KEY` | din nøgle fra console.anthropic.com (til AI-knappen) |
   | `CLAUDE_MODEL` | *(valgfri)* `claude-haiku-4-5` for billigere/hurtigere forslag |

5. **Redeploy** (Deployments → ⋯ → Redeploy) så variablerne træder i kraft. Færdig.

> Uden Redis kører appen stadig, men status gemmes kun i hukommelsen pr. instans (ikke delt).
> Uden `ANTHROPIC_API_KEY` virker alt undtagen 🤖-knappen.

## Kør lokalt

```bash
npm install
npm i -g vercel
vercel dev          # kører både statiske filer og /api lokalt
```
Lav en `.env.local` (se `.env.example`). Uden `APP_PASSWORD` er appen åben lokalt.

## Sådan virker det

- Status-forløb: Ikke kontaktet → Sendt → Opfølgning sendt → Svar modtaget / Booket / Nej tak.
- **Kopiér mail** sætter automatisk status til *Sendt* med dagens dato; **Kopiér opfølgning** sætter *Opfølgning sendt*.
- **Opfølgning**-fanen viser kunder sendt for ≥ X dage siden uden svar, hver med færdigt opfølgnings-udkast **og** forslag til at vinde kunden.
- **Nulstil** ruller tilbage til den importerede CSV-status (seed), ikke en tom liste.

## Datamodel

`data.json` (kontakter, placeringer) og `seed.json` (startstatus) redigeres frit.
Vil du opdatere startstatus fra en ny CSV, så regenerér `seed.json` og commit.
