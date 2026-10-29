/**
 * training.js — "Trainingslessen": vrije prompts/richtlijnen die de beheerder schrijft.
 *
 * Opslag: DATA_DIR/training.json. Elke les hoort bij één vak (vakId) of is algemeen (vakId = null).
 * Bij elke verbetering worden de algemene lessen + de lessen van het gekozen vak aan de
 * systeemprompt toegevoegd (context-injectie, géén fine-tuning van het model).
 * Optioneel worden lessen ook in agentmemory bewaard (zie memory.js).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "./settings.js";

const FILE = path.join(DATA_DIR, "training.json");
const MAX_LESSONS = 200;
const MAX_LEN = 1500;
const BUDGET = 4000; // max tekens lessen in de prompt
export const SOORTEN = ["richtlijn", "correctie", "voorbeeld"];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = Array.isArray(data) ? data : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function listLessons() {
  return [...load()].sort((a, b) => b.aangemaakt.localeCompare(a.aangemaakt));
}

export function addLesson({ tekst, vakId = null, vakNaam = "", soort = "richtlijn" } = {}) {
  const t = String(tekst ?? "").trim();
  if (t.length < 5) throw new Error("Schrijf een les van minstens 5 tekens.");
  if (t.length > MAX_LEN) throw new Error(`De les is te lang (max ${MAX_LEN} tekens).`);
  if (!SOORTEN.includes(soort)) throw new Error("Ongeldig soort les.");
  const list = load();
  if (list.length >= MAX_LESSONS) throw new Error(`Maximum ${MAX_LESSONS} lessen bereikt. Verwijder oude lessen.`);
  if (list.some((l) => l.tekst === t && (l.vakId || null) === (vakId || null))) {
    throw new Error("Deze les bestaat al.");
  }
  const lesson = {
    id: randomUUID(),
    tekst: t,
    vakId: vakId || null,
    vakNaam: vakId ? String(vakNaam || "").slice(0, 80) : "",
    soort,
    aangemaakt: new Date().toISOString(),
  };
  list.push(lesson);
  save();
  return lesson;
}

export function deleteLesson(id) {
  const list = load();
  const i = list.findIndex((l) => l.id === id);
  if (i === -1) throw new Error("Les niet gevonden.");
  list.splice(i, 1);
  save();
}

/** Zet vak-lessen om naar een tekstblok voor de prompt. */
export function buildTrainingContext(subjectId, extraLines = "") {
  const relevant = load().filter((l) => !l.vakId || l.vakId === subjectId);
  const lines = [];
  let used = 0;
  const seen = new Set();
  const push = (label, text) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean) || used + clean.length > BUDGET) return;
    seen.add(clean);
    used += clean.length;
    lines.push(label ? `- (${label}) ${clean}` : `- ${clean}`);
  };
  for (const l of relevant) push(l.soort, l.tekst);
  for (const raw of String(extraLines).split("\n")) {
    push("", raw.replace(/^-\s*/, ""));
  }
  if (!lines.length) return "";
  return `Geleerde lessen uit eerdere verbeteringen (volg deze richtlijnen waar ze van toepassing zijn):\n${lines.join("\n")}`;
}
