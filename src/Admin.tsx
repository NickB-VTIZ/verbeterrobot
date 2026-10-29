import { useCallback, useEffect, useState } from "react";
import SubjectsAdmin from "./SubjectsAdmin";
import TrainingAdmin from "./TrainingAdmin";

interface PublicSettings {
  omnirouteBaseUrl: string;
  omnirouteModel: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  temperature: number;
  visualCheckEnabled: boolean;
  visionModel: string;
  maxFileMb: number;
  systemPrompt: string;
  defaultSystemPrompt: string;
  teacherPasswordSource: "beheer" | "env";
  memoryEnabled: boolean;
  memoryUrl: string;
  hasMemorySecret: boolean;
  memorySecretHint: string;
  memoryProject: string;
}

interface TestResult {
  ok: boolean;
  at?: string;
  ms?: number;
  error?: string;
  // Omniroute
  modelCount?: number;
  modelFound?: boolean | null;
  model?: string;
  chatMs?: number;
  // agentmemory
  lessons?: number;
}

interface Status {
  version: string;
  uptimeSeconds: number;
  node: string;
  omniroute: { baseUrl: string; model: string; configured: boolean; last: TestResult | null };
  memory: {
    enabled: boolean;
    configured: boolean;
    url: string;
    project: string;
    last: TestResult | null;
  };
  visual?: {
    enabled: boolean;
    visionModel: string;
    libreoffice: string | null;
    libreofficeVersion: string;
    poppler: boolean;
    available: boolean;
  };
  counts: { subjects: number; lessons: number };
  teacherPasswordSource: "beheer" | "env";
  teacherConfigured: boolean;
  maxFileMb: number;
}

type Tab = "status" | "verbindingen" | "instellingen" | "vakken" | "training";

const TABS: { id: Tab; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "verbindingen", label: "Verbindingen" },
  { id: "instellingen", label: "Instellingen" },
  { id: "vakken", label: "Vakken" },
  { id: "training", label: "Training" },
];

interface Props {
  token: string;
  version: string;
  onUnauthorized: () => void;
  onUseTool: () => void;
  onLogout: () => void;
}

const inputCls =
  "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent";
const labelCls = "block text-sm font-medium text-gray-700 mb-1.5";
const hintCls = "text-xs text-gray-400 mt-1";
const legendCls = "text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2";

function formatUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} u`;
  if (h > 0) return `${h} u ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

function formatAt(iso?: string) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("nl-BE", { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return iso;
  }
}

type Tone = "ok" | "err" | "warn" | "off";

function Dot({ tone }: { tone: Tone }) {
  const color =
    tone === "ok" ? "bg-green-500" : tone === "err" ? "bg-red-500" : tone === "warn" ? "bg-amber-400" : "bg-gray-300";
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} aria-hidden="true" />;
}

function describeOmniroute(r: TestResult): string {
  if (!r.ok) return r.error || "Mislukt.";
  const parts = [`bereikbaar in ${r.ms} ms`];
  if (r.modelCount) parts.push(`${r.modelCount} modellen`);
  if (r.modelFound === true) parts.push(`model "${r.model}" gevonden`);
  if (r.modelFound === false) parts.push(`⚠ model "${r.model}" staat niet in de lijst`);
  if (r.chatMs !== undefined) parts.push(`chat-test OK in ${r.chatMs} ms`);
  return parts.join(" · ");
}

function describeMemory(r: TestResult): string {
  if (!r.ok) return r.error || "Mislukt.";
  const parts = [`bereikbaar in ${r.ms} ms`, "geheim aanvaard"];
  if (typeof r.lessons === "number") parts.push(`${r.lessons} lessen van dit project`);
  return parts.join(" · ");
}

