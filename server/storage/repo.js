/**
 * repo.js — repository-laag boven op SQLite + bestandsopslag.
 *
 * Documenten, versies, aanduidingen, feedback, audit, sjablonen, prullenbak en statistieken.
 * Alle schrijfacties die meerdere tabellen raken gebeuren in een transactie.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getDb } from "./db.js";
import { getSettings } from "../settings.js";
import { storeFile, getFileRecord, deleteFiles, removeDocDir, findDuplicatesBySha, storageUsage, sha256Buffer } from "./files.js";

/* ───────────── hulpfuncties ───────────── */

function parseJson(s, fallback) {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function normTags(tags) {
  const arr = Array.isArray(tags) ? tags : String(tags || "").split(",");
  const out = [];
  for (const t of arr) {
    const v = String(t).trim().toLowerCase().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 30);
}

const clip = (v, n = 120) => (v == null ? null : String(v).trim().slice(0, n) || null);

/** Schooljaar van vandaag, bv. "2025-2026" (schooljaar start op 1 september). */
export function currentSchoolYear(date = new Date()) {
  const y = date.getFullYear();
  const start = date.getMonth() >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

export const STATUSES = ["geupload", "aangeduid", "bezig", "gegenereerd", "goedgekeurd", "mislukt"];

/* ───────────── audit ───────────── */

export function audit(documentId, user, role, action, details = null) {
  try {
    getDb()
      .prepare(`INSERT INTO audit_log (id, document_id, action, user, role, details_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), documentId || null, action, user || "onbekend", role || "onbekend", details ? JSON.stringify(details) : null);
  } catch (err) {
    console.warn("[audit] mislukt:", err.message);
  }
}

export function listAudit({ documentId = null, limit = 200 } = {}) {
  const db = getDb();
  const rows = documentId
    ? db.prepare(`SELECT * FROM audit_log WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(documentId, limit)
    : db.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit);
  return rows.map((r) => ({ ...r, details: parseJson(r.details_json, null), details_json: undefined }));
}

/* ───────────── documenten ───────────── */

function rowToDoc(r, extra = {}) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    originalFilename: r.original_filename,
    teacher: r.teacher,
    vak: r.vak,
    vakId: r.vak_id,
    leerjaar: r.leerjaar,
    richting: r.richting,
    schooljaar: r.schooljaar,
    tags: parseJson(r.tags_json, []),
    status: r.status,
    activeVersion: r.active_version,
    previewStatus: r.preview_status,
    proposalStatus: r.proposal_status || "geen",
    proposalError: r.proposal_error || null,
    note: r.note,
    genOptions: parseJson(r.gen_options_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by,
    ...extra,
  };
}

export function indexDocument(docId) {
  const db = getDb();
  const d = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId);
  db.prepare(`DELETE FROM documents_fts WHERE document_id = ?`).run(docId);
  if (!d) return;
  db.prepare(`INSERT INTO documents_fts (document_id, title, vak, tags, full_text) VALUES (?, ?, ?, ?, ?)`).run(
    docId,
    d.title || "",
    d.vak || "",
    parseJson(d.tags_json, []).join(" "),
    d.full_text || ""
  );
}

/**
 * Maakt een document op basis van een geüpload bestand. Het origineel wordt ongewijzigd bewaard.
 * @returns {{ doc, duplicates: Array }}
 */
export function createDocument({ srcPath, originalName, user, vak, vakId, leerjaar, richting, schooljaar, tags, title, fullText, genOptions }) {
  const db = getDb();
  const id = randomUUID();
  const ext = path.extname(originalName || srcPath || "").toLowerCase();
  const data = fs.readFileSync(srcPath);
  const sha = sha256Buffer(data);
  const duplicates = findDuplicatesBySha(sha).filter((d) => !d.deleted_at);
  const cleanName = clip(path.basename(originalName || "document" + ext), 200) || "document";
  const baseTitle = clip(title, 160) || cleanName.replace(/\.[^.]+$/, "");

  const tx = db.transaction(() => {
    // documents verwijst naar files; files verwijst niet naar documents → eerst bestand, dan rij
    const fileId = storeFile({ docId: id, buffer: data, ext });
    db.prepare(
      `INSERT INTO documents (id, title, original_filename, teacher, vak, vak_id, leerjaar, richting, schooljaar,
         tags_json, status, original_file_id, full_text, gen_options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'geupload', ?, ?, ?)`
    ).run(
      id,
      baseTitle,
      cleanName,
      clip(user, 60) || "onbekend",
      clip(vak),
      clip(vakId, 60),
      clip(leerjaar, 40),
      clip(richting, 80),
      clip(schooljaar, 20) || currentSchoolYear(),
      JSON.stringify(normTags(tags)),
      fileId,
      fullText ? String(fullText).slice(0, 200_000) : null,
      genOptions ? JSON.stringify(genOptions) : null
    );
    indexDocument(id);
  });
  try {
    tx();
  } catch (err) {
    removeDocDir(id);
    throw err;
  }
  return { doc: getDocument(id), duplicates };
}

export function getDocument(id, { includeDeleted = true } = {}) {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  if (!r || (!includeDeleted && r.deleted_at)) return null;
  const versions = db.prepare(`SELECT COUNT(*) AS n FROM versions WHERE document_id = ?`).get(id).n;
  const sizes = documentBytes(id);
  return rowToDoc(r, {
    versionCount: versions,
    bytes: sizes,
    originalFileId: r.original_file_id,
    originalPdfFileId: r.original_pdf_file_id,
    originalThumbFileId: r.original_thumb_file_id,
  });
}

function documentFileIds(id) {
  const db = getDb();
  const d = db.prepare(`SELECT original_file_id, original_pdf_file_id, original_thumb_file_id FROM documents WHERE id = ?`).get(id);
  if (!d) return [];
  const ids = [d.original_file_id, d.original_pdf_file_id, d.original_thumb_file_id];
  for (const v of db.prepare(`SELECT docx_file_id, pdf_file_id, thumb_file_id FROM versions WHERE document_id = ?`).all(id)) {
    ids.push(v.docx_file_id, v.pdf_file_id, v.thumb_file_id);
  }
  return ids.filter(Boolean);
}

function documentBytes(id) {
  const ids = documentFileIds(id);
  if (!ids.length) return 0;
  const db = getDb();
  let total = 0;
  for (const f of ids) total += db.prepare(`SELECT size_bytes FROM files WHERE id = ?`).get(f)?.size_bytes || 0;
  return total;
}

/** Mag deze gebruiker dit document zien/beheren? Admin alles, leerkracht enkel eigen. */
export function canAccess(doc, user) {
  if (!doc || !user) return false;
  if (user.role === "admin") return true;
  return doc.teacher === user.name;
}

export function updateDocument(id, patch = {}) {
  const db = getDb();
  const cur = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  if (!cur) return null;
  const next = {
    title: patch.title !== undefined ? clip(patch.title, 160) || cur.title : cur.title,
    vak: patch.vak !== undefined ? clip(patch.vak) : cur.vak,
    vak_id: patch.vakId !== undefined ? clip(patch.vakId, 60) : cur.vak_id,
    leerjaar: patch.leerjaar !== undefined ? clip(patch.leerjaar, 40) : cur.leerjaar,
    richting: patch.richting !== undefined ? clip(patch.richting, 80) : cur.richting,
    schooljaar: patch.schooljaar !== undefined ? clip(patch.schooljaar, 20) : cur.schooljaar,
    tags_json: patch.tags !== undefined ? JSON.stringify(normTags(patch.tags)) : cur.tags_json,
    note: patch.note !== undefined ? clip(patch.note, 2000) : cur.note,
    status: patch.status && STATUSES.includes(patch.status) ? patch.status : cur.status,
    gen_options_json: patch.genOptions !== undefined ? JSON.stringify(patch.genOptions) : cur.gen_options_json,
    original_pdf_file_id: patch.originalPdfFileId !== undefined ? patch.originalPdfFileId : cur.original_pdf_file_id,
    original_thumb_file_id: patch.originalThumbFileId !== undefined ? patch.originalThumbFileId : cur.original_thumb_file_id,
    preview_status: patch.previewStatus || cur.preview_status,
    full_text: patch.fullText !== undefined ? String(patch.fullText || "").slice(0, 200_000) : cur.full_text,
  };
  db.prepare(
    `UPDATE documents SET title=@title, vak=@vak, vak_id=@vak_id, leerjaar=@leerjaar, richting=@richting,
       schooljaar=@schooljaar, tags_json=@tags_json, note=@note, status=@status, gen_options_json=@gen_options_json,
       original_pdf_file_id=@original_pdf_file_id, original_thumb_file_id=@original_thumb_file_id,
       preview_status=@preview_status, full_text=@full_text, updated_at=datetime('now')
     WHERE id=@id`
  ).run({ ...next, id });
  indexDocument(id);
  return getDocument(id);
}

export function setStatus(id, status) {
  if (!STATUSES.includes(status)) return;
  getDb().prepare(`UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

export const PROPOSAL_STATUSES = ["geen", "bezig", "klaar", "mislukt"];

/** Status van het automatische AI-voorstel (aanduiding van vragen en antwoordplaatsen). */
export function setProposalStatus(id, status, error = null) {
  if (!PROPOSAL_STATUSES.includes(status)) return;
  getDb()
    .prepare(`UPDATE documents SET proposal_status = ?, proposal_error = ? WHERE id = ?`)
    .run(status, error ? String(error).slice(0, 500) : null, id);
}

/* ───────────── lijst, zoeken, filters ───────────── */

function ftsQuery(q) {
  const terms = String(q || "")
    .split(/\s+/)
    .map((t) => t.replace(/["'*^():{}\[\]-]/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}

const SORTS = {
  nieuwste: "d.created_at DESC",
  oudste: "d.created_at ASC",
  titel: "d.title COLLATE NOCASE ASC",
  vak: "d.vak COLLATE NOCASE ASC, d.title COLLATE NOCASE ASC",
  leerkracht: "d.teacher COLLATE NOCASE ASC, d.title COLLATE NOCASE ASC",
  status: "d.status ASC, d.title COLLATE NOCASE ASC",
  gewijzigd: "d.updated_at DESC",
};

/**
 * @param {object} f  q, vak, teacher, leerjaar, richting, schooljaar, status, tag, trash, sort, limit, offset
 * @param {{role:string,name:string}} user  leerkracht ziet enkel eigen documenten
 */
export function listDocuments(f = {}, user) {
  const db = getDb();
  const where = [];
  const params = [];
  where.push(f.trash ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL");
  if (user?.role !== "admin") {
    where.push("d.teacher = ?");
    params.push(user?.name || "");
  } else if (f.teacher) {
    where.push("d.teacher = ?");
    params.push(f.teacher);
  }
  for (const k of ["vak", "leerjaar", "richting", "schooljaar", "status"]) {
    if (f[k]) {
      where.push(`d.${k} = ?`);
      params.push(f[k]);
    }
  }
  if (f.tag) {
    where.push(`EXISTS (SELECT 1 FROM json_each(d.tags_json) WHERE json_each.value = ?)`);
    params.push(String(f.tag).toLowerCase());
  }
  const fts = ftsQuery(f.q);
  if (fts) {
    where.push(`d.id IN (SELECT document_id FROM documents_fts WHERE documents_fts MATCH ?)`);
    params.push(fts);
  }
  const order = SORTS[f.sort] || SORTS.nieuwste;
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS n FROM documents d ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT d.*,
         (SELECT COUNT(*) FROM versions v WHERE v.document_id = d.id) AS version_count,
         (SELECT v.thumb_file_id FROM versions v WHERE v.document_id = d.id AND v.version_number = d.active_version) AS active_thumb
       FROM documents d ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return {
    total,
    items: rows.map((r) =>
      rowToDoc(r, {
        versionCount: r.version_count,
        thumbFileId: r.original_thumb_file_id || null,
        keyThumbFileId: r.active_thumb || null,
      })
    ),
  };
}

/** Unieke waarden voor filters (binnen wat de gebruiker mag zien). */
export function filterOptions(user) {
  const db = getDb();
  const own = user?.role === "admin" ? "" : "AND teacher = @t";
  const p = { t: user?.name || "" };
  const col = (c) =>
    db
      .prepare(`SELECT DISTINCT ${c} AS v FROM documents WHERE deleted_at IS NULL AND ${c} IS NOT NULL AND ${c} <> '' ${own} ORDER BY ${c} COLLATE NOCASE`)
      .all(p)
      .map((r) => r.v);
  const tagRows = db
    .prepare(`SELECT DISTINCT j.value AS v FROM documents d, json_each(d.tags_json) j WHERE d.deleted_at IS NULL ${own.replace("teacher", "d.teacher")} ORDER BY j.value`)
    .all(p);
  return {
    vakken: col("vak"),
    leerkrachten: user?.role === "admin" ? col("teacher") : [],
    leerjaren: col("leerjaar"),
    richtingen: col("richting"),
    schooljaren: col("schooljaar"),
    tags: tagRows.map((r) => r.v),
    statussen: STATUSES,
  };
}

/* ───────────── paragrafen ───────────── */

export function saveParagraphs(docId, paragraphs) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO doc_paragraphs (document_id, para_id, idx, text, style, heading_level, is_list, bold, is_empty,
       is_page_break, in_table, table_row, table_cell, placeholders)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM doc_paragraphs WHERE document_id = ?`).run(docId);
    paragraphs.forEach((p, i) =>
      ins.run(
        docId,
        p.id,
        i,
        p.text || "",
        p.style || null,
        p.headingLevel ?? null,
        p.isList ? 1 : 0,
        p.bold ? 1 : 0,
        p.isEmpty ? 1 : 0,
        p.isPageBreak ? 1 : 0,
        p.inTable ? 1 : 0,
        p.tableCoord?.row ?? null,
        p.tableCoord?.cell ?? null,
        p.placeholders || 0
      )
    );
    const text = paragraphs
      .map((p) => p.text)
      .filter((t) => t && t.trim())
      .join("\n");
    db.prepare(`UPDATE documents SET full_text = ? WHERE id = ?`).run(text.slice(0, 200_000), docId);
    indexDocument(docId);
  })();
}

