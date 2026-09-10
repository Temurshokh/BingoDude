import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import { db, initializeDatabase, now } from "./db.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const IMAGE_LIMIT = 98_304;
const STORY_LIFETIME = 24 * 60 * 60 * 1000;
const defaultOrigins = [
  "https://dude-bingo.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000"
];
const envOrigins = (process.env.FRONTEND_ORIGIN || "").split(",").map(origin => origin.trim().replace(/\/$/, "")).filter(Boolean);
const allowedOrigins = new Set([...defaultOrigins, ...envOrigins]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    return callback(null, false);
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: false,
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: "256kb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_LIMIT },
  fileFilter: (_req, file, callback) => callback(null, new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]).has(file.mimetype))
});

type User = { id: number; username: string };
type AuthRequest = Request & { user?: User };
type ImageRow = { id: string; mimeType: string; data: Buffer };

function cleanUsername(input: unknown) { return String(input ?? "").trim().replace(/^@/, "").toLowerCase(); }
function validUsername(username: string) { return /^[a-z0-9_]{2,24}$/.test(username); }
function cleanText(input: unknown, max: number) { return String(input ?? "").trim().slice(0, max); }
function tokenFrom(req: Request) { return req.header("authorization")?.startsWith("Bearer ") ? req.header("authorization")!.slice(7).trim() : ""; }
function asNumber(value: unknown) { return Number(value); }
function imageUrl(imageId: string | null) { return imageId ? `/api/images/${imageId}` : null; }
function userObject(row: { id: string | number; username: string }): User { return { id: asNumber(row.id), username: row.username }; }

async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = tokenFrom(req);
    if (!token) return res.status(401).json({ error: "Sign in first." });
    const result = await db.query<{ id: string; username: string }>(`
      SELECT u.id::text AS id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1
    `, [token]);
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: "Session expired." });
    await db.query("UPDATE sessions SET last_seen_at = $1 WHERE token = $2", [now(), token]);
    req.user = userObject(row);
    next();
  } catch (error) { next(error); }
}

async function saveImage(file: Express.Multer.File | undefined) {
  if (!file) return null;
  if (file.size >= 99 * 1024) throw new Error("Image must be smaller than 99 KB.");
  if (!new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]).has(file.mimetype)) throw new Error("Unsupported image type.");
  const id = crypto.randomUUID();
  await db.query("INSERT INTO images (id, mime_type, size_bytes, data, created_at) VALUES ($1, $2, $3, $4, $5)", [id, file.mimetype, file.size, file.buffer, now()]);
  return id;
}

async function deleteImageIfUnused(id: string | null) {
  if (!id) return;
  await db.query(`DELETE FROM images i WHERE i.id = $1 AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.image_id = i.id) AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.image_id = i.id)`, [id]);
}

async function cleanupStories() {
  const expired = await db.query<{ imageId: string | null }>("DELETE FROM stories WHERE expires_at <= $1 RETURNING image_id AS \"imageId\"", [now()]);
  await Promise.all(expired.rows.map(story => deleteImageIfUnused(story.imageId)));
}

function postObject(row: any) {
  return { id: asNumber(row.id), content: row.content, imagePath: imageUrl(row.imageId), createdAt: asNumber(row.createdAt), userId: asNumber(row.userId), username: row.username, replyCount: asNumber(row.replyCount) };
}
function storyObject(row: any) {
  return { id: asNumber(row.id), content: row.content, imagePath: imageUrl(row.imageId), createdAt: asNumber(row.createdAt), expiresAt: asNumber(row.expiresAt), userId: asNumber(row.userId), username: row.username };
}
const postFields = `p.id::text AS id, p.content, p.image_id AS "imageId", p.created_at::text AS "createdAt", u.id::text AS "userId", u.username, (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id)::text AS "replyCount"`;
const storyFields = `s.id::text AS id, s.content, s.image_id AS "imageId", s.created_at::text AS "createdAt", s.expires_at::text AS "expiresAt", u.id::text AS "userId", u.username`;

app.get("/api/health", async (_req, res, next) => {
  try { await db.query("SELECT 1"); res.json({ ok: true, database: "connected" }); } catch (error) { next(error); }
});

