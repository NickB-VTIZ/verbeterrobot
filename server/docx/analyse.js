/**
 * analyse.js — LLM-aanroep 1: structuuranalyse.
 *
 * Het model ziet de genummerde paragrafen en bepaalt welke vragen er zijn en waar de
 * antwoorden ("slots") horen. Het model schrijft geen XML. De code valideert de uitvoer
 * en stuurt fouten terug (max. 2 herpogingen).
 */

import { askJson } from "./llm.js";
import { serializeForPrompt } from "./extract.js";
import { SLOT_TYPES } from "./insert.js";

export const ANALYSE_PROMPT = `Je analyseert de structuur van een toets of oefening (Word-document) om te bepalen WAAR antwoorden moeten komen. Je lost niets op.

Je krijgt een JSON-lijst van paragrafen: { id, text, style, heading_level, is_list, is_empty, in_table, placeholders }.
"placeholders" is het aantal invulpunten (reeksen van minstens 5 puntjes of liggende streepjes) in die paragraaf.

Antwoord UITSLUITEND met JSON van de vorm:
{"questions":[{"qid":"1","question_para_ids":["p_003"],"context":"gegevens of voorafgaande uitleg die nodig is om te antwoorden","slots":[{"para_id":"p_004","type":"fill_placeholders","count":2,"content":"korte beschrijving van wat hier ingevuld moet worden"}]}]}

Slot-types:
- fill_placeholders: de paragraaf bevat invulpunten; "count" moet EXACT gelijk zijn aan "placeholders" van die paragraaf.
- append: het antwoord komt achteraan dezelfde paragraaf (bv. een vraag met "Antwoord:" of een opsomming).
- fill_empty_following: de eerstvolgende lege paragrafen (is_empty) onder para_id zijn de antwoordlijnen; "count" = het aantal lege paragrafen dat ingevuld moet worden (niet meer dan er effectief volgen).
- insert_after: er is geen plaats voorzien; een nieuwe paragraaf wordt na para_id ingevoegd.
- fill_cell: een lege tabelcel (paragraaf met in_table en is_empty) waarin het antwoord komt.

Regels:
1. Elke paragraaf met placeholders > 0 MOET in een slot fill_placeholders zitten.
2. Gebruik altijd de paragraaf-ID's uit de lijst, nooit de tekst of nummering om een plaats aan te duiden (labels herhalen zich).
3. Groepeer subvragen (a, b, c) met hun gemeenschappelijke opgave in één vraag als ze samen gegevens delen; "context" bevat dan de gegevens.
4. Paragrafen die enkel een paginascheiding zijn komen nooit in een slot.
5. Geen vragen gevonden? Antwoord {"questions":[]}.
6. Geen tekst buiten de JSON.`;

/**
 * Valideert het analyse-resultaat tegen de echte paragrafen. Gooit een Error met een
 * duidelijke Nederlandse boodschap (die aan het model teruggegeven wordt).
 * @param {any} parsed
 * @param {Array<ParagraphInfo>} paragraphs
 */
export function validateAnalysis(parsed, paragraphs, { collect = false, skipCoverage = false } = {}) {
  const byId = new Map(paragraphs.map((p, i) => [p.id, { p, i }]));
  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list)) throw new Error('Verwacht {"questions":[...]}.');

  const errors = [];
  const covered = new Set();
  const seenSlot = new Set();
  const questions = [];

  list.forEach((q, qi) => {
    const qid = String(q?.qid ?? qi + 1);
    const slots = Array.isArray(q?.slots) ? q.slots : [];
    const outSlots = [];
    for (const s of slots) {
      const type = s?.type;
      const found = byId.get(s?.para_id);
      if (!SLOT_TYPES.includes(type)) {
        errors.push(`Vraag ${qid}: onbekend slot-type '${type}'.`);
        continue;
      }
      if (!found) {
        errors.push(`Vraag ${qid}: para_id '${s?.para_id}' bestaat niet.`);
        continue;
      }
      const key = `${type}:${s.para_id}`;
      if (seenSlot.has(key)) {
        errors.push(`Vraag ${qid}: dubbel slot ${key}.`);
        continue;
      }
      seenSlot.add(key);
      const { p, i } = found;
      let count = Number(s.count ?? 1) || 1;

      if (type === "fill_placeholders") {
        if (p.placeholders === 0) {
          errors.push(`Vraag ${qid}: ${p.id} bevat geen invulpunten, gebruik een ander slot-type.`);
          continue;
        }
        if (count !== p.placeholders) {
          errors.push(
            `Vraag ${qid}: ${p.id} heeft ${p.placeholders} invulpunt(en), maar count is ${count}.`
          );
          continue;
        }
        covered.add(p.id);
      } else if (type === "fill_empty_following") {
        let avail = 0;
        for (let k = i + 1; k < paragraphs.length; k++) {
          const n = paragraphs[k];
          if (!n.isEmpty || n.inTable !== p.inTable) break;
          avail++;
        }
        if (avail === 0) {
          errors.push(`Vraag ${qid}: na ${p.id} volgen geen lege paragrafen; gebruik insert_after.`);
          continue;
        }
        if (count > avail) count = avail; // stilzwijgend begrenzen
      } else if (type === "fill_cell") {
        if (!p.inTable) {
          errors.push(`Vraag ${qid}: ${p.id} zit niet in een tabel.`);
          continue;
        }
      }
      if (p.isPageBreak) {
        errors.push(`Vraag ${qid}: ${p.id} is een paginascheiding.`);
        continue;
      }
      outSlots.push({
        para_id: p.id,
        type,
        count: type === "fill_placeholders" || type === "fill_empty_following" ? count : 1,
        content: String(s.content ?? ""),
      });
    }
    const qParas = (Array.isArray(q?.question_para_ids) ? q.question_para_ids : [])
      .map(String)
      .filter((id) => byId.has(id));
    if (outSlots.length > 0) {
      questions.push({
        qid,
        question_para_ids: qParas,
        context: String(q?.context ?? ""),
        slots: outSlots,
      });
    }
  });

  if (!skipCoverage) {
    for (const p of paragraphs) {
      if (p.placeholders > 0 && !covered.has(p.id)) {
        errors.push(`Paragraaf ${p.id} heeft ${p.placeholders} invulpunt(en) maar zit in geen enkel fill_placeholders-slot.`);
      }
    }
  }
  // collect: geef geldige vragen + de fouten terug (voor de aanduidingen van de leerkracht)
  if (collect) return { questions, errors };
  if (errors.length) throw new Error(errors.slice(0, 15).join("\n"));
  return questions;
}

