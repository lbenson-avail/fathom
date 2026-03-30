# Fathom MCP Server

An MCP server that wraps the [Fathom](https://fathom.video) API, letting Claude query your meeting data directly — summaries, transcripts, action items, and search.

## Tools

| Tool | Description |
|------|-------------|
| `list_meetings` | List recent meetings with title, date, attendees, duration |
| `get_meeting_summary` | Get AI summary and action items for a meeting |
| `get_transcript` | Get full transcript for a meeting |
| `search_meetings` | Search by keyword, attendee, or date range |

## Setup

### 1. Get a Fathom API key

Go to **Fathom Settings > API Access** and create a key.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure Claude Code

Add to your Claude Code MCP config (`~/.claude/claude_desktop_config.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "fathom": {
      "command": "node",
      "args": ["/absolute/path/to/fathom/src/index.js"],
      "env": {
        "FATHOM_API_KEY": "your_key_here"
      }
    }
  }
}
```

Or via CLI:

```bash
claude mcp add fathom -- node /absolute/path/to/fathom/src/index.js
```

Then set the env var in your shell or `.env` file.

### 4. Test locally

```bash
FATHOM_API_KEY=your_key node src/index.js
```

The server communicates over stdio — it will sit waiting for MCP messages.

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project from that repo
3. Add `FATHOM_API_KEY` as an environment variable in Railway
4. Railway will auto-detect `railway.toml` and deploy

The `railway.toml` is pre-configured with the start command.

## API Notes

- **Auth**: Uses `X-Api-Key` header with the Fathom API
- **Base URL**: `https://api.fathom.ai/external/v1`
- **Rate limit**: 60 requests per 60-second window
- **Pagination**: The server auto-paginates through all results
- **Access**: Your API key can only access meetings you recorded or that were shared to your team
