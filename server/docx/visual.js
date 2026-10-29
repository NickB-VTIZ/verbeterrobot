/**
 * visual.js — visuele eindcontrole van het ingevulde .docx.
 *
 * Stappen:
 *   1. LibreOffice (headless) zet het resultaat om naar PDF
 *   2. poppler (pdftoppm) rendert de pagina's naar PNG
 *   3. een vision-model (via Omniroute) bekijkt de pagina's en rapporteert in JSON
 *
 * Alles is "best effort": ontbreken de tools of faalt het vision-model, dan wordt de
 * controle overgeslagen (status "skipped") en loopt de verwerking gewoon verder.
 * Twijfelt het model, dan komen er verduidelijkingsvragen voor de leerkracht
 * (status "unsure") in plaats van een gok.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { pathToFileURL } from "url";
import { getSettings } from "../settings.js";
import { askJson } from "./llm.js";

const MAX_PAGES = 6;
const DPI = 80;
const CONVERT_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 60_000;

// ── Hulpfuncties voor externe programma's ────────────────────────────────
function run(cmd, args, { timeout = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

let toolsCache = null;
let toolsCachedAt = 0;

/**
 * Controleert of LibreOffice en poppler beschikbaar zijn (resultaat 60 s gecached).
 * @returns {Promise<{soffice:string|null, pdftoppm:boolean, pdfinfo:boolean, available:boolean, version:string}>}
 */
export async function toolsAvailable({ force = false } = {}) {
  if (!force && toolsCache && Date.now() - toolsCachedAt < 60_000) return toolsCache;
  let soffice = null;
  let version = "";
  for (const bin of ["soffice", "libreoffice"]) {
    try {
      const r = await run(bin, ["--version"], { timeout: 20_000, env: { HOME: os.tmpdir() } });
      soffice = bin;
      version = r.stdout.trim().split("\n")[0];
      break;
    } catch {
      /* volgende kandidaat */
    }
  }
  let pdftoppm = false;
  try {
    await run("pdftoppm", ["-v"], { timeout: 10_000 });
    pdftoppm = true;
  } catch (err) {
    // pdftoppm -v eindigt soms met een exit-code ≠ 0 maar bestaat wel
    pdftoppm = !!err && err.code !== "ENOENT" && /pdftoppm/i.test(String(err.stderr || ""));
  }
  let pdfinfo = false;
  try {
    await run("pdfinfo", ["-v"], { timeout: 10_000 });
    pdfinfo = true;
  } catch (err) {
    pdfinfo = !!err && err.code !== "ENOENT" && /pdfinfo/i.test(String(err.stderr || ""));
  }
  toolsCache = { soffice, pdftoppm, pdfinfo, available: !!(soffice && pdftoppm), version };
  toolsCachedAt = Date.now();
  return toolsCache;
}

