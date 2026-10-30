import { useCallback, useEffect, useRef, useState } from "react";
import { Api, ApiError, formatDate } from "./api";
import { Banner, Spinner } from "./ui";

interface Sample {
  id: string;
  qid: string;
  questionText: string;
  aiAnswer: string;
  teacherAnswer: string;
  verdict: string;
  insight: string;
  createdAt: string;
}

interface LearnResult {
  samples: number;
  gelijk: number;
  afwijkend: number;
  nieuw: number;
  lessons: number;
  insightsFailed?: boolean;
  changedParagraphs?: number;
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  gelijk: { label: "zelfde als AI", cls: "bg-green-100 text-green-800" },
  afwijkend: { label: "afwijkend", cls: "bg-amber-100 text-amber-800" },
  nieuw: { label: "nieuw", cls: "bg-blue-100 text-blue-800" },
};

interface Props {
  api: Api;
  docId: string;
  disabled?: boolean;
}

/** Upload van een zelf verbeterde versie: de robot vergelijkt die met zijn eigen antwoorden en leert ervan. */
export default function CorrectedUpload({ api, docId, disabled = false }: Props) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LearnResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadSamples = useCallback(async () => {
    try {
      const d = await api.json<{ samples: Sample[] }>(`/api/documents/${docId}/samples`);
      setSamples(d.samples || []);
    } catch {
      /* geen voorbeelden tonen */
    }
  }, [api, docId]);

  useEffect(() => {
    loadSamples();
  }, [loadSamples]);

  async function upload(file: File | undefined | null) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setError("Enkel Word-bestanden (.docx) zijn mogelijk.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api.json<{ result: LearnResult }>(`/api/documents/${docId}/corrected`, {
        method: "POST",
        body: fd,
      });
      setResult(r.result);
      await loadSamples();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : "Mislukt.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-gray-900">Zelf verbeterde versie &mdash; de robot leert</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Upload jouw eigen verbeterde versie (.docx, gebaseerd op dit document). De robot vergelijkt jouw
            antwoorden met zijn eigen sleutel, bewaart de verschillen als voorbeelden en gebruikt ze bij volgende
            verbeteringen.
          </p>
        </div>
        <label className={`btn-sm cursor-pointer ${disabled || busy ? "opacity-50 pointer-events-none" : ""}`}>
          {busy ? <Spinner className="w-3.5 h-3.5" /> : "⬆"} {busy ? "Analyseren…" : "Verbeterde versie uploaden"}
          <input
            ref={inputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            disabled={disabled || busy}
            onChange={e => upload(e.target.files?.[0])}
          />
        </label>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {result && (
        <Banner tone="ok">
          {result.samples} antwoord(en) geleerd: {result.afwijkend} afwijkend, {result.nieuw} nieuw, {result.gelijk}{" "}
          gelijk aan de AI. {result.lessons > 0 ? `${result.lessons} les(sen) toegevoegd. ` : ""}
          {result.insightsFailed ? "De uitleg per vraag kon niet gegenereerd worden, maar de antwoorden zijn bewaard." : ""}
        </Banner>
      )}

      {samples.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-700">Geleerde voorbeelden ({samples.length})</summary>
          <ul className="mt-2 divide-y divide-gray-100">
            {samples.map(s => {
              const v = VERDICT[s.verdict] || { label: s.verdict, cls: "bg-gray-100 text-gray-700" };
              return (
                <li key={s.id} className="py-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${v.cls}`}>{v.label}</span>
                    <span className="font-medium text-gray-800">{s.qid ? `Vraag ${s.qid}` : "Vraag"}</span>
                    <span className="text-xs text-gray-400">{formatDate(s.createdAt)}</span>
                  </div>
                  {s.questionText && <div className="text-xs text-gray-500 line-clamp-2">{s.questionText}</div>}
                  <div className="grid sm:grid-cols-2 gap-2 text-xs">
                    <div className="rounded bg-gray-50 border border-gray-200 p-2 whitespace-pre-wrap">
                      <div className="font-semibold text-gray-500">AI</div>
                      {s.aiAnswer || "—"}
                    </div>
                    <div className="rounded bg-red-50 border border-red-200 p-2 whitespace-pre-wrap text-red-700">
                      <div className="font-semibold">Leerkracht</div>
                      {s.teacherAnswer || "—"}
                    </div>
                  </div>
                  {s.insight && <div className="text-xs text-gray-600">💡 {s.insight}</div>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
