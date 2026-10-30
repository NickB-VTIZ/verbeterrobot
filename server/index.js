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
import { runDocxPipeline, extractDocxParagraphs } from "./docx/pipeline.js";
import { runWithLlmContext } from "./storage/llmlog.js";
import {
  createDocument,
  saveParagraphs,
  addVersion,
  listVersions,
  setStatus,
  audit,
  purgeExpired,
} from "./storage/repo.js";
import { generateOriginalPreview, generateVersionPreview, retryMissingPreviews } from "./storage/previews.js";
import { buildGenerationContext } from "./context.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { toolsAvailable } from "./docx/visual.js";
import {
  listSubjectsPublic,
  listSubjectsAdmin,
  getSubject,
  upsertSubject,
  deleteSubject,
  addReference,
  removeReference,
  buildSubjectContext,
} from "./subjects.js";
import { listLessons, addLesson, deleteLesson, buildTrainingContext } from "./training.js";
import { memoryActive, memoryConfigured, rememberLesson, recallLessons } from "./memory.js";
import {
  VERSION,
  uptimeSeconds,
  lastResult,
  testOmniroute,
  testAgentmemory,
} from "./health.js";
import {
  getSettings,
  publicSettings,
  updateSettings,
  verifyAdminPassword,
  verifyTeacherPassword,
  adminConfigured,
  teacherConfigured,
} from "./settings.js";
import {
  createSession,
  destroySession,
  requireRole,
  sessionRole,
  sessionUser,
  tokenFromReq,
  loginAllowed,
  registerFailure,
  registerSuccess,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3010;
const DIST = path.join(__dirname, "..", "dist");
const UPLOADS = path.join(__dirname, "..", "uploads");

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ── Multer ────────────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([
  ".docx", ".pdf", ".pptx", ".xlsx", ".xls", ".txt",
]);

const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

/** Maakt per aanvraag een multer-instantie, zodat de limiet uit het beheer meteen geldt. */
function makeUpload() {
  return multer({
    storage,
    limits: { fileSize: getSettings().maxFileMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return cb(new Error(`Bestandstype '${ext}' is niet toegelaten.`));
      }
      cb(null, true);
    },
  });
}

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Statische frontend
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
}

// ── Health & publieke config ──────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true, version: VERSION }));

app.get("/api/config", (_req, res) =>
  res.json({ maxFileMb: getSettings().maxFileMb, version: VERSION })
);

// Vakken + onderwerpen (voor de keuzelijst van de leerkracht)
app.get("/api/subjects", requireRole("teacher", "admin"), (_req, res) =>
  res.json(listSubjectsPublic())
);

// ── Aanmelden ─────────────────────────────────────────────────────────
// Body: { role: "teacher" | "admin", password }
app.post("/api/login", (req, res) => {
  const ip = req.ip;
  if (!loginAllowed(ip)) {
    return res
      .status(429)
      .json({ error: "Te veel mislukte pogingen. Probeer het later opnieuw." });
  }

  const { role, password } = req.body || {};
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (role !== "teacher" && role !== "admin") {
    return res.status(400).json({ error: "Ongeldige rol." });
  }
  if (role === "teacher" && name.length < 2) {
    return res.status(400).json({ error: "Geef je naam op (minstens 2 tekens)." });
  }
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Wachtwoord ontbreekt." });
  }

  if (role === "admin") {
    if (!adminConfigured()) {
      return res
        .status(500)
        .json({ error: "ADMIN_PASSWORD is niet ingesteld op de server." });
    }
  } else if (!teacherConfigured()) {
    return res
      .status(500)
      .json({ error: "Er is nog geen leerkrachtenwachtwoord ingesteld." });
  }

  const ok =
    role === "admin" ? verifyAdminPassword(password) : verifyTeacherPassword(password);
  if (!ok) {
    registerFailure(ip);
    return res.status(401).json({ error: "Ongeldig wachtwoord." });
  }

  registerSuccess(ip);
  const finalName = name || (role === "admin" ? "Beheerder" : "Leerkracht");
  return res.json({ ok: true, role, name: finalName, token: createSession(role, finalName) });
});

app.post("/api/logout", (req, res) => {
  destroySession(tokenFromReq(req));
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  const role = sessionRole(req);
  if (!role) return res.status(401).json({ error: "Niet aangemeld." });
  res.json({ role, name: sessionUser(req) });
});

