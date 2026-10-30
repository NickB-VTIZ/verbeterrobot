/**
 * files.js — bestandsopslag op schijf (Docker-volume) met UUID-bestandsnamen en SHA-256.
 *
 * Indeling: DATA_DIR/store/<document-id>/<uuid><ext>
 * De oorspronkelijke bestandsnaam staat enkel in de database. Bestanden worden nooit
 * overschreven: elke nieuwe versie is een nieuw bestand.
 */
import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { DATA_DIR } from "../settings.js";
import { getDb } from "./db.js";

export const STORE_DIR = path.join(DATA_DIR, "store");

const MIME = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

export function mimeFor(ext) {
  return MIME[String(ext).toLowerCase()] || "application/octet-stream";
}

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Slaat een bestand (pad of buffer) op voor een document en registreert het.
 * @returns {string} file id
 */
export function storeFile({ docId, srcPath, buffer, ext }) {
  if (!docId || !/^[0-9a-f-]{36}$/i.test(docId)) throw new Error("Ongeldig document-id.");
  const data = buffer ?? fs.readFileSync(srcPath);
  const cleanExt = /^\.[a-z0-9]{1,8}$/i.test(ext || "") ? ext.toLowerCase() : "";
  const id = randomUUID();
  const rel = path.posix.join(docId, `${id}${cleanExt}`);
  const abs = path.join(STORE_DIR, docId, `${id}${cleanExt}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  getDb()
    .prepare(`INSERT INTO files (id, sha256, size_bytes, mime_type, storage_relpath) VALUES (?, ?, ?, ?, ?)`)
    .run(id, sha256Buffer(data), data.length, mimeFor(cleanExt), rel);
  return id;
}

export function getFileRecord(id) {
  if (!id) return null;
  const r = getDb().prepare(`SELECT * FROM files WHERE id = ?`).get(id);
  if (!r) return null;
  const abs = path.join(STORE_DIR, ...r.storage_relpath.split("/"));
  // Bescherming tegen paden buiten de opslagmap
  if (!abs.startsWith(STORE_DIR + path.sep)) return null;
  return { ...r, abs };
}

/** Andere documenten met een identiek origineel (zelfde SHA-256). */
export function findDuplicatesBySha(sha, excludeDocId = null) {
  return getDb()
    .prepare(
      `SELECT d.id, d.title, d.teacher, d.created_at, d.deleted_at
         FROM documents d JOIN files f ON f.id = d.original_file_id
        WHERE f.sha256 = ? AND (? IS NULL OR d.id <> ?)`
    )
    .all(sha, excludeDocId, excludeDocId);
}

/** Verwijdert bestandsregistraties en de bestanden zelf. */
export function deleteFiles(ids) {
  const db = getDb();
  for (const id of ids.filter(Boolean)) {
    const rec = getFileRecord(id);
    if (rec) {
      try {
        fs.unlinkSync(rec.abs);
      } catch {
        /* bestond al niet meer */
      }
    }
    db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
  }
}

export function removeDocDir(docId) {
  if (!/^[0-9a-f-]{36}$/i.test(docId)) return;
  fs.rmSync(path.join(STORE_DIR, docId), { recursive: true, force: true });
}

/** Totale opslag in bytes (per teller uit de database). */
export function storageUsage() {
  const r = getDb().prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM files`).get();
  return { files: r.n, bytes: r.bytes };
}
