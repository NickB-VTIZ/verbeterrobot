/**
 * routes/library.js — documentbibliotheek (P5), aanduiden van rollen (P2), review per antwoord,
 * versies, prullenbak en beheeroverzichten.
 *
 * Alle routes vereisen een sessie. Een leerkracht ziet en beheert enkel eigen documenten,
 * een beheerder ziet alles.
 */
import fs from "fs";
import path from "path";
import { ZipArchive } from "archiver";
import { requireRole } from "../auth.js";
import { parseDocument } from "../parser.js";
import { getAnswersFromAI } from "../ai.js";
import { injectAnswers } from "../injector.js";
import { getSubject } from "../subjects.js";
import { buildGenerationContext } from "../context.js";
import { getSettings } from "../settings.js";
import {
  runDocxPipeline,
  extractDocxParagraphs,
  proposeStructure,
  buildOutputDocx,
} from "../docx/pipeline.js";
import { questionsToMarks, marksToQuestions } from "../docx/marks.js";
import { runWithLlmContext } from "../storage/llmlog.js";
import { getFileRecord } from "../storage/files.js";
import { generateOriginalPreview, generateVersionPreview } from "../storage/previews.js";
import {
  createDocument,
  getDocument,
  canAccess,
  updateDocument,
  setStatus,
  listDocuments,
  filterOptions,
  saveParagraphs,
  getParagraphs,
  saveMarks,
  getMarks,
  ROLES,
  addVersion,
  getVersion,
  listVersions,
  setActiveVersion,
  approveVersion,
  compareVersions,
  addFeedback,
  listFeedback,
  listExamples,
  deleteFeedback,
  listLlmCalls,
  documentCost,
  costOverview,
  storageOverview,
  softDelete,
  restoreDocument,
  purgePreview,
  purgeDocument,
  purgeExpired,
  createTemplate,
  listTemplates,
  getTemplate,
  deleteTemplate,
  duplicateDocument,
  listAudit,
  audit,
} from "../storage/repo.js";

/* ───────────── hulpfuncties ───────────── */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.status !== undefined && err.status < 500) {
      if (!res.headersSent) res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[library]", req.method, req.path, err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || "Onbekende fout." });
  }
};

const userOf = (req) => ({ role: req.role, name: req.user });

function loadDoc(req, { allowDeleted = false } = {}) {
  const doc = getDocument(req.params.id);
  if (!doc || !canAccess(doc, userOf(req))) throw httpError(404, "Document niet gevonden.");
  if (doc.deletedAt && !allowDeleted) throw httpError(409, "Dit document staat in de prullenbak.");
  return doc;
}

function originalOf(doc) {
  const rec = getFileRecord(doc.originalFileId);
  if (!rec || !fs.existsSync(rec.abs)) throw httpError(404, "Het originele bestand ontbreekt op schijf.");
  return rec;
}

const extOf = (rec) => path.extname(rec.abs).toLowerCase();

function safeName(name) {
  return String(name || "bestand").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 180);
}

