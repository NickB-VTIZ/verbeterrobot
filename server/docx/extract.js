/**
 * extract.js — DOCX parsen naar een lijst van paragraaf-nodes met stabiele ID's.
 *
 * Werkt deterministisch met DOMParser (@xmldom/xmldom):
 * - Traverst w:document/w:body recursief (inclusief tabellen w:tbl en tekstvakken w:txbxContent).
 * - Voegt aaneensluitende w:r runs samen als hun w:rPr identiek is (merge_runs).
 * - Kent aan elke <w:p> een para_id toe (p_001, p_002, ...) en stempelt die
 *   als intern attribuut _vr_id in de DOM zodat insert.js dezelfde knoop terugvindt.
 * - Detecteert placeholders: puntjes (minstens 5: \.{5,}) en liggende streepjes (_{5,}).
 * - Telt placeholders, detecteert tabelcontext en lege paragrafen.
 */

import { DOMParser } from "@xmldom/xmldom";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const PLACEHOLDER_RE = /(\.{5,}|_{5,})/g;

/**
 * Normaliseert w:rPr naar een canonieke XML-string voor vergelijking.
 */
function rPrKey(rPrNode) {
  if (!rPrNode) return "";
  // Serialiseer genormaliseerd (zonder whitespace tussen tags)
  return Array.from(rPrNode.childNodes || [])
    .filter((n) => n.nodeType === 1)
    .map((n) => n.toString())
    .join("|");
}

/**
 * Voegt aaneensluitende runs met identieke styling samen.
 * Belangrijk: puntjes zoals '.....' worden in Word vaak opgesplitst over meerdere runs.
 * @param {Element} pNode  <w:p> element
 */
export function mergeRunsInParagraph(pNode) {
  const runs = [];
  for (let c = pNode.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (c.localName === "r" || c.nodeName === "w:r")) {
      runs.push(c);
    }
  }
  if (runs.length <= 1) return;

  let i = 0;
  while (i < runs.length - 1) {
    const cur = runs[i];
    const nxt = runs[i + 1];

    // Zoek w:rPr, w:t in beide
    const curRPr = getDirectChild(cur, "rPr");
    const nxtRPr = getDirectChild(nxt, "rPr");
    const curKey = rPrKey(curRPr);
    const nxtKey = rPrKey(nxtRPr);

    const curT = getDirectChild(cur, "t");
    const nxtT = getDirectChild(nxt, "t");

    // Enkel mergen als styling identiek is en beide enkel <w:t> tekst bevatten (geen tekeningen/breaks)
    const curIsTextOnly = isRunTextOnly(cur);
    const nxtIsTextOnly = isRunTextOnly(nxt);

    if (curKey === nxtKey && curIsTextOnly && nxtIsTextOnly && curT && nxtT) {
      const mergedText = (curT.textContent || "") + (nxtT.textContent || "");
      curT.textContent = mergedText;
      curT.setAttribute("xml:space", "preserve");
      pNode.removeChild(nxt);
      runs.splice(i + 1, 1);
    } else {
      i++;
    }
  }
}

function isRunTextOnly(rNode) {
  for (let c = rNode.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const name = c.localName || c.nodeName.replace(/^w:/, "");
    if (name !== "rPr" && name !== "t") return false;
  }
  return true;
}

export function getDirectChild(parent, localName) {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      const name = c.localName || c.nodeName.replace(/^.*:/, "");
      if (name === localName) return c;
    }
  }
  return null;
}

export function getDirectChildren(parent, localName) {
  const out = [];
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      const name = c.localName || c.nodeName.replace(/^.*:/, "");
      if (name === localName) out.push(c);
    }
  }
  return out;
}

/**
 * Telt het aantal placeholders (\.{5,} of _{5,}) in een string.
 */
export function countPlaceholders(text) {
  if (!text) return 0;
  const matches = text.match(PLACEHOLDER_RE);
  return matches ? matches.length : 0;
}

/**
 * Haalt de platte tekst uit een paragraafknoop.
 */
