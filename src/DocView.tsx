import { Fragment, ReactNode, useMemo } from "react";
import { Mark, Para, ROLE_META, Role, SLOT_SHORT } from "./markingTypes";

/**
 * Documentweergave: de alinea's van het Word-document worden getoond als een pagina
 * (koppen, vet, lijsten, tabellen, invulpunten, lege regels). Klik op een stuk tekst om
 * aan te duiden of het een vraag, antwoordplaats, gegeven, ... is. Rode markeringen tonen
 * precies waar de robot later het antwoord invoegt.
 */

interface Props {
  paras: Para[];
  marks: Record<string, Mark>;
  proposal: Mark[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  setRef: (id: string, el: HTMLElement | null) => void;
}

type Item =
  | { kind: "para"; p: Para }
  | { kind: "table"; key: string; rows: { row: number; cells: { cell: number; paras: Para[] }[] }[] };

function buildItems(paras: Para[]): Item[] {
  const items: Item[] = [];
  let cur: { rows: Map<number, Map<number, Para[]>>; lastRow: number; lastCell: number; key: string } | null = null;
  const flush = () => {
    if (!cur) return;
    const rows = [...cur.rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, cells]) => ({
        row,
        cells: [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([cell, ps]) => ({ cell, paras: ps })),
      }));
    items.push({ kind: "table", key: cur.key, rows });
    cur = null;
  };
  for (const p of paras) {
    if (p.inTable && p.tableCoord) {
      const { row, cell } = p.tableCoord;
      if (cur && (row < cur.lastRow || (row === cur.lastRow && cell < cur.lastCell))) flush();
      if (!cur) cur = { rows: new Map(), lastRow: row, lastCell: cell, key: `t_${p.id}` };
      let r = cur.rows.get(row);
      if (!r) {
        r = new Map();
        cur.rows.set(row, r);
      }
      const list = r.get(cell) || [];
      list.push(p);
      r.set(cell, list);
      cur.lastRow = row;
      cur.lastCell = cell;
    } else {
      flush();
      items.push({ kind: "para", p });
    }
  }
  flush();
  return items;
}

