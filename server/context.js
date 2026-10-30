/**
 * context.js — bouwt de vak- en trainingscontext voor de LLM (gedeeld door /api/improve en de P2-routes).
 */
import { recallLessons } from "./memory.js";
import { buildTrainingContext } from "./training.js";
import { buildSubjectContext } from "./subjects.js";
import { listTrainingSamples } from "./storage/repo.js";

const SAMPLE_BUDGET = 2500;

/**
 * Korte few-shot-voorbeelden uit door leerkrachten zelf verbeterde toetsen (vak-specifieke eerst).
 * Enkel voorbeelden waar het antwoord van de leerkracht verschilt van of ontbrak bij de app.
 */
export function buildSampleContext(subjectId) {
  let samples = [];
  try {
    const own = subjectId ? listTrainingSamples({ vakId: subjectId, limit: 40 }) : [];
    const all = listTrainingSamples({ limit: 40 });
    const seen = new Set();
    samples = [...own, ...all].filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
  } catch (err) {
    console.warn("[context] voorbeelden laden mislukt:", err.message);
    return "";
  }
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const blocks = [];
  let used = 0;
  for (const s of samples) {
    if (s.verdict === "gelijk" || !s.teacherAnswer || !s.questionText) continue;
    const block =
      `Vraag: ${clip(s.questionText, 300)}\n` +
      (s.aiAnswer ? `Antwoord van de app (afgekeurd/aangepast): ${clip(s.aiAnswer, 200)}\n` : "") +
      `Antwoord van de leerkracht: ${clip(s.teacherAnswer, 300)}` +
      (s.insight ? `\nReden: ${clip(s.insight, 200)}` : "");
    if (used + block.length > SAMPLE_BUDGET) break;
    used += block.length;
    blocks.push(block);
  }
  if (!blocks.length) return "";
  return `Voorbeelden van hoe leerkrachten zelf verbeterden (volg hun stijl, notatie en afronding):\n${blocks.join("\n---\n")}`;
}

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
  return [buildSubjectContext(subject, text, topics), training, buildSampleContext(subject?.id || null)]
    .filter(Boolean)
    .join("\n\n");
}
