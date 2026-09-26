require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const required = [
  "TELEGRAM_BOT_TOKEN",
  "ADMIN_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MAIN_APP_API_URL",
  "MAIN_APP_API_SECRET"
];

for (const key of required) {
  if (!process.env[key]) console.warn(`[config] Missing ${key}`);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const supabaseOrigin = (() => {
  try { return new URL(process.env.SUPABASE_URL || "").origin; } catch { return ""; }
})();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://telegram.org"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", ...(supabaseOrigin ? [supabaseOrigin] : [])],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'", "https://web.telegram.org", "https://*.telegram.org"]
    }
  }
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", publicLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG and WebP images are accepted."));
    }
    cb(null, true);
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const bucket = process.env.SUPABASE_STORAGE_BUCKET || "task-proofs";
const OWNER_ID = String(process.env.ADMIN_ID || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const envMods = (process.env.MODERATOR_IDS || "")
  .split(",").map(x => x.trim()).filter(Boolean);

const bot = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
  : null;

const REASONS = {
  invalid_screenshot: "Invalid screenshot",
  wrong_task: "Wrong task",
  incomplete_proof: "Incomplete proof",
  unreadable_proof: "Unreadable proof",
  duplicate_submission: "Duplicate submission",
  task_requirements_not_met: "Task requirements not met",
  suspicious_submission: "Suspicious submission",
  other: "Other"
};

function nowIso() { return new Date().toISOString(); }
function clean(v, max = 500) { return String(v ?? "").trim().slice(0, max); }
function json(v, fallback = {}) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
function isOwner(id) { return String(id) === OWNER_ID; }

async function getModerator(id) {
  if (!id) return null;
  if (isOwner(id)) return { telegram_id: String(id), role: "OWNER", active: true };
  const { data } = await supabase.from("moderators").select("*")
    .eq("telegram_id", String(id)).eq("active", true).maybeSingle();
  return data || null;
}
async function requireRole(req, res, minimum = "MODERATOR") {
  const id = req.auth?.telegramId;
  const actor = await getModerator(id);
  if (!actor) return res.status(403).json({ error: "Admin authorization required." });
  if (minimum === "OWNER" && actor.role !== "OWNER") {
    return res.status(403).json({ error: "Owner authorization required." });
  }
  req.actor = actor;
  return null;
}
function authFromHeader(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return "";
}
function constantTime(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function verifyMainApi(req) {
  const token = authFromHeader(req);
  return token && constantTime(token, process.env.MAIN_APP_API_SECRET || "");
}
function telegramWebAppCheck(initData) {
  if (!initData || !process.env.TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const received = params.get("hash");
  if (!received) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData")
    .update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secret)
    .update(dataCheckString).digest("hex");
  if (!constantTime(calculated, received)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  return json(params.get("user"), null);
}

async function audit(actor, action, target, metadata = {}) {
  await supabase.from("audit_logs").insert({
    actor_telegram_id: String(actor || "system"),
    action, target: target ? String(target) : null, metadata
  });
}

async function ensureUser(payload) {
  const telegramId = clean(payload.user_telegram_id || payload.telegram_id, 100);
  if (!telegramId) throw new Error("user_telegram_id is required");
  const record = {
    telegram_id: telegramId,
    full_name: clean(payload.user_name || payload.full_name, 200) || null,
    username: clean(payload.username, 100) || null,
    main_app_user_id: clean(payload.main_app_user_id, 200) || null,
    registration_info: json(payload.registration_info),
    cached_main_app_profile: json(payload.cached_main_app_profile)
  };
  const { data, error } = await supabase.from("users").upsert(record, { onConflict: "telegram_id" })
    .select("*").single();
  if (error) throw error;
  return data;
}

async function createSignedUrl(storagePath) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 15 * 60);
  if (error) throw error;
  return data.signedUrl;
}

async function notifyMainApp(result) {
  const base = (process.env.MAIN_APP_API_URL || "").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/proof-result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${process.env.MAIN_APP_API_SECRET}`
    },
    body: JSON.stringify(result)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Main app callback ${response.status}: ${body.slice(0, 500)}`);
  return body ? json(body, { raw: body }) : {};
}

