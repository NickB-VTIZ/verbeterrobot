/**
 * Test van marks.js: aanduidingen van de leerkracht → vragen met slots.
 * Uitvoeren: node scripts/test-marks.mjs
 */
import assert from "assert";
import { defaultSlot, marksToQuestions, questionsToMarks } from "../server/docx/marks.js";

let ok = 0;
function t(name, fn) {
  try {
    fn();
    ok++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n   ", e.message);
    process.exitCode = 1;
  }
}

const P = (id, text, extra = {}) => ({
  id,
  text,
  isEmpty: text === "",
  inTable: false,
  placeholders: 0,
  isPageBreak: false,
  ...extra,
});

const paragraphs = [
  P("p_001", "Formule: U = R · I"),
  P("p_002", "Gegeven: R = 10 Ω, I = 2 A"),
  P("p_003", "1. Bereken de spanning."),
  P("p_004", ""),
  P("p_005", ""),
  P("p_006", "2. Vul aan: de spanning is ........ en de stroom is ........", { placeholders: 2 }),
  P("p_007", "3. Wat is een weerstand?"),
  P("p_008", "Modelantwoord: een component die stroom beperkt."),
  P("p_009", "", { inTable: true }),
];

t("defaultSlot: invulpunten → fill_placeholders", () => {
  assert.deepStrictEqual(defaultSlot(paragraphs[5], paragraphs), { slotType: "fill_placeholders", slotCount: 2 });
});
t("defaultSlot: lege cel → fill_cell", () => {
  assert.strictEqual(defaultSlot(paragraphs[8], paragraphs).slotType, "fill_cell");
});
t("defaultSlot: tekst met lege lijnen eronder → fill_empty_following", () => {
  const d = defaultSlot(paragraphs[2], paragraphs);
  assert.strictEqual(d.slotType, "fill_empty_following");
  assert.strictEqual(d.slotCount, 2);
});
t("defaultSlot: tekst zonder lege lijnen → insert_after", () => {
  assert.strictEqual(defaultSlot(paragraphs[6], paragraphs).slotType, "insert_after");
});

t("marksToQuestions: koppelt vraag, gegeven en antwoordplaats", () => {
  const marks = [
    { paraId: "p_001", role: "formuleblad" },
    { paraId: "p_002", role: "gegeven", qid: "1" },
    { paraId: "p_003", role: "vraag", qid: "1" },
    { paraId: "p_003", role: "antwoordplaats", qid: "1", slotType: "fill_empty_following", slotCount: 2, teacherAnswer: "20 V" },
  ];
  const r = marksToQuestions(marks, paragraphs);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.questions.length, 1);
  const q = r.questions[0];
  assert.deepStrictEqual(q.question_para_ids, ["p_003"]);
  assert.ok(q.context.includes("R = 10"));
  assert.strictEqual(q.slots[0].type, "fill_empty_following");
  assert.strictEqual(q.slots[0].count, 2);
  assert.strictEqual(r.teacherAnswers["1"], "20 V");
  assert.ok(r.reference.includes("U = R"));
});

t("marksToQuestions: modelantwoord wordt leerkrachtantwoord", () => {
  const marks = [
    { paraId: "p_007", role: "vraag", qid: "3" },
    { paraId: "p_007", role: "antwoordplaats", qid: "3" },
    { paraId: "p_008", role: "modelantwoord", qid: "3" },
  ];
  const r = marksToQuestions(marks, paragraphs);
  assert.ok(r.teacherAnswers["3"].includes("beperkt"));
  assert.strictEqual(r.questions[0].slots[0].type, "insert_after");
});

t("marksToQuestions: ontbrekende slottype → standaardvoorstel", () => {
  const r = marksToQuestions(
    [
      { paraId: "p_006", role: "vraag", qid: "2" },
      { paraId: "p_006", role: "antwoordplaats", qid: "2" },
    ],
    paragraphs
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.questions[0].slots[0].type, "fill_placeholders");
  assert.strictEqual(r.questions[0].slots[0].count, 2);
});

t("marksToQuestions: verkeerd aantal invulpunten → fout", () => {
  const r = marksToQuestions(
    [{ paraId: "p_006", role: "antwoordplaats", qid: "2", slotType: "fill_placeholders", slotCount: 5 }],
    paragraphs
  );
  assert.ok(r.errors.length > 0);
  assert.strictEqual(r.questions.length, 0);
});

t("marksToQuestions: onbekende paragraaf → fout", () => {
  const r = marksToQuestions([{ paraId: "p_999", role: "vraag", qid: "9" }], paragraphs);
  assert.ok(r.errors.some((e) => e.includes("p_999")));
});

t("marksToQuestions: vraag zonder antwoordplaats wordt overgeslagen met waarschuwing", () => {
  const r = marksToQuestions([{ paraId: "p_003", role: "vraag", qid: "1" }], paragraphs);
  assert.strictEqual(r.questions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("geen antwoordplaats")));
});

t("marksToQuestions: antwoordplaats zonder qid krijgt eigen vraag", () => {
  const r = marksToQuestions([{ paraId: "p_004", role: "antwoordplaats", slotType: "append" }], paragraphs);
  assert.strictEqual(r.questions.length, 1);
  assert.ok(r.warnings.length > 0);
});

t("marksToQuestions: niet aangeduid invulpunt geeft waarschuwing", () => {
  const r = marksToQuestions([{ paraId: "p_003", role: "vraag", qid: "1" }, { paraId: "p_003", role: "antwoordplaats", qid: "1" }], paragraphs);
  assert.ok(r.warnings.some((w) => w.includes("p_006")));
});

t("questionsToMarks: zet LLM-vragen om naar aanduidingen", () => {
  const marks = questionsToMarks([
    { qid: "1", question_para_ids: ["p_003"], slots: [{ para_id: "p_004", type: "append", count: 1 }] },
  ]);
  assert.strictEqual(marks.length, 2);
  assert.strictEqual(marks[0].role, "vraag");
  assert.strictEqual(marks[1].role, "antwoordplaats");
  assert.deepStrictEqual(marks[1].linkedParaIds, ["p_003"]);
});

console.log(`\n${ok} tests geslaagd`);
