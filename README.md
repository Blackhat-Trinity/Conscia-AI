# VideoCall App

> A private, peer-to-peer WebRTC video calling application.

---

## Overview

VideoCall is a self-hosted, real-time video calling application built entirely on [WebRTC](https://webrtc.org/). Media travels **directly between participants** — no server ever sees your video, audio, or chat. No accounts. No tracking. No intermediaries.

This is a private project built for personal use and demonstration purposes.

---

## Features

| Feature | Details |
|---|---|
| **HD Video & Audio** | Up to 8K webcam streaming with adaptive quality |
| **Screen Sharing** | Share screen or any app window at up to 8K / 60fps |
| **In-Call Chat** | Public or private messaging with emoji picker |
| **Local Recording** | Record to your own device — nothing uploaded anywhere |
| **Shared Whiteboard** | Real-time collaborative drawing and annotation |
| **P2P File Transfer** | Encrypted via DTLS, never through a server |
| **Room Lock** | Password-protect any room |
| **E2E Encrypted** | DTLS/SRTP throughout — WebRTC standard |
| **No Sign-Up** | Pick a room name, share the link, connect |
| **Browser-native** | Works in Chrome, Edge, Firefox, Safari, Brave, Opera |

---

## Tech Stack

- **Backend:** Node.js + Express + Socket.IO (WebRTC signalling)
- **Frontend:** Vanilla HTML/CSS/JS — no frontend framework
- **WebRTC:** Browser-native, peer-to-peer media
- **Transport:** `httpolyglot` (HTTP + HTTPS on the same port)
- **Auth (optional):** JWT tokens, host protection, OIDC support
- **API:** REST API v1 with Swagger UI at `/api/v1/docs/`

---

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later

---

## Quick Start

```bash
# 1. Clone / enter the project folder
cd WebRTC-Videochatting-App

# 2. Install dependencies
npm install

# 3. Start the server (config.js is auto-generated from template on first run)
npm start
```

Open **http://localhost:3000** in your browser.

> The `prestart` script automatically creates `app/src/config.js` from `app/src/config.template.js` if it doesn't exist yet.

---

## Configuration

All runtime settings are controlled via environment variables in the `.env` file at the project root.

Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `http://localhost:3000` | Public URL (used in API responses) |
| `HOST_PROTECTED` | `false` | Enable login-protected access |
| `HOST_USERS` | `[{...}]` | JSON array of username/password pairs |
| `JWT_KEY` | *(change me)* | Secret for JWT token signing |
| `API_KEY_SECRET` | *(change me)* | API authentication key |
| `STUN_SERVER_ENABLED` | `true` | Enable STUN for NAT traversal |
| `TURN_SERVER_ENABLED` | `false` | Enable TURN relay server |
| `CHATGPT_ENABLED` | `false` | Enable in-call ChatGPT assistant |
| `NGROK_ENABLED` | `false` | Expose via Ngrok tunnel |

Copy `.env.template` to `.env` and adjust values as needed.

---

## SSL / HTTPS

Place `key.pem` and `cert.pem` in the `app/ssl/` directory. The server will automatically serve HTTPS alongside HTTP (via `httpolyglot`). Without certificates, it falls back to plain HTTP.

For local development you can generate self-signed certs:

```bash
openssl req -x509 -newkey rsa:4096 -keyout app/ssl/key.pem -out app/ssl/cert.pem -days 365 -nodes
```

---

## Development

```bash
# Hot-reload via nodemon
npm run start-dev

# Run tests
npm test

# Format code
npm run lint
```

---

## Docker

```bash
# Build
npm run docker:build

# Run
npm run docker:run
```

Or use Docker Compose:

```bash
docker-compose up -d
```

---

## Project Structure

```
WebRTC-Videochatting-App/
├── app/
│   ├── api/          # Swagger / OpenAPI spec
│   ├── src/          # Server source (server.js, config.js, …)
│   └── ssl/          # SSL certificates (key.pem, cert.pem)
├── public/
│   ├── css/          # Stylesheets
│   ├── js/           # Client-side scripts
│   ├── views/        # HTML pages
│   ├── images/       # Static images
│   └── sounds/       # Audio assets
├── .env              # Environment configuration
├── package.json
└── README.md
```

---

## API

The REST API is available at `/api/v1/` with interactive Swagger docs at `/api/v1/docs/`.

Authentication uses the `API_KEY_SECRET` value as a bearer token in the `Authorization` header.

Endpoints include:

- `GET  /api/v1/stats` — Active rooms and peer counts
- `POST /api/v1/meeting` — Generate a new meeting URL
- `POST /api/v1/join` — Generate a join URL with optional auth token
- `GET  /api/v1/activeRooms` — List active rooms (if enabled)

---

## Security Notes

Before deploying publicly, change these defaults in `.env`:

```env
JWT_KEY=<your-random-secret>
API_KEY_SECRET=<your-random-secret>
```

Optionally enable host protection:

```env
HOST_PROTECTED=true
HOST_USERS='[{"username":"yourname","password":"yourpassword"}]'
```

---

## License

AGPL-3.0 — See [LICENSE](./LICENSE) for details.

---

*Private project. All rights reserved.*
