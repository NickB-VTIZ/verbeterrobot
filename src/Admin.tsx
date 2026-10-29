import { useEffect, useState, FormEvent } from "react";
import SubjectsAdmin from "./SubjectsAdmin";
import TrainingAdmin from "./TrainingAdmin";

interface PublicSettings {
  omnirouteBaseUrl: string;
  omnirouteModel: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  temperature: number;
  maxFileMb: number;
  systemPrompt: string;
  defaultSystemPrompt: string;
  teacherPasswordSource: "beheer" | "env";
}

interface Props {
  token: string;
  onUnauthorized: () => void;
  onUseTool: () => void;
  onLogout: () => void;
}

const inputCls =
  "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent";
const labelCls = "block text-sm font-medium text-gray-700 mb-1.5";
const hintCls = "text-xs text-gray-400 mt-1";

export default function Admin({ token, onUnauthorized, onUseTool, onLogout }: Props) {
  const [loaded, setLoaded] = useState<PublicSettings | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [maxFileMb, setMaxFileMb] = useState("20");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [teacherPw, setTeacherPw] = useState("");
  const [teacherPw2, setTeacherPw2] = useState("");

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  function apply(s: PublicSettings) {
    setLoaded(s);
    setBaseUrl(s.omnirouteBaseUrl);
    setModel(s.omnirouteModel);
    setTemperature(String(s.temperature));
    setMaxFileMb(String(s.maxFileMb));
    setSystemPrompt(s.systemPrompt);
    setApiKey("");
    setTeacherPw("");
    setTeacherPw2("");
  }

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/admin/settings", { headers });
      if (res.status === 401 || res.status === 403) return onUnauthorized();
      if (!res.ok) {
        setMsg({ type: "err", text: "Instellingen laden mislukt." });
        return;
      }
      apply(await res.json());
    })().catch(() => setMsg({ type: "err", text: "Kon de server niet bereiken." }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(extra: Record<string, unknown> = {}, okText = "Instellingen opgeslagen.") {
    setMsg(null);
    if (teacherPw && teacherPw !== teacherPw2) {
      setMsg({ type: "err", text: "De twee leerkrachtenwachtwoorden komen niet overeen." });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        omnirouteBaseUrl: baseUrl,
        omnirouteModel: model,
        temperature: Number(temperature),
        maxFileMb: Number(maxFileMb),
        systemPrompt,
        ...extra,
      };
      if (apiKey.trim()) body.omnirouteApiKey = apiKey.trim();
      if (teacherPw) body.teacherPassword = teacherPw;

      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (res.status === 401 || res.status === 403) return onUnauthorized();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Serverfout (${res.status})`);
      apply(data);
      setMsg({ type: "ok", text: okText });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "Opslaan mislukt." });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save();
  }

  async function testConnection() {
    setMsg(null);
    setTesting(true);
    try {
      const res = await fetch("/api/admin/test", { method: "POST", headers });
      if (res.status === 401 || res.status === 403) return onUnauthorized();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Test mislukt.");
      setMsg({ type: "ok", text: "Verbinding met Omniroute werkt (opgeslagen instellingen)." });
    } catch (err) {
      setMsg({ type: "err", text: err instanceof Error ? err.message : "Test mislukt." });
    } finally {
      setTesting(false);
    }
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

  return (
    <div>
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Beheer</h2>
        <div className="flex gap-2">
          <button type="button" onClick={onUseTool} className="btn-secondary !px-3 !py-1.5">
            Document verbeteren
          </button>
          <button type="button" onClick={onLogout} className="btn-secondary !px-3 !py-1.5">
            Afmelden
          </button>
        </div>
      </div>

      {/* Omniroute */}
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
          Omniroute (AI)
        </legend>
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
        <button type="button" onClick={testConnection} disabled={testing} className="btn-secondary">
          {testing ? "Testen…" : "Verbinding testen"}
        </button>
        <p className={hintCls}>De test gebruikt de laatst opgeslagen instellingen.</p>
      </fieldset>

      {/* Uploads */}
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
          Uploads
        </legend>
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

      {/* Prompt */}
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
          Systeemprompt
        </legend>
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

      {/* Leerkrachtenaccount */}
      <fieldset className="space-y-4">
        <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
          Leerkrachtenaccount
        </legend>
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

      {msg && (
        <p
          className={`text-sm rounded-lg px-4 py-2 ${
            msg.type === "ok" ? "text-green-700 bg-green-50" : "text-red-600 bg-red-50"
          }`}
        >
          {msg.text}
        </p>
      )}

      <button type="submit" disabled={busy} className="btn-primary w-full justify-center">
        {busy ? "Opslaan…" : "Instellingen opslaan"}
      </button>
    </form>
    <SubjectsAdmin token={token} onUnauthorized={onUnauthorized} />
    <TrainingAdmin token={token} onUnauthorized={onUnauthorized} />
    </div>
  );
}
