import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, ApiError, formatBytes, formatDate } from "./api";
import { AuthPdf, Banner, EmptyState, GeneratingPanel, Loader, Modal, PurgeDialog, Spinner } from "./ui";
import { StatusPill } from "./Library";
import CorrectedUpload from "./CorrectedUpload";

interface VersionInfo {
  versionNumber: number;
  status: string;
  createdBy: string;
  createdAt: string;
  summary: any;
  qcIssues: string[];
  docxFileId: string | null;
  pdfFileId: string | null;
  thumbFileId: string | null;
}

interface FeedbackItem {
  id: string;
  versionNumber: number;
  qid: string;
  questionText: string;
  originalAnswer: string;
  correctedAnswer: string;
  action: string;
  comment: string;
  user: string;
  createdAt: string;
}

interface DetailData {
  document: any;
  versions: VersionInfo[];
  feedback: FeedbackItem[];
  cost: { calls: number; prompt_tokens: number; completion_tokens: number; cost_eur: number };
  llmCalls: any[];
  audit: any[];
  marks: { teacher: number; proposal: number };
  markable: boolean;
  generating: boolean;
}

interface AnswerSlot {
  paraId: string;
  type: string;
  content: string | string[];
}

interface Answer {
  qid: string;
  questionText: string;
  paraIds: string[];
  slots: AnswerSlot[];
  teacherAnswer: string;
  review: string | null;
  decision: { action: string; user: string; at: string; comment: string } | null;
}

interface Props {
  api: Api;
  role: "teacher" | "admin";
  userName: string;
  id: string;
  onBack: () => void;
  onMark: (id: string) => void;
  onOpen: (id: string) => void;
}

const ACTION_LABEL: Record<string, string> = {
  goedgekeurd: "Goedgekeurd",
  aangepast: "Aangepast",
  opnieuw_gegenereerd: "Opnieuw gegenereerd",
};

const ACTION_TONE: Record<string, string> = {
  goedgekeurd: "bg-green-100 text-green-800",
  aangepast: "bg-blue-100 text-blue-800",
  opnieuw_gegenereerd: "bg-amber-100 text-amber-800",
};

