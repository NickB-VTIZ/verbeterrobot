/**
 * memory.js — Kleine client voor de agentmemory REST-server (dezelfde als de MCP-server gebruikt).
 *
 * - Authenticatie: Authorization: Bearer <secret>
 * - Alles wat we opslaan krijgt de tag [<project>] zodat we bij het ophalen enkel
 *   herinneringen van de verbeterrobot gebruiken (nooit die van andere projecten).
 * - Fouten blokkeren een verbetering nooit: recall() geeft dan gewoon "" terug.
 */
import { getSettings } from "./settings.js";

const TIMEOUT_MS = 6000;

function cfg() {
  const s = getSettings();
  return {
    enabled: !!s.memoryEnabled,
    url: s.memoryUrl,
    secret: s.memorySecret,
    project: s.memoryProject || "verbeterrobot",
  };
}

export function memoryActive() {
  const c = cfg();
  return c.enabled && !!c.url && !!c.secret;
}

async function request(method, urlPath, body) {
  const c = cfg();
  if (!c.url || !c.secret) throw new Error("Geheugen-URL of geheim ontbreekt.");
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`${c.url}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.secret}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Geheugenserver antwoordde ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Test de verbinding (zonder iets op te slaan). */
export async function testMemory() {
  await request("GET", "/agentmemory/sessions");
  return true;
}

/** Bewaar een les in het geheugen. Gooit bij een fout (zodat de beheerder het ziet). */
export async function rememberLesson({ tekst, vak, soort }) {
  const c = cfg();
  const tag = `[${c.project}]`;
  const kop = [soort || "les", vak ? `vak: ${vak}` : "algemeen"].join(" | ");
  await request("POST", "/agentmemory/remember", {
    content: `${tag} ${kop} — ${tekst}`,
    type: "pattern",
    concepts: [c.project, vak, soort].filter(Boolean).join(","),
    project: c.project,
  });
}

/** Haal uit een willekeurig antwoord de tekstvelden van de gevonden items. */
function extractTexts(data) {
  const out = [];
  const list = Array.isArray(data)
    ? data
    : data?.results || data?.memories || data?.observations || data?.items || [];
  for (const item of Array.isArray(list) ? list : []) {
    const node = item?.memory || item?.observation || item;
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    const t = node?.content || node?.narrative || node?.text || node?.summary || node?.title;
    if (typeof t === "string") out.push(t);
  }
  return out;
}

/**
 * Zoek relevante lessen voor dit vak/document. Geeft een tekstblok terug (of "").
 * Enkel items met de projecttag worden gebruikt.
 */
export async function recallLessons(query, maxChars = 2500) {
  if (!memoryActive()) return "";
  const c = cfg();
  const tag = `[${c.project}]`;
  try {
    const data = await request("POST", "/agentmemory/smart-search", {
      query: `${c.project} ${query}`.slice(0, 500),
      limit: 15,
      project: c.project,
    });
    const seen = new Set();
    const lines = [];
    let used = 0;
    for (const raw of extractTexts(data)) {
      if (!raw.includes(tag)) continue;
      const line = raw.replace(tag, "").replace(/\s+/g, " ").trim();
      if (!line || seen.has(line)) continue;
      if (used + line.length > maxChars) break;
      seen.add(line);
      used += line.length;
      lines.push(`- ${line}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn("Geheugen (recall) mislukt:", err.message);
    return "";
  }
}
