import { useEffect, useState } from "react";

interface Sample {
  id: string;
  documentId: string | null;
  qid: string;
  vak: string;
  vakId: string | null;
  teacher: string;
  questionText: string;
  aiAnswer: string;
  teacherAnswer: string;
  verdict: "gelijk" | "afwijkend" | "nieuw" | string;
  insight: string;
  source: string;
  createdAt: string;
}
interface Lesson {
  id: string;
  tekst: string;
  vakNaam: string;
  soort: string;
  aangemaakt: string;
}
interface FeedbackItem {
  id: string;
  documentId?: string | null;
  qid?: string | null;
  questionText?: string;
  originalAnswer?: string;
  correctedAnswer?: string;
  action?: string;
  comment?: string;
  user?: string;
  createdAt?: string;
}

interface Props {
  token: string;
  onUnauthorized: () => void;
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  gelijk: { label: "gelijk aan AI", cls: "bg-green-100 text-green-800" },
  afwijkend: { label: "afwijkend", cls: "bg-amber-100 text-amber-800" },
  nieuw: { label: "nieuw", cls: "bg-blue-100 text-blue-800" },
};

function fmt(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("nl-BE");
}

export default function TrainingData({ token, onUnauthorized }: Props) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [sampleCount, setSampleCount] = useState(0);
  const [memoryOn, setMemoryOn] = useState(false);
  const [filter, setFilter] = useState<"alle" | "afwijkend" | "nieuw" | "gelijk">("alle");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const auth = { Authorization: `Bearer ${token}` };

  async function call(url: string, init: RequestInit = {}) {
    const res = await fetch(url, init);
    if (res.status === 401 || res.status === 403) {
      onUnauthorized();
      throw new Error("Sessie verlopen.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Serverfout (${res.status})`);
    return data;
  }

  async function reload() {
    const d = await call("/api/admin/training-data", { headers: auth });
    setSamples(d.samples || []);
    setLessons(d.lessons || []);
    setFeedback(d.feedback || []);
    setSampleCount(d.sampleCount ?? (d.samples || []).length);
    setMemoryOn(!!d.memoryActive);
    setLoaded(true);
  }

  useEffect(() => {
    reload().catch(e => setMsg({ type: "err", text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(url: string, okText: string, question: string) {
    if (!confirm(question)) return;
    setBusy(true);
    setMsg(null);
    try {
      await call(url, { method: "DELETE", headers: auth });
      await reload();
      setMsg({ type: "ok", text: okText });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Mislukt." });
    } finally {
      setBusy(false);
    }
  }

  const shown = samples.filter(s => filter === "alle" || s.verdict === filter);
  const count = (v: string) => samples.filter(s => s.verdict === v).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="stat-tile">
          <p className="text-xs text-gray-400">Voorbeelden</p>
          <p className="text-xl font-bold text-gray-900">{sampleCount}</p>
        </div>
        <div className="stat-tile">
          <p className="text-xs text-gray-400">Lessen</p>
          <p className="text-xl font-bold text-gray-900">{lessons.length}</p>
        </div>
        <div className="stat-tile">
          <p className="text-xs text-gray-400">Feedback</p>
          <p className="text-xl font-bold text-gray-900">{feedback.length}</p>
        </div>
        <div className="stat-tile">
          <p className="text-xs text-gray-400">Geheugen (agentmemory)</p>
          <p className={`text-xl font-bold ${memoryOn ? "text-green-700" : "text-gray-500"}`}>
            {memoryOn ? "● actief" : "○ uit"}
          </p>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Afwijkende en nieuwe antwoorden uit zelf verbeterde versies worden als voorbeeld aan de prompt
        toegevoegd (eerst vakspecifiek). Lessen en feedback van leerkrachten tellen ook mee.
      </p>

      {msg && (
        <div
          className={`rounded-lg px-4 py-3 text-sm border ${
            msg.type === "ok"
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-gray-800">
            Voorbeelden uit verbeterde versies ({sampleCount})
          </h4>
          <div className="flex gap-1 text-xs ml-auto">
            {(["alle", "afwijkend", "nieuw", "gelijk"] as const).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-full border cursor-pointer ${
                  filter === f ? "bg-red-600 text-white border-red-600" : "border-gray-300 text-gray-600"
                }`}
              >
                {f === "alle" ? `alle (${samples.length})` : `${f} (${count(f)})`}
              </button>
            ))}
          </div>
        </div>
        {loaded && shown.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center">
            <p className="text-3xl" aria-hidden="true">🧠</p>
            <p className="mt-2 text-sm font-semibold text-gray-700">
              {samples.length === 0 ? "Nog geen voorbeelden" : "Geen voorbeelden met dit filter"}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {samples.length === 0
                ? "Open een document in de bibliotheek en upload een zelf verbeterde versie om de robot te trainen."
                : "Kies een ander filter om de andere voorbeelden te zien."}
            </p>
          </div>
        )}
        {shown.map(s => {
          const v = VERDICT[s.verdict] || { label: s.verdict, cls: "bg-gray-100 text-gray-700" };
          return (
            <details key={s.id} className="rounded-lg border border-gray-200 px-4 py-3 text-sm">
              <summary className="cursor-pointer flex flex-wrap items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full ${v.cls}`}>{v.label}</span>
                <span className="font-medium text-gray-900">
                  {s.qid ? `Vraag ${s.qid}: ` : ""}
                  {(s.questionText || "").slice(0, 90)}
                  {(s.questionText || "").length > 90 ? "…" : ""}
                </span>
                <span className="text-xs text-gray-400 ml-auto">
                  {[s.vak, s.teacher, fmt(s.createdAt)].filter(Boolean).join(" · ")}
                </span>
              </summary>
              <div className="mt-3 space-y-2">
                <div>
                  <div className="text-xs font-semibold text-gray-500">Vraag</div>
                  <p className="whitespace-pre-wrap">{s.questionText}</p>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="rounded bg-gray-50 p-2">
                    <div className="text-xs font-semibold text-gray-500">Antwoord van de AI</div>
                    <p className="whitespace-pre-wrap">{s.aiAnswer || "—"}</p>
                  </div>
                  <div className="rounded bg-red-50 p-2">
                    <div className="text-xs font-semibold text-red-700">Antwoord van de leerkracht</div>
                    <p className="whitespace-pre-wrap">{s.teacherAnswer || "—"}</p>
                  </div>
                </div>
                {s.insight && (
                  <div>
                    <div className="text-xs font-semibold text-gray-500">Inzicht</div>
                    <p className="whitespace-pre-wrap">{s.insight}</p>
                  </div>
                )}
                <button
                  type="button"
                  className="text-xs text-red-700 underline cursor-pointer"
                  disabled={busy}
                  onClick={() =>
                    remove(
                      `/api/admin/training-data/samples/${s.id}`,
                      "Voorbeeld verwijderd.",
                      "Dit voorbeeld verwijderen uit de trainingsdata?"
                    )
                  }
                >
                  Verwijderen
                </button>
              </div>
            </details>
          );
        })}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-800">Lessen ({lessons.length})</h4>
        {lessons.length === 0 && <p className="text-sm text-gray-500">Geen lessen.</p>}
        {lessons.map(l => (
          <div key={l.id} className="rounded-lg border border-gray-200 px-4 py-3 text-sm">
            <div className="text-xs text-gray-500">
              {l.soort} · {l.vakNaam || "algemeen"} · {fmt(l.aangemaakt)}
            </div>
            <p className="whitespace-pre-wrap">{l.tekst}</p>
          </div>
        ))}
        <p className="text-xs text-gray-400">Lessen beheer je onder het tabblad Training.</p>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-800">Feedback van leerkrachten ({feedback.length})</h4>
        {feedback.length === 0 && <p className="text-sm text-gray-500">Nog geen feedback.</p>}
        {feedback.map(f => (
          <div key={f.id} className="rounded-lg border border-gray-200 px-4 py-3 text-sm space-y-1">
            <div className="text-xs text-gray-500">
              {[f.action, f.user, fmt(f.createdAt)].filter(Boolean).join(" · ")}
            </div>
            {f.questionText && <p className="font-medium whitespace-pre-wrap">{f.questionText}</p>}
            {f.originalAnswer && (
              <p className="text-gray-600 whitespace-pre-wrap">
                <span className="text-xs font-semibold">AI: </span>
                {f.originalAnswer}
              </p>
            )}
            {f.correctedAnswer && (
              <p className="text-red-700 whitespace-pre-wrap">
                <span className="text-xs font-semibold">Leerkracht: </span>
                {f.correctedAnswer}
              </p>
            )}
            {f.comment && <p className="italic text-gray-600">{f.comment}</p>}
            <button
              type="button"
              className="text-xs text-red-700 underline cursor-pointer"
              disabled={busy}
              onClick={() =>
                remove(
                  `/api/admin/training-data/feedback/${f.id}`,
                  "Feedback verwijderd.",
                  "Deze feedback verwijderen?"
                )
              }
            >
              Verwijderen
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
