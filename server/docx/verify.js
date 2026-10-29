/**
 * verify.js — deterministische controle van berekeningen en eenheden.
 *
 * - Rekenkundige expressies worden met een eigen recursieve parser geëvalueerd
 *   (+ - * / ** ^ en haakjes); er wordt nooit eval/Function gebruikt.
 * - De controle vergelijkt de verwachte waarde (check.expect) met expr en met het
 *   laatste getal in de ingevulde slot-tekst (Belgische notatie: komma, spatie als duizendtal).
 * - Eenheden: omrekenbare eenheden (kW ↔ W, kWh ↔ Wh ↔ J, ...) worden herleid
 *   naar dezelfde basis voor vergelijking.
 */

export const TOLERANCE = 0.001; // 0,1 %

// ── Veilige expressie-evaluatie ───────────────────────────────────────

/** Zet tekst met decimale komma e.d. om naar een rekenbare expressie. */
function normaliseExpr(expr) {
  return String(expr)
    .replace(/[×·⋅]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/(\d)\s+(?=\d{3}(\D|$))/g, "$1") // duizendtalspatie
    .replace(/(\d),(\d)/g, "$1.$2");
}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|\*\*|[-+*/^()])/gy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`Ongeldig teken in expressie bij '${src.slice(pos, pos + 8)}'`);
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

/**
 * Evalueert een numerieke expressie veilig.
 * @param {string} expr
 * @returns {number}
 */
export function safeEval(expr) {
  const tokens = tokenize(normaliseExpr(expr));
  if (tokens.length === 0) throw new Error("Lege expressie");
  let i = 0;

  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseExpr() {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseUnary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = parseUnary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function parseUnary() {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (peek() === "**" || peek() === "^") {
      next();
      const exp = parseUnary(); // rechts-associatief
      return Math.pow(base, exp);
    }
    return base;
  }
  function parseAtom() {
    const t = next();
    if (t === undefined) throw new Error("Expressie onvolledig");
    if (t === "(") {
      const v = parseExpr();
      if (next() !== ")") throw new Error("Haakje ontbreekt");
      return v;
    }
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error(`Onverwacht token '${t}'`);
    return n;
  }

  const result = parseExpr();
  if (i < tokens.length) throw new Error(`Onverwacht token '${tokens[i]}'`);
  if (!Number.isFinite(result)) throw new Error("Resultaat is geen eindig getal");
  return result;
}

// ── Getallen en eenheden uit tekst ────────────────────────────────────

const NUM_RE = /-?\d+(?:[ \u00A0.]\d{3})*(?:,\d+)?(?:[eE][+-]?\d+)?|-?\d+(?:\.\d+)?/g;

/**
 * Zoekt het laatste getal in een tekst en de eenheid die erop volgt.
 * @returns {{value:number, unit:string}|null}
 */
export function lastNumber(text) {
  const s = String(text ?? "");
  let last = null;
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s)) !== null) {
    last = { raw: m[0], end: m.index + m[0].length };
  }
  if (!last) return null;
  let raw = last.raw.replace(/[ \u00A0]/g, "");
  if (raw.includes(",")) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) {
    raw = raw.replace(/\./g, ""); // 1.500 als duizendtal
  }
  const value = Number(raw);
  if (Number.isNaN(value)) return null;
  const rest = s.slice(last.end).trimStart();
  const um = rest.match(/^(%|[A-Za-zµμΩΩ°][A-Za-zµμΩΩ°/²³·.]*)/);
  return { value, unit: um ? um[1].replace(/\.$/, "") : "" };
}

/** Factoren per eenheid naar de basis van hetzelfde grootheidstype. */
const UNITS = {
  W: ["vermogen", 1], kW: ["vermogen", 1e3], MW: ["vermogen", 1e6], mW: ["vermogen", 1e-3],
  Wh: ["energie", 3600], kWh: ["energie", 3.6e6], MWh: ["energie", 3.6e9],
  J: ["energie", 1], kJ: ["energie", 1e3], MJ: ["energie", 1e6],
  V: ["spanning", 1], kV: ["spanning", 1e3], mV: ["spanning", 1e-3],
  A: ["stroom", 1], mA: ["stroom", 1e-3], kA: ["stroom", 1e3],
  Ω: ["weerstand", 1], kΩ: ["weerstand", 1e3], MΩ: ["weerstand", 1e6], mΩ: ["weerstand", 1e-3],
  s: ["tijd", 1], min: ["tijd", 60], h: ["tijd", 3600],
  "%": ["percentage", 1],
  Hz: ["frequentie", 1], kHz: ["frequentie", 1e3],
  m: ["lengte", 1], cm: ["lengte", 1e-2], mm: ["lengte", 1e-3], km: ["lengte", 1e3],
  "m²": ["oppervlakte", 1], "mm²": ["oppervlakte", 1e-6], "cm²": ["oppervlakte", 1e-4],
};

