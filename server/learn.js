/**
 * learn.js — leert uit een door de leerkracht zelf verbeterde versie van een toets.
 *
 * Werking (de code doet het zware werk, het taalmodel levert enkel een korte duiding):
 *  1. De paragrafen van de verbeterde versie worden vergeleken met die van het origineel (LCS op genormaliseerde tekst).
 *  2. Alles wat de leerkracht toevoegde of wijzigde, wordt aan de dichtstbijzijnde voorafgaande vraag gekoppeld.
 *  3. Per vraag wordt een trainingsvoorbeeld bewaard (vraag, antwoord van de app, antwoord van de leerkracht, oordeel).
 *  4. Best effort: het taalmodel verklaart de afwijkingen en formuleert korte lessen die in de training terechtkomen.
 */
import { extractDocxParagraphs } from "./docx/pipeline.js";
import { marksToQuestions } from "./docx/marks.js";
import { askJson } from "./docx/llm.js";
import { runWithLlmContext } from "./storage/llmlog.js";
import { addLesson } from "./training.js";
import {
  getParagraphs,
  getVersion,
  getMarks,
  addTrainingSample,
  clearTrainingSamples,
  audit,
} from "./storage/repo.js";

const MAX_PARAS = 3000;

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const contentText = (c) => (Array.isArray(c) ? c.map(String).join("\n") : String(c ?? ""));

