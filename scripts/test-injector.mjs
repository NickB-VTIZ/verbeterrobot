// Smoke test: bouwt een minimaal .docx, injecteert rode antwoorden en controleert het resultaat.
import JSZip from "jszip";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { injectAnswers } from "../server/injector.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const docXml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>` +
  `<w:p><w:r><w:t>1. Wat is 2 + 2?</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t xml:space="preserve">2. Hoofdstad van </w:t></w:r><w:r><w:t>België & Nederland?</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

const zip = new JSZip();
zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
zip.file("word/document.xml", docXml);
const tmp = path.join(os.tmpdir(), "vr-test.docx");
await fs.writeFile(tmp, await zip.generateAsync({ type: "nodebuffer" }));

const answers = [
  { vraag: "1. Wat is 2 + 2?", antwoord: "4" },
  { vraag: "2. Hoofdstad van België & Nederland?", antwoord: "Brussel & Amsterdam <ok>" },
];
const out = await injectAnswers(tmp, ".docx", answers);
const outPath = typeof out === "string" ? out : tmp;
const res = await JSZip.loadAsync(await fs.readFile(outPath));
const xml = await res.file("word/document.xml").async("string");
console.log("Rode paragrafen:", (xml.match(/FF0000/g) || []).length);
console.log("Bevat antwoord 4:", xml.includes(">4<") || xml.includes("4</w:t>"));
console.log("Bevat escaped &:", xml.includes("Brussel & Amsterdam <ok>"));