export function getParagraphs(docId) {
  return getDb()
    .prepare(`SELECT * FROM doc_paragraphs WHERE document_id = ? ORDER BY idx`)
    .all(docId)
    .map((r) => ({
      id: r.para_id,
      text: r.text,
      style: r.style,
      headingLevel: r.heading_level,
      isList: !!r.is_list,
      bold: !!r.bold,
      isEmpty: !!r.is_empty,
      isPageBreak: !!r.is_page_break,
      inTable: !!r.in_table,
      tableCoord: r.in_table ? { row: r.table_row, cell: r.table_cell } : null,
      placeholders: r.placeholders,
    }));
}

/* ───────────── aanduidingen (role_marks) ───────────── */

export const ROLES = ["vraag", "antwoordplaats", "gegeven", "formuleblad", "instructie", "modelantwoord"];

/** Vervangt alle aanduidingen van een bron ('teacher' of 'llm_proposal'). */
export function saveMarks(docId, source, marks) {
  if (!["teacher", "llm_proposal"].includes(source)) throw new Error("Ongeldige bron.");
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO role_marks (id, document_id, source, para_id, role, qid, sub_nr, slot_type, slot_count, linked_para_ids_json, teacher_answer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM role_marks WHERE document_id = ? AND source = ?`).run(docId, source);
    for (const m of marks) {
      if (!m?.paraId || !ROLES.includes(m.role)) continue;
      ins.run(
        randomUUID(),
        docId,
        source,
        String(m.paraId),
        m.role,
        clip(m.qid, 40),
        clip(m.subNr, 40),
        clip(m.slotType, 40),
        Number.isFinite(m.slotCount) ? m.slotCount : null,
        JSON.stringify(Array.isArray(m.linkedParaIds) ? m.linkedParaIds : []),
        m.teacherAnswer ? String(m.teacherAnswer).slice(0, 4000) : null
      );
    }
  })();
}

export function getMarks(docId, source) {
  return getDb()
    .prepare(`SELECT * FROM role_marks WHERE document_id = ? AND source = ? ORDER BY rowid`)
    .all(docId, source)
    .map((r) => ({
      paraId: r.para_id,
      role: r.role,
      qid: r.qid,
      subNr: r.sub_nr,
      slotType: r.slot_type,
      slotCount: r.slot_count,
      linkedParaIds: parseJson(r.linked_para_ids_json, []),
      teacherAnswer: r.teacher_answer,
      source: r.source,
    }));
}

/* ───────────── versies ───────────── */

function rowToVersion(r) {
  return {
    id: r.id,
    documentId: r.document_id,
    versionNumber: r.version_number,
    docxFileId: r.docx_file_id,
    pdfFileId: r.pdf_file_id,
    thumbFileId: r.thumb_file_id,
    summary: parseJson(r.summary_json, null),
    qcIssues: parseJson(r.qc_issues_json, []),
    slots: parseJson(r.slots_json, []),
    questions: parseJson(r.questions_json, []),
    teacherAnswers: parseJson(r.teacher_answers_json, {}),
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Voegt een nieuwe versie toe (overschrijft nooit) en maakt ze de actieve versie. */
export function addVersion({ docId, outputPath, buffer, ext = ".docx", createdBy, summary, qcIssues, slots, questions, teacherAnswers, status = "gegenereerd" }) {
  const db = getDb();
  let versionNumber;
  db.transaction(() => {
    versionNumber = (db.prepare(`SELECT COALESCE(MAX(version_number),0) AS m FROM versions WHERE document_id = ?`).get(docId).m || 0) + 1;
    const fileId = storeFile({ docId, srcPath: outputPath, buffer, ext });
    db.prepare(
      `INSERT INTO versions (id, document_id, version_number, docx_file_id, summary_json, qc_issues_json, slots_json,
         questions_json, teacher_answers_json, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      docId,
      versionNumber,
      fileId,
      JSON.stringify(summary || null),
      JSON.stringify(qcIssues || []),
      JSON.stringify(slots || []),
      JSON.stringify(questions || []),
      JSON.stringify(teacherAnswers || {}),
      status,
      clip(createdBy, 60) || "onbekend"
    );
    db.prepare(`UPDATE documents SET active_version = ?, status = 'gegenereerd', updated_at = datetime('now') WHERE id = ?`).run(versionNumber, docId);
  })();
  return versionNumber;
}