/** Invulpunten (…… of ____) tonen als stippellijn, zoals op papier. */
function renderText(text: string): ReactNode {
  const parts = text.split(/(\.{5,}|_{5,}|…{2,})/);
  return parts.map((part, i) =>
    /^(\.{5,}|_{5,}|…{2,})$/.test(part) ? (
      <span
        key={i}
        className="inline-block align-baseline border-b-2 border-dotted border-red-400 mx-0.5"
        style={{ minWidth: `${Math.min(14, Math.max(4, part.length * 0.5))}em` }}
        title="Invulpunt"
      >
        &nbsp;
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  );
}

export default function DocView({ paras, marks, proposal, selected, onSelect, setRef }: Props) {
  const items = useMemo(() => buildItems(paras), [paras]);
  const proposalById = useMemo(() => new Map(proposal.map(m => [m.paraId, m])), [proposal]);

  /** Lege regels die door een antwoordplaats "In de lege regels eronder" gevuld worden. */
  const covered = useMemo(() => {
    const s = new Map<string, string>();
    paras.forEach((p, idx) => {
      const m = marks[p.id];
      if (!m || m.role !== "antwoordplaats" || m.slotType !== "fill_empty_following") return;
      let left = m.slotCount ?? 1;
      for (let k = idx + 1; k < paras.length && left > 0; k++) {
        const n = paras[k];
        if (!n.isEmpty || n.inTable !== p.inTable) break;
        s.set(n.id, m.qid);
        left--;
      }
    });
    return s;
  }, [paras, marks]);

  function block(p: Para) {
    if (p.isPageBreak && p.isEmpty) {
      return (
        <div key={p.id} className="my-3 border-t-2 border-dashed border-gray-300 text-center text-[10px] uppercase tracking-wide text-gray-400">
          paginaeinde
        </div>
      );
    }
    const m = marks[p.id];
    const meta = m ? ROLE_META[m.role] : null;
    const prop = !m ? proposalById.get(p.id) : undefined;
    const isSel = selected === p.id;
    const cov = covered.get(p.id);
    const heading = p.headingLevel
      ? p.headingLevel === 1
        ? "text-2xl font-bold"
        : p.headingLevel === 2
        ? "text-xl font-semibold"
        : "text-lg font-semibold"
      : p.bold
      ? "font-semibold"
      : "";

    let body: ReactNode;
    if (p.isEmpty) {
      body = <div className="min-h-[1.5rem]" aria-label="lege regel" />;
    } else {
      body = (
        <p className={`whitespace-pre-wrap break-words text-gray-900 leading-relaxed ${heading}`}>
          {p.isList && <span className="mr-2 text-gray-500">•</span>}
          {renderText(p.text)}
        </p>
      );
    }

    return (
      <div
        key={p.id}
        ref={el => setRef(p.id, el)}
        role="button"
        tabIndex={0}
        onClick={e => {
          e.stopPropagation();
          onSelect(isSel ? null : p.id);
        }}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(isSel ? null : p.id);
          }
        }}
        title={`${p.id}${m ? " · " + meta!.label : ""}`}
        className={`group relative rounded-sm border-l-4 px-2 py-0.5 cursor-pointer transition-colors ${
          meta ? `${meta.bar} ${meta.bg}` : cov ? "border-l-red-300 bg-red-50/60" : "border-l-transparent hover:bg-gray-100"
        } ${isSel ? "ring-2 ring-offset-1 ring-gray-500" : ""} ${prop ? "outline outline-1 outline-dashed outline-gray-300" : ""}`}
      >
        {(m || prop) && (
          <div className="flex flex-wrap items-center gap-1 text-[10px] leading-4 mb-0.5">
            {m && (
              <span className="rounded bg-white/80 px-1.5 font-semibold text-gray-700 border border-gray-300">
                {meta!.label}
                {m.qid ? ` ${m.qid}` : ""}
              </span>
            )}
            {prop && (
              <span className="rounded px-1.5 text-gray-500 border border-dashed border-gray-300" title="Voorstel van de AI">
                AI: {ROLE_META[prop.role as Role]?.label}
                {prop.qid ? ` ${prop.qid}` : ""}
              </span>
            )}
          </div>
        )}
        {body}
        {m?.role === "antwoordplaats" && (
          <div className="mt-0.5 mb-0.5 rounded border border-dashed border-red-400 bg-white/70 px-2 py-0.5 text-xs italic text-red-600">
            ✎ Antwoord{m.qid ? ` ${m.qid}` : ""} komt hier {m.slotType ? SLOT_SHORT[m.slotType] || "" : ""}
            {m.slotCount && m.slotCount > 1 && (m.slotType === "fill_placeholders" || m.slotType === "fill_empty_following")
              ? ` (${m.slotCount}×)`
              : ""}
          </div>
        )}
        {!m && cov && (
          <div className="text-[11px] italic text-red-500">✎ antwoord {cov} komt in deze lege regel</div>
        )}
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-3xl rounded-lg border border-gray-300 bg-white shadow-md px-6 sm:px-10 py-8 space-y-0.5"
      onClick={() => onSelect(null)}
    >
      {items.map(it =>
        it.kind === "para" ? (
          block(it.p)
        ) : (
          <div key={it.key} className="my-2 overflow-x-auto" onClick={e => e.stopPropagation()}>
            <table className="w-full border-collapse text-sm">
              <tbody>
                {it.rows.map(r => (
                  <tr key={r.row}>
                    {r.cells.map(c => (
                      <td key={c.cell} className="border border-gray-400 align-top p-1 min-w-[4rem]">
                        {c.paras.map(block)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
