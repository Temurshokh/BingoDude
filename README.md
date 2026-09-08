# BINGO DUDE

A tiny, fast social space for a few friends.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Express + TypeScript
- Database: SQLite (Node.js built-in `node:sqlite`)
- Sessions: random opaque tokens stored in SQLite
- Images: local disk storage, hard limit of 98,304 bytes (96 KiB)
- No external services required

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

## Data

The backend automatically creates:

- `backend/data/bingo.db`
- `backend/uploads/`

The SQLite schema is created on startup. Story cleanup runs automatically and also before relevant story reads.

To reset the local app completely, stop the backend and delete `backend/data/bingo.db` and the contents of `backend/uploads/`.

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

Images are served from `/uploads/...`.

## Image limit

The server checks the actual uploaded byte size and rejects anything at or above 99 KB. The frontend also checks before sending, but the backend remains authoritative.
