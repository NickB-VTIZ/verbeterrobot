// Smoke test voor PDF- en TXT-injectie.
import { PDFDocument, StandardFonts } from "pdf-lib";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { injectAnswers } from "../server/injector.js";

const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage().drawText("1. Wat is 2 + 2?", { x: 50, y: 700, size: 12, font: f });
const pdfPath = path.join(os.tmpdir(), "vr-test.pdf");
await fs.writeFile(pdfPath, await doc.save());

const answers = Array.from({ length: 40 }, (_, i) => ({
  vraag: `${i + 1}. Vraag nummer ${i + 1} met speciaal teken \u2264 en \u00E9`,
  antwoord: `Antwoord ${i + 1} \u2713 `.repeat(6),
}));

const out = await injectAnswers(pdfPath, ".pdf", answers);
const res = await PDFDocument.load(await fs.readFile(out));
console.log("PDF paginas na injectie:", res.getPageCount(), "(verwacht > 2)");

const txtPath = path.join(os.tmpdir(), "vr-test.txt");
await fs.writeFile(txtPath, "1. Wat is 2 + 2?\n2. Kleur van de lucht?\n");
const outTxt = await injectAnswers(txtPath, ".txt", [
  { vraag: "1. Wat is 2 + 2?", antwoord: "4" },
  { vraag: "2. Kleur van de lucht?", antwoord: "Blauw" },
]);
console.log(await fs.readFile(outTxt, "utf8"));
