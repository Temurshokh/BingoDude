import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, now } from "./db.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const IMAGE_LIMIT = 98_304;
const STORY_LIFETIME = 24 * 60 * 60 * 1000;
const uploadDir = path.resolve(process.cwd(), "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN?.split(",") ?? ["http://localhost:5173"],
  credentials: false
}));
app.use(express.json({ limit: "256kb" }));
app.use("/uploads", express.static(uploadDir));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_LIMIT },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    cb(null, allowed.has(file.mimetype));
  }
});

type AuthRequest = Request & { user?: { id: number; username: string } };

function cleanUsername(input: unknown) {
  return String(input ?? "").trim().replace(/^@/, "").toLowerCase();
}

function validUsername(username: string) {
  return /^[a-z0-9_]{2,24}$/.test(username);
}

function cleanText(input: unknown, max: number) {
  return String(input ?? "").trim().slice(0, max);
}

function tokenFrom(req: Request) {
  const value = req.header("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: "Sign in first." });

  const row = db.prepare(`
    SELECT users.id, users.username
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token) as { id: number; username: string } | undefined;

  if (!row) return res.status(401).json({ error: "Session expired." });

  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").run(now(), token);
  req.user = row;
  next();
}

function saveImage(file: Express.Multer.File | undefined) {
  if (!file) return null;
  if (file.size >= 99 * 1024) {
    throw new Error("Image must be smaller than 99 KB.");
  }

  const extMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };

  const ext = extMap[file.mimetype];
  if (!ext) throw new Error("Unsupported image type.");

  const filename = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
  return `/uploads/${filename}`;
}

function removeStoredImage(imagePath: string | null | undefined) {
  if (!imagePath) return;
  const file = path.basename(imagePath);
  const target = path.join(uploadDir, file);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

function cleanupStories() {
  const expired = db.prepare("SELECT image_path FROM stories WHERE expires_at <= ?").all(now()) as { image_path: string | null }[];
  for (const story of expired) removeStoredImage(story.image_path);
  db.prepare("DELETE FROM stories WHERE expires_at <= ?").run(now());
}

function userObject(id: number, username: string) {
  return { id, username };
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", (req, res) => {
  const username = cleanUsername(req.body?.username);
  if (!validUsername(username)) {
    return res.status(400).json({ error: "Username: 2–24 lowercase letters, numbers, or underscores." });
  }

  const exists = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (exists) return res.status(409).json({ error: "That username is already taken." });

  const createdAt = now();
  const result = db.prepare("INSERT INTO users (username, created_at) VALUES (?, ?)").run(username, createdAt);
  const token = crypto.randomBytes(32).toString("hex");

  db.prepare("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(token, result.lastInsertRowid, createdAt, createdAt);

  res.status(201).json({ token, user: userObject(Number(result.lastInsertRowid), username) });
});

app.post("/api/auth/access", (req, res) => {
  const username = cleanUsername(req.body?.username);
  if (!validUsername(username)) return res.status(400).json({ error: "Enter a valid username." });

  const user = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: number; username: string } | undefined;
  if (!user) return res.status(404).json({ error: "No account with that username exists." });

  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(token, user.id, now(), now());

  res.json({ token, user: userObject(user.id, user.username) });
});

app.post("/api/auth/logout", authenticate, (req: AuthRequest, res) => {
  const token = tokenFrom(req);
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

app.get("/api/me", authenticate, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

app.get("/api/feed", authenticate, (_req, res) => {
  cleanupStories();

  const posts = db.prepare(`
    SELECT
      p.id, p.content, p.image_path AS imagePath, p.created_at AS createdAt,
      u.id AS userId, u.username,
      (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS replyCount
    FROM posts p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC
    LIMIT 200
  `).all();

  const stories = db.prepare(`
    SELECT
      s.id, s.content, s.image_path AS imagePath,
      s.created_at AS createdAt, s.expires_at AS expiresAt,
      u.id AS userId, u.username
    FROM stories s
    JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ?
    ORDER BY s.created_at DESC
  `).all(now());

  res.json({ posts, stories });
});

app.post("/api/posts", authenticate, upload.single("image"), (req: AuthRequest, res) => {
  try {
    const content = cleanText(req.body?.content, 2000);
    if (!content && !req.file) return res.status(400).json({ error: "Write something or attach an image." });

    const imagePath = saveImage(req.file);
    const result = db.prepare(`
      INSERT INTO posts (user_id, content, image_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(req.user!.id, content, imagePath, now());

    const post = db.prepare(`
      SELECT p.id, p.content, p.image_path AS imagePath, p.created_at AS createdAt,
             u.id AS userId, u.username, 0 AS replyCount
      FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ post });
  } catch (error) {
    if (req.file) {
      // memoryStorage means there is no file to clean unless saveImage wrote it.
    }
    const message = error instanceof Error ? error.message : "Could not create post.";
    res.status(400).json({ error: message });
  }
});

app.delete("/api/posts/:id", authenticate, (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT image_path AS imagePath, user_id AS userId FROM posts WHERE id = ?").get(id) as { imagePath: string | null; userId: number } | undefined;
  if (!post) return res.status(404).json({ error: "Post not found." });
  if (post.userId !== req.user!.id) return res.status(403).json({ error: "You can only delete your own posts." });

  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  removeStoredImage(post.imagePath);
  res.json({ ok: true, id });
});

app.get("/api/posts/:id/replies", authenticate, (req, res) => {
  const id = Number(req.params.id);
  const replies = db.prepare(`
    SELECT r.id, r.content, r.created_at AS createdAt,
           u.id AS userId, u.username
    FROM replies r JOIN users u ON u.id = r.user_id
    WHERE r.post_id = ?
    ORDER BY r.created_at ASC
  `).all(id);
  res.json({ replies });
});

app.post("/api/posts/:id/replies", authenticate, (req: AuthRequest, res) => {
  const postId = Number(req.params.id);
  const content = cleanText(req.body?.content, 800);
  if (!content) return res.status(400).json({ error: "Reply cannot be empty." });

  const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found." });

  const result = db.prepare(`
    INSERT INTO replies (post_id, user_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `).run(postId, req.user!.id, content, now());

  const reply = db.prepare(`
    SELECT r.id, r.content, r.created_at AS createdAt,
           u.id AS userId, u.username
    FROM replies r JOIN users u ON u.id = r.user_id WHERE r.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({ reply });
});

app.delete("/api/replies/:id", authenticate, (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const reply = db.prepare("SELECT user_id AS userId FROM replies WHERE id = ?").get(id) as { userId: number } | undefined;
  if (!reply) return res.status(404).json({ error: "Reply not found." });
  if (reply.userId !== req.user!.id) return res.status(403).json({ error: "You can only delete your own replies." });

  db.prepare("DELETE FROM replies WHERE id = ?").run(id);
  res.json({ ok: true, id });
});

app.get("/api/stories", authenticate, (_req, res) => {
  cleanupStories();
  const stories = db.prepare(`
    SELECT s.id, s.content, s.image_path AS imagePath,
           s.created_at AS createdAt, s.expires_at AS expiresAt,
           u.id AS userId, u.username
    FROM stories s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ?
    ORDER BY s.created_at DESC
  `).all(now());
  res.json({ stories });
});

app.post("/api/stories", authenticate, upload.single("image"), (req: AuthRequest, res) => {
  try {
    const content = cleanText(req.body?.content, 600);
    if (!content && !req.file) return res.status(400).json({ error: "Write something or attach an image." });

    const createdAt = now();
    const imagePath = saveImage(req.file);
    const result = db.prepare(`
      INSERT INTO stories (user_id, content, image_path, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user!.id, content, imagePath, createdAt, createdAt + STORY_LIFETIME);

    const story = db.prepare(`
      SELECT s.id, s.content, s.image_path AS imagePath,
             s.created_at AS createdAt, s.expires_at AS expiresAt,
             u.id AS userId, u.username
      FROM stories s JOIN users u ON u.id = s.user_id WHERE s.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ story });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create story.";
    res.status(400).json({ error: message });
  }
});

app.delete("/api/stories/:id", authenticate, (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const story = db.prepare("SELECT image_path AS imagePath, user_id AS userId FROM stories WHERE id = ?").get(id) as { imagePath: string | null; userId: number } | undefined;
  if (!story) return res.status(404).json({ error: "Story not found." });
  if (story.userId !== req.user!.id) return res.status(403).json({ error: "You can only delete your own stories." });

  db.prepare("DELETE FROM stories WHERE id = ?").run(id);
  removeStoredImage(story.imagePath);
  res.json({ ok: true, id });
});

app.get("/api/users/:username", authenticate, (req, res) => {
  const username = cleanUsername(req.params.username);
  const user = db.prepare("SELECT id, username, created_at AS createdAt FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: number; username: string; createdAt: number } | undefined;
  if (!user) return res.status(404).json({ error: "User not found." });

  const posts = db.prepare(`
    SELECT p.id, p.content, p.image_path AS imagePath, p.created_at AS createdAt,
           u.id AS userId, u.username,
           (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS replyCount
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `).all(user.id);

  res.json({ user, posts });
});

app.get("/api/search", authenticate, (req, res) => {
  const q = cleanText(req.query.q, 40);
  if (!q) return res.json({ users: [], posts: [] });

  const users = db.prepare(`
    SELECT id, username
    FROM users
    WHERE username LIKE ? COLLATE NOCASE
    ORDER BY username ASC
    LIMIT 20
  `).all(`%${q}%`);

  const posts = db.prepare(`
    SELECT p.id, p.content, p.image_path AS imagePath, p.created_at AS createdAt,
           u.id AS userId, u.username,
           (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS replyCount
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.content LIKE ? COLLATE NOCASE OR u.username LIKE ? COLLATE NOCASE
    ORDER BY p.created_at DESC
    LIMIT 30
  `).all(`%${q}%`, `%${q}%`);

  res.json({ users, posts });
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Image must be smaller than 99 KB." });
  res.status(400).json({ error: error?.message || "Request failed." });
});

app.listen(PORT, () => {
  console.log(`BINGO DUDE API running at http://localhost:${PORT}`);
});