export function getVersion(docId, versionNumber) {
  const r = getDb().prepare(`SELECT * FROM versions WHERE document_id = ? AND version_number = ?`).get(docId, versionNumber);
  return r ? rowToVersion(r) : null;
}

export function listVersions(docId) {
  return getDb()
    .prepare(`SELECT * FROM versions WHERE document_id = ? ORDER BY version_number DESC`)
    .all(docId)
    .map(rowToVersion);
}

export function updateVersion(docId, versionNumber, patch = {}) {
  const db = getDb();
  const cur = db.prepare(`SELECT * FROM versions WHERE document_id = ? AND version_number = ?`).get(docId, versionNumber);
  if (!cur) return null;
  db.prepare(
    `UPDATE versions SET pdf_file_id = ?, thumb_file_id = ?, status = ?, summary_json = ?, qc_issues_json = ?, slots_json = ? WHERE id = ?`
  ).run(
    patch.pdfFileId !== undefined ? patch.pdfFileId : cur.pdf_file_id,
    patch.thumbFileId !== undefined ? patch.thumbFileId : cur.thumb_file_id,
    patch.status || cur.status,
    patch.summary !== undefined ? JSON.stringify(patch.summary) : cur.summary_json,
    patch.qcIssues !== undefined ? JSON.stringify(patch.qcIssues) : cur.qc_issues_json,
    patch.slots !== undefined ? JSON.stringify(patch.slots) : cur.slots_json,
    cur.id
  );
  return getVersion(docId, versionNumber);
}

