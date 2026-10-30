# Personalisatie van de verbetersleutel-robot (Probleem 3)

> **Status: voorstel. Er is niets van geïmplementeerd. Wacht op akkoord.**

## 1. Vraag

Hoe laten we de robot antwoorden formuleren zoals *deze* leerkracht, voor *dit* vak, in *dit* leerjaar het wil
(notatie, tussenstappen, terminologie, sjabloon) – zonder dat elke correctie opnieuw uitgelegd moet worden?

## 2. Dimensies die het resultaat beïnvloeden

| Dimensie | Voorbeelden |
|---|---|
| Leerkracht | persoonlijke stijl, "ik schrijf altijd eerst de formule" |
| Vak | wiskunde, fysica, elektriciteit, talen |
| Leerjaar / richting / niveau | 3 TSO vs. 5 BSO; basis vs. uitgebreid |
| Notatieconventies | decimaalkomma, `.` of `×`, eenheden, afronding, beduidende cijfers |
| Diepte tussenstappen | enkel eindantwoord / formule + invulling + antwoord |
| Taal en terminologie | "stroomsterkte" vs. "intensiteit", Vlaamse vakterm |
| Documentsjabloon | vaste labels ("Gegeven:", "Antwoord:"), tabelopbouw, stijlen |
| Vraagtype | berekening, meerkeuze, open vraag, invulzin, schema |
| Schooljaar / toets-type | oefening, evaluatie, examen (eigen toevoeging) |
| Antwoordplaats | ruimte onder de vraag, tabelcel, invulstreepjes (eigen toevoeging) |

## 3. Vergelijking van de opties

| Criterium | (a) Fine-tuning | (b) Few-shot met retrieval | (c) Profielen met regels | (d) Sjabloonherkenning | (e) Combinatie b+c+d |
|---|---|---|---|---|---|
| Kwaliteit | Hoog bij veel data, zwak bij weinig | Hoog en direct bruikbaar vanaf 3–5 voorbeelden | Goed voor vaste conventies, niet voor nuances | Zeer goed voor structuur/plaatsing, niet voor inhoud | **Best**: elk onderdeel dekt een ander soort afwijking |
| Kost | Hoog (training + hosting eigen model); Omniroute-modellen zijn meestal niet fine-tunebaar | Laag: ~300–800 extra tokens per vraag | Verwaarloosbaar | Verwaarloosbaar (lokale hash/vergelijking) | Laag |
| Onderhoud | Zwaar: hertrainen bij elke nieuwe stijl of modelwissel | Licht: voorbeelden zijn data, geen model | Licht: tekstregels in beheer | Licht: automatisch bij elke upload | Licht |
| Privacy | Slecht: toetsinhoud verlaat de school in een trainingsset | Goed: enkel enkele goedgekeurde voorbeelden per aanroep, lokaal opgeslagen | Zeer goed | Zeer goed (lokaal) | Goed |
| Data nodig | Honderden tot duizenden goedgekeurde antwoorden | 1 voorbeeld volstaat; beter bij meer | Geen; regels kunnen met de hand geschreven of uit correcties afgeleid worden | 1 eerdere toets van hetzelfde sjabloon | Groeit mee |
| Uitlegbaarheid | Zwart vak | Zichtbaar welke voorbeelden gebruikt werden | Leesbare regels | Zichtbaar welk sjabloon herkend werd | Volledig traceerbaar |
| Modelwissel | Verloren werk | Blijft werken | Blijft werken | Blijft werken | Blijft werken |

### Conclusie per optie

- **(a) Fine-tuning – afgeraden.** Te weinig data per leerkracht, privacyprobleem, gebonden aan één model, duur onderhoud.
- **(b) Few-shot met retrieval – kern.** Elk goedgekeurd of verbeterd antwoord wordt een voorbeeld. Bij een nieuwe vraag
  halen we de 2–4 meest gelijkende voorbeelden op (zelfde leerkracht/vak eerst) en voegen ze toe aan de prompt.
- **(c) Profielen met regels – aanvullend.** Korte, expliciete regels per leerkracht / vak / school, bv.
  "decimaalkomma; eenheden altijd vermelden; rond af op 2 decimalen; toon formule → invulling → resultaat".
  Voorgesteld door het systeem na herhaalde correcties, bevestigd door de leerkracht.
- **(d) Sjabloonherkenning – aanvullend.** Vingerafdruk van het document (gebruikte stijlen, kopteksten, vaste labels,
  tabelstructuur). Bij een nieuwe upload met een gekend sjabloon worden de eerdere aanduidingen (rollen, antwoordplaatsen)
  automatisch als voorstel overgenomen en wordt het bijhorende profiel geladen.
- **(e) Combinatie – aanbevolen.**

**Hypothese bevestigd:** geen fine-tuning; combinatie b + c + d; elke correctie van de leerkracht wordt automatisch een nieuw
voorbeeld of een regelvoorstel; een eenvoudige beheerpagina voor profielen en voorbeelden volstaat.

## 4. Aanbevolen aanpak

Volgorde bij het bouwen van de prompt voor één vraag:

