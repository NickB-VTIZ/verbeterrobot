/**
 * pipeline.js — volledige .docx-verwerking: extractie → analyse → oplossen → controle → invoegen → QC.
 *
 * De code opent, leest en schrijft het document; het taalmodel levert enkel JSON.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { extractParagraphs, W_NS, countPlaceholders } from "./extract.js";
import { analyseStructure, refineStructure } from "./analyse.js";
import { solveQuestion } from "./solve.js";
import { applySlots, serializeDocument } from "./insert.js";
import { visualCheck } from "./visual.js";
import { getSettings } from "../settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = path.join(__dirname, "..", "..", "uploads");

/** Telt paragrafen op dezelfde manier als de extractor (zonder dubbele Fallback-inhoud). */
function countParagraphs(xml) {
  new DOMParser().parseFromString(xml, "application/xml"); // gooit bij ongeldige XML
  return extractParagraphs(xml).paragraphs.length;
}

/** Eenvoudige concurrency-limiet. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Pure kern zonder LLM: past opgeloste slots toe op document.xml en voert de QC uit.
 * (Apart geëxporteerd zodat dit deterministisch getest kan worden.)
 *
 * @returns {{xml:string, applied:number, warnings:string[], qc:string[], unplaced:Array, insertedParagraphs:number, paragraphsBefore:number, paragraphsAfter:number}}
 */
export function applySolutionsToXml(xmlString, buildSlots) {
  const { doc, paragraphs } = extractParagraphs(xmlString);
  const before = paragraphs.length;
  const slots = buildSlots(paragraphs);
  const { applied, warnings, unplaced, insertedParagraphs } = applySlots(doc, paragraphs, slots);

  // Placeholders in paragrafen die we invulden: moeten weg zijn (tenzij een waarde ontbrak)
  const filledIds = new Set(slots.filter((s) => s.type === "fill_placeholders").map((s) => s.para_id));
  const stillDots = paragraphs
    .filter((p) => filledIds.has(p.id))
    .filter((p) => {
      const t = Array.from(p._node.getElementsByTagNameNS(W_NS, "t"))
        .map((n) => n.textContent || "")
        .join("");
      return countPlaceholders(t) > 0;
    })
    .map((p) => p.id);

  const xml = serializeDocument(doc, paragraphs);

  const qc = [];
  let paragraphsAfter = null;
  try {
    paragraphsAfter = countParagraphs(xml);
    const after = paragraphsAfter;
    if (after - before !== insertedParagraphs) {
      qc.push(`Aantal paragrafen klopt niet: verwacht +${insertedParagraphs}, gevonden ${after - before >= 0 ? "+" : ""}${after - before}.`);
    }
  } catch (err) {
    qc.push(`Resultaat-XML is niet geldig: ${err.message}`);
  }
  if (stillDots.length) qc.push(`Invulpunten niet ingevuld in: ${stillDots.join(", ")}.`);
  return {
    xml,
    applied,
    warnings,
    qc,
    unplaced,
    insertedParagraphs,
    paragraphsBefore: before,
    paragraphsAfter,
  };
}

/** Leest document.xml uit een .docx. */
async function loadDocx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("word/document.xml ontbreekt in het bestand.");
  const xmlString = await docFile.async("string");
  return { zip, xmlString };
}

/**
 * Schrijft een sleutel-docx op basis van het origineel en een lijst opgeloste slots.
 * Gebruikt door de pipeline én door de review (bewerken/opnieuw genereren).
 */
export async function buildOutputDocx(filePath, slots) {
  const { zip, xmlString } = await loadDocx(filePath);
  const result = applySolutionsToXml(xmlString, () => slots);
  zip.file("word/document.xml", result.xml);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.mkdirSync(UPLOADS, { recursive: true });
  const outputPath = path.join(UPLOADS, `${randomUUID()}_output.docx`);
  fs.writeFileSync(outputPath, buffer);
  return { outputPath, result };
}

/** Geeft de geëxtraheerde paragrafen van een docx (voor de HTML-weergave en het opslaan). */
export async function extractDocxParagraphs(filePath) {
  const { xmlString } = await loadDocx(filePath);
  return extractParagraphs(xmlString).paragraphs;
}

/**
 * Laat het taalmodel een voorstel doen voor de structuur (vragen + antwoordplaatsen).
 * Met `refine` volgt een tweede, kritische controle-pass (grondiger, maar een extra LLM-aanroep).
 */
export async function proposeStructure(filePath, { extraContext = "", subjectContext = "", refine = false } = {}) {
  const { xmlString } = await loadDocx(filePath);
  const { paragraphs } = extractParagraphs(xmlString);
  let questions = await analyseStructure(paragraphs, { extraContext, subjectContext });
  if (refine) questions = await refineStructure(paragraphs, questions, { extraContext, subjectContext });
  return { paragraphs, questions };
}