/** Zet een eerdere versie opnieuw actief (zonder iets te wissen). */
export function setActiveVersion(docId, versionNumber) {
  const v = getVersion(docId, versionNumber);
  if (!v) return null;
  const status = v.status === "goedgekeurd" ? "goedgekeurd" : "gegenereerd";
  getDb().prepare(`UPDATE documents SET active_version = ?, status = ?, updated_at = datetime('now') WHERE id = ?`).run(versionNumber, status, docId);
  return getDocument(docId);
}

export function approveVersion(docId, versionNumber) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE versions SET status = 'goedgekeurd' WHERE document_id = ? AND version_number = ?`).run(docId, versionNumber);
    db.prepare(`UPDATE documents SET status = 'goedgekeurd', active_version = ?, updated_at = datetime('now') WHERE id = ?`).run(versionNumber, docId);
  })();
}

function flattenSlots(slots) {
  const map = new Map();
  for (const s of Array.isArray(slots) ? slots : []) {
    const key = `${s.qid || ""}|${s.para_id || s.paraId || ""}|${s.type || ""}`;
    const content = Array.isArray(s.content) ? s.content.join(" ¶ ") : String(s.content ?? "");
    map.set(key, { qid: s.qid || "", paraId: s.para_id || s.paraId || "", type: s.type || "", content });
  }
  return map;
}

/** Vergelijkt de antwoorden van twee versies. */
export function compareVersions(docId, a, b) {
  const va = getVersion(docId, a);
  const vb = getVersion(docId, b);
  if (!va || !vb) return null;
  const ma = flattenSlots(va.slots);
  const mb = flattenSlots(vb.slots);
  const keys = [...new Set([...ma.keys(), ...mb.keys()])];
  const items = keys.map((k) => {
    const x = ma.get(k);
    const y = mb.get(k);
    const ref = x || y;
    return {
      qid: ref.qid,
      paraId: ref.paraId,
      type: ref.type,
      a: x ? x.content : null,
      b: y ? y.content : null,
      status: !x ? "nieuw" : !y ? "verdwenen" : x.content === y.content ? "gelijk" : "gewijzigd",
    };
  });
  return {
    a,
    b,
    changed: items.filter((i) => i.status !== "gelijk").length,
    equal: items.filter((i) => i.status === "gelijk").length,
    items,
  };
}

/* ───────────── feedback ───────────── */

export function addFeedback({ docId, versionNumber, qid, paraId, questionText, originalAnswer, correctedAnswer, action, comment, user }) {
  if (!["goedgekeurd", "aangepast", "opnieuw_gegenereerd"].includes(action)) throw new Error("Ongeldige feedbackactie.");
  const db = getDb();
  const d = db.prepare(`SELECT vak, teacher FROM documents WHERE id = ?`).get(docId);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO feedback (id, document_id, version_number, qid, para_id, question_text, vak, teacher, original_answer,
       corrected_answer, action, comment, user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    d ? docId : null,
    versionNumber || 1,
    String(qid || "?"),
    paraId || null,
    questionText ? String(questionText).slice(0, 4000) : null,
    d?.vak || null,
    d?.teacher || null,
    originalAnswer != null ? String(originalAnswer).slice(0, 4000) : null,
    correctedAnswer != null ? String(correctedAnswer).slice(0, 4000) : null,
    action,
    comment ? String(comment).slice(0, 2000) : null,
    clip(user, 60) || "onbekend"
  );
  return id;
}

export function listFeedback(docId) {
  return getDb()
    .prepare(`SELECT * FROM feedback WHERE document_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(docId)
    .map((r) => ({
      id: r.id,
      versionNumber: r.version_number,
      qid: r.qid,
      paraId: r.para_id,
      questionText: r.question_text,
      originalAnswer: r.original_answer,
      correctedAnswer: r.corrected_answer,
      action: r.action,
      comment: r.comment,
      user: r.user,
      createdAt: r.created_at,
    }));
}

