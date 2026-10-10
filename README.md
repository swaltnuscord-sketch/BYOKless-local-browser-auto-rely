# BYOKless Local Browser Auto Relay

Local-first Model Context Protocol (MCP) relay daemon and WebSocket bridge for browser automation. 

Connects ChatGPT directly to your real Chrome browser session over an authenticated WebSocket bridge—without needing third-party cloud browser automation services or OpenAI API keys (BYOKless).

---

## Architecture Overview

- **MCP Server over Streamable HTTP:** Exposes the MCP endpoint at `/mcp/<token>` for ChatGPT.
- **WebSocket Bridge:** Listens on `/extension` at `127.0.0.1:8765` for the companion Chrome Extension with mutual authentication (`EXT_SHARED_SECRET`).
- **Local-First & Secure:** Binds strictly to loopback (`127.0.0.1`). State, task budgets, and audit logging are stored locally using SQLite.
- **Built-in Metrics & Health:** Health checks on `/healthz` and `/readyz`, metrics on port `8766`.

---

## Getting Started

### 1. Requirements
- Node.js >= 20.6.0 (Node 24 LTS recommended)
- pnpm or npm

### 2. Installation

```bash
git clone https://github.com/swaltnuscord-sketch/BYOKless-local-browser-auto-rely.git
cd BYOKless-local-browser-auto-rely
pnpm install
```

### 3. Setup Configuration

Generate a 32+ character secret for the extension handshake and place it in `.env`:

```bash
cp .env.example .env
```

Set `EXT_SHARED_SECRET` in `.env`:
```ini
RELAY_HOST=127.0.0.1
RELAY_PORT=8765
EXT_SHARED_SECRET=<your-random-32-char-secret>
```

Also make sure `state/relay.token` exists with at least 32 characters (or run a quick token generator script):
```bash
node -e "const fs = require('fs'), crypto = require('crypto'); fs.mkdirSync('state', { recursive: true }); fs.writeFileSync('state/relay.token', crypto.randomBytes(32).toString('hex'));"
```

### 4. Running the Relay

```bash
pnpm start
```

For live development with auto-reload:
```bash
pnpm dev
```

### 5. Running Tests

```bash
pnpm test
```

---

## License

MIT
