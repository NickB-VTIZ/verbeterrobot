// Deterministische test van de docx-pipeline (zonder LLM): extractie, validatie, controle en invoeging.
import assert from "node:assert/strict";
import { extractParagraphs } from "../server/docx/extract.js";
import { validateAnalysis } from "../server/docx/analyse.js";
import { validateSolution } from "../server/docx/solve.js";
import { verifySolution, safeEval, lastNumber } from "../server/docx/verify.js";
import { applySolutionsToXml } from "../server/docx/pipeline.js";
import {
  validateVisualReport,
  summariseReport,
  buildVisualMessages,
  summariseSlots,
  visualCheck,
} from "../server/docx/visual.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const rpr = `<w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="22"/></w:rPr>`;
const xml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>` +
  // p_001: vraag met append
  `<w:p><w:r>${rpr}<w:t>1. Bereken P bij 230 V en 5 A.</w:t></w:r></w:p>` +
  // p_002: placeholders verspreid over meerdere runs
  `<w:p><w:r>${rpr}<w:t xml:space="preserve">P = ...</w:t></w:r><w:r>${rpr}<w:t>.......... W en I = ........ A</w:t></w:r></w:p>` +
  // p_003 + p_004 + p_005: vraag met lege antwoordlijnen
  `<w:p><w:r>${rpr}<w:t>2. Bereken de energie bij 2 kW gedurende 30 min.</w:t></w:r></w:p>` +
  `<w:p/><w:p/>` +
  // p_006: pagina-einde, mag nooit ingevuld worden
  `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
  // tabel met lege cel
  `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Spanning</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>` +
  // laatste vraag met insert_after + lijst
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r>${rpr}<w:t>3. Wat is het rendement?</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

// ── Extractie ─────────────────────────────────────────────────────────
const { paragraphs } = extractParagraphs(xml);
const ids = paragraphs.map((p) => p.id);
assert.deepEqual(ids, ["p_001", "p_002", "p_003", "p_004", "p_005", "p_006", "p_007", "p_008", "p_009"]);
assert.equal(paragraphs[1].placeholders, 2, "twee invulpunten, ook over runs heen");
assert.equal(paragraphs[3].isEmpty, true);
assert.equal(paragraphs[5].isEmpty, false, "pagina-einde is niet leeg");
assert.equal(paragraphs[6].inTable, true);
assert.equal(paragraphs[7].inTable && paragraphs[7].isEmpty, true);
assert.equal(paragraphs[8].isList, true);
console.log("✔ extractie");

// ── Validatie analyse ─────────────────────────────────────────────────
const okAnalysis = {
  questions: [
    { qid: "1", question_para_ids: ["p_001"], slots: [
      { para_id: "p_002", type: "fill_placeholders", count: 2 },
    ] },
    { qid: "2", question_para_ids: ["p_003"], slots: [
      { para_id: "p_003", type: "fill_empty_following", count: 2 },
      { para_id: "p_008", type: "fill_cell" },
      { para_id: "p_009", type: "insert_after" },
    ] },
  ],
};
const qs = validateAnalysis(okAnalysis, paragraphs);
assert.equal(qs.length, 2);
assert.throws(
  () => validateAnalysis({ questions: [{ qid: "1", slots: [{ para_id: "p_002", type: "fill_placeholders", count: 3 }] }] }, paragraphs),
  /2 invulpunt/
);
assert.throws(() => validateAnalysis({ questions: [{ qid: "1", slots: [{ para_id: "p_001", type: "append" }] }] }, paragraphs), /geen enkel fill_placeholders/);
console.log("✔ validatie analyse");

// ── Rekenen & eenheden ────────────────────────────────────────────────
assert.equal(safeEval("230*5"), 1150);
assert.equal(safeEval("2**3 + (4-1)/2"), 9.5);
assert.equal(safeEval("2,5 * 4"), 10);
assert.throws(() => safeEval("process.exit(1)"));
assert.throws(() => safeEval("1; alert(1)"));
assert.deepEqual(lastNumber("P = 230 V . 5 A = 1 150 W"), { value: 1150, unit: "W" });
assert.deepEqual(lastNumber("E = 2,5 kWh"), { value: 2.5, unit: "kWh" });
assert.equal(
  verifySolution([{ expr: "230*5", expect: 1150, unit: "W", slot: "p_002", index: 0 }], [{ para_id: "p_002", content: ["1 150 W"] }]).ok,
  true
);
// kW ↔ W wordt herleid
assert.equal(
  verifySolution([{ expr: "230*5", expect: 1150, unit: "W", slot: "p_002" }], [{ para_id: "p_002", content: ["1,15 kW"] }]).ok,
  true
);
const bad = verifySolution([{ expr: "230*5", expect: 1150, unit: "W", slot: "p_002" }], [{ para_id: "p_002", content: ["1 105 W"] }]);
assert.equal(bad.ok, false);
const wrongUnit = verifySolution([{ expr: "2*0.5", expect: 1, unit: "kWh", slot: "p_002" }], [{ para_id: "p_002", content: ["1 W"] }]);
assert.equal(wrongUnit.ok, false);
console.log("✔ rekenen en eenheden");

