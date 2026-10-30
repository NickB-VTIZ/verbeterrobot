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
| **Persoonlijk account** (vanaf v1.9.0) | gebruikersnaam + eigen wachtwoord | Rol *leerkracht* of *beheerder*, door het beheer aangemaakt |

Persoonlijke accounts maak je aan in het beheer, tab **Gebruikers** (wachtwoord minstens 8 tekens; rol wijzigen, wachtwoord opnieuw instellen, deactiveren, verwijderen). Op het aanmeldscherm wissel je met de link onderaan tussen het gedeelde wachtwoord en een persoonlijk account. De weergavenaam van het account wordt als naam van de leerkracht gebruikt, zodat eigenaarschap van documenten gewoon blijft werken. De gedeelde wachtwoorden blijven altijd werken.

### Het beheer (tabs)

De titel toont het versienummer (bv. `Beheer v1.6.0`; ook bij de hoofdtitel en in de voettekst).

| Tab | Inhoud |
|-----|--------|
| **Status** | versie, looptijd, aantal vakken/lessen, toestand van Omniroute en agentmemory (laatste testresultaat), herkomst van het leerkrachtenwachtwoord, knop "Alle verbindingen testen" |
| **Verbindingen** | Omniroute (URL, API-sleutel, model, temperatuur) en agentmemory (aan/uit, URL, geheim, projectnaam), elk met "Opslaan & testen" |
| **Instellingen** | maximale bestandsgrootte, systeemprompt, leerkrachtenwachtwoord |
| **Vakken** | vakprofielen met onderwerpen, instructies, voorbeelden en referentiemateriaal |
| **Training** | vrije prompts/lessen (richtlijn, correctie, voorbeeld) |
| **Trainingsdata** | alles wat de app geleerd heeft: voorbeelden uit verbeterde versies (met oordeel en duiding, filterbaar en verwijderbaar), lessen en feedback op antwoorden |
| **Gebruikers** | persoonlijke accounts aanmaken en beheren |

**Verbindingstests**
- *Omniroute*: haalt de modellenlijst op (latency, aantal modellen, staat het gekozen model erin?). De
  **diepe test** stuurt daarnaast een minuscuul chatbericht naar het gekozen model.
- *agentmemory*: controleert bereikbaarheid, of het geheim aanvaard wordt en hoeveel lessen van dit project er zijn.
- Het laatste resultaat blijft zichtbaar op de Status-tab (tot de server herstart). Sleutels en geheimen worden
  nooit teruggestuurd naar de browser.

### Vakken & training (gericht verbeteren)

De robot wordt niet "getraind" in de zin van model-finetuning. In plaats daarvan krijgt de AI per
vak extra context mee (context-injectie). In **Beheer → Vakken** maak je per vak een profiel met:

- **Onderwerpen**: één per regel; de leerkracht vinkt ze aan bij het uploaden
- **Instructies**: vakspecifieke regels (bv. puntenverdeling, eenheden, taalgebruik)
- **Voorbeelden**: voorbeelden van goede verbeteringen
- **Referentiemateriaal**: cursus, correctiemodel, ... (upload of plak tekst). Bij elke verbetering worden
  de meest relevante fragmenten (max. ±10.000 tekens) automatisch geselecteerd.

Leerkrachten kiezen bij het uploaden een vak en eventueel onderwerpen. De profielen worden bewaard in
`data/subjects.json` (Docker-volume `verbeterrobot_data`).

### Training: prompts & lessen + geheugen (agentmemory)

In **Beheer → Training** schrijf je vrije prompts als
*richtlijn*, *correctie* of *voorbeeld* — voor alle vakken of voor één vak. Bij elke verbetering worden
de algemene lessen en die van het gekozen vak aan de prompt toegevoegd (max. ±4000 tekens).
Opslag: `data/training.json`.

Optioneel kan je de robot koppelen aan een **agentmemory**-server (dezelfde als de MCP-server gebruikt):

- Zet in het beheer (**Verbindingen → Geheugen**) de server-URL, het geheim en een projectnaam, vink "Geheugen gebruiken" aan
  en klik "Opslaan & testen". Of gebruik `AGENTMEMORY_*` in `.env` (zie `.env.example`).
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

### Gestructureerde .docx-pipeline (vanaf v1.5.0)

