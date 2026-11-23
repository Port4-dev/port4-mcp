# `port4-mcp` — Official Port4 CLI & STDIO-to-HTTP x402 MCP Bridge

Connect **Cursor**, **Claude Desktop**, **Windsurf**, or any terminal workflow to [Port4 (`port4.dev`)](https://port4.dev) Paid MCP (`2026-07-28`) and Cloudflare Code Mode endpoints with strict client-side spend caps.

## 1. Use in Cursor / Claude Desktop (`mcp.json`)

For **read-only / discovery** or manual payment signing:

```json
{
  "mcpServers": {
    "port4-demo": {
      "command": "npx",
      "args": [
        "-y",
        "port4-mcp",
        "bridge",
        "--url",
        "https://port4.dev/mcp/demo",
        "--max-per-call-usd",
        "0.05",
        "--max-session-usd",
        "1.00"
      ]
    }
  }
}
```

For **automatic x402 EIP-3009 signing**, include optional peer dependencies `@x402/evm` and `viem`:

```json
{
  "mcpServers": {
    "safespaces": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "port4-mcp",
        "-p",
        "@x402/evm",
        "-p",
        "viem",
        "port4-mcp",
        "bridge",
        "--url",
        "https://safespaces.port4.dev/mcp",
        "--network",
        "eip155:8453",
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

## 2. Inspect Any Port4 Endpoint & Check CLI Options

```bash
npx -y port4-mcp inspect https://port4.dev/mcp/demo
npx -y port4-mcp --version
npx -y port4-mcp --self-test
```

## 3. Manage Endpoints & Import OpenAPI Specs from CI/CD

```bash
export PORT4_API_KEY="p4_live_..."
npx -y port4-mcp tenants --api-base https://port4.dev
npx -y port4-mcp import-openapi ten_123456 https://api.example.com/openapi.json --price 0.005 --mcp-mode openapi_codemode
npx -y port4-mcp import-openapi ten_123456 ./openapi.json --price 0.005 --mcp-mode codemode
```

## 4. Environment Variables

| Variable | Purpose |
| :--- | :--- |
| `PORT4_MCP_URL` | Target Port4 MCP endpoint URL |
| `PORT4_API_BASE` | Control-plane API base URL (default `https://port4.dev`) |
| `PORT4_NETWORK` | Preferred EVM settlement network (e.g. `eip155:8453`, `eip155:84532`) |
| `PORT4_MAX_PER_CALL_USD` | Max USD per tool call (default `0.10`) |
| `PORT4_MAX_SESSION_USD` | Max cumulative USD per session (default `2.00`) |
| `PORT4_PRIVATE_KEY` | EVM private key for auto-signing (requires `@x402/evm` + `viem`) |
| `PORT4_API_KEY` | Scoped developer API key (`p4_live_...`) for `tenants` / `import-openapi` |
| `CF_ACCESS_CLIENT_ID` | Optional Cloudflare Access Service Token Client ID |
| `CF_ACCESS_CLIENT_SECRET` | Optional Cloudflare Access Service Token Client Secret |
| `CF_ACCESS_JWT` | Optional Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) |