/** Alle voorbeelden (feedback) over documenten heen, ook losgekoppelde — voor het beheer. */
export function listExamples({ limit = 200 } = {}) {
  return getDb()
    .prepare(`SELECT * FROM feedback ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(Math.min(Math.max(Number(limit) || 200, 1), 1000))
    .map((r) => ({
      id: r.id,
      documentId: r.document_id,
      qid: r.qid,
      vak: r.vak,
      teacher: r.teacher,
      questionText: r.question_text,
      originalAnswer: r.original_answer,
      correctedAnswer: r.corrected_answer,
      action: r.action,
      comment: r.comment,
      user: r.user,
      createdAt: r.created_at,
    }));
}

export function deleteFeedback(id) {
  return getDb().prepare(`DELETE FROM feedback WHERE id = ?`).run(id).changes > 0;
}

/* ───────────── trainingsvoorbeelden uit verbeterde versies ───────────── */

function rowToSample(r) {
  return {
    id: r.id,
    documentId: r.document_id,
    qid: r.qid,
    vak: r.vak,
    vakId: r.vak_id,
    teacher: r.teacher,
    questionText: r.question_text,
    aiAnswer: r.ai_answer,
    teacherAnswer: r.teacher_answer,
    verdict: r.verdict,
    insight: r.insight,
    source: r.source,
    createdAt: r.created_at,
  };
}

/** Bewaart wat de app leerde uit een verbeterde versie van de leerkracht. */
export function addTrainingSample({ docId = null, qid, questionText, aiAnswer, teacherAnswer, verdict, insight, source = "verbeterde_versie" }) {
  const db = getDb();
  const d = docId ? db.prepare(`SELECT vak, vak_id, teacher FROM documents WHERE id = ?`).get(docId) : null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO training_samples (id, document_id, qid, vak, vak_id, teacher, question_text, ai_answer, teacher_answer, verdict, insight, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    d ? docId : null,
    qid != null ? String(qid).slice(0, 40) : null,
    d?.vak || null,
    d?.vak_id || null,
    d?.teacher || null,
    questionText ? String(questionText).slice(0, 4000) : null,
    aiAnswer != null ? String(aiAnswer).slice(0, 4000) : null,
    teacherAnswer != null ? String(teacherAnswer).slice(0, 4000) : null,
    verdict ? String(verdict).slice(0, 40) : null,
    insight ? String(insight).slice(0, 1500) : null,
    String(source).slice(0, 40)
  );
  return id;
}

export function listTrainingSamples({ limit = 300, vakId = null, docId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 300, 1), 2000);
  const where = [];
  const args = [];
  if (vakId) {
    where.push("vak_id = ?");
    args.push(vakId);
  }
  if (docId) {
    where.push("document_id = ?");
    args.push(docId);
  }
  const sql = `SELECT * FROM training_samples ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, lim).map(rowToSample);
}

