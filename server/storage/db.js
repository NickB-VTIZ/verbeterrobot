/**
 * db.js — SQLite-database via better-sqlite3 met WAL-modus en FTS5-volledige-tekstzoekindex.
 *
 * Beheert:
 *   - documents: metadata, actieve versie, leerkracht, vak, schooljaar, status, soft-delete
 *   - versions: elke gegenereerde sleutel (v1, v2, ...), bestandspaden, PDF/miniatuur, QC-status
 *   - files: opslagregister met SHA-256 (geen duplicaten op schijf)
 *   - doc_paragraphs: geëxtraheerde paragrafen per document (voor HTML-weergave & aanduidingen)
 *   - role_marks: rolaanduidingen van leerkracht en LLM-voorstel (Probleem 2)
 *   - llm_calls: elke Omniroute-aanroep met prompt, response, model, tokens, kost, duur
 *   - feedback: correcties en goedkeuringen per antwoord (voor Probleem 3)
 *   - audit_log: uploads, wijzigingen, downloads, verwijderingen
 *   - documents_fts: FTS5-index over titel, vak, tags en geëxtraheerde tekst
 */

import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { DATA_DIR } from "../settings.js";

let _db = null;

export function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, "verbeterrobot.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  initSchema(db);
  _db = db;
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      storage_relpath TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      teacher TEXT NOT NULL,
      vak TEXT,
      vak_id TEXT,
      leerjaar TEXT,
      richting TEXT,
      schooljaar TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('geupload','aangeduid','bezig','gegenereerd','goedgekeurd','mislukt')),
      active_version INTEGER NOT NULL DEFAULT 1,
      original_file_id TEXT NOT NULL REFERENCES files(id),
      original_pdf_file_id TEXT REFERENCES files(id),
      original_thumb_file_id TEXT REFERENCES files(id),
      preview_status TEXT NOT NULL DEFAULT 'geen',
      note TEXT,
      full_text TEXT,
      gen_options_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      deleted_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_docs_teacher ON documents(teacher);
    CREATE INDEX IF NOT EXISTS idx_docs_deleted ON documents(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_docs_vak ON documents(vak);
    CREATE INDEX IF NOT EXISTS idx_docs_schooljaar ON documents(schooljaar);

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      docx_file_id TEXT REFERENCES files(id),
      pdf_file_id TEXT REFERENCES files(id),
      thumb_file_id TEXT REFERENCES files(id),
      summary_json TEXT,
      qc_issues_json TEXT,
      slots_json TEXT,
      questions_json TEXT,
      teacher_answers_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('gegenereerd','goedgekeurd','afgekeurd','concept')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_id, version_number)
    );

    CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(document_id);

    CREATE TABLE IF NOT EXISTS doc_paragraphs (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      para_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      style TEXT,
      heading_level INTEGER,
      is_list INTEGER NOT NULL DEFAULT 0,
      bold INTEGER NOT NULL DEFAULT 0,
      is_empty INTEGER NOT NULL DEFAULT 0,
      is_page_break INTEGER NOT NULL DEFAULT 0,
      in_table INTEGER NOT NULL DEFAULT 0,
      table_row INTEGER,
      table_cell INTEGER,
      placeholders INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (document_id, para_id)
    );

    CREATE INDEX IF NOT EXISTS idx_doc_paras_doc ON doc_paragraphs(document_id, idx);

    CREATE TABLE IF NOT EXISTS role_marks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('llm_proposal','teacher')),
      para_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('vraag','antwoordplaats','gegeven','formuleblad','instructie','modelantwoord')),
      qid TEXT,
      sub_nr TEXT,
      slot_type TEXT,
      slot_count INTEGER,
      linked_para_ids_json TEXT,
      teacher_answer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_id, source, para_id)
    );

    CREATE INDEX IF NOT EXISTS idx_marks_doc ON role_marks(document_id, source);

    -- vak/teacher worden mee bewaard zodat de kostenoverzichten blijven kloppen
    -- nadat een document definitief verwijderd werd (prompt/response worden dan gewist).
    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      version_number INTEGER,
      vak TEXT,
      teacher TEXT,
      call_type TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_text TEXT,
      response_text TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cost_eur REAL,
      duration_ms INTEGER,
      verification_result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_llm_doc ON llm_calls(document_id);
    CREATE INDEX IF NOT EXISTS idx_llm_created ON llm_calls(created_at);

    -- document_id wordt NULL als het document definitief verwijderd werd maar de
    -- goedgekeurde voorbeelden bewaard blijven (ontkoppeld, zie purgeDocument).
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      version_number INTEGER NOT NULL,
      qid TEXT NOT NULL,
      para_id TEXT,
      question_text TEXT,
      vak TEXT,
      teacher TEXT,
      original_answer TEXT,
      corrected_answer TEXT,
      action TEXT NOT NULL CHECK(action IN ('goedgekeurd','aangepast','opnieuw_gegenereerd')),
      comment TEXT,
      user TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_doc ON feedback(document_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      document_id TEXT,
      action TEXT NOT NULL,
      user TEXT NOT NULL,
      role TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_doc ON audit_log(document_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      vak TEXT,
      leerjaar TEXT,
      richting TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      gen_options_json TEXT,
      marks_json TEXT,
      paragraphs_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      document_id UNINDEXED,
      title,
      vak,
      tags,
      full_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    -- Persoonlijke accounts (aangemaakt door de beheerder).
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('teacher','admin')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );

    -- Wat de app leert uit een door de leerkracht zelf verbeterde versie:
    -- per vraag het AI-antwoord naast het antwoord van de leerkracht.
    -- document_id wordt NULL als het document definitief verwijderd werd (voorbeeld blijft).
    CREATE TABLE IF NOT EXISTS training_samples (
      id TEXT PRIMARY KEY,
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      qid TEXT,
      vak TEXT,
      vak_id TEXT,
      teacher TEXT,
      question_text TEXT,
      ai_answer TEXT,
      teacher_answer TEXT,
      verdict TEXT,
      insight TEXT,
      source TEXT NOT NULL DEFAULT 'verbeterde_versie',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_samples_doc ON training_samples(document_id);
    CREATE INDEX IF NOT EXISTS idx_samples_vak ON training_samples(vak_id);
  `);

  // Migraties voor bestaande databanken
  const cols = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
  if (!cols.includes("proposal_status")) {
    db.exec("ALTER TABLE documents ADD COLUMN proposal_status TEXT NOT NULL DEFAULT 'geen'");
  }
  if (!cols.includes("proposal_error")) {
    db.exec("ALTER TABLE documents ADD COLUMN proposal_error TEXT");
  }
  // Achtergrondtaken leven enkel in het geheugen: na een herstart kan niets nog 'bezig' zijn.
  db.exec(
    "UPDATE documents SET proposal_status = 'mislukt', proposal_error = 'Onderbroken door een herstart van de server.' WHERE proposal_status = 'bezig'"
  );
}

/** Sluit de database (nuttig bij graceful shutdown en in tests). */
export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch (_) {}
    _db = null;
  }
}
