/**
 * llmlog.js — Context en logging voor elke LLM-aanroep.
 *
 * `runWithLlmContext({documentId, versionNumber, callType}, fn)` zet de context voor
 * alle `chat()`-aanroepen binnen `fn` (AsyncLocalStorage). `llm.js` roept na elke
 * aanroep `recordLlmCall()` aan, die in de tabel `llm_calls` schrijft.
 * Logfouten mogen de verwerking nooit onderbreken.
 */
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { getDb } from "./db.js";
import { getSettings } from "../settings.js";

const als = new AsyncLocalStorage();

export function runWithLlmContext(ctx, fn) {
  const parent = als.getStore() || {};
  return als.run({ ...parent, ...ctx }, fn);
}

export function currentLlmContext() {
  return als.getStore() || {};
}

/** Kostenraming in EUR op basis van de ingestelde prijs per 1M tokens. */
export function estimateCost(promptTokens, completionTokens) {
  const s = getSettings();
  const cost =
    ((promptTokens || 0) * Number(s.priceInPer1M || 0) + (completionTokens || 0) * Number(s.priceOutPer1M || 0)) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

/** Vervangt base64-afbeeldingen door een plaatshouder zodat de log klein blijft. */
function promptToText(messages) {
  try {
    return JSON.stringify(
      messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map((c) => (c.type === "image_url" ? { type: "image_url", image_url: "[afbeelding weggelaten]" } : c))
          : m.content,
      }))
    );
  } catch {
    return "";
  }
}

export function recordLlmCall({ messages, response, model, usage, durationMs, error }) {
  try {
    const ctx = currentLlmContext();
    const db = getDb();
    const pt = usage?.prompt_tokens ?? null;
    const ct = usage?.completion_tokens ?? null;
    const total = usage?.total_tokens ?? (pt != null && ct != null ? pt + ct : null);
    // document_id moet bestaan (foreign key); anders NULL
    let documentId = ctx.documentId || null;
    let vak = ctx.vak || null;
    let teacher = ctx.teacher || null;
    if (documentId) {
      const doc = db.prepare("SELECT vak, teacher FROM documents WHERE id = ?").get(documentId);
      if (!doc) documentId = null;
      else {
        vak = vak || doc.vak || null;
        teacher = teacher || doc.teacher || null;
      }
    }
    db.prepare(
      `INSERT INTO llm_calls (id, document_id, version_number, vak, teacher, call_type, model, prompt_text, response_text,
         prompt_tokens, completion_tokens, total_tokens, cost_eur, duration_ms, verification_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      documentId,
      ctx.versionNumber ?? null,
      vak,
      teacher,
      ctx.callType || "overig",
      model || "onbekend",
      promptToText(messages),
      error ? `FOUT: ${error}` : String(response || ""),
      pt,
      ct,
      total,
      pt != null || ct != null ? estimateCost(pt, ct) : null,
      durationMs ?? null,
      error ? "fout" : ctx.verificationResult || null
    );
  } catch (err) {
    console.warn("[llmlog] kon aanroep niet loggen:", err.message);
  }
}
