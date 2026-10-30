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

// ── P1: antwoorden staan direct bij de vraag, nooit achteraan ─────────
{
  const { DOMParser } = await import("@xmldom/xmldom");
  const q = (n, t) => `<w:p><w:r>${rpr}<w:t>${n}. ${t}</w:t></w:r></w:p>`;
  const filler = (t) => `<w:p><w:r>${rpr}<w:t>${t}</w:t></w:r></w:p>`;
  const sample =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>` +
    filler("Toets elektriciteit") +
    q(1, "Bereken U bij 2 A en 5 ohm.") +
    filler("Gegeven: I = 2 A") +
    q(2, "Bereken P bij 230 V en 5 A.") +
    // tabel met een vraag in een cel
    `<w:tbl><w:tr><w:tc><w:p><w:r>${rpr}<w:t>3. Bereken R bij 10 V en 2 A.</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>` +
    // tekstvak (met Choice + Fallback: mag maar één keer geteld worden)
    `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice><w:txbxContent><w:p><w:r>${rpr}<w:t>4. Wat is de eenheid van lading?</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r>${rpr}<w:t>4. Wat is de eenheid van lading?</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>` +
    q(5, "Wat is het rendement?") +
    // laatste paragraaf in het document: antwoord moet vóór sectPr blijven
    q(6, "Laatste vraag.") +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>` +
    `</w:body></w:document>`;

  const idOf = (text) => extractParagraphs(sample).paragraphs.find((p) => p.text.includes(text)).id;
  const insertSlots = [
    { para_id: idOf("1. Bereken U"), type: "insert_after", content: "U = 10 V" },
    { para_id: idOf("2. Bereken P"), type: "insert_after", content: "P = 1 150 W" },
    { para_id: idOf("3. Bereken R"), type: "insert_after", content: "R = 5 ohm" },
    { para_id: idOf("4. Wat is de eenheid"), type: "insert_after", content: "coulomb" },
    { para_id: idOf("5. Wat is het"), type: "insert_after", content: "η = 80 %" },
    { para_id: idOf("6. Laatste"), type: "insert_after", content: "klaar" },
  ];
  // Opzettelijk door elkaar aangeleverd: volgorde van de slots mag niets uitmaken
  const shuffled = [insertSlots[3], insertSlots[0], insertSlots[5], insertSlots[2], insertSlots[1], insertSlots[4]];
  const r = applySolutionsToXml(sample, () => shuffled);
  assert.deepEqual(r.qc, [], r.qc.join("; "));
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.insertedParagraphs, insertSlots.length);
  assert.equal(r.paragraphsAfter - r.paragraphsBefore, insertSlots.length, "aantal paragrafen +1 per insert_after");

  const outDoc = new DOMParser().parseFromString(r.xml, "application/xml");
  // eigen tekst van een paragraaf (zonder paragrafen in een tekstvak erbinnen)
  const ownP = (t) => {
    for (let n = t.parentNode; n; n = n.parentNode) if (n.localName === "p") return n;
    return null;
  };
  const textOf = (p) =>
    Array.from(p.getElementsByTagNameNS(W, "t"))
      .filter((t) => ownP(t) === p)
      .map((t) => t.textContent)
      .join("");
  const all = Array.from(outDoc.getElementsByTagNameNS(W, "p"));
  const texts = all.map(textOf);
  const pairs = [
    ["1. Bereken U", "U = 10 V"],
    ["2. Bereken P", "P = 1 150 W"],
    ["3. Bereken R", "R = 5 ohm"],
    ["4. Wat is de eenheid", "coulomb"],
    ["5. Wat is het", "η = 80 %"],
    ["6. Laatste", "klaar"],
  ];
  for (const [vraag, antwoord] of pairs) {
    const qi = texts.findIndex((t) => t.includes(vraag));
    assert.ok(qi >= 0, `vraag '${vraag}' bestaat`);
    assert.ok(texts[qi + 1]?.includes(antwoord), `antwoord '${antwoord}' staat direct na '${vraag}'`);
    // en het is dezelfde ouder: direct volgende broer-paragraaf
    assert.equal(all[qi + 1].previousSibling, all[qi], `'${antwoord}' is de directe volgende broer van de vraag`);
  }
  // Geen enkel antwoord in de laatste paragraaf van de body, na sectPr of op documentniveau
  const body = outDoc.getElementsByTagNameNS(W, "body")[0];
  const lastEl = Array.from(body.childNodes).filter((n) => n.nodeType === 1).pop();
  assert.equal(lastEl.localName, "sectPr", "sectPr blijft het laatste element van body");
  assert.equal((r.xml.match(/Antwoord: /g) || []).length, insertSlots.length, "elk antwoord precies één keer");
  console.log("✔ P1: antwoorden direct bij de vraag, ook in tabel, tekstvak en laatste paragraaf");

  // Ongeldig para_id → NOOIT achteraan, maar gemeld als 'handmatig nakijken'
  const bad = applySolutionsToXml(sample, () => [
    { para_id: "p_999", type: "insert_after", content: "ZWERFANTWOORD" },
    { para_id: idOf("1. Bereken U"), type: "insert_after", content: "U = 10 V" },
  ]);
  assert.equal(bad.unplaced.length, 1);
  assert.equal(bad.unplaced[0].para_id, "p_999");
  assert.ok(!bad.xml.includes("ZWERFANTWOORD"), "onplaatsbaar antwoord komt nergens in het document");
  assert.equal(bad.paragraphsAfter - bad.paragraphsBefore, 1);
  assert.deepEqual(bad.qc, []);
  console.log("✔ P1: slot zonder geldige plaats wordt gemeld en niet achteraan gezet");
}

console.log("\nAlle tests geslaagd.");
