import { useEffect, useState, ChangeEvent } from "react";

interface Example { vraag: string; antwoord: string }
interface Reference { id: string; naam: string; chars: number }
export interface Subject {
  id: string;
  naam: string;
  graad: string;
  onderwerpen: string[];
  instructies: string;
  voorbeelden: Example[];
  referenties: Reference[];
}

interface Props {
  token: string;
  onUnauthorized: () => void;
}

const inputCls =
  "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent";
const labelCls = "block text-sm font-medium text-gray-700 mb-1.5";
const hintCls = "text-xs text-gray-400 mt-1";

const EMPTY = { naam: "", graad: "", onderwerpen: "", instructies: "", voorbeelden: [] as Example[] };

export default function SubjectsAdmin({ token, onUnauthorized }: Props) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [editId, setEditId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refText, setRefText] = useState("");
  const [refName, setRefName] = useState("");

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
    setSubjects(await call("/api/admin/subjects", { headers: auth }));
  }

  useEffect(() => {
    reload().catch(e => setMsg({ type: "err", text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startNew() {
    setForm(EMPTY);
    setEditId("new");
    setMsg(null);
  }

  function startEdit(s: Subject) {
    setForm({
      naam: s.naam,
      graad: s.graad,
      onderwerpen: s.onderwerpen.join("\n"),
      instructies: s.instructies,
      voorbeelden: s.voorbeelden,
    });
    setEditId(s.id);
    setMsg(null);
  }

  async function run(fn: () => Promise<void>, okText?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ type: "ok", text: okText });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Mislukt." });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const body = JSON.stringify({
        ...form,
        onderwerpen: form.onderwerpen.split(/[\n,;]+/).map(t => t.trim()).filter(Boolean),
      });
      const saved: Subject =
        editId === "new"
          ? await call("/api/admin/subjects", { method: "POST", headers: json, body })
          : await call(`/api/admin/subjects/${editId}`, { method: "PUT", headers: json, body });
      await reload();
      setEditId(saved.id); // blijf open: nu kan er referentiemateriaal bij
    }, "Vak opgeslagen.");

  const remove = (s: Subject) => {
    if (!confirm(`Vak "${s.naam}" en alle bijhorende training verwijderen?`)) return;
    run(async () => {
      await call(`/api/admin/subjects/${s.id}`, { method: "DELETE", headers: auth });
      if (editId === s.id) setEditId(null);
      await reload();
    }, "Vak verwijderd.");
  };

  const uploadRef = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || editId === null || editId === "new") return;
    run(async () => {
      const fd = new FormData();
      fd.append("file", f);
      await call(`/api/admin/subjects/${editId}/references`, { method: "POST", headers: auth, body: fd });
      await reload();
    }, `"${f.name}" toegevoegd als referentie.`);
  };

  const addRefText = () => {
    if (editId === null || editId === "new") return;
    run(async () => {
      await call(`/api/admin/subjects/${editId}/references`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ naam: refName || "Notities", tekst: refText }),
      });
      setRefText("");
      setRefName("");
      await reload();
    }, "Referentietekst toegevoegd.");
  };

  const removeRef = (r: Reference) =>
    run(async () => {
      await call(`/api/admin/subjects/${editId}/references/${r.id}`, { method: "DELETE", headers: auth });
      await reload();
    });

  const current = subjects.find(s => s.id === editId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-900">Vakken & training</h3>
          <p className="text-xs text-gray-500">
            Leer de robot per vak welke onderwerpen, regels en bronnen er gelden. Leerkrachten kiezen het vak bij het uploaden.
          </p>
        </div>
        {editId === null && (
          <button type="button" onClick={startNew} className="btn-primary !px-3 !py-1.5">+ Nieuw vak</button>
        )}
      </div>

      {msg && (
        <p className={`text-sm rounded-lg px-4 py-2 ${msg.type === "ok" ? "text-green-700 bg-green-50" : "text-red-600 bg-red-50"}`}>
          {msg.text}
        </p>
      )}

      {editId === null && (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-xl">
          {subjects.length === 0 && (
            <li className="px-4 py-3 text-sm text-gray-400">Nog geen vakken. Zonder vak verbetert de robot algemeen.</li>
          )}
          {subjects.map(s => (
            <li key={s.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">
                  {s.naam}{s.graad ? <span className="text-gray-400 font-normal"> · {s.graad}</span> : null}
                </p>
                <p className="text-xs text-gray-400">
                  {s.onderwerpen.length} onderwerpen · {s.voorbeelden.length} voorbeelden · {s.referenties.length} referenties
                </p>
              </div>
              <button type="button" onClick={() => startEdit(s)} className="text-xs text-red-600 hover:underline">Bewerken</button>
              <button type="button" onClick={() => remove(s)} className="text-xs text-gray-400 hover:text-red-600 hover:underline">Verwijderen</button>
            </li>
          ))}
        </ul>
      )}

      {editId !== null && (
        <div className="space-y-4 border border-gray-200 rounded-xl p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Vak</label>
              <input className={inputCls} value={form.naam} onChange={e => setForm({ ...form, naam: e.target.value })} placeholder="Bv. Mechanica" />
            </div>
            <div>
              <label className={labelCls}>Graad / jaar <span className="text-gray-400 font-normal">(optioneel)</span></label>
              <input className={inputCls} value={form.graad} onChange={e => setForm({ ...form, graad: e.target.value })} placeholder="Bv. 3de graad" />
            </div>
          </div>

          <div>
            <label className={labelCls}>Onderwerpen</label>
            <textarea
              rows={4}
              className={inputCls}
              value={form.onderwerpen}
              onChange={e => setForm({ ...form, onderwerpen: e.target.value })}
              placeholder={"Eén per lijn, bv.\nKrachten en momenten\nSpanningen\nVermogen en rendement"}
            />
            <p className={hintCls}>De leerkracht kiest bij het uploaden welke onderwerpen van toepassing zijn.</p>
          </div>

          <div>
            <label className={labelCls}>Vakspecifieke instructies</label>
            <textarea
              rows={5}
              className={inputCls}
              value={form.instructies}
              onChange={e => setForm({ ...form, instructies: e.target.value })}
              placeholder={"Bv.\n- Geef bij berekeningen de formule, de invulling en de eenheid.\n- Rond af op 2 decimalen.\n- Gebruik g = 9,81 m/s²."}
            />
          </div>

          <div className="space-y-2">
            <label className={labelCls}>Voorbeelden van goede verbeteringen <span className="text-gray-400 font-normal">(max 10)</span></label>
            {form.voorbeelden.map((v, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
                <textarea rows={2} className={inputCls} placeholder="Vraag" value={v.vraag}
                  onChange={e => setForm({ ...form, voorbeelden: form.voorbeelden.map((x, j) => j === i ? { ...x, vraag: e.target.value } : x) })} />
                <textarea rows={2} className={inputCls} placeholder="Gewenst antwoord" value={v.antwoord}
                  onChange={e => setForm({ ...form, voorbeelden: form.voorbeelden.map((x, j) => j === i ? { ...x, antwoord: e.target.value } : x) })} />
                <button type="button" className="text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                  onClick={() => setForm({ ...form, voorbeelden: form.voorbeelden.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            {form.voorbeelden.length < 10 && (
              <button type="button" className="text-xs text-red-600 hover:underline"
                onClick={() => setForm({ ...form, voorbeelden: [...form.voorbeelden, { vraag: "", antwoord: "" }] })}>
                + Voorbeeld toevoegen
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button type="button" disabled={busy || !form.naam.trim()} onClick={save} className="btn-primary">
              {busy ? "Opslaan…" : "Vak opslaan"}
            </button>
            <button type="button" onClick={() => { setEditId(null); setMsg(null); }} className="btn-secondary">Sluiten</button>
          </div>

          {/* Referentiemateriaal */}
          <div className="border-t border-gray-200 pt-4 space-y-3">
            <label className={labelCls}>Referentiemateriaal (cursus, correctiemodel, formularium)</label>
            {editId === "new" ? (
              <p className={hintCls}>Sla het vak eerst op om referentiemateriaal toe te voegen.</p>
            ) : (
              <>
                {current && current.referenties.length > 0 && (
                  <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                    {current.referenties.map(r => (
                      <li key={r.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                        <span className="flex-1 truncate text-gray-700">{r.naam}</span>
                        <span className="text-xs text-gray-400">{Math.round(r.chars / 1000)}k tekens</span>
                        <button type="button" onClick={() => removeRef(r)} className="text-gray-400 hover:text-red-600">×</button>
                      </li>
                    ))}
                  </ul>
                )}
                <input type="file" accept=".docx,.pdf,.pptx,.xlsx,.xls,.txt" onChange={uploadRef} disabled={busy}
                  className="block w-full text-sm text-gray-500 file:mr-3 file:rounded-lg file:border-0 file:bg-red-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-red-700 hover:file:bg-red-100" />
                <p className={hintCls}>
                  De tekst wordt uit het bestand gehaald en bewaard; het bestand zelf wordt verwijderd.
                  Bij elke verbetering worden enkel de meest relevante stukken meegegeven.
                </p>
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-500">Of plak tekst rechtstreeks</summary>
                  <div className="space-y-2 mt-2">
                    <input className={inputCls} placeholder="Naam (bv. Formularium)" value={refName} onChange={e => setRefName(e.target.value)} />
                    <textarea rows={5} className={inputCls} value={refText} onChange={e => setRefText(e.target.value)} />
                    <button type="button" disabled={busy || refText.trim().length < 20} onClick={addRefText} className="btn-secondary">Toevoegen</button>
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