// ── Beheer ────────────────────────────────────────────────────────────
app.get("/api/admin/settings", requireRole("admin"), (_req, res) =>
  res.json(publicSettings())
);

app.put("/api/admin/settings", requireRole("admin"), (req, res) => {
  try {
    res.json(updateSettings(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Beheer: vakken ("training") ───────────────────────────────────────
function handle(fn) {
  return (req, res) => {
    try {
      res.json(fn(req) ?? { ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

app.get("/api/admin/subjects", requireRole("admin"), (_req, res) =>
  res.json(listSubjectsAdmin())
);
app.post("/api/admin/subjects", requireRole("admin"), handle((req) => upsertSubject(req.body)));
app.put("/api/admin/subjects/:id", requireRole("admin"), handle((req) => upsertSubject(req.body, req.params.id)));
app.delete("/api/admin/subjects/:id", requireRole("admin"), handle((req) => deleteSubject(req.params.id)));

// Referentiemateriaal: bestand uploaden (tekst wordt geëxtraheerd, bestand wordt verwijderd)
app.post(
  "/api/admin/subjects/:id/references",
  requireRole("admin"),
  (req, res, next) => {
    makeUpload().single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    const file = req.file;
    try {
      if (!getSubject(req.params.id)) throw new Error("Vak niet gevonden.");
      let text = String(req.body?.tekst ?? "");
      let naam = String(req.body?.naam ?? "");
      if (file) {
        const ext = path.extname(file.originalname).toLowerCase();
        text = await parseDocument(file.path, ext);
        naam = naam || file.originalname;
      }
      res.json(addReference(req.params.id, naam, text));
    } catch (err) {
      res.status(400).json({ error: err.message });
    } finally {
      if (file) cleanup(file.path);
    }
  }
);
app.delete(
  "/api/admin/subjects/:id/references/:refId",
  requireRole("admin"),
  handle((req) => removeReference(req.params.id, req.params.refId))
);

// ── Beheer: trainingslessen + agentmemory ─────────────────────────────
app.get("/api/admin/training", requireRole("admin"), (_req, res) =>
  res.json({ lessons: listLessons(), memoryActive: memoryActive() })
);
app.post("/api/admin/training", requireRole("admin"), async (req, res) => {
  try {
    const { tekst, vakId, soort } = req.body || {};
    const vak = vakId ? getSubject(String(vakId)) : null;
    if (vakId && !vak) throw new Error("Vak niet gevonden.");
    const lesson = addLesson({ tekst, vakId: vak?.id || null, vakNaam: vak?.naam || "", soort });
    let memory = "uit";
    if (memoryActive()) {
      try {
        await rememberLesson({ tekst: lesson.tekst, vak: vak?.naam, soort: lesson.soort });
        memory = "opgeslagen";
      } catch (err) {
        memory = `mislukt: ${err.message}`;
      }
    }
    res.json({ lesson, memory });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete("/api/admin/training/:id", requireRole("admin"), handle((req) => deleteLesson(req.params.id)));

// Statusoverzicht voor het beheerscherm
app.get("/api/admin/status", requireRole("admin"), async (_req, res) => {
  const cfg = getSettings();
  const pub = publicSettings();
  let tools = null;
  try {
    tools = await toolsAvailable();
  } catch {
    tools = null;
  }
  res.json({
    visual: {
      enabled: cfg.visualCheckEnabled !== false && process.env.VISUAL_CHECK !== "off",
      visionModel: cfg.visionModel || "",
      libreoffice: tools ? tools.soffice : null,
      libreofficeVersion: tools ? tools.version : "",
      poppler: tools ? tools.pdftoppm : false,
      available: tools ? tools.available : false,
    },
    version: VERSION,
    uptimeSeconds: uptimeSeconds(),
    node: process.version,
    omniroute: {
      baseUrl: cfg.omnirouteBaseUrl,
      model: cfg.omnirouteModel,
      configured: !!(cfg.omnirouteBaseUrl && cfg.omnirouteApiKey),
      last: lastResult("omniroute"),
    },
    memory: {
      enabled: !!cfg.memoryEnabled,
      configured: memoryConfigured(),
      url: cfg.memoryUrl || "",
      project: cfg.memoryProject || "",
      last: lastResult("memory"),
    },
    counts: { subjects: listSubjectsAdmin().length, lessons: listLessons().length },
    teacherPasswordSource: pub.teacherPasswordSource,
    teacherConfigured: teacherConfigured(),
    maxFileMb: cfg.maxFileMb,
  });
});

// Test de verbinding met de agentmemory-server (opgeslagen instellingen)
app.post("/api/admin/memory/test", requireRole("admin"), async (_req, res) => {
  try {
    res.json(await testAgentmemory());
  } catch (err) {
    res.status(502).json({ ok: false, error: `Verbinding mislukt: ${err.message}` });
  }
});

// Test de verbinding met Omniroute (opgeslagen instellingen); { deep: true } doet ook een chat-test
app.post("/api/admin/test", requireRole("admin"), async (req, res) => {
  try {
    res.json(await testOmniroute({ deep: !!req.body?.deep }));
  } catch (err) {
    res.status(502).json({ ok: false, error: `Verbinding mislukt: ${err.message}` });
  }
});

// ── Hoofdroute: verbetering (leerkracht én beheerder) ─────────────────
app.post(
  "/api/improve",
  requireRole("teacher", "admin"),
  (req, res, next) => {
    // multer verwerkt multipart; daarna hebben we req.body
    makeUpload().single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const file = req.file;
    const extraContext = req.body?.context || "";
    const subject = req.body?.subjectId ? getSubject(String(req.body.subjectId)) : null;
    let topics = [];
    try {
      topics = JSON.parse(req.body?.topics || "[]");
      if (!Array.isArray(topics)) topics = [];
    } catch {
      topics = [];
    }

    if (!file) {
      return res.status(400).json({ error: "Geen bestand ontvangen." });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const filePath = file.path;
    let outputPath = null;
    let docId = null;
    const fail = (status, message) => {
      if (docId) {
        try {
          setStatus(docId, "mislukt");
          audit(docId, req.user, req.role, "generatie_mislukt", { fout: String(message).slice(0, 300) });
        } catch {
          /* negeren */
        }
      }
      cleanup(filePath, outputPath);
      return res.status(status).json({ error: message, documentId: docId });
    };

    try {
      // 1. Tekst extraheren
      const text = await parseDocument(filePath, ext);
      if (!text || text.trim().length < 10) {
        return fail(422, "Kon geen leesbare tekst uit het document halen.");
      }

      // 1b. Permanent opslaan: origineel ongewijzigd + metadata (P4)
      const body = req.body || {};
      const created = createDocument({
        srcPath: filePath,
        originalName: file.originalname,
        user: req.user,
        vak: subject?.naam || body.vak || "",
        vakId: subject?.id || "",
        leerjaar: body.leerjaar,
        richting: body.richting,
        schooljaar: body.schooljaar,
        tags: body.tags,
        title: body.title,
        fullText: text,
        genOptions: { context: extraContext, topics, subjectId: subject?.id || null },
      });
      docId = created.doc.id;
      audit(docId, req.user, req.role, "upload", {
        bestand: file.originalname,
        grootte: file.size,
        duplicaatVan: created.duplicates.map((d) => d.id),
      });
      const llmCtx = { documentId: docId, callType: "generatie", vak: subject?.naam || "", teacher: req.user };

      // 2. AI: antwoorden genereren
      const subjectContext = await buildGenerationContext({ subject, topics, text });
      let slotsForVersion = [];
      let questionsForVersion = [];
      let qcIssues = [];
      // 2a. .docx: gestructureerde pipeline (paragraaf-ID's, slots, controle van berekeningen)
      let review = null;
      let clarifications = [];
      let visualStatus = "";
      // Voor .docx is er bewust GEEN terugval op de klassieke tekst-matching/achteraan-methode:
      // een antwoord dat niet op een geldige plaats kan, wordt "handmatig nakijken" en nooit achteraan gezet.
      const docxPipelineOn = ext === ".docx" && process.env.DOCX_PIPELINE !== "off";
      if (docxPipelineOn) {
        let result = null;
        try {
          const paras = await extractDocxParagraphs(filePath);
          saveParagraphs(docId, paras);
          result = await runWithLlmContext(llmCtx, () =>
            runDocxPipeline(filePath, { extraContext, subjectContext })
          );
        } catch (err) {
          console.error("docx-pipeline mislukt:", err.message);
          return fail(502, `Het Word-document kon niet betrouwbaar verwerkt worden: ${err.message}`);
        }
        if (!result) {
          return fail(
            422,
            "Er werden geen vragen of antwoordplaatsen herkend in dit Word-document. " +
              "Er is niets achteraan toegevoegd. Controleer het document of duid de vragen zelf aan."
          );
        }
        outputPath = result.outputPath;
        slotsForVersion = result.slots;
        questionsForVersion = result.questionList;
        qcIssues = [...result.warnings, ...result.review.map((r) => `${r.qid}: ${r.reden}`)];
        review = result.review;
        clarifications = result.clarifications || [];
        visualStatus = result.visual?.status || "";
        for (const w of result.warnings) console.warn("docx-pipeline:", w);
        console.log(
          `docx-pipeline: ${result.questions} vraag/vragen, ${review.length} om na te kijken.`
        );
      }

      // 2b. Klassieke methode (andere formaten dan .docx, of DOCX_PIPELINE=off)
      if (!outputPath) {
        const answers = await getAnswersFromAI(text, extraContext, subjectContext);
        if (!answers || answers.length === 0) {
          return fail(422, "AI kon geen vragen vinden in het document.");
        }

        // 3. Antwoorden injecteren in origineel document
        outputPath = await injectAnswers(filePath, ext, answers);
        slotsForVersion = answers.map((a, i) => ({ qid: `k${i + 1}`, para_id: "", type: "klassiek", content: a.antwoord ?? a.answer ?? "" }));
      }

      // 3b. Versie permanent bewaren (nooit overschrijven)
      const versionNumber = addVersion({
        docId,
        outputPath,
        ext: path.extname(outputPath).toLowerCase() || ext,
        createdBy: req.user,
        summary: { aantalVragen: questionsForVersion.length, nakijken: review ? review.length : 0, visueel: visualStatus || null },
        qcIssues,
        slots: slotsForVersion,
        questions: questionsForVersion,
      });
      audit(docId, req.user, req.role, "gegenereerd", { versie: versionNumber });
      generateOriginalPreview(docId);
      generateVersionPreview(docId, versionNumber);
      res.setHeader("X-Document-Id", docId);
      res.setHeader("X-Version", String(versionNumber));
      res.setHeader(
        "Access-Control-Expose-Headers",
        "X-Document-Id, X-Version, X-Nakijken, X-Nakijken-Aantal, X-Verduidelijking, X-Visuele-Controle"
      );

      if (review) {
        res.setHeader("X-Nakijken-Aantal", String(review.length));
        if (review.length) {
          res.setHeader(
            "X-Nakijken",
            encodeURIComponent(JSON.stringify(review)).slice(0, 4000)
          );
        }
        if (clarifications.length) {
          res.setHeader(
            "X-Verduidelijking",
            encodeURIComponent(JSON.stringify(clarifications)).slice(0, 3000)
          );
        }
        if (visualStatus) res.setHeader("X-Visuele-Controle", visualStatus);
      }

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
      console.error("Verwerkingsfout:", err);
      return fail(500, err.message || "Onbekende serverfout.");
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

// ── Bibliotheek, markeren, versies, prullenbak, beheeroverzicht ───────
registerLibraryRoutes(app, { makeUpload });

// ── SPA fallback ──────────────────────────────────────────────────────
if (fs.existsSync(DIST)) {
  app.get("*", (_req, res) => {
    res.sendFile(path.join(DIST, "index.html"));
  });
}

function runMaintenance() {
  try {
    const purged = purgeExpired();
    if (purged && (purged.length || purged.purged)) {
      console.log("🗑️  Verlopen documenten uit de prullenbak verwijderd.");
    }
  } catch (e) {
    console.warn("Prullenbak opruimen mislukt:", e.message);
  }
  try {
    retryMissingPreviews();
  } catch (e) {
    console.warn("Previews opnieuw proberen mislukt:", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`✅ Verbeterrobot draait op http://localhost:${PORT}`);
  runMaintenance();
  setInterval(runMaintenance, 60 * 60 * 1000).unref();
  if (!getSettings().omnirouteApiKey) {
    console.warn("⚠️  Geen Omniroute API-sleutel ingesteld (.env of beheer).");
  }
  if (!adminConfigured()) {
    console.warn("⚠️  ADMIN_PASSWORD is niet ingesteld: beheer is niet bereikbaar.");
  }
  if (!teacherConfigured()) {
    console.warn("⚠️  Geen leerkrachtenwachtwoord (TEACHER_PASSWORD/APP_PASSWORD) ingesteld.");
  }
});