/**
 * @param {Array<ParagraphInfo>} paragraphs
 * @param {{extraContext?:string, subjectContext?:string}} opts
 * @returns {Promise<Array<{qid,question_para_ids,context,slots}>>}
 */
export async function analyseStructure(paragraphs, { extraContext = "", subjectContext = "" } = {}) {
  const payload = JSON.stringify(serializeForPrompt(paragraphs));
  const user =
    (extraContext ? `Extra instructies van de leerkracht: ${extraContext}\n\n` : "") +
    (subjectContext ? `Achtergrond over het vak (enkel om het soort vragen te begrijpen):\n${String(subjectContext).slice(0, 3000)}\n\n` : "") +
    `Paragrafen:\n${payload}`;
  return askJson(
    [
      { role: "system", content: ANALYSE_PROMPT },
      { role: "user", content: user },
    ],
    (parsed) => validateAnalysis(parsed, paragraphs),
    { retries: 2, temperature: 0 }
  );
}

export const REFINE_PROMPT = `${ANALYSE_PROMPT}

EXTRA OPDRACHT — tweede, grondige controle:
Je krijgt hieronder ook een EERSTE VOORSTEL van de structuur. Controleer het kritisch en geef de volledige, verbeterde lijst terug in exact hetzelfde formaat:
- ontbreken er vragen of subvragen? voeg ze toe;
- horen vragen samen die nu los staan (of omgekeerd)? corrigeer;
- is het slot-type of "count" fout, of staat een slot op de verkeerde paragraaf (bv. vóór de vraag)? corrigeer;
- is iets geen echte vraag (titel, instructie, puntenverdeling, formuleblad)? verwijder het;
- staat er al een modelantwoord in het document? neem dat dan niet op als vraag.
Behoud alles wat al juist is.`;

/**
 * Tweede pass: laat het model het eerste voorstel kritisch nakijken. Mislukt dit, dan blijft het eerste voorstel gelden.
 * @returns {Promise<Array>} verbeterde (of ongewijzigde) vragenlijst
 */
export async function refineStructure(paragraphs, questions, { extraContext = "", subjectContext = "" } = {}) {
  if (!questions?.length) return questions || [];
  const payload = JSON.stringify(serializeForPrompt(paragraphs));
  const user =
    (extraContext ? `Extra instructies van de leerkracht: ${extraContext}\n\n` : "") +
    (subjectContext ? `Achtergrond over het vak:\n${String(subjectContext).slice(0, 3000)}\n\n` : "") +
    `Paragrafen:\n${payload}\n\nEerste voorstel:\n${JSON.stringify({ questions })}`;
  try {
    const refined = await askJson(
      [
        { role: "system", content: REFINE_PROMPT },
        { role: "user", content: user },
      ],
      (parsed) => validateAnalysis(parsed, paragraphs),
      { retries: 1, temperature: 0 }
    );
    return refined?.length ? refined : questions;
  } catch (err) {
    console.warn("[analyse] verfijnen mislukt, eerste voorstel behouden:", err.message);
    return questions;
  }
}
