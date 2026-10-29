import { useEffect, useState } from "react";

interface Lesson {
  id: string;
  tekst: string;
  vakId: string | null;
  vakNaam: string;
  soort: "richtlijn" | "correctie" | "voorbeeld";
  aangemaakt: string;
}
interface SubjectLite { id: string; naam: string }
interface MemorySettings {
  memoryEnabled: boolean;
  memoryUrl: string;
  hasMemorySecret: boolean;
  memorySecretHint: string;
  memoryProject: string;
}

interface Props {
  token: string;
  onUnauthorized: () => void;
}

const inputCls =
  "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent";
const labelCls = "block text-sm font-medium text-gray-700 mb-1.5";
const hintCls = "text-xs text-gray-400 mt-1";

const SOORTEN: { value: Lesson["soort"]; label: string; hint: string }[] = [
  { value: "richtlijn", label: "Richtlijn", hint: "Bv. 'Geef bij wiskunde altijd de tussenstappen.'" },
  { value: "correctie", label: "Correctie", hint: "Bv. 'Bij vraag over BTW-tarieven was 21% fout, het moet 6% zijn.'" },
  { value: "voorbeeld", label: "Voorbeeld", hint: "Bv. 'Goed antwoord: Een kort, volledig antwoord in 2 zinnen.'" },
];

export default function TrainingAdmin({ token, onUnauthorized }: Props) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [subjects, setSubjects] = useState<SubjectLite[]>([]);
  const [mem, setMem] = useState<MemorySettings | null>(null);

  const [tekst, setTekst] = useState("");
  const [vakId, setVakId] = useState("");
  const [soort, setSoort] = useState<Lesson["soort"]>("richtlijn");

  const [memEnabled, setMemEnabled] = useState(false);
  const [memUrl, setMemUrl] = useState("");
  const [memSecret, setMemSecret] = useState("");
  const [memProject, setMemProject] = useState("verbeterrobot");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const auth = { Authorization: `Bearer ${token}` };
  const json = { ...auth, "Content-Type": "application/json" };

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

  function applyMem(s: MemorySettings) {
    setMem(s);
    setMemEnabled(s.memoryEnabled);
    setMemUrl(s.memoryUrl);
    setMemProject(s.memoryProject);
    setMemSecret("");
  }

  async function reload() {
    const [t, subs, settings] = await Promise.all([
      call("/api/admin/training", { headers: auth }),
      call("/api/admin/subjects", { headers: auth }),
      call("/api/admin/settings", { headers: auth }),
    ]);
    setLessons(t.lessons);
    setSubjects(subs.map((s: SubjectLite) => ({ id: s.id, naam: s.naam })));
    applyMem(settings);
  }

  useEffect(() => {
    reload().catch(e => setMsg({ type: "err", text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ type: "ok", text });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Mislukt." });
    } finally {
      setBusy(false);
    }
  }

  const addLesson = () =>
    run(async () => {
      const r = await call("/api/admin/training", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ tekst, vakId: vakId || null, soort }),
      });
      setTekst("");
      await reload();
      if (r.memory === "opgeslagen") return "Les opgeslagen (ook in het geheugen).";
      if (String(r.memory).startsWith("mislukt"))
        return `Les lokaal opgeslagen, maar niet in het geheugen (${r.memory}).`;
      return "Les opgeslagen.";
    });

  const removeLesson = (l: Lesson) => {
    if (!confirm("Deze les verwijderen? (Een kopie in agentmemory blijft bestaan.)")) return;
    run(async () => {
      await call(`/api/admin/training/${l.id}`, { method: "DELETE", headers: auth });
      await reload();
      return "Les verwijderd.";
    });
  };

  const saveMemory = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        memoryEnabled: memEnabled,
        memoryUrl: memUrl,
        memoryProject: memProject,
      };
      if (memSecret.trim()) body.memorySecret = memSecret.trim();
      const data = await call("/api/admin/settings", {
        method: "PUT",
        headers: json,
        body: JSON.stringify(body),
      });
      applyMem(data);
      return "Geheugeninstellingen opgeslagen.";
    });

  const testMemory = () =>
    run(async () => {
      await call("/api/admin/memory/test", { method: "POST", headers: auth });
      return "Verbinding met agentmemory werkt (opgeslagen instellingen).";
    });

  const current = SOORTEN.find(s => s.value === soort)!;

  return (
    <div className="mt-8 pt-6 border-t border-gray-200 space-y-6">
      <div>
        <h3 className="text-lg font-bold text-gray-900">Training: prompts & lessen</h3>
        <p className="text-xs text-gray-500 mt-1">
          Schrijf hier richtlijnen, correcties of voorbeelden. Ze worden bij elke verbetering aan de
          prompt toegevoegd (algemeen of enkel voor het gekozen vak). Het model zelf wordt niet
          aangepast: de robot &ldquo;leert&rdquo; via deze context.
        </p>
      </div>

      <fieldset className="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Soort</label>
            <select className={inputCls} value={soort} onChange={e => setSoort(e.target.value as Lesson["soort"])}>
              {SOORTEN.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Geldt voor</label>
            <select className={inputCls} value={vakId} onChange={e => setVakId(e.target.value)}>
              <option value="">Alle vakken</option>
              {subjects.map(s => (
                <option key={s.id} value={s.id}>{s.naam}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>Prompt / les</label>
          <textarea
            className={`${inputCls} resize-y`}
            rows={4}
            maxLength={1500}
            value={tekst}
            onChange={e => setTekst(e.target.value)}
            placeholder={current.hint}
          />
          <p className={hintCls}>{tekst.length}/1500 tekens</p>
        </div>
        <button
          type="button"
          disabled={busy || tekst.trim().length < 5}
          onClick={addLesson}
          className="btn-primary"
        >
          Les toevoegen
        </button>
      </fieldset>

      <div className="space-y-2">
        {lessons.length === 0 && <p className="text-xs text-gray-400">Nog geen lessen.</p>}
        {lessons.map(l => (
          <div key={l.id} className="rounded-lg border border-gray-200 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs text-gray-500">
                <strong className="uppercase">{l.soort}</strong> · {l.vakNaam || "alle vakken"}
              </span>
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                disabled={busy}
                onClick={() => removeLesson(l)}
              >
                Verwijderen
              </button>
            </div>
            <p className="text-gray-700 whitespace-pre-wrap">{l.tekst}</p>
          </div>
        ))}
      </div>

      <fieldset className="space-y-4 pt-4 border-t border-gray-100">
        <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
          Geheugen (agentmemory)
        </legend>
        <p className="text-xs text-gray-500">
          Koppel de robot aan dezelfde agentmemory-server als de MCP. Nieuwe lessen worden daar
          bewaard, en bij elke verbetering worden de relevante lessen opgehaald en meegegeven.
          Als de server niet bereikbaar is, werkt de robot gewoon verder.
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
              placeholder={mem?.hasMemorySecret ? mem.memorySecretHint : "niet ingesteld"}
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
        <div className="flex gap-3">
          <button type="button" disabled={busy} onClick={saveMemory} className="btn-primary">
            Geheugen opslaan
          </button>
          <button type="button" disabled={busy} onClick={testMemory} className="btn-secondary">
            Test verbinding
          </button>
        </div>
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
    </div>
  );
}
