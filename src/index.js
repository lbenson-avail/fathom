#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

const FATHOM_API_BASE = "https://api.fathom.ai/external/v1";
const API_KEY = process.env.FATHOM_API_KEY;

if (!API_KEY) {
  console.error("FATHOM_API_KEY environment variable is required");
  process.exit(1);
}

// --- Fathom API client ---

async function fathomFetch(path, params = {}) {
  const url = new URL(`${FATHOM_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      if (Array.isArray(value)) {
        for (const v of value) {
          url.searchParams.append(key, v);
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { "X-Api-Key": API_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fathom API ${res.status}: ${res.statusText} — ${body}`);
  }

  return res.json();
}

async function fetchAllMeetings(params = {}) {
  const meetings = [];
  let cursor = undefined;

  do {
    const data = await fathomFetch("/meetings", { ...params, cursor });
    meetings.push(...data.items);
    cursor = data.next_cursor;
  } while (cursor);

  return meetings;
}

// --- Helpers ---

function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return "unknown";
  const ms = new Date(endIso) - new Date(startIso);
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatMeetingShort(m) {
  const date = m.created_at?.slice(0, 10) ?? "unknown date";
  const duration = formatDuration(m.recording_start_time, m.recording_end_time);
  const attendees = (m.calendar_invitees ?? [])
    .map((i) => i.name || i.email || "unknown")
    .join(", ");
  return [
    `**${m.title}**`,
    `  ID: ${m.recording_id}`,
    `  Date: ${date} | Duration: ${duration}`,
    `  Recorded by: ${m.recorded_by?.name ?? "unknown"}`,
    attendees ? `  Attendees: ${attendees}` : null,
    `  URL: ${m.url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- MCP Server ---

function registerTools(server) {

// Tool: list_meetings
server.tool(
  "list_meetings",
  "List recent Fathom meetings with title, date, attendees, and duration. Returns up to 100 meetings by default.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Max meetings to return (default 100)"),
    created_after: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp — only meetings after this date"),
    created_before: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp — only meetings before this date"),
    recorded_by: z
      .string()
      .optional()
      .describe("Filter by recorder email address"),
    team: z.string().optional().describe("Filter by team name"),
  },
  async ({ limit = 100, created_after, created_before, recorded_by, team }) => {
    const params = {
      created_after,
      created_before,
    };
    if (recorded_by) params["recorded_by[]"] = [recorded_by];
    if (team) params["teams[]"] = [team];

    let meetings = await fetchAllMeetings(params);
    meetings = meetings.slice(0, limit);

    if (meetings.length === 0) {
      return { content: [{ type: "text", text: "No meetings found." }] };
    }

    const text = [
      `Found ${meetings.length} meeting(s):\n`,
      ...meetings.map(formatMeetingShort),
    ].join("\n\n");

    return { content: [{ type: "text", text }] };
  }
);

// Tool: get_meeting_summary
server.tool(
  "get_meeting_summary",
  "Get the AI-generated summary and action items for a specific Fathom meeting.",
  {
    recording_id: z.number().int().describe("The meeting recording ID"),
  },
  async ({ recording_id }) => {
    const [summaryData, meetingsData] = await Promise.all([
      fathomFetch(`/recordings/${recording_id}/summary`),
      fathomFetch("/meetings", {
        include_action_items: "true",
      }),
    ]);

    // Find matching meeting for action items
    const meeting = meetingsData.items.find(
      (m) => m.recording_id === recording_id
    );

    const parts = [];

    if (summaryData.summary?.markdown_formatted) {
      parts.push("## Summary\n\n" + summaryData.summary.markdown_formatted);
    } else {
      parts.push("No summary available for this meeting.");
    }

    const actionItems = meeting?.action_items ?? [];
    if (actionItems.length > 0) {
      parts.push("\n## Action Items\n");
      for (const item of actionItems) {
        const status = item.completed ? "✅" : "⬜";
        const assignee = item.assignee?.name ?? "unassigned";
        parts.push(
          `${status} ${item.description} (assigned to: ${assignee})` +
            (item.recording_playback_url
              ? `\n   [Jump to moment](${item.recording_playback_url})`
              : "")
        );
      }
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// Tool: get_transcript
server.tool(
  "get_transcript",
  "Get the full transcript for a Fathom meeting.",
  {
    recording_id: z.number().int().describe("The meeting recording ID"),
  },
  async ({ recording_id }) => {
    const data = await fathomFetch(`/recordings/${recording_id}/transcript`);
    const transcript = data.transcript;

    if (!transcript || transcript.length === 0) {
      return {
        content: [
          { type: "text", text: "No transcript available for this meeting." },
        ],
      };
    }

    const lines = transcript.map(
      (t) => `[${t.timestamp}] **${t.speaker.display_name}**: ${t.text}`
    );

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// Tool: search_meetings
server.tool(
  "search_meetings",
  "Search Fathom meetings by keyword (in title/transcript), attendee name/email, or date range.",
  {
    query: z
      .string()
      .optional()
      .describe(
        "Keyword to search in meeting titles. Leave empty to filter by other criteria only."
      ),
    attendee: z
      .string()
      .optional()
      .describe("Attendee name or email to filter by"),
    created_after: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp — only meetings after this date"),
    created_before: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp — only meetings before this date"),
    include_transcript_search: z
      .boolean()
      .optional()
      .describe(
        "Also search within transcripts (slower, fetches transcripts). Default false."
      ),
  },
  async ({
    query,
    attendee,
    created_after,
    created_before,
    include_transcript_search = false,
  }) => {
    const params = { created_after, created_before };

    if (include_transcript_search) {
      params.include_transcript = "true";
    }

    let meetings = await fetchAllMeetings(params);

    // Filter by keyword in title
    if (query) {
      const q = query.toLowerCase();
      meetings = meetings.filter((m) => {
        if (m.title?.toLowerCase().includes(q)) return true;
        if (m.meeting_title?.toLowerCase().includes(q)) return true;
        // Search transcript if included
        if (include_transcript_search && m.transcript) {
          return m.transcript.some((t) =>
            t.text.toLowerCase().includes(q)
          );
        }
        return false;
      });
    }

    // Filter by attendee
    if (attendee) {
      const a = attendee.toLowerCase();
      meetings = meetings.filter((m) => {
        const invitees = m.calendar_invitees ?? [];
        return invitees.some(
          (i) =>
            i.name?.toLowerCase().includes(a) ||
            i.email?.toLowerCase().includes(a)
        );
      });
    }

    if (meetings.length === 0) {
      return { content: [{ type: "text", text: "No matching meetings found." }] };
    }

    const text = [
      `Found ${meetings.length} matching meeting(s):\n`,
      ...meetings.map(formatMeetingShort),
    ].join("\n\n");

    return { content: [{ type: "text", text }] };
  }
);

} // end registerTools

// --- HTTP/SSE Transport ---

const app = createMcpExpressApp({ host: "0.0.0.0" });
const transports = {};

// Streamable HTTP transport (current protocol)
app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      if (!(transport instanceof StreamableHTTPServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session uses a different transport" },
          id: null,
        });
        return;
      }
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };
      const s = new McpServer({ name: "fathom", version: "1.0.0" });
      registerTools(s);
      await s.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling /mcp:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Legacy SSE transport (for older clients)
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  const s = new McpServer({ name: "fathom", version: "1.0.0" });
  registerTools(s);
  await s.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport instanceof SSEServerTransport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Fathom MCP server listening on port ${PORT}`);
  console.log(`  Streamable HTTP: /mcp`);
  console.log(`  Legacy SSE:      /sse + /messages`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const sid in transports) {
    try { await transports[sid].close(); } catch {}
    delete transports[sid];
  }
  process.exit(0);
});