function sendRecord(res, rec, downloadName, { inline = false } = {}) {
  if (!rec || !fs.existsSync(rec.abs)) throw httpError(404, "Bestand niet gevonden.");
  res.setHeader("Content-Type", rec.mime_type || "application/octet-stream");
  res.setHeader("Content-Length", String(rec.size_bytes ?? fs.statSync(rec.abs).size));
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(safeName(downloadName))}`
  );
  if (inline) res.setHeader("Cache-Control", "private, max-age=300");
  fs.createReadStream(rec.abs).pipe(res);
}

function versionFile(doc, n) {
  const v = getVersion(doc.id, n);
  if (!v) throw httpError(404, "Versie niet gevonden.");
  return v;
}

const keyName = (doc, v, rec) => {
  const base = path.basename(doc.originalFilename, path.extname(doc.originalFilename));
  return `verbetersleutel_${base}_v${v.versionNumber}${extOf(rec)}`;
};

/** Platte tekst van de inhoud van een slot. */
function contentText(c) {
  return Array.isArray(c) ? c.map(String).join("\n") : String(c ?? "");
}

function normalizeContent(orig, given) {
  const clip = (s) => String(s ?? "").slice(0, 4000);
  if (Array.isArray(orig)) {
    const arr = Array.isArray(given) ? given : String(given ?? "").split(/\r?\n/);
    return arr.map(clip);
  }
  return clip(Array.isArray(given) ? given.join("\n") : given);
}

/** Antwoorden per vraag van een versie, aangevuld met vraagtekst, controle-opmerking en beslissing. */
function buildAnswers(doc, version) {
  const paragraphs = getParagraphs(doc.id);
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const feedback = listFeedback(doc.id).filter((f) => f.versionNumber === version.versionNumber);
  const questions = version.questions?.length
    ? version.questions
    : [...new Set(version.slots.map((s) => s.qid))].map((qid) => ({ qid, question_para_ids: [], slots: [] }));
  return questions.map((q) => {
    const slots = version.slots.filter((s) => s.qid === q.qid);
    const issues = (version.qcIssues || [])
      .filter((i) => String(i).startsWith(`${q.qid}: `))
      .map((i) => String(i).slice(String(q.qid).length + 2));
    const last = feedback.find((f) => f.qid === q.qid);
    return {
      qid: q.qid,
      questionText: (q.question_para_ids || [])
        .map((id) => byId.get(id)?.text)
        .filter(Boolean)
        .join("\n"),
      paraIds: q.question_para_ids || [],
      slots: slots.map((s) => ({ paraId: s.para_id, type: s.type, content: s.content })),
      teacherAnswer: version.teacherAnswers?.[q.qid] || "",
      review: issues.join(" | ") || null,
      decision: last ? { action: last.action, user: last.user, at: last.createdAt, comment: last.comment } : null,
    };
  });
}

function versionPublic(v, withDetails = false) {
  const base = {
    versionNumber: v.versionNumber,
    status: v.status,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    summary: v.summary,
    qcIssues: v.qcIssues,
    docxFileId: v.docxFileId,
    pdfFileId: v.pdfFileId,
    thumbFileId: v.thumbFileId,
  };
  return withDetails ? { ...base, slots: v.slots, questions: v.questions, teacherAnswers: v.teacherAnswers } : base;
}

function cleanup(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* negeren */
      }
    }
  }
}

const running = new Set();

async function readGenOptions(doc, text) {
  const opts = doc.genOptions || {};
  const subject = doc.vakId ? getSubject(doc.vakId) : opts.subjectId ? getSubject(opts.subjectId) : null;
  const topics = Array.isArray(opts.topics) ? opts.topics : [];
  const subjectContext = await buildGenerationContext({ subject, topics, text });
  return { extraContext: opts.context || "", subjectContext, subject };
}

function parseIds(v) {
  const arr = Array.isArray(v) ? v : [];
  return [...new Set(arr.map(String))].slice(0, 200);
}

/* ───────────── registratie ───────────── */

export function registerLibraryRoutes(app, { makeUpload }) {
  const teacherOrAdmin = requireRole("teacher", "admin");
  const adminOnly = requireRole("admin");

  /* ── lijst, filters ── */

  app.get(
    "/api/library",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const q = req.query;
      const result = listDocuments(
        {
          q: q.q,
          vak: q.vak,
          teacher: q.teacher,
          leerjaar: q.leerjaar,
          richting: q.richting,
          schooljaar: q.schooljaar,
          status: q.status,
          tag: q.tag,
          trash: q.trash === "1",
          sort: q.sort,
          limit: q.limit,
          offset: q.offset,
        },
        userOf(req)
      );
      res.json(result);
    })
  );

  app.get(
    "/api/library/options",
    teacherOrAdmin,
    wrap(async (req, res) => res.json(filterOptions(userOf(req))))
  );

  /* ── bulkacties ── */

  app.post(
    "/api/library/bulk",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const { action, tags, keepExamples, confirm } = req.body || {};
      const ids = parseIds(req.body?.ids);
      if (!ids.length) throw httpError(400, "Geen documenten geselecteerd.");
      const user = userOf(req);
      const done = [];
      const skipped = [];
      for (const id of ids) {
        const doc = getDocument(id);
        if (!doc || !canAccess(doc, user)) {
          skipped.push({ id, reden: "niet gevonden" });
          continue;
        }
        try {
          if (action === "tags_add" || action === "tags_remove") {
            const given = (Array.isArray(tags) ? tags : String(tags || "").split(","))
              .map((t) => String(t).trim().toLowerCase())
              .filter(Boolean);
            if (!given.length) throw new Error("Geen tags opgegeven.");
            const next =
              action === "tags_add"
                ? [...new Set([...doc.tags, ...given])]
                : doc.tags.filter((t) => !given.includes(t));
            updateDocument(id, { tags: next });
            audit(id, req.user, req.role, "tags_gewijzigd", { actie: action, tags: given });
          } else if (action === "delete") {
            if (doc.deletedAt) throw new Error("staat al in de prullenbak");
            softDelete(id, req.user);
            audit(id, req.user, req.role, "naar_prullenbak", null);
          } else if (action === "restore") {
            if (!restoreDocument(id)) throw new Error("niet in de prullenbak");
            audit(id, req.user, req.role, "hersteld", null);
          } else if (action === "purge") {
            if (confirm !== true) throw new Error("bevestiging ontbreekt");
            if (!doc.deletedAt) throw new Error("staat niet in de prullenbak");
            purgeDocument(id, { keepExamples: keepExamples !== false, user: req.user, role: req.role });
          } else {
            throw new Error("Onbekende actie.");
          }
          done.push(id);
        } catch (err) {
          skipped.push({ id, reden: err.message });
        }
      }
      res.json({ done, skipped });
    })
  );

  /** ZIP van de actieve sleutels (en optioneel de originelen) van meerdere documenten. */
  app.post(
    "/api/library/zip",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const ids = parseIds(req.body?.ids);
      if (!ids.length) throw httpError(400, "Geen documenten geselecteerd.");
      const includeOriginals = req.body?.includeOriginals === true;
      const user = userOf(req);
      const entries = [];
      let n = 0;
      for (const id of ids) {
        const doc = getDocument(id);
        if (!doc || doc.deletedAt || !canAccess(doc, user)) continue;
        n++;
        const prefix = String(n).padStart(2, "0");
        const v = doc.activeVersion ? getVersion(id, doc.activeVersion) : null;
        const rec = v ? getFileRecord(v.docxFileId) : null;
        if (rec && fs.existsSync(rec.abs)) {
          entries.push({ abs: rec.abs, name: `${prefix}_${safeName(keyName(doc, v, rec))}` });
        }
        if (includeOriginals) {
          const o = getFileRecord(doc.originalFileId);
          if (o && fs.existsSync(o.abs)) entries.push({ abs: o.abs, name: `${prefix}_origineel_${safeName(doc.originalFilename)}` });
        }
        audit(id, req.user, req.role, "download", { soort: "zip_selectie" });
      }
      if (!entries.length) throw httpError(404, "Geen bestanden om te downloaden.");
      await streamZip(res, "verbetersleutels.zip", entries);
    })
  );

  /* ── nieuw document uploaden (zonder meteen te genereren) ── */

  app.post(
    "/api/documents",
    teacherOrAdmin,
    (req, res, next) => {
      makeUpload().single("file")(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      });
    },
    wrap(async (req, res) => {
      const file = req.file;
      if (!file) throw httpError(400, "Geen bestand ontvangen.");
      try {
        const ext = path.extname(file.originalname).toLowerCase();
        const text = await parseDocument(file.path, ext);
        if (!text || text.trim().length < 10) throw httpError(422, "Kon geen leesbare tekst uit het document halen.");
        const b = req.body || {};
        const subject = b.subjectId ? getSubject(String(b.subjectId)) : null;
        let topics = [];
        try {
          topics = JSON.parse(b.topics || "[]");
          if (!Array.isArray(topics)) topics = [];
        } catch {
          topics = [];
        }
        const created = createDocument({
          srcPath: file.path,
          originalName: file.originalname,
          user: req.user,
          vak: subject?.naam || b.vak || "",
          vakId: subject?.id || "",
          leerjaar: b.leerjaar,
          richting: b.richting,
          schooljaar: b.schooljaar,
          tags: b.tags,
          title: b.title,
          fullText: text,
          genOptions: { context: b.context || "", topics, subjectId: subject?.id || null },
        });
        const id = created.doc.id;
        if (ext === ".docx") {
          try {
            saveParagraphs(id, await extractDocxParagraphs(file.path));
          } catch (err) {
            console.warn("[library] paragrafen extraheren mislukt:", err.message);
          }
        }
        audit(id, req.user, req.role, "upload", {
          bestand: file.originalname,
          grootte: file.size,
          duplicaatVan: created.duplicates.map((d) => d.id),
        });
        generateOriginalPreview(id);
        res.json({ document: getDocument(id), duplicates: created.duplicates });
      } finally {
        cleanup(file.path);
      }
    })
  );

  /* ── detail ── */

  app.get(
    "/api/documents/:id",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const versions = listVersions(doc.id).map((v) => versionPublic(v));
      const teacherMarks = getMarks(doc.id, "teacher");
      const proposal = getMarks(doc.id, "llm_proposal");
      const ext = path.extname(doc.originalFilename).toLowerCase();
      res.json({
        document: doc,
        versions,
        feedback: listFeedback(doc.id),
        cost: documentCost(doc.id),
        llmCalls: listLlmCalls(doc.id),
        audit: listAudit({ documentId: doc.id, limit: 100 }),
        marks: { teacher: teacherMarks.length, proposal: proposal.length },
        markable: ext === ".docx",
        generating: running.has(doc.id),
      });
    })
  );

  app.patch(
    "/api/documents/:id",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const b = req.body || {};
      const patch = {};
      for (const k of ["title", "vak", "leerjaar", "richting", "schooljaar", "tags", "note"]) {
        if (b[k] !== undefined) patch[k] = b[k];
      }
      if (b.vakId !== undefined) patch.vakId = b.vakId;
      const updated = updateDocument(doc.id, patch);
      audit(doc.id, req.user, req.role, "gewijzigd", { velden: Object.keys(patch) });
      res.json({ document: updated });
    })
  );

  /** Admin: volledige prompt/antwoord van de LLM-aanroepen. */
  app.get(
    "/api/documents/:id/llm-calls",
    adminOnly,
    wrap(async (req, res) => {
      const doc = getDocument(req.params.id);
      if (!doc) throw httpError(404, "Document niet gevonden.");
      res.json({ calls: listLlmCalls(doc.id, { withText: true }) });
    })
  );

  /* ── downloads en voorbeelden ── */

  app.get(
    "/api/documents/:id/download/original",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const rec = originalOf(doc);
      audit(doc.id, req.user, req.role, "download", { soort: "origineel" });
      sendRecord(res, rec, doc.originalFilename);
    })
  );

  app.get(
    "/api/documents/:id/download/version/:n",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const v = versionFile(doc, Number(req.params.n));
      const rec = getFileRecord(v.docxFileId);
      audit(doc.id, req.user, req.role, "download", { soort: "versie", versie: v.versionNumber });
      sendRecord(res, rec, keyName(doc, v, rec));
    })
  );

  app.get(
    "/api/documents/:id/download/active",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      if (!doc.activeVersion) throw httpError(404, "Nog geen sleutel gegenereerd.");
      const v = versionFile(doc, doc.activeVersion);
      const rec = getFileRecord(v.docxFileId);
      audit(doc.id, req.user, req.role, "download", { soort: "actieve_sleutel", versie: v.versionNumber });
      sendRecord(res, rec, keyName(doc, v, rec));
    })
  );

  app.get(
    "/api/documents/:id/download/zip",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const entries = [];
      const o = getFileRecord(doc.originalFileId);
      if (o && fs.existsSync(o.abs)) entries.push({ abs: o.abs, name: `origineel/${safeName(doc.originalFilename)}` });
      for (const v of listVersions(doc.id)) {
        const rec = getFileRecord(v.docxFileId);
        if (rec && fs.existsSync(rec.abs)) entries.push({ abs: rec.abs, name: `versies/${safeName(keyName(doc, v, rec))}` });
      }
      if (!entries.length) throw httpError(404, "Geen bestanden gevonden.");
      audit(doc.id, req.user, req.role, "download", { soort: "zip_alles" });
      await streamZip(res, `${safeName(doc.title)}.zip`, entries);
    })
  );

  /** Miniaturen en PDF-weergaven (inline). */
  app.get(
    "/api/documents/:id/preview/original/:kind",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const id = req.params.kind === "pdf" ? doc.originalPdfFileId : req.params.kind === "thumb" ? doc.originalThumbFileId : null;
      const rec = getFileRecord(id);
      if (!rec) throw httpError(404, "Voorbeeld (nog) niet beschikbaar.");
      sendRecord(res, rec, req.params.kind === "pdf" ? "origineel.pdf" : "origineel.png", { inline: true });
    })
  );

  app.get(
    "/api/documents/:id/preview/version/:n/:kind",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const v = versionFile(doc, Number(req.params.n));
      const id = req.params.kind === "pdf" ? v.pdfFileId : req.params.kind === "thumb" ? v.thumbFileId : null;
      const rec = getFileRecord(id);
      if (!rec) throw httpError(404, "Voorbeeld (nog) niet beschikbaar.");
      sendRecord(res, rec, `versie${v.versionNumber}.${req.params.kind === "pdf" ? "pdf" : "png"}`, { inline: true });
    })
  );

  /** Voorbeeld opnieuw laten maken (bv. na installatie van LibreOffice). */
  app.post(
    "/api/documents/:id/preview/retry",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      generateOriginalPreview(doc.id);
      for (const v of listVersions(doc.id)) generateVersionPreview(doc.id, v.versionNumber);
      res.json({ ok: true });
    })
  );

  /* ── versies ── */

  app.get(
    "/api/documents/:id/versions/:n",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const v = versionFile(doc, Number(req.params.n));
      const ext = path.extname(doc.originalFilename).toLowerCase();
      res.json({
        version: versionPublic(v),
        answers: buildAnswers(doc, v),
        editable: ext === ".docx",
      });
    })
  );

  app.get(
    "/api/documents/:id/compare",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      const cmp = compareVersions(doc.id, Number(req.query.a), Number(req.query.b));
      if (!cmp) throw httpError(404, "Versie niet gevonden.");
      res.json(cmp);
    })
  );

  app.post(
    "/api/documents/:id/versions/:n/activate",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const v = versionFile(doc, Number(req.params.n));
      const updated = setActiveVersion(doc.id, v.versionNumber);
      audit(doc.id, req.user, req.role, "versie_actief", { versie: v.versionNumber });
      res.json({ document: updated });
    })
  );

  /** Hele versie goedkeuren: alle antwoorden zonder beslissing worden voorbeelden. */
  app.post(
    "/api/documents/:id/versions/:n/approve",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const v = versionFile(doc, Number(req.params.n));
      const decided = new Set(
        listFeedback(doc.id)
          .filter((f) => f.versionNumber === v.versionNumber)
          .map((f) => f.qid)
      );
      for (const a of buildAnswers(doc, v)) {
        if (decided.has(a.qid)) continue;
        addFeedback({
          docId: doc.id,
          versionNumber: v.versionNumber,
          qid: a.qid,
          paraId: a.slots[0]?.paraId,
          questionText: a.questionText,
          originalAnswer: a.slots.map((s) => contentText(s.content)).join("\n"),
          action: "goedgekeurd",
          user: req.user,
        });
      }
      approveVersion(doc.id, v.versionNumber);
      audit(doc.id, req.user, req.role, "goedgekeurd", { versie: v.versionNumber });
      res.json({ document: getDocument(doc.id) });
    })
  );

  /**
   * Review per antwoord. Body: { edits: [{qid, slots:[content,…]}], approve: [qid], comment }
   * Aanpassingen leiden tot een NIEUWE versie (nooit overschrijven) en worden als feedback bewaard.
   */
  app.post(
    "/api/documents/:id/versions/:n/review",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const v = versionFile(doc, Number(req.params.n));
      const orig = originalOf(doc);
      const answers = buildAnswers(doc, v);
      const byQid = new Map(answers.map((a) => [a.qid, a]));
      const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
      const approve = parseIds(req.body?.approve);
      const comment = req.body?.comment ? String(req.body.comment).slice(0, 2000) : "";

      const newSlots = v.slots.map((s) => ({ ...s }));
      const changedQids = [];
      for (const e of edits) {
        const a = byQid.get(String(e.qid));
        if (!a || !Array.isArray(e.slots)) continue;
        const own = newSlots.filter((s) => s.qid === a.qid);
        let changed = false;
        own.forEach((s, i) => {
          if (e.slots[i] === undefined) return;
          const next = normalizeContent(s.content, e.slots[i]);
          if (JSON.stringify(next) !== JSON.stringify(s.content)) {
            s.content = next;
            changed = true;
          }
        });
        if (changed) changedQids.push(a.qid);
      }

      for (const qid of approve) {
        const a = byQid.get(qid);
        if (!a || changedQids.includes(qid)) continue;
        addFeedback({
          docId: doc.id,
          versionNumber: v.versionNumber,
          qid,
          paraId: a.slots[0]?.paraId,
          questionText: a.questionText,
          originalAnswer: a.slots.map((s) => contentText(s.content)).join("\n"),
          action: "goedgekeurd",
          comment,
          user: req.user,
        });
      }

      if (!changedQids.length) return res.json({ changed: false, versionNumber: v.versionNumber });
      if (path.extname(doc.originalFilename).toLowerCase() !== ".docx") {
        throw httpError(400, "Antwoorden bewerken kan enkel bij Word-documenten (.docx).");
      }

      const { outputPath, result } = await buildOutputDocx(orig.abs, newSlots);
      let versionNumber;
      try {
        const qc = (v.qcIssues || []).filter((i) => !changedQids.some((q) => String(i).startsWith(`${q}: `)));
        for (const u of result.unplaced || []) qc.push(`${u.qid || "?"}: Handmatig nakijken — antwoord niet geplaatst (${u.reason})`);
        versionNumber = addVersion({
          docId: doc.id,
          outputPath,
          ext: ".docx",
          createdBy: req.user,
          summary: { ...(v.summary || {}), basis: v.versionNumber, bewerkt: changedQids },
          qcIssues: qc,
          slots: newSlots,
          questions: v.questions,
          teacherAnswers: v.teacherAnswers,
        });
      } finally {
        cleanup(outputPath);
      }

      for (const qid of changedQids) {
        const before = byQid.get(qid);
        const after = newSlots.filter((s) => s.qid === qid);
        addFeedback({
          docId: doc.id,
          versionNumber,
          qid,
          paraId: before.slots[0]?.paraId,
          questionText: before.questionText,
          originalAnswer: before.slots.map((s) => contentText(s.content)).join("\n"),
          correctedAnswer: after.map((s) => contentText(s.content)).join("\n"),
          action: "aangepast",
          comment,
          user: req.user,
        });
      }
      audit(doc.id, req.user, req.role, "antwoorden_aangepast", { van: v.versionNumber, naar: versionNumber, vragen: changedQids });
      generateVersionPreview(doc.id, versionNumber);
      res.json({ changed: true, versionNumber });
    })
  );

  /** Enkele vragen opnieuw laten genereren (met opmerking). Body: { qids:[], comments:{qid:tekst} } */
  app.post(
    "/api/documents/:id/versions/:n/regenerate",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      if (running.has(doc.id)) throw httpError(409, "Er loopt al een generatie voor dit document.");
      const v = versionFile(doc, Number(req.params.n));
      const orig = originalOf(doc);
      if (path.extname(doc.originalFilename).toLowerCase() !== ".docx" || !v.questions?.length) {
        throw httpError(400, "Opnieuw genereren per vraag kan enkel bij Word-documenten met herkende vragen.");
      }
      const qids = parseIds(req.body?.qids).filter((q) => v.questions.some((x) => x.qid === q));
      if (!qids.length) throw httpError(400, "Geen geldige vragen gekozen.");
      const comments = {};
      for (const q of qids) {
        const c = req.body?.comments?.[q];
        if (c) comments[q] = String(c).slice(0, 1500);
      }
      const byQid = new Map(buildAnswers(doc, v).map((a) => [a.qid, a]));
      const previous = {};
      for (const q of qids) previous[q] = byQid.get(q)?.slots.map((s) => contentText(s.content)).join("\n") || "";

      running.add(doc.id);
      try {
        const text = await parseDocument(orig.abs, ".docx");
        const gen = await readGenOptions(doc, text);
        const marks = getMarks(doc.id, "teacher");
        const reference = marks.length ? marksToQuestions(marks, getParagraphs(doc.id)).reference : "";
        const result = await runWithLlmContext(
          { documentId: doc.id, callType: "opnieuw", vak: doc.vak || "", teacher: req.user },
          () =>
            runDocxPipeline(orig.abs, {
              extraContext: [gen.extraContext, reference ? `Formuleblad/referentie:\n${reference}` : ""].filter(Boolean).join("\n\n"),
              subjectContext: gen.subjectContext,
              questions: v.questions,
              teacherAnswers: v.teacherAnswers || {},
              only: qids,
              reuseSlots: v.slots,
              comments,
              previous,
              skipVisual: true,
            })
        );
        if (!result) throw httpError(422, "Het opnieuw genereren leverde geen antwoorden op.");
        const keep = (v.qcIssues || []).filter((i) => !qids.some((q) => String(i).startsWith(`${q}: `)));
        const qc = [...keep, ...result.warnings.filter((w) => !keep.includes(w)), ...result.review.map((r) => `${r.qid}: ${r.reden}`)];
        let versionNumber;
        try {
          versionNumber = addVersion({
            docId: doc.id,
            outputPath: result.outputPath,
            ext: ".docx",
            createdBy: req.user,
            summary: { ...(v.summary || {}), basis: v.versionNumber, opnieuw: qids },
            qcIssues: qc,
            slots: result.slots,
            questions: v.questions,
            teacherAnswers: v.teacherAnswers,
          });
        } finally {
          cleanup(result.outputPath);
        }
        const fresh = getVersion(doc.id, versionNumber);
        const freshBy = new Map(buildAnswers(doc, fresh).map((a) => [a.qid, a]));
        for (const q of qids) {
          addFeedback({
            docId: doc.id,
            versionNumber,
            qid: q,
            paraId: byQid.get(q)?.slots[0]?.paraId,
            questionText: byQid.get(q)?.questionText,
            originalAnswer: previous[q],
            correctedAnswer: freshBy.get(q)?.slots.map((s) => contentText(s.content)).join("\n"),
            action: "opnieuw_gegenereerd",
            comment: comments[q] || "",
            user: req.user,
          });
        }
        audit(doc.id, req.user, req.role, "opnieuw_gegenereerd", { van: v.versionNumber, naar: versionNumber, vragen: qids });
        generateVersionPreview(doc.id, versionNumber);
        res.json({ versionNumber });
      } finally {
        running.delete(doc.id);
      }
    })
  );

  /* ── aanduidingen (P2) ── */

  app.get(
    "/api/documents/:id/paragraphs",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      if (path.extname(doc.originalFilename).toLowerCase() !== ".docx") {
        throw httpError(400, "Aanduiden kan enkel bij Word-documenten (.docx).");
      }
      let paragraphs = getParagraphs(doc.id);
      if (!paragraphs.length) {
        paragraphs = await extractDocxParagraphs(originalOf(doc).abs);
        saveParagraphs(doc.id, paragraphs);
        paragraphs = getParagraphs(doc.id);
      }
      res.json({
        paragraphs,
        marks: getMarks(doc.id, "teacher"),
        proposal: getMarks(doc.id, "llm_proposal"),
        roles: ROLES,
      });
    })
  );

  /** Het taalmodel doet een voorstel; de leerkracht corrigeert nadien. */
  app.post(
    "/api/documents/:id/propose",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      if (path.extname(doc.originalFilename).toLowerCase() !== ".docx") {
        throw httpError(400, "Aanduiden kan enkel bij Word-documenten (.docx).");
      }
      if (running.has(doc.id)) throw httpError(409, "Er loopt al een bewerking voor dit document.");
      running.add(doc.id);
      try {
        const orig = originalOf(doc);
        const { questions } = await runWithLlmContext(
          { documentId: doc.id, callType: "voorstel", vak: doc.vak || "", teacher: req.user },
          () => proposeStructure(orig.abs, { extraContext: doc.genOptions?.context || "" })
        );
        const marks = questionsToMarks(questions);
        saveMarks(doc.id, "llm_proposal", marks);
        audit(doc.id, req.user, req.role, "voorstel_gemaakt", { aantal: marks.length });
        res.json({ proposal: marks });
      } finally {
        running.delete(doc.id);
      }
    })
  );

  /** Bewaart de aanduidingen van de leerkracht en geeft de controle (fouten/waarschuwingen) terug. */
  app.put(
    "/api/documents/:id/marks",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const incoming = Array.isArray(req.body?.marks) ? req.body.marks : [];
      const paragraphs = getParagraphs(doc.id);
      const known = new Set(paragraphs.map((p) => p.id));
      const marks = incoming
        .filter((m) => m && known.has(String(m.paraId)) && ROLES.includes(m.role))
        .map((m) => ({
          paraId: String(m.paraId),
          role: m.role,
          qid: m.qid ? String(m.qid).slice(0, 40) : "",
          subNr: m.subNr ? String(m.subNr).slice(0, 40) : "",
          slotType: m.slotType || null,
          slotCount: Number.isFinite(Number(m.slotCount)) && m.slotCount !== "" && m.slotCount != null ? Number(m.slotCount) : null,
          linkedParaIds: Array.isArray(m.linkedParaIds) ? m.linkedParaIds.map(String) : [],
          teacherAnswer: m.teacherAnswer ? String(m.teacherAnswer) : "",
        }));
      saveMarks(doc.id, "teacher", marks);
      if (marks.length && ["geupload", "aangeduid", "mislukt"].includes(doc.status)) setStatus(doc.id, "aangeduid");
      audit(doc.id, req.user, req.role, "aanduidingen_bewaard", { aantal: marks.length });
      const check = marks.length
        ? marksToQuestions(marks.map((m) => ({ ...m })), paragraphs)
        : { questions: [], errors: [], warnings: [] };
      res.json({
        saved: marks.length,
        questions: check.questions.length,
        errors: check.errors,
        warnings: check.warnings,
      });
    })
  );

  /* ── genereren ── */

  /**
   * Genereert een nieuwe versie op basis van de aanduidingen (of automatisch als er geen zijn).
   * Body (optioneel): { context }
   */
  app.post(
    "/api/documents/:id/generate",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      if (running.has(doc.id)) throw httpError(409, "Er loopt al een generatie voor dit document.");
      const orig = originalOf(doc);
      const ext = path.extname(doc.originalFilename).toLowerCase();
      const previousStatus = doc.status;
      running.add(doc.id);
      setStatus(doc.id, "bezig");
      audit(doc.id, req.user, req.role, "generatie_gestart", null);
      let outputPath = null;
      try {
        const text = await parseDocument(orig.abs, ext);
        const gen = await readGenOptions(doc, text);
        const extraBase = [gen.extraContext, req.body?.context ? String(req.body.context).slice(0, 4000) : ""]
          .filter(Boolean)
          .join("\n\n");
        const llmCtx = { documentId: doc.id, callType: "generatie", vak: doc.vak || "", teacher: req.user };

        let slots = [];
        let questions = [];
        let qcIssues = [];
        let teacherAnswers = {};
        let review = [];
        let visual = "";
        let usedMarks = false;

        if (ext === ".docx" && process.env.DOCX_PIPELINE !== "off") {
          const paragraphs = getParagraphs(doc.id).length ? getParagraphs(doc.id) : await extractDocxParagraphs(orig.abs);
          if (!getParagraphs(doc.id).length) saveParagraphs(doc.id, paragraphs);
          const marks = getMarks(doc.id, "teacher");
          const opts = { extraContext: extraBase, subjectContext: gen.subjectContext };
          if (marks.length) {
            const m = marksToQuestions(marks, getParagraphs(doc.id));
            if (m.errors.length) {
              throw httpError(422, `De aanduidingen bevatten fouten: ${m.errors.slice(0, 5).join(" | ")}`);
            }
            if (!m.questions.length) throw httpError(422, "De aanduidingen bevatten geen vraag met een antwoordplaats.");
            opts.questions = m.questions;
            opts.teacherAnswers = m.teacherAnswers;
            if (m.reference) opts.extraContext = [extraBase, `Formuleblad/referentie:\n${m.reference}`].filter(Boolean).join("\n\n");
            qcIssues.push(...m.warnings);
            usedMarks = true;
          }
          const result = await runWithLlmContext(llmCtx, () => runDocxPipeline(orig.abs, opts));
          if (!result) {
            throw httpError(
              422,
              "Er werden geen vragen of antwoordplaatsen herkend in dit Word-document. Er is niets achteraan toegevoegd. Duid de vragen en antwoordplaatsen zelf aan."
            );
          }
          outputPath = result.outputPath;
          slots = result.slots;
          questions = result.questionList;
          teacherAnswers = opts.teacherAnswers || {};
          review = result.review;
          visual = result.visual?.status || "";
          qcIssues.push(...result.warnings, ...result.review.map((r) => `${r.qid}: ${r.reden}`));
        } else {
          const answers = await runWithLlmContext(llmCtx, () => getAnswersFromAI(text, extraBase, gen.subjectContext));
          if (!answers || !answers.length) throw httpError(422, "AI kon geen vragen vinden in het document.");
          outputPath = await injectAnswers(orig.abs, ext, answers);
          slots = answers.map((a, i) => ({ qid: `k${i + 1}`, para_id: "", type: "klassiek", content: a.antwoord ?? a.answer ?? "" }));
        }

        const versionNumber = addVersion({
          docId: doc.id,
          outputPath,
          ext: path.extname(outputPath).toLowerCase() || ext,
          createdBy: req.user,
          summary: { aantalVragen: questions.length, nakijken: review.length, visueel: visual || null, opAanduidingen: usedMarks },
          qcIssues,
          slots,
          questions,
          teacherAnswers,
        });
        audit(doc.id, req.user, req.role, "gegenereerd", { versie: versionNumber, opAanduidingen: usedMarks });
        generateOriginalPreview(doc.id);
        generateVersionPreview(doc.id, versionNumber);
        res.json({ versionNumber, review, warnings: qcIssues });
      } catch (err) {
        const hasMarks = getMarks(doc.id, "teacher").length > 0;
        setStatus(doc.id, previousStatus === "gegenereerd" || previousStatus === "goedgekeurd" ? previousStatus : hasMarks ? "aangeduid" : "mislukt");
        audit(doc.id, req.user, req.role, "generatie_mislukt", { fout: String(err.message).slice(0, 300) });
        if (!err.status) err.status = 502;
        throw err;
      } finally {
        running.delete(doc.id);
        cleanup(outputPath);
      }
    })
  );

  /* ── prullenbak, verwijderen ── */

  app.delete(
    "/api/documents/:id",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      softDelete(doc.id, req.user);
      audit(doc.id, req.user, req.role, "naar_prullenbak", null);
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/documents/:id/restore",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      if (!restoreDocument(doc.id)) throw httpError(409, "Dit document staat niet in de prullenbak.");
      audit(doc.id, req.user, req.role, "hersteld", null);
      res.json({ document: getDocument(doc.id) });
    })
  );

  /** Overzicht van wat er definitief verdwijnt (voor de bevestiging). */
  app.get(
    "/api/documents/:id/purge-preview",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      res.json({ preview: purgePreview(doc.id), retentionDays: Number(getSettings().trashRetentionDays) || 30 });
    })
  );

  app.post(
    "/api/documents/:id/purge",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req, { allowDeleted: true });
      if (!doc.deletedAt) throw httpError(409, "Verplaats het document eerst naar de prullenbak.");
      if (req.body?.confirm !== true) throw httpError(400, "Bevestiging ontbreekt.");
      purgeDocument(doc.id, { keepExamples: req.body?.keepExamples !== false, user: req.user, role: req.role });
      res.json({ ok: true });
    })
  );

  /* ── dupliceren en sjablonen ── */

  app.post(
    "/api/documents/:id/duplicate",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const copy = duplicateDocument(doc.id, req.user);
      if (!copy) throw httpError(500, "Dupliceren mislukt.");
      audit(copy.id, req.user, req.role, "gedupliceerd", { van: doc.id });
      generateOriginalPreview(copy.id);
      res.json({ document: copy });
    })
  );

  app.post(
    "/api/documents/:id/template",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const id = createTemplate({ docId: doc.id, name: req.body?.name, owner: req.user });
      audit(doc.id, req.user, req.role, "sjabloon_opgeslagen", { sjabloon: id });
      res.json({ id });
    })
  );

  app.get(
    "/api/templates",
    teacherOrAdmin,
    wrap(async (req, res) => res.json({ templates: listTemplates(userOf(req)) }))
  );

  app.delete(
    "/api/templates/:id",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const t = getTemplate(req.params.id);
      if (!t || (req.role !== "admin" && t.owner !== req.user)) throw httpError(404, "Sjabloon niet gevonden.");
      deleteTemplate(t.id);
      res.json({ ok: true });
    })
  );

  /** Past de aanduidingen van een sjabloon toe op dit document (enkel paragraaf-ID's die bestaan). */
  app.post(
    "/api/documents/:id/apply-template",
    teacherOrAdmin,
    wrap(async (req, res) => {
      const doc = loadDoc(req);
      const t = getTemplate(String(req.body?.templateId || ""));
      if (!t || (req.role !== "admin" && t.owner !== req.user)) throw httpError(404, "Sjabloon niet gevonden.");
      const known = new Set(getParagraphs(doc.id).map((p) => p.id));
      const marks = t.marks.filter((m) => known.has(m.paraId));
      if (!marks.length) throw httpError(422, "De aanduidingen van dit sjabloon passen niet op dit document.");
      saveMarks(doc.id, "teacher", marks);
      if (["geupload", "mislukt"].includes(doc.status)) setStatus(doc.id, "aangeduid");
      audit(doc.id, req.user, req.role, "sjabloon_toegepast", { sjabloon: t.id, aantal: marks.length, overgeslagen: t.marks.length - marks.length });
      res.json({ applied: marks.length, skipped: t.marks.length - marks.length });
    })
  );

  /* ── beheer: kosten, opslag, audit, voorbeelden ── */

  app.get(
    "/api/admin/overview",
    adminOnly,
    wrap(async (_req, res) => {
      const s = getSettings();
      res.json({
        cost: costOverview(),
        storage: storageOverview(),
        trashRetentionDays: Number(s.trashRetentionDays) || 30,
        priceInPer1M: s.priceInPer1M ?? null,
        priceOutPer1M: s.priceOutPer1M ?? null,
      });
    })
  );

  app.get(
    "/api/admin/audit",
    adminOnly,
    wrap(async (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
      res.json({ audit: listAudit({ documentId: req.query.documentId ? String(req.query.documentId) : null, limit }) });
    })
  );

  app.get(
    "/api/admin/examples",
    adminOnly,
    wrap(async (req, res) => res.json({ examples: listExamples({ limit: req.query.limit }) }))
  );

  app.delete(
    "/api/admin/examples/:id",
    adminOnly,
    wrap(async (req, res) => {
      if (!deleteFeedback(req.params.id)) throw httpError(404, "Voorbeeld niet gevonden.");
      audit(null, req.user, req.role, "voorbeeld_verwijderd", { id: req.params.id });
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/admin/purge-expired",
    adminOnly,
    wrap(async (req, res) => {
      const n = purgeExpired();
      audit(null, req.user, req.role, "prullenbak_opgeruimd", { aantal: n });
      res.json({ purged: n });
    })
  );
}

/** Stuurt een ZIP als download; bestanden worden gestreamd, niet in het geheugen geladen. */
function streamZip(res, filename, entries) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName(filename))}`);
    archive.on("error", (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy(err);
      reject(err);
    });
    res.on("close", resolve);
    archive.pipe(res);
    for (const e of entries) archive.file(e.abs, { name: e.name });
    archive.finalize().catch(reject);
  });
}
