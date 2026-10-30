/**
 * llm.js — kleine hulpfuncties voor JSON-aanroepen naar Omniroute (OpenAI-compatibel).
 * De instellingen (URL, sleutel, model) worden bij elke aanroep uit het beheer gelezen.
 */

import { getSettings } from "../settings.js";
import { recordLlmCall } from "../storage/llmlog.js";

/**
 * Haalt een JSON-object (of array) uit een modelantwoord, ook met codefences of extra tekst.
 * @param {string} raw
 * @returns {any}
 */
export function parseJsonLoose(raw) {
  const cleaned = String(raw || "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const o1 = cleaned.indexOf("{");
    const o2 = cleaned.lastIndexOf("}");
    if (o1 !== -1 && o2 > o1) {
      try {
        return JSON.parse(cleaned.slice(o1, o2 + 1));
      } catch {
        /* val door */
      }
    }
    const a1 = cleaned.indexOf("[");
    const a2 = cleaned.lastIndexOf("]");
    if (a1 !== -1 && a2 > a1) {
      try {
        return JSON.parse(cleaned.slice(a1, a2 + 1));
      } catch {
        /* val door */
      }
    }
  }
  throw new Error("AI stuurde geen geldige JSON terug.");
}

/**
 * Stuurt messages naar het model en geeft de ruwe tekst terug.
 * `content` mag ook een array zijn (tekst + image_url) voor vision-modellen.
 * @param {Array<{role:string,content:string|Array}>} messages
 * @param {{temperature?:number, json?:boolean, model?:string}} opts  model: overschrijft het standaardmodel
 */
export async function chat(messages, { temperature, json = true, model } = {}) {
  const fetch = (await import("node-fetch")).default;
  const cfg = getSettings();
  const body = {
    model: model || cfg.omnirouteModel,
    temperature: temperature ?? Math.min(Number(cfg.temperature ?? 0.2), 0.2),
    messages,
  };
  if (json) body.response_format = { type: "json_object" };

  async function post(b) {
    return fetch(`${cfg.omnirouteBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.omnirouteApiKey}`,
      },
      body: JSON.stringify(b),
    });
  }

  const started = Date.now();
  let response;
  try {
    response = await post(body);
    // Niet elk model ondersteunt JSON-modus: probeer opnieuw zonder response_format
    if (!response.ok && json && [400, 422].includes(response.status)) {
      delete body.response_format;
      response = await post(body);
    }
  } catch (err) {
    recordLlmCall({ messages, model: body.model, durationMs: Date.now() - started, error: err.message });
    throw err;
  }
  if (!response.ok) {
    const text = await response.text();
    const msg = `Omniroute API-fout (${response.status}): ${text.slice(0, 300)}`;
    recordLlmCall({ messages, model: body.model, durationMs: Date.now() - started, error: msg });
    throw new Error(msg);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  recordLlmCall({
    messages,
    response: content,
    model: data?.model || body.model,
    usage: data?.usage,
    durationMs: Date.now() - started,
  });
  return content;
}

/**
 * Vraagt een JSON-antwoord. Bij ongeldige JSON of een validatiefout wordt de fout
 * teruggegeven aan het model (max. `retries` extra pogingen).
 *
 * @param {Array} messages  startconversatie (wordt aangevuld)
 * @param {(parsed:any)=>any} validate  gooit een Error met een duidelijke melding bij fouten; geeft de genormaliseerde waarde terug
 * @param {{retries?:number, temperature?:number, model?:string}} opts
 */
export async function askJson(messages, validate, { retries = 2, temperature, model } = {}) {
  const convo = [...messages];
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await chat(convo, { temperature, model });
    try {
      return validate(parseJsonLoose(raw));
    } catch (err) {
      lastErr = err;
      convo.push({ role: "assistant", content: String(raw).slice(0, 6000) });
      convo.push({
        role: "user",
        content:
          `Je antwoord werd geweigerd: ${err.message}\n` +
          "Stuur het volledige antwoord opnieuw als geldige JSON, zonder uitleg en zonder codefences.",
      });
    }
  }
  throw lastErr;
}
