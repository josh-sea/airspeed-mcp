# airspeed-mcp

Remote MCP server exposing Airspeed/Glyphic call data to Claude web (claude.ai).

---

## Deploy to Railway (recommended)

1. Push this repo to GitHub (already done).
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → select `airspeed-mcp`.
3. In **Variables**, add:
   - `GLYPHIC_API_KEY` = your key from https://app.goairspeed.com/settings/api
   - `MCP_AUTH_TOKEN` = any secret string you choose (protects the endpoint)
4. Railway auto-assigns a public HTTPS URL, e.g. `https://airspeed-mcp-production.up.railway.app`

## Add to Claude web

1. Open [claude.ai](https://claude.ai) → **Settings → Integrations → Add MCP server**
2. **URL:** `https://<your-railway-url>/sse`
3. **Auth header:** `Authorization: Bearer <your MCP_AUTH_TOKEN>`

---

## Tools

| Tool | What it does |
|---|---|
| `ping` | Verify the API key works |
| `list_calls` | List calls with filters (email, date, title, tags); paginated |
| `get_call` | Full call detail: participants, summary, insights, transcript |
| `get_transcript` | Formatted speaker-labeled transcript |
| `get_call_snippets` | Saved snippets with transcript and media URLs |
| `list_call_tags` | All tags (use IDs to filter `list_calls`) |
| `list_playbooks` | Paginated playbook list |
| `get_playbook` | Full playbook content |

## Local development

```bash
npm install
GLYPHIC_API_KEY=your_key node index.js
# SSE endpoint at http://localhost:3000/sse
```

## Endpoints

- `GET /health` — liveness check (no auth)
- `GET /sse` — MCP SSE connection
- `POST /messages?sessionId=<id>` — MCP message relay