export function normaliseUnit(u) {
  let s = String(u ?? "").trim().replace(/μ|µ/g, "µ").replace(/ohm/i, "Ω");
  if (/^mm2$/i.test(s)) s = "mm²";
  if (/^m2$/i.test(s)) s = "m²";
  if (s.toLowerCase() === "kwh") return "kWh";
  if (s.toLowerCase() === "wh") return "Wh";
  if (s.toLowerCase() === "kw") return "kW";
  if (s === "w") return "W";
  return s;
}

// ── Controle ──────────────────────────────────────────────────────────

function close(a, b, tol = TOLERANCE) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tol * scale || Math.abs(a - b) < 1e-9;
}

function slotText(slotValues, ref, index) {
  const sv = slotValues.find((s) => s.para_id === ref);
  if (!sv) return null;
  const c = sv.content;
  if (Array.isArray(c)) {
    if (index != null && c[index] != null) return String(c[index]);
    return c.map(String).join(" ");
  }
  return String(c ?? "");
}

/**
 * Controleert de checks van één oplossing.
 *
 * @param {Array<{expr:string, expect?:number|string, unit?:string, slot?:string, index?:number}>} checks
 * @param {Array<{para_id:string, content:any}>} slotValues
 * @returns {{ok:boolean, issues:string[]}}
 */
export function verifySolution(checks, slotValues) {
  const issues = [];
  for (const [n, chk] of (checks || []).entries()) {
    const label = `check ${n + 1} (${chk.expr})`;
    let computed;
    try {
      computed = safeEval(chk.expr);
    } catch (err) {
      issues.push(`${label}: expressie onbruikbaar: ${err.message}`);
      continue;
    }

    // 1. expect (door het model opgegeven) moet kloppen met de berekende waarde
    if (chk.expect != null && chk.expect !== "") {
      let expected;
      try {
        expected = typeof chk.expect === "number" ? chk.expect : safeEval(String(chk.expect));
      } catch {
        const ln = lastNumber(String(chk.expect));
        expected = ln ? ln.value : NaN;
      }
      if (Number.isNaN(expected)) {
        issues.push(`${label}: 'expect' is geen getal.`);
      } else if (!close(computed, expected)) {
        issues.push(`${label}: expr geeft ${fmt(computed)}, maar expect is ${fmt(expected)}.`);
      }
    }

    // 2. het laatste getal in het ingevulde slot moet overeenkomen
    if (chk.slot) {
      const text = slotText(slotValues, chk.slot, chk.index);
      if (text == null) {
        issues.push(`${label}: slot '${chk.slot}' bestaat niet in slot_values.`);
        continue;
      }
      const ln = lastNumber(text);
      if (!ln) {
        issues.push(`${label}: geen getal gevonden in slot ${chk.slot}.`);
        continue;
      }
      const wantUnit = normaliseUnit(chk.unit);
      const gotUnit = normaliseUnit(ln.unit);
      let gotValue = ln.value;
      let wantValue = computed;

      if (wantUnit && gotUnit && wantUnit !== gotUnit) {
        const w = UNITS[wantUnit];
        const g = UNITS[gotUnit];
        if (!w || !g) {
          issues.push(`${label}: eenheid '${gotUnit}' in het antwoord, verwacht '${wantUnit}'.`);
          continue;
        }
        if (w[0] !== g[0]) {
          issues.push(
            `${label}: eenheid '${gotUnit}' (${g[0]}) past niet bij '${wantUnit}' (${w[0]}).`
          );
          continue;
        }
        gotValue = ln.value * g[1];
        wantValue = computed * w[1];
      } else if (wantUnit && !gotUnit) {
        issues.push(`${label}: eenheid '${wantUnit}' ontbreekt in het antwoord.`);
      }
      if (!close(gotValue, wantValue)) {
        issues.push(
          `${label}: in het antwoord staat ${fmt(ln.value)}${ln.unit ? " " + ln.unit : ""}, ` +
            `de berekening geeft ${fmt(computed)}${chk.unit ? " " + chk.unit : ""}.`
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6)));
}