app.get("/api/images/:id", async (req, res, next) => {
  try {
    const image = await db.query<ImageRow>("SELECT id, mime_type AS \"mimeType\", data FROM images WHERE id = $1", [req.params.id]);
    const row = image.rows[0];
    if (!row) return res.sendStatus(404);
    res.set({ "Content-Type": row.mimeType, "Cache-Control": "public, max-age=31536000, immutable" }).send(row.data);
  } catch (error) { next(error); }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const username = cleanUsername(req.body?.username);
    if (!validUsername(username)) return res.status(400).json({ error: "Username: 2–24 lowercase letters, numbers, or underscores." });
    const createdAt = now();
    const created = await db.query<{ id: string; username: string }>("INSERT INTO users (username, created_at) VALUES ($1, $2) RETURNING id::text AS id, username", [username, createdAt]);
    const user = userObject(created.rows[0]);
    const token = crypto.randomBytes(32).toString("hex");
    await db.query("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES ($1, $2, $3, $4)", [token, user.id, createdAt, createdAt]);
    res.status(201).json({ token, user });
  } catch (error: any) { if (error?.code === "23505") return res.status(409).json({ error: "That username is already taken." }); next(error); }
});

app.post("/api/auth/access", async (req, res, next) => {
  try {
    const username = cleanUsername(req.body?.username);
    if (!validUsername(username)) return res.status(400).json({ error: "Enter a valid username." });
    const found = await db.query<{ id: string; username: string }>("SELECT id::text AS id, username FROM users WHERE username = $1", [username]);
    if (!found.rows[0]) return res.status(404).json({ error: "No account with that username exists." });
    const user = userObject(found.rows[0]); const token = crypto.randomBytes(32).toString("hex"); const timestamp = now();
    await db.query("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES ($1, $2, $3, $4)", [token, user.id, timestamp, timestamp]);
    res.json({ token, user });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", authenticate, async (req, res, next) => { try { await db.query("DELETE FROM sessions WHERE token = $1", [tokenFrom(req)]); res.json({ ok: true }); } catch (error) { next(error); } });
app.get("/api/me", authenticate, (req: AuthRequest, res) => res.json({ user: req.user }));

app.get("/api/feed", authenticate, async (_req, res, next) => {
  try {
    await cleanupStories();
    const [posts, stories] = await Promise.all([
      db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200`),
      db.query(`SELECT ${storyFields} FROM stories s JOIN users u ON u.id = s.user_id WHERE s.expires_at > $1 ORDER BY s.created_at DESC`, [now()])
    ]);
    res.json({ posts: posts.rows.map(postObject), stories: stories.rows.map(storyObject) });
  } catch (error) { next(error); }
});

app.post("/api/posts", authenticate, upload.single("image"), async (req: AuthRequest, res, next) => {
  try {
    const content = cleanText(req.body?.content, 2000);
    if (!content && !req.file) return res.status(400).json({ error: "Write something or attach an image." });
    const imageId = await saveImage(req.file);
    const created = await db.query<{ id: string }>("INSERT INTO posts (user_id, content, image_id, created_at) VALUES ($1, $2, $3, $4) RETURNING id::text AS id", [req.user!.id, content, imageId, now()]);
    const post = await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [created.rows[0].id]);
    res.status(201).json({ post: postObject(post.rows[0]) });
  } catch (error) { next(error); }
});

app.delete("/api/posts/:id", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const id = Number(req.params.id); if (!Number.isSafeInteger(id)) return res.status(400).json({ error: "Invalid post." });
    const deleted = await db.query<{ imageId: string | null }>("DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING image_id AS \"imageId\"", [id, req.user!.id]);
    if (!deleted.rows[0]) return res.status(404).json({ error: "Post not found or not owned by you." });
    await deleteImageIfUnused(deleted.rows[0].imageId); res.json({ ok: true, id });
  } catch (error) { next(error); }
});

app.get("/api/posts/:id/replies", authenticate, async (req, res, next) => {
  try {
    const replies = await db.query(`SELECT r.id::text AS id, r.content, r.created_at::text AS "createdAt", u.id::text AS "userId", u.username FROM replies r JOIN users u ON u.id = r.user_id WHERE r.post_id = $1 ORDER BY r.created_at ASC`, [req.params.id]);
    res.json({ replies: replies.rows.map(row => ({ ...row, id: asNumber(row.id), createdAt: asNumber(row.createdAt), userId: asNumber(row.userId) })) });
  } catch (error) { next(error); }
});

app.post("/api/posts/:id/replies", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const content = cleanText(req.body?.content, 800); if (!content) return res.status(400).json({ error: "Reply cannot be empty." });
    const postId = Number(req.params.id); const exists = await db.query("SELECT id FROM posts WHERE id = $1", [postId]); if (!exists.rows[0]) return res.status(404).json({ error: "Post not found." });
    const reply = await db.query(`INSERT INTO replies (post_id, user_id, content, created_at) VALUES ($1, $2, $3, $4) RETURNING id::text AS id, content, created_at::text AS "createdAt"`, [postId, req.user!.id, content, now()]);
    res.status(201).json({ reply: { ...reply.rows[0], id: asNumber(reply.rows[0].id), createdAt: asNumber(reply.rows[0].createdAt), userId: req.user!.id, username: req.user!.username } });
  } catch (error) { next(error); }
});

app.delete("/api/replies/:id", authenticate, async (req: AuthRequest, res, next) => { try { const deleted = await db.query("DELETE FROM replies WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, req.user!.id]); if (!deleted.rows[0]) return res.status(404).json({ error: "Reply not found or not owned by you." }); res.json({ ok: true, id: Number(req.params.id) }); } catch (error) { next(error); } });

app.get("/api/stories", authenticate, async (_req, res, next) => { try { await cleanupStories(); const stories = await db.query(`SELECT ${storyFields} FROM stories s JOIN users u ON u.id = s.user_id WHERE s.expires_at > $1 ORDER BY s.created_at DESC`, [now()]); res.json({ stories: stories.rows.map(storyObject) }); } catch (error) { next(error); } });
app.post("/api/stories", authenticate, upload.single("image"), async (req: AuthRequest, res, next) => { try { const content = cleanText(req.body?.content, 600); if (!content && !req.file) return res.status(400).json({ error: "Write something or attach an image." }); const timestamp = now(); const imageId = await saveImage(req.file); const created = await db.query<{ id: string }>("INSERT INTO stories (user_id, content, image_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id", [req.user!.id, content, imageId, timestamp, timestamp + STORY_LIFETIME]); const story = await db.query(`SELECT ${storyFields} FROM stories s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [created.rows[0].id]); res.status(201).json({ story: storyObject(story.rows[0]) }); } catch (error) { next(error); } });
app.delete("/api/stories/:id", authenticate, async (req: AuthRequest, res, next) => { try { const deleted = await db.query<{ imageId: string | null }>("DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING image_id AS \"imageId\"", [req.params.id, req.user!.id]); if (!deleted.rows[0]) return res.status(404).json({ error: "Story not found or not owned by you." }); await deleteImageIfUnused(deleted.rows[0].imageId); res.json({ ok: true, id: Number(req.params.id) }); } catch (error) { next(error); } });

app.get("/api/users/:username", authenticate, async (req, res, next) => { try { const username = cleanUsername(req.params.username); const user = await db.query<{ id: string; username: string; createdAt: string }>("SELECT id::text AS id, username, created_at::text AS \"createdAt\" FROM users WHERE username = $1", [username]); if (!user.rows[0]) return res.status(404).json({ error: "User not found." }); const posts = await db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1 ORDER BY p.created_at DESC`, [user.rows[0].id]); res.json({ user: { ...userObject(user.rows[0]), createdAt: asNumber(user.rows[0].createdAt) }, posts: posts.rows.map(postObject) }); } catch (error) { next(error); } });
app.get("/api/search", authenticate, async (req, res, next) => { try { const q = cleanText(req.query.q, 40); if (!q) return res.json({ users: [], posts: [] }); const pattern = `%${q}%`; const [users, posts] = await Promise.all([db.query("SELECT id::text AS id, username FROM users WHERE username ILIKE $1 ORDER BY username ASC LIMIT 20", [pattern]), db.query(`SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.content ILIKE $1 OR u.username ILIKE $1 ORDER BY p.created_at DESC LIMIT 30`, [pattern])]); res.json({ users: users.rows.map(userObject), posts: posts.rows.map(postObject) }); } catch (error) { next(error); } });

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Image must be smaller than 99 KB." });
  console.error(error); res.status(500).json({ error: "The API could not complete this request." });
});

initializeDatabase().then(() => app.listen(PORT, () => console.log(`BINGO DUDE API running on port ${PORT}`))).catch(error => { console.error("Database startup failed:", error); process.exit(1); });