export function deleteTrainingSample(id) {
  return getDb().prepare(`DELETE FROM training_samples WHERE id = ?`).run(id).changes > 0;
}

/** Verwijdert eerdere voorbeelden van een document uit dezelfde bron (bij opnieuw uploaden). */
export function clearTrainingSamples(docId, source = "verbeterde_versie") {
  return getDb().prepare(`DELETE FROM training_samples WHERE document_id = ? AND source = ?`).run(docId, source).changes;
}

export function trainingSampleCount() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM training_samples`).get().n;
}

/* ───────────── LLM-aanroepen ───────────── */

export function listLlmCalls(docId, { withText = false } = {}) {
  const cols = withText ? "*" : "id, document_id, version_number, call_type, model, prompt_tokens, completion_tokens, total_tokens, cost_eur, duration_ms, verification_result, created_at";
  return getDb().prepare(`SELECT ${cols} FROM llm_calls WHERE document_id = ? ORDER BY created_at, rowid`).all(docId);
}

export function documentCost(docId) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(cost_eur),0) AS cost_eur FROM llm_calls WHERE document_id = ?`
    )
    .get(docId);
}

/** Kostenoverzicht per maand, vak en leerkracht (blijft kloppen na definitief verwijderen). */
export function costOverview() {
  const db = getDb();
  const agg = (groupExpr) =>
    db
      .prepare(
        `SELECT ${groupExpr} AS label, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_eur),0) AS cost_eur
           FROM llm_calls GROUP BY label ORDER BY label`
      )
      .all();
  const total = db
    .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_eur),0) AS cost_eur FROM llm_calls`)
    .get();
  return {
    total,
    perMonth: agg(`strftime('%Y-%m', created_at)`),
    perVak: agg(`COALESCE(NULLIF(vak,''),'(geen vak)')`),
    perTeacher: agg(`COALESCE(NULLIF(teacher,''),'(onbekend)')`),
  };
}

export function storageOverview() {
  const db = getDb();
  const usage = storageUsage();
  const perTeacher = db
    .prepare(
      `SELECT d.teacher AS label, COUNT(DISTINCT d.id) AS documents
         FROM documents d WHERE d.deleted_at IS NULL GROUP BY d.teacher ORDER BY d.teacher`
    )
    .all();
  const counts = db
    .prepare(
      `SELECT SUM(deleted_at IS NULL) AS actief, SUM(deleted_at IS NOT NULL) AS prullenbak FROM documents`
    )
    .get();
  return { ...usage, documents: counts.actief || 0, trash: counts.prullenbak || 0, perTeacher };
}

/* ───────────── prullenbak, verwijderen ───────────── */

export function softDelete(docId, user) {
  const r = getDb()
    .prepare(`UPDATE documents SET deleted_at = datetime('now'), deleted_by = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .run(clip(user, 60) || "onbekend", docId);
  return r.changes > 0;
}

