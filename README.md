# BINGO DUDE

A tiny, fast social space for a few friends.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Express + TypeScript
- Database: managed PostgreSQL (required; it survives Render restarts and spin-down)
- Sessions: random opaque tokens stored in PostgreSQL
- Images: image metadata and bytes stored in PostgreSQL, hard limit of 98,304 bytes (96 KiB)

## Requirements

Node.js 20+ and npm.

## Run locally

Open two terminals:

### Backend

```bash
cd backend
npm install
npm run dev
```

The API starts on `http://localhost:4000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`).

For a production-style local run:

```bash
cd backend
npm install
npm run build
npm start
```

```bash
cd frontend
npm install
npm run build
npm run preview
```

## Durable data and deployment

`DATABASE_URL` is required. The backend deliberately refuses to start without it, so a Render local filesystem can never be used for social data. On startup it creates its PostgreSQL schema if needed. The database contains users, sessions, posts, replies, stories, image metadata, and image bytes. This makes both records and uploaded images durable across Render restarts/spin-down.

For production:

1. Create a managed PostgreSQL database (Render PostgreSQL is the simplest match) and copy its connection string into the Render web service as `DATABASE_URL`.
2. Set `FRONTEND_ORIGIN` on the Render web service to the exact Vercel URL, for example `https://your-project.vercel.app`. Multiple origins may be comma-separated.
3. Set `VITE_API_URL` in Vercel to the public Render API URL, for example `https://your-service.onrender.com`, then redeploy the frontend. Do not leave it unset: production API calls must not go to the Vercel frontend origin.
4. Deploy the backend. `GET /api/health` returns `200` only after PostgreSQL is reachable; it returns `500` if the database is unavailable.

### One-time SQLite migration

Do this before switching traffic to the new database, while the legacy `backend/data/bingo.db` and `backend/uploads/` files are still available. The importer refuses to run if the target PostgreSQL database contains data, and rolls back on an error—it never resets or deletes the SQLite source.

```bash
cd backend
DATABASE_URL="your-postgres-connection-string" npm run migrate:sqlite
```

Set `SQLITE_PATH` and `UPLOADS_PATH` if the legacy database and uploads are elsewhere. The command retains user, session, post, reply, and story IDs and imports each referenced image file into PostgreSQL. If a referenced image is missing, it stops rather than silently losing that record's image.

Story cleanup runs automatically before story reads. Expired story images are removed from PostgreSQL only after the story row is removed.

## Account workflow

There is intentionally no password-heavy registration flow.

1. Enter a unique username.
2. The backend creates the account and a session token.
3. The token is saved in browser localStorage.
4. Opening BINGO DUDE later on the same browser restores the account.
5. On another device, use the account access form with the username. This prototype treats the username as the lightweight account identifier requested by the project brief.

Because this is intentionally lightweight, it is suitable for a private friend group rather than sensitive/private information.

## Features

- Chronological posts, newest first
- Text posts
- One optional image per post under 99 KB
- Owner-only post deletion
- Temporary text/image stories
- Automatic story expiration and storage cleanup
- Replies with owner-only deletion
- Lightweight profiles
- Username uniqueness
- Search
- Responsive mobile/desktop UI
- Immediate UI updates after mutations

## API

Main endpoints:

- `POST /api/auth/register`
- `POST /api/auth/access`
- `GET /api/me`
- `GET /api/feed`
- `POST /api/posts`
- `DELETE /api/posts/:id`
- `GET /api/posts/:id/replies`
- `POST /api/posts/:id/replies`
- `DELETE /api/replies/:id`
- `GET /api/stories`
- `POST /api/stories`
- `DELETE /api/stories/:id`
- `GET /api/users/:username`
- `GET /api/search?q=...`
- `GET /api/health`

Images are served from `/api/images/:id` and are read from PostgreSQL, not the Render filesystem.

## Image limit

The server checks the actual uploaded byte size and rejects anything at or above 99 KB. The frontend also checks before sending, but the backend remains authoritative.
