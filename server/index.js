import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import multer from "multer";
import { parseDocument } from "./parser.js";
import { getAnswersFromAI } from "./ai.js";
import { injectAnswers } from "./injector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3010;
const DIST = path.join(__dirname, "..", "dist");
const UPLOADS = path.join(__dirname, "..", "uploads");
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "20", 10);
const APP_PASSWORD = process.env.APP_PASSWORD || "";

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ── Multer ────────────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([
  ".docx", ".pdf", ".pptx", ".xlsx", ".xls", ".txt",
]);
const ALLOWED_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  // sommige browsers sturen application/octet-stream
  "application/octet-stream",
]);

const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`Bestandstype '${ext}' is niet toegelaten.`));
    }
    cb(null, true);
  },
});

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Statische frontend
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
}

// ── Auth middleware ───────────────────────────────────────────────────
function requirePassword(req, res, next) {
  const provided =
    req.headers["x-app-password"] ||
    req.body?.password ||
    req.query?.password;

  if (!APP_PASSWORD) {
    return res
      .status(500)
      .json({ error: "APP_PASSWORD is niet ingesteld op de server." });
  }
  if (!provided || provided !== APP_PASSWORD) {
    return res.status(401).json({ error: "Ongeldig wachtwoord." });
  }
  next();
}

// ── Health ────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ── Auth check ────────────────────────────────────────────────────────
app.post("/api/auth", express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!APP_PASSWORD) {
    return res.status(500).json({ error: "APP_PASSWORD niet ingesteld." });
  }
  if (password === APP_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Ongeldig wachtwoord." });
});

// ── Hoofdroute: verbetering ───────────────────────────────────────────
app.post(
  "/api/improve",
  (req, res, next) => {
    // multer verwerkt multipart; daarna hebben we req.body
    upload.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  requirePassword,
  async (req, res) => {
    const file = req.file;
    const extraContext = req.body?.context || "";

    if (!file) {
      return res.status(400).json({ error: "Geen bestand ontvangen." });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const filePath = file.path;
    let outputPath = null;

    try {
      // 1. Tekst extraheren
      const text = await parseDocument(filePath, ext);
      if (!text || text.trim().length < 10) {
        return res
          .status(422)
          .json({ error: "Kon geen leesbare tekst uit het document halen." });
      }

      // 2. AI: antwoorden genereren
      const answers = await getAnswersFromAI(text, extraContext);
      if (!answers || answers.length === 0) {
        return res
          .status(422)
          .json({ error: "AI kon geen vragen vinden in het document." });
      }

      // 3. Antwoorden injecteren in origineel document
      outputPath = await injectAnswers(filePath, ext, answers);

      // 4. Terugsturen
      const downloadName = `verbetersleutel_${file.originalname}`;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      );
      res.setHeader("Content-Type", "application/octet-stream");

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on("end", () => {
        cleanup(filePath, outputPath);
      });
      stream.on("error", (err) => {
        cleanup(filePath, outputPath);
        console.error("Stream fout:", err);
      });
    } catch (err) {
      cleanup(filePath, outputPath);
      console.error("Verwerkingsfout:", err);
      return res
        .status(500)
        .json({ error: err.message || "Onbekende serverfout." });
    }
  }
);

function cleanup(...paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  }
}

// ── SPA fallback ──────────────────────────────────────────────────────
if (fs.existsSync(DIST)) {
  app.get("*", (_req, res) => {
    res.sendFile(path.join(DIST, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`✅ Verbeterrobot draait op http://localhost:${PORT}`);
  if (!process.env.OMNIROUTE_API_KEY) {
    console.warn("⚠️  OMNIROUTE_API_KEY is niet ingesteld in .env");
  }
  if (!process.env.APP_PASSWORD || process.env.APP_PASSWORD === "changeme") {
    console.warn("⚠️  Stel een veilig APP_PASSWORD in via .env");
  }
});
