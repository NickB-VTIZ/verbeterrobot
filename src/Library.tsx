import { useCallback, useEffect, useMemo, useRef, useState, DragEvent } from "react";
import { Api, DocItem, STATUS_LABEL, STATUS_TONE, formatDate, saveBlob } from "./api";
import { AuthImage, Banner, EmptyState, Loader, Modal, PurgeDialog, Spinner } from "./ui";

interface Options {
  vakken: string[];
  leerkrachten: string[];
  leerjaren: string[];
  richtingen: string[];
  schooljaren: string[];
  tags: string[];
  statussen: string[];
}

interface Props {
  api: Api;
  role: "teacher" | "admin";
  userName: string;
  maxMb: number;
  onOpen: (id: string, view?: "detail" | "mark") => void;
  onQuickTool: () => void;
}

const ACCEPT = ".docx,.pdf,.pptx,.xlsx,.xls,.txt";

function currentSchoolYear() {
  const d = new Date();
  const y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${y + 1}`;
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status] || "bg-gray-100 text-gray-700"}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export default function Library({ api, role, userName, maxMb, onOpen, onQuickTool }: Props) {
  const [items, setItems] = useState<DocItem[]>([]);
  const [total, setTotal] = useState(0);
  const [options, setOptions] = useState<Options | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [vak, setVak] = useState("");
  const [teacher, setTeacher] = useState("");
  const [leerjaar, setLeerjaar] = useState("");
  const [richting, setRichting] = useState("");
  const [schooljaar, setSchooljaar] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState("nieuwste");
  const [groupBy, setGroupBy] = useState<"" | "vak" | "schooljaar">("");
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem("vr-view") as "grid" | "list") || "grid");
  const [trash, setTrash] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null);
  const [tagModal, setTagModal] = useState<"tags_add" | "tags_remove" | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    localStorage.setItem("vr-view", view);
  }, [view]);

  const loadOptions = useCallback(async () => {
    try {
      setOptions(await api.json<Options>("/api/library/options"));
    } catch {
      /* filters zijn optioneel */
    }
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams();
      if (dq) p.set("q", dq);
      if (vak) p.set("vak", vak);
      if (teacher) p.set("teacher", teacher);
      if (leerjaar) p.set("leerjaar", leerjaar);
      if (richting) p.set("richting", richting);
      if (schooljaar) p.set("schooljaar", schooljaar);
      if (status) p.set("status", status);
      if (tag) p.set("tag", tag);
      if (trash) p.set("trash", "1");
      p.set("sort", sort);
      p.set("limit", "300");
      const r = await api.json<{ total: number; items: DocItem[] }>(`/api/library?${p.toString()}`);
      setItems(r.items);
      setTotal(r.total);
      setSelected(prev => new Set([...prev].filter(id => r.items.some(i => i.id === id))));
    } catch (e: any) {
      if (e.status !== 401) setError(e.message || "Laden mislukt.");
    } finally {
      setLoading(false);
    }
  }, [api, dq, vak, teacher, leerjaar, richting, schooljaar, status, tag, trash, sort]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const anyFilter = !!(dq || vak || teacher || leerjaar || richting || schooljaar || status || tag);
  function clearFilters() {
    setQ("");
    setVak("");
    setTeacher("");
    setLeerjaar("");
    setRichting("");
    setSchooljaar("");
    setStatus("");
    setTag("");
  }

  function toggle(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  const allSelected = items.length > 0 && items.every(i => selected.has(i.id));
  const ids = [...selected];

  const groups = useMemo(() => {
    if (!groupBy) return [{ label: "", items }];
    const map = new Map<string, DocItem[]>();
    for (const i of items) {
      const k = (groupBy === "vak" ? i.vak : i.schooljaar) || (groupBy === "vak" ? "(geen vak)" : "(geen schooljaar)");
      map.set(k, [...(map.get(k) || []), i]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "nl")).map(([label, its]) => ({ label, items: its }));
  }, [items, groupBy]);

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const r = await api.json<{ done: string[]; skipped: { id: string; reden: string }[] }>("/api/library/bulk", {
        method: "POST",
        body: { ids, action, ...extra },
      });
      setNotice(`${r.done.length} document(en) bijgewerkt.` + (r.skipped.length ? ` Overgeslagen: ${r.skipped.map(s => s.reden).join("; ")}` : ""));
      setSelected(new Set());
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setError(e.message || "Actie mislukt.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadZip(includeOriginals: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/library/zip", {
        method: "POST",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids, includeOriginals }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Serverfout (${res.status})`);
      }
      saveBlob(await res.blob(), "verbetersleutels.zip");
    } catch (e: any) {
      setError(e.message || "Downloaden mislukt.");
    } finally {
      setBusy(false);
    }
  }

  // Gewone functies (geen componenten) zodat miniaturen niet opnieuw geladen worden bij elke selectie.
  function renderCard(d: DocItem) {
    const sel = selected.has(d.id);
    return (
      <div className={`card overflow-hidden flex flex-col ${sel ? "ring-2 ring-red-500" : ""}`}>
        <div className="relative">
          <button type="button" onClick={() => onOpen(d.id)} className="block w-full text-left" aria-label={`Open ${d.title}`}>
            <div className="grid grid-cols-2 gap-px bg-gray-200 h-40">
              <AuthImage api={api} url={d.thumbFileId ? `/api/documents/${d.id}/preview/original/thumb` : null} alt="Origineel" className="w-full h-40 object-cover object-top bg-white" />
              <AuthImage
                api={api}
                url={d.keyThumbFileId && d.activeVersion ? `/api/documents/${d.id}/preview/version/${d.activeVersion}/thumb` : null}
                alt="Sleutel"
                className="w-full h-40 object-cover object-top bg-white"
              />
            </div>
          </button>
          <label className="absolute top-2 left-2 bg-white/90 rounded p-1 shadow cursor-pointer">
            <input type="checkbox" checked={sel} onChange={() => toggle(d.id)} aria-label="Selecteer" className="w-4 h-4" />
          </label>
        </div>
        <div className="p-3 flex-1 flex flex-col gap-1.5">
          <button type="button" onClick={() => onOpen(d.id)} className="text-left font-semibold text-sm text-gray-900 hover:text-red-700 line-clamp-2 break-words">
            {d.title}
          </button>
          <div className="text-xs text-gray-500 flex flex-wrap gap-x-2">
            {d.vak && <span>{d.vak}</span>}
            {role === "admin" && <span>· {d.teacher}</span>}
            <span>· {formatDate(d.createdAt).split(" ")[0]}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
            <StatusPill status={d.status} />
            <span className="chip">{d.versionCount ?? 0} versie{(d.versionCount ?? 0) === 1 ? "" : "s"}</span>
            {d.tags.slice(0, 3).map(t => (
              <span key={t} className="chip">
                #{t}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function renderRow(d: DocItem) {
    return (
      <tr key={d.id} className={`border-t border-gray-100 hover:bg-gray-50/60 ${selected.has(d.id) ? "bg-red-50/60" : ""}`}>
        <td className="px-3 py-2">
          <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} aria-label="Selecteer" className="w-4 h-4" />
        </td>
        <td className="px-2 py-2">
          <button type="button" onClick={() => onOpen(d.id)} className="text-left font-medium text-gray-900 hover:text-red-700">
            {d.title}
          </button>
          <div className="text-xs text-gray-500">{d.originalFilename}</div>
        </td>
        <td className="px-2 py-2 text-sm text-gray-600 hidden md:table-cell">{d.vak}</td>
        {role === "admin" && <td className="px-2 py-2 text-sm text-gray-600 hidden md:table-cell">{d.teacher}</td>}
        <td className="px-2 py-2 text-sm text-gray-600 hidden lg:table-cell">{[d.leerjaar, d.richting].filter(Boolean).join(" · ")}</td>
        <td className="px-2 py-2 text-sm text-gray-600 hidden lg:table-cell">{d.schooljaar}</td>
        <td className="px-2 py-2">
          <StatusPill status={d.status} />
        </td>
        <td className="px-2 py-2 text-center text-sm text-gray-600">{d.versionCount ?? 0}</td>
        <td className="px-2 py-2 text-xs text-gray-500 hidden sm:table-cell">{formatDate(d.updatedAt)}</td>
      </tr>
    );
  }

  const sel = (label: string, value: string, set: (v: string) => void, opts: string[]) => (
    <select className="input !w-auto min-w-[8rem]" value={value} onChange={e => set(e.target.value)} aria-label={label}>
      <option value="">{label}</option>
      {opts.map(o => (
        <option key={o} value={o}>
          {STATUS_LABEL[o] || o}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-5">
      {/* Titel + acties */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">{trash ? "Prullenbak" : role === "admin" ? "Alle documenten" : "Mijn documenten"}</h2>
          <p className="text-sm text-gray-500">
            {total} document{total === 1 ? "" : "en"}
            {role === "teacher" && userName ? ` van ${userName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-sm" onClick={() => setTrash(t => !t)}>
            {trash ? "← Terug naar bibliotheek" : "🗑 Prullenbak"}
          </button>
          {!trash && (
            <>
              <button type="button" className="btn-sm" onClick={onQuickTool} title="Upload en krijg meteen een sleutel, zonder aanduiden">
                ⚡ Snel verbeteren
              </button>
              <button type="button" className="btn-sm-red" onClick={() => setShowUpload(true)}>
                + Nieuw document
              </button>
            </>
          )}
        </div>
      </div>

      {/* Zoeken + filters */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input
            className="input flex-1 min-w-[12rem]"
            type="search"
            placeholder="Zoek in titel, tags en inhoud…"
            value={q}
            onChange={e => setQ(e.target.value)}
            aria-label="Zoeken"
          />
          <select className="input !w-auto" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sorteren">
            <option value="nieuwste">Nieuwste eerst</option>
            <option value="oudste">Oudste eerst</option>
            <option value="gewijzigd">Laatst gewijzigd</option>
            <option value="titel">Titel A–Z</option>
            <option value="vak">Vak</option>
            {role === "admin" && <option value="leerkracht">Leerkracht</option>}
            <option value="status">Status</option>
          </select>
          <select className="input !w-auto" value={groupBy} onChange={e => setGroupBy(e.target.value as "" | "vak" | "schooljaar")} aria-label="Groeperen">
            <option value="">Niet groeperen</option>
            <option value="vak">Groepeer per vak</option>
            <option value="schooljaar">Groepeer per schooljaar</option>
          </select>
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden" role="group" aria-label="Weergave">
            <button type="button" onClick={() => setView("grid")} className={`px-3 text-sm ${view === "grid" ? "bg-red-600 text-white" : "bg-white text-gray-600"}`} aria-pressed={view === "grid"}>
              ▦
            </button>
            <button type="button" onClick={() => setView("list")} className={`px-3 text-sm ${view === "list" ? "bg-red-600 text-white" : "bg-white text-gray-600"}`} aria-pressed={view === "list"}>
              ☰
            </button>
          </div>
        </div>
        {options && (
          <div className="flex flex-wrap gap-2 items-center">
            {sel("Alle vakken", vak, setVak, options.vakken)}
            {role === "admin" && sel("Alle leerkrachten", teacher, setTeacher, options.leerkrachten)}
            {sel("Alle leerjaren", leerjaar, setLeerjaar, options.leerjaren)}
            {sel("Alle richtingen", richting, setRichting, options.richtingen)}
            {sel("Alle schooljaren", schooljaar, setSchooljaar, options.schooljaren)}
            {!trash && sel("Alle statussen", status, setStatus, options.statussen)}
            {sel("Alle tags", tag, setTag, options.tags)}
            {anyFilter && (
              <button type="button" className="text-xs text-red-600 hover:underline" onClick={clearFilters}>
                Filters wissen
              </button>
            )}
          </div>
        )}
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      {/* Bulkbalk */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 card px-3 py-2 flex flex-wrap items-center gap-2 shadow-md">
          <strong className="text-sm mr-1">{selected.size} geselecteerd</strong>
          {!trash ? (
            <>
              <button className="btn-sm" disabled={busy} onClick={() => setTagModal("tags_add")}>
                + Tags
              </button>
              <button className="btn-sm" disabled={busy} onClick={() => setTagModal("tags_remove")}>
                − Tags
              </button>
              <button className="btn-sm" disabled={busy} onClick={() => downloadZip(false)}>
                ⬇ ZIP sleutels
              </button>
              <button className="btn-sm" disabled={busy} onClick={() => downloadZip(true)}>
                ⬇ ZIP + originelen
              </button>
              <button
                className="btn-sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`${selected.size} document(en) naar de prullenbak verplaatsen? Je kan ze herstellen.`)) bulk("delete");
                }}
              >
                🗑 Naar prullenbak
              </button>
            </>
          ) : (
            <>
              <button className="btn-sm" disabled={busy} onClick={() => bulk("restore")}>
                ↩ Herstellen
              </button>
              <button className="btn-sm-red" disabled={busy} onClick={() => setPurgeIds(ids)}>
                Definitief verwijderen…
              </button>
            </>
          )}
          <button className="text-xs text-gray-500 hover:underline ml-auto" onClick={() => setSelected(new Set())}>
            Selectie wissen
          </button>
        </div>
      )}

      {/* Inhoud */}
      {loading && items.length === 0 ? (
        <Loader text="Documenten laden…" />
      ) : items.length === 0 ? (
        trash ? (
          <EmptyState icon="🗑" title="De prullenbak is leeg">
            Verwijderde documenten blijven hier staan tot ze definitief verwijderd worden.
          </EmptyState>
        ) : anyFilter ? (
          <EmptyState icon="🔍" title="Geen documenten gevonden">
            Pas je zoekopdracht of filters aan.{" "}
            <button className="text-red-600 hover:underline" onClick={clearFilters}>
              Filters wissen
            </button>
          </EmptyState>
        ) : (
          <EmptyState icon="📚" title="Nog geen documenten">
            Upload je eerste toets of taak om te beginnen.
            <div className="mt-4">
              <button className="btn-primary" onClick={() => setShowUpload(true)}>
                + Nieuw document
              </button>
            </div>
          </EmptyState>
        )
      ) : (
        <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>
          {view === "list" && (
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map(i => i.id)))}
                className="w-4 h-4"
              />
              Alles selecteren
            </label>
          )}
          {groups.map(g => (
            <section key={g.label || "alle"}>
              {g.label && (
                <h3 className="text-sm font-semibold text-gray-700 mb-2 border-b border-gray-200 pb-1">
                  {g.label} <span className="text-gray-400 font-normal">({g.items.length})</span>
                </h3>
              )}
              {view === "grid" ? (
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {g.items.map(d => (
                    <div key={d.id}>{renderCard(d)}</div>
                  ))}
                </div>
              ) : (
                <div className="card overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="text-xs text-gray-500 bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 w-8"></th>
                        <th className="px-2 py-2">Titel</th>
                        <th className="px-2 py-2 hidden md:table-cell">Vak</th>
                        {role === "admin" && <th className="px-2 py-2 hidden md:table-cell">Leerkracht</th>}
                        <th className="px-2 py-2 hidden lg:table-cell">Leerjaar / richting</th>
                        <th className="px-2 py-2 hidden lg:table-cell">Schooljaar</th>
                        <th className="px-2 py-2">Status</th>
                        <th className="px-2 py-2 text-center">Versies</th>
                        <th className="px-2 py-2 hidden sm:table-cell">Gewijzigd</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map(d => renderRow(d))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {showUpload && (
        <UploadModal
          api={api}
          maxMb={maxMb}
          options={options}
          onClose={() => setShowUpload(false)}
          onCreated={(id, goMark) => {
            setShowUpload(false);
            loadOptions();
            onOpen(id, goMark ? "mark" : "detail");
          }}
        />
      )}

      {tagModal && (
        <Modal title={tagModal === "tags_add" ? "Tags toevoegen" : "Tags verwijderen"} onClose={() => setTagModal(null)}>
          <form
            className="space-y-3"
            onSubmit={e => {
              e.preventDefault();
              const tags = tagInput.split(",").map(t => t.trim()).filter(Boolean);
              if (!tags.length) return;
              const a = tagModal;
              setTagModal(null);
              setTagInput("");
              bulk(a, { tags });
            }}
          >
            <p className="text-sm text-gray-600">Voor {selected.size} geselecteerde document(en). Meerdere tags scheid je met een komma.</p>
            <input className="input" autoFocus value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="bv. examen, herhaling" list="lib-tags" />
            <datalist id="lib-tags">
              {(options?.tags || []).map(t => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setTagModal(null)}>
                Annuleren
              </button>
              <button type="submit" className="btn-primary" disabled={!tagInput.trim()}>
                Toepassen
              </button>
            </div>
          </form>
        </Modal>
      )}

      {purgeIds && (
        <PurgeDialog
          api={api}
          ids={purgeIds}
          onCancel={() => setPurgeIds(null)}
          onDone={msg => {
            setPurgeIds(null);
            setSelected(new Set());
            setNotice(msg);
            load();
            loadOptions();
          }}
        />
      )}
    </div>
  );
}

/* ───────────── upload ───────────── */

function UploadModal({
  api,
  maxMb,
  options,
  onClose,
  onCreated,
}: {
  api: Api;
  maxMb: number;
  options: Options | null;
  onClose: () => void;
  onCreated: (id: string, goMark: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [title, setTitle] = useState("");
  const [vak, setVak] = useState("");
  const [subjects, setSubjects] = useState<{ id: string; naam: string }[]>([]);
  const [leerjaar, setLeerjaar] = useState("");
  const [richting, setRichting] = useState("");
  const [schooljaar, setSchooljaar] = useState(currentSchoolYear());
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dups, setDups] = useState<{ id: string; title: string }[] | null>(null);
  const [createdId, setCreatedId] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .json<any>("/api/subjects")
      .then(d => setSubjects(Array.isArray(d) ? d : Array.isArray(d.subjects) ? d.subjects : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(f: File | undefined | null) {
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["docx", "pdf", "pptx", "xlsx", "xls", "txt"].includes(ext)) {
      setErr(`Bestandstype .${ext} is niet toegelaten.`);
      return;
    }
    if (f.size > maxMb * 1024 * 1024) {
      setErr(`Bestand is te groot (max ${maxMb} MB).`);
      return;
    }
    setErr("");
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title.trim());
      const subj = subjects.find(s => s.naam === vak);
      if (subj) form.append("subjectId", subj.id);
      else if (vak.trim()) form.append("vak", vak.trim());
      form.append("leerjaar", leerjaar.trim());
      form.append("richting", richting.trim());
      form.append("schooljaar", schooljaar.trim());
      form.append("tags", tags);
      const r = await api.json<{ document: DocItem; duplicates: { id: string; title: string }[] }>("/api/documents", { method: "POST", body: form });
      if (r.duplicates?.length) {
        setDups(r.duplicates);
        setCreatedId(r.document.id);
      } else {
        onCreated(r.document.id, file.name.toLowerCase().endsWith(".docx"));
      }
    } catch (e: any) {
      setErr(e.message || "Uploaden mislukt.");
    } finally {
      setBusy(false);
    }
  }

  const ext = file?.name.split(".").pop()?.toLowerCase();

  if (dups) {
    return (
      <Modal title="Dit bestand bestaat al" onClose={() => onCreated(createdId, false)}>
        <div className="space-y-3">
          <Banner tone="warn">Er staat al een identiek bestand in de bibliotheek:</Banner>
          <ul className="list-disc pl-5 text-sm text-gray-700">
            {dups.map(d => (
              <li key={d.id}>{d.title}</li>
            ))}
          </ul>
          <p className="text-sm text-gray-500">Het nieuwe document is toch toegevoegd. Je kan het later verwijderen als dat niet de bedoeling was.</p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => onCreated(createdId, ext === "docx")}>
              Verder
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Nieuw document" onClose={onClose} wide>
      <div className="space-y-4">
        <div
          className={`drop-zone ${drag ? "active" : "hover:border-red-400 hover:bg-red-50/50"}`}
          onDragOver={e => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        >
          <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={e => pick(e.target.files?.[0])} />
          {file ? (
            <div className="text-center">
              <div className="text-3xl mb-1">📄</div>
              <p className="text-sm font-semibold text-gray-900">{file.name}</p>
              <p className="text-xs text-gray-500">Klik om een ander bestand te kiezen</p>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-3xl mb-1">⬆️</div>
              <p className="text-sm font-semibold text-gray-700">Sleep een bestand hierheen of tik om te kiezen</p>
              <p className="text-xs text-gray-500">.docx (aanbevolen), .pdf, .pptx, .xlsx, .txt — max {maxMb} MB</p>
            </div>
          )}
        </div>
        {file && ext !== "docx" && <Banner tone="info">Het aanduiden van vragen en antwoordplaatsen werkt enkel voor Word-bestanden (.docx).</Banner>}

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="sm:col-span-2 text-sm">
            <span className="block text-gray-600 mb-1">Titel</span>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="bv. Toets hoofdstuk 3" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Vak</span>
            <input className="input" list="up-vakken" value={vak} onChange={e => setVak(e.target.value)} placeholder="bv. Wiskunde" />
            <datalist id="up-vakken">
              {[...new Set([...subjects.map(s => s.naam), ...(options?.vakken || [])])].map(v => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Schooljaar</span>
            <input className="input" value={schooljaar} onChange={e => setSchooljaar(e.target.value)} list="up-sj" />
            <datalist id="up-sj">
              {(options?.schooljaren || []).map(v => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Leerjaar</span>
            <input className="input" value={leerjaar} onChange={e => setLeerjaar(e.target.value)} list="up-lj" placeholder="bv. 3" />
            <datalist id="up-lj">
              {(options?.leerjaren || []).map(v => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">Richting</span>
            <input className="input" value={richting} onChange={e => setRichting(e.target.value)} list="up-ri" placeholder="bv. Elektriciteit" />
            <datalist id="up-ri">
              {(options?.richtingen || []).map(v => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label className="sm:col-span-2 text-sm">
            <span className="block text-gray-600 mb-1">Tags (gescheiden door komma's)</span>
            <input className="input" value={tags} onChange={e => setTags(e.target.value)} placeholder="bv. examen, herhaling" />
          </label>
        </div>

        {err && <Banner tone="error">{err}</Banner>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Annuleren
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={!file || busy}>
            {busy ? <Spinner className="w-4 h-4" /> : null}
            {busy ? "Uploaden…" : ext === "docx" ? "Uploaden en aanduiden" : "Uploaden"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
