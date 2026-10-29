# Verbeterrobot

> AI-gestuurde verbetersleutelgenerator voor leerkrachten — VTI Zandhoven

Leerkrachten uploaden een taak- of toetsdocument. De AI (via Omniroute) lost alle vragen op
en geeft het originele document terug met de verbetersleutel **in het rood bij de vragen ingevoegd**.

---

## Ondersteunde formaten

| Formaat | Upload | Output |
|---|---|---|
| `.docx` | ✅ | Rode paragrafen na elke vraag |
| `.pdf` | ✅ | Rode verbetersleutel-sectie op de laatste pagina |
| `.pptx` | ✅ | Rode tekst-run na elke vraagtekst |
| `.xlsx` / `.xls` | ✅ | Rode rij onder elke vraagcel |
| `.txt` | ✅ | `[ANTWOORD]`-regels na elke vraag |

---

## Installatie

### 1. Vereisten
- Node.js 20+ (voor lokaal draaien)
- Docker + Docker Compose (voor deployment)
- Toegang tot een Omniroute-instantie (OpenAI-compatibele LLM-proxy)

### 2. Configuratie

```bash
cp .env.example .env
```

Vul in `.env`:

```env
ADMIN_PASSWORD=kies-een-sterk-beheerwachtwoord
TEACHER_PASSWORD=startwachtwoord-voor-leerkrachten
OMNIROUTE_BASE_URL=https://jouw-omniroute-url/v1
OMNIROUTE_API_KEY=jouw-api-sleutel
OMNIROUTE_MODEL=gpt-4o          # of een ander model dat Omniroute aanbiedt
PORT=3010
```

De waarden voor Omniroute en het leerkrachtenwachtwoord zijn **startwaarden**: wat je in het
beheerscherm opslaat (bewaard in `data/settings.json`, in Docker het volume `/app/data`) heeft voorrang.
`ADMIN_PASSWORD` kan enkel via `.env` gewijzigd worden.

### Accounts

| Account | Aanmelden met | Mag |
|---|---|---|
| **Beheer** | `ADMIN_PASSWORD` | Instellingen aanpassen + documenten verbeteren |
| **Leerkracht** | leerkrachtenwachtwoord | Documenten verbeteren |

### Instellingen in het beheer

Omniroute-URL, API-sleutel (wordt nooit teruggestuurd naar de browser), model, temperatuur,
maximale bestandsgrootte, systeemprompt en het leerkrachtenwachtwoord. Met "Verbinding testen"
controleer je de Omniroute-instellingen.

### Vakken & training (gericht verbeteren)

De robot wordt niet "getraind" in de zin van model-finetuning. In plaats daarvan krijgt de AI per
vak extra context mee (context-injectie). In **Beheer → Vakken & training** maak je per vak een profiel met:

- **Onderwerpen**: één per regel; de leerkracht vinkt ze aan bij het uploaden
- **Instructies**: vakspecifieke regels (bv. puntenverdeling, eenheden, taalgebruik)
- **Voorbeelden**: voorbeelden van goede verbeteringen
- **Referentiemateriaal**: cursus, correctiemodel, ... (upload of plak tekst). Bij elke verbetering worden
  de meest relevante fragmenten (max. ±10.000 tekens) automatisch geselecteerd.

Leerkrachten kiezen bij het uploaden een vak en eventueel onderwerpen. De profielen worden bewaard in
`data/subjects.json` (Docker-volume `verbeterrobot_data`).

### Training: prompts & lessen + geheugen (agentmemory)

Onderaan het beheer staat **Training: prompts & lessen**. Daar schrijf je vrije prompts als
*richtlijn*, *correctie* of *voorbeeld* — voor alle vakken of voor één vak. Bij elke verbetering worden
de algemene lessen en die van het gekozen vak aan de prompt toegevoegd (max. ±4000 tekens).
Opslag: `data/training.json`.

Optioneel kan je de robot koppelen aan een **agentmemory**-server (dezelfde als de MCP-server gebruikt):

- Zet in het beheer (**Geheugen**) de server-URL, het geheim en een projectnaam, vink "Geheugen gebruiken" aan
  en klik "Test verbinding". Of gebruik `AGENTMEMORY_*` in `.env` (zie `.env.example`).
- Nieuwe lessen worden dan ook in agentmemory bewaard (met de tag `[projectnaam]`).
- Bij elke verbetering zoekt de robot de relevante lessen op (vak, onderwerpen, begin van het document) en
  geeft die mee. Is de server onbereikbaar, dan werkt de robot gewoon verder zonder die lessen.
- Het geheim wordt nooit teruggestuurd naar de browser en hoort niet in de repository.

### 3. Lokaal draaien (dev)

```bash
npm install
npm run dev
```

De app is bereikbaar op `http://localhost:5173` (Vite dev-server met proxy naar Express op `:3010`).

### 4. Productie (Docker)

```bash
docker compose pull && docker compose up -d
```

### Versiebeheer (app-dashboard)

De app volgt dezelfde werkwijze als de andere VTIZ-apps: GitHub Actions bouwt bij een push op `main`
het image `ghcr.io/nickb-vtiz/verbeterrobot:<versie>` en maakt release `v<versie>`. De versie is
`version` in `package.json`. Nieuwe release maken:

```bash
npm version patch    # of minor / major
git push --follow-tags
```

Het app-dashboard toont daarna "Nieuw: vX.Y.Z" met een knop **Bijwerken**. De compose-service heet `app`
en de versie staat in `APP_VERSION` in `.env` (door het dashboard beheerd). Lokaal bouwen:
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

### Systeemprompt

Schrijf in het beheer enkel de inhoudelijke richtlijnen (vakconventies, notatie, werkwijze bij berekeningen).
De server voegt zelf altijd het technische uitvoerformaat (JSON met `vraag` en `antwoord`) toe en
bewerkt het bestand zelf; instructies over bestanden openen, pandoc of PDF's zijn niet nodig.

De app is bereikbaar op `http://<host>:3010`.

---

## Gebruik

1. Open de app in de browser.
2. Kies **Leerkracht** (of **Beheer**) en voer het bijbehorende wachtwoord in.
3. Sleep een document in het uploadvenster of klik om een bestand te kiezen.
4. Voeg optioneel extra instructies toe (bv. vak, graad, strengheid).
5. Klik **"Verbetersleutel genereren"**.
6. Download het verbeterde document — zelfde bestandsnaam, zelfde opmaak, antwoorden in rood.

---

## Veiligheidsnota's

- Geüploade bestanden worden **onmiddellijk na verwerking verwijderd** van de server.
- Stel altijd sterke wachtwoorden in voor `ADMIN_PASSWORD` en `TEACHER_PASSWORD`.
- Het leerkrachtenwachtwoord uit het beheer wordt als scrypt-hash opgeslagen.
- Na 10 mislukte aanmeldpogingen wordt een IP 15 minuten geblokkeerd; sessies vervallen na 12 uur of bij herstart van de server.
- Bewaar `OMNIROUTE_API_KEY` enkel in `.env` (nooit in versiebeheer).

---

## Stack

React 18 + Vite + Tailwind · Express.js · Omniroute (OpenAI-compat) · Docker
