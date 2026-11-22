# `port4-mcp` — Official Port4 CLI & STDIO-to-HTTP x402 MCP Bridge

Connect **Cursor**, **Claude Desktop**, **Windsurf**, or any terminal workflow to [Port4 (`port4.dev`)](https://port4.dev) Paid MCP (`2026-07-28`) and Cloudflare Code Mode endpoints with strict client-side spend caps.

## 1. Use in Cursor / Claude Desktop (`mcp.json`)

```json
{
  "mcpServers": {
    "safespaces": {
      "command": "npx",
      "args": [
        "-y",
        "port4-mcp",
        "bridge",
        "--url",
        "https://safespaces.port4.dev/mcp",
        "--max-per-call-usd",
        "0.05",
        "--max-session-usd",
        "1.00"
      ],
      "env": {
        "PORT4_PRIVATE_KEY": "0xYourAgentWalletPrivateKey"
      }
    }
  }
}
```

## 2. Inspect Any Port4 Endpoint

```bash
npx port4-mcp inspect https://port4.dev/mcp/demo
```

## 3. Manage Endpoints & Import OpenAPI Specs from CI/CD

```bash
export PORT4_API_KEY="p4_live_..."
npx port4-mcp tenants
npx port4-mcp import-openapi ten_123456 https://api.example.com/openapi.json
```
