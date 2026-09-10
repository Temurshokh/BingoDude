import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, initializeDatabase } from "./db.js";
const sqlitePath = path.resolve(process.env.SQLITE_PATH || "data/bingo.db");
const uploadsPath = path.resolve(process.env.UPLOADS_PATH || "uploads");
function mimeTypeFor(file) {
    const extension = path.extname(file).toLowerCase();
    const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
    const mime = types[extension];
    if (!mime)
        throw new Error(`Unsupported legacy image extension: ${extension}`);
    return mime;
}
async function main() {
    if (!fs.existsSync(sqlitePath))
        throw new Error(`SQLite database not found: ${sqlitePath}`);
    await initializeDatabase();
    const target = await db.query("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM posts) + (SELECT COUNT(*) FROM stories) + (SELECT COUNT(*) FROM replies) AS count");
    if (Number(target.rows[0].count) > 0)
        throw new Error("Target PostgreSQL database is not empty; refusing to merge or overwrite data.");
    const source = new DatabaseSync(sqlitePath, { readOnly: true });
    const client = await db.connect();
    const importedImages = new Map();
    try {
        await client.query("BEGIN");
        const copyImage = async (legacyPath) => {
            if (!legacyPath)
                return null;
            const file = path.join(uploadsPath, path.basename(legacyPath));
            if (!fs.existsSync(file))
                throw new Error(`Legacy image is missing: ${file}. Restore it before migration so no image data is lost.`);
            if (importedImages.has(file))
                return importedImages.get(file);
            const data = fs.readFileSync(file);
            if (data.length >= 99 * 1024)
                throw new Error(`Legacy image exceeds the 99 KB limit: ${file}`);
            const id = crypto.randomUUID();
            await client.query("INSERT INTO images (id, mime_type, size_bytes, data, created_at) VALUES ($1, $2, $3, $4, $5)", [id, mimeTypeFor(file), data.length, data, Date.now()]);
            importedImages.set(file, id);
            return id;
        };
        for (const row of source.prepare("SELECT id, username, created_at FROM users ORDER BY id").all())
            await client.query("INSERT INTO users (id, username, created_at) VALUES ($1, $2, $3)", [row.id, row.username, row.created_at]);
        for (const row of source.prepare("SELECT token, user_id, created_at, last_seen_at FROM sessions").all())
            await client.query("INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES ($1, $2, $3, $4)", [row.token, row.user_id, row.created_at, row.last_seen_at]);
        for (const row of source.prepare("SELECT id, user_id, content, image_path, created_at FROM posts ORDER BY id").all())
            await client.query("INSERT INTO posts (id, user_id, content, image_id, created_at) VALUES ($1, $2, $3, $4, $5)", [row.id, row.user_id, row.content, await copyImage(row.image_path), row.created_at]);
        for (const row of source.prepare("SELECT id, user_id, content, image_path, created_at, expires_at FROM stories ORDER BY id").all())
            await client.query("INSERT INTO stories (id, user_id, content, image_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)", [row.id, row.user_id, row.content, await copyImage(row.image_path), row.created_at, row.expires_at]);
        for (const row of source.prepare("SELECT id, post_id, user_id, content, created_at FROM replies ORDER BY id").all())
            await client.query("INSERT INTO replies (id, post_id, user_id, content, created_at) VALUES ($1, $2, $3, $4, $5)", [row.id, row.post_id, row.user_id, row.content, row.created_at]);
        for (const table of ["users", "posts", "stories", "replies"]) {
            await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
        }
        await client.query("COMMIT");
        console.log(`Migrated SQLite data from ${sqlitePath}, including ${importedImages.size} image file(s).`);
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
        source.close();
        await db.end();
    }
}
main().catch(error => { console.error("SQLite migration failed:", error); process.exit(1); });
