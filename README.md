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

### 3. Lokaal draaien (dev)

```bash
npm install
npm run dev
```

De app is bereikbaar op `http://localhost:5173` (Vite dev-server met proxy naar Express op `:3010`).

### 4. Productie (Docker)

```bash
docker compose up -d --build
```

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
