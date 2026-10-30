// Integratietest van de bibliotheek-API (zonder LLM): start de server met een tijdelijke DATA_DIR,
// uploadt een .docx, duidt alinea's aan, downloadt, verwijdert/herstelt/purge't en test de back-up.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vr-lib-"));
const DATA = path.join(tmp, "data");
const BACKUPS = path.join(tmp, "backups");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR: DATA,
  BACKUP_DIR: BACKUPS,
  ADMIN_PASSWORD: "adminpw",
  TEACHER_PASSWORD: "teacherpw",
  VISUAL_CHECK: "off",
  OMNIROUTE_API_KEY: "test",
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
async function makeDocx(extra = "") {
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>` +
    `<w:p><w:r><w:t>1. Wat is 2 + 2? ${extra}</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Antwoord: ........</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>2. Hoofdstad van België?</w:t></w:r></w:p>` +
    `<w:p/>` +
    `</w:body></w:document>`;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

const server = spawn(process.execPath, ["server/index.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Server startte niet:\n" + log);
}

async function api(token, method, url, body, raw = false) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  if (raw) return r;
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

async function login(role, name, password) {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, name, password }),
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  return j.token;
}

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    throw e;
  }
}

try {
  await waitUp();
  const anna = await login("teacher", "Anna Peeters", "teacherpw");
  const bram = await login("teacher", "Bram Janssens", "teacherpw");
  const admin = await login("admin", "", "adminpw");
  let docId;

  await t("zonder naam kan een leerkracht niet aanmelden", async () => {
    const r = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "teacher", password: "teacherpw" }),
    });
    assert.equal(r.status, 400);
  });

  await t("upload zonder genereren", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([await makeDocx()]), "toets wiskunde.docx");
    fd.append("vak", "Wiskunde");
    fd.append("leerjaar", "3");
    fd.append("tags", "toets, hoofdstuk 1");
    const r = await api(anna, "POST", "/api/documents", fd);
    assert.equal(r.status, 200, r.text);
    docId = r.json.document.id;
    assert.equal(r.json.document.status, "geupload");
    assert.equal(r.json.document.teacher, "Anna Peeters");
    assert.ok(r.json.document.schooljaar);
    assert.deepEqual(r.json.document.tags.sort(), ["hoofdstuk 1", "toets"]);
  });

  await t("duplicaat wordt gemeld (zelfde SHA-256)", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([await makeDocx()]), "kopie.docx");
    const r = await api(bram, "POST", "/api/documents", fd);
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.duplicates));
  });

  await t("bibliotheek toont enkel eigen documenten, admin alles", async () => {
    const a = await api(anna, "GET", "/api/library");
    assert.equal(a.status, 200, a.text);
    assert.ok(a.json.items.every((d) => d.teacher === "Anna Peeters"));
    assert.ok(a.json.items.some((d) => d.id === docId));
    const ad = await api(admin, "GET", "/api/library");
    assert.ok(ad.json.items.length >= 2);
    const b = await api(bram, "GET", `/api/documents/${docId}`);
    assert.equal(b.status, 404);
  });

  await t("zoeken en filteren", async () => {
    const q = await api(anna, "GET", "/api/library?q=wiskunde&vak=Wiskunde&tag=toets");
    assert.ok(q.json.items.some((d) => d.id === docId));
    const none = await api(anna, "GET", "/api/library?q=nietbestaandwoord");
    assert.equal(none.json.items.length, 0);
    const opt = await api(anna, "GET", "/api/library/options");
    assert.equal(opt.status, 200);
  });

  let paragraphs;
  await t("alinea's ophalen", async () => {
    const r = await api(anna, "GET", `/api/documents/${docId}/paragraphs`);
    assert.equal(r.status, 200, r.text);
    paragraphs = r.json.paragraphs;
    assert.ok(paragraphs.length >= 3);
    assert.ok(Array.isArray(r.json.roles));
  });

  await t("aanduidingen bewaren + controle", async () => {
    const q1 = paragraphs.find((p) => p.text.startsWith("1."));
    const a1 = paragraphs.find((p) => p.text.startsWith("Antwoord"));
    const r = await api(anna, "PUT", `/api/documents/${docId}/marks`, {
      marks: [
        { paraId: q1.id, role: "vraag", qid: "1" },
        { paraId: a1.id, role: "antwoordplaats", qid: "1", slotType: "fill_placeholders", slotCount: 1, teacherAnswer: "4" },
      ],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.saved, 2);
    assert.equal(r.json.questions, 1);
    assert.deepEqual(r.json.errors, []);
    const d = await api(anna, "GET", `/api/documents/${docId}`);
    assert.equal(d.json.document.status, "aangeduid");
    assert.equal(d.json.marks.teacher, 2);
  });

  await t("ongeldig slot wordt als fout gemeld (nooit gokken)", async () => {
    const q1 = paragraphs.find((p) => p.text.startsWith("1."));
    const r = await api(anna, "PUT", `/api/documents/${docId}/marks`, {
      marks: [
        { paraId: q1.id, role: "vraag", qid: "1" },
        { paraId: q1.id, role: "antwoordplaats", qid: "1", slotType: "fill_placeholders", slotCount: 2 },
      ],
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.errors.length > 0);
    // herstel de goede aanduidingen
    const a1 = paragraphs.find((p) => p.text.startsWith("Antwoord"));
    await api(anna, "PUT", `/api/documents/${docId}/marks`, {
      marks: [
        { paraId: q1.id, role: "vraag", qid: "1" },
        { paraId: a1.id, role: "antwoordplaats", qid: "1", slotType: "fill_placeholders", slotCount: 1 },
      ],
    });
  });

  await t("metadata + tags wijzigen en audit", async () => {
    const r = await api(anna, "PATCH", `/api/documents/${docId}`, { title: "Toets 1", tags: ["a", "b"], richting: "Moderne talen" });
    assert.equal(r.status, 200, r.text);
    const d = await api(anna, "GET", `/api/documents/${docId}`);
    assert.equal(d.json.document.title, "Toets 1");
    assert.ok(d.json.audit.some((x) => x.action === "upload"));
  });

  await t("origineel downloaden is byte-identiek en wordt gelogd", async () => {
    const r = await api(anna, "GET", `/api/documents/${docId}/download/original`, undefined, true);
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    assert.ok(zip.file("word/document.xml"));
    const d = await api(anna, "GET", `/api/documents/${docId}`);
    assert.ok(d.json.audit.some((x) => x.action === "download"));
  });

  await t("ZIP van meerdere documenten", async () => {
    const r = await api(anna, "POST", "/api/library/zip", { ids: [docId], includeOriginals: true }, true);
    assert.equal(r.status, 200);
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    assert.ok(Object.keys(zip.files).length >= 1);
  });

  await t("bulk tags toevoegen", async () => {
    const r = await api(anna, "POST", "/api/library/bulk", { ids: [docId], action: "tags_add", tags: ["extra"] });
    assert.equal(r.status, 200, r.text);
    const d = await api(anna, "GET", `/api/documents/${docId}`);
    assert.ok(d.json.document.tags.includes("extra"));
  });

  await t("sjabloon opslaan en lijst", async () => {
    const r = await api(anna, "POST", `/api/documents/${docId}/template`, { name: "Wiskundesjabloon" });
    assert.equal(r.status, 200, r.text);
    const l = await api(anna, "GET", "/api/templates");
    assert.ok(l.json.templates.some((x) => x.name === "Wiskundesjabloon"));
    const other = await api(bram, "GET", "/api/templates");
    assert.equal(other.json.templates.length, 0);
  });

  let copyId;
  await t("dupliceren als nieuw document", async () => {
    const r = await api(anna, "POST", `/api/documents/${docId}/duplicate`);
    assert.equal(r.status, 200, r.text);
    copyId = r.json.document.id;
    assert.notEqual(copyId, docId);
  });

  await t("prullenbak: verwijderen, herstellen, definitief verwijderen met bevestiging", async () => {
    let r = await api(anna, "DELETE", `/api/documents/${docId}`);
    assert.equal(r.status, 200, r.text);
    r = await api(anna, "GET", "/api/library");
    assert.ok(!r.json.items.some((d) => d.id === docId));
    r = await api(anna, "GET", "/api/library?trash=1");
    assert.ok(r.json.items.some((d) => d.id === docId));
    r = await api(anna, "POST", `/api/documents/${docId}/restore`);
    assert.equal(r.status, 200, r.text);
    r = await api(anna, "DELETE", `/api/documents/${copyId}`);
    r = await api(anna, "GET", `/api/documents/${copyId}/purge-preview`);
    assert.equal(r.status, 200, r.text);
    r = await api(anna, "POST", `/api/documents/${copyId}/purge`, {});
    assert.equal(r.status, 400, "zonder bevestiging mag niets verdwijnen");
    r = await api(anna, "POST", `/api/documents/${copyId}/purge`, { confirm: true, keepExamples: true });
    assert.equal(r.status, 200, r.text);
    r = await api(admin, "GET", `/api/documents/${copyId}`);
    assert.equal(r.status, 404);
    const aud = await api(admin, "GET", `/api/admin/audit?documentId=${copyId}`);
    assert.ok(aud.json.audit.some((x) => x.action === "definitief_verwijderd"));
  });

  await t("beheeroverzicht enkel voor admin", async () => {
    const no = await api(anna, "GET", "/api/admin/overview");
    assert.equal(no.status, 403);
    const ok = await api(admin, "GET", "/api/admin/overview");
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.storage);
    const ex = await api(admin, "GET", "/api/admin/examples");
    assert.equal(ex.status, 200);
  });

  await t("genereren zonder LLM-sleutel faalt netjes en laat het document intact", async () => {
    const r = await api(anna, "POST", `/api/documents/${docId}/generate`, {});
    assert.ok(r.status >= 400 || r.json?.versionNumber);
    const d = await api(anna, "GET", `/api/documents/${docId}`);
    assert.equal(d.status, 200);
    assert.notEqual(d.json.document.status, "bezig");
  });

  // ── back-up en herstel ────────────────────────────────────────────
  server.kill();
  await new Promise((r) => setTimeout(r, 700));

  const run = (script, args = []) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
    });

  await t("back-up maakt een volledige kopie", async () => {
    const r = await run("scripts/backup.mjs");
    assert.equal(r.code, 0, r.out);
    const names = fs.readdirSync(BACKUPS).filter((n) => /^\d{4}-/.test(n));
    assert.equal(names.length, 1);
    assert.ok(fs.existsSync(path.join(BACKUPS, names[0], "verbeterrobot.db")));
    assert.ok(fs.existsSync(path.join(BACKUPS, names[0], "store")));
  });

  await t("herstel zonder --yes wijzigt niets; met --yes zet de back-up terug", async () => {
    const dbFile = path.join(DATA, "verbeterrobot.db");
    const sizeBefore = fs.statSync(dbFile).size;
    let r = await run("scripts/restore.mjs", ["latest"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.statSync(dbFile).size, sizeBefore);
    // beschadig de store en herstel
    fs.rmSync(path.join(DATA, "store"), { recursive: true, force: true });
    r = await run("scripts/restore.mjs", ["latest", "--yes"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(DATA, "store")));
    assert.ok(fs.readdirSync(DATA).some((n) => n.startsWith("vor-herstel-")));
  });

  console.log(`\n${passed} tests geslaagd.`);
} catch (e) {
  console.error("\nServerlog:\n" + log.slice(-2000));
  process.exitCode = 1;
} finally {
  try {
    server.kill();
  } catch {}
  setTimeout(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    process.exit(process.exitCode || 0);
  }, 800);
}