export function restoreDocument(docId) {
  const r = getDb()
    .prepare(`UPDATE documents SET deleted_at = NULL, deleted_by = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL`)
    .run(docId);
  return r.changes > 0;
}

/** Overzicht van wat er bij definitief verwijderen verdwijnt (voor de bevestiging). */
export function purgePreview(docId) {
  const db = getDb();
  const d = getDocument(docId);
  if (!d) return null;
  const count = (sql) => db.prepare(sql).get(docId).n;
  const approved = count(`SELECT COUNT(*) AS n FROM feedback WHERE document_id = ? AND action = 'goedgekeurd'`);
  const corrections = count(`SELECT COUNT(*) AS n FROM feedback WHERE document_id = ? AND action <> 'goedgekeurd'`);
  return {
    id: d.id,
    title: d.title,
    teacher: d.teacher,
    versions: d.versionCount,
    files: documentFileIds(docId).length,
    bytes: d.bytes,
    marks: count(`SELECT COUNT(*) AS n FROM role_marks WHERE document_id = ?`),
    llmCalls: count(`SELECT COUNT(*) AS n FROM llm_calls WHERE document_id = ?`),
    approvedExamples: approved,
    otherFeedback: corrections,
  };
}

/**
 * Verwijdert een document definitief (alle bestanden, versies, aanduidingen).
 * - keepExamples=true: feedback blijft bestaan, losgekoppeld van het document
 * - LLM-aanroepen blijven als kostenregel bestaan, maar prompt/response worden gewist
 * - audit_log krijgt een regel zonder inhoud
 */
