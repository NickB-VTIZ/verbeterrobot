/**
 * Test van de opslaglaag (SQLite + bestanden): documenten, versies, zoeken, prullenbak, purge.
 * Uitvoeren: node scripts/test-storage.mjs
 */
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vr-storage-"));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = await import("../server/storage/db.js");
const repo = await import("../server/storage/repo.js");
const { runWithLlmContext, recordLlmCall } = await import("../server/storage/llmlog.js");
const { getFileRecord } = await import("../server/storage/files.js");

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

const src = path.join(tmp, "toets.docx");
fs.writeFileSync(src, Buffer.from("PK-nepdocx-inhoud-1"));
const teacher = { role: "teacher", name: "An" };
const admin = { role: "admin", name: "Beheerder" };

const { doc, duplicates } = repo.createDocument({
  srcPath: src,
  originalName: "Toets Fysica.docx",
  user: "An",
  vak: "Fysica",
  leerjaar: "3",
  tags: ["Toets", "toets", "kracht"],
  fullText: "Bereken de snelheid van de wagen",
});

t("document aangemaakt met unieke tags en schooljaar", () => {
  assert.equal(doc.status, "geupload");
  assert.deepEqual(doc.tags, ["toets", "kracht"]);
  assert.match(doc.schooljaar, /^\d{4}-\d{4}$/);
  assert.equal(duplicates.length, 0);
});

t("origineel staat ongewijzigd op schijf onder UUID-naam", () => {
  const rec = getFileRecord(doc.originalFileId);
  assert.ok(fs.existsSync(rec.abs));
  assert.ok(!rec.abs.includes("Toets"));
  assert.equal(fs.readFileSync(rec.abs).toString(), "PK-nepdocx-inhoud-1");
});

t("duplicaat wordt herkend via SHA-256", () => {
  const r = repo.createDocument({ srcPath: src, originalName: "kopie.docx", user: "Bart" });
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].id, doc.id);
});

t("zoeken op titel, tekst en tag; leerkracht ziet enkel eigen", () => {
  assert.equal(repo.listDocuments({ q: "snelheid" }, teacher).total, 1);
  assert.equal(repo.listDocuments({ q: "fysi" }, teacher).total, 1);
  assert.equal(repo.listDocuments({ q: "kracht" }, teacher).total, 1);
  assert.equal(repo.listDocuments({ tag: "kracht" }, teacher).total, 1);
  assert.equal(repo.listDocuments({}, teacher).total, 1);
  assert.equal(repo.listDocuments({}, admin).total, 2);
  assert.equal(repo.listDocuments({ teacher: "Bart" }, admin).total, 1);
  assert.equal(repo.listDocuments({ q: 'x"; DROP' }, admin).total, 0);
});

t("versies worden nooit overschreven", () => {
  const out1 = path.join(tmp, "o1.docx");
  const out2 = path.join(tmp, "o2.docx");
  fs.writeFileSync(out1, "v1");
  fs.writeFileSync(out2, "v2");
  const n1 = repo.addVersion({ docId: doc.id, outputPath: out1, createdBy: "An", slots: [{ qid: "1", para_id: "p_001", type: "append", content: "A" }] });
  const n2 = repo.addVersion({ docId: doc.id, outputPath: out2, createdBy: "An", slots: [{ qid: "1", para_id: "p_001", type: "append", content: "B" }] });
  assert.equal(n1, 1);
  assert.equal(n2, 2);
  const vs = repo.listVersions(doc.id);
  assert.equal(vs.length, 2);
  assert.notEqual(vs[0].docxFileId, vs[1].docxFileId);
  assert.equal(fs.readFileSync(getFileRecord(vs[1].docxFileId).abs, "utf8"), "v1");
  assert.equal(repo.getDocument(doc.id).activeVersion, 2);
});

t("versies vergelijken en eerdere versie herstellen", () => {
  const c = repo.compareVersions(doc.id, 1, 2);
  assert.equal(c.changed, 1);
  assert.equal(c.items[0].status, "gewijzigd");
  repo.setActiveVersion(doc.id, 1);
  assert.equal(repo.getDocument(doc.id).activeVersion, 1);
  assert.equal(repo.listVersions(doc.id).length, 2);
});

