import { useState, useRef, useCallback, DragEvent, ChangeEvent } from "react";

// ── Types ─────────────────────────────────────────────────────────────
type Step = "login" | "upload" | "processing" | "done" | "error";

interface ProcessingStage {
  id: string;
  label: string;
  done: boolean;
  active: boolean;
}

const ACCEPTED = ".docx,.pdf,.pptx,.xlsx,.xls,.txt";
const MAX_MB = 20;

// ── SVG-icoontjes (inline, geen extra dep) ────────────────────────────
function RobotIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="16" y="22" width="32" height="24" rx="6" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2.5"/>
      <circle cx="24" cy="34" r="4" fill="currentColor"/>
      <circle cx="40" cy="34" r="4" fill="currentColor"/>
      <rect x="26" y="43" width="12" height="3" rx="1.5" fill="currentColor"/>
      <rect x="29" y="14" width="6" height="8" rx="3" fill="currentColor"/>
      <circle cx="32" cy="12" r="3" fill="currentColor"/>
      <rect x="10" y="28" width="6" height="3" rx="1.5" fill="currentColor"/>
      <rect x="48" y="28" width="6" height="3" rx="1.5" fill="currentColor"/>
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
    </svg>
  );
}

function SpinnerIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>
  );
}

function UploadIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
    </svg>
  );
}

function DownloadIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
    </svg>
  );
}

// ── Hulpfuncties ───────────────────────────────────────────────────────
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  const icons: Record<string, string> = {
    docx: "📄", pdf: "📕", pptx: "📊", xlsx: "📗", xls: "📗", txt: "📝",
  };
  return icons[ext ?? ""] ?? "📁";
}