const textOf = (c: string | string[]) => (Array.isArray(c) ? c.join("\n") : String(c ?? ""));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function DocumentDetail({ api, role, userName, id, onBack, onMark, onOpen }: Props) {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [selVersion, setSelVersion] = useState<number | null>(null);
  const [previewTab, setPreviewTab] = useState<"beide" | "origineel" | "sleutel">("beide");
  const [showPurge, setShowPurge] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const load = useCallback(
    async (keepSel = true, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const d = await api.json<DetailData>(`/api/documents/${id}`);
        setData(d);
        setError("");
        setSelVersion(prev => {
          if (keepSel && prev && d.versions.some(v => v.versionNumber === prev)) return prev;
          return d.document.activeVersion || d.versions[d.versions.length - 1]?.versionNumber || null;
        });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [api, id]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // Terwijl er een generatie loopt: elke 4 s verversen.
  useEffect(() => {
    if (!data?.generating && data?.document.status !== "bezig" && data?.document.proposalStatus !== "bezig") return;
    const t = setInterval(() => load(true, true), 4000);
    return () => clearInterval(t);
  }, [data?.generating, data?.document.status, data?.document.proposalStatus, load]);

  async function run<T>(label: string, fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const r = await fn();
      if (okText) setNotice(okText);
      return r;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(errMsg(e));
    } finally {
      setBusy("");
    }
    return undefined;
  }

  const doc = data?.document;
  const inTrash = !!doc?.deletedAt;
  const version = useMemo(() => data?.versions.find(v => v.versionNumber === selVersion) || null, [data, selVersion]);

  if (loading && !data) return <Loader text="Document laden…" />;
  if (!data || !doc) {
    return (
      <div className="space-y-4">
        <button className="btn-sm" onClick={onBack}>
          ← Bibliotheek
        </button>
        {error ? <Banner tone="error">{error}</Banner> : <EmptyState title="Document niet gevonden" />}
      </div>
    );
  }

  const generate = () =>
    run(
      "generate",
      async () => {
        const r = await api.json<{ versionNumber: number; review: any[]; warnings: string[] }>(`/api/documents/${id}/generate`, { method: "POST", body: {} });
        await load(false, true);
        setSelVersion(r.versionNumber);
        return r;
      },
      "Nieuwe versie gegenereerd."
    );

  const duplicate = async () => {
    const r = await run("dup", () => api.json<{ document: { id: string } }>(`/api/documents/${id}/duplicate`, { method: "POST" }));
    if (r) onOpen(r.document.id);
  };

  const trashIt = async () => {
    if (!window.confirm("Dit document naar de prullenbak verplaatsen? Je kan het later herstellen.")) return;
    const r = await run("del", () => api.json(`/api/documents/${id}`, { method: "DELETE" }));
    if (r) onBack();
  };

  const restore = () =>
    run(
      "restore",
      async () => {
        await api.json(`/api/documents/${id}/restore`, { method: "POST" });
        await load(true, true);
      },
      "Document hersteld."
    );

  const dl = (url: string, name: string) => run("dl", () => api.download(url, name));

  const retryPreview = () =>
    run(
      "preview",
      async () => {
        await api.json(`/api/documents/${id}/preview/retry`, { method: "POST" });
      },
      "Voorbeelden worden opnieuw gemaakt; ververs over enkele seconden."
    );

  const isGenerating = !inTrash && (busy === "generate" || data.generating || doc.status === "bezig");
  const originalPdf = `/api/documents/${id}/preview/original/pdf`;
  const keyPdf = version ? `/api/documents/${id}/preview/version/${version.versionNumber}/pdf` : null;
  const showOrig = previewTab !== "sleutel";
  const showKey = previewTab !== "origineel";

  return (
    <div className="space-y-5 text-left">
      {/* kop */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button className="btn-sm mb-2" onClick={onBack}>
            ← Bibliotheek
          </button>
          <h1 className="text-xl font-bold text-gray-900 break-words">{doc.title}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-gray-500">
            <StatusPill status={doc.status} />
            {doc.vak && <span className="chip">{doc.vak}</span>}
            {doc.leerjaar && <span className="chip">{doc.leerjaar}</span>}
            {doc.richting && <span className="chip">{doc.richting}</span>}
            {doc.schooljaar && <span className="chip">{doc.schooljaar}</span>}
            <span>door {doc.teacher}</span>
            <span>· {formatDate(doc.createdAt)}</span>
            {(doc.tags as string[]).map(t => (
              <span key={t} className="chip">
                #{t}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!inTrash && (
            <>
              {data.markable && (
                <button className="btn-sm" onClick={() => onMark(id)}>
                  ✏️ Aanduiden{data.marks.teacher ? ` (${data.marks.teacher})` : ""}
                </button>
              )}
              <button className="btn-sm-red" onClick={generate} disabled={!!busy || data.generating}>
                {isGenerating ? <Spinner className="w-3.5 h-3.5" /> : "⚙"}{" "}
                {isGenerating ? "AI is bezig met genereren…" : data.versions.length ? "Opnieuw genereren" : "Sleutel genereren"}
              </button>
            </>
          )}
          {inTrash && (
            <>
              <button className="btn-sm" onClick={restore} disabled={!!busy}>
                ↩ Herstellen
              </button>
              <button className="btn-sm-red" onClick={() => setShowPurge(true)}>
                Definitief verwijderen…
              </button>
            </>
          )}
        </div>
      </div>

      {inTrash && <Banner tone="warn">Dit document staat in de prullenbak (verwijderd door {doc.deletedBy || "onbekend"} op {formatDate(doc.deletedAt)}).</Banner>}
      {isGenerating && (
        <GeneratingPanel
          title="De AI genereert de antwoordsleutel…"
          steps={["Vragen en antwoordplaatsen inlezen", "Elke vraag oplossen", "Antwoorden in rood invoegen in het document", "Controle en voorbeeld maken"]}
        >
          Je mag deze pagina open laten staan: ze ververst automatisch zodra de nieuwe versie klaar is.
        </GeneratingPanel>
      )}
      {doc.proposalStatus === "bezig" && !inTrash && !isGenerating && (
        <GeneratingPanel
          title="De AI maakt een eerste voorstel…"
          steps={["Document lezen", "Vragen en antwoordplaatsen herkennen", "Voorstel controleren"]}
        >
          De AI zoekt de vragen en antwoordplaatsen in je document. Je kan het daarna nakijken via &ldquo;Aanduiden&rdquo;.
        </GeneratingPanel>
      )}
      {doc.proposalStatus === "klaar" && !inTrash && data.marks.teacher === 0 && data.marks.proposal > 0 && (
        <Banner tone="ok">
          De AI heeft een eerste voorstel gemaakt ({data.marks.proposal} aanduidingen). Open &ldquo;Aanduiden&rdquo; om het na te kijken
          en aan te passen, of genereer meteen de sleutel.
        </Banner>
      )}
      {doc.proposalStatus === "mislukt" && !inTrash && (
        <Banner tone="warn">
          Het automatische voorstel is mislukt{doc.proposalError ? `: ${doc.proposalError}` : "."} Je kan in &ldquo;Aanduiden&rdquo; opnieuw een voorstel laten maken.
        </Banner>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      {/* acties */}
      <div className="card p-3 flex flex-wrap gap-2 items-center">
        <span className="text-xs font-semibold text-gray-500 mr-1">Downloaden</span>
        <button className="btn-sm" disabled={!!busy} onClick={() => dl(`/api/documents/${id}/download/original`, doc.originalFilename)}>
          ⬇ Origineel
        </button>
        <button className="btn-sm" disabled={!!busy || !doc.activeVersion} onClick={() => dl(`/api/documents/${id}/download/active`, "sleutel.docx")}>
          ⬇ Actieve sleutel
        </button>
        <button className="btn-sm" disabled={!!busy} onClick={() => dl(`/api/documents/${id}/download/zip`, "document.zip")}>
          ⬇ ZIP (alles)
        </button>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button className="btn-sm" onClick={() => setShowMeta(true)} disabled={inTrash}>
          🏷 Gegevens & tags
        </button>
        <button className="btn-sm" onClick={duplicate} disabled={!!busy || inTrash}>
          ⧉ Dupliceren
        </button>
        <button className="btn-sm" onClick={() => setShowTemplate(true)} disabled={inTrash}>
          📑 Sjabloon
        </button>
        <button className="btn-sm" onClick={retryPreview} disabled={!!busy}>
          ↻ Voorbeelden
        </button>
        {!inTrash && (
          <button className="btn-sm" onClick={trashIt} disabled={!!busy}>
            🗑 Verwijderen
          </button>
        )}
      </div>

      {/* naast elkaar */}
      <section className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Origineel en sleutel</h2>
          <div className="flex flex-wrap items-center gap-2">
            {data.versions.length > 0 && (
              <select className="input !w-auto" value={selVersion ?? ""} onChange={e => setSelVersion(Number(e.target.value))} aria-label="Versie">
                {[...data.versions].reverse().map(v => (
                  <option key={v.versionNumber} value={v.versionNumber}>
                    Versie {v.versionNumber}
                    {v.versionNumber === doc.activeVersion ? " (actief)" : ""}
                  </option>
                ))}
              </select>
            )}
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs" role="group" aria-label="Weergave">
              {(["beide", "origineel", "sleutel"] as const).map(t => (
                <button key={t} type="button" onClick={() => setPreviewTab(t)} className={`px-3 py-1.5 capitalize ${previewTab === t ? "bg-red-600 text-white" : "bg-white text-gray-600"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className={`grid gap-4 ${showOrig && showKey ? "xl:grid-cols-2" : "grid-cols-1"}`}>
          {showOrig && (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-3 py-2 bg-gray-100 border-b border-gray-200 flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span aria-hidden>📄</span> Origineel
              </div>
              <div className="p-2">
                <AuthPdf api={api} url={originalPdf} title="Origineel" />
              </div>
            </div>
          )}
          {showKey && (
            <div className="rounded-xl border border-red-200 overflow-hidden">
              <div className="px-3 py-2 bg-red-50 border-b border-red-200 flex items-center gap-2 text-sm font-semibold text-red-800">
                <span aria-hidden>🔑</span> Sleutel{version ? ` — versie ${version.versionNumber}` : ""}
                {isGenerating && (
                  <span className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-blue-800">
                    <Spinner className="w-3 h-3" /> nieuwe versie wordt gemaakt…
                  </span>
                )}
              </div>
              <div className="p-2">
                {version ? (
                  <AuthPdf api={api} url={keyPdf} title="Sleutel" />
                ) : isGenerating ? (
                  <GeneratingPanel compact title="Sleutel wordt gemaakt…">
                    De sleutel verschijnt hier naast het origineel zodra de AI klaar is.
                  </GeneratingPanel>
                ) : (
                  <EmptyState icon="🔑" title="Nog geen sleutel">
                    Genereer de sleutel om hem hier naast het origineel te zien.
                  </EmptyState>
                )}
              </div>
            </div>
          )}
        </div>
        {showOrig && showKey && (
          <p className="text-xs text-gray-500">
            Tip: gebruik &ldquo;origineel&rdquo; of &ldquo;sleutel&rdquo; hierboven voor een volledig brede weergave, of open een voorbeeld in een nieuw tabblad.
          </p>
        )}
        {version && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-sm" disabled={!!busy} onClick={() => dl(`/api/documents/${id}/download/version/${version.versionNumber}`, `sleutel-v${version.versionNumber}.docx`)}>
              ⬇ Deze versie
            </button>
          </div>
        )}
      </section>

      {!inTrash && <CorrectedUpload api={api} docId={id} disabled={!!busy} />}

      {/* nakijken */}
      {version && !inTrash && (
        <ReviewPanel
          key={`${id}-${version.versionNumber}`}
          api={api}
          docId={id}
          version={version}
          busyOuter={!!busy || data.generating}
          onNewVersion={async n => {
            await load(false, true);
            setSelVersion(n);
          }}
          onChanged={() => load(true, true)}
          setError={setError}
          setNotice={setNotice}
        />
      )}

      {/* versies */}
      <VersionsPanel
        api={api}
        data={data}
        docId={id}
        inTrash={inTrash}
        busy={!!busy}
        onSelect={setSelVersion}
        onActivate={n => run("act", async () => { await api.json(`/api/documents/${id}/versions/${n}/activate`, { method: "POST" }); await load(true, true); }, `Versie ${n} is nu de actieve sleutel.`)}
        onApprove={n => run("appr", async () => { await api.json(`/api/documents/${id}/versions/${n}/approve`, { method: "POST" }); await load(true, true); }, `Versie ${n} goedgekeurd; de antwoorden zijn bewaard als voorbeelden.`)}
        onDownload={n => dl(`/api/documents/${id}/download/version/${n}`, `sleutel-v${n}.docx`)}
      />

      {/* feedback */}
      <section className="card p-4 space-y-3">
        <h2 className="font-semibold text-gray-900">Feedbackgeschiedenis</h2>
        {data.feedback.length === 0 ? (
          <p className="text-sm text-gray-500">Nog geen goedkeuringen of aanpassingen.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.feedback.map(f => (
              <li key={f.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${ACTION_TONE[f.action] || "bg-gray-100 text-gray-700"}`}>{ACTION_LABEL[f.action] || f.action}</span>
                  <span className="font-medium text-gray-800">Vraag {f.qid}</span>
                  <span className="text-xs text-gray-500">
                    v{f.versionNumber} · {f.user} · {formatDate(f.createdAt)}
                  </span>
                </div>
                {f.questionText && <div className="text-xs text-gray-500 mt-1 line-clamp-2">{f.questionText}</div>}
                {(f.originalAnswer || f.correctedAnswer) && (
                  <div className="grid sm:grid-cols-2 gap-2 mt-1 text-xs">
                    {f.originalAnswer && <div className="rounded bg-gray-50 border border-gray-200 p-2 whitespace-pre-wrap text-red-700">{f.originalAnswer}</div>}
                    {f.correctedAnswer && <div className="rounded bg-green-50 border border-green-200 p-2 whitespace-pre-wrap text-red-700">{f.correctedAnswer}</div>}
                  </div>
                )}
                {f.comment && <div className="text-xs text-gray-600 mt-1">💬 {f.comment}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* kost */}
      <section className="card p-4">
        <h2 className="font-semibold text-gray-900 mb-2">AI-gebruik voor dit document</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat label="Aanroepen" value={String(data.cost.calls)} />
          <Stat label="Tokens in" value={data.cost.prompt_tokens.toLocaleString("nl-BE")} />
          <Stat label="Tokens uit" value={data.cost.completion_tokens.toLocaleString("nl-BE")} />
          <Stat label="Geschatte kost" value={`€ ${data.cost.cost_eur.toFixed(4)}`} />
        </div>
        {data.llmCalls.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-gray-600">Aanroepen tonen ({data.llmCalls.length})</summary>
            <table className="w-full mt-2">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1">Wanneer</th>
                  <th>Soort</th>
                  <th>Model</th>
                  <th className="text-right">Tokens</th>
                  <th className="text-right">Kost</th>
                </tr>
              </thead>
              <tbody>
                {data.llmCalls.map((c: any) => (
                  <tr key={c.id} className="border-t border-gray-100">
                    <td className="py-1">{formatDate(c.created_at)}</td>
                    <td>{c.call_type}</td>
                    <td>{c.model}</td>
                    <td className="text-right">{c.total_tokens}</td>
                    <td className="text-right">€ {Number(c.cost_eur || 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      {/* audit */}
      <section className="card p-4">
        <button className="text-sm font-semibold text-gray-900" onClick={() => setShowAudit(s => !s)}>
          {showAudit ? "▾" : "▸"} Activiteit ({data.audit.length})
        </button>
        {showAudit && (
          <ul className="mt-2 text-xs divide-y divide-gray-100">
            {data.audit.map((a: any, i: number) => (
              <li key={i} className="py-1.5 flex flex-wrap gap-x-3">
                <span className="text-gray-500">{formatDate(a.created_at)}</span>
                <span className="font-medium text-gray-800">{a.action}</span>
                <span className="text-gray-500">{a.user}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showPurge && (
        <PurgeDialog
          api={api}
          ids={[id]}
          onCancel={() => setShowPurge(false)}
          onDone={() => {
            setShowPurge(false);
            onBack();
          }}
        />
      )}
      {showMeta && (
        <MetaModal
          api={api}
          doc={doc}
          onClose={() => setShowMeta(false)}
          onSaved={async () => {
            setShowMeta(false);
            setNotice("Gegevens opgeslagen.");
            await load(true, true);
          }}
        />
      )}
      {showTemplate && (
        <TemplateModal
          api={api}
          docId={id}
          docTitle={doc.title}
          canApply={data.markable}
          onClose={() => setShowTemplate(false)}
          onDone={async msg => {
            setShowTemplate(false);
            setNotice(msg);
            await load(true, true);
          }}
        />
      )}
      <p className="text-[11px] text-gray-400">
        Ingelogd als {userName || role}
        {role === "admin" ? " (beheerder)" : ""} · {formatBytes(doc.bytes || 0)}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="font-semibold text-gray-900">{value}</div>
    </div>
  );
}

/* ───────────── versies, vergelijken ───────────── */

function VersionsPanel({
  api,
  data,
  docId,
  inTrash,
  busy,
  onSelect,
  onActivate,
  onApprove,
  onDownload,
}: {
  api: Api;
  data: DetailData;
  docId: string;
  inTrash: boolean;
  busy: boolean;
  onSelect: (n: number) => void;
  onActivate: (n: number) => void;
  onApprove: (n: number) => void;
  onDownload: (n: number) => void;
}) {
  const [a, setA] = useState<number | "">("");
  const [b, setB] = useState<number | "">("");
  const [cmp, setCmp] = useState<any | null>(null);
  const [cmpErr, setCmpErr] = useState("");
  const [cmpBusy, setCmpBusy] = useState(false);

  async function compare() {
    if (!a || !b) return;
    setCmpBusy(true);
    setCmpErr("");
    try {
      setCmp(await api.json(`/api/documents/${docId}/compare?a=${a}&b=${b}`));
    } catch (e) {
      setCmpErr(errMsg(e));
      setCmp(null);
    } finally {
      setCmpBusy(false);
    }
  }

  const vs = [...data.versions].reverse();
  const active = data.document.activeVersion;

  return (
    <section className="card p-4 space-y-3">
      <h2 className="font-semibold text-gray-900">Versies</h2>
      {vs.length === 0 ? (
        <p className="text-sm text-gray-500">Er zijn nog geen versies. Elke generatie of aanpassing maakt een nieuwe versie; oude versies worden nooit overschreven.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {vs.map(v => (
            <li key={v.versionNumber} className="py-2.5 flex flex-wrap items-center gap-2 text-sm">
              <button className="font-semibold text-gray-900 hover:underline" onClick={() => onSelect(v.versionNumber)}>
                Versie {v.versionNumber}
              </button>
              {v.versionNumber === active && <span className="chip !bg-green-100 !text-green-800">actief</span>}
              <StatusPill status={v.status} />
              <span className="text-xs text-gray-500">
                {v.createdBy} · {formatDate(v.createdAt)}
                {v.summary?.opnieuw ? ` · opnieuw: ${v.summary.opnieuw.join(", ")}` : ""}
                {v.summary?.bewerkt ? ` · bewerkt: ${v.summary.bewerkt.join(", ")}` : ""}
                {v.summary?.basis ? ` · gebaseerd op v${v.summary.basis}` : ""}
                {v.qcIssues?.length ? ` · ${v.qcIssues.length} opmerking(en)` : ""}
              </span>
              <span className="ml-auto flex flex-wrap gap-1.5">
                <button className="btn-sm" disabled={busy} onClick={() => onDownload(v.versionNumber)}>
                  ⬇
                </button>
                {!inTrash && v.versionNumber !== active && (
                  <button className="btn-sm" disabled={busy} onClick={() => onActivate(v.versionNumber)}>
                    Actief maken
                  </button>
                )}
                {!inTrash && v.status !== "goedgekeurd" && (
                  <button className="btn-sm" disabled={busy} onClick={() => onApprove(v.versionNumber)}>
                    ✓ Goedkeuren
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {vs.length >= 2 && (
        <div className="pt-3 border-t border-gray-100 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-gray-700">Vergelijk</span>
            <select className="input !w-auto" value={a} onChange={e => setA(Number(e.target.value) || "")}>
              <option value="">versie…</option>
              {vs.map(v => (
                <option key={v.versionNumber} value={v.versionNumber}>
                  v{v.versionNumber}
                </option>
              ))}
            </select>
            <span>met</span>
            <select className="input !w-auto" value={b} onChange={e => setB(Number(e.target.value) || "")}>
              <option value="">versie…</option>
              {vs.map(v => (
                <option key={v.versionNumber} value={v.versionNumber}>
                  v{v.versionNumber}
                </option>
              ))}
            </select>
            <button className="btn-sm" disabled={!a || !b || a === b || cmpBusy} onClick={compare}>
              {cmpBusy ? <Spinner className="w-3.5 h-3.5" /> : null} Vergelijken
            </button>
          </div>
          {cmpErr && <Banner tone="error">{cmpErr}</Banner>}
          {cmp && (
            <div className="text-xs">
              <p className="text-gray-600 mb-1">{cmp.changed === 0 ? "De twee versies zijn identiek." : `${cmp.changed} antwoord(en) verschillen.`}</p>
              {cmp.changed > 0 && (
                <div className="overflow-auto max-h-96 rounded border border-gray-200">
                  <table className="w-full">
                    <thead className="bg-gray-50 text-gray-500 text-left">
                      <tr>
                        <th className="p-2">Vraag</th>
                        <th className="p-2">v{cmp.a}</th>
                        <th className="p-2">v{cmp.b}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cmp.items
                        .filter((it: any) => it.status !== "gelijk")
                        .map((it: any, i: number) => (
                          <tr key={i} className="border-t border-gray-100 align-top">
                            <td className="p-2 font-medium">{it.qid}</td>
                            <td className="p-2 whitespace-pre-wrap text-red-700">{textOf(it.a ?? "")}</td>
                            <td className="p-2 whitespace-pre-wrap text-red-700">{textOf(it.b ?? "")}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ───────────── nakijken per antwoord ───────────── */

function ReviewPanel({
  api,
  docId,
  version,
  busyOuter,
  onNewVersion,
  onChanged,
  setError,
  setNotice,
}: {
  api: Api;
  docId: string;
  version: VersionInfo;
  busyOuter: boolean;
  onNewVersion: (n: number) => Promise<void>;
  onChanged: () => void;
  setError: (s: string) => void;
  setNotice: (s: string) => void;
}) {
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [editable, setEditable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [openRegen, setOpenRegen] = useState<string | null>(null);
  const [working, setWorking] = useState("");

  const n = version.versionNumber;

  const loadAnswers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.json<{ answers: Answer[]; editable: boolean }>(`/api/documents/${docId}/versions/${n}`);
      setAnswers(r.answers);
      setEditable(r.editable);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [api, docId, n, setError]);

  useEffect(() => {
    loadAnswers();
  }, [loadAnswers]);

  const key = (qid: string, i: number) => `${qid}::${i}`;
  const valueOf = (a: Answer, i: number) => edits[key(a.qid, i)] ?? textOf(a.slots[i].content);
  const dirtyQids = useMemo(() => {
    const out = new Set<string>();
    for (const a of answers || []) {
      a.slots.forEach((s, i) => {
        const k = key(a.qid, i);
        if (k in edits && edits[k] !== textOf(s.content)) out.add(a.qid);
      });
    }
    return out;
  }, [answers, edits]);

  async function saveEdits() {
    if (!answers) return;
    setWorking("save");
    setError("");
    try {
      const payload = answers
        .filter(a => dirtyQids.has(a.qid))
        .map(a => ({ qid: a.qid, slots: a.slots.map((_, i) => valueOf(a, i)) }));
      const r = await api.json<{ changed: boolean; versionNumber: number }>(`/api/documents/${docId}/versions/${n}/review`, {
        method: "POST",
        body: { edits: payload },
      });
      setEdits({});
      if (r.changed) {
        setNotice(`Aanpassingen bewaard als nieuwe versie ${r.versionNumber}. Ze worden als voorbeeld onthouden.`);
        await onNewVersion(r.versionNumber);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setWorking("");
    }
  }

  async function approve(qid: string) {
    setWorking(`ok:${qid}`);
    setError("");
    try {
      await api.json(`/api/documents/${docId}/versions/${n}/review`, { method: "POST", body: { approve: [qid] } });
      await loadAnswers();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setWorking("");
    }
  }

  async function regenerate(qid: string) {
    setWorking(`re:${qid}`);
    setError("");
    try {
      const r = await api.json<{ versionNumber: number }>(`/api/documents/${docId}/versions/${n}/regenerate`, {
        method: "POST",
        body: { qids: [qid], comments: { [qid]: comments[qid] || "" } },
      });
      setOpenRegen(null);
      setNotice(`Vraag ${qid} opnieuw gegenereerd in versie ${r.versionNumber}.`);
      await onNewVersion(r.versionNumber);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setWorking("");
    }
  }

  async function approveAll() {
    if (!answers) return;
    setWorking("all");
    try {
      await api.json(`/api/documents/${docId}/versions/${n}/review`, {
        method: "POST",
        body: { approve: answers.filter(a => !a.decision && !dirtyQids.has(a.qid)).map(a => a.qid) },
      });
      await loadAnswers();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setWorking("");
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900">Nakijken — versie {n}</h2>
        <div className="flex gap-2">
          {dirtyQids.size > 0 && (
            <button className="btn-sm-red" disabled={!!working || busyOuter} onClick={saveEdits}>
              {working === "save" ? <Spinner className="w-3.5 h-3.5" /> : null} {dirtyQids.size} aanpassing(en) opslaan
            </button>
          )}
          {answers && answers.some(a => !a.decision) && (
            <button className="btn-sm" disabled={!!working || busyOuter} onClick={approveAll}>
              ✓ Alles zonder beslissing goedkeuren
            </button>
          )}
        </div>
      </div>
      {version.qcIssues?.filter(i => !/^[^\s:]+: /.test(i)).length > 0 && (
        <Banner tone="warn">
          <ul className="list-disc ml-4">
            {version.qcIssues
              .filter(i => !/^[^\s:]+: /.test(i))
              .slice(0, 8)
              .map((i, k) => (
                <li key={k}>{i}</li>
              ))}
          </ul>
        </Banner>
      )}
      {loading ? (
        <Loader />
      ) : !answers || answers.length === 0 ? (
        <p className="text-sm text-gray-500">Geen antwoorden per vraag beschikbaar voor deze versie.</p>
      ) : (
        <ul className="space-y-3">
          {answers.map(a => (
            <li key={a.qid} className={`rounded-lg border p-3 ${a.review ? "border-amber-300 bg-amber-50/40" : "border-gray-200"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900">Vraag {a.qid}</div>
                  {a.questionText && <div className="text-xs text-gray-600 whitespace-pre-wrap line-clamp-3">{a.questionText}</div>}
                </div>
                {a.decision && (
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${ACTION_TONE[a.decision.action] || "bg-gray-100 text-gray-700"}`} title={`${a.decision.user} · ${formatDate(a.decision.at)}`}>
                    {ACTION_LABEL[a.decision.action] || a.decision.action}
                  </span>
                )}
              </div>
              {a.teacherAnswer && <div className="mt-1 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1">Jouw antwoord/modelantwoord had voorrang: {a.teacherAnswer}</div>}
              {a.review && <div className="mt-1 text-xs text-amber-900">⚠ {a.review}</div>}
              <div className="mt-2 space-y-2">
                {a.slots.map((s, i) => (
                  <label key={i} className="block">
                    <span className="text-[11px] text-gray-500">
                      Antwoordplaats {a.slots.length > 1 ? i + 1 : ""} · {s.type}
                    </span>
                    <textarea
                      className="input !text-red-700 font-medium"
                      rows={Math.min(8, Math.max(2, valueOf(a, i).split("\n").length))}
                      value={valueOf(a, i)}
                      disabled={!editable || !!working}
                      onChange={e => setEdits(prev => ({ ...prev, [key(a.qid, i)]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button className="btn-sm" disabled={!!working || busyOuter || dirtyQids.has(a.qid)} onClick={() => approve(a.qid)}>
                  {working === `ok:${a.qid}` ? <Spinner className="w-3.5 h-3.5" /> : "✓"} Goedkeuren
                </button>
                <button className="btn-sm" disabled={!!working || busyOuter || !editable} onClick={() => setOpenRegen(openRegen === a.qid ? null : a.qid)}>
                  ↻ Opnieuw genereren
                </button>
                {dirtyQids.has(a.qid) && <span className="text-xs text-blue-700">Niet-opgeslagen aanpassing</span>}
              </div>
              {openRegen === a.qid && (
                <div className="mt-2 flex flex-wrap gap-2 items-start">
                  <textarea
                    className="input flex-1 min-w-[12rem]"
                    rows={2}
                    placeholder="Wat moet er anders? (optioneel, bv. 'gebruik de formule van het formuleblad')"
                    value={comments[a.qid] || ""}
                    onChange={e => setComments(prev => ({ ...prev, [a.qid]: e.target.value }))}
                  />
                  <button className="btn-sm-red" disabled={!!working} onClick={() => regenerate(a.qid)}>
                    {working === `re:${a.qid}` ? <Spinner className="w-3.5 h-3.5" /> : null} Genereren
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ───────────── gegevens bewerken ───────────── */

function MetaModal({ api, doc, onClose, onSaved }: { api: Api; doc: any; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState<string>(doc.title || "");
  const [vak, setVak] = useState<string>(doc.vak || "");
  const [leerjaar, setLeerjaar] = useState<string>(doc.leerjaar || "");
  const [richting, setRichting] = useState<string>(doc.richting || "");
  const [schooljaar, setSchooljaar] = useState<string>(doc.schooljaar || "");
  const [tags, setTags] = useState<string>((doc.tags || []).join(", "));
  const [note, setNote] = useState<string>(doc.note || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await api.json(`/api/documents/${doc.id}`, {
        method: "PATCH",
        body: {
          title,
          vak,
          leerjaar,
          richting,
          schooljaar,
          note,
          tags: tags
            .split(/[,;\n]/)
            .map(t => t.trim().replace(/^#/, ""))
            .filter(Boolean),
        },
      });
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  }

  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="block">
      <span className="text-xs font-semibold text-gray-600">{label}</span>
      <input className="input mt-1" value={value} onChange={e => set(e.target.value)} />
    </label>
  );

  return (
    <Modal title="Gegevens en tags" onClose={onClose}>
      <div className="space-y-3">
        {field("Titel", title, setTitle)}
        <div className="grid grid-cols-2 gap-3">
          {field("Vak", vak, setVak)}
          {field("Schooljaar", schooljaar, setSchooljaar)}
          {field("Leerjaar", leerjaar, setLeerjaar)}
          {field("Richting", richting, setRichting)}
        </div>
        {field("Tags (gescheiden door komma's)", tags, setTags)}
        <label className="block">
          <span className="text-xs font-semibold text-gray-600">Notitie</span>
          <textarea className="input mt-1" rows={3} value={note} onChange={e => setNote(e.target.value)} />
        </label>
        {err && <Banner tone="error">{err}</Banner>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Annuleren
          </button>
          <button className="btn-primary" onClick={save} disabled={busy || !title.trim()}>
            {busy ? <Spinner className="w-4 h-4" /> : null} Opslaan
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────── sjablonen ───────────── */

function TemplateModal({
  api,
  docId,
  docTitle,
  canApply,
  onClose,
  onDone,
}: {
  api: Api;
  docId: string;
  docTitle: string;
  canApply: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [templates, setTemplates] = useState<any[] | null>(null);
  const [name, setName] = useState(docTitle);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reload = useCallback(async () => {
    try {
      const r = await api.json<{ templates: any[] }>("/api/templates");
      setTemplates(r.templates);
    } catch (e) {
      setErr(errMsg(e));
      setTemplates([]);
    }
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setErr("");
    try {
      onDone(await fn());
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Sjablonen" onClose={onClose} wide>
      <div className="space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Aanduidingen van dit document bewaren als sjabloon</h3>
          <p className="text-xs text-gray-500 mb-2">Handig voor toetsen met dezelfde opmaak: je past de aanduidingen later in één klik toe.</p>
          <div className="flex gap-2">
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Naam van het sjabloon" />
            <button
              className="btn-sm-red whitespace-nowrap"
              disabled={busy || !name.trim()}
              onClick={() =>
                act(async () => {
                  await api.json(`/api/documents/${docId}/template`, { method: "POST", body: { name: name.trim() } });
                  return "Sjabloon opgeslagen.";
                })
              }
            >
              Bewaren
            </button>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-2">Bestaande sjablonen</h3>
          {templates === null ? (
            <Loader />
          ) : templates.length === 0 ? (
            <p className="text-sm text-gray-500">Nog geen sjablonen.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {templates.map(t => (
                <li key={t.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-gray-900">{t.name}</span>
                  <span className="text-xs text-gray-500">
                    {t.owner}
                    {t.vak ? ` · ${t.vak}` : ""}
                    {t.createdAt ? ` · ${formatDate(t.createdAt)}` : ""}
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    {canApply && (
                      <button
                        className="btn-sm"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            const r = await api.json<{ applied: number; skipped: number }>(`/api/documents/${docId}/apply-template`, { method: "POST", body: { templateId: t.id } });
                            return `Sjabloon toegepast: ${r.applied} aanduidingen${r.skipped ? `, ${r.skipped} overgeslagen (paragraaf bestaat niet)` : ""}.`;
                          })
                        }
                      >
                        Toepassen
                      </button>
                    )}
                    <button
                      className="btn-sm"
                      disabled={busy}
                      onClick={async () => {
                        if (!window.confirm(`Sjabloon '${t.name}' verwijderen?`)) return;
                        try {
                          await api.json(`/api/templates/${t.id}`, { method: "DELETE" });
                          await reload();
                        } catch (e) {
                          setErr(errMsg(e));
                        }
                      }}
                    >
                      🗑
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && <Banner tone="error">{err}</Banner>}
      </div>
    </Modal>
  );
}
