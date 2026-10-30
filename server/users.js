/**
 * users.js — persoonlijke accounts (gebruikersnaam + wachtwoord) die de beheerder aanmaakt.
 *
 * Naast de gedeelde wachtwoorden (ADMIN_PASSWORD / leerkrachtenwachtwoord) kan elke leerkracht of
 * beheerder een eigen account krijgen. De weergavenaam wordt als sessienaam gebruikt, zodat het
 * eigenaarschap van documenten (documents.teacher) hetzelfde blijft werken.
 */
import { randomUUID } from "crypto";
import { getDb } from "./storage/db.js";
import { hashPassword, verifyHash } from "./settings.js";

const ROLES = ["teacher", "admin"];
const MIN_PASSWORD = 8;

export function normalizeUsername(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function cleanName(v) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 60);
}

function publicUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    active: !!r.active,
    createdAt: r.created_at,
    lastLogin: r.last_login,
  };
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) {
    throw new Error(`Het wachtwoord moet minstens ${MIN_PASSWORD} tekens bevatten.`);
  }
  if (pw.length > 200) throw new Error("Het wachtwoord is te lang.");
}

export function listUsers() {
  return getDb()
    .prepare(`SELECT * FROM users ORDER BY role DESC, lower(display_name)`)
    .all()
    .map(publicUser);
}

export function userCount() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
}

export function createUser({ username, displayName, password, role = "teacher" } = {}) {
  const uname = normalizeUsername(username);
  if (!/^[a-z0-9._@-]{3,60}$/.test(uname)) {
    throw new Error("Gebruikersnaam: 3–60 tekens (letters, cijfers, punt, streepje, underscore of @).");
  }
  const name = cleanName(displayName) || uname;
  if (name.length < 2) throw new Error("Geef een weergavenaam op (minstens 2 tekens).");
  if (!ROLES.includes(role)) throw new Error("Ongeldige rol.");
  checkPassword(password);

  const db = getDb();
  if (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(uname)) {
    throw new Error("Deze gebruikersnaam bestaat al.");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)`
  ).run(id, uname, name, hashPassword(password), role);
  return publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
}

/** Past een gebruiker aan: weergavenaam, rol, actief en/of nieuw wachtwoord. */
export function updateUser(id, patch = {}) {
  const db = getDb();
  const cur = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!cur) throw new Error("Gebruiker niet gevonden.");

  const name = patch.displayName !== undefined ? cleanName(patch.displayName) : cur.display_name;
  if (name.length < 2) throw new Error("Geef een weergavenaam op (minstens 2 tekens).");
  const role = patch.role !== undefined ? patch.role : cur.role;
  if (!ROLES.includes(role)) throw new Error("Ongeldige rol.");
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : cur.active;

  // Er moet altijd minstens één actieve persoonlijke beheerder overblijven als er al een was? Nee:
  // het gedeelde ADMIN_PASSWORD blijft altijd werken, dus geen extra beperking nodig.
  let hash = cur.password_hash;
  if (patch.password !== undefined && patch.password !== "") {
    checkPassword(patch.password);
    hash = hashPassword(patch.password);
  }
  db.prepare(`UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?`).run(
    name,
    role,
    active,
    hash,
    id
  );
  return publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
}

export function deleteUser(id) {
  return getDb().prepare(`DELETE FROM users WHERE id = ?`).run(id).changes > 0;
}

export function getUser(id) {
  return publicUser(getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id));
}

// Dummy-hash om het verschil in antwoordtijd tussen "onbekende gebruiker" en "fout wachtwoord" te beperken.
const DUMMY_HASH = hashPassword("dummy-wachtwoord-voor-timing");

/**
 * Controleert gebruikersnaam + wachtwoord.
 * @returns {{ user: object } | { error: "onbekend" | "inactief" }}
 */
export function verifyUserLogin(username, password) {
  const uname = normalizeUsername(username);
  const db = getDb();
  const r = uname ? db.prepare(`SELECT * FROM users WHERE username = ?`).get(uname) : null;
  const ok = verifyHash(String(password || ""), r ? r.password_hash : DUMMY_HASH);
  if (!r || !ok) return { error: "onbekend" };
  if (!r.active) return { error: "inactief" };
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(r.id);
  return { user: publicUser(r) };
}
