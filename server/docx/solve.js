/**
 * solve.js — LLM-aanroep 2: één vraag/oefening oplossen en de slots invullen.
 * Daarna controleert verify.js de berekeningen; bij afwijkingen krijgt het model de
 * concrete fouten terug (max. 2 herpogingen). Blijft het fout, dan wordt de vraag
 * gemarkeerd als "handmatig nakijken".
 */

import { askJson } from "./llm.js";
import { verifySolution } from "./verify.js";

export const SOLVE_RULES = `Je lost een oefening op als leerkracht elektriciteit en vult de antwoordplaatsen van een verbetersleutel in.

NOTATIE (Belgische schrijfwijze):
- Vermenigvuldigen met " . " (bv. 230 V . 5 A), delen met " / ".
- Decimale komma (bv. 2,5), duizendtallen met een spatie (bv. 1 500 W).
- Reken tijd eerst om naar uren voor je energie (Wh/kWh) berekent.
- Vermogen in W of kW, energie in Wh of kWh (of J), rendement η in %, stroom in A, spanning in V, weerstand in Ω.
- Een kwadraat werk je uit met een tussenstap (bv. I² = 5² = 25).
- Gebruik de symbolen van het formularium (P, U, I, R, W, t, η, ...).
- Geef bij elk eindresultaat de eenheid.

CONTROLES:
- Geef per eindresultaat een check: {"expr":"<enkel getallen en + - * / ** ( )>", "expect":<getal>, "unit":"<eenheid>", "slot":"<para_id van het slot met dat resultaat>", "index":<optioneel positie bij meerdere invulpunten>}.
- "expr" gebruikt een punt als decimaalteken en bevat geen eenheden of woorden.
- Open vragen (uitleg, redeneren) hebben "checks": [].

SLOTS INVULLEN (exact het gevraagde aantal):
- fill_placeholders: "content" is een lijst met precies "count" strings, in volgorde van de invulpunten. Zet in elk invulpunt enkel de waarde met eenheid (bv. "230 V"), geen zin.
- fill_empty_following: lijst van maximaal "count" strings (één per lege lijn; tussenstappen mogen samengevoegd worden).
- append, insert_after, fill_cell: één string.

Antwoord UITSLUITEND met JSON:
{"qid":"...","steps":"korte uitleg van de oplossing","checks":[...],"slot_values":[{"para_id":"p_004","content":["..."]}]}
Geen tekst buiten de JSON.`;

function buildQuestionPrompt(q, byId) {
  const paraText = (id) => byId.get(id)?.text ?? "";
  const lines = [];
  lines.push(`Vraag ${q.qid}`);
  if (q.context) lines.push(`Context: ${q.context}`);
  lines.push("Opgave (paragrafen):");
  const ids = [...new Set([...q.question_para_ids, ...q.slots.map((s) => s.para_id)])];
  for (const id of ids) lines.push(`  [${id}] ${paraText(id)}`);
  lines.push("Slots die ingevuld moeten worden:");
  for (const s of q.slots) {
    lines.push(
      `  - para_id=${s.para_id} type=${s.type}` +
        (s.type === "fill_placeholders" || s.type === "fill_empty_following" ? ` count=${s.count}` : "") +
        (s.content ? ` (${s.content})` : "")
    );
  }
  return lines.join("\n");
}

/**
 * Valideert en normaliseert het oplossingsobject.
 * @returns {{qid:string, steps:string, checks:Array, slotValues:Array<{para_id,type,content}>}}
 */
export function validateSolution(parsed, q) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Verwacht een JSON-object met qid, steps, checks en slot_values.");
  }
  const values = Array.isArray(parsed.slot_values) ? parsed.slot_values : [];
  const errors = [];
  const out = [];

  for (const s of q.slots) {
    const v =
      values.find((x) => x?.para_id === s.para_id && (!x.type || x.type === s.type)) ||
      values.find((x) => x?.para_id === s.para_id);
    if (!v) {
      errors.push(`slot_values mist een waarde voor ${s.para_id}.`);
      continue;
    }
    let content = v.content;
    if (s.type === "fill_placeholders") {
      if (!Array.isArray(content)) content = content == null ? [] : [content];
      content = content.map((c) => String(c ?? "").trim());
      if (content.length !== s.count) {
        errors.push(`${s.para_id} verwacht exact ${s.count} waarde(n) (fill_placeholders), kreeg ${content.length}.`);
        continue;
      }
      if (content.some((c) => c === "")) {
        errors.push(`${s.para_id} bevat een lege waarde.`);
        continue;
      }
    } else if (s.type === "fill_empty_following") {
      if (!Array.isArray(content)) content = content == null ? [] : [content];
      content = content.map((c) => String(c ?? "").trim()).filter(Boolean);
      if (content.length === 0) {
        errors.push(`${s.para_id}: geen inhoud.`);
        continue;
      }
    } else {
      if (Array.isArray(content)) content = content.join("\n");
      content = String(content ?? "").trim();
      if (!content) {
        errors.push(`${s.para_id}: lege inhoud.`);
        continue;
      }
    }
    out.push({ para_id: s.para_id, type: s.type, content });
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const checks = Array.isArray(parsed.checks)
    ? parsed.checks.filter((c) => c && typeof c.expr === "string")
    : [];
  return { qid: String(parsed.qid ?? q.qid), steps: String(parsed.steps ?? ""), checks, slotValues: out };
}

/**
 * Lost één vraag op met controle-lus.
 *
 * @param {object} q  vraag uit analyseStructure
 * @param {Map<string,ParagraphInfo>} byId
 * @param {{systemPrompt?:string, subjectContext?:string, extraContext?:string, maxFix?:number}} opts
 * @returns {Promise<{qid, slots:Array, steps, flagged:boolean, issues:string[]}>}
 */
export async function solveQuestion(q, byId, opts = {}) {
  const { systemPrompt = "", subjectContext = "", extraContext = "", maxFix = 2 } = opts;
  const system = [systemPrompt, subjectContext, SOLVE_RULES].filter(Boolean).join("\n\n");
  const user =
    (extraContext ? `Extra instructies van de leerkracht: ${extraContext}\n\n` : "") +
    buildQuestionPrompt(q, byId);

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let solution = await askJson(messages, (p) => validateSolution(p, q), { retries: 2 });
  let issues = verifySolution(solution.checks, solution.slotValues).issues;

  for (let attempt = 0; issues.length > 0 && attempt < maxFix; attempt++) {
    messages.push({ role: "assistant", content: JSON.stringify({
      qid: solution.qid, steps: solution.steps, checks: solution.checks,
      slot_values: solution.slotValues.map(({ para_id, content }) => ({ para_id, content })),
    }) });
    messages.push({
      role: "user",
      content:
        "De automatische controle vond afwijkingen:\n- " + issues.join("\n- ") +
        "\nHerbereken, corrigeer de slot_values (of de check als die fout was) en stuur het volledige JSON-object opnieuw.",
    });
    try {
      solution = await askJson(messages, (p) => validateSolution(p, q), { retries: 1 });
    } catch (err) {
      issues = [...issues, `Herstelpoging mislukt: ${err.message}`];
      break;
    }
    issues = verifySolution(solution.checks, solution.slotValues).issues;
  }

  return {
    qid: q.qid,
    slots: solution.slotValues,
    steps: solution.steps,
    flagged: issues.length > 0,
    issues,
    openQuestion: solution.checks.length === 0,
  };
}
