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
import { analyseStructure } from "./analyse.js";
import { solveQuestion } from "./solve.js";
import { applySlots, serializeDocument } from "./insert.js";
import { visualCheck } from "./visual.js";
import { getSettings } from "../settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = path.join(__dirname, "..", "..", "uploads");

function countParagraphs(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.getElementsByTagNameNS(W_NS, "p").length;
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
 * @returns {{xml:string, applied:number, warnings:string[], qc:string[]}}
 */
export function applySolutionsToXml(xmlString, buildSlots) {
  const { doc, paragraphs } = extractParagraphs(xmlString);
  const before = paragraphs.length;
  const slots = buildSlots(paragraphs);
  const { applied, warnings, insertedParagraphs } = applySlots(doc, paragraphs, slots);

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
  try {
    const after = countParagraphs(xml);
    if (after - before !== insertedParagraphs) {
      qc.push(`Aantal paragrafen klopt niet: verwacht +${insertedParagraphs}, gevonden ${after - before >= 0 ? "+" : ""}${after - before}.`);
    }
  } catch (err) {
    qc.push(`Resultaat-XML is niet geldig: ${err.message}`);
  }
  if (stillDots.length) qc.push(`Invulpunten niet ingevuld in: ${stillDots.join(", ")}.`);
  return { xml, applied, warnings, qc };
}

/**
 * @param {string} filePath  origineel .docx
 * @param {{extraContext?:string, subjectContext?:string, concurrency?:number}} opts
 * @returns {Promise<{outputPath:string, questions:number, review:Array, warnings:string[]} | null>}
 *          null als er geen vragen/slots gevonden zijn (de aanroeper valt dan terug op de klassieke flow).
 */
export async function runDocxPipeline(filePath, { extraContext = "", subjectContext = "", concurrency = 3 } = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("word/document.xml ontbreekt in het bestand.");
  const xmlString = await docFile.async("string");

  // 1. Extractie
  const { paragraphs } = extractParagraphs(xmlString);
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  if (paragraphs.filter((p) => p.text.trim()).length === 0) return null;

  // 2. Structuuranalyse (LLM 1)
  const questions = await analyseStructure(paragraphs, { extraContext });
  if (questions.length === 0) return null;

  // 3. Oplossen + controle (LLM 2, per vraag)
  const systemPrompt = getSettings().systemPrompt || "";
  const solved = await mapLimit(questions, concurrency, async (q) => {
    try {
      return await solveQuestion(q, byId, { systemPrompt, subjectContext, extraContext });
    } catch (err) {
      return { qid: q.qid, slots: [], flagged: true, issues: [`Oplossen mislukt: ${err.message}`], error: true };
    }
  });

  const slots = solved.flatMap((s) => s.slots);
  if (slots.length === 0) return null;

  // 4. Invoegen (code) + QC; werkt op een verse DOM zodat de ID's gelijk blijven
  const result = applySolutionsToXml(xmlString, () => slots);

  zip.file("word/document.xml", result.xml);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const outputPath = path.join(UPLOADS, `${randomUUID()}_output.docx`);
  fs.writeFileSync(outputPath, buffer);

  // 5. Log: wat moet de leerkracht zelf nakijken?
  const review = solved
    .filter((s) => s.flagged || s.openQuestion)
    .map((s) => ({
      qid: s.qid,
      reden: s.flagged ? s.issues.join(" | ") : "Open vraag: niet automatisch gecontroleerd.",
    }));

  // 6. Visuele controle (LibreOffice → PDF → PNG → vision-model); nooit fataal
  let visual = { status: "skipped", issues: [], clarifications: [], pages: 0, note: "" };
  try {
    visual = await visualCheck({ outputPath, originalPath: filePath, slots });
  } catch (err) {
    visual.note = `Visuele controle mislukt: ${err.message}`;
  }
  for (const issue of visual.issues) review.push({ qid: "layout", reden: issue });

  return {
    outputPath,
    questions: questions.length,
    review,
    warnings: [...result.warnings, ...result.qc, ...(visual.note ? [visual.note] : [])],
    visual,
    clarifications: visual.clarifications,
  };
}
