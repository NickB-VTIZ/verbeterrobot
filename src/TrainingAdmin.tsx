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
  const [memoryOn, setMemoryOn] = useState(false);

  const [tekst, setTekst] = useState("");
  const [vakId, setVakId] = useState("");
  const [soort, setSoort] = useState<Lesson["soort"]>("richtlijn");

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

  async function reload() {
    const [t, subs] = await Promise.all([
      call("/api/admin/training", { headers: auth }),
      call("/api/admin/subjects", { headers: auth }),
    ]);
    setLessons(t.lessons);
    setMemoryOn(!!t.memoryActive);
    setSubjects(subs.map((s: SubjectLite) => ({ id: s.id, naam: s.naam })));
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

  const current = SOORTEN.find(s => s.value === soort)!;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-gray-900">Training: prompts & lessen</h3>
        <p className="text-xs text-gray-500 mt-1">
          Schrijf hier richtlijnen, correcties of voorbeelden. Ze worden bij elke verbetering aan de
          prompt toegevoegd (algemeen of enkel voor het gekozen vak). Het model zelf wordt niet
          aangepast: de robot &ldquo;leert&rdquo; via deze context.
        </p>
        <p className="text-xs mt-1">
          Geheugen (agentmemory):{" "}
          <strong className={memoryOn ? "text-green-700" : "text-gray-500"}>
            {memoryOn ? "actief — lessen worden ook daar bewaard" : "uit — lessen blijven lokaal"}
          </strong>{" "}
          <span className="text-gray-400">(instellen onder Verbindingen)</span>
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
