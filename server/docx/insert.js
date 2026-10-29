/**
 * insert.js — Rode antwoorden deterministisch in de DOM van word/document.xml plaatsen.
 *
 * Het taalmodel raakt de XML nooit aan: het levert enkel slot-waarden (JSON), deze module
 * bouwt daarmee w:r/w:p-elementen. De opmaak (rPr) wordt gekopieerd van de omliggende tekst
 * en de kleur wordt op rood gezet volgens de schemavolgorde van w:rPr.
 *
 * Slot-types:
 *  - fill_placeholders   { para_id, content: string[] }  puntjes/streepjes vervangen door rood antwoord
 *  - append              { para_id, content: string }    rode run aan het einde van de paragraaf
 *  - fill_empty_following{ para_id, content: string[] }  volgende lege paragrafen invullen
 *  - insert_after        { para_id, content: string }    nieuwe paragraaf "Antwoord: …" na de paragraaf
 *  - fill_cell           { para_id, content: string }    lege tabelcel (paragraaf in de cel) invullen
 */

import { XMLSerializer } from "@xmldom/xmldom";
import { W_NS, PLACEHOLDER_RE, getDirectChild, getDirectChildren } from "./extract.js";

export const RED = "FF0000";
export const SLOT_TYPES = [
  "fill_placeholders",
  "append",
  "fill_empty_following",
  "insert_after",
  "fill_cell",
];

/** Elementen die in w:rPr NA w:color komen (schemavolgorde). */
const AFTER_COLOR = new Set([
  "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr",
  "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath",
]);

const PARA_MARK_ONLY = new Set(["ins", "del", "moveFrom", "moveTo", "rPrChange"]);

function localName(n) {
  return n.localName || n.nodeName.replace(/^.*:/, "");
}

function el(doc, name) {
  return doc.createElementNS(W_NS, `w:${name}`);
}

/** Zet de kleur van een w:rPr op rood, op de juiste plaats in de volgorde. */
export function setRedColor(doc, rPr) {
  for (const c of getDirectChildren(rPr, "color")) rPr.removeChild(c);
  const color = el(doc, "color");
  color.setAttribute("w:val", RED);
  let before = null;
  for (let c = rPr.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && AFTER_COLOR.has(localName(c))) {
      before = c;
      break;
    }
  }
  if (before) rPr.insertBefore(color, before);
  else rPr.appendChild(color);
  return rPr;
}

/** Kopieert de run-opmaak van de eerste run, of anders van pPr/rPr (alineamarkering). */
export function baseRPr(pNode) {
  for (let c = pNode.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && localName(c) === "r") {
      const rPr = getDirectChild(c, "rPr");
      if (rPr) return rPr.cloneNode(true);
    }
  }
  const pPr = getDirectChild(pNode, "pPr");
  const markRPr = pPr && getDirectChild(pPr, "rPr");
  if (markRPr) {
    const copy = markRPr.cloneNode(true);
    for (const c of Array.from(copy.childNodes)) {
      if (c.nodeType === 1 && PARA_MARK_ONLY.has(localName(c))) copy.removeChild(c);
    }
    return copy;
  }
  return null;
}

/** Bouwt een w:r met rode tekst; "\n" wordt een w:br. */
export function makeRun(doc, text, rPrTemplate, { red = true } = {}) {
  const r = el(doc, "r");
  let rPr = rPrTemplate ? rPrTemplate.cloneNode(true) : null;
  if (red) {
    if (!rPr) rPr = el(doc, "rPr");
    setRedColor(doc, rPr);
  }
  if (rPr && rPr.childNodes.length > 0) r.appendChild(rPr);

  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (i > 0) r.appendChild(el(doc, "br"));
    if (line === "" && lines.length > 1) return;
    const t = el(doc, "t");
    t.setAttribute("xml:space", "preserve");
    t.appendChild(doc.createTextNode(line));
    r.appendChild(t);
  });
  return r;
}

function insertAfter(parent, newNode, refNode) {
  if (refNode.nextSibling) parent.insertBefore(newNode, refNode.nextSibling);
  else parent.appendChild(newNode);
}

// ── Slot-implementaties ───────────────────────────────────────────────

/** Vervangt placeholders in tekstruns, in documentvolgorde. Geeft het aantal ingevulde terug. */
function fillPlaceholders(doc, p, values, warnings) {
  let idx = 0;
  const runs = getDirectChildren(p, "r");
  for (const run of runs) {
    const ts = getDirectChildren(run, "t");
    if (ts.length !== 1) continue;
    const text = ts[0].textContent || "";
    PLACEHOLDER_RE.lastIndex = 0;
    if (!PLACEHOLDER_RE.test(text)) continue;

    const rPr = getDirectChild(run, "rPr");
    const pieces = text.split(PLACEHOLDER_RE); // oneven indices = placeholders (capture group)
    const frag = [];
    pieces.forEach((piece, i) => {
      if (i % 2 === 1) {
        const value = idx < values.length ? values[idx] : null;
        idx++;
        if (value == null || value === "") {
          frag.push(makeRun(doc, piece, rPr, { red: false })); // laat placeholder staan
        } else {
          frag.push(makeRun(doc, String(value), rPr, { red: true }));
        }
      } else if (piece !== "") {
        frag.push(makeRun(doc, piece, rPr, { red: false }));
      }
    });
    for (const f of frag) p.insertBefore(f, run);
    p.removeChild(run);
  }
  if (idx !== values.length) {
    warnings.push(
      `Paragraaf ${p.getAttribute("_vr_id")}: ${idx} invulpunt(en) gevonden, ${values.length} waarde(n) opgegeven.`
    );
  }
  return Math.min(idx, values.length);
}