/** Overlap (Jaccard) van woorden, 0..1. */
export function similarity(a, b) {
  const words = (s) => new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const A = words(a);
  const B = words(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Vergelijkt twee paragraaflijsten. Geeft per "gat" tussen overeenkomende paragrafen terug wat er
 * in het origineel niet gematcht is en welke tekst de leerkracht toevoegde of wijzigde.
 * @param {string[]} origTexts
 * @param {string[]} corrTexts
 * @returns {Array<{anchorIdx:number, origIdxs:number[], added:string[]}>}
 */
export function diffParagraphs(origTexts, corrTexts) {
  const n = origTexts.length;
  const m = corrTexts.length;
  if (n > MAX_PARAS || m > MAX_PARAS) throw new Error("Het document is te groot om te vergelijken.");
  const a = origTexts.map(norm);
  const b = corrTexts.map(norm);
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const matches = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  matches.push([n, m]);

  const gaps = [];
  let pi = -1;
  let pj = -1;
  for (const [ni, nj] of matches) {
    const origIdxs = [];
    for (let k = pi + 1; k < ni; k++) origIdxs.push(k);
    const added = [];
    for (let k = pj + 1; k < nj; k++) {
      const raw = String(corrTexts[k] ?? "").trim();
      if (!raw) continue;
      let text = raw;
      // Een gewijzigde paragraaf die met de originele tekst begint → enkel het toegevoegde deel is het antwoord
      for (const oi of origIdxs) {
        const o = String(origTexts[oi] ?? "").trim();
        if (o.length >= 3 && raw.length > o.length && raw.startsWith(o)) {
          text = raw.slice(o.length).replace(/^[\s:.\-–]+/, "").trim() || raw;
          break;
        }
      }
      added.push(text);
    }
    if (added.length) gaps.push({ anchorIdx: pi, origIdxs, added });
    pi = ni;
    pj = nj;
  }
  return gaps;
}

/**
 * Koppelt de gaten aan vragen: de vraag met de grootste startpositie die niet na het gat begint.
 * @param {Array} gaps
 * @param {Array<{qid:string, start:number}>} starts  gesorteerd op positie
 * @returns {Map<string, string[]>} qid → toegevoegde teksten
 */
export function assignToQuestions(gaps, starts) {
  const out = new Map();
  for (const g of gaps) {
    const pos = g.origIdxs.length ? g.origIdxs[0] : g.anchorIdx;
    let chosen = null;
    for (const s of starts) {
      if (s.start <= pos) chosen = s;
      else break;
    }
    if (!chosen) continue;
    if (!out.has(chosen.qid)) out.set(chosen.qid, []);
    out.get(chosen.qid).push(...g.added);
  }
  return out;
}

/** Vragen van het document: actieve versie → aanduidingen van de leerkracht → voorstel van het model. */
function questionSource(doc, paragraphs) {
  const version = doc.activeVersion ? getVersion(doc.id, doc.activeVersion) : null;
  if (version?.questions?.length) {
    const aiByQid = new Map();
    for (const s of version.slots || []) {
      aiByQid.set(s.qid, [aiByQid.get(s.qid), contentText(s.content)].filter(Boolean).join("\n"));
    }
    return { questions: version.questions, aiByQid };
  }
  for (const source of ["teacher", "llm_proposal"]) {
    const marks = getMarks(doc.id, source);
    if (marks.length) {
      const { questions } = marksToQuestions(marks.map((m) => ({ ...m })), paragraphs);
      if (questions.length) return { questions, aiByQid: new Map() };
    }
  }
  return { questions: [], aiByQid: new Map() };
}

async function explain(items, doc) {
  const payload = items.map((s) => ({
    qid: s.qid,
    vraag: s.questionText.slice(0, 600),
    antwoord_app: s.aiAnswer.slice(0, 600),
    antwoord_leerkracht: s.teacherAnswer.slice(0, 600),
  }));
  const messages = [
    {
      role: "system",
      content:
        'Je helpt een verbetersleutel-robot leren van een leerkracht. Je krijgt per vraag het antwoord van de app en dat van de leerkracht. ' +
        'Verklaar kort (1 zin, Nederlands) waarom het antwoord van de leerkracht anders is (andere notatie, eenheid, afronding, methode, formulering, ...). ' +
        'Formuleer daarna maximaal 3 korte, algemene lessen (elk max. 250 tekens) die de app moet volgen bij vergelijkbare vragen. Geen lessen als er niets algemeens te leren valt. ' +
        'Antwoord UITSLUITEND met JSON: {"inzichten":[{"qid":"1","inzicht":"..."}],"lessen":["..."]}',
    },
    { role: "user", content: `Vak: ${doc.vak || "onbekend"}\n${JSON.stringify(payload)}` },
  ];
  return askJson(
    messages,
    (p) => {
      if (!p || typeof p !== "object") throw new Error("Verwacht een JSON-object.");
      return {
        inzichten: Array.isArray(p.inzichten) ? p.inzichten : [],
        lessen: Array.isArray(p.lessen) ? p.lessen.map(String) : [],
      };
    },
    { retries: 1, temperature: 0 }
  );
}

/**
 * @param {object} doc  document (uit getDocument)
 * @param {string} correctedPath  pad naar de verbeterde .docx
 * @param {{name:string, role:string}} user
 * @param {{useLlm?:boolean}} opts
 */
export async function learnFromCorrected(doc, correctedPath, user, { useLlm = true } = {}) {
  const paragraphs = getParagraphs(doc.id);
  if (!paragraphs.length) throw Object.assign(new Error("Van dit document zijn geen paragrafen opgeslagen."), { status: 422 });
  const corrected = await extractDocxParagraphs(correctedPath);
  const gaps = diffParagraphs(
    paragraphs.map((p) => p.text),
    corrected.map((p) => p.text)
  );

  const { questions, aiByQid } = questionSource(doc, paragraphs);
  if (!questions.length) {
    throw Object.assign(
      new Error("Er zijn nog geen vragen bepaald. Laat eerst een voorstel maken of genereer een verbetersleutel."),
      { status: 422 }
    );
  }
  const idx = new Map(paragraphs.map((p, i) => [p.id, i]));
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const info = new Map();
  const starts = [];
  for (const q of questions) {
    const ids = [...(q.question_para_ids || []), ...(q.slots || []).map((s) => s.para_id)];
    const pos = ids.map((id) => idx.get(id)).filter((v) => v != null);
    if (!pos.length) continue;
    const qText = (q.question_para_ids || []).map((id) => byId.get(id)?.text).filter(Boolean).join("\n");
    info.set(q.qid, { questionText: qText });
    starts.push({ qid: q.qid, start: Math.min(...pos) });
  }
  starts.sort((x, y) => x.start - y.start);

  const assigned = assignToQuestions(gaps, starts);
  const samples = [];
  for (const [qid, texts] of assigned) {
    const teacherAnswer = texts.join("\n").trim();
    if (!teacherAnswer) continue;
    const aiAnswer = (aiByQid.get(qid) || "").trim();
    let verdict = "nieuw";
    if (aiAnswer) verdict = similarity(aiAnswer, teacherAnswer) >= 0.8 ? "gelijk" : "afwijkend";
    samples.push({ qid, questionText: info.get(qid)?.questionText || "", aiAnswer, teacherAnswer, verdict, insight: "" });
  }

  const result = {
    samples: samples.length,
    gelijk: samples.filter((s) => s.verdict === "gelijk").length,
    afwijkend: samples.filter((s) => s.verdict === "afwijkend").length,
    nieuw: samples.filter((s) => s.verdict === "nieuw").length,
    lessons: 0,
    insightsFailed: false,
    changedParagraphs: gaps.reduce((n, g) => n + g.added.length, 0),
  };

  // Best effort duiding door het taalmodel (enkel bij afwijkingen/nieuwe antwoorden)
  const toExplain = samples.filter((s) => s.verdict !== "gelijk").slice(0, 8);
  let lessen = [];
  if (useLlm && toExplain.length) {
    try {
      const r = await runWithLlmContext(
        { documentId: doc.id, callType: "leren", vak: doc.vak || "", teacher: user.name },
        () => explain(toExplain, doc)
      );
      const byQ = new Map(r.inzichten.map((x) => [String(x.qid), String(x.inzicht ?? "")]));
      for (const s of samples) s.insight = byQ.get(String(s.qid)) || "";
      lessen = r.lessen.map((l) => l.trim()).filter((l) => l.length >= 5).slice(0, 3);
    } catch (err) {
      console.warn("[learn] duiding mislukt:", err.message);
      result.insightsFailed = true;
    }
  }

  clearTrainingSamples(doc.id, "verbeterde_versie");
  for (const s of samples) addTrainingSample({ docId: doc.id, source: "verbeterde_versie", ...s });

  for (const tekst of lessen) {
    try {
      addLesson({ tekst: tekst.slice(0, 280), vakId: doc.vakId || null, vakNaam: doc.vak || "", soort: "correctie" });
      result.lessons++;
    } catch {
      /* dubbele of te lange les: negeren */
    }
  }

  audit(doc.id, user.name, user.role, "verbeterde_versie_geupload", result);
  return result;
}
