// Back-up van database + bestanden + instellingen.
//
// Gebruik:
//   node scripts/backup.mjs            eenmalige back-up
//   node scripts/backup.mjs --loop     elke dag om BACKUP_HOUR (standaard 03:00), blijft draaien
//   node scripts/backup.mjs --list     toon bestaande back-ups
//
// Omgevingsvariabelen:
//   DATA_DIR              gegevensmap van de app (standaard ./data)
//   BACKUP_DIR            doelmap (standaard ./backups)
//   BACKUP_RETENTION_DAYS aantal dagen dat back-ups bewaard blijven (standaard 14, 0 = nooit opruimen)
//   BACKUP_HOUR           uur (0-23, lokale tijd) van de dagelijkse back-up in --loop-modus
//
// Elke back-up is een map BACKUP_DIR/<jjjj-mm-dd_uummss>/ met:
//   verbeterrobot.db (consistente kopie via SQLite-backup), settings.json, subjects.json,
//   training.json en store/ (alle documentbestanden).
// Bestanden in store/ zijn onveranderlijk (UUID-namen). Daarom worden ze, als ze al in de vorige
// back-up zitten en op hetzelfde volume staan, als hard link overgenomen: dat bespaart schijfruimte,
// terwijl elke back-up toch volledig en los herstelbaar blijft.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, "backups"));
const RETENTION_DAYS = Number.isFinite(Number(process.env.BACKUP_RETENTION_DAYS))
  ? Number(process.env.BACKUP_RETENTION_DAYS)
  : 14;
const BACKUP_HOUR = Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR ?? 3) || 0));
const JSON_FILES = ["settings.json", "subjects.json", "training.json"];
const NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

export function listBackups(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => NAME_RE.test(n) && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs));
  }
  return out;
}

function copyOrLink(src, dest, prevFile) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (prevFile && fs.existsSync(prevFile)) {
    try {
      if (fs.statSync(prevFile).size === fs.statSync(src).size) {
        fs.linkSync(prevFile, dest);
        return "link";
      }
    } catch {
      /* ander volume of geen hard links: gewoon kopiëren */
    }
  }
  fs.copyFileSync(src, dest);
  return "copy";
}

export async function runBackup() {
  const dbPath = path.join(DATA_DIR, "verbeterrobot.db");
  if (!fs.existsSync(DATA_DIR)) throw new Error(`DATA_DIR bestaat niet: ${DATA_DIR}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const previous = listBackups().pop() || null;
  const name = stamp();
  const target = path.join(BACKUP_DIR, name);
  const tmp = `${target}.bezig`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  try {
    // 1. Database: consistente kopie, ook terwijl de app draait.
    let dbBytes = 0;
    if (fs.existsSync(dbPath)) {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        await db.backup(path.join(tmp, "verbeterrobot.db"));
      } finally {
        db.close();
      }
      dbBytes = fs.statSync(path.join(tmp, "verbeterrobot.db")).size;
    }

    // 2. JSON-instellingen.
    for (const f of JSON_FILES) {
      const src = path.join(DATA_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }

    // 3. Documentbestanden.
    const storeSrc = path.join(DATA_DIR, "store");
    const prevStore = previous ? path.join(BACKUP_DIR, previous, "store") : null;
    let files = 0;
    let linked = 0;
    let bytes = 0;
    for (const rel of walk(storeSrc)) {
      const src = path.join(storeSrc, rel);
      const how = copyOrLink(src, path.join(tmp, "store", rel), prevStore && path.join(prevStore, rel));
      files++;
      if (how === "link") linked++;
      bytes += fs.statSync(src).size;
    }

    fs.writeFileSync(
      path.join(tmp, "backup.json"),
      JSON.stringify(
        { name, createdAt: new Date().toISOString(), files, linked, storeBytes: bytes, dbBytes },
        null,
        2
      )
    );
    fs.renameSync(tmp, target);
    console.log(
      `✅ Back-up ${name}: database ${(dbBytes / 1024).toFixed(0)} kB, ${files} bestand(en) ` +
        `(${linked} als hard link overgenomen).`
    );
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }

  pruneBackups();
  return name;
}

export function pruneBackups() {
  if (!(RETENTION_DAYS > 0)) return [];
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const all = listBackups();
  const removed = [];
  // Nooit de laatste back-up weggooien, ook niet als ze ouder is dan de bewaartermijn.
  for (const n of all.slice(0, -1)) {
    const m = n.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/);
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (t < cutoff) {
      fs.rmSync(path.join(BACKUP_DIR, n), { recursive: true, force: true });
      removed.push(n);
    }
  }
  if (removed.length) console.log(`🧹 ${removed.length} oude back-up(s) verwijderd (> ${RETENTION_DAYS} dagen).`);
  return removed;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(BACKUP_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

async function loop() {
  console.log(
    `⏰ Back-upservice actief: dagelijks om ${String(BACKUP_HOUR).padStart(2, "0")}:00, ` +
      `bewaartermijn ${RETENTION_DAYS || "onbeperkt"} dag(en), doelmap ${BACKUP_DIR}`
  );
  const tick = async () => {
    try {
      await runBackup();
    } catch (e) {
      console.error("❌ Back-up mislukt:", e.message);
    }
    setTimeout(tick, msUntilNextRun());
  };
  if (process.env.BACKUP_ON_START !== "false") await tick();
  else setTimeout(tick, msUntilNextRun());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  if (arg === "--list") {
    const all = listBackups();
    if (!all.length) console.log("Geen back-ups gevonden in", BACKUP_DIR);
    for (const n of all) console.log(n);
  } else if (arg === "--loop") {
    loop();
  } else {
    runBackup().catch((e) => {
      console.error("❌ Back-up mislukt:", e.message);
      process.exit(1);
    });
  }
}
