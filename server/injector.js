/**
 * injector.js — Antwoorden in rood injecteren in het originele document
 *
 * Per formaat:
 *  .docx  → docx-library: rode run na elke paragraaf die een vraag bevat
 *  .pdf   → pdf-lib: rode tekstannotatie per pagina waar de vraag voorkomt
 *  .pptx  → JSZip + XML: rode tekst-run na elke tekst die een vraag bevat
 *  .xlsx  → ExcelJS: rode cel onder/naast de vraagcel
 *  .txt   → tekstbestand met [ANTWOORD: ...] toegevoegd na elke vraag
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = path.join(__dirname, "..", "uploads");

const RED = "FF0000";

/**
 * @param {string} filePath  Pad naar het originele uploadbestand
 * @param {string} ext       Bestandsextensie (.docx, .pdf, ...)
 * @param {Array<{vraag: string, antwoord: string}>} answers
 * @returns {Promise<string>} Pad naar het nieuw gegenereerde outputbestand
 */
export async function injectAnswers(filePath, ext, answers) {
  switch (ext) {
    case ".docx":
      return injectDocx(filePath, answers);
    case ".pdf":
      return injectPdf(filePath, answers);
    case ".pptx":
      return injectPptx(filePath, answers);
    case ".xlsx":
    case ".xls":
      return injectXlsx(filePath, answers);
    case ".txt":
      return injectTxt(filePath, answers);
    default:
      throw new Error(`Injectie niet ondersteund voor formaat: ${ext}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

// Let op: "\u0026" is het &-teken. Unicode-escapes voorkomen dat entiteiten in de broncode worden gedecodeerd.
const XML_ESCAPES = {
  "\u0026": "\u0026amp;",
  "\u003C": "\u0026lt;",
  "\u003E": "\u0026gt;",
  "\u0022": "\u0026quot;",
};

function escapeXml(s) {
  return String(s).replace(/[\u0026\u003C\u003E\u0022]/g, (ch) => XML_ESCAPES[ch]);
}

function outputPath(ext) {
  return path.join(UPLOADS, `${randomUUID()}_output${ext}`);
}

/**
 * Controleer of een tekst een van de vragen bevat (fuzzy: eerste 80 tekens).
 * @param {string} text
 * @param {Array<{vraag:string, antwoord:string}>} answers
 * @returns {{vraag:string, antwoord:string}|null}
 */
function findMatchingAnswer(text, answers) {
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  for (const qa of answers) {
    const qNorm = qa.vraag.toLowerCase().replace(/\s+/g, " ").trim();
    // Exacte match of de tekst bevat de eerste 60 tekens van de vraag
    const snippet = qNorm.slice(0, 60);
    if (snippet.length > 3 && normalised.includes(snippet)) {
      return qa;
    }
  }
  return null;
}

// ── .docx ──────────────────────────────────────────────────────────────
async function injectDocx(filePath, answers) {
  // Lees de ruwe XML van het originele .docx via JSZip
  const JSZip = (await import("jszip")).default;
  const zipBuffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(zipBuffer);

  // Haal document.xml op
  const docXml = await zip.file("word/document.xml").async("string");

  // We injecteren rode tekst door de XML te manipuleren:
  // Na elke <w:p> die een vraagtekst bevat, voegen we een extra rode paragraaf in.
  const injectedXml = injectRedParagraphsInDocXml(docXml, answers);

  // Schrijf terug in het zip-archief
  zip.file("word/document.xml", injectedXml);

  const out = outputPath(".docx");
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(out, buffer);
  return out;
}

/**
 * Injecteer rode <w:p>-paragrafen na elke vraagragraaf in de Word XML.
 */
function injectRedParagraphsInDocXml(xml, answers) {
  const remaining = [...answers];

  // Elke <w:p ...>...</w:p> afzonderlijk behandelen; de rest van de XML blijft ongewijzigd.
  return xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para) => {
    // Platte tekst: tags weggooien zonder spatie (tekst kan over meerdere runs verspreid zijn)
    const paraText = decodeXmlEntities(para.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!paraText) return para;

    const match = findMatchingAnswer(paraText, remaining);
    if (!match) return para;

    // Elk antwoord maar één keer gebruiken
    remaining.splice(remaining.indexOf(match), 1);
    return para + buildRedParagraph(match.antwoord);
  });
}

function decodeXmlEntities(s) {
  return s
    .replace(/\u0026lt;/g, "\u003C")
    .replace(/\u0026gt;/g, "\u003E")
    .replace(/\u0026quot;/g, "\u0022")
    .replace(/\u0026apos;/g, "'")
    .replace(/\u0026#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\u0026amp;/g, "\u0026");
}

/**
 * Bouw een rode <w:p>-paragraaf met het antwoord als XML-string.
 */
function buildRedParagraph(antwoord) {
  const escaped = escapeXml(antwoord);

  return (
    `<w:p>` +
    `<w:pPr><w:jc w:val="left"/></w:pPr>` +
    `<w:r>` +
    `<w:rPr><w:color w:val="${RED}"/><w:b/></w:rPr>` +
    `<w:t xml:space="preserve">✓ ${escaped}</w:t>` +
    `</w:r>` +
    `</w:p>`
  );
}

// ── .pdf ───────────────────────────────────────────────────────────────
async function injectPdf(filePath, answers) {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

  const pdfBytes = fs.readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();
  const red = rgb(0.85, 0, 0);

  // PDF-layout inline aanpassen is onbetrouwbaar. De originele pagina's blijven daarom
  // 100% ongewijzigd en de verbetersleutel (in rood) komt op extra pagina(s) achteraan.
  const { width, height } = pages[pages.length - 1].getSize();
  const margin = 40;
  const lineHeight = 15;
  const charSet = new Set(font.getCharacterSet());
  // Standaard PDF-lettertypes ondersteunen niet alle tekens: onbekende tekens vervangen door '?'
  const safe = (s) =>
    Array.from(String(s).replace(/\s+/g, " "))
      .map((ch) => (charSet.has(ch.codePointAt(0)) ? ch : "?"))
      .join("");

  let page = null;
  let yPos = 0;
  const newPage = (title) => {
    page = pdfDoc.addPage([width, height]);
    page.drawText(title, { x: margin, y: height - 50, size: 14, font, color: red });
    page.drawLine({
      start: { x: margin, y: height - 60 },
      end: { x: width - margin, y: height - 60 },
      thickness: 1,
      color: red,
    });
    yPos = height - 85;
  };
  const writeLines = (lines, x, size) => {
    for (const line of lines) {
      if (yPos < 50) newPage("VERBETERSLEUTEL (vervolg)");
      page.drawText(line, { x, y: yPos, size, font, color: red });
      yPos -= lineHeight;
    }
  };

  newPage("VERBETERSLEUTEL");
  for (const qa of answers) {
    writeLines(wrapText(safe(qa.vraag), 95), margin, 10);
    writeLines(wrapText(`-> ${safe(qa.antwoord)}`, 90), margin + 12, 10);
    yPos -= 6;
  }

  const out = outputPath(".pdf");
  const outBytes = await pdfDoc.save();
  fs.writeFileSync(out, outBytes);
  return out;
}

function wrapText(text, maxLen) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxLen) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

// ── .pptx ──────────────────────────────────────────────────────────────
async function injectPptx(filePath, answers) {
  const JSZip = (await import("jszip")).default;
  const zipBuffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(zipBuffer);

  // Verwerk elke slide
  const slideFiles = Object.keys(zip.files).filter(
    (f) => f.match(/^ppt\/slides\/slide\d+\.xml$/)
  );

  for (const slideFile of slideFiles) {
    let slideXml = await zip.file(slideFile).async("string");
    slideXml = injectRedRunsInPptxSlide(slideXml, answers);
    zip.file(slideFile, slideXml);
  }

  const out = outputPath(".pptx");
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(out, buffer);
  return out;
}

/**
 * Na elke <a:p> met een vraagtekst een extra rode run invoegen.
 */
function injectRedRunsInPptxSlide(xml, answers) {
  // Splits op <a:p>-niveau
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (match, inner) => {
    const paraText = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const found = findMatchingAnswer(paraText, answers);
    if (!found) return match;

    const escaped = escapeXml(found.antwoord);

    const redRun =
      `<a:r>` +
      `<a:rPr lang="nl-BE" dirty="0">` +
      `<a:solidFill><a:srgbClr val="${RED}"/></a:solidFill>` +
      `<a:latin typeface="+mj-lt"/>` +
      `</a:rPr>` +
      `<a:t> ✓ ${escaped}</a:t>` +
      `</a:r>`;

    return `<a:p>${inner}${redRun}</a:p>`;
  });
}

// ── .xlsx ──────────────────────────────────────────────────────────────
async function injectXlsx(filePath, answers) {
  const ExcelJS = (await import("exceljs")).default;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  for (const worksheet of workbook.worksheets) {
    const rowsToInsert = []; // { afterRow, qa }

    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        const cellText = String(cell.value || "");
        const match = findMatchingAnswer(cellText, answers);
        if (match) {
          rowsToInsert.push({ afterRow: rowNumber, qa: match });
        }
      });
    });

    // Voeg antwoord-rijen in (van onder naar boven zodat rijnummers kloppen)
    for (const { afterRow, qa } of rowsToInsert.reverse()) {
      worksheet.spliceRows(afterRow + 1, 0, [`✓ ${qa.antwoord}`]);
      const newRow = worksheet.getRow(afterRow + 1);
      newRow.eachCell((cell) => {
        cell.font = { color: { argb: `FF${RED}` }, bold: true };
      });
    }
  }

  const out = outputPath(".xlsx");
  await workbook.xlsx.writeFile(out);
  return out;
}

// ── .txt ───────────────────────────────────────────────────────────────
async function injectTxt(filePath, answers) {
  const original = await fs.promises.readFile(filePath, "utf-8");
  const lines = original.split("\n");
  const result = [];

  for (const line of lines) {
    result.push(line);
    const match = findMatchingAnswer(line, answers);
    if (match) {
      result.push(`  [ANTWOORD] ✓ ${match.antwoord}`);
    }
  }

  const out = outputPath(".txt");
  await fs.promises.writeFile(out, result.join("\n"), "utf-8");
  return out;
}
