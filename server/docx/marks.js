/**
 * marks.js — van aanduidingen van de leerkracht (rollen per paragraaf) naar vragen met slots,
 * en omgekeerd van een LLM-voorstel (analyse) naar aanduidingen.
 *
 * Rollen: vraag, antwoordplaats, gegeven, formuleblad, instructie, modelantwoord.
 * Een "qid" koppelt de aanduidingen aan elkaar (vraag ↔ antwoordplaats ↔ gegeven ↔ modelantwoord).
 */

import { validateAnalysis } from "./analyse.js";

/** Voorstel voor het slot-type van een paragraaf die als antwoordplaats is aangeduid. */
export function defaultSlot(p, paragraphs) {
  const idx = paragraphs.findIndex((x) => x.id === p.id);
  if (p.placeholders > 0) return { slotType: "fill_placeholders", slotCount: p.placeholders };
  if (p.inTable && p.isEmpty) return { slotType: "fill_cell", slotCount: 1 };
  if (p.isEmpty) {
    // lege lijn: antwoord komt in de lege paragraaf zelf
    return { slotType: "append", slotCount: 1 };
  }
  // paragraaf met tekst: staan er lege lijnen onder, dan daar; anders erachter
  let avail = 0;
  for (let k = idx + 1; k < paragraphs.length; k++) {
    const n = paragraphs[k];
    if (!n.isEmpty || n.inTable !== p.inTable) break;
    avail++;
  }
  if (avail > 0) return { slotType: "fill_empty_following", slotCount: Math.min(avail, 3) };
  return { slotType: "insert_after", slotCount: 1 };
}

/**
 * Zet LLM-vragen (analyseStructure) om naar aanduidingen.
 * @returns {Array<{paraId, role, qid, slotType?, slotCount?}>}
 */
export function questionsToMarks(questions) {
  const marks = [];
  const seen = new Set();
  for (const q of questions) {
    for (const id of q.question_para_ids || []) {
      const k = `vraag:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      marks.push({ paraId: id, role: "vraag", qid: q.qid });
    }
    for (const s of q.slots || []) {
      marks.push({
        paraId: s.para_id,
        role: "antwoordplaats",
        qid: q.qid,
        slotType: s.type,
        slotCount: s.count,
        linkedParaIds: (q.question_para_ids || []).slice(0, 1),
      });
    }
  }
  return marks;
}

function textOf(paragraphs, ids) {
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  return ids
    .map((id) => byId.get(id)?.text?.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Bouwt de vragenlijst voor de pipeline op uit de aanduidingen van de leerkracht.
 * Valideert de slots (zelfde regels als bij de LLM-analyse).
 *
 * @returns {{questions:Array, teacherAnswers:Object, reference:string, errors:string[], warnings:string[]}}
 */
export function marksToQuestions(marks, paragraphs) {
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const errors = [];
  const warnings = [];

  const valid = marks.filter((m) => {
    if (!byId.has(m.paraId)) {
      errors.push(`Paragraaf ${m.paraId} bestaat niet (meer) in het document.`);
      return false;
    }
    return true;
  });

  const qids = [];
  const add = (qid) => {
    if (qid && !qids.includes(qid)) qids.push(qid);
  };
  for (const m of valid) if (m.role === "vraag" || m.role === "antwoordplaats") add(m.qid);

  // Antwoordplaatsen zonder vraag: eigen (naamloze) vraag per plaats
  let auto = 1;
  const marksOf = (qid) => valid.filter((m) => m.qid === qid);
  const rawQuestions = [];

  const orphanSlots = valid.filter((m) => m.role === "antwoordplaats" && !m.qid);
  for (const m of orphanSlots) {
    let qid;
    do {
      qid = `x${auto++}`;
    } while (qids.includes(qid));
    qids.push(qid);
    m.qid = qid;
    warnings.push(`Antwoordplaats ${m.paraId} was niet aan een vraag gekoppeld; er werd een eigen vraag '${qid}' van gemaakt.`);
  }

  const globalContext = valid.filter((m) => m.role === "gegeven" && !m.qid).map((m) => m.paraId);
  const reference = textOf(
    paragraphs,
    valid.filter((m) => m.role === "formuleblad").map((m) => m.paraId)
  ).slice(0, 6000);

  const teacherAnswers = {};
  const orderIdx = new Map(paragraphs.map((p, i) => [p.id, i]));
  const sortIds = (ids) => [...new Set(ids)].sort((a, b) => (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0));

  for (const qid of qids) {
    const ms = marksOf(qid);
    const questionIds = sortIds(ms.filter((m) => m.role === "vraag").map((m) => m.paraId));
    const slotMarks = ms.filter((m) => m.role === "antwoordplaats");
    if (slotMarks.length === 0) {
      warnings.push(`Vraag ${qid} heeft geen antwoordplaats en wordt overgeslagen.`);
      continue;
    }
    const givenIds = sortIds([...ms.filter((m) => m.role === "gegeven").map((m) => m.paraId), ...globalContext]);
    const slots = slotMarks.map((m) => {
      const p = byId.get(m.paraId);
      const def = defaultSlot(p, paragraphs);
      const type = m.slotType || def.slotType;
      const count = Number(m.slotCount) || def.slotCount;
      return {
        para_id: m.paraId,
        type,
        count,
        content: "",
      };
    });
    rawQuestions.push({
      qid,
      question_para_ids: questionIds,
      context: textOf(paragraphs, givenIds).slice(0, 4000),
      slots,
    });

    const ownAnswers = ms
      .filter((m) => m.teacherAnswer && m.teacherAnswer.trim())
      .map((m) => m.teacherAnswer.trim());
    const modelAnswers = textOf(
      paragraphs,
      ms.filter((m) => m.role === "modelantwoord").map((m) => m.paraId)
    );
    const combined = [...ownAnswers, modelAnswers ? `Modelantwoord uit het document:\n${modelAnswers}` : ""].filter(Boolean);
    if (combined.length) teacherAnswers[qid] = combined.join("\n");
  }

  const checked = validateAnalysis({ questions: rawQuestions }, paragraphs, { collect: true, skipCoverage: true });
  errors.push(...checked.errors);

  // Invulpunten die nergens in een slot zitten: waarschuwing (blijft onaangeroerd, nooit gokken)
  const covered = new Set(checked.questions.flatMap((q) => q.slots.map((s) => s.para_id)));
  for (const p of paragraphs) {
    if (p.placeholders > 0 && !covered.has(p.id)) {
      const role = valid.find((m) => m.paraId === p.id)?.role;
      if (role !== "instructie" && role !== "formuleblad" && role !== "modelantwoord") {
        warnings.push(`Paragraaf ${p.id} heeft ${p.placeholders} invulpunt(en) maar is niet als antwoordplaats aangeduid.`);
      }
    }
  }

  return { questions: checked.questions, teacherAnswers, reference, errors, warnings };
}