// ── validateSolution ──────────────────────────────────────────────────
assert.throws(() => validateSolution({ slot_values: [{ para_id: "p_002", content: ["1"] }] }, qs[0]), /exact 2/);
console.log("✔ validatie oplossing");

// ── Invoegen ──────────────────────────────────────────────────────────
const slots = [
  { para_id: "p_001", type: "append", content: "P = 230 V . 5 A = 1 150 W" },
  { para_id: "p_002", type: "fill_placeholders", content: ["1 150 W", "5"] },
  { para_id: "p_003", type: "fill_empty_following", content: ["E = P . t", "E = 2 kW . 0,5 h", "E = 1 kWh"] },
  { para_id: "p_008", type: "fill_cell", content: "230 V" },
  { para_id: "p_009", type: "insert_after", content: "η = 80 %" },
];
const res = applySolutionsToXml(xml, () => slots);
assert.deepEqual(res.qc, [], res.qc.join("; "));
assert.equal(res.applied, 5);
const out = res.xml;
assert.ok(!out.includes("_vr_id"), "interne markering moet weg");
assert.ok(!/\.{5,}/.test(out), "geen invulpunten meer");
assert.ok(out.includes("1 150 W"));
assert.ok(out.includes("E = 2 kW . 0,5 h = E = 1 kWh"), "restwaarden samengevoegd in de laatste lege paragraaf");
assert.ok(out.includes('<w:color w:val="FF0000"/>'));
// schemavolgorde: w:color staat vóór w:sz
const m = out.match(/<w:rPr>(?:(?!<\/w:rPr>).)*<w:color w:val="FF0000"\/>(?:(?!<\/w:rPr>).)*<\/w:rPr>/);
assert.ok(m && m[0].indexOf("w:color") < m[0].indexOf("w:sz"), "w:color vóór w:sz");
assert.ok(out.includes("Antwoord: "));
// numPr niet gekopieerd naar ingevoegde paragraaf
const afterList = out.slice(out.indexOf("3. Wat is het rendement?"));
assert.ok(afterList.includes("η = 80 %"));
assert.ok(!afterList.includes("numPr"), "nieuwe paragraaf heeft geen numPr");
assert.equal((out.match(/<w:numPr>/g) || []).length, 1, "enkel het originele numPr blijft");
// Pagina-einde ongemoeid
assert.ok(out.includes('<w:br w:type="page"/>'));
console.log("✔ invoegen en kwaliteitscontrole");
// ── Visuele controle (enkel de pure delen; LibreOffice en het vision-model niet) ──
assert.throws(() => validateVisualReport("tekst"), /JSON-object/);
const rep1 = validateVisualReport({ ok: true, zeker: true, problemen: [], vragen: [] });
assert.deepEqual(summariseReport(rep1), { status: "ok", issues: [], clarifications: [] });

const rep2 = validateVisualReport({
  ok: false,
  zeker: true,
  problemen: [{ pagina: 2, probleem: "Antwoord overlapt de tabel", ernst: "hoog" }, { pagina: 1, probleem: "kleine afwijking", ernst: "laag" }],
});
const sum2 = summariseReport(rep2);
assert.equal(sum2.status, "issues");
assert.ok(sum2.issues[0].startsWith("Pagina 2: "));

const rep3 = validateVisualReport({ ok: true, problemen: [], vragen: ["Is de tabel op pagina 1 een invulblad?"] });
assert.equal(rep3.zeker, false, "vragen betekenen onzeker");
const sum3 = summariseReport(rep3);
assert.equal(sum3.status, "unsure");
assert.equal(sum3.clarifications.length, 1);

assert.equal(validateVisualReport({ vragen: ["1", "2", "3", "4", "5", "6", "7"] }).vragen.length, 5, "max. 5 vragen");
assert.equal(validateVisualReport({ problemen: [{ probleem: "x", ernst: "raar" }] }).problemen[0].ernst, "middel");

// Veel meer pagina's dan het origineel → melding
const sum4 = summariseReport(rep1, { pageCount: 6, originalPageCount: 3 });
assert.equal(sum4.status, "issues");
assert.ok(/6 pagina/.test(sum4.issues[0]));

const msgs = buildVisualMessages(["AAAA", "BBBB"], { expected: "p1: 12 W", pageCount: 2, originalPageCount: 2 });
assert.equal(msgs[0].role, "system");
assert.ok(Array.isArray(msgs[1].content));
assert.equal(msgs[1].content.filter((c) => c.type === "image_url").length, 2);
assert.ok(msgs[1].content.some((c) => c.image_url?.url === "data:image/png;base64,AAAA"));
assert.equal(typeof summariseSlots([]), "string");

process.env.VISUAL_CHECK = "off";
const skipped = await visualCheck({ outputPath: "/bestaat/niet.docx" });
assert.equal(skipped.status, "skipped");
assert.deepEqual(skipped.issues, []);
delete process.env.VISUAL_CHECK;
console.log("✔ visuele controle (pure delen en overslaan)");

console.log("\nAlle tests geslaagd.");
