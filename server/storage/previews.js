/**
 * previews.js — PDF-weergave en miniatuur (eerste pagina) van originelen en gegenereerde sleutels.
 *
 * Best effort en op de achtergrond: ontbreken LibreOffice/poppler, of mislukt de conversie,
 * dan blijft `preview_status` op 'mislukt' / 'geen' en werkt de rest van de app gewoon.
 * Conversies lopen in een wachtrij (één tegelijk) omdat LibreOffice zwaar is.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { toolsAvailable, convertToPdf, renderPages } from "../docx/visual.js";
import { storeFile, getFileRecord } from "./files.js";
import { getDb } from "./db.js";
import { updateDocument, updateVersion, getDocument, getVersion } from "./repo.js";

let chain = Promise.resolve();

function enqueue(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/** Zet een bronbestand om naar { pdf: Buffer|null, thumb: Buffer|null }. */
async function render(srcAbs, ext) {
  const tools = await toolsAvailable();
  if (!tools.pdftoppm) return { pdf: null, thumb: null };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vr-prev-"));
  try {
    let pdfPath;
    let pdfBuf = null;
    if (ext === ".pdf") {
      pdfPath = path.join(work, "bron.pdf");
      fs.copyFileSync(srcAbs, pdfPath);
    } else if ([".docx", ".pptx", ".xlsx", ".xls"].includes(ext) && tools.soffice) {
      const copy = path.join(work, `${randomUUID()}${ext}`);
      fs.copyFileSync(srcAbs, copy);
      pdfPath = await convertToPdf(copy, work, tools.soffice);
      pdfBuf = fs.readFileSync(pdfPath);
    } else {
      return { pdf: null, thumb: null };
    }
    const outDir = path.join(work, "png");
    fs.mkdirSync(outDir);
    const pages = await renderPages(pdfPath, outDir, { dpi: 60, maxPages: 1 });
    return { pdf: pdfBuf, thumb: pages[0] || null };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Maakt PDF + miniatuur voor het origineel van een document (op de achtergrond). */
export function generateOriginalPreview(docId) {
  return enqueue(async () => {
    try {
      const doc = getDocument(docId);
      if (!doc) return;
      const rec = getFileRecord(doc.originalFileId);
      if (!rec || !fs.existsSync(rec.abs)) return;
      const ext = path.extname(rec.abs).toLowerCase();
      const { pdf, thumb } = await render(rec.abs, ext);
      const patch = { previewStatus: thumb ? "klaar" : "mislukt" };
      if (pdf) patch.originalPdfFileId = storeFile({ docId, buffer: pdf, ext: ".pdf" });
      if (thumb) patch.originalThumbFileId = storeFile({ docId, buffer: thumb, ext: ".png" });
      if (ext === ".pdf") {
        // Het origineel is zelf de PDF
        patch.originalPdfFileId = doc.originalFileId;
      }
      // Het document kan ondertussen definitief verwijderd zijn
      if (getDocument(docId)) updateDocument(docId, patch);
    } catch (err) {
      console.warn("[preview] origineel mislukt:", err.message);
      try {
        if (getDocument(docId)) updateDocument(docId, { previewStatus: "mislukt" });
      } catch {
        /* negeren */
      }
    }
  });
}

/** Maakt PDF + miniatuur voor een gegenereerde versie (op de achtergrond). */
export function generateVersionPreview(docId, versionNumber) {
  return enqueue(async () => {
    try {
      const v = getVersion(docId, versionNumber);
      if (!v || !v.docxFileId) return;
      const rec = getFileRecord(v.docxFileId);
      if (!rec || !fs.existsSync(rec.abs)) return;
      const { pdf, thumb } = await render(rec.abs, path.extname(rec.abs).toLowerCase());
      if (!getDocument(docId)) return;
      const patch = {};
      if (pdf) patch.pdfFileId = storeFile({ docId, buffer: pdf, ext: ".pdf" });
      if (thumb) patch.thumbFileId = storeFile({ docId, buffer: thumb, ext: ".png" });
      if (Object.keys(patch).length) updateVersion(docId, versionNumber, patch);
    } catch (err) {
      console.warn("[preview] versie mislukt:", err.message);
    }
  });
}

/** Wachtende previews afwachten (voor tests). */
export function previewsIdle() {
  return chain;
}

/** Documenten zonder preview opnieuw proberen (bij het opstarten). */
export function retryMissingPreviews(limit = 20) {
  const rows = getDb()
    .prepare(`SELECT id FROM documents WHERE preview_status IN ('geen') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  for (const r of rows) generateOriginalPreview(r.id);
}