async function getProof(id) {
  const { data, error } = await supabase.from("proof_submissions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function serializeProof(p) {
  if (!p) return null;
  let screenshot_url = null;
  try { screenshot_url = await createSignedUrl(p.screenshot_path); } catch {}
  const { data: reviews } = await supabase.from("proof_reviews")
    .select("*").eq("submission_id", p.id).order("reviewed_at", { ascending: false });
  return { ...p, screenshot_url, reviews: reviews || [] };
}

async function reviewProof(id, actorId, action, reasonType, reason) {
  const proof = await getProof(id);
  if (!proof) throw Object.assign(new Error("Proof not found"), { status: 404 });
  if (proof.status !== "pending") throw Object.assign(new Error("Only pending proofs can be reviewed"), { status: 409 });

  if (action === "rejected" && !REASONS[reasonType]) {
    throw Object.assign(new Error("Invalid reject_reason_type"), { status: 400 });
  }

  const reviewedAt = nowIso();
  const update = {
    status: action,
    reviewed_at: reviewedAt,
    reviewed_by: String(actorId),
    reject_reason_type: action === "rejected" ? reasonType : null,
    reject_reason: action === "rejected" ? clean(reason, 2000) || null : null
  };

  const { data, error } = await supabase.from("proof_submissions")
    .update(update).eq("id", id).eq("status", "pending").select("*").single();
  if (error) throw error;

  await supabase.from("proof_reviews").insert({
    submission_id: id,
    reviewer_telegram_id: String(actorId),
    action,
    reject_reason_type: update.reject_reason_type,
    reject_reason: update.reject_reason
  });

  const callback = {
    event_id: `${data.submission_id}:${action}`,
    submission_id: data.submission_id,
    user_id: data.user_telegram_id,
    task_id: data.task_id,
    status: action,
    reviewed_by: String(actorId),
    reviewed_at: reviewedAt
  };
  if (action === "rejected") {
    callback.reject_reason_type = reasonType;
    callback.reject_reason = update.reject_reason;
  }

  let callbackError = null;
  try { await notifyMainApp(callback); }
  catch (e) { callbackError = e.message; }

  await audit(actorId, action === "approved" ? "proof_approved" : "proof_rejected",
    data.submission_id, { task_id: data.task_id, callback_error: callbackError });

  return { proof: await serializeProof(data), callback_error: callbackError };
}

async function deleteOneProof(id, actorId) {
  const proof = await getProof(id);
  if (!proof) throw Object.assign(new Error("Proof not found"), { status: 404 });
  if (!["approved", "rejected"].includes(proof.status)) {
    throw Object.assign(new Error("Only reviewed proofs can be deleted"), { status: 409 });
  }

  const { error: storageError } = await supabase.storage.from(bucket).remove([proof.screenshot_path]);
  if (storageError) throw storageError;

  const { error: dbError } = await supabase.from("proof_submissions").delete().eq("id", id);
  if (dbError) throw dbError;

  await audit(actorId, "proof_deleted", proof.submission_id, { status: proof.status });
  return proof;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Base44 -> Proof service: create a proof. Accept multipart image field "screenshot".
app.post("/api/proofs", (req, res, next) => {
  if (!verifyMainApi(req)) return res.status(401).json({ error: "Invalid API credentials." });
  upload.single("screenshot")(req, res, async err => {
    if (err) return next(err);
    try {
      const b = req.body || {};
      if (!req.file) return res.status(400).json({ error: "screenshot file is required." });
      const submissionId = clean(b.submission_id || crypto.randomUUID(), 200);
      const userId = clean(b.user_telegram_id, 100);
      const taskId = clean(b.task_id, 200);
      const taskName = clean(b.task_name, 300);
      if (!userId || !taskId || !taskName) {
        return res.status(400).json({ error: "user_telegram_id, task_id and task_name are required." });
      }

      await ensureUser({
        user_telegram_id: userId,
        user_name: b.user_name,
        username: b.username,
        main_app_user_id: b.main_app_user_id,
        registration_info: json(b.registration_info),
        cached_main_app_profile: json(b.cached_main_app_profile)
      });

      const ext = req.file.mimetype === "image/png" ? "png" :
        req.file.mimetype === "image/webp" ? "webp" : "jpg";
      const storagePath = `${userId}/${submissionId}/proof.${ext}`;

      const { error: uploadError } = await supabase.storage.from(bucket)
        .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (uploadError) throw uploadError;

      const { data, error } = await supabase.from("proof_submissions").insert({
        submission_id: submissionId,
        user_telegram_id: userId,
        user_name: clean(b.user_name, 200) || null,
        username: clean(b.username, 100) || null,
        task_id: taskId,
        task_name: taskName,
        task_description: clean(b.task_description, 5000) || null,
        task_metadata: json(b.task_metadata),
        status: "pending",
        screenshot_path: storagePath,
        submitted_at: b.submitted_at || nowIso()
      }).select("*").single();
      if (error) {
        await supabase.storage.from(bucket).remove([storagePath]);
        throw error;
      }

      const metadata = json(b.task_metadata);
      const entries = Object.entries(metadata);
      if (entries.length) {
        await supabase.from("proof_metadata").insert(entries.map(([key, value]) => ({
          submission_id: data.id, key, value
        })));
      }
      await audit(userId, "proof_submitted", submissionId, { task_id: taskId });
      return res.status(201).json({ proof: await serializeProof(data) });
    } catch (e) { next(e); }
  });
});

app.use("/api", async (req, res, next) => {
  if (["POST", "GET", "DELETE"].includes(req.method) && req.path !== "/proof-result") {
    // Admin routes use Telegram WebApp sessions or the server secret.
  }
  next();
});

// Admin web session. Frontend sends Telegram.WebApp.initData.
app.post("/api/admin/session", async (req, res) => {
  try {
    const user = telegramWebAppCheck(req.body?.initData);
    if (!user) return res.status(401).json({ error: "Invalid Telegram WebApp authentication." });
    const actor = await getModerator(user.id);
    if (!actor) return res.status(403).json({ error: "You are not an authorized reviewer." });
    res.json({ user, actor });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any Telegram user can authenticate here. Reviewers additionally receive their role.
app.post("/api/session", async (req, res) => {
  try {
    const user = telegramWebAppCheck(req.body?.initData);
    if (!user) return res.status(401).json({ error: "Invalid Telegram WebApp authentication." });
    const actor = await getModerator(user.id);
    res.json({ user, actor: actor || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User submission API. Task details/reward are never accepted from the browser.
// The main app is authoritative for the task.
app.use("/api/user", async (req, res, next) => {
  try {
    const initData = req.get("x-telegram-init-data") || req.body?.initData;
    const user = telegramWebAppCheck(initData);
    if (!user) return res.status(401).json({ error: "Valid Telegram WebApp authentication required." });
    req.auth = { telegramId: String(user.id), user };
    next();
  } catch (e) { next(e); }
});

async function getAuthoritativeTask(taskId, telegramId) {
  const base = (process.env.MAIN_APP_API_URL || "").replace(/\/+$/, "");
  const template = process.env.MAIN_APP_TASK_LOOKUP_PATH || "/api/proof-task/:taskId";
  const route = template.replace(":taskId", encodeURIComponent(taskId));
  if (!base) throw Object.assign(new Error("MAIN_APP_API_URL is not configured."), { status: 503 });
  const r = await fetch(`${base}${route}`, {
    headers: {
      authorization: `Bearer ${process.env.MAIN_APP_API_SECRET}`,
      "x-telegram-user-id": String(telegramId)
    }
  });
  const body = await r.text();
  if (!r.ok) throw Object.assign(new Error(`Task lookup failed (${r.status}).`), { status: r.status });
  const task = json(body, null);
  if (!task || task.id == null && task.task_id == null) {
    throw Object.assign(new Error("Main app returned an invalid task."), { status: 502 });
  }
  if (task.active === false || task.enabled === false) {
    throw Object.assign(new Error("This task is not accepting proofs."), { status: 409 });
  }
  return task;
}

app.get("/api/user/submissions", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("proof_submissions").select("id,submission_id,task_id,task_name,status,submitted_at,reviewed_at,reject_reason_type,reject_reason")
      .eq("user_telegram_id", req.auth.telegramId).order("submitted_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ submissions: data || [] });
  } catch (e) { next(e); }
});

app.post("/api/user/proofs", (req, res, next) => {
  upload.single("screenshot")(req, res, async err => {
    if (err) return next(err);
    try {
      if (!req.file) return res.status(400).json({ error: "Screenshot is required." });
      const taskId = clean(req.body?.task_id, 200);
      if (!taskId) return res.status(400).json({ error: "task_id is required." });
      const task = await getAuthoritativeTask(taskId, req.auth.telegramId);
      const authoritativeTaskId = clean(task.task_id ?? task.id, 200);
      const taskName = clean(task.task_name ?? task.name, 300);
      if (!authoritativeTaskId || !taskName) return res.status(502).json({ error: "Main app task response is missing task id/name." });
      const submissionId = clean(req.body?.submission_id || crypto.randomUUID(), 200);

      const { data: existing } = await supabase.from("proof_submissions").select("id,submission_id,status")
        .eq("submission_id", submissionId).maybeSingle();
      if (existing) return res.status(409).json({ error: "This submission has already been received.", submission_id: existing.submission_id, status: existing.status });

      await ensureUser({
        user_telegram_id: req.auth.telegramId,
        user_name: req.auth.user?.first_name ? `${req.auth.user.first_name}${req.auth.user.last_name ? ` ${req.auth.user.last_name}` : ""}` : null,
        username: req.auth.user?.username
      });
      const ext = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
      const storagePath = `${req.auth.telegramId}/${submissionId}/proof.${ext}`;
      const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (uploadError) throw uploadError;
      const metadata = {
        source: "telegram_proof_center",
        task_reward: task.reward ?? task.reward_amount ?? null,
        task_snapshot: task
      };
      const { data, error } = await supabase.from("proof_submissions").insert({
        submission_id: submissionId, user_telegram_id: req.auth.telegramId,
        user_name: req.auth.user?.first_name ? `${req.auth.user.first_name}${req.auth.user.last_name ? ` ${req.auth.user.last_name}` : ""}` : null,
        username: req.auth.user?.username || null, task_id: authoritativeTaskId, task_name: taskName,
        task_description: clean(task.description ?? task.task_description, 5000) || null,
        task_metadata: metadata, status: "pending", screenshot_path: storagePath
      }).select("*").single();
      if (error) { await supabase.storage.from(bucket).remove([storagePath]); throw error; }
      await audit(req.auth.telegramId, "proof_submitted", submissionId, { task_id: authoritativeTaskId });
      res.status(201).json({ proof: { id: data.id, submission_id: data.submission_id, task_id: data.task_id, task_name: data.task_name, status: data.status } });
    } catch (e) { next(e); }
  });
});

app.use("/api/admin", async (req, res, next) => {
  try {
    const initData = req.get("x-telegram-init-data") || req.body?.initData;
    const user = telegramWebAppCheck(initData);
    if (!user) return res.status(401).json({ error: "Valid Telegram WebApp authentication required." });
    req.auth = { telegramId: String(user.id), user };
    const denied = await requireRole(req, res, "MODERATOR");
    if (denied) return;
    next();
  } catch (e) { next(e); }
});

app.get("/api/admin/dashboard", async (req, res, next) => {
  try {
    const [pending, approved, rejected, total, mods, recent] = await Promise.all([
      supabase.from("proof_submissions").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("proof_submissions").select("id", { count: "exact", head: true }).eq("status", "approved").gte("reviewed_at", new Date(Date.now()-86400000).toISOString()),
      supabase.from("proof_submissions").select("id", { count: "exact", head: true }).eq("status", "rejected").gte("reviewed_at", new Date(Date.now()-86400000).toISOString()),
      supabase.from("proof_submissions").select("id", { count: "exact", head: true }),
      supabase.from("moderators").select("telegram_id", { count: "exact", head: true }).eq("active", true),
      supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(12)
    ]);
    res.json({
      pending: pending.count || 0, approved_today: approved.count || 0,
      rejected_today: rejected.count || 0, total: total.count || 0,
      active_moderators: (mods.count || 0) + (OWNER_ID ? 1 : 0), recent_activity: recent.data || []
    });
  } catch (e) { next(e); }
});

app.get("/api/admin/proofs", async (req, res, next) => {
  try {
    const status = clean(req.query.status, 20);
    const search = clean(req.query.search, 200);
    const sort = ["submitted_at","reviewed_at","created_at","task_name","status"].includes(req.query.sort)
      ? req.query.sort : "submitted_at";
    const ascending = req.query.order === "asc";
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    let q = supabase.from("proof_submissions").select("*").order(sort, { ascending }).limit(limit);
    if (["pending","approved","rejected"].includes(status)) q = q.eq("status", status);
    if (search) {
      const s = search.replace(/[(),]/g, " ");
      q = q.or(`username.ilike.%${s}%,user_telegram_id.ilike.%${s}%,task_id.ilike.%${s}%,task_name.ilike.%${s}%,submission_id.ilike.%${s}%`);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ proofs: data || [] });
  } catch (e) { next(e); }
});

app.get("/api/admin/proofs/:id", async (req, res, next) => {
  try {
    const proof = await getProof(req.params.id);
    if (!proof) return res.status(404).json({ error: "Proof not found." });
    const user = await getMainUser(proof.user_telegram_id);
    res.json({ proof: await serializeProof(proof), user });
  } catch (e) { next(e); }
});

app.post("/api/admin/proofs/:id/approve", async (req, res, next) => {
  try { res.json(await reviewProof(req.params.id, req.auth.telegramId, "approved")); }
  catch (e) { next(e); }
});

app.post("/api/admin/proofs/:id/reject", async (req, res, next) => {
  try {
    const type = clean(req.body?.reject_reason_type, 100);
    const reason = clean(req.body?.reject_reason, 2000);
    res.json(await reviewProof(req.params.id, req.auth.telegramId, "rejected", type, reason));
  } catch (e) { next(e); }
});

app.delete("/api/admin/proofs/:id", async (req, res, next) => {
  try {
    if (req.actor.role !== "OWNER") return res.status(403).json({ error: "Owner authorization required." });
    const deleted = await deleteOneProof(req.params.id, req.auth.telegramId);
    res.json({ deleted: true, submission_id: deleted.submission_id });
  } catch (e) { next(e); }
});

app.post("/api/admin/proofs/reviewed/delete", async (req, res, next) => {
  try {
    if (req.actor.role !== "OWNER") return res.status(403).json({ error: "Owner authorization required." });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 100) : [];
    const deleteAll = Boolean(req.body?.all);
    if (!ids.length && !deleteAll) return res.status(400).json({ error: "Provide ids or all:true." });

    let q = supabase.from("proof_submissions").select("id").in("status", ["approved","rejected"]);
    if (!deleteAll) q = q.in("id", ids);
    const { data, error } = await q;
    if (error) throw error;
    const targets = data || [];
    let count = 0;
    for (const row of targets) {
      try { await deleteOneProof(row.id, req.auth.telegramId); count++; } catch {}
    }
    await audit(req.auth.telegramId, "reviewed_proofs_bulk_deleted", "bulk", { count, requested: deleteAll ? "all" : ids.length });
    res.json({ deleted_count: count });
  } catch (e) { next(e); }
});

async function getMainUser(telegramId) {
  const base = (process.env.MAIN_APP_API_URL || "").replace(/\/+$/, "");
  const r = await fetch(`${base}/api/users/${encodeURIComponent(telegramId)}`, {
    headers: { authorization: `Bearer ${process.env.MAIN_APP_API_SECRET}` }
  });
  if (!r.ok) return { telegram_id: telegramId, source_error: `main_app_${r.status}` };
  const body = await r.text();
  return json(body, { telegram_id: telegramId });
}

app.get("/api/admin/users/:telegramId", async (req, res, next) => {
  try {
    const id = clean(req.params.telegramId, 100);
    const [local, remote] = await Promise.all([
      supabase.from("users").select("*").eq("telegram_id", id).maybeSingle(),
      getMainUser(id)
    ]);
    if (local.error) throw local.error;
    res.json({ local: local.data, main_app: remote });
  } catch (e) { next(e); }
});

app.get("/api/admin/users/:telegramId/history", async (req, res, next) => {
  try {
    const id = clean(req.params.telegramId, 100);
    const { data, error } = await supabase.from("proof_submissions").select(
      "submission_id,user_telegram_id,task_id,task_name,status,reviewed_by,reviewed_at,submitted_at,reject_reason_type,reject_reason"
    ).eq("user_telegram_id", id).order("submitted_at", { ascending: false });
    if (error) throw error;
    const main = await getMainUser(id);
    res.json({ proofs: data || [], main_app: main });
  } catch (e) { next(e); }
});

app.get("/api/admin/tasks/:taskId", async (req, res, next) => {
  try {
    const id = clean(req.params.taskId, 200);
    const { data, error } = await supabase.from("proof_submissions").select("*").eq("task_id", id).order("submitted_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ proofs: data || [] });
  } catch (e) { next(e); }
});

app.get("/api/admin/moderators", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("moderators").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ owner: OWNER_ID, moderators: data || [] });
  } catch (e) { next(e); }
});

app.post("/api/admin/moderators", async (req, res, next) => {
  try {
    if (req.actor.role !== "OWNER") return res.status(403).json({ error: "Owner authorization required." });
    const telegram_id = clean(req.body?.telegram_id, 100);
    if (!telegram_id || !/^\d+$/.test(telegram_id)) return res.status(400).json({ error: "Valid numeric Telegram ID required." });
    const row = {
      telegram_id, full_name: clean(req.body?.full_name, 200) || null,
      username: clean(req.body?.username, 100) || null,
      role: "MODERATOR", added_by: req.auth.telegramId, active: true
    };
    const { data, error } = await supabase.from("moderators").upsert(row, { onConflict: "telegram_id" }).select().single();
    if (error) throw error;
    await audit(req.auth.telegramId, "moderator_added", telegram_id, {});
    res.status(201).json(data);
  } catch (e) { next(e); }
});

app.patch("/api/admin/moderators/:telegramId", async (req, res, next) => {
  try {
    if (req.actor.role !== "OWNER") return res.status(403).json({ error: "Owner authorization required." });
    const id = clean(req.params.telegramId, 100);
    const active = Boolean(req.body?.active);
    const { data, error } = await supabase.from("moderators").update({ active }).eq("telegram_id", id).select().single();
    if (error) throw error;
    await audit(req.auth.telegramId, active ? "moderator_enabled" : "moderator_disabled", id, {});
    res.json(data);
  } catch (e) { next(e); }
});

app.delete("/api/admin/moderators/:telegramId", async (req, res, next) => {
  try {
    if (req.actor.role !== "OWNER") return res.status(403).json({ error: "Owner authorization required." });
    const id = clean(req.params.telegramId, 100);
    const { error } = await supabase.from("moderators").delete().eq("telegram_id", id).neq("role", "OWNER");
    if (error) throw error;
    await audit(req.auth.telegramId, "moderator_removed", id, {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

app.post("/api/admin/messages", async (req, res, next) => {
  try {
    const userId = clean(req.body?.user_telegram_id, 100);
    const message = clean(req.body?.message, 4000);
    if (!userId || !message) return res.status(400).json({ error: "user_telegram_id and message are required." });
    if (!bot) return res.status(503).json({ error: "Telegram bot is not configured." });
    let delivery_status = "sent", telegram_message_id = null;
    try {
      const sent = await bot.sendMessage(userId, message);
      telegram_message_id = sent.message_id;
    } catch (e) { delivery_status = "failed"; }
    await supabase.from("admin_messages").insert({
      user_telegram_id: userId, admin_telegram_id: req.auth.telegramId,
      message, delivery_status, telegram_message_id
    });
    await audit(req.auth.telegramId, "personal_message_sent", userId, { delivery_status });
    res.json({ delivery_status, telegram_message_id });
  } catch (e) { next(e); }
});

app.post("/api/admin/broadcasts", async (req, res, next) => {
  try {
    if (req.actor.role !== "OWNER") return res.status(403).json({ error: "Owner authorization required." });
    if (!bot) return res.status(503).json({ error: "Telegram bot is not configured." });
    const message = clean(req.body?.message, 4000);
    const ids = Array.isArray(req.body?.user_telegram_ids) ? req.body.user_telegram_ids.map(String).slice(0, 5000) : [];
    if (!message || !ids.length) return res.status(400).json({ error: "message and user_telegram_ids are required." });

    const { data: broadcast, error } = await supabase.from("broadcasts").insert({
      created_by: req.auth.telegramId, message, target_type: "selected",
      target_data: { user_telegram_ids: ids }, total_targets: ids.length, status: "sending"
    }).select().single();
    if (error) throw error;

    let sent = 0, failed = 0;
    for (const id of ids) {
      try { await bot.sendMessage(id, message); sent++; }
      catch { failed++; }
      await new Promise(r => setTimeout(r, 35));
    }
    await supabase.from("broadcasts").update({
      sent_count: sent, failed_count: failed, status: "completed", completed_at: nowIso()
    }).eq("id", broadcast.id);
    await audit(req.auth.telegramId, "broadcast_sent", broadcast.id, { sent, failed });
    res.json({ broadcast_id: broadcast.id, sent_count: sent, failed_count: failed });
  } catch (e) { next(e); }
});

// Main-app callback endpoint is intentionally not public unless authenticated.
app.post("/api/proof-result", (req, res) => {
  if (!verifyMainApi(req)) return res.status(401).json({ error: "Invalid API credentials." });
  res.json({ received: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? "Internal server error." : err.message });
});

// Telegram bot: the bot itself is the entry point. Every user gets a real Web App button;
// reviewers additionally see the reviewer/admin tools inside the same Web App.
if (bot) {
  const webUrl = PUBLIC_BASE_URL;
  if (!webUrl) console.warn("[config] PUBLIC_BASE_URL is missing; Telegram Web App buttons cannot be configured.");

  bot.setMyCommands([
    { command: "start", description: "Open HillsByte Proof Center" },
    { command: "pending", description: "View pending proofs (reviewers)" },
    { command: "dashboard", description: "Open reviewer dashboard" },
    { command: "moderators", description: "Manage moderators (owner)" }
  ]).catch(console.error);

  const webButton = () => webUrl ? ({ inline_keyboard: [[{ text: "🚀 Open Proof Center", web_app: { url: webUrl } }]] }) : undefined;
  const replyWebButton = () => webUrl ? ({ keyboard: [[{ text: "🚀 Open Proof Center", web_app: { url: webUrl } }]], resize_keyboard: true, is_persistent: true }) : undefined;

  async function sendStart(chatId, from) {
    const actor = await getModerator(from?.id || chatId);
    if (actor) {
      return bot.sendMessage(chatId,
        `🛡 *HillsByte Proof Center*\n\nWelcome ${actor.role === "OWNER" ? "Owner" : "Moderator"}. Open the secure Web App to review submissions.`,
        { parse_mode: "Markdown", reply_markup: webButton() || { remove_keyboard: true } });
    }
    return bot.sendMessage(chatId,
      "👋 *Welcome to HillsByte Proof Center*\n\nSubmit your task screenshot here and track the review result. The task and reward are verified by the HillsByte main app.",
      { parse_mode: "Markdown", reply_markup: webButton() || replyWebButton() });
  }

  bot.onText(/^\/start(?:\s+.*)?$/, msg => sendStart(msg.chat.id, msg.from));
  bot.onText(/^\/dashboard$/, async msg => {
    const actor = await getModerator(msg.from.id);
    if (!actor) return;
    if (webUrl) return bot.sendMessage(msg.chat.id, "Open the reviewer dashboard:", { reply_markup: webButton() });
    const { data } = await supabase.from("proof_submissions").select("status");
    const counts = { pending:0, approved:0, rejected:0 };
    for (const x of data || []) counts[x.status] = (counts[x.status] || 0) + 1;
    return bot.sendMessage(msg.chat.id, `📊 Dashboard\n\n🕐 Pending: ${counts.pending}\n✅ Approved: ${counts.approved}\n❌ Rejected: ${counts.rejected}`);
  });
  bot.onText(/^\/pending$/, async msg => {
    const actor = await getModerator(msg.from.id);
    if (!actor) return;
    if (webUrl) return bot.sendMessage(msg.chat.id, "Open Proof Center to review pending proofs:", { reply_markup: webButton() });
    const { data } = await supabase.from("proof_submissions").select("*").eq("status","pending").order("submitted_at",{ascending:false}).limit(10);
    if (!data?.length) return bot.sendMessage(msg.chat.id, "No pending proofs.");
    for (const p of data) await bot.sendMessage(msg.chat.id, `🕐 ${p.task_name}\nID: ${p.submission_id}`);
  });
  bot.onText(/^\/moderators$/, async msg => {
    const actor = await getModerator(msg.from.id);
    if (!actor || actor.role !== "OWNER") return;
    return bot.sendMessage(msg.chat.id, webUrl ? "Moderator management is available in the secure Proof Center:" : "Open the web Proof Center to manage moderators.", webUrl ? { reply_markup: webButton() } : undefined);
  });

  // Put the Web App in Telegram's bot menu as well. This is separate from the /start button.
  async function telegramApi(method, payload) {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {})
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.description || `Telegram API ${r.status}`);
    return body.result;
  }
  if (webUrl) {
    telegramApi("setChatMenuButton", { menu_button: { type: "web_app", text: "Proof Center", web_app: { url: webUrl } } })
      .catch(e => console.error("[telegram menu]", e.message));
  }
  bot.getMe().then(me => console.log(`[telegram] connected as @${me.username} (${me.id})`)).catch(e => console.error("[telegram] token check failed", e.message));
  bot.on("polling_error", e => console.error("[telegram]", e.message));
}

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`HillsByte Proof Center listening on ${PORT}`));