1. **Systeemprompt** (bestaand) + **vakcontext** (bestaand: vak, onderwerpen, referenties).
2. **Profielregels**: school → vak → leerjaar/richting → leerkracht (specifiek wint van algemeen).
3. **Voorbeelden** (retrieval): max. 3 goedgekeurde/verbeterde (vraag → antwoord)-paren, gerangschikt op:
   zelfde leerkracht en vak (+3), zelfde vraagtype (+2), zelfde sjabloon (+2), tekstovereenkomst (FTS5/BM25),
   recentheid. Verbeterde antwoorden wegen zwaarder dan louter goedgekeurde.
4. **Eigen antwoord/notatie van de leerkracht** voor deze vraag (uit Probleem 2) – heeft altijd voorrang.
5. De vraag zelf.

### Leerlus

```
generatie → leerkracht keurt goed / past aan / laat opnieuw genereren
   goedgekeurd      → voorbeeld (gewicht 1)
   aangepast        → voorbeeld (gewicht 2) + diff (oud↔nieuw) bewaard
   ≥3 gelijkaardige diffs → regelvoorstel ("je schrijft altijd 'x' in plaats van '×'") → leerkracht bevestigt in beheer
```

Regelvoorstellen komen uit één extra LLM-aanroep die enkel de diffs ziet (geen volledige toets).

## 5. Datamodel (SQLite, aanvulling op het opslagschema van Probleem 4)

```sql
profiles(
  id TEXT PK, scope TEXT CHECK(scope IN ('school','vak','klas','leerkracht')),
  scope_key TEXT,            -- vak-id, leerkracht-naam, "3TSO" ...
  rules TEXT,                -- vrije tekst, één regel per lijn
  enabled INTEGER, updated_at TEXT, updated_by TEXT)

examples(
  id TEXT PK, document_id TEXT NULL,   -- NULL = losgekoppeld van document
  teacher TEXT, vak TEXT, leerjaar TEXT,
  question_type TEXT,                  -- berekening|meerkeuze|open|invul|schema
  template_id TEXT NULL,
  question_text TEXT, answer_text TEXT, steps_json TEXT,
  source TEXT CHECK(source IN ('goedgekeurd','aangepast','handmatig')),
  weight REAL, created_at TEXT, active INTEGER)
-- FTS5-index examples_fts(question_text)

rule_suggestions(
  id TEXT PK, scope TEXT, scope_key TEXT, rule TEXT,
  evidence_json TEXT,                  -- ids van de diffs
  status TEXT CHECK(status IN ('open','bevestigd','afgewezen')), created_at TEXT)

templates(
  id TEXT PK, fingerprint TEXT UNIQUE, -- hash van gesorteerde stijlen + vaste labels + tabelstructuur
  label TEXT, teacher TEXT, vak TEXT,
  marks_json TEXT,                     -- laatst bevestigde rolaanduidingen per positie/label
  seen_count INTEGER, last_seen TEXT)
```

De tabel `feedback` uit Probleem 4 (per antwoord: oud, nieuw, actie, tijdstip, gebruiker) is de voeding voor `examples`
en `rule_suggestions`.

## 6. Implementatiestappen na akkoord

1. `server/personalise/profiles.js` – CRUD en samenstellen van de regeltekst per (school, vak, klas, leerkracht).
2. `server/personalise/examples.js` – opslaan uit feedback, retrieval met FTS5 + scoring, ontkoppelen/verwijderen bij document-delete.
3. `server/personalise/fingerprint.js` – vingerafdruk uit `extractParagraphs`, matching met `templates`, voorstel van marks overnemen.
4. Aanpassing `solve.js`: `buildQuestionPrompt` krijgt `profileRules`, `examples`, `teacherAnswer` mee.
5. `server/personalise/suggest.js` – regelvoorstellen uit diffs (batch, na x correcties of handmatig in beheer).
6. Beheerpagina "Personalisatie": profielen bewerken, voorbeelden zoeken/deactiveren/verwijderen, regelvoorstellen bevestigen of afwijzen.
7. Meting: percentage antwoorden dat zonder aanpassing goedgekeurd wordt, per leerkracht en per vak (grafiek in beheer) om het effect te bewijzen.
8. Tests: retrieval-rangschikking, profielvoorrang, fingerprint-stabiliteit bij gewijzigde vragen, verwijdering van voorbeelden bij document-delete.

Geschatte omvang: 1 sprint (± 5 werkdagen), zonder extra infrastructuur of nieuwe externe diensten.

## 7. Risico's en beperkingen

- Te veel of tegenstrijdige voorbeelden → prompt wordt lang: harde limiet (3 voorbeelden, 1 500 tekens regels).
- Slechte goedkeuringen vervuilen de voorbeelden: leerkracht kan voorbeelden deactiveren; admin kan alles inzien.
- Privacy: voorbeelden staan lokaal; enkel de geselecteerde paren gaan mee naar het model, net als de toetsvraag zelf.
- Op termijn kan fine-tuning heroverwogen worden als er > 2 000 goedgekeurde paren zijn én een fine-tunebaar model beschikbaar is.

## 8. Beslissing gevraagd

- [ ] Akkoord met aanbeveling (b + c + d, geen fine-tuning)
- [ ] Akkoord met datamodel en leerlus
- [ ] Opmerkingen / aanpassingen: …

**Er wordt pas gebouwd na jouw akkoord.**
