import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError } from "./api";
import { AuthPdf, Banner, EmptyState, GeneratingPanel, Loader, Spinner } from "./ui";
import DocView from "./DocView";
import { Mark, Para, ROLE_META, ROLE_ORDER, Role, SLOT_LABEL } from "./markingTypes";

/**
 * Aanduiden (Probleem 2): de leerkracht duidt per alinea aan wat het is.
 * Elke alinea van het document wordt getoond met haar stabiele ID; de aanduiding
 * (vraag, antwoordplaats, gegeven, formuleblad, instructie, modelantwoord) bepaalt
 * waar de code later het rode antwoord invoegt. Werkt met aanraking (grote knoppen).
 */

interface SaveResult {
  saved: number;
  questions: number;
  errors: string[];
  warnings: string[];
}

interface Props {
  api: Api;
  id: string;
  onBack: () => void;
  onDone: (id: string) => void;
}

/** Zelfde logica als de server (marks.js defaultSlot), enkel als voorstel. */
function defaultSlot(p: Para, all: Para[]): { slotType: string; slotCount: number } {
  const idx = all.findIndex(x => x.id === p.id);
  if (p.placeholders > 0) return { slotType: "fill_placeholders", slotCount: p.placeholders };
  if (p.inTable && p.isEmpty) return { slotType: "fill_cell", slotCount: 1 };
  if (p.isEmpty) return { slotType: "append", slotCount: 1 };
  let avail = 0;
  for (let k = idx + 1; k < all.length; k++) {
    const n = all[k];
    if (!n.isEmpty || n.inTable !== p.inTable) break;
    avail++;
  }
  if (avail > 0) return { slotType: "fill_empty_following", slotCount: Math.min(avail, 3) };
  return { slotType: "insert_after", slotCount: 1 };
}

/** Raadt het vraagnummer op basis van het begin van de tekst en de vorige vraag (3 → 3a → 3b → 4). */
function suggestQid(text: string, previousQid: string | null): string {
  const prev = previousQid ? /^(\d+)/.exec(previousQid) : null;
  const top = prev ? Number(prev[1]) : 0;
  const num = /^\s*(?:vraag\s*)?(\d{1,3})\s*[.):]?(?:\s|$)/i.exec(text);
  if (num) return num[1];
  const sub = /^\s*\(?([a-z])[.)]\s/i.exec(text);
  if (sub && top > 0) return `${top}${sub[1].toLowerCase()}`;
  return String(top + 1);
}

function emptyMark(paraId: string, role: Role): Mark {
  return { paraId, role, qid: "", subNr: "", slotType: null, slotCount: null, linkedParaIds: [], teacherAnswer: null };
}

