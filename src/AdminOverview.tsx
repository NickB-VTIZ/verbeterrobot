import { useCallback, useEffect, useState } from "react";
import { Api, formatBytes, formatDate } from "./api";
import { Banner, Loader } from "./ui";

interface Row {
  label: string;
  calls?: number;
  tokens?: number;
  cost_eur?: number;
  documents?: number;
}

interface Overview {
  cost: {
    total: { calls: number; tokens: number; cost_eur: number };
    perMonth: Row[];
    perVak: Row[];
    perTeacher: Row[];
  };
  storage: { files: number; bytes: number; documents: number; trash: number; perTeacher: Row[] };
  trashRetentionDays: number;
  priceInPer1M: number | null;
  priceOutPer1M: number | null;
}

interface Example {
  id: string;
  documentId: string | null;
  qid: string;
  vak: string;
  teacher: string;
  questionText: string;
  originalAnswer: string;
  correctedAnswer: string;
  action: string;
  comment: string;
  createdAt: string;
}

interface AuditRow {
  id: number | string;
  document_id: string | null;
  action: string;
  user: string;
  role: string;
  details: any;
  created_at: string;
}

const eur = (n?: number) => `€ ${(n ?? 0).toFixed(n && n < 1 ? 4 : 2)}`;

function CostTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="card overflow-x-auto">
      <div className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</div>
      <table className="w-full text-sm mt-1">
        <thead className="text-xs text-gray-500">
          <tr>
            <th className="text-left px-4 py-1.5 font-medium">&nbsp;</th>
            <th className="text-right px-2 py-1.5 font-medium">Aanroepen</th>
            <th className="text-right px-2 py-1.5 font-medium">Tokens</th>
            <th className="text-right px-4 py-1.5 font-medium">Kost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-3 text-gray-400">Nog geen gegevens.</td>
            </tr>
          )}
          {rows.map(r => (
            <tr key={r.label} className="border-t border-gray-100">
              <td className="px-4 py-1.5">{r.label}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.calls}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{(r.tokens ?? 0).toLocaleString("nl-BE")}</td>
              <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.cost_eur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminOverview({ api }: { api: Api }) {
  const [data, setData] = useState<Overview | null>(null);
  const [examples, setExamples] = useState<Example[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, e, a] = await Promise.all([
        api.json<Overview>("/api/admin/overview"),
        api.json<{ examples: Example[] }>("/api/admin/examples?limit=100"),
        api.json<{ audit: AuditRow[] }>("/api/admin/audit?limit=100"),
      ]);
      setData(o);
      setExamples(e.examples);
      setAudit(a.audit);
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : "Laden mislukt." });
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function purge() {
    if (!confirm("Alle documenten in de prullenbak die langer dan de bewaartermijn staan nu definitief verwijderen?")) return;
    setBusy(true);
    try {
      const r = await api.json<{ purged: number }>("/api/admin/purge-expired", { method: "POST" });
      setMsg({ tone: "ok", text: `${r.purged} document(en) definitief verwijderd.` });
      await load();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : "Opruimen mislukt." });
    } finally {
      setBusy(false);
    }
  }

  async function removeExample(id: string) {
    if (!confirm("Dit voorbeeld verwijderen? Het wordt niet meer gebruikt om de robot te verbeteren.")) return;
    try {
      await api.json(`/api/admin/examples/${encodeURIComponent(id)}`, { method: "DELETE" });
      setExamples(prev => (prev || []).filter(x => x.id !== id));
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : "Verwijderen mislukt." });
    }
  }

  if (!data) return msg ? <Banner tone="error">{msg.text}</Banner> : <Loader />;

  const s = data.storage;

  return (
    <div className="space-y-6">
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Opslag</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ["Documenten", String(s.documents)],
            ["In prullenbak", String(s.trash)],
            ["Bestanden", String(s.files)],
            ["Schijfgebruik", formatBytes(s.bytes)],
          ].map(([k, v]) => (
            <div key={k} className="card p-3">
              <div className="text-xs text-gray-500">{k}</div>
              <div className="text-lg font-semibold text-gray-900">{v}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
          <span>Prullenbak wordt na {data.trashRetentionDays} dagen automatisch opgeruimd.</span>
          <button type="button" className="btn-secondary !px-3 !py-1.5" onClick={purge} disabled={busy}>
            Nu opruimen
          </button>
        </div>
        <CostTable
          title="Documenten per leerkracht"
          rows={s.perTeacher.map(r => ({ label: r.label || "(onbekend)", calls: r.documents, tokens: undefined, cost_eur: undefined }))}
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">AI-kosten</h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-3">
            <div className="text-xs text-gray-500">Aanroepen</div>
            <div className="text-lg font-semibold">{data.cost.total.calls}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-gray-500">Tokens</div>
            <div className="text-lg font-semibold">{data.cost.total.tokens.toLocaleString("nl-BE")}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-gray-500">Geschatte kost</div>
            <div className="text-lg font-semibold">{eur(data.cost.total.cost_eur)}</div>
          </div>
        </div>
        {!data.priceInPer1M && !data.priceOutPer1M && (
          <p className="text-xs text-gray-400">
            Geen tokenprijzen ingesteld (LLM_PRICE_IN_PER_1M / LLM_PRICE_OUT_PER_1M per 1 miljoen tokens, in euro); de kost blijft dan € 0.
          </p>
        )}
        <div className="grid lg:grid-cols-3 gap-3">
          <CostTable title="Per maand" rows={data.cost.perMonth} />
          <CostTable title="Per vak" rows={data.cost.perVak} />
          <CostTable title="Per leerkracht" rows={data.cost.perTeacher} />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Voorbeelden uit correcties ({examples?.length ?? 0})
        </h3>
        {!examples || examples.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen voorbeelden. Ze ontstaan wanneer een leerkracht een antwoord aanpast of opnieuw laat genereren.</p>
        ) : (
          <div className="space-y-2">
            {examples.map(x => (
              <div key={x.id} className="card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{x.vak || "(geen vak)"}</span>
                  <span>vraag {x.qid}</span>
                  <span>· {x.action}</span>
                  <span>· {x.teacher}</span>
                  <span>· {formatDate(x.createdAt)}</span>
                  <button
                    type="button"
                    className="ml-auto text-red-600 hover:underline"
                    onClick={() => removeExample(x.id)}
                  >
                    Verwijderen
                  </button>
                </div>
                {x.questionText && <p className="mt-1 text-gray-700 line-clamp-2">{x.questionText}</p>}
                <div className="mt-1 grid sm:grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-gray-50 px-2 py-1">
                    <span className="text-gray-400">Eerst: </span>
                    {x.originalAnswer || "—"}
                  </div>
                  <div className="rounded bg-green-50 px-2 py-1">
                    <span className="text-gray-400">Verbeterd: </span>
                    {x.correctedAnswer || "—"}
                  </div>
                </div>
                {x.comment && <p className="mt-1 text-xs text-gray-500">Opmerking: {x.comment}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Auditlog (laatste 100)</h3>
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 bg-gray-50">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Wanneer</th>
                <th className="text-left px-3 py-1.5 font-medium">Wie</th>
                <th className="text-left px-3 py-1.5 font-medium">Actie</th>
                <th className="text-left px-3 py-1.5 font-medium">Document</th>
              </tr>
            </thead>
            <tbody>
              {(audit || []).map(a => (
                <tr key={a.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(a.created_at)}</td>
                  <td className="px-3 py-1.5">{a.user}{a.role ? ` (${a.role})` : ""}</td>
                  <td className="px-3 py-1.5">{a.action}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-400">{a.document_id ? a.document_id.slice(0, 8) : "—"}</td>
                </tr>
              ))}
              {(!audit || audit.length === 0) && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-gray-400">Nog geen activiteit.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