function ResultLine({ r, kind }: { r: TestResult | null; kind: "omniroute" | "memory" }) {
  if (!r) return <p className="text-xs text-gray-400">Nog niet getest sinds de server startte.</p>;
  const text = kind === "omniroute" ? describeOmniroute(r) : describeMemory(r);
  const warn = r.ok && r.modelFound === false;
  return (
    <p className={`text-xs ${r.ok ? (warn ? "text-amber-600" : "text-green-700") : "text-red-600"}`}>
      <Dot tone={r.ok ? (warn ? "warn" : "ok") : "err"} /> {text}
      {r.at && <span className="text-gray-400"> — {formatAt(r.at)}</span>}
    </p>
  );
}

export default function Admin({ token, version, onUnauthorized, onUseTool, onLogout }: Props) {
  const [tab, setTab] = useState<Tab>("status");
  const [loaded, setLoaded] = useState<PublicSettings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  // Omniroute
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [visualEnabled, setVisualEnabled] = useState(true);
  const [visionModel, setVisionModel] = useState("");
  // Agentmemory
  const [memEnabled, setMemEnabled] = useState(false);
  const [memUrl, setMemUrl] = useState("");
  const [memSecret, setMemSecret] = useState("");
  const [memProject, setMemProject] = useState("verbeterrobot");
  // Algemeen
  const [maxFileMb, setMaxFileMb] = useState("20");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [teacherPw, setTeacherPw] = useState("");
  const [teacherPw2, setTeacherPw2] = useState("");

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  // Resultaat van een test die net in dit scherm is uitgevoerd
  const [omniResult, setOmniResult] = useState<TestResult | null>(null);
  const [memResult, setMemResult] = useState<TestResult | null>(null);

  const auth = { Authorization: `Bearer ${token}` };
  const json = { ...auth, "Content-Type": "application/json" };

  const call = useCallback(
    async (url: string, init: RequestInit = {}) => {
      const res = await fetch(url, init);
      if (res.status === 401 || res.status === 403) {
        onUnauthorized();
        throw new Error("Sessie verlopen.");
      }
      const data = await res.json().catch(() => ({}));
      return { res, data };
    },
    [onUnauthorized]
  );

  function apply(s: PublicSettings) {
    setLoaded(s);
    setBaseUrl(s.omnirouteBaseUrl);
    setModel(s.omnirouteModel);
    setTemperature(String(s.temperature));
    setVisualEnabled(s.visualCheckEnabled !== false);
    setVisionModel(s.visionModel || "");
    setMaxFileMb(String(s.maxFileMb));
    setSystemPrompt(s.systemPrompt);
    setMemEnabled(s.memoryEnabled);
    setMemUrl(s.memoryUrl);
    setMemProject(s.memoryProject);
    setApiKey("");
    setMemSecret("");
    setTeacherPw("");
    setTeacherPw2("");
  }

  const loadStatus = useCallback(async () => {
    const { res, data } = await call("/api/admin/status", { headers: auth });
    if (res.ok) setStatus(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, token]);

  useEffect(() => {
    (async () => {
      const { res, data } = await call("/api/admin/settings", { headers: auth });
      if (!res.ok) {
        setMsg({ type: "err", text: "Instellingen laden mislukt." });
        return;
      }
      apply(data);
      await loadStatus();
    })().catch(() => setMsg({ type: "err", text: "Kon de server niet bereiken." }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Slaat alle velden op. Geeft true terug bij succes. */
  async function save(extra: Record<string, unknown> = {}, okText: string | null = "Instellingen opgeslagen.") {
    setMsg(null);
    if (teacherPw && teacherPw !== teacherPw2) {
      setMsg({ type: "err", text: "De twee leerkrachtenwachtwoorden komen niet overeen." });
      return false;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        omnirouteBaseUrl: baseUrl,
        omnirouteModel: model,
        temperature: Number(temperature),
        visualCheckEnabled: visualEnabled,
        visionModel,
        maxFileMb: Number(maxFileMb),
        systemPrompt,
        memoryEnabled: memEnabled,
        memoryUrl: memUrl,
        memoryProject: memProject,
        ...extra,
      };
      if (apiKey.trim()) body.omnirouteApiKey = apiKey.trim();
      if (memSecret.trim()) body.memorySecret = memSecret.trim();
      if (teacherPw) body.teacherPassword = teacherPw;

      const { res, data } = await call("/api/admin/settings", {
        method: "PUT",
        headers: json,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(data.error || `Serverfout (${res.status})`);
      apply(data);
      if (okText) setMsg({ type: "ok", text: okText });
      loadStatus().catch(() => undefined);
      return true;
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "Opslaan mislukt." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runTest(kind: "omniroute" | "omniroute-deep" | "memory", saveFirst: boolean) {
    setMsg(null);
    if (saveFirst && !(await save({}, null))) return;
    setTesting(kind);
    const isOmni = kind !== "memory";
    try {
      const { data } = await call(isOmni ? "/api/admin/test" : "/api/admin/memory/test", {
        method: "POST",
        headers: json,
        body: JSON.stringify(isOmni ? { deep: kind === "omniroute-deep" } : {}),
      });
      const r: TestResult = data && typeof data.ok === "boolean" ? data : { ok: false, error: data?.error || "Test mislukt." };
      if (!r.at) r.at = new Date().toISOString();
      (isOmni ? setOmniResult : setMemResult)(r);
    } catch (err) {
      const r: TestResult = { ok: false, error: err instanceof Error ? err.message : "Test mislukt.", at: new Date().toISOString() };
      (isOmni ? setOmniResult : setMemResult)(r);
    } finally {
      setTesting(null);
      loadStatus().catch(() => undefined);
    }
  }

  async function testAll() {
    await runTest("omniroute", false);
    if (status?.memory.configured) await runTest("memory", false);
  }

  if (!loaded) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-500 text-center">Instellingen laden…</p>
        {msg && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2">{msg.text}</p>}
        <button onClick={onLogout} className="btn-secondary w-full justify-center">Afmelden</button>
      </div>
    );
  }

  const messageBox = msg && (
    <p
      className={`text-sm rounded-lg px-4 py-2 ${
        msg.type === "ok" ? "text-green-700 bg-green-50" : "text-red-600 bg-red-50"
      }`}
    >
      {msg.text}
    </p>
  );

  // Laatste resultaat: dat van dit scherm indien nieuwer, anders dat van de server
  const omniLast = omniResult ?? status?.omniroute.last ?? null;
  const memLast = memResult ?? status?.memory.last ?? null;

  const omniTone: Tone = !status?.omniroute.configured
    ? "off"
    : omniLast
    ? omniLast.ok
      ? omniLast.modelFound === false
        ? "warn"
        : "ok"
      : "err"
    : "warn";
  const memTone: Tone = !status?.memory.enabled
    ? "off"
    : !status.memory.configured
    ? "warn"
    : memLast
    ? memLast.ok
      ? "ok"
      : "err"
    : "warn";

  return (
    <div className="space-y-6">
      {/* Titel + versie */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold text-gray-900">
          Beheer{" "}
          <span className="align-middle text-xs font-semibold text-red-700 bg-red-50 rounded-full px-2 py-0.5">
            v{version || status?.version || "?"}
          </span>
        </h2>
        <div className="flex gap-2">
          <button type="button" onClick={onUseTool} className="btn-secondary !px-3 !py-1.5">
            Document verbeteren
          </button>
          <button type="button" onClick={onLogout} className="btn-secondary !px-3 !py-1.5">
            Afmelden
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setMsg(null);
              if (t.id === "status") loadStatus().catch(() => undefined);
            }}
            className={`px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-red-600 text-red-700"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
            {t.id === "verbindingen" && (omniTone === "err" || memTone === "err") && (
              <span className="ml-1.5"><Dot tone="err" /></span>
            )}
          </button>
        ))}
      </div>

      {/* ── Status ─────────────────────────────────────────────── */}
      {tab === "status" && (
        <div className="space-y-5">
          {!status ? (
            <p className="text-sm text-gray-500">Status laden…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  ["Versie", `v${status.version}`],
                  ["Draait al", formatUptime(status.uptimeSeconds)],
                  ["Vakken", String(status.counts.subjects)],
                  ["Lessen", String(status.counts.lessons)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-gray-200 px-3 py-2">
                    <p className="text-xs text-gray-400">{k}</p>
                    <p className="text-sm font-semibold text-gray-800">{v}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-gray-200 px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-800">
                    <Dot tone={omniTone} /> Omniroute (AI)
                  </p>
                  <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setTab("verbindingen")}>
                    Instellen
                  </button>
                </div>
                <p className="text-xs text-gray-500 break-all">
                  {status.omniroute.configured ? status.omniroute.baseUrl : "Niet volledig ingesteld (URL of sleutel ontbreekt)"} · model {status.omniroute.model}
                </p>
                <ResultLine r={omniLast} kind="omniroute" />
              </div>

              <div className="rounded-lg border border-gray-200 px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-800">
                    <Dot tone={memTone} /> Geheugen (agentmemory)
                  </p>
                  <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setTab("verbindingen")}>
                    Instellen
                  </button>
                </div>
                <p className="text-xs text-gray-500 break-all">
                  {!status.memory.enabled
                    ? "Uitgeschakeld"
                    : !status.memory.configured
                    ? "Aan, maar URL of geheim ontbreekt"
                    : `${status.memory.url} · project ${status.memory.project}`}
                </p>
                {status.memory.enabled && status.memory.configured && <ResultLine r={memLast} kind="memory" />}
              </div>

              {status.visual && (
                <div className="rounded-lg border border-gray-200 px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-800">
                      <Dot tone={!status.visual.enabled ? "off" : status.visual.available ? "ok" : "warn"} /> Visuele controle (LibreOffice)
                    </p>
                    <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setTab("verbindingen")}>
                      Instellen
                    </button>
                  </div>
                  <p className="text-xs text-gray-500">
                    {!status.visual.enabled
                      ? "Uitgeschakeld"
                      : status.visual.available
                      ? `Actief · ${status.visual.libreofficeVersion || "LibreOffice"} + poppler${status.visual.visionModel ? ` · visionmodel ${status.visual.visionModel}` : " · standaardmodel"}`
                      : `Niet beschikbaar: ${!status.visual.libreoffice ? "LibreOffice ontbreekt" : ""}${!status.visual.libreoffice && !status.visual.poppler ? " en " : ""}${!status.visual.poppler ? "poppler (pdftoppm) ontbreekt" : ""}. De controle wordt overgeslagen (in de Docker-image zijn ze aanwezig).`}
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-gray-200 px-4 py-3 text-xs text-gray-600 space-y-1">
                <p>
                  Leerkrachtenwachtwoord:{" "}
                  <strong>
                    {!status.teacherConfigured
                      ? "niet ingesteld"
                      : status.teacherPasswordSource === "beheer"
                      ? "ingesteld in het beheer"
                      : "uit het .env-bestand"}
                  </strong>
                </p>
                <p>Maximale bestandsgrootte: <strong>{status.maxFileMb} MB</strong></p>
                <p className="text-gray-400">Node {status.node}</p>
              </div>

              <div className="flex gap-3">
                <button type="button" className="btn-primary" disabled={!!testing} onClick={testAll}>
                  {testing ? "Testen…" : "Alle verbindingen testen"}
                </button>
                <button type="button" className="btn-secondary" disabled={!!testing} onClick={() => loadStatus()}>
                  Vernieuwen
                </button>
              </div>
            </>
          )}
          {messageBox}
        </div>
      )}

      {/* ── Verbindingen ───────────────────────────────────────── */}
      {tab === "verbindingen" && (
        <form
          className="space-y-8"
          onSubmit={e => {
            e.preventDefault();
            save();
          }}
        >
          <fieldset className="space-y-4">
            <legend className={legendCls}>Omniroute (AI)</legend>
            <div>
              <label className={labelCls}>Base URL</label>
              <input
                className={inputCls}
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://omniroute.example.com/v1"
                required
              />
            </div>
            <div>
              <label className={labelCls}>API-sleutel</label>
              <input
                type="password"
                className={inputCls}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={loaded.hasApiKey ? `Huidige sleutel: ${loaded.apiKeyHint} (leeg laten = ongewijzigd)` : "Nog geen sleutel ingesteld"}
                autoComplete="off"
              />
              {loaded.hasApiKey && (
                <button
                  type="button"
                  className="text-xs text-red-600 hover:underline mt-1"
                  onClick={() => {
                    if (confirm("API-sleutel verwijderen?")) save({ clearApiKey: true }, "API-sleutel verwijderd.");
                  }}
                >
                  Sleutel verwijderen
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Model</label>
                <input className={inputCls} value={model} onChange={e => setModel(e.target.value)} required />
              </div>
              <div>
                <label className={labelCls}>Temperatuur</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  className={inputCls}
                  value={temperature}
                  onChange={e => setTemperature(e.target.value)}
                  required
                />
                <p className={hintCls}>0 = strikt, 2 = creatief</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={busy || !!testing} onClick={() => runTest("omniroute", true)} className="btn-secondary">
                {testing === "omniroute" ? "Testen…" : "Opslaan & testen"}
              </button>
              <button type="button" disabled={busy || !!testing} onClick={() => runTest("omniroute-deep", true)} className="btn-secondary">
                {testing === "omniroute-deep" ? "Chat testen…" : "Diepe test (echte chat)"}
              </button>
            </div>
            <ResultLine r={omniLast} kind="omniroute" />
            <p className={hintCls}>
              De gewone test controleert de modellenlijst; de diepe test stuurt een minuscuul bericht naar het gekozen model.
            </p>
          </fieldset>

          <fieldset className="space-y-4 pt-6 border-t border-gray-100">
            <legend className={legendCls}>Visuele controle (LibreOffice)</legend>
            <p className="text-xs text-gray-500">
              Na het invullen zet LibreOffice het .docx om naar pagina's en kijkt een vision-model of de rode antwoorden
              goed staan en niets afgesneden of overlappend is. Bij twijfel krijg je vragen om verduidelijking.
              Ontbreekt LibreOffice of het model, dan wordt de controle gewoon overgeslagen.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={visualEnabled} onChange={e => setVisualEnabled(e.target.checked)} />
              Visuele controle gebruiken
            </label>
            <div>
              <label className={labelCls}>Vision-model (optioneel)</label>
              <input
                className={inputCls}
                value={visionModel}
                onChange={e => setVisionModel(e.target.value)}
                placeholder="leeg = zelfde model als hierboven"
              />
              <p className={hintCls}>Het gekozen model moet afbeeldingen kunnen lezen (bv. gpt-4o).</p>
            </div>
          </fieldset>

          <fieldset className="space-y-4 pt-6 border-t border-gray-100">
            <legend className={legendCls}>Geheugen (agentmemory)</legend>
            <p className="text-xs text-gray-500">
              Koppel de robot aan dezelfde agentmemory-server als de MCP. Nieuwe lessen worden daar bewaard en bij
              elke verbetering worden de relevante lessen opgehaald. Is de server onbereikbaar, dan werkt de robot gewoon verder.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={memEnabled} onChange={e => setMemEnabled(e.target.checked)} />
              Geheugen gebruiken
            </label>
            <div>
              <label className={labelCls}>Server-URL</label>
              <input
                className={inputCls}
                value={memUrl}
                onChange={e => setMemUrl(e.target.value)}
                placeholder="https://mem.example.com"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Geheim (secret)</label>
                <input
                  type="password"
                  className={inputCls}
                  value={memSecret}
                  onChange={e => setMemSecret(e.target.value)}
                  placeholder={loaded.hasMemorySecret ? loaded.memorySecretHint : "niet ingesteld"}
                  autoComplete="new-password"
                />
                <p className={hintCls}>Leeg laten om het huidige geheim te behouden.</p>
              </div>
              <div>
                <label className={labelCls}>Projectnaam</label>
                <input className={inputCls} value={memProject} onChange={e => setMemProject(e.target.value)} />
                <p className={hintCls}>Scheidt de lessen van andere projecten.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={busy || !!testing} onClick={() => runTest("memory", true)} className="btn-secondary">
                {testing === "memory" ? "Testen…" : "Opslaan & testen"}
              </button>
            </div>
            {(memEnabled || memLast) && <ResultLine r={memLast} kind="memory" />}
            <p className={hintCls}>
              De test controleert bereikbaarheid, of het geheim wordt aanvaard en hoeveel lessen van dit project er zijn.
            </p>
          </fieldset>

          {messageBox}
          <button type="submit" disabled={busy} className="btn-primary w-full justify-center">
            {busy ? "Opslaan…" : "Verbindingen opslaan"}
          </button>
        </form>
      )}

      {/* ── Instellingen ───────────────────────────────────────── */}
      {tab === "instellingen" && (
        <form
          className="space-y-6"
          onSubmit={e => {
            e.preventDefault();
            save();
          }}
        >
          <fieldset className="space-y-4">
            <legend className={legendCls}>Uploads</legend>
            <div>
              <label className={labelCls}>Maximale bestandsgrootte (MB)</label>
              <input
                type="number"
                min="1"
                max="100"
                className={inputCls}
                value={maxFileMb}
                onChange={e => setMaxFileMb(e.target.value)}
                required
              />
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className={legendCls}>Systeemprompt</legend>
            <textarea
              className={`${inputCls} font-mono text-xs`}
              rows={12}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              required
            />
            <p className={hintCls}>
              Het antwoord moet een JSON-array van {"{ vraag, antwoord }"} blijven, anders kan het document niet verwerkt worden.
            </p>
            <button
              type="button"
              className="text-xs text-red-600 hover:underline"
              onClick={() => setSystemPrompt(loaded.defaultSystemPrompt)}
            >
              Standaardprompt herstellen
            </button>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className={legendCls}>Leerkrachtenaccount</legend>
            <p className="text-xs text-gray-500">
              Huidig wachtwoord komt uit:{" "}
              <strong>{loaded.teacherPasswordSource === "beheer" ? "beheer (hier ingesteld)" : ".env-bestand"}</strong>
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Nieuw wachtwoord</label>
                <input
                  type="password"
                  className={inputCls}
                  value={teacherPw}
                  onChange={e => setTeacherPw(e.target.value)}
                  autoComplete="new-password"
                  minLength={6}
                />
              </div>
              <div>
                <label className={labelCls}>Herhaal</label>
                <input
                  type="password"
                  className={inputCls}
                  value={teacherPw2}
                  onChange={e => setTeacherPw2(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <p className={hintCls}>Leeg laten om het wachtwoord niet te wijzigen. Minstens 6 tekens.</p>
            {loaded.teacherPasswordSource === "beheer" && (
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                onClick={() => {
                  if (confirm("Terugkeren naar het wachtwoord uit het .env-bestand?"))
                    save({ resetTeacherPassword: true }, "Leerkrachtenwachtwoord teruggezet naar .env.");
                }}
              >
                Terug naar .env-wachtwoord
              </button>
            )}
          </fieldset>

          {messageBox}
          <button type="submit" disabled={busy} className="btn-primary w-full justify-center">
            {busy ? "Opslaan…" : "Instellingen opslaan"}
          </button>
        </form>
      )}

      {tab === "vakken" && <SubjectsAdmin token={token} onUnauthorized={onUnauthorized} />}
      {tab === "training" && <TrainingAdmin token={token} onUnauthorized={onUnauthorized} />}
    </div>
  );
}
