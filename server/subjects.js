/**
 * subjects.js — Vakprofielen ("training" van de verbeterrobot).
 *
 * Een vakprofiel bevat: vak, graad, onderwerpen, vakspecifieke instructies,
 * correctievoorbeelden en referentiemateriaal (cursus, correctiemodel, ...).
 * Bij een verbetering wordt het relevante deel daarvan aan de prompt toegevoegd.
 *
 * Er wordt géén model getraind: het is gerichte context-injectie (lichte RAG).
 * Opslag: JSON-bestand in DATA_DIR (data/subjects.json).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DATA_DIR } from "./settings.js";

const FILE = path.join(DATA_DIR, "subjects.json");

const MAX_SUBJECTS = 100;
const MAX_TOPICS = 60;
const MAX_EXAMPLES = 10;
const MAX_REFS = 20;
const MAX_REF_CHARS = 200_000;
const REF_BUDGET = 10_000; // max. tekens referentiemateriaal per verbetering

let cache = null;

function load() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      cache = { subjects: [] };
    }
    if (!Array.isArray(cache.subjects)) cache.subjects = [];
  }
  return cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// ── Weergave ──────────────────────────────────────────────────────────
function summary(s) {
  return {
    id: s.id,
    naam: s.naam,
    graad: s.graad,
    onderwerpen: s.onderwerpen,
  };
}

function full(s) {
  return {
    ...summary(s),
    instructies: s.instructies,
    voorbeelden: s.voorbeelden,
    referenties: s.referenties.map((r) => ({
      id: r.id,
      naam: r.naam,
      chars: r.tekst.length,
    })),
  };
}

/** Voor leerkrachten: enkel wat nodig is om een vak te kiezen. */
export function listSubjectsPublic() {
  return load().subjects.map(summary);
}

/** Voor beheer. */
export function listSubjectsAdmin() {
  return load().subjects.map(full);
}

export function getSubject(id) {
  return load().subjects.find((s) => s.id === id) || null;
}

// ── Validatie ─────────────────────────────────────────────────────────
function normTopics(input) {
  const arr = Array.isArray(input) ? input : String(input ?? "").split(/[\n,;]+/);
  const out = [];
  for (const t of arr) {
    const v = String(t).trim().slice(0, 100);
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > MAX_TOPICS) throw new Error(`Maximaal ${MAX_TOPICS} onderwerpen per vak.`);
  return out;
}

function normExamples(input) {
  if (!Array.isArray(input)) return [];
  const out = input
    .map((e) => ({
      vraag: String(e?.vraag ?? "").trim().slice(0, 1000),
      antwoord: String(e?.antwoord ?? "").trim().slice(0, 2000),
    }))
    .filter((e) => e.vraag && e.antwoord);
  if (out.length > MAX_EXAMPLES) throw new Error(`Maximaal ${MAX_EXAMPLES} voorbeelden per vak.`);
  return out;
}

export function upsertSubject(input = {}, id = null) {
  const data = load();
  const naam = String(input.naam ?? "").trim();
  if (!naam) throw new Error("Vul een naam voor het vak in.");
  if (naam.length > 80) throw new Error("De naam van het vak is te lang (max 80 tekens).");
  const instructies = String(input.instructies ?? "").trim();
  if (instructies.length > 4000) throw new Error("De instructies zijn te lang (max 4000 tekens).");

  const fields = {
    naam,
    graad: String(input.graad ?? "").trim().slice(0, 40),
    onderwerpen: normTopics(input.onderwerpen),
    instructies,
    voorbeelden: normExamples(input.voorbeelden),
  };

  if (id) {
    const s = getSubject(id);
    if (!s) throw new Error("Vak niet gevonden.");
    Object.assign(s, fields);
    save();
    return full(s);
  }

  if (data.subjects.length >= MAX_SUBJECTS) throw new Error(`Maximaal ${MAX_SUBJECTS} vakken.`);
  const s = { id: randomUUID(), ...fields, referenties: [] };
  data.subjects.push(s);
  save();
  return full(s);
}

export function deleteSubject(id) {
  const data = load();
  const before = data.subjects.length;
  data.subjects = data.subjects.filter((s) => s.id !== id);
  if (data.subjects.length === before) throw new Error("Vak niet gevonden.");
  save();
}

