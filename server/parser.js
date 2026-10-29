/**
 * parser.js — tekst extraheren uit verschillende documentformaten
 * Ondersteunde formaten: .docx, .pdf, .pptx, .xlsx, .xls, .txt
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} filePath  Absoluut pad naar het uploadbestand
 * @param {string} ext       Bestandsextensie (lowercase, incl. punt)
 * @returns {Promise<string>} Geëxtraheerde platte tekst
 */
export async function parseDocument(filePath, ext) {
  switch (ext) {
    case ".docx":
      return parseDocx(filePath);
    case ".pdf":
      return parsePdf(filePath);
    case ".pptx":
      return parsePptx(filePath);
    case ".xlsx":
    case ".xls":
      return parseXlsx(filePath);
    case ".txt":
      return fs.promises.readFile(filePath, "utf-8");
    default:
      throw new Error(`Niet-ondersteund formaat: ${ext}`);
  }
}

// ── .docx ──────────────────────────────────────────────────────────────
async function parseDocx(filePath) {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

// ── .pdf ───────────────────────────────────────────────────────────────
async function parsePdf(filePath) {
  // pdf-parse verwacht een Buffer
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

// ── .pptx ──────────────────────────────────────────────────────────────
async function parsePptx(filePath) {
  const officeParser = await import("officeparser");
  return new Promise((resolve, reject) => {
    officeParser.parseOffice(filePath, (data, err) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

// ── .xlsx / .xls ───────────────────────────────────────────────────────
async function parseXlsx(filePath) {
  const XLSX = (await import("xlsx")).default;
  const workbook = XLSX.readFile(filePath);
  const lines = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      lines.push(`=== Werkblad: ${sheetName} ===`);
      lines.push(csv);
    }
  }
  return lines.join("\n");
}