export function paragraphText(pNode) {
  const parts = [];
  function walk(n) {
    if (!n) return;
    if (n.nodeType === 1) {
      const name = n.localName || n.nodeName.replace(/^.*:/, "");
      if (name === "t") {
        parts.push(n.textContent || "");
      } else if (name === "tab") {
        parts.push("\t");
      } else if (name === "br" || name === "cr") {
        parts.push("\n");
      } else {
        for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      }
    }
  }
  walk(pNode);
  return parts.join("");
}

/**
 * Detecteert of een paragraaf een harde paginascheiding is (<w:br w:type="page"/>).
 */
export function isPageBreakOnly(pNode) {
  const text = paragraphText(pNode).trim();
  if (text.length > 0) return false;
  for (let c = pNode.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    if ((c.localName || c.nodeName) === "r" || c.nodeName === "w:r") {
      const br = getDirectChild(c, "br");
      if (br && br.getAttribute("w:type") === "page") return true;
    }
  }
  return false;
}

/**
 * Extraheert stijlinformatie uit <w:pPr>.
 */
function extractPStyle(pNode) {
  const pPr = getDirectChild(pNode, "pPr");
  if (!pPr) return { style: "", headingLevel: null, isList: false };
  const pStyle = getDirectChild(pPr, "pStyle");
  const style = pStyle ? pStyle.getAttribute("w:val") || "" : "";
  const numPr = getDirectChild(pPr, "numPr");
  const isList = !!numPr;

  let headingLevel = null;
  const m = style.match(/heading\s*(\d+)|kop\s*(\d+)/i);
  if (m) headingLevel = Number(m[1] || m[2]);

  return { style, headingLevel, isList };
}

/**
 * Doorloopt het document en verzamelt alle <w:p> in volgorde.
 * Kent stabiele ID's toe ("p_001", "p_002", ...) en stempelt _vr_id op de DOM-node.
 *
 * @param {string} xmlString  Inhoud van word/document.xml
 * @returns {{ doc: Document, paragraphs: Array<ParagraphInfo> }}
 */
export function extractParagraphs(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");

  const paragraphs = [];
  let counter = 0;

  function traverse(node, context = {}) {
    if (!node) return;
    const name = node.localName || node.nodeName.replace(/^.*:/, "");

    let nextContext = context;
    if (name === "tbl") {
      nextContext = { ...context, inTable: true, cellIndex: 0, rowIndex: 0 };
    } else if (name === "tr") {
      nextContext = { ...context, rowIndex: (context.rowIndex || 0) + 1, cellIndex: 0 };
    } else if (name === "tc") {
      nextContext = { ...context, inTable: true, cellIndex: (context.cellIndex || 0) + 1 };
    }

    if (name === "p") {
      counter++;
      const id = `p_${String(counter).padStart(3, "0")}`;
      node.setAttribute("_vr_id", id);

      mergeRunsInParagraph(node);

      const text = paragraphText(node);
      const trimmed = text.trim();
      const placeholders = countPlaceholders(text);
      const isPageBreak = isPageBreakOnly(node);
      const { style, headingLevel, isList } = extractPStyle(node);

      // Lege paragrafen tellen enkel als mogelijke invulruimte als ze geen pure paginascheiding zijn
      const isEmpty = trimmed.length === 0 && !isPageBreak;

      paragraphs.push({
        id,
        text,
        style,
        headingLevel,
        isList,
        isEmpty,
        isPageBreak,
        inTable: !!nextContext.inTable,
        tableCoord: nextContext.inTable
          ? { row: nextContext.rowIndex || 0, cell: nextContext.cellIndex || 0 }
          : null,
        placeholders,
        // Referentie naar de DOM-knoop (voor in-memory inspectie)
        _node: node,
      });
      return; // <w:p> bevat geen geneste <w:p>'s
    }

    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) traverse(c, nextContext);
    }
  }

  traverse(doc.documentElement || doc);

  return { doc, paragraphs };
}

/**
 * Filtert de metadata naar een compacte representatie voor de LLM (geen DOM-knooppunten).
 */
export function serializeForPrompt(paragraphs) {
  return paragraphs.map((p) => ({
    id: p.id,
    text: p.text,
    style: p.style || undefined,
    heading_level: p.headingLevel ?? undefined,
    is_list: p.isList || undefined,
    is_empty: p.isEmpty || undefined,
    in_table: p.inTable || undefined,
    placeholders: p.placeholders || undefined,
  }));
}