// ── Hoofd App ─────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState<Step>("login");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [context, setContext] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [fileError, setFileError] = useState("");

  const [stages, setStages] = useState<ProcessingStage[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef("");
  passwordRef.current = password;

  // ── Aanmelden ───────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setStep("upload");
      } else {
        const data = await res.json().catch(() => ({}));
        setAuthError(data.error || "Ongeldig wachtwoord.");
      }
    } catch {
      setAuthError("Kon de server niet bereiken.");
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Bestand selecteren ─────────────────────────────────────────────
  function validateFile(f: File): string {
    const allowed = ["docx", "pdf", "pptx", "xlsx", "xls", "txt"];
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowed.includes(ext)) {
      return `Bestandstype .${ext} is niet toegelaten. Gebruik: ${allowed.map(e => `.${e}`).join(", ")}`;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      return `Bestand is te groot (max ${MAX_MB} MB).`;
    }
    return "";
  }

  function handleFileChange(f: File) {
    const err = validateFile(f);
    if (err) {
      setFileError(err);
      setFile(null);
    } else {
      setFileError("");
      setFile(f);
    }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFileChange(f);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileChange(f);
  }

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback(() => setDragActive(false), []);

  // ── Verbetering starten ────────────────────────────────────────────
  async function handleImprove() {
    if (!file) return;

    setStages([
      { id: "upload",   label: "Bestand uploaden",         done: false, active: true  },
      { id: "parse",    label: "Document analyseren",       done: false, active: false },
      { id: "ai",       label: "AI genereert antwoorden",   done: false, active: false },
      { id: "inject",   label: "Verbetersleutel injecteren",done: false, active: false },
      { id: "ready",    label: "Klaar voor download",       done: false, active: false },
    ]);
    setStep("processing");
    setErrorMsg("");

    const advanceStage = (doneId: string, nextId?: string) => {
      setStages(prev =>
        prev.map(s => ({
          ...s,
          done:   s.done || s.id === doneId,
          active: nextId ? s.id === nextId : false,
        }))
      );
    };

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("password", passwordRef.current);
      if (context.trim()) form.append("context", context.trim());

      advanceStage("upload", "parse");

      const res = await fetch("/api/improve", { method: "POST", body: form });

      advanceStage("parse", "ai");

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Serverfout (${res.status})`);
      }

      advanceStage("ai", "inject");

      const blob = await res.blob();

      advanceStage("inject", "ready");

      const url = URL.createObjectURL(blob);
      const ext = file.name.split(".").pop() ?? "docx";
      const name = `verbetersleutel_${file.name}`;

      setDownloadUrl(url);
      setDownloadName(name);

      advanceStage("ready");
      setStep("done");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Onbekende fout";
      setErrorMsg(msg);
      setStep("error");
    }
  }

  function handleReset() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setFile(null);
    setContext("");
    setFileError("");
    setDownloadUrl("");
    setDownloadName("");
    setStages([]);
    setErrorMsg("");
    setStep("upload");
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-br from-gray-50 to-red-50">
      {/* Header */}
      <div className="mb-8 text-center">
        <RobotIcon className="w-16 h-16 text-red-600 mx-auto mb-3" />
        <h1 className="text-3xl font-bold text-gray-900">Verbeterrobot</h1>
        <p className="text-gray-500 mt-1">Upload een taak of toets — de AI maakt de verbetersleutel</p>
      </div>

      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg p-8">

        {/* ── Stap 1: Aanmelden ── */}
        {step === "login" && (
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Wachtwoord
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Voer het leerkrachtenwachtwoord in"
                autoFocus
                required
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
            {authError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2">{authError}</p>
            )}
            <button type="submit" disabled={authLoading || !password} className="btn-primary w-full justify-center">
              {authLoading ? <SpinnerIcon className="w-4 h-4" /> : null}
              {authLoading ? "Aanmelden…" : "Aanmelden"}
            </button>
          </form>
        )}

        {/* ── Stap 2: Upload ── */}
        {step === "upload" && (
          <div className="space-y-5">
            {/* Drop zone */}
            <div
              className={`drop-zone ${dragActive ? "active" : "hover:border-red-400 hover:bg-red-50/50"}`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={onInputChange}
              />
              <UploadIcon className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-600">
                Sleep een bestand hier of <span className="text-red-600 font-semibold">kies een bestand</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">
                .docx · .pdf · .pptx · .xlsx · .txt — max {MAX_MB} MB
              </p>
            </div>

            {fileError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2">{fileError}</p>
            )}

            {/* Geselecteerd bestand */}
            {file && (
              <div className="flex items-center gap-3 bg-gray-50 rounded-xl px-4 py-3 border border-gray-200">
                <span className="text-2xl">{getFileIcon(file.name)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
                  <p className="text-xs text-gray-400">{formatBytes(file.size)}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setFile(null); }}
                  className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none"
                  title="Verwijder bestand"
                >×</button>
              </div>
            )}

            {/* Extra context */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Extra instructies voor de AI <span className="text-gray-400 font-normal">(optioneel)</span>
              </label>
              <textarea
                value={context}
                onChange={e => setContext(e.target.value)}
                placeholder="Bv. 'Dit is een toets voor 5MECH. Beoordeel streng.' of 'De taal is Frans.'"
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
              />
            </div>

            <button
              onClick={handleImprove}
              disabled={!file}
              className="btn-primary w-full justify-center"
            >
              <RobotIcon className="w-5 h-5" />
              Verbetersleutel genereren
            </button>
          </div>
        )}

        {/* ── Stap 3: Verwerking ── */}
        {step === "processing" && (
          <div className="space-y-6">
            <div className="text-center">
              <SpinnerIcon className="w-10 h-10 text-red-600 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-600">Even geduld…</p>
            </div>
            <ol className="space-y-3">
              {stages.map(s => (
                <li key={s.id} className="flex items-center gap-3">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold transition-colors ${
                    s.done   ? "bg-green-500 text-white" :
                    s.active ? "bg-red-600 text-white" :
                    "bg-gray-200 text-gray-400"
                  }`}>
                    {s.done ? <CheckIcon className="w-3.5 h-3.5" /> : s.active ? <SpinnerIcon className="w-3 h-3" /> : ""}
                  </span>
                  <span className={`text-sm ${s.active ? "text-gray-900 font-semibold" : s.done ? "text-gray-400 line-through" : "text-gray-400"}`}>
                    {s.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── Stap 4: Klaar ── */}
        {step === "done" && (
          <div className="space-y-6 text-center">
            <div>
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <CheckIcon className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-xl font-bold text-gray-900">Verbetersleutel klaar!</h2>
              <p className="text-sm text-gray-500 mt-1">
                De antwoorden staan in het rood bij de vragen in het originele document.
              </p>
            </div>

            <a
              href={downloadUrl}
              download={downloadName}
              className="btn-primary w-full justify-center"
            >
              <DownloadIcon className="w-5 h-5" />
              {downloadName}
            </a>

            <button onClick={handleReset} className="btn-secondary w-full justify-center">
              Nog een document verbeteren
            </button>
          </div>
        )}

        {/* ── Foutmelding ── */}
        {step === "error" && (
          <div className="space-y-5">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                <span className="text-3xl">⚠️</span>
              </div>
              <h2 className="text-xl font-bold text-gray-900">Er ging iets mis</h2>
              <p className="text-sm text-red-700 mt-2 bg-red-50 rounded-lg px-4 py-3">{errorMsg}</p>
            </div>
            <button onClick={handleReset} className="btn-primary w-full justify-center">
              Opnieuw proberen
            </button>
          </div>
        )}
      </div>

      <p className="mt-6 text-xs text-gray-400">
        VTI Zandhoven · Verbeterrobot v1.0 · Bestanden worden direct na verwerking verwijderd van de server.
      </p>
    </div>
  );
}