export function purgeDocument(docId, { keepExamples = true, user = "systeem", role = "systeem", automatic = false } = {}) {
  const db = getDb();
  const doc = db.prepare(`SELECT id FROM documents WHERE id = ?`).get(docId);
  if (!doc) return false;
  const fileIds = documentFileIds(docId);
  const preview = purgePreview(docId);
  db.transaction(() => {
    if (!keepExamples) db.prepare(`DELETE FROM training_samples WHERE document_id = ?`).run(docId);
    if (keepExamples) {
      db.prepare(`DELETE FROM feedback WHERE document_id = ? AND action <> 'goedgekeurd' AND (corrected_answer IS NULL OR corrected_answer = '')`).run(docId);
      db.prepare(`UPDATE feedback SET document_id = NULL WHERE document_id = ?`).run(docId);
    } else {
      db.prepare(`DELETE FROM feedback WHERE document_id = ?`).run(docId);
    }
    db.prepare(`UPDATE llm_calls SET prompt_text = NULL, response_text = NULL, document_id = NULL WHERE document_id = ?`).run(docId);
    db.prepare(`DELETE FROM documents_fts WHERE document_id = ?`).run(docId);
    db.prepare(`DELETE FROM documents WHERE id = ?`).run(docId); // cascade: versies, paragrafen, aanduidingen
  })();
  deleteFiles(fileIds);
  removeDocDir(docId);
  audit(docId, user, role, automatic ? "definitief_verwijderd_automatisch" : "definitief_verwijderd", {
    versies: preview?.versions ?? 0,
    bestanden: preview?.files ?? 0,
    voorbeeldenBewaard: !!keepExamples,
  });
  return true;
}

/** Verwijdert documenten die langer dan `trashRetentionDays` in de prullenbak staan. */
export function purgeExpired() {
  const days = Number(getSettings().trashRetentionDays) || 30;
  const rows = getDb()
    .prepare(`SELECT id FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)`)
    .all(`-${Math.floor(days)} days`);
  let n = 0;
  for (const r of rows) {
    try {
      if (purgeDocument(r.id, { keepExamples: true, automatic: true })) n++;
    } catch (err) {
      console.warn("[prullenbak] opruimen mislukt:", r.id, err.message);
    }
  }
  return n;
}

/* ───────────── sjablonen & dupliceren ───────────── */

export function createTemplate({ docId, name, owner }) {
  const db = getDb();
  const d = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId);
  if (!d) return null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO templates (id, name, owner, vak, leerjaar, richting, tags_json, gen_options_json, marks_json, paragraphs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    clip(name, 120) || d.title,
    clip(owner, 60) || "onbekend",
    d.vak,
    d.leerjaar,
    d.richting,
    d.tags_json,
    d.gen_options_json,
    JSON.stringify(getMarks(docId, "teacher")),
    JSON.stringify(getParagraphs(docId))
  );
  return id;
}

export function listTemplates(user) {
  const db = getDb();
  const rows =
    user?.role === "admin"
      ? db.prepare(`SELECT * FROM templates ORDER BY created_at DESC`).all()
      : db.prepare(`SELECT * FROM templates WHERE owner = ? ORDER BY created_at DESC`).all(user?.name || "");
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    owner: r.owner,
    vak: r.vak,
    leerjaar: r.leerjaar,
    richting: r.richting,
    tags: parseJson(r.tags_json, []),
    createdAt: r.created_at,
  }));
}

export function getTemplate(id) {
  const r = getDb().prepare(`SELECT * FROM templates WHERE id = ?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    vak: r.vak,
    leerjaar: r.leerjaar,
    richting: r.richting,
    tags: parseJson(r.tags_json, []),
    genOptions: parseJson(r.gen_options_json, null),
    marks: parseJson(r.marks_json, []),
    paragraphs: parseJson(r.paragraphs_json, []),
  };
}

export function deleteTemplate(id) {
  return getDb().prepare(`DELETE FROM templates WHERE id = ?`).run(id).changes > 0;
}

/**
 * Dupliceert een document als nieuw document (origineel + aanduidingen), zonder versies.
 */
export function duplicateDocument(docId, user) {
  const src = getDocument(docId);
  if (!src) return null;
  const rec = getFileRecord(getDb().prepare(`SELECT original_file_id FROM documents WHERE id = ?`).get(docId).original_file_id);
  if (!rec || !fs.existsSync(rec.abs)) return null;
  const { doc } = createDocument({
    srcPath: rec.abs,
    originalName: src.originalFilename,
    user,
    vak: src.vak,
    vakId: src.vakId,
    leerjaar: src.leerjaar,
    richting: src.richting,
    schooljaar: src.schooljaar,
    tags: src.tags,
    title: `${src.title} (kopie)`,
    genOptions: src.genOptions,
  });
  const paras = getParagraphs(docId);
  if (paras.length) saveParagraphs(doc.id, paras);
  const marks = getMarks(docId, "teacher");
  if (marks.length) {
    saveMarks(doc.id, "teacher", marks);
    setStatus(doc.id, "aangeduid");
  }
  return getDocument(doc.id);
}
