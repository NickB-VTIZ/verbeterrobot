/**
 * Test (zonder taalmodel) van: persoonlijke accounts, trainingsvoorbeelden, vergelijking van verbeterde versies
 * en de status van het automatische voorstel.
 * Uitvoeren: node scripts/test-users.mjs
 */
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vr-users-"));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = await import("../server/storage/db.js");
const repo = await import("../server/storage/repo.js");
const users = await import("../server/users.js");
const auth = await import("../server/auth.js");
const learn = await import("../server/learn.js");

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

getDb();

/* ───────────── gebruikers ───────────── */
let an;
t("gebruiker aanmaken en weergeven", () => {
  an = users.createUser({ username: "  An.Peeters ", displayName: "An Peeters", password: "geheim123", role: "teacher" });
  assert.equal(an.username, "an.peeters");
  assert.equal(an.role, "teacher");
  assert.ok(an.active);
  assert.equal(users.listUsers().length, 1);
  assert.ok(!JSON.stringify(users.listUsers()).includes("geheim123"));
  assert.ok(!("password_hash" in an) && !("passwordHash" in an));
});

t("ongeldige invoer wordt geweigerd", () => {
  assert.throws(() => users.createUser({ username: "bo", displayName: "Bo", password: "geheim123" }), /Gebruikersnaam/);
  assert.throws(() => users.createUser({ username: "bart", displayName: "Bart", password: "kort" }), /minstens 8/);
  assert.throws(() => users.createUser({ username: "bart", displayName: "Bart", password: "geheim123", role: "god" }), /rol/);
  assert.throws(() => users.createUser({ username: "AN.peeters", displayName: "Dubbel", password: "geheim123" }), /bestaat al/);
});

t("inloggen: juist, fout wachtwoord, onbekend, hoofdletterongevoelig", () => {
  assert.equal(users.verifyUserLogin("an.peeters", "geheim123").user.displayName, "An Peeters");
  assert.equal(users.verifyUserLogin("AN.Peeters", "geheim123").user.id, an.id);
  assert.equal(users.verifyUserLogin("an.peeters", "fout").error, "onbekend");
  assert.equal(users.verifyUserLogin("niemand", "geheim123").error, "onbekend");
  assert.equal(users.verifyUserLogin("", "").error, "onbekend");
  assert.ok(users.listUsers()[0].lastLogin);
});

t("wachtwoord wijzigen, rol wijzigen en deactiveren", () => {
  users.updateUser(an.id, { password: "nieuw-wachtwoord" });
  assert.equal(users.verifyUserLogin("an.peeters", "geheim123").error, "onbekend");
  assert.ok(users.verifyUserLogin("an.peeters", "nieuw-wachtwoord").user);
  assert.throws(() => users.updateUser(an.id, { password: "kort" }), /minstens 8/);
  assert.equal(users.updateUser(an.id, { role: "admin" }).role, "admin");
  users.updateUser(an.id, { active: false });
  assert.equal(users.verifyUserLogin("an.peeters", "nieuw-wachtwoord").error, "inactief");
  users.updateUser(an.id, { active: true });
  assert.ok(users.verifyUserLogin("an.peeters", "nieuw-wachtwoord").user);
});