export default function Marking({ api, id, onBack, onDone }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [paras, setParas] = useState<Para[]>([]);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [proposal, setProposal] = useState<Mark[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "propose" | "generate">("");
  const [result, setResult] = useState<SaveResult | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok" | "warn" | "info"; text: string } | null>(null);
  const [context, setContext] = useState("");
  const [showOverview, setShowOverview] = useState(true);
  const [viewMode, setViewMode] = useState<"document" | "lijst">("document");
  const [showOriginal, setShowOriginal] = useState(false);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});
  const [proposalStatus, setProposalStatus] = useState<string>("geen");
  const marksRef = useRef<Record<string, Mark>>({});
  marksRef.current = marks;

  const normalize = useCallback((list: any[]): Mark[] => {
    return (list || []).map(m => ({
      paraId: String(m.paraId),
      role: m.role as Role,
      qid: m.qid || "",
      subNr: m.subNr || "",
      slotType: m.slotType || null,
      slotCount: typeof m.slotCount === "number" ? m.slotCount : null,
      linkedParaIds: Array.isArray(m.linkedParaIds) ? m.linkedParaIds : [],
      teacherAnswer: m.teacherAnswer || null,
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [docRes, res] = await Promise.all([
          api.json<{ document: { title?: string; originalFilename?: string; proposalStatus?: string } }>(`/api/documents/${id}`),
          api.json<{ paragraphs: Para[]; marks: any[]; proposal: any[] }>(`/api/documents/${id}/paragraphs`),
        ]);
        if (cancelled) return;
        setTitle(docRes.document.title || docRes.document.originalFilename || "Document");
        setParas(res.paragraphs);
        const map: Record<string, Mark> = {};
        for (const m of normalize(res.marks)) if (!map[m.paraId]) map[m.paraId] = m;
        setMarks(map);
        const prop = normalize(res.proposal);
        setProposal(prop);
        setProposalStatus(docRes.document.proposalStatus || "geen");
        // Nog geen eigen aanduidingen: begin meteen met het AI-voorstel.
        if (Object.keys(map).length === 0 && prop.length > 0) {
          const ids = new Set(res.paragraphs.map(p => p.id));
          const start: Record<string, Mark> = {};
          for (const m of prop) if (ids.has(m.paraId) && !start[m.paraId]) start[m.paraId] = { ...m };
          setMarks(start);
          setDirty(true);
          setMessage({
            tone: "info",
            text: "Het AI-voorstel is al ingevuld als startpunt. Controleer het, pas aan waar nodig en sla op.",
          });
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Laden mislukt.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, id, normalize]);

  // Terwijl de AI nog een eerste voorstel maakt: elke 4 s controleren.
  useEffect(() => {
    if (proposalStatus !== "bezig") return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const d = await api.json<{ document: { proposalStatus?: string } }>(`/api/documents/${id}`);
        const st = d.document.proposalStatus || "geen";
        if (cancelled || st === "bezig") return;
        const res = await api.json<{ paragraphs: Para[]; proposal: any[] }>(`/api/documents/${id}/paragraphs`);
        if (cancelled) return;
        const prop = normalize(res.proposal);
        setProposal(prop);
        setProposalStatus(st);
        if (st === "klaar" && prop.length > 0 && Object.keys(marksRef.current).length === 0) {
          const ids = new Set(res.paragraphs.map(p => p.id));
          const start: Record<string, Mark> = {};
          for (const m of prop) if (ids.has(m.paraId) && !start[m.paraId]) start[m.paraId] = { ...m };
          setMarks(start);
          setDirty(true);
          setMessage({ tone: "ok", text: "Het AI-voorstel is klaar en ingevuld. Controleer het en sla op." });
        } else if (st === "klaar") {
          setMessage({ tone: "ok", text: "Het AI-voorstel is klaar. Neem het over via de knoppen hieronder." });
        } else if (st === "mislukt") {
          setMessage({ tone: "warn", text: "Het automatische voorstel is mislukt. Je kan het opnieuw laten maken." });
        }
      } catch {
        /* volgende poging */
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [proposalStatus, api, id, normalize]);

  const order = useMemo(() => new Map(paras.map((p, i) => [p.id, i])), [paras]);

  function update(paraId: string, patch: Partial<Mark>) {
    setMarks(prev => (prev[paraId] ? { ...prev, [paraId]: { ...prev[paraId], ...patch } } : prev));
    setDirty(true);
    setResult(null);
  }

  /** Dichtstbijzijnde vorige vraag (in documentvolgorde) als vertrekpunt voor de qid. */
  function previousVraagQid(paraId: string): string | null {
    const idx = order.get(paraId) ?? 0;
    for (let i = idx - 1; i >= 0; i--) {
      const m = marks[paras[i].id];
      if (m && m.role === "vraag" && m.qid) return m.qid;
    }
    return null;
  }

  function setRole(p: Para, role: Role | null) {
    setDirty(true);
    setResult(null);
    setMarks(prev => {
      const next = { ...prev };
      if (!role || prev[p.id]?.role === role) {
        delete next[p.id];
        return next;
      }
      const m = emptyMark(p.id, role);
      const keepAnswer = prev[p.id]?.teacherAnswer || null;
      if (role === "vraag") {
        m.qid = prev[p.id]?.qid || suggestQid(p.text, previousVraagQid(p.id));
        m.teacherAnswer = keepAnswer;
      } else if (role === "antwoordplaats") {
        m.qid = prev[p.id]?.qid || previousVraagQid(p.id) || "";
        const d = defaultSlot(p, paras);
        m.slotType = d.slotType;
        m.slotCount = d.slotCount;
        m.teacherAnswer = keepAnswer;
      }
      next[p.id] = m;
      return next;
    });
  }

  const marksList = useMemo(
    () => Object.values(marks).sort((a, b) => (order.get(a.paraId) ?? 0) - (order.get(b.paraId) ?? 0)),
    [marks, order]
  );

  const knownQids = useMemo(() => {
    const s: string[] = [];
    for (const m of marksList) if (m.qid && !s.includes(m.qid)) s.push(m.qid);
    return s;
  }, [marksList]);

  interface QSummary {
    qid: string;
    vraag: string;
    vraagParaId: string | null;
    slots: number;
    givens: number;
    answer: boolean;
  }
  const overview = useMemo(() => {
    const byId = new Map(paras.map(p => [p.id, p]));
    const map = new Map<string, QSummary>();
    for (const m of marksList) {
      if (!m.qid) continue;
      let s = map.get(m.qid);
      if (!s) {
        s = { qid: m.qid, vraag: "", vraagParaId: null, slots: 0, givens: 0, answer: false };
        map.set(m.qid, s);
      }
      if (m.role === "vraag") {
        if (!s.vraagParaId) s.vraagParaId = m.paraId;
        s.vraag = [s.vraag, byId.get(m.paraId)?.text || ""].filter(Boolean).join(" ").slice(0, 90);
      }
      if (m.role === "antwoordplaats") s.slots++;
      if (m.role === "gegeven") s.givens++;
      if (m.teacherAnswer && m.teacherAnswer.trim()) s.answer = true;
      if (m.role === "modelantwoord") s.answer = true;
    }
    const orphans = marksList.filter(m => m.role === "antwoordplaats" && !m.qid).length;
    return { questions: [...map.values()], orphans };
  }, [marksList, paras]);

  function scrollTo(paraId: string | null) {
    if (!paraId) return;
    setSelected(paraId);
    rowRefs.current[paraId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function propose() {
    setBusy("propose");
    setMessage(null);
    try {
      const res = await api.json<{ proposal: any[] }>(`/api/documents/${id}/propose`, { method: "POST" });
      setProposal(normalize(res.proposal));
      setMessage({
        tone: "ok",
        text: `AI-voorstel klaar (${res.proposal.length} aanduidingen). Neem het over en corrigeer waar nodig.`,
      });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Voorstel mislukt." });
    } finally {
      setBusy("");
    }
  }

  function applyProposal(replace: boolean) {
    if (replace && Object.keys(marks).length > 0 && !window.confirm("Je huidige aanduidingen worden vervangen door het voorstel. Doorgaan?")) return;
    setMarks(prev => {
      const next: Record<string, Mark> = replace ? {} : { ...prev };
      for (const m of proposal) {
        if (!order.has(m.paraId)) continue;
        if (!replace && next[m.paraId]) continue;
        next[m.paraId] = { ...m };
      }
      return next;
    });
    setDirty(true);
    setResult(null);
  }

  function clearAll() {
    if (!window.confirm("Alle aanduidingen wissen?")) return;
    setMarks({});
    setDirty(true);
    setResult(null);
  }

  function payload() {
    const firstVraag = new Map<string, string>();
    for (const m of marksList) if (m.role === "vraag" && m.qid && !firstVraag.has(m.qid)) firstVraag.set(m.qid, m.paraId);
    return marksList.map(m => ({
      paraId: m.paraId,
      role: m.role,
      qid: m.qid.trim(),
      subNr: m.subNr,
      slotType: m.role === "antwoordplaats" ? m.slotType : null,
      slotCount: m.role === "antwoordplaats" ? m.slotCount : null,
      linkedParaIds: m.role === "antwoordplaats" && firstVraag.get(m.qid.trim()) ? [firstVraag.get(m.qid.trim())!] : m.linkedParaIds,
      teacherAnswer: m.teacherAnswer || "",
    }));
  }

  async function save(): Promise<SaveResult | null> {
    setBusy("save");
    setMessage(null);
    try {
      const r = await api.json<SaveResult>(`/api/documents/${id}/marks`, { method: "PUT", body: { marks: payload() } });
      setResult(r);
      setDirty(false);
      return r;
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Bewaren mislukt." });
      return null;
    } finally {
      setBusy("");
    }
  }

  async function saveAndGenerate() {
    const r = await save();
    if (!r) return;
    if (r.errors.length) {
      setMessage({ tone: "error", text: "Los eerst de fouten hieronder op voor je een sleutel genereert." });
      return;
    }
    if (r.questions === 0) {
      setMessage({ tone: "error", text: "Er is nog geen vraag met een antwoordplaats aangeduid." });
      return;
    }
    setBusy("generate");
    try {
      await api.json(`/api/documents/${id}/generate`, { method: "POST", body: context.trim() ? { context } : {} });
      onDone(id);
    } catch (e) {
      const text = e instanceof ApiError || e instanceof Error ? e.message : "Genereren mislukt.";
      setMessage({ tone: "error", text });
      setBusy("");
    }
  }

  function leave() {
    if (dirty && !window.confirm("Er zijn niet-bewaarde wijzigingen. Toch verlaten?")) return;
    onBack();
  }

  function renderEditor(p: Para, m: Mark) {
    const needsCount = m.slotType === "fill_placeholders" || m.slotType === "fill_empty_following";
    const hasVraagForQid = marksList.some(x => x.role === "vraag" && x.qid && x.qid === m.qid);
    const showAnswer = m.role === "vraag" || (m.role === "antwoordplaats" && !hasVraagForQid);
    return (
      <div className="mt-3 pt-3 border-t border-gray-200 space-y-3" onClick={e => e.stopPropagation()}>
        <p className="text-xs text-gray-500">{ROLE_META[m.role].hint}</p>
        {(m.role === "vraag" || m.role === "antwoordplaats" || m.role === "gegeven" || m.role === "modelantwoord") && (
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-gray-600 mb-1">
                {m.role === "gegeven" ? "Hoort bij vraag (leeg = geldt voor alles)" : "Vraagnummer (koppelt de onderdelen)"}
              </span>
              <input
                className="input"
                list="mk-qids"
                value={m.qid}
                onChange={e => update(p.id, { qid: e.target.value })}
                placeholder="bv. 3b"
                inputMode="text"
              />
            </label>
            {m.role === "antwoordplaats" && (
              <label className="text-sm">
                <span className="block text-gray-600 mb-1">Waar komt het antwoord?</span>
                <select
                  className="input"
                  value={m.slotType || ""}
                  onChange={e => update(p.id, { slotType: e.target.value, slotCount: defaultCountFor(e.target.value, p) })}
                >
                  {Object.entries(SLOT_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {m.role === "antwoordplaats" && needsCount && (
              <label className="text-sm">
                <span className="block text-gray-600 mb-1">
                  {m.slotType === "fill_placeholders" ? "Aantal invulpunten" : "Aantal lege regels"}
                </span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  className="input"
                  value={m.slotCount ?? 1}
                  onChange={e => update(p.id, { slotCount: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })}
                />
              </label>
            )}
          </div>
        )}
        {showAnswer && (
          <label className="block text-sm">
            <span className="block text-gray-600 mb-1">Eigen antwoord (optioneel, heeft voorrang op de AI)</span>
            <textarea
              className="input min-h-[4.5rem]"
              value={m.teacherAnswer || ""}
              onChange={e => update(p.id, { teacherAnswer: e.target.value })}
              placeholder="Laat leeg als de AI het mag oplossen."
            />
          </label>
        )}
        <div className="flex justify-end">
          <button type="button" className="btn-sm" onClick={() => setRole(p, null)}>
            Aanduiding wissen
          </button>
        </div>
      </div>
    );
  }

  function defaultCountFor(slotType: string, p: Para): number {
    if (slotType === "fill_placeholders") return Math.max(1, p.placeholders);
    if (slotType === "fill_empty_following") {
      const d = defaultSlot(p, paras);
      return d.slotType === "fill_empty_following" ? d.slotCount : 1;
    }
    return 1;
  }

  function renderParagraph(p: Para) {
    if (p.isPageBreak && p.isEmpty) {
      return (
        <div key={p.id} className="py-1 text-center text-xs text-gray-400 border-t border-dashed border-gray-300">
          paginaeinde
        </div>
      );
    }
    const m = marks[p.id];
    const isSel = selected === p.id;
    const meta = m ? ROLE_META[m.role] : null;
    const prop: Mark | undefined = m ? undefined : proposal.find(x => x.paraId === p.id);
    const heading = p.headingLevel ? (p.headingLevel === 1 ? "text-xl font-bold" : p.headingLevel === 2 ? "text-lg font-semibold" : "font-semibold") : "";
    return (
      <div
        key={p.id}
        ref={el => {
          rowRefs.current[p.id] = el;
        }}
        onClick={() => setSelected(isSel ? null : p.id)}
        className={`rounded-lg border border-l-4 px-3 py-2.5 cursor-pointer transition-colors ${
          meta ? `${meta.bar} ${meta.bg}` : "border-l-transparent bg-white hover:bg-gray-50"
        } ${isSel ? "border-gray-400 shadow" : "border-gray-200"} ${p.inTable ? "ml-4" : ""}`}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
              <code className="text-[10px] text-gray-400">{p.id}</code>
              {p.inTable && p.tableCoord && (
                <span className="chip">
                  tabel r{p.tableCoord.row + 1} · c{p.tableCoord.cell + 1}
                </span>
              )}
              {p.placeholders > 0 && (
                <span className="chip">
                  {p.placeholders} invulpunt{p.placeholders > 1 ? "en" : ""}
                </span>
              )}
              {m && (
                <span className="chip font-medium">
                  {ROLE_META[m.role].label}
                  {m.qid ? ` · ${m.qid}` : ""}
                </span>
              )}
              {prop && (
                <span className="chip text-gray-500" title="Voorstel van de AI">
                  AI: {ROLE_META[prop.role as Role]?.label}
                  {prop.qid ? ` · ${prop.qid}` : ""}
                </span>
              )}
            </div>
            {p.isEmpty ? (
              <p className="text-sm italic text-gray-400">(lege regel)</p>
            ) : (
              <p className={`whitespace-pre-wrap break-words text-gray-800 ${heading || (p.bold ? "font-semibold" : "")}`}>
                {p.isList && <span className="mr-1.5 text-gray-400">•</span>}
                {p.text}
              </p>
            )}
          </div>
        </div>
        {isSel && (
          <div onClick={e => e.stopPropagation()}>
            <div className="mt-3 flex flex-wrap gap-2">
              {ROLE_ORDER.map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(p, r)}
                  className={`min-h-[44px] px-3 rounded-lg border text-sm font-medium transition-colors ${
                    m?.role === r ? ROLE_META[r].active : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                  aria-pressed={m?.role === r}
                >
                  {ROLE_META[r].label}
                </button>
              ))}
            </div>
            {m && renderEditor(p, m)}
          </div>
        )}
      </div>
    );
  }

  if (loading) return <Loader text="Alinea's laden…" />;
  if (loadError)
    return (
      <div className="space-y-3">
        <Banner tone="error">{loadError}</Banner>
        <button className="btn-secondary" onClick={onBack}>
          ← Terug
        </button>
      </div>
    );

  const selectedPara = selected ? paras.find(p => p.id === selected) || null : null;
  const markCount = marksList.length;
  const generating = busy === "generate";

  return (
    <div className="space-y-4">
      <datalist id="mk-qids">
        {knownQids.map(q => (
          <option key={q} value={q} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary" onClick={leave}>
          ← Terug
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-gray-900 truncate">Aanduiden: {title}</h2>
          <p className="text-xs text-gray-500">
            {viewMode === "document"
              ? "Klik in het voorbeeld op de tekst die je wil aanduiden: is het de vraag, of staat daar het antwoord? Zo weet de robot precies waar elk antwoord komt."
              : "Tik op een alinea en kies wat het is. Zo weet de robot precies waar elk antwoord komt."}
          </p>
        </div>
      </div>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {(busy === "propose" || proposalStatus === "bezig") && (
        <GeneratingPanel
          compact
          title="De AI maakt een voorstel…"
          steps={["Document lezen", "Vragen en antwoordplaatsen herkennen", "Voorstel controleren"]}
        >
          De aanduidingen verschijnen automatisch in het document zodra de AI klaar is.
        </GeneratingPanel>
      )}
      {generating && (
        <GeneratingPanel
          compact
          title="De AI genereert de antwoordsleutel…"
          steps={["Aanduidingen bewaren", "Elke vraag oplossen", "Antwoorden in rood invoegen", "Controle en voorbeeld maken"]}
        >
          Sluit dit scherm niet tot de sleutel klaar is.
        </GeneratingPanel>
      )}

      <div className="card p-4 space-y-3 sticky top-2 z-20">
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={propose} disabled={busy !== ""}>
            {busy === "propose" ? (
              <span className="inline-flex items-center gap-2">
                <Spinner className="w-4 h-4" /> AI bekijkt het document…
              </span>
            ) : proposal.length ? (
              "AI-voorstel vernieuwen"
            ) : (
              "AI laat een voorstel doen"
            )}
          </button>
          {proposal.length > 0 && (
            <>
              <button className="btn-sm" onClick={() => applyProposal(false)} disabled={busy !== ""} title="Vult enkel alinea's aan die je nog niet aanduidde">
                Voorstel aanvullen
              </button>
              <button className="btn-sm" onClick={() => applyProposal(true)} disabled={busy !== ""}>
                Voorstel overnemen (vervangt)
              </button>
            </>
          )}
          {markCount > 0 && (
            <button className="btn-sm-red" onClick={clearAll} disabled={busy !== ""}>
              Alles wissen
            </button>
          )}
          <span className="ml-auto text-sm text-gray-500">
            {markCount} aangeduid · {overview.questions.length} vra{overview.questions.length === 1 ? "ag" : "gen"}
            {dirty ? " · niet bewaard" : ""}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => save()} disabled={busy !== ""}>
            {busy === "save" ? "Bewaren…" : "Bewaar aanduidingen"}
          </button>
          <button className="btn-primary" onClick={saveAndGenerate} disabled={busy !== "" || markCount === 0}>
            {generating ? (
              <span className="inline-flex items-center gap-2">
                <Spinner className="w-4 h-4" /> Sleutel wordt gemaakt…
              </span>
            ) : (
              "Bewaar en maak sleutel"
            )}
          </button>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-gray-600">Extra uitleg voor de AI (optioneel)</summary>
          <textarea
            className="input mt-2 min-h-[4rem]"
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder="bv. 'Rond af op 2 decimalen' of 'Leerjaar 3 — gebruik de formules van het formuleblad'."
          />
        </details>

        {generating && <p className="text-xs text-gray-500">Dit kan enkele minuten duren. Sluit dit scherm niet.</p>}
      </div>

      {result && (result.errors.length > 0 || result.warnings.length > 0 || result.questions > 0) && (
        <div className="space-y-2">
          {result.errors.length > 0 && (
            <Banner tone="error">
              <p className="font-medium mb-1">Dit moet je nog oplossen:</p>
              <ul className="list-disc ml-5 space-y-0.5">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Banner>
          )}
          {result.warnings.length > 0 && (
            <Banner tone="warn">
              <p className="font-medium mb-1">Let op:</p>
              <ul className="list-disc ml-5 space-y-0.5">
                {result.warnings.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Banner>
          )}
          {result.errors.length === 0 && (
            <Banner tone="ok">
              Bewaard: {result.saved} aanduidingen, {result.questions} vra{result.questions === 1 ? "ag" : "gen"} klaar om op te lossen.
            </Banner>
          )}
        </div>
      )}

      {markCount > 0 && (
        <div className="card p-4">
          <button className="w-full flex items-center justify-between text-left" onClick={() => setShowOverview(v => !v)}>
            <span className="font-medium text-gray-800">Overzicht van de vragen</span>
            <span className="text-gray-400 text-sm">{showOverview ? "verberg" : "toon"}</span>
          </button>
          {showOverview && (
            <div className="mt-3 space-y-2">
              {overview.orphans > 0 && (
                <p className="text-sm text-amber-700">
                  {overview.orphans} antwoordplaats(en) zonder vraagnummer: die krijgen elk een eigen vraag.
                </p>
              )}
              {overview.questions.length === 0 ? (
                <p className="text-sm text-gray-500">Nog geen vragen.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {overview.questions.map(q => (
                    <li key={q.qid}>
                      <button
                        type="button"
                        className="w-full text-left py-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-gray-50 rounded px-1"
                        onClick={() => scrollTo(q.vraagParaId)}
                      >
                        <span className="chip font-semibold">{q.qid}</span>
                        <span className="flex-1 min-w-0 truncate text-sm text-gray-700">{q.vraag || "(geen vraagtekst aangeduid)"}</span>
                        <span className={`text-xs ${q.slots === 0 ? "text-red-600 font-medium" : "text-gray-500"}`}>
                          {q.slots} antwoordplaats{q.slots === 1 ? "" : "en"}
                        </span>
                        {q.givens > 0 && <span className="text-xs text-gray-500">{q.givens} gegeven</span>}
                        {q.answer && <span className="text-xs text-green-700">eigen antwoord</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {ROLE_ORDER.map(r => (
          <span key={r} className={`px-2 py-1 rounded border-l-4 ${ROLE_META[r].bar} ${ROLE_META[r].bg} text-gray-700`}>
            {ROLE_META[r].label}
          </span>
        ))}
      </div>

      {paras.length === 0 ? (
        <EmptyState icon="📄" title="Geen alinea's gevonden">
          Dit document bevat geen tekst die aangeduid kan worden.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden" role="group" aria-label="Weergave">
              {(["document", "lijst"] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setViewMode(v)}
                  aria-pressed={viewMode === v}
                  className={`px-3 py-1.5 text-sm font-medium ${
                    viewMode === v ? "bg-gray-800 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {v === "document" ? "Voorbeeld van het document" : "Lijst met alinea's"}
                </button>
              ))}
            </div>
            <button type="button" className="btn-sm" onClick={() => setShowOriginal(v => !v)}>
              {showOriginal ? "Origineel verbergen" : "Origineel bekijken (pdf)"}
            </button>
          </div>

          {showOriginal && (
            <div className="card p-3 space-y-2">
              <p className="text-xs text-gray-500">
                Zo ziet het originele document eruit. Gebruik het als houvast; aanduiden doe je in het voorbeeld hierboven.
              </p>
              <AuthPdf api={api} url={`/api/documents/${id}/preview/original/pdf`} title="Origineel document" />
            </div>
          )}

          {viewMode === "document" ? (
            <div className="pb-4">
              <DocView
                paras={paras}
                marks={marks}
                proposal={proposal}
                selected={selected}
                onSelect={setSelected}
                setRef={(pid, el) => {
                  rowRefs.current[pid] = el;
                }}
              />
            </div>
          ) : (
            <div className="space-y-1.5 pb-24">{paras.map(renderParagraph)}</div>
          )}

          {viewMode === "document" && selectedPara && (
            <div className="card p-4 sticky bottom-2 z-20 max-h-[60vh] overflow-y-auto shadow-lg border-gray-400">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500">
                    <code>{selectedPara.id}</code>
                    {selectedPara.inTable && selectedPara.tableCoord
                      ? ` · tabel rij ${selectedPara.tableCoord.row}, cel ${selectedPara.tableCoord.cell}`
                      : ""}
                  </p>
                  <p className="text-sm text-gray-800 truncate">
                    {selectedPara.isEmpty ? "(lege regel)" : selectedPara.text}
                  </p>
                </div>
                <button type="button" className="btn-sm" onClick={() => setSelected(null)}>
                  Sluiten
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {ROLE_ORDER.map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(selectedPara, r)}
                    className={`min-h-[44px] px-3 rounded-lg border text-sm font-medium transition-colors ${
                      marks[selectedPara.id]?.role === r
                        ? ROLE_META[r].active
                        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                    }`}
                    aria-pressed={marks[selectedPara.id]?.role === r}
                    title={ROLE_META[r].hint}
                  >
                    {ROLE_META[r].label}
                  </button>
                ))}
              </div>
              {marks[selectedPara.id] && renderEditor(selectedPara, marks[selectedPara.id])}
            </div>
          )}
        </>
      )}
    </div>
  );
}