export function addReference(id, naam, tekst) {
  const s = getSubject(id);
  if (!s) throw new Error("Vak niet gevonden.");
  if (s.referenties.length >= MAX_REFS) throw new Error(`Maximaal ${MAX_REFS} referentiebestanden per vak.`);
  const text = String(tekst ?? "").replace(/\r/g, "").trim();
  if (text.length < 20) throw new Error("Het referentiemateriaal bevat te weinig tekst.");
  s.referenties.push({
    id: randomUUID(),
    naam: String(naam || "Referentie").trim().slice(0, 120),
    tekst: text.slice(0, MAX_REF_CHARS),
  });
  save();
  return full(s);
}

export function removeReference(id, refId) {
  const s = getSubject(id);
  if (!s) throw new Error("Vak niet gevonden.");
  const before = s.referenties.length;
  s.referenties = s.referenties.filter((r) => r.id !== refId);
  if (s.referenties.length === before) throw new Error("Referentie niet gevonden.");
  save();
  return full(s);
}

// ── Context opbouwen voor de prompt ───────────────────────────────────
const wordSet = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);

function chunk(text, size = 1500) {
  const out = [];
  let cur = "";
  for (const line of text.split(/\n+/)) {
    if (cur && cur.length + line.length > size) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
    while (cur.length > size * 1.5) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Kiest de meest relevante stukken referentiemateriaal voor dit document.
 * Is alles samen klein genoeg, dan wordt alles meegegeven.
 */
function selectReference(subject, documentText, topics) {
  const chunks = [];
  for (const r of subject.referenties) {
    for (const c of chunk(r.tekst)) chunks.push({ bron: r.naam, tekst: c });
  }
  if (!chunks.length) return "";

  const total = chunks.reduce((n, c) => n + c.tekst.length, 0);
  let chosen = chunks;

  if (total > REF_BUDGET) {
    const docWords = wordSet(documentText);
    const topicWords = wordSet(topics.join(" "));
    const scored = chunks.map((c, i) => {
      let score = 0;
      for (const w of wordSet(c.tekst)) {
        if (docWords.has(w)) score += 1;
        if (topicWords.has(w)) score += 3;
      }
      return { ...c, i, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    let used = 0;
    for (const c of scored) {
      if (c.score === 0) break;
      if (used + c.tekst.length > REF_BUDGET) continue;
      picked.push(c);
      used += c.tekst.length;
    }
    chosen = picked.sort((a, b) => a.i - b.i);
  }

  return chosen.map((c) => `[${c.bron}]\n${c.tekst}`).join("\n\n");
}

/**
 * @param {object} subject  Vakprofiel
 * @param {string} documentText  Tekst van het geüploade document
 * @param {string[]} topics  Door de leerkracht gekozen onderwerpen (mag leeg zijn)
 * @returns {string} Extra tekst voor de systeemprompt
 */
export function buildSubjectContext(subject, documentText, topics = []) {
  if (!subject) return "";
  const known = new Set(subject.onderwerpen.map((t) => t.toLowerCase()));
  const chosen = topics.filter((t) => known.has(String(t).toLowerCase()));

  const parts = [
    `VAKCONTEXT\nVak: ${subject.naam}${subject.graad ? ` (${subject.graad})` : ""}`,
  ];
  if (chosen.length) parts.push(`Onderwerpen van dit document: ${chosen.join(", ")}`);
  else if (subject.onderwerpen.length) parts.push(`Onderwerpen binnen dit vak: ${subject.onderwerpen.join(", ")}`);
  if (subject.instructies) parts.push(`Vakspecifieke instructies van de leerkracht(en):\n${subject.instructies}`);

  if (subject.voorbeelden.length) {
    parts.push(
      "Voorbeelden van de gewenste verbeterstijl (volg dit niveau en deze formulering):\n" +
        subject.voorbeelden.map((e, i) => `${i + 1}. Vraag: ${e.vraag}\n   Antwoord: ${e.antwoord}`).join("\n")
    );
  }

  const ref = selectReference(subject, documentText, chosen);
  if (ref) {
    parts.push(
      "Referentiemateriaal (leerstof/correctiemodel van de school). Gebruik dit als bron voor de antwoorden " +
        "en wijk er enkel van af als het duidelijk fout is:\n" +
        ref
    );
  }
  return parts.join("\n\n");
}
