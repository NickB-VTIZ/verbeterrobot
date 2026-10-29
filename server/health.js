/**
 * health.js — Versie, statusinfo en verbindingstests voor het beheerscherm.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSettings } from "./settings.js";
import { probeMemory } from "./memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return String(pkg.version || "onbekend");
  } catch {
    return "onbekend";
  }
}

export const VERSION = readVersion();

export function uptimeSeconds() {
  return Math.round((Date.now() - STARTED_AT) / 1000);
}

// Laatste testresultaat per verbinding (enkel in het geheugen van het proces)
const last = {};

export function lastResult(name) {
  return last[name] || null;
}

/** Voert een test uit en onthoudt het resultaat. Gooit de fout opnieuw door. */
async function track(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    last[name] = { ...result, ok: true, at: new Date().toISOString() };
    return last[name];
  } catch (err) {
    last[name] = {
      ok: false,
      error: err.message,
      ms: Date.now() - t0,
      at: new Date().toISOString(),
    };
    throw err;
  }
}

/** Omniroute: modellenlijst (en optioneel een minimale chat-aanvraag). */
export function testOmniroute({ deep = false } = {}) {
  return track("omniroute", async () => {
    const cfg = getSettings();
    if (!cfg.omnirouteBaseUrl) throw new Error("Base URL ontbreekt.");
    if (!cfg.omnirouteApiKey) throw new Error("API-sleutel ontbreekt.");
    const fetch = (await import("node-fetch")).default;
    const headers = {
      Authorization: `Bearer ${cfg.omnirouteApiKey}`,
      "Content-Type": "application/json",
    };

    const t0 = Date.now();
    const r = await fetch(`${cfg.omnirouteBaseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) {
      throw new Error(`Omniroute antwoordde met status ${r.status}: ${body.slice(0, 200)}`);
    }
    let ids = [];
    try {
      const j = JSON.parse(body);
      ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    } catch {
      /* geen JSON-lijst: niet erg */
    }
    const result = {
      ms,
      modelCount: ids.length,
      modelFound: ids.length ? ids.includes(cfg.omnirouteModel) : null,
      model: cfg.omnirouteModel,
    };

    if (deep) {
      const c0 = Date.now();
      const cr = await fetch(`${cfg.omnirouteBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: cfg.omnirouteModel,
          messages: [{ role: "user", content: "Antwoord met het woord: ok" }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const ctext = await cr.text();
      if (!cr.ok) {
        throw new Error(
          `Modellenlijst werkt, maar de chat-test met model "${cfg.omnirouteModel}" faalde (status ${cr.status}): ${ctext.slice(0, 200)}`
        );
      }
      result.chatMs = Date.now() - c0;
    }
    return result;
  });
}

/** Agentmemory: bereikbaarheid, geheim en aantal lessen. */
export function testAgentmemory() {
  return track("memory", () => probeMemory());
}
