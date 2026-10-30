// Herstel een back-up.
//
// Gebruik (stop eerst de app zodat niemand schrijft):
//   node scripts/restore.mjs --list                 toon beschikbare back-ups
//   node scripts/restore.mjs <naam|latest>          toon wat er zou gebeuren (niets wordt gewijzigd)
//   node scripts/restore.mjs <naam|latest> --yes    voer het herstel effectief uit
//
// Docker:
//   docker compose stop app
//   docker compose run --rm backup node scripts/restore.mjs latest --yes
//   docker compose start app
//
// De huidige toestand wordt vóór het herstel bewaard in DATA_DIR/vor-herstel-<tijdstip>/,
// zodat een herstel zelf ook ongedaan gemaakt kan worden.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listBackups } from "./backup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, "backups"));
const JSON_FILES = ["settings.json", "subjects.json", "training.json"];

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const first = args.find((a) => !a.startsWith("--"));

if (args.includes("--list") || !first) {
  const all = listBackups(BACKUP_DIR);
  console.log(all.length ? `Back-ups in ${BACKUP_DIR}:` : `Geen back-ups gevonden in ${BACKUP_DIR}`);
  for (const n of all) {
    let info = "";
    try {
      const m = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, n, "backup.json"), "utf8"));
      info = `  (${m.files} bestanden)`;
    } catch {}
    console.log(`  ${n}${info}`);
  }
  if (!first) console.log("\nGebruik: node scripts/restore.mjs <naam|latest> [--yes]");
  process.exit(0);
}

const all = listBackups(BACKUP_DIR);
const name = first === "latest" ? all[all.length - 1] : first;
if (!name || !all.includes(name)) {
  console.error(`❌ Back-up "${first}" niet gevonden. Beschikbaar: ${all.join(", ") || "(geen)"}`);
  process.exit(1);
}
const src = path.join(BACKUP_DIR, name);
if (!fs.existsSync(path.join(src, "verbeterrobot.db")) && !fs.existsSync(path.join(src, "store"))) {
  console.error("❌ Deze back-up bevat geen database of bestanden.");
  process.exit(1);
}

console.log(`Herstellen van back-up ${name}`);
console.log(`  naar gegevensmap: ${DATA_DIR}`);
if (!yes) {
  console.log("\nDit is een controle. Voeg --yes toe om het herstel effectief uit te voeren.");
  console.log("Zorg dat de app gestopt is (docker compose stop app).");
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const safety = path.join(DATA_DIR, `vor-herstel-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(safety, { recursive: true });

// 1. Huidige toestand opzij zetten.
for (const f of ["verbeterrobot.db", "verbeterrobot.db-wal", "verbeterrobot.db-shm", ...JSON_FILES]) {
  const p = path.join(DATA_DIR, f);
  if (fs.existsSync(p)) fs.renameSync(p, path.join(safety, f));
}
if (fs.existsSync(path.join(DATA_DIR, "store"))) {
  fs.renameSync(path.join(DATA_DIR, "store"), path.join(safety, "store"));
}

// 2. Back-up terugzetten.
for (const f of ["verbeterrobot.db", ...JSON_FILES]) {
  const p = path.join(src, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(DATA_DIR, f));
}
if (fs.existsSync(path.join(src, "store"))) {
  fs.cpSync(path.join(src, "store"), path.join(DATA_DIR, "store"), { recursive: true });
}

console.log(`✅ Hersteld. De vorige toestand staat in ${safety}`);
console.log("   Start de app opnieuw (docker compose start app).");
