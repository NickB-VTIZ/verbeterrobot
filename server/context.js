/**
 * context.js — bouwt de vak- en trainingscontext voor de LLM (gedeeld door /api/improve en de P2-routes).
 */
import { recallLessons } from "./memory.js";
import { buildTrainingContext } from "./training.js";
import { buildSubjectContext } from "./subjects.js";

/**
 * @param {{subject: object|null, topics?: string[], text?: string}} p
 * @returns {Promise<string>} samengestelde context (leeg als er niets is)
 */
export async function buildGenerationContext({ subject = null, topics = [], text = "" }) {
  let recalled = "";
  try {
    recalled = await recallLessons(`${subject?.naam || ""} ${topics.join(" ")} ${String(text).slice(0, 300)}`);
  } catch (err) {
    console.warn("[context] recall mislukt:", err.message);
  }
  const training = buildTrainingContext(subject?.id || null, recalled);
  return [buildSubjectContext(subject, text, topics), training].filter(Boolean).join("\n\n");
}
