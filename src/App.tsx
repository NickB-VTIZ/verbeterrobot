import { useState, useRef, useCallback, useEffect, useMemo, DragEvent, ChangeEvent } from "react";
import Admin from "./Admin";
import Library from "./Library";
import DocumentDetail from "./DocumentDetail";
import Marking from "./Marking";
import { createApi } from "./api";
import { RobotMascot, ThoughtBubble, WorkflowSteps, PromptBlocks, Mood } from "./RobotMascot";

// ── Types ─────────────────────────────────────────────────────────────
type Step = "login" | "upload" | "processing" | "done" | "error" | "admin" | "library" | "document" | "mark";
type Role = "teacher" | "admin";

interface ProcessingStage {
  id: string;
  label: string;
  done: boolean;
  active: boolean;
}

interface SubjectOption {
  id: string;
  naam: string;
  graad: string;
  onderwerpen: string[];
}

const ACCEPTED = ".docx,.pdf,.pptx,.xlsx,.xls,.txt";

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
  const [role, setRole] = useState<Role>("teacher");
  const [token, setToken] = useState("");
  const [userName, setUserName] = useState("");
  const [docId, setDocId] = useState("");
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("theme");
      if (saved) return saved === "dark";
    } catch {
      /* geen localStorage */
    }
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  });
  const api = useMemo(() => createApi(token, sessionExpired), [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      /* negeren */
    }
  }, [dark]);
  const [maxMb, setMaxMb] = useState(20);
  const [version, setVersion] = useState("");
  const [password, setPassword] = useState("");
  const [personal, setPersonal] = useState<boolean>(() => {
    try {
      return localStorage.getItem("loginMode") === "personal";
    } catch {
      return false;
    }
  });
  const [loginUser, setLoginUser] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [context, setContext] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [fileError, setFileError] = useState("");

  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [topics, setTopics] = useState<string[]>([]);

  const [stages, setStages] = useState<ProcessingStage[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [reviewItems, setReviewItems] = useState<{ qid: string; reden: string }[]>([]);
  const [clarifications, setClarifications] = useState<string[]>([]);
  const [visualStatus, setVisualStatus] = useState("");
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Maximale bestandsgrootte komt uit het beheer
  useEffect(() => {
    fetch("/api/config")
      .then(r => r.json())
      .then(d => {
        if (typeof d.maxFileMb === "number") setMaxMb(d.maxFileMb);
        if (typeof d.version === "string") setVersion(d.version);
      })
      .catch(() => {});
  }, [step]);

  // Vakken (voor gerichte verbetering) laden zodra een sessie bestaat
  useEffect(() => {
    if (!token || step !== "upload") return;
    fetch("/api/subjects", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { subjects: [] }))
      .then(d => setSubjects(Array.isArray(d) ? d : Array.isArray(d.subjects) ? d.subjects : []))
      .catch(() => {});
  }, [token, step]);

  const selectedSubject = subjects.find(s => s.id === subjectId);

  function toggleTopic(t: string) {
    setTopics(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]));
  }

  // ── Aanmelden ───────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          personal ? { username: loginUser.trim(), password } : { role, name: userName.trim(), password }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setToken(data.token);
        setPassword("");
        setUserName(data.name || userName.trim());
        setStep(data.role === "admin" ? "admin" : "library");
      } else {
        setAuthError(data.error || "Ongeldig wachtwoord.");
      }
    } catch {
      setAuthError("Kon de server niet bereiken.");
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    if (token) {
      fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    setToken("");
    setPassword("");
    setDocId("");
    handleReset();
    setStep("login");
  }

  function openDocument(id: string, view: "detail" | "mark" = "detail") {
    setDocId(id);
    setStep(view === "mark" ? "mark" : "document");
  }

  function sessionExpired() {
    setToken("");
    setAuthError("Sessie verlopen. Meld opnieuw aan.");
    setStep("login");
  }

  // ── Bestand selecteren ─────────────────────────────────────────────
  function validateFile(f: File): string {
    const allowed = ["docx", "pdf", "pptx", "xlsx", "xls", "txt"];
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowed.includes(ext)) {
      return `Bestandstype .${ext} is niet toegelaten. Gebruik: ${allowed.map(e => `.${e}`).join(", ")}`;
    }
    if (f.size > maxMb * 1024 * 1024) {
      return `Bestand is te groot (max ${maxMb} MB).`;
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
  async function handleImprove(extra = "") {
    if (!file) return;

    // Verduidelijking van de leerkracht wordt aan de context toegevoegd (en onthouden voor een volgende ronde)
    const fullContext = [context.trim(), extra.trim() && `Verduidelijking van de leerkracht: ${extra.trim()}`]
      .filter(Boolean)
      .join("\n\n");
    if (extra.trim()) setContext(fullContext);
    setClarifyAnswer("");
    setReviewItems([]);
    setClarifications([]);
    setVisualStatus("");

    setStages([
      { id: "upload",   label: "Bestand uploaden",         done: false, active: true  },
      { id: "parse",    label: "Document analyseren",       done: false, active: false },
      { id: "ai",       label: "AI genereert antwoorden",   done: false, active: false },
      { id: "inject",   label: "Verbetersleutel injecteren",done: false, active: false },
      { id: "visual",   label: "Visuele controle (LibreOffice)", done: false, active: false },
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
      if (fullContext) form.append("context", fullContext);
      if (subjectId) {
        form.append("subjectId", subjectId);
        if (topics.length) form.append("topics", JSON.stringify(topics));
      }

      advanceStage("upload", "parse");

      const res = await fetch("/api/improve", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      advanceStage("parse", "ai");

      if (res.status === 401) {
        sessionExpired();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Serverfout (${res.status})`);
      }

      advanceStage("ai", "inject");

      // Nakijklijst en verduidelijkingsvragen uit de headers
      const readJsonHeader = <T,>(name: string): T | null => {
        const raw = res.headers.get(name);
        if (!raw) return null;
        try {
          return JSON.parse(decodeURIComponent(raw)) as T;
        } catch {
          return null;
        }
      };
      setReviewItems(readJsonHeader<{ qid: string; reden: string }[]>("X-Nakijken") ?? []);
      setClarifications(readJsonHeader<string[]>("X-Verduidelijking") ?? []);
      setVisualStatus(res.headers.get("X-Visuele-Controle") ?? "");

      const blob = await res.blob();

      advanceStage("inject", "visual");
      advanceStage("visual", "ready");

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
    setSubjectId("");
    setTopics([]);
    setFileError("");
    setDownloadUrl("");
    setDownloadName("");
    setStages([]);
    setErrorMsg("");
    setReviewItems([]);
    setClarifications([]);
    setVisualStatus("");
    setClarifyAnswer("");
    setStep(!token ? "login" : role === "admin" ? "admin" : "library");
  }

  // ── Robot: stemming, denkballon en workflow ─────────────────────────
  const activeStageId = stages.find(s => s.active)?.id;
  const mood: Mood =
    step === "processing" ? "thinking" : step === "done" ? "happy" : step === "error" ? "sad" : "idle";

  let bubbleMessages: string[];
  if (step === "login") {
    bubbleMessages = ["Hoi! Ik ben de Verbeterrobot 🤖", "Meld je aan en ik help je met verbeteren."];
  } else if (step === "admin") {
    bubbleMessages = [
      "Welkom in het beheer! Hier leer je me hoe ik moet verbeteren.",
      "Maak vakken aan met onderwerpen en voorbeelden — dan verbeter ik gerichter.",
    ];
  } else if (step === "upload") {
    if (!file) {
      bubbleMessages = [
        "Geef me een toets of taak, dan maak ik de verbetersleutel.",
        "Ik begrijp .docx, .pdf, .pptx, .xlsx en .txt.",
      ];
    } else if (subjects.length > 0 && !selectedSubject) {
      bubbleMessages = ["Mooi bestand! Kies eventueel een vak, dan verbeter ik gerichter."];
    } else if (selectedSubject && selectedSubject.onderwerpen.length > 0 && topics.length === 0) {
      bubbleMessages = [`${selectedSubject.naam}, top! Duid aan welke onderwerpen aan bod komen.`];
    } else {
      bubbleMessages = ["Ik ben er klaar voor — druk maar op de knop! 🚀"];
    }
  } else if (step === "processing") {
    const vak = selectedSubject ? ` over ${selectedSubject.naam}` : "";
    if (activeStageId === "upload") bubbleMessages = ["Ik pak je bestand uit…"];
    else if (activeStageId === "parse") bubbleMessages = ["Ik lees alle vragen één voor één…", "Welke vragen staan hier allemaal in?"];
    else if (activeStageId === "ai") {
      bubbleMessages = [
        "Hmm, even nadenken…",
        selectedSubject ? `Ik zoek in wat ik weet${vak}…` : "Ik los elke vraag zorgvuldig op…",
        "Ik reken alles twee keer na 🧮",
        "Tussenstappen netjes noteren…",
      ];
    } else if (activeStageId === "inject") bubbleMessages = ["Ik pak mijn rode stift 🖍️", "Antwoorden bij de juiste vragen zetten…"];
    else if (activeStageId === "visual") bubbleMessages = ["Ik laat LibreOffice meekijken…", "Staat de opmaak nog goed?"];
    else bubbleMessages = ["Bijna klaar…"];
  } else if (step === "done") {
    bubbleMessages = ["Klaar! Je verbetersleutel staat klaar 🎉", "Controleer de rode antwoorden altijd even zelf."];
  } else {
    bubbleMessages = ["Oeps… er ging iets mis. Probeer het gerust opnieuw."];
  }

  // 1 = upload, 2 = vak & onderwerp, 3 = AI denkt, 4 = rode sleutel, 5 = klaar
  const workflowActive =
    step === "upload"
      ? file ? 2 : 1
      : step === "processing"
      ? activeStageId === "inject" || activeStageId === "visual" || activeStageId === "ready" ? 4 : 3
      : step === "done"
      ? 5
      : step === "error"
      ? 3
      : 0;

  // ── Render ─────────────────────────────────────────────────────────
  const wide = step === "library" || step === "document" || step === "mark";

  const themeToggle = (
    <button
      type="button"
      onClick={() => setDark(d => !d)}
      className="fixed top-3 right-3 z-40 w-11 h-11 rounded-full bg-white/90 border border-gray-200 shadow text-lg flex items-center justify-center hover:bg-gray-50"
      aria-label={dark ? "Lichte weergave" : "Donkere weergave"}
      title={dark ? "Lichte weergave" : "Donkere weergave"}
    >
      {dark ? "☀️" : "🌙"}
    </button>
  );

  if (wide) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-red-50">
        {themeToggle}
        <header className="max-w-6xl mx-auto px-4 pt-4 pb-2 flex flex-wrap items-center gap-3 pr-16">
          <button
            type="button"
            className="flex items-center gap-2 text-xl font-bold text-gray-900"
            onClick={() => setStep("library")}
          >
            <RobotMascot mood="idle" className="w-8 h-9" />
            Verbeterrobot
            {version && (
              <span className="text-xs font-semibold text-red-700 bg-red-50 rounded-full px-2 py-0.5">v{version}</span>
            )}
          </button>
          <span className="ml-auto text-sm text-gray-500">{userName}</span>
          {role === "admin" && (
            <button type="button" onClick={() => setStep("admin")} className="btn-sm">
              Beheer
            </button>
          )}
          <button type="button" onClick={handleLogout} className="btn-sm">
            Afmelden
          </button>
        </header>
        <main className="max-w-6xl mx-auto px-4 pb-10 pt-2">
          {step === "library" && (
            <Library
              api={api}
              role={role}
              userName={userName}
              maxMb={maxMb}
              onOpen={(id, view) => openDocument(id, view === "mark" ? "mark" : "detail")}
              onQuickTool={() => setStep("upload")}
            />
          )}
          {step === "document" && docId && (
            <DocumentDetail
              key={docId}
              api={api}
              role={role}
              userName={userName}
              id={docId}
              onBack={() => setStep("library")}
              onMark={id => openDocument(id, "mark")}
              onOpen={id => openDocument(id, "detail")}
            />
          )}
          {step === "mark" && docId && (
            <Marking
              key={docId}
              api={api}
              id={docId}
              onBack={() => setStep("document")}
              onDone={id => openDocument(id, "detail")}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-br from-gray-50 to-red-50">
      {themeToggle}
      {/* Header: robot met denkballon */}
      <div className={`mb-6 w-full ${step === "admin" ? "max-w-2xl" : "max-w-lg"}`}>
        <h1 className="text-3xl font-bold text-gray-900 text-center">
          Verbeterrobot
          {version && (
            <span className="ml-2 align-middle text-xs font-semibold text-red-700 bg-red-50 rounded-full px-2 py-0.5">
              v{version}
            </span>
          )}
        </h1>
        <p className="text-gray-500 mt-1 text-center text-sm">Upload een taak of toets — de AI maakt de verbetersleutel</p>
        <div className="flex items-center gap-6 mt-5 pl-4">
          <RobotMascot mood={mood} className="w-24 h-28 shrink-0" />
          <ThoughtBubble messages={bubbleMessages} thinking={step === "processing"} />
        </div>
        {workflowActive > 0 && (
          <div className="mt-5 px-1">
            <WorkflowSteps active={workflowActive} />
          </div>
        )}
      </div>

      <div className={`w-full ${step === "admin" ? "max-w-2xl" : "max-w-lg"} bg-white rounded-2xl shadow-lg p-8`}>

        {/* ── Stap 1: Aanmelden ── */}
        {step === "login" && (
          <form onSubmit={handleLogin} noValidate className="space-y-5">
            {!personal && (<>
            <div className="grid grid-cols-2 gap-1 bg-gray-100 rounded-lg p-1">
              {(["teacher", "admin"] as Role[]).map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setRole(r); setAuthError(""); }}
                  className={`rounded-md py-2 text-sm font-semibold transition-colors ${
                    role === r ? "bg-white text-red-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {r === "teacher" ? "Leerkracht" : "Beheer"}
                </button>
              ))}
            </div>
            {role === "teacher" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Jouw naam</label>
                <input
                  type="text"
                  value={userName}
                  onChange={e => setUserName(e.target.value)}
                  placeholder="Voornaam Naam (je documenten staan onder deze naam)"
                  autoComplete="name"
                  autoFocus
                  required
                  minLength={2}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Wachtwoord
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={role === "admin" ? "Voer het beheerderswachtwoord in" : "Voer het leerkrachtenwachtwoord in"}
                autoFocus={role === "admin"}
                required
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
            </>)}
            {personal && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Gebruikersnaam</label>
                  <input
                    type="text"
                    value={loginUser}
                    onChange={e => setLoginUser(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Wachtwoord</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>
              </>
            )}
            {authError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2">{authError}</p>
            )}
            <button
              type="submit"
              disabled={
                authLoading ||
                !password ||
                (personal ? !loginUser.trim() : role === "teacher" && userName.trim().length < 2)
              }
              className="btn-primary w-full justify-center"
            >
              {authLoading ? <SpinnerIcon className="w-4 h-4" /> : null}
              {authLoading ? "Aanmelden…" : "Aanmelden"}
            </button>
            <button
              type="button"
              onClick={() => {
                const next = !personal;
                setPersonal(next);
                setAuthError("");
                try {
                  localStorage.setItem("loginMode", next ? "personal" : "shared");
                } catch {
                  /* negeren */
                }
              }}
              className="block mx-auto text-xs text-gray-500 underline cursor-pointer"
            >
              {personal ? "Aanmelden met het gedeelde wachtwoord" : "Aanmelden met een persoonlijk account"}
            </button>
          </form>
        )}

        {/* ── Beheer ── */}
        {step === "admin" && (
          <Admin
            token={token}
            version={version}
            onUnauthorized={sessionExpired}
            onUseTool={() => setStep("library")}
            onLogout={handleLogout}
          />
        )}

        {/* ── Stap 2: Upload ── */}
        {step === "upload" && (
          <div className="space-y-5">
            <div className="flex justify-end gap-2 -mt-2">
              <button type="button" onClick={() => setStep("library")} className="text-xs text-red-600 hover:underline mr-auto">
                ← Bibliotheek
              </button>
              {role === "admin" && (
                <button type="button" onClick={() => setStep("admin")} className="text-xs text-red-600 hover:underline">
                  ← Naar beheer
                </button>
              )}
              <button type="button" onClick={handleLogout} className="text-xs text-gray-400 hover:text-gray-600 hover:underline">
                Afmelden
              </button>
            </div>
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
                .docx · .pdf · .pptx · .xlsx · .txt — max {maxMb} MB
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

            {/* Vak & onderwerpen */}
            {subjects.length > 0 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Vak <span className="text-gray-400 font-normal">(optioneel, voor gerichte verbetering)</span>
                  </label>
                  <select
                    value={subjectId}
                    onChange={e => { setSubjectId(e.target.value); setTopics([]); }}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent bg-white"
                  >
                    <option value="">Algemeen (geen vak)</option>
                    {subjects.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.naam}{s.graad ? ` (${s.graad})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedSubject && selectedSubject.onderwerpen.length > 0 && (
                  <div>
                    <p className="block text-sm font-medium text-gray-700 mb-1.5">
                      Onderwerpen <span className="text-gray-400 font-normal">(kies wat in dit document aan bod komt)</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {selectedSubject.onderwerpen.map(t => {
                        const on = topics.includes(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => toggleTopic(t)}
                            className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                              on
                                ? "bg-red-600 text-white border-red-600"
                                : "bg-white text-gray-600 border-gray-300 hover:border-red-400"
                            }`}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
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

            <PromptBlocks
              parts={{
                hasFile: !!file,
                subject: selectedSubject?.naam,
                topicCount: topics.length,
                hasContext: context.trim().length > 0,
              }}
            />

            <button
              onClick={() => handleImprove()}
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

            {visualStatus === "ok" && (
              <p className="text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">
                ✓ Visuele controle: de opmaak van het resultaat ziet er goed uit.
              </p>
            )}

            {reviewItems.length > 0 && (
              <div className="text-left rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-sm font-semibold text-amber-800 mb-1">Kijk deze onderdelen zelf even na</p>
                <ul className="list-disc pl-5 space-y-1 text-xs text-amber-900">
                  {reviewItems.map((r, i) => (
                    <li key={i}>
                      <strong>{r.qid === "layout" ? "Opmaak" : `Vraag ${r.qid}`}:</strong> {r.reden}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {clarifications.length > 0 && (
              <div className="text-left rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 space-y-2">
                <p className="text-sm font-semibold text-blue-900">De robot twijfelt en heeft je hulp nodig</p>
                <ul className="list-disc pl-5 space-y-1 text-xs text-blue-900">
                  {clarifications.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
                <textarea
                  className="w-full rounded-lg border border-blue-200 px-3 py-2 text-sm"
                  rows={3}
                  value={clarifyAnswer}
                  onChange={e => setClarifyAnswer(e.target.value)}
                  placeholder="Typ hier je antwoord of extra uitleg (bv. 'antwoorden onder de vraag zetten, niet in de tabel')"
                />
                <button
                  type="button"
                  className="btn-secondary w-full justify-center"
                  disabled={!clarifyAnswer.trim()}
                  onClick={() => handleImprove(clarifyAnswer)}
                >
                  Opnieuw proberen met deze verduidelijking
                </button>
              </div>
            )}

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
        VTI Zandhoven · Verbeterrobot{version ? ` v${version}` : ""} · Bestanden worden direct na verwerking verwijderd van de server.
      </p>
    </div>
  );
}