t("sessies van een gebruiker kunnen worden beëindigd", () => {
  const tok = auth.createSession("teacher", "An Peeters", an.id);
  assert.ok(tok);
  auth.destroySessionsOfUser(an.id);
  const req = { headers: { authorization: `Bearer ${tok}` } };
  let status = 200;
  const res = {
    status(s) {
      status = s;
      return this;
    },
    json() {
      return this;
    },
  };
  let passed = false;
  auth.requireRole("teacher", "admin")(req, res, () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(status, 401);
});

t("gebruiker verwijderen", () => {
  assert.equal(users.deleteUser(an.id), true);
  assert.equal(users.deleteUser(an.id), false);
  assert.equal(users.listUsers().length, 0);
});

/* ───────────── vergelijking van verbeterde versies ───────────── */
t("similarity", () => {
  assert.equal(learn.similarity("De kracht is 5 N", "de kracht is 5 n"), 1);
  assert.equal(learn.similarity("", ""), 1);
  assert.equal(learn.similarity("abc", ""), 0);
  assert.ok(learn.similarity("de kracht is 5 N", "de kracht is 6 N") > 0.5);
});

const orig = ["Toets fysica", "1. Bereken de snelheid.", "Antwoord:", "2. Bereken de kracht.", "Antwoord:", "Veel succes"];
const corr = ["Toets fysica", "1. Bereken de snelheid.", "Antwoord: 20 m/s", "2. Bereken de kracht.", "Antwoord:", "Dit is de oplossing: 5 N", "Veel succes"];

t("diffParagraphs vindt toegevoegde en gewijzigde tekst", () => {
  const gaps = learn.diffParagraphs(orig, corr);
  const added = gaps.flatMap((g) => g.added);
  assert.ok(added.includes("20 m/s"), "toegevoegd deel van gewijzigde paragraaf: " + JSON.stringify(added));
  assert.ok(added.includes("Dit is de oplossing: 5 N"));
  assert.equal(learn.diffParagraphs(orig, orig).length, 0);
});

t("assignToQuestions koppelt aan de dichtstbijzijnde vorige vraag", () => {
  const gaps = learn.diffParagraphs(orig, corr);
  const map = learn.assignToQuestions(gaps, [
    { qid: "q1", start: 1 },
    { qid: "q2", start: 3 },
  ]);
  assert.deepEqual(map.get("q1"), ["20 m/s"]);
  assert.deepEqual(map.get("q2"), ["Dit is de oplossing: 5 N"]);
});

t("diffParagraphs weigert enorme documenten", () => {
  const big = Array.from({ length: 3001 }, (_, i) => "p" + i);
  assert.throws(() => learn.diffParagraphs(big, big), /te groot/);
});

/* ───────────── trainingsvoorbeelden ───────────── */
const src = path.join(tmp, "toets.docx");
fs.writeFileSync(src, Buffer.from("PK-nepdocx-inhoud-users"));
const { doc } = repo.createDocument({
  srcPath: src,
  originalName: "Toets.docx",
  user: "An Peeters",
  vak: "Fysica",
  fullText: "Bereken de snelheid",
});

t("trainingsvoorbeelden toevoegen, tonen, filteren en verwijderen", () => {
  const id1 = repo.addTrainingSample({
    docId: doc.id,
    qid: "q1",
    questionText: "Bereken de snelheid.",
    aiAnswer: "20 m/s",
    teacherAnswer: "20 m/s",
    verdict: "gelijk",
    insight: "Zelfde antwoord.",
  });
  const id2 = repo.addTrainingSample({
    docId: doc.id,
    qid: "q2",
    questionText: "Bereken de kracht.",
    aiAnswer: "4 N",
    teacherAnswer: "5 N",
    verdict: "afwijkend",
  });
  const all = repo.listTrainingSamples();
  assert.equal(all.length, 2);
  assert.equal(repo.trainingSampleCount(), 2);
  assert.equal(all[0].vak, "Fysica");
  assert.equal(all[0].teacher, "An Peeters");
  assert.equal(repo.listTrainingSamples({ docId: doc.id }).length, 2);
  assert.equal(repo.listTrainingSamples({ docId: "bestaat-niet" }).length, 0);
  assert.equal(repo.deleteTrainingSample(id1), true);
  assert.equal(repo.deleteTrainingSample(id1), false);
  assert.equal(repo.listTrainingSamples()[0].id, id2);
});

t("clearTrainingSamples ruimt enkel de opgegeven bron op", () => {
  repo.addTrainingSample({ docId: doc.id, qid: "q3", teacherAnswer: "x", verdict: "nieuw", source: "andere" });
  assert.equal(repo.clearTrainingSamples(doc.id), 1);
  assert.equal(repo.listTrainingSamples().length, 1);
  assert.equal(repo.listTrainingSamples()[0].source, "andere");
});

/* ───────────── status van het automatische voorstel ───────────── */
t("voorstelstatus bijhouden en negeren van ongeldige waarden", () => {
  assert.equal(repo.getDocument(doc.id).proposalStatus, "geen");
  repo.setProposalStatus(doc.id, "bezig");
  assert.equal(repo.getDocument(doc.id).proposalStatus, "bezig");
  repo.setProposalStatus(doc.id, "onzin");
  assert.equal(repo.getDocument(doc.id).proposalStatus, "bezig");
  repo.setProposalStatus(doc.id, "mislukt", "Geen verbinding");
  const d = repo.getDocument(doc.id);
  assert.equal(d.proposalStatus, "mislukt");
  assert.equal(d.proposalError, "Geen verbinding");
  repo.setProposalStatus(doc.id, "klaar");
  assert.equal(repo.getDocument(doc.id).proposalError, null);
});

t("na een herstart staat 'bezig' niet langer op bezig", () => {
  repo.setProposalStatus(doc.id, "bezig");
  closeDb();
  getDb();
  const d = repo.getDocument(doc.id);
  assert.equal(d.proposalStatus, "mislukt");
  assert.match(d.proposalError, /herstart/);
});

t("definitief verwijderen ruimt de trainingsvoorbeelden van het document op", () => {
  repo.addTrainingSample({ docId: doc.id, qid: "q9", teacherAnswer: "y", verdict: "nieuw" });
  repo.purgeDocument(doc.id, { keepExamples: false });
  assert.equal(repo.listTrainingSamples({ docId: doc.id }).length, 0);
});

closeDb();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ok} tests geslaagd`);