t("aanduidingen worden opgeslagen per bron", () => {
  repo.saveMarks(doc.id, "teacher", [
    { paraId: "p_001", role: "vraag", qid: "1" },
    { paraId: "p_002", role: "antwoordplaats", qid: "1", slotType: "append", teacherAnswer: "5 m/s" },
    { paraId: "p_003", role: "onbekend" },
  ]);
  repo.saveMarks(doc.id, "llm_proposal", [{ paraId: "p_001", role: "vraag", qid: "1" }]);
  assert.equal(repo.getMarks(doc.id, "teacher").length, 2);
  assert.equal(repo.getMarks(doc.id, "llm_proposal").length, 1);
});

t("LLM-aanroepen worden gelogd met vak en leerkracht", () => {
  runWithLlmContext({ documentId: doc.id, versionNumber: 1, callType: "oplossen" }, () =>
    recordLlmCall({
      messages: [{ role: "user", content: "hallo" }],
      response: "{}",
      model: "test",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      durationMs: 12,
    })
  );
  const calls = repo.listLlmCalls(doc.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].total_tokens, 150);
  const cost = repo.costOverview();
  assert.equal(cost.perVak.find((v) => v.label === "Fysica").calls, 1);
  assert.equal(cost.perTeacher.find((v) => v.label === "An").calls, 1);
});

t("feedback bewaard, voorbeelden blijven na purge (ontkoppeld)", () => {
  repo.addFeedback({ docId: doc.id, versionNumber: 1, qid: "1", questionText: "Bereken v", originalAnswer: "4", correctedAnswer: "5 m/s", action: "aangepast", user: "An" });
  repo.addFeedback({ docId: doc.id, versionNumber: 1, qid: "2", questionText: "Wat is F?", originalAnswer: "m·a", correctedAnswer: "m·a", action: "goedgekeurd", user: "An" });
  assert.equal(repo.listFeedback(doc.id).length, 2);
});

t("sjabloon en kopie", () => {
  const tid = repo.createTemplate({ docId: doc.id, name: "Sjabloon", owner: "An" });
  assert.equal(repo.getTemplate(tid).marks.length, 2);
  const copy = repo.duplicateDocument(doc.id, "An");
  assert.equal(copy.versionCount, 0);
  assert.equal(copy.status, "aangeduid");
  assert.notEqual(copy.id, doc.id);
});

t("soft delete → prullenbak → herstel", () => {
  assert.ok(repo.softDelete(doc.id, "An"));
  assert.equal(repo.listDocuments({}, teacher).items.find((d) => d.id === doc.id), undefined);
  assert.equal(repo.listDocuments({ trash: true }, teacher).total, 1);
  assert.ok(repo.restoreDocument(doc.id));
  assert.equal(repo.listDocuments({ trash: true }, teacher).total, 0);
});

t("definitief verwijderen ruimt alles op, bewaart voorbeelden en auditregel", () => {
  const preview = repo.purgePreview(doc.id);
  assert.equal(preview.versions, 2);
  assert.equal(preview.approvedExamples, 1);
  const dir = path.join(tmp, "store", doc.id);
  assert.ok(fs.existsSync(dir));
  repo.softDelete(doc.id, "An");
  assert.ok(repo.purgeDocument(doc.id, { keepExamples: true, user: "An", role: "teacher" }));
  assert.ok(!fs.existsSync(dir), "map moet weg zijn");
  assert.equal(repo.getDocument(doc.id), null);
  const db = getDb();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM versions WHERE document_id=?").get(doc.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback WHERE document_id IS NULL AND vak='Fysica'").get().n >= 1, true);
  const llm = db.prepare("SELECT prompt_text, vak FROM llm_calls WHERE vak='Fysica'").get();
  assert.equal(llm.prompt_text, null);
  const log = repo.listAudit({ documentId: doc.id });
  assert.ok(log.some((l) => l.action === "definitief_verwijderd"));
  assert.ok(!JSON.stringify(log).includes("Bereken"), "geen inhoud in audit");
});

t("automatisch opruimen na bewaartermijn", () => {
  const r = repo.createDocument({ srcPath: src, originalName: "oud.docx", user: "Cas" });
  repo.softDelete(r.doc.id, "Cas");
  getDb().prepare("UPDATE documents SET deleted_at = datetime('now','-40 days') WHERE id = ?").run(r.doc.id);
  assert.ok(repo.purgeExpired() >= 1);
  assert.equal(repo.getDocument(r.doc.id), null);
});

closeDb();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "\nSommige tests faalden." : `\nAlle ${ok} opslagtests geslaagd.`);
