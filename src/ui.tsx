import { useEffect, useState, ReactNode } from "react";
import { Api, formatBytes } from "./api";

export function Spinner({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loader({ text = "Laden…" }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-gray-500 text-sm">
      <Spinner className="w-5 h-5 text-red-600" /> {text}
    </div>
  );
}

export function EmptyState({ icon = "📄", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="text-center py-12 px-4">
      <div className="text-5xl mb-3" aria-hidden>
        {icon}
      </div>
      <h3 className="text-base font-semibold text-gray-800">{title}</h3>
      {children && <div className="text-sm text-gray-500 mt-1 max-w-md mx-auto">{children}</div>}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "error" | "ok" | "warn" | "info"; children: ReactNode }) {
  const cls = {
    error: "bg-red-50 text-red-700 border-red-200",
    ok: "bg-green-50 text-green-800 border-green-200",
    warn: "bg-amber-50 text-amber-900 border-amber-200",
    info: "bg-blue-50 text-blue-900 border-blue-200",
  }[tone];
  return <div className={`text-sm rounded-lg border px-4 py-2.5 ${cls}`}>{children}</div>;
}

/** Afbeelding die met Authorization-header wordt opgehaald (miniaturen / PDF-voorbeeld). */
export function AuthImage({ api, url, alt, className = "" }: { api: Api; url: string | null; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) {
      setSrc(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    let obj = "";
    setFailed(false);
    api
      .blob(url)
      .then(b => {
        if (cancelled) return;
        obj = URL.createObjectURL(b);
        setSrc(obj);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, api.token]);
  if (!url || failed || !src) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-gray-400 text-xs ${className}`}>
        {url && !failed ? <Spinner className="w-4 h-4" /> : "Geen voorbeeld"}
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}

/**
 * Duidelijke "AI is bezig"-weergave: grote spinner, uitleg, lopende stappen en verstreken tijd.
 * `compact` toont een kleinere versie (bv. als overlay of in een kolom).
 */
export function GeneratingPanel({
  title,
  children,
  steps,
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  steps?: string[];
  compact?: boolean;
}) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  // Dummy-voortgang: loopt snel op en vlakt af, zodat de balk altijd beweegt maar nooit "klaar" suggereert.
  const pct = Math.min(92, Math.round(100 * (1 - Math.exp(-secs / 60))));
  const activeStep = steps && steps.length ? Math.min(steps.length - 1, Math.floor(secs / 20)) : -1;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border border-blue-200 bg-blue-50 text-blue-900 ${compact ? "p-4" : "p-5"} flex flex-col items-center text-center gap-3`}
    >
      <div className="relative">
        <Spinner className={compact ? "w-10 h-10 text-red-600" : "w-12 h-12 text-red-600"} />
        <span className="absolute inset-0 flex items-center justify-center text-lg" aria-hidden>
          🤖
        </span>
      </div>
      <div>
        <div className="font-semibold text-base">{title}</div>
        {children && <div className="text-sm text-blue-800 mt-1 max-w-md">{children}</div>}
      </div>
      <div className="w-full max-w-sm">
        <div className="h-2 rounded-full bg-blue-100 overflow-hidden">
          <div className="h-full bg-red-500 transition-all duration-1000 animate-pulse" style={{ width: `${Math.max(pct, 5)}%` }} />
        </div>
        <div className="text-xs text-blue-700 mt-1 tabular-nums">
          Bezig sinds {mm}:{ss} · dit duurt meestal 1 à 3 minuten
        </div>
      </div>
      {steps && steps.length > 0 && (
        <ol className="text-xs text-left space-y-1">
          {steps.map((s, i) => (
            <li key={s} className={`flex items-center gap-2 ${i < activeStep ? "text-green-700" : i === activeStep ? "font-semibold text-blue-900" : "text-blue-400"}`}>
              <span aria-hidden className="w-4 inline-flex justify-center">
                {i < activeStep ? "✓" : i === activeStep ? <Spinner className="w-3 h-3" /> : "•"}
              </span>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** PDF-voorbeeld in een iframe (met Authorization opgehaald als blob), zonder pagina-overzicht. */
export function AuthPdf({
  api,
  url,
  title,
  height = "h-[80vh]",
}: {
  api: Api;
  url: string | null;
  title: string;
  height?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let obj = "";
    setFailed(false);
    setSrc(null);
    api
      .blob(url)
      .then(b => {
        if (cancelled) return;
        obj = URL.createObjectURL(b);
        setSrc(obj);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, api.token]);
  if (!url || failed) return <div className={`text-sm text-gray-500 p-6 text-center rounded-lg border border-dashed border-gray-300 ${height} flex items-center justify-center`}>Geen voorbeeld beschikbaar.</div>;
  if (!src) return <Loader text="Voorbeeld laden…" />;
  // Fragment: verbergt het miniaturen-/paginaoverzicht en de werkbalk van de ingebouwde PDF-viewer
  // (Chrome/Edge: navpanes/toolbar, Firefox: pagemode) en past de pagina aan de breedte aan.
  const viewerSrc = `${src}#toolbar=0&navpanes=0&scrollbar=1&pagemode=none&view=FitH`;
  return (
    <div className="space-y-1">
      <iframe src={viewerSrc} title={title} className={`w-full ${height} rounded-lg border border-gray-200 bg-white`} />
      <div className="text-right">
        <a href={src} target="_blank" rel="noreferrer" className="text-xs text-red-600 hover:underline">
          ↗ Open in nieuw tabblad (volledige viewer)
        </a>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className={`bg-white rounded-2xl shadow-xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-auto p-6`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none" aria-label="Sluiten">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface PurgeInfo {
  id: string;
  title: string;
  teacher: string;
  versions: number;
  files: number;
  bytes: number;
  marks: number;
  llmCalls: number;
  approvedExamples: number;
  otherFeedback: number;
}

/** Bevestiging met overzicht van wat er definitief verdwijnt (altijd tonen, ook bij meerdere documenten). */
export function PurgeDialog({ api, ids, onDone, onCancel }: { api: Api; ids: string[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const [infos, setInfos] = useState<PurgeInfo[] | null>(null);
  const [retention, setRetention] = useState(30);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out: PurgeInfo[] = [];
        for (const id of ids) {
          const r = await api.json<{ preview: PurgeInfo; retentionDays: number }>(`/api/documents/${id}/purge-preview`);
          out.push(r.preview);
          setRetention(r.retentionDays);
        }
        if (!cancelled) setInfos(out);
      } catch (e: any) {
        if (!cancelled) setErr(e.message || "Overzicht laden mislukt.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);

  const sum = (k: keyof PurgeInfo) => (infos || []).reduce((a, i) => a + (Number(i[k]) || 0), 0);

  async function confirm() {
    setBusy(true);
    setErr("");
    try {
      const res = await api.json<{ done: string[]; skipped: { id: string; reden: string }[] }>("/api/library/bulk", {
        method: "POST",
        body: { ids, action: "purge", confirm: true, keepExamples: keep },
      });
      const msg = `${res.done.length} document(en) definitief verwijderd.` + (res.skipped.length ? ` ${res.skipped.length} overgeslagen: ${res.skipped.map(s => s.reden).join("; ")}` : "");
      onDone(msg);
    } catch (e: any) {
      setErr(e.message || "Verwijderen mislukt.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Definitief verwijderen?" onClose={onCancel} wide>
      {!infos && !err && <Loader text="Overzicht opmaken…" />}
      {infos && (
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Dit kan <strong>niet</strong> ongedaan gemaakt worden. Alle bestanden en versies van onderstaande documenten verdwijnen van de server. Documenten in de prullenbak worden na {retention} dagen
            sowieso automatisch verwijderd.
          </p>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">Document</th>
                  <th className="px-2 py-2">Versies</th>
                  <th className="px-2 py-2">Bestanden</th>
                  <th className="px-2 py-2">Grootte</th>
                  <th className="px-2 py-2">Voorbeelden</th>
                </tr>
              </thead>
              <tbody>
                {infos.map(i => (
                  <tr key={i.id} className="border-t border-gray-100">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{i.title}</div>
                      <div className="text-xs text-gray-500">{i.teacher}</div>
                    </td>
                    <td className="px-2 py-2 text-center">{i.versions}</td>
                    <td className="px-2 py-2 text-center">{i.files}</td>
                    <td className="px-2 py-2 text-center">{formatBytes(i.bytes)}</td>
                    <td className="px-2 py-2 text-center">{i.approvedExamples}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <td className="px-3 py-2 font-semibold">Totaal ({infos.length})</td>
                  <td className="px-2 py-2 text-center">{sum("versions")}</td>
                  <td className="px-2 py-2 text-center">{sum("files")}</td>
                  <td className="px-2 py-2 text-center">{formatBytes(sum("bytes"))}</td>
                  <td className="px-2 py-2 text-center">{sum("approvedExamples")}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-gray-500">
            Daarnaast verdwijnen {sum("marks")} aanduidingen, {sum("llmCalls")} opgeslagen LLM-aanroepen en {sum("otherFeedback")} andere feedbackregels. In het auditlog blijft één regel per document over, zonder inhoud.
          </p>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} className="mt-0.5" />
            <span>
              Goedgekeurde voorbeelden ({sum("approvedExamples")}) bewaren als geanonimiseerde leervoorbeelden (aanbevolen). Uitvinken = ook deze voorbeelden verwijderen.
            </span>
          </label>
          {err && <Banner tone="error">{err}</Banner>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
              Annuleren
            </button>
            <button type="button" className="btn-sm-red" onClick={confirm} disabled={busy}>
              {busy ? "Bezig…" : `Definitief verwijderen (${infos.length})`}
            </button>
          </div>
        </div>
      )}
      {err && !infos && (
        <div className="space-y-3">
          <Banner tone="error">{err}</Banner>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Sluiten
          </button>
        </div>
      )}
    </Modal>
  );
}
