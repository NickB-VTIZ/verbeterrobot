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
APP_PASSWORD=kies-een-sterk-wachtwoord
OMNIROUTE_BASE_URL=https://jouw-omniroute-url/v1
OMNIROUTE_API_KEY=jouw-api-sleutel
OMNIROUTE_MODEL=gpt-4o          # of een ander model dat Omniroute aanbiedt
PORT=3010
```

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
2. Voer het gedeelde leerkrachtenwachtwoord in.
3. Sleep een document in het uploadvenster of klik om een bestand te kiezen.
4. Voeg optioneel extra instructies toe (bv. vak, graad, strengheid).
5. Klik **"Verbetersleutel genereren"**.
6. Download het verbeterde document — zelfde bestandsnaam, zelfde opmaak, antwoorden in rood.

---

## Veiligheidsnota's

- Geüploade bestanden worden **onmiddellijk na verwerking verwijderd** van de server.
- Stel altijd een sterk `APP_PASSWORD` in — niet `changeme`.
- Bewaar `OMNIROUTE_API_KEY` enkel in `.env` (nooit in versiebeheer).

---

## Stack

React 18 + Vite + Tailwind · Express.js · Omniroute (OpenAI-compat) · Docker