/** Zet een .docx om naar PDF met LibreOffice. Geeft het pad naar de PDF terug. */
export async function convertToPdf(docxPath, outDir, soffice = "soffice") {
  const profileDir = path.join(outDir, `lo_profile_${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir,
    docxPath,
  ];
  await run(soffice, args, { timeout: CONVERT_TIMEOUT_MS, env: { HOME: outDir } });
  const pdf = path.join(outDir, `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
  if (!fs.existsSync(pdf)) throw new Error("LibreOffice maakte geen PDF aan.");
  return pdf;
}

/** Aantal pagina's via pdfinfo (null als onbekend). */
export async function pdfPageCount(pdfPath) {
  try {
    const r = await run("pdfinfo", [pdfPath], { timeout: 15_000 });
    const m = r.stdout.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** Rendert de eerste pagina's van de PDF naar PNG-buffers. */
export async function renderPages(pdfPath, outDir, { dpi = DPI, maxPages = MAX_PAGES } = {}) {
  const prefix = path.join(outDir, "pagina");
  await run("pdftoppm", ["-png", "-r", String(dpi), "-f", "1", "-l", String(maxPages), pdfPath, prefix], {
    timeout: RENDER_TIMEOUT_MS,
  });
  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("pagina") && f.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files.map((f) => fs.readFileSync(path.join(outDir, f)));
}

// ── Pure onderdelen (zonder tools; apart testbaar) ───────────────────────

/** Korte samenvatting van wat ingevuld werd, zodat het model weet wat er rood moet staan. */
export function summariseSlots(slots, maxChars = 1800) {
  const lines = [];
  for (const s of slots || []) {
    const c = Array.isArray(s.content) ? s.content.join(" ; ") : String(s.content ?? "");
    const t = c.replace(/\s+/g, " ").trim();
    if (t) lines.push(`- ${t.slice(0, 160)}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n- …`;
  return out;
}

export function buildVisualMessages(imagesBase64, { expected = "", pageCount = null, originalPageCount = null } = {}) {
  const system =
    "Je bent een nauwgezette controleur van de opmaak van Word-documenten. " +
    "Je krijgt afbeeldingen van de pagina's van een toets waarin een verbetersleutel in ROOD werd ingevuld. " +
    "Controleer enkel de zichtbare opmaak, niet de inhoudelijke juistheid. " +
    "Antwoord uitsluitend met geldige JSON.";
  const text = [
    "Controleer deze pagina's op:",
    "1. Staan de rode antwoorden duidelijk zichtbaar en leesbaar op de juiste plaats (naast of onder de vraag)?",
    "2. Is er tekst afgesneden, overlappend of buiten de pagina/tabel terechtgekomen?",
    "3. Staan er nog lege invulpunten (….., ___, lege vakjes) bij vragen waar een antwoord had moeten staan?",
    "4. Zijn tabellen, afbeeldingen en opsommingen nog intact? Is de pagina-indeling duidelijk slechter dan verwacht?",
    pageCount != null
      ? `Het resultaat heeft ${pageCount} pagina's${originalPageCount != null ? `; het origineel had er ${originalPageCount}` : ""}.`
      : "",
    expected ? `Dit werd ingevuld (rood):\n${expected}` : "",
    "",
    "Antwoord met dit JSON-formaat:",
    '{"ok": true|false, "zeker": true|false, "problemen": [{"pagina": 1, "probleem": "korte beschrijving", "ernst": "laag|middel|hoog"}], "vragen": ["vraag aan de leerkracht indien je iets niet kan beoordelen"]}',
    '- "ok": true als je geen noemenswaardige problemen ziet.',
    '- "zeker": false als je het niet goed kan beoordelen (te klein, onleesbaar, onduidelijke structuur). Stel dan in "vragen" concrete vragen aan de leerkracht.',
    "- Verzin geen problemen; een lege lijst is prima.",
  ]
    .filter(Boolean)
    .join("\n");

  const content = [{ type: "text", text }];
  imagesBase64.forEach((b64, i) => {
    content.push({ type: "text", text: `Pagina ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
  });
  return [
    { role: "system", content: system },
    { role: "user", content },
  ];
}

/**
 * Valideert en normaliseert het antwoord van het vision-model.
 * @returns {{ok:boolean, zeker:boolean, problemen:Array<{pagina:number|null,probleem:string,ernst:string}>, vragen:string[]}}
 */
export function validateVisualReport(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Verwacht een JSON-object met de velden ok, zeker, problemen en vragen.");
  }
  const problemen = (Array.isArray(parsed.problemen) ? parsed.problemen : [])
    .map((p) => {
      if (typeof p === "string") return { pagina: null, probleem: p.trim(), ernst: "middel" };
      const pagina = Number.isFinite(Number(p?.pagina)) ? Number(p.pagina) : null;
      const ernst = ["laag", "middel", "hoog"].includes(String(p?.ernst)) ? String(p.ernst) : "middel";
      return { pagina, probleem: String(p?.probleem ?? "").trim(), ernst };
    })
    .filter((p) => p.probleem);
  const vragen = (Array.isArray(parsed.vragen) ? parsed.vragen : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);
  const zeker = parsed.zeker === undefined ? vragen.length === 0 : !!parsed.zeker;
  const ok = parsed.ok === undefined ? problemen.length === 0 : !!parsed.ok;
  return { ok, zeker, problemen, vragen };
}

/**
 * Zet een rapport om naar een eindstatus.
 * @returns {{status:"ok"|"issues"|"unsure", issues:string[], clarifications:string[]}}
 */
export function summariseReport(report, { pageCount = null, originalPageCount = null } = {}) {
  const issues = report.problemen
    .filter((p) => p.ernst !== "laag" || !report.ok)
    .map((p) => `${p.pagina ? `Pagina ${p.pagina}: ` : ""}${p.probleem}`);
  if (pageCount != null && originalPageCount != null && pageCount > originalPageCount + 1) {
    issues.push(`Het resultaat telt ${pageCount} pagina's tegenover ${originalPageCount} in het origineel.`);
  }
  const clarifications = report.vragen;
  let status = "ok";
  if (!report.zeker || clarifications.length) status = "unsure";
  else if (!report.ok || issues.length) status = "issues";
  return { status, issues, clarifications };
}

// ── Hoofdfunctie ──────────────────────────────────────────────────────────
/**
 * @param {{outputPath:string, originalPath?:string, slots?:Array}} input
 * @returns {Promise<{status:"ok"|"issues"|"unsure"|"skipped", issues:string[], clarifications:string[], pages:number, note:string}>}
 */
export async function visualCheck({ outputPath, originalPath, slots = [] }) {
  const cfg = getSettings();
  const skipped = (note) => ({ status: "skipped", issues: [], clarifications: [], pages: 0, note });

  if (cfg.visualCheckEnabled === false || process.env.VISUAL_CHECK === "off") {
    return skipped("Visuele controle staat uit.");
  }
  const tools = await toolsAvailable();
  if (!tools.available) {
    return skipped("LibreOffice of poppler is niet geïnstalleerd; visuele controle overgeslagen.");
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vr_visual_"));
  try {
    // Resultaat → PDF → PNG
    let pdf;
    try {
      pdf = await convertToPdf(outputPath, workDir, tools.soffice);
    } catch (err) {
      return skipped(`Omzetten naar PDF mislukt: ${err.message.split("\n")[0]}`);
    }
    const pageCount = tools.pdfinfo ? await pdfPageCount(pdf) : null;

    // Origineel enkel voor het aantal pagina's (best effort)
    let originalPageCount = null;
    if (originalPath && tools.pdfinfo) {
      const origDir = path.join(workDir, "orig");
      fs.mkdirSync(origDir, { recursive: true });
      try {
        const origPdf = await convertToPdf(originalPath, origDir, tools.soffice);
        originalPageCount = await pdfPageCount(origPdf);
      } catch {
        /* niet erg */
      }
    }

    const pngs = await renderPages(pdf, workDir);
    if (pngs.length === 0) return skipped("Er werden geen pagina's gerenderd.");

    // Vision-model
    const messages = buildVisualMessages(
      pngs.map((b) => b.toString("base64")),
      { expected: summariseSlots(slots), pageCount, originalPageCount }
    );
    let report;
    try {
      report = await askJson(messages, validateVisualReport, {
        retries: 1,
        temperature: 0,
        model: cfg.visionModel || undefined,
      });
    } catch (err) {
      return skipped(`Vision-model gaf geen bruikbaar antwoord: ${err.message.slice(0, 200)}`);
    }

    const s = summariseReport(report, { pageCount, originalPageCount });
    return { ...s, pages: pngs.length, note: pageCount && pageCount > pngs.length ? `Eerste ${pngs.length} van ${pageCount} pagina's gecontroleerd.` : "" };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* opruimen is best effort */
    }
  }
}