Voor `.docx` werkt de robot niet meer door het LLM de XML te laten aanpassen, maar in vaste stappen
(modules in `server/docx/`). Het LLM levert enkel JSON; de code doet de rest.

| Stap | Module | Wat gebeurt er |
|---|---|---|
| 1. Extract | `extract.js` | Leest `word/document.xml`, geeft elke paragraaf een stabiel ID (`p_001`, …), voegt runs met dezelfde opmaak samen en herkent invulplaatsen (`.....`, `_____`), tabellen en tekstvakken. |
| 2. Analyse | `analyse.js` | Het LLM herkent vragen en bepaalt per vraag *slots* (waar het antwoord komt). De code valideert paragraaf-ID's en aantallen en vraagt zo nodig opnieuw (max. 2 keer). |
| 3. Solve | `solve.js` | Per vraag lost het LLM op en geeft antwoorden, tussenstappen en `checks` (rekenuitdrukkingen). |
| 4. Verify | `verify.js` | Rekent de checks na met een eigen veilige parser (geen `eval`), met eenhedenomzetting en 0,1 % tolerantie. Bij een afwijking krijgt het LLM feedback en probeert het opnieuw. |
| 5. Insert | `insert.js` | Voegt antwoorden toe als **rode runs**, van achter naar voor zodat de ID's geldig blijven. |
| 6. QC | `pipeline.js` | Controleert het aantal paragrafen en of er geen invulplaatsen overblijven. |

Slottypes: `fill_placeholders`, `append`, `fill_empty_following`, `insert_after`, `fill_cell`.

- Vragen die niet geverifieerd raken, komen in een **nakijklijst** (response-headers `X-Nakijken-Aantal` en `X-Nakijken`).
- Als de pipeline niets herkent of faalt, valt de app automatisch terug op de klassieke methode.
- Uitschakelen kan met de omgevingsvariabele `DOCX_PIPELINE=off`.
- Deterministische test (zonder LLM): `node scripts/test-docx-pipeline.mjs`.

### Visuele controle met LibreOffice (vanaf v1.6.0)

Na het invoegen controleert de robot het resultaat ook **visueel**:

1. LibreOffice (headless) zet het verbeterde `.docx` om naar PDF (het origineel ook, om het aantal pagina's te vergelijken).
2. `pdftoppm` (poppler) rendert de eerste pagina's (max. 6, 80 dpi) naar PNG.
3. Een **vision-model** via Omniroute bekijkt de pagina's: staan de rode antwoorden leesbaar op de juiste plaats, is er niets afgesneden of overlappend, blijven er geen lege invulpunten, zijn tabellen nog intact?

Resultaat:
- **Alles in orde**: groene melding bij het resultaat.
- **Problemen**: ze komen als `layout` in de nakijklijst (`X-Nakijken`) en worden getoond onder "Kijk deze onderdelen zelf even na".
- **Het model kan het niet goed beoordelen**: de robot stelt de leerkracht maximaal 5 vragen (header `X-Verduidelijking`). De leerkracht typt een antwoord en klikt op *Opnieuw proberen met deze verduidelijking*; het antwoord wordt aan de context toegevoegd.
- **Niet beschikbaar** (geen LibreOffice/poppler, conversie of model faalt): de controle wordt overgeslagen en het document wordt gewoon geleverd (header `X-Visuele-Controle: skipped`).

Instellingen: in het beheer (tab *Verbindingen*) of met `VISUAL_CHECK=on|off` en `VISION_MODEL=`. Het model moet afbeeldingen kunnen lezen; leeg = het gewone Omniroute-model. De tab *Status* toont of LibreOffice en poppler gevonden zijn.

> Let op: door LibreOffice en poppler wordt het Docker-image enkele honderden MB groter. Wil je dat niet, zet dan `VISUAL_CHECK=off` of verwijder de `apk add`-regel in de `Dockerfile`.

### Bibliotheek, aanduiden en opslag (vanaf v1.7.0)

**Permanente opslag.** Elk geüpload document wordt bewaard in `DATA_DIR/documents/<uuid>/` (UUID-bestandsnamen, SHA-256-controlesom).
Metadata, versies, aanduidingen, feedback, LLM-aanroepen en het auditlog staan in SQLite (`DATA_DIR/verbeterrobot.db`).
Per document zijn er meerdere versies van de sleutel; elke versie bewaart de gebruikte slots, vragen en kwaliteitscontrole. Voorbeeldafbeeldingen (previews) van origineel en sleutel worden op de achtergrond met LibreOffice gemaakt.

**Bibliotheek.** Na het aanmelden (leerkrachten geven hun naam in) zie je je documenten als raster of lijst, met zoeken, filters (vak, leerjaar, richting, schooljaar, status, tags), groeperen, meervoudige selectie en slepen-en-neerzetten. Het scherm werkt op tablet en in licht én donker thema.
Op de detailpagina staan origineel en sleutel naast elkaar, alle versies (vergelijken, activeren, goedkeuren), het aanduidingenscherm, de feedbackgeschiedenis, de LLM-kost en de metadata. Acties: downloaden (origineel, sleutel, beide als zip), opnieuw genereren, dupliceren, als sjabloon bewaren en tags beheren.

**Aanduiden (probleem 2).** Je duidt per paragraaf aan wat het is: *vraag, antwoordplaats, gegeven, formuleblad, modelantwoord* of *instructie*. De AI kan een voorstel doen dat je kan aanvullen of overnemen. Je kan per vraag ook zelf een antwoord invullen; dat heeft voorrang op wat de AI berekent. Na het genereren kan je elk antwoord goedkeuren, aanpassen of laten hergenereren; aanpassingen worden als feedback bewaard (basis voor latere personalisatie, zie `docs/personalisatie.md`).
Een antwoord komt **nooit** aan het einde van het document terecht: is er voor een vraag geen geldige plaats, dan wordt dat gelogd en staat de vraag op de lijst *handmatig nakijken*.

**Aanduiden in een voorbeeld van het document (vanaf v1.8.0).** Na het uploaden van een .docx opent het aanduidingenscherm standaard in de *documentweergave*: het document wordt als pagina getoond (koppen, vet, lijsten, tabellen, invulpunten als stippellijn, lege regels). Klik op een stuk tekst en kies of het de vraag, de antwoordplaats, een gegeven, ... is. Een antwoordplaats krijgt een rode gestippelde markering *"✎ Antwoord 3b komt hier"*, ook bij lege regels of cellen waar het antwoord later in komt. Met de schakelaar wissel je naar de *lijst met alinea's*, en met *Origineel bekijken (pdf)* toon je het echte document als houvast.

**Prullenbak en bewaartermijn.** Verwijderen is eerst zacht (prullenbak). Na `TRASH_RETENTION_DAYS` dagen (standaard 30) worden documenten automatisch definitief verwijderd. Bij definitief verwijderen zie je eerst hoeveel bestanden en ruimte dat vrijmaakt, en kies je of de voorbeelden uit correcties bewaard blijven. Alles komt in het auditlog.

**Beheer, tab *Overzicht*.** Opslaggebruik, aantal documenten per leerkracht, AI-kosten per maand/vak/leerkracht (stel `LLM_PRICE_IN_PER_1M` en `LLM_PRICE_OUT_PER_1M` in, in euro per miljoen tokens), de lijst met voorbeelden (verwijderbaar), het auditlog en een knop om de prullenbak nu op te ruimen.

**Back-up en herstel.** De service `backup` in `docker-compose.yml` maakt dagelijks een back-up van database en bestanden naar het volume `verbeterrobot_backups`.
- `BACKUP_RETENTION_DAYS` (standaard 14) en `BACKUP_HOUR` (standaard 3 u) regelen bewaartermijn en tijdstip.
- Meteen een back-up: `docker compose run --rm backup node scripts/backup.mjs`.
- Beschikbare back-ups: `docker compose run --rm backup node scripts/restore.mjs --list`.
- Herstellen: `docker compose stop app`, daarna `docker compose run --rm backup node scripts/restore.mjs <naam|latest> --yes`, daarna `docker compose start app`.

**Automatisch eerste voorstel (vanaf v1.9.0).** Zodra je een .docx uploadt, start de server op de achtergrond een grondig voorstel: het model duidt vragen, antwoordplaatsen, gegevens en instructies aan en een tweede controleronde (*verfijning*) vult hiaten aan en corrigeert fouten, met de vakcontext en de voorbeelden uit eerdere verbeterde versies als houvast. De status (*bezig / klaar / mislukt*) staat op de detailpagina. In het aanduidingenscherm is het voorstel al ingevuld zolang je zelf nog niets aanduidde; jouw aanduidingen hebben altijd voorrang. Bij een herstart van de server wordt een onderbroken voorstel als *mislukt* gemarkeerd (je kan het opnieuw laten doen met "AI laat een voorstel doen").

**Zelf verbeterde versie uploaden en de app laten leren (vanaf v1.9.0).** Op de detailpagina van een document kan je je eigen verbeterde .docx uploaden. De code vergelijkt de alinea's met het origineel, haalt uit wat jij toevoegde of wijzigde per vraag, en legt dat naast het antwoord van de app. Het resultaat per vraag (*gelijk, afwijkend, enkel van jou, ...*) wordt bewaard als trainingsvoorbeeld; het model geeft (best effort) een korte duiding en formuleert lessen die in de training terechtkomen. Latere generaties gebruiken de voorbeelden als few-shot context, per vak. Opnieuw uploaden vervangt de vorige voorbeelden van dat document. In het beheer (tab *Trainingsdata*) zie en verwijder je alles.

**Tests** (zonder LLM): `npm test` (aanduidingen, docx-pipeline, opslag, bibliotheek-API, gebruikers/trainingsdata/vergelijking).

### Systeemprompt

Schrijf in het beheer enkel de inhoudelijke richtlijnen (vakconventies, notatie, werkwijze bij berekeningen).
De server voegt zelf altijd het technische uitvoerformaat (JSON met `vraag` en `antwoord`) toe en
bewerkt het bestand zelf; instructies over bestanden openen, pandoc of PDF's zijn niet nodig.

De app is bereikbaar op `http://<host>:3010`.

---

## Gebruik

1. Open de app in de browser.
2. Kies **Leerkracht** (geef je naam) of **Beheer** en voer het bijbehorende wachtwoord in.
3. Klik in de bibliotheek op **Nieuw document** (of sleep een bestand in het scherm) en vul vak, leerjaar en schooljaar in.
4. Duid aan wat vraag, antwoordplaats en gegeven is (of laat de AI een voorstel doen) en klik **Bewaar en maak sleutel**.
5. Controleer de antwoorden, pas aan of keur goed.
6. Download de sleutel — zelfde opmaak, antwoorden in rood. De snelle werkwijze zonder bibliotheek (*Snel document verbeteren*) blijft beschikbaar.

De voorbeelden (origineel en sleutel naast elkaar) worden zonder het paginaoverzicht van de PDF-viewer getoond, zodat ze de volle breedte gebruiken; via *Open in nieuw tabblad* krijg je de volledige viewer. Terwijl de AI bezig is (voorstel of sleutel) toont de app een duidelijk voortgangspaneel met verstreken tijd en de lopende stappen.

**Duidelijker beheer en adaptieve UI (vanaf v1.10.0).** Het beheer gebruikt nu de volle breedte met dezelfde kop als de rest van de app (Bibliotheek / Beheer / Afmelden). Het menu is gegroepeerd in *Systeem* (Status, Verbindingen, Instellingen), *Inhoud & training* (Vakken, Training, Trainingsdata) en *Gebruik* (Overzicht, Gebruikers), met icoon en een korte uitleg per pagina. Op grote schermen staat het als vaste zijbalk, op tablet en gsm als horizontaal scrollbare knoppen. Trainingsdata toont samenvattende tegels (voorbeelden, lessen, feedback, geheugenstatus) en een duidelijke lege staat.

---

## Veiligheidsnota's

- Documenten uit de bibliotheek worden bewaard tot ze (na de prullenbak) definitief verwijderd worden; bestanden uit de snelle werkwijze worden na verwerking verwijderd. Leerkrachten zien enkel hun eigen documenten.
- Stel altijd sterke wachtwoorden in voor `ADMIN_PASSWORD` en `TEACHER_PASSWORD`.
- Het leerkrachtenwachtwoord uit het beheer wordt als scrypt-hash opgeslagen.
- Na 10 mislukte aanmeldpogingen wordt een IP 15 minuten geblokkeerd; sessies vervallen na 12 uur of bij herstart van de server.
- Bewaar `OMNIROUTE_API_KEY` enkel in `.env` (nooit in versiebeheer).

---

## Stack

React 18 + Vite + Tailwind · Express.js · Omniroute (OpenAI-compat) · Docker