/**
 * @param {string} filePath  origineel .docx
 * @param {object} opts
 *   extraContext, subjectContext, concurrency
 *   questions      : vooraf opgebouwde vragen (uit de markeringen van de leerkracht) → analyse wordt overgeslagen
 *   teacherAnswers : { [qid]: tekst } — antwoord/notatie van de leerkracht, krijgt voorrang
 *   only           : [qid] — enkel deze vragen (opnieuw) oplossen; de rest komt uit `reuseSlots`
 *   reuseSlots     : bestaande slots (met qid) die behouden blijven voor vragen buiten `only`
 *   comments       : { [qid]: opmerking van de leerkracht } bij opnieuw genereren
 *   previous       : { [qid]: vorig antwoord (tekst) }
 *   skipVisual     : sla de visuele controle over
 * @returns {Promise<{outputPath:string, questions:number, review:Array, warnings:string[]} | null>}
 *          null als er geen vragen/slots gevonden zijn (de aanroeper valt dan terug op de klassieke flow).
 */
export async function runDocxPipeline(
  filePath,
  {
    extraContext = "",
    subjectContext = "",
    concurrency = 3,
    questions: givenQuestions = null,
    teacherAnswers = {},
    only = null,
    reuseSlots = [],
    comments = {},
    previous = {},
    skipVisual = false,
  } = {}
) {
  const { xmlString } = await loadDocx(filePath);

  // 1. Extractie
  const { paragraphs } = extractParagraphs(xmlString);
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  if (paragraphs.filter((p) => p.text.trim()).length === 0) return null;

  // 2. Structuuranalyse (LLM 1) — of de markeringen van de leerkracht
  const questions = givenQuestions ? givenQuestions : await analyseStructure(paragraphs, { extraContext });
  if (questions.length === 0) return null;

  // 3. Oplossen + controle (LLM 2, per vraag)
  const systemPrompt = getSettings().systemPrompt || "";
  const onlySet = only ? new Set(only) : null;
  const toSolve = onlySet ? questions.filter((q) => onlySet.has(q.qid)) : questions;
  const solved = await mapLimit(toSolve, concurrency, async (q) => {
    try {
      const r = await solveQuestion(q, byId, {
        systemPrompt,
        subjectContext,
        extraContext,
        teacherAnswer: teacherAnswers[q.qid] || "",
        comment: comments[q.qid] || "",
        previous: previous[q.qid] || "",
      });
      return { ...r, slots: (r.slots || []).map((s) => ({ ...s, qid: q.qid })) };
    } catch (err) {
      return { qid: q.qid, slots: [], flagged: true, issues: [`Oplossen mislukt: ${err.message}`], error: true };
    }
  });

  const kept = onlySet ? reuseSlots.filter((s) => !onlySet.has(s.qid)) : [];
  const slots = [...kept, ...solved.flatMap((s) => s.slots)];
  if (slots.length === 0) return null;

  // 4. Invoegen (code) + QC; werkt op een verse DOM zodat de ID's gelijk blijven
  const { outputPath, result } = await buildOutputDocx(filePath, slots);

  // 5. Log: wat moet de leerkracht zelf nakijken?
  const review = solved
    .filter((s) => s.flagged || s.openQuestion)
    .map((s) => ({
      qid: s.qid,
      reden: s.flagged ? s.issues.join(" | ") : "Open vraag: niet automatisch gecontroleerd.",
    }));
  // Slots zonder geldige plaats: foutmelding in de log + handmatig nakijken (nooit tekst achteraan)
  const qidByPara = new Map();
  for (const q of questions) for (const s of q.slots) qidByPara.set(s.para_id, q.qid);
  for (const u of result.unplaced) {
    const qid = qidByPara.get(u.para_id) || "?";
    console.error(`docx-pipeline: handmatig nakijken — vraag ${qid}, slot ${u.type} op ${u.para_id}: ${u.reason}`);
    review.push({ qid, reden: `Handmatig nakijken: antwoord niet geplaatst (${u.reason})` });
  }

  // 6. Visuele controle (LibreOffice → PDF → PNG → vision-model); nooit fataal
  let visual = { status: "skipped", issues: [], clarifications: [], pages: 0, note: "" };
  if (!skipVisual) {
    try {
      visual = await visualCheck({ outputPath, originalPath: filePath, slots });
    } catch (err) {
      visual.note = `Visuele controle mislukt: ${err.message}`;
    }
  }
  for (const issue of visual.issues) review.push({ qid: "layout", reden: issue });

  return {
    outputPath,
    questions: questions.length,
    slots,
    questionList: questions,
    unplaced: result.unplaced,
    review,
    warnings: [...result.warnings, ...result.qc, ...(visual.note ? [visual.note] : [])],
    visual,
    clarifications: visual.clarifications,
  };
}
