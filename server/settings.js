/**
 * settings.js — Instellingen die de beheerder in de UI kan aanpassen.
 *
 * Opslag: JSON-bestand in DATA_DIR (standaard ./data/settings.json).
 * Waarden uit .env gelden als standaard; waarden uit het bestand overschrijven die.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "settings.json");

export const DEFAULT_SYSTEM_PROMPT = `Je bent een ervaren leerkracht die een verbetersleutel opstelt.
Je krijgt de volledige tekst van een taak of toets.
Identificeer ALLE vragen (genummerd, geletterd, bullet of als zin geformuleerd).
Los elke vraag correct en volledig op.

Stuur je antwoord als een JSON-array, ZONDER Markdown-codefences, in dit formaat:
[
  { "vraag": "<letterlijke vraag of vraagnummer>", "antwoord": "<correct antwoord>" },
  ...
]

Regels:
- Gebruik dezelfde taal als het document.
- Wees beknopt maar volledig.
- Als een vraag meerdere deelvragen heeft, geef dan een antwoord per deelvraag als aparte objecten.
- Verzin geen vragen die er niet zijn.
- Als er geen vragen zijn, geef dan een lege array [].`;

function envDefaults() {
  return {
    omnirouteBaseUrl: process.env.OMNIROUTE_BASE_URL || "https://omniroute.example.com/v1",
    omnirouteApiKey: process.env.OMNIROUTE_API_KEY || "",
    omnirouteModel: process.env.OMNIROUTE_MODEL || "gpt-4o",
    temperature: 0.2,
    maxFileMb: parseInt(process.env.MAX_FILE_MB || "20", 10),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    teacherPasswordHash: "",
  };
}

let cache = null;

function readStored() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function getSettings() {
  if (!cache) cache = { ...envDefaults(), ...readStored() };
  return cache;
}

function persist(next) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = { ...envDefaults(), ...next };
}

// ── Wachtwoorden ──────────────────────────────────────────────────────
export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyHash(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function adminConfigured() {
  return !!process.env.ADMIN_PASSWORD;
}

export function verifyAdminPassword(pw) {
  return adminConfigured() && safeEqual(pw, process.env.ADMIN_PASSWORD);
}

/** Leerkrachtenwachtwoord: eerst uit beheer (hash), anders TEACHER_PASSWORD / APP_PASSWORD uit .env. */
export function verifyTeacherPassword(pw) {
  const s = getSettings();
  if (s.teacherPasswordHash) return verifyHash(pw, s.teacherPasswordHash);
  const envPw = process.env.TEACHER_PASSWORD || process.env.APP_PASSWORD || "";
  return !!envPw && safeEqual(pw, envPw);
}

export function teacherConfigured() {
  const s = getSettings();
  return !!(s.teacherPasswordHash || process.env.TEACHER_PASSWORD || process.env.APP_PASSWORD);
}

// ── Weergave & updates ────────────────────────────────────────────────
/** Versie voor de beheer-UI: de API-sleutel wordt nooit teruggestuurd. */
export function publicSettings() {
  const s = getSettings();
  return {
    omnirouteBaseUrl: s.omnirouteBaseUrl,
    omnirouteModel: s.omnirouteModel,
    hasApiKey: !!s.omnirouteApiKey,
    apiKeyHint: s.omnirouteApiKey ? `••••${s.omnirouteApiKey.slice(-4)}` : "",
    temperature: s.temperature,
    maxFileMb: s.maxFileMb,
    systemPrompt: s.systemPrompt,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    teacherPasswordSource: s.teacherPasswordHash ? "beheer" : "env",
  };
}

/**
 * Valideert en bewaart. Gooit een Error met Nederlandse boodschap bij ongeldige invoer.
 */
export function updateSettings(input = {}) {
  const stored = readStored();
  const next = { ...stored };

  if (input.omnirouteBaseUrl !== undefined) {
    const url = String(input.omnirouteBaseUrl).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw new Error("Omniroute-URL moet beginnen met http:// of https://");
    }
    next.omnirouteBaseUrl = url;
  }
  if (input.omnirouteApiKey !== undefined && String(input.omnirouteApiKey).trim() !== "") {
    next.omnirouteApiKey = String(input.omnirouteApiKey).trim();
  }
  if (input.clearApiKey) next.omnirouteApiKey = "";
  if (input.omnirouteModel !== undefined) {
    const m = String(input.omnirouteModel).trim();
    if (!m) throw new Error("Model mag niet leeg zijn.");
    next.omnirouteModel = m;
  }
  if (input.temperature !== undefined) {
    const t = Number(input.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new Error("Temperatuur moet tussen 0 en 2 liggen.");
    next.temperature = t;
  }
  if (input.maxFileMb !== undefined) {
    const n = parseInt(input.maxFileMb, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("Maximale bestandsgrootte moet tussen 1 en 100 MB liggen.");
    next.maxFileMb = n;
  }
  if (input.systemPrompt !== undefined) {
    const p = String(input.systemPrompt).trim();
    if (!p) throw new Error("De systeemprompt mag niet leeg zijn.");
    if (p.length > 10000) throw new Error("De systeemprompt is te lang (max 10000 tekens).");
    next.systemPrompt = p;
  }
  if (input.teacherPassword !== undefined && String(input.teacherPassword) !== "") {
    const pw = String(input.teacherPassword);
    if (pw.length < 6) throw new Error("Het leerkrachtenwachtwoord moet minstens 6 tekens bevatten.");
    next.teacherPasswordHash = hashPassword(pw);
  }
  if (input.resetTeacherPassword) delete next.teacherPasswordHash;

  persist(next);
  return publicSettings();
}