function appendRed(doc, p, text, isList) {
  const sep = isList ? "  →  " : " ";
  const rPr = baseRPr(p);
  p.appendChild(makeRun(doc, sep, rPr, { red: false }));
  p.appendChild(makeRun(doc, text, rPr, { red: true }));
}

function insertParagraphAfter(doc, p, text, stats) {
  if (stats) stats.inserted++;
  const np = el(doc, "p");
  const pPr = getDirectChild(p, "pPr");
  if (pPr) {
    const copy = pPr.cloneNode(true);
    const num = getDirectChild(copy, "numPr");
    if (num) copy.removeChild(num);
    // Alineamarkering-rPr bevat soms w:ins/w:del: weg
    const mark = getDirectChild(copy, "rPr");
    if (mark) {
      for (const c of Array.from(mark.childNodes)) {
        if (c.nodeType === 1 && PARA_MARK_ONLY.has(localName(c))) mark.removeChild(c);
      }
    }
    np.appendChild(copy);
  }
  const rPr = baseRPr(p);
  np.appendChild(makeRun(doc, "Antwoord: ", rPr, { red: false }));
  np.appendChild(makeRun(doc, text, rPr, { red: true }));
  insertAfter(p.parentNode, np, p);
  return np;
}

function asArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? ""));
  if (v == null) return [];
  return [String(v)];
}

function asText(v) {
  return Array.isArray(v) ? v.map((x) => String(x ?? "")).join("\n") : String(v ?? "");
}

/**
 * Past alle slots toe op de DOM.
 *
 * @param {Document} doc
 * @param {Array<ParagraphInfo>} paragraphs  uit extractParagraphs()
 * @param {Array<{para_id:string,type:string,content:any}>} slots
 * @returns {{applied:number, warnings:string[]}}
 */
export function applySlots(doc, paragraphs, slots) {
  const warnings = [];
  const stats = { inserted: 0 };
  const byId = new Map(paragraphs.map((p, i) => [p.id, { info: p, index: i }]));

  // Van achter naar voor werken; bij dezelfde paragraaf in omgekeerde volgorde
  const ordered = slots
    .map((s, order) => ({ s, order, pos: byId.get(s.para_id)?.index ?? -1 }))
    .sort((a, b) => b.pos - a.pos || b.order - a.order);

  let applied = 0;
  for (const { s, pos } of ordered) {
    if (pos < 0) {
      warnings.push(`Onbekende paragraaf-ID '${s.para_id}' (slot ${s.type}) overgeslagen.`);
      continue;
    }
    const info = byId.get(s.para_id).info;
    const p = info._node;
    switch (s.type) {
      case "fill_placeholders": {
        const values = asArray(s.content);
        if (fillPlaceholders(doc, p, values, warnings) > 0) applied++;
        break;
      }
      case "append": {
        const text = asText(s.content).trim();
        if (!text) break;
        appendRed(doc, p, text, info.isList);
        applied++;
        break;
      }
      case "fill_cell": {
        const text = asText(s.content).trim();
        if (!text) break;
        if (info.isEmpty) {
          p.appendChild(makeRun(doc, text, baseRPr(p), { red: true }));
        } else {
          appendRed(doc, p, text, false);
        }
        applied++;
        break;
      }
      case "insert_after": {
        const text = asText(s.content).trim();
        if (!text) break;
        insertParagraphAfter(doc, p, text, stats);
        applied++;
        break;
      }
      case "fill_empty_following": {
        const values = asArray(s.content).filter((v) => v.trim() !== "");
        if (values.length === 0) break;
        // Volgende aaneensluitende lege paragrafen (geen paginascheiding)
        const empties = [];
        for (let i = pos + 1; i < paragraphs.length && empties.length < values.length; i++) {
          const q = paragraphs[i];
          if (!q.isEmpty || q.inTable !== info.inTable) break;
          empties.push(q);
        }
        if (empties.length === 0) {
          insertParagraphAfter(doc, p, values.join(" = "), stats);
          warnings.push(
            `Paragraaf ${s.para_id}: geen lege paragrafen gevonden, antwoord als nieuwe paragraaf ingevoegd.`
          );
          applied++;
          break;
        }
        const k = empties.length;
        const lines =
          values.length <= k
            ? values
            : [...values.slice(0, k - 1), values.slice(k - 1).join(" = ")];
        lines.forEach((line, i) => {
          const target = empties[i]._node;
          const rPr = baseRPr(target) || baseRPr(p);
          target.appendChild(makeRun(doc, line, rPr, { red: true }));
        });
        applied++;
        break;
      }
      default:
        warnings.push(`Onbekend slot-type '${s.type}' voor ${s.para_id} overgeslagen.`);
    }
  }
  return { applied, warnings, insertedParagraphs: stats.inserted };
}

/** Serialiseert de DOM en verwijdert de interne _vr_id-markeringen. */
export function serializeDocument(doc, paragraphs) {
  for (const p of paragraphs) {
    if (p._node && p._node.hasAttribute && p._node.hasAttribute("_vr_id")) {
      p._node.removeAttribute("_vr_id");
    }
  }
  let xml = new XMLSerializer().serializeToString(doc);
  if (!xml.startsWith("<?xml")) {
    xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
  }
  return xml;
}
