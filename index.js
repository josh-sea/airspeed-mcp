#!/usr/bin/env node

/**
 * Airspeed / Glyphic MCP Server — HTTP/SSE transport for Claude web
 *
 * Required env vars:
 *   GLYPHIC_API_KEY   – your Airspeed/Glyphic API key
 *
 * Optional env vars:
 *   MCP_AUTH_TOKEN    – if set, clients must send  Authorization: Bearer <token>
 *   PORT              – HTTP port (default 3000; Railway/Render set this automatically)
 */

import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = "https://api.glyphic.ai/v1";
const API_KEY = process.env.GLYPHIC_API_KEY;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // optional endpoint protection
const PORT = process.env.PORT ?? 3000;

if (!API_KEY) {
  console.error("ERROR: GLYPHIC_API_KEY environment variable is not set.");
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function glyphicFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      if (Array.isArray(v)) {
        v.forEach((item) => url.searchParams.append(k, String(item)));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": API_KEY, Accept: "application/json" },
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Glyphic API ${res.status} ${res.statusText}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

function textContent(obj) {
  return {
    content: [
      {
        type: "text",
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function formatTranscript(transcriptTurns, participants = []) {
  const partyMap = {};
  for (const p of participants) {
    partyMap[p.id] = p.name || p.email || `Party ${p.id}`;
  }
  return transcriptTurns
    .map((turn) => {
      const speaker = partyMap[turn.party_id] ?? `Party ${turn.party_id}`;
      return `[${turn.timestamp}] ${speaker}: ${turn.turn_text}`;
    })
    .join("\n");
}

// ── tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_calls",
    description:
      "List calls from your Airspeed/Glyphic organization. Only public calls are returned, sorted newest first. Supports filtering by participant email, date range, title, and tags.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of calls per page (default: 20, max: 100)" },
        cursor: { type: "string", description: "Pagination cursor from a previous response" },
        direction: { type: "string", enum: ["next", "prev"], description: "Pagination direction" },
        participant_email: { type: "string", description: "Filter by participant email (case insensitive)" },
        start_time_from: { type: "string", description: "Filter calls on or after this UTC ISO 8601 time, e.g. 2025-05-01T00:00:00Z" },
        start_time_to: { type: "string", description: "Filter calls on or before this UTC ISO 8601 time" },
        title_filter: { type: "string", description: "Filter calls by title (partial match)" },
        tag_ids: { type: "array", items: { type: "string" }, description: "Filter by tag IDs (24-char hex). Use list_call_tags to get IDs." },
      },
      required: [],
    },
  },
  {
    name: "get_call",
    description:
      "Get full detail for a specific call by ID, including participants, duration, status, tags, AI summary, insights, and the full transcript.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string", description: "24-character hex call ID" },
      },
      required: ["call_id"],
    },
  },
  {
    name: "get_transcript",
    description:
      "Get the formatted, speaker-labeled transcript for a specific call.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string", description: "24-character hex call ID" },
      },
      required: ["call_id"],
    },
  },
  {
    name: "get_call_snippets",
    description:
      "Get saved snippets for a call; each snippet includes a time range, transcript turns, and a presigned media URL (valid 24h).",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string", description: "24-character hex call ID" },
      },
      required: ["call_id"],
    },
  },
  {
    name: "list_call_tags",
    description: "List all call tags for your organization.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_playbooks",
    description: "List playbooks for your organization, sorted newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number per page (default: 20, max: 100)" },
        cursor: { type: "string", description: "Pagination cursor from a previous response" },
        direction: { type: "string", enum: ["next", "prev"] },
      },
      required: [],
    },
  },
  {
    name: "get_playbook",
    description: "Get the full content of a playbook by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: { type: "string", description: "24-character hex playbook ID" },
      },
      required: ["playbook_id"],
    },
  },
  {
    name: "ping",
    description: "Test that your API key is valid and the Airspeed API is reachable.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ── tool handlers ─────────────────────────────────────────────────────────────

async function handleListCalls(args) {
  const data = await glyphicFetch("/calls/", {
    limit: args.limit,
    cursor: args.cursor,
    direction: args.direction,
    participant_email: args.participant_email,
    start_time_from: args.start_time_from,
    start_time_to: args.start_time_to,
    title_filter: args.title_filter,
    tag_ids: args.tag_ids,
  });
  return textContent({
    count: data.data?.length ?? 0,
    next_cursor: data.pagination?.next_cursor ?? null,
    previous_cursor: data.pagination?.previous_cursor ?? null,
    calls: data.data,
  });
}

async function handleGetCall(args) {
  return textContent(await glyphicFetch(`/calls/${args.call_id}`));
}

async function handleGetTranscript(args) {
  const data = await glyphicFetch(`/calls/${args.call_id}`);
  if (!data.transcript_turns || data.transcript_turns.length === 0) {
    return textContent(`No transcript available for call ${args.call_id}. Status: ${data.status?.code}`);
  }
  const header = [
    `Title: ${data.title}`,
    `Date:  ${data.start_time}`,
    `Duration: ${data.duration ? `${Math.round(data.duration / 60)} min` : "unknown"}`,
    `Participants: ${data.participants?.map((p) => p.name || p.email || `ID ${p.id}`).join(", ") || "none"}`,
    "",
  ].join("\n");
  return textContent(header + formatTranscript(data.transcript_turns, data.participants ?? []));
}

async function handleGetCallSnippets(args) {
  const data = await glyphicFetch(`/calls/${args.call_id}/snippets`);
  if (!Array.isArray(data) || data.length === 0) {
    return textContent(`No snippets found for call ${args.call_id}.`);
  }
  let participants = [];
  try {
    const callData = await glyphicFetch(`/calls/${args.call_id}`);
    participants = callData.participants ?? [];
  } catch { /* non-fatal */ }

  const formatted = data
    .map((snippet, i) => {
      const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      const time = `${fmt(snippet.start_seconds)} - ${fmt(snippet.end_seconds)}`;
      const turns = snippet.transcript_turns?.length > 0
        ? formatTranscript(snippet.transcript_turns, participants)
        : "(no transcript for this snippet)";
      const mediaLine = snippet.media?.media_url
        ? `Media (${snippet.media.media_type}): ${snippet.media.media_url}`
        : "";
      return [`Snippet ${i + 1} [${time}]`, mediaLine, turns].filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");

  return textContent(formatted);
}

async function handleListCallTags() {
  return textContent(await glyphicFetch("/call_tags/"));
}

async function handleListPlaybooks(args) {
  return textContent(await glyphicFetch("/playbooks/", {
    limit: args.limit, cursor: args.cursor, direction: args.direction,
  }));
}

async function handleGetPlaybook(args) {
  return textContent(await glyphicFetch(`/playbooks/${args.playbook_id}`));
}

async function handlePing() {
  const data = await glyphicFetch("/test/ping");
  return textContent(`Airspeed API is reachable. Response: ${JSON.stringify(data)}`);
}

// ── MCP server ────────────────────────────────────────────────────────────────

function createMCPServer() {
  const server = new Server(
    { name: "airspeed-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_calls":        return await handleListCalls(args ?? {});
        case "get_call":          return await handleGetCall(args ?? {});
        case "get_transcript":    return await handleGetTranscript(args ?? {});
        case "get_call_snippets": return await handleGetCallSnippets(args ?? {});
        case "list_call_tags":    return await handleListCallTags();
        case "list_playbooks":    return await handleListPlaybooks(args ?? {});
        case "get_playbook":      return await handleGetPlaybook(args ?? {});
        case "ping":              return await handlePing();
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error calling ${name}: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ── HTTP / SSE server ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Optional bearer-token guard
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// Health check (no auth required)
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// One transport per SSE connection
const transports = new Map();

app.get("/sse", requireAuth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => transports.delete(transport.sessionId));

  const server = createMCPServer();
  await server.connect(transport);
});

app.post("/messages", requireAuth, async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (!transport) {
    return res.status(400).json({ error: "Unknown session" });
  }
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`Airspeed MCP server listening on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
