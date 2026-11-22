import type { PayoutWalletEntry } from "./lib/networks";

export type UserPlan = "free" | "pro";
export type TenantStatus = "active" | "suspended" | "archived";
export type McpMode = "direct" | "codemode" | "openapi_codemode";
export type ToolSourceType = "rest" | "mcp" | "openapi" | "internal";
export type UpstreamAuthType = "none" | "bearer" | "api_key_header";

export interface AppBindings extends CloudflareBindings {
  PORT4_TREASURY_WALLET?: string;
  PORT4_TREASURY_SOLANA_WALLET?: string;
  DEMO_PAYER_PRIVATE_KEY?: string;
  DEMO_AUTH_ENABLED?: string;
  ADMIN_GITHUB_ID?: string;
  GATEWAY_ANALYTICS?: AnalyticsEngineDataset;
  LEDGER_ARCHIVE?: R2Bucket;
  MCP_RATE_LIMIT_PER_MINUTE?: string;
}

export interface MeteringEvent {
  id: string;
  tenantId: string;
  tenantSubdomain: string;
  toolName: string;
  payerWallet: string;
  amountAtomic: string;
  amountUsd: string;
  network: string;
  txHash: string;
  latencyMs: number;
  status: "settled" | "sandbox_settled";
  isPlatformFee: boolean;
  occurredAt: string;
}

export interface AuthUser {
  id: string;
  github_id: string;
  login: string;
  avatar_url: string | null;
  email: string | null;
  is_admin: number;
  plan: UserPlan;
  auth_via?: "session" | "api_key";
  api_key_scopes?: string[];
}

export interface ToolRecord {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  http_method: "GET" | "POST" | "PUT" | "DELETE";
  upstream_path: string;
  input_schema_json: string;
  price_usd: string;
  price_atomic: string;
  is_active: number;
  source_type?: ToolSourceType;
  remote_tool_name?: string | null;
  created_at?: string;
}

export interface TenantRecord {
  id: string;
  user_id: string;
  subdomain: string;
  name: string;
  upstream_base_url: string;
  payout_wallet: string;
  payout_wallets_json?: string | null;
  network: string;
  auth_mode: "x402" | "x402+oauth_v2";
  is_active: number;
  status: TenantStatus;
  is_featured: number;
  call_count: number;
  settled_call_sequence?: number;
  upstream_signing_secret?: string | null;
  upstream_verified?: number;
  require_upstream_verified?: number;
  verification_token?: string | null;
  upstream_auth_type?: UpstreamAuthType;
  upstream_auth_header?: string | null;
  upstream_auth_secret?: string | null;
  rate_limit_rpm?: number;
  daily_quota?: number;
  mcp_mode?: McpMode;
  codemode_price_usd?: string;
  codemode_max_subcalls?: number;
  cf_access_team_domain?: string | null;
  cf_access_aud?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TenantRoutingRecord {
  id: string;
  user_id: string;
  subdomain: string;
  name: string;
  upstream_base_url: string;
  payout_wallet: string;
  payout_wallets: PayoutWalletEntry[];
  network: string;
  auth_mode: "x402" | "x402+oauth_v2";
  status: TenantStatus;
  is_featured: number;
  call_count: number;
  settled_call_sequence: number;
  owner_plan: UserPlan;
  upstream_signing_secret: string | null;
  upstream_verified: number;
  require_upstream_verified: number;
  upstream_auth_type: UpstreamAuthType;
  upstream_auth_header: string | null;
  upstream_auth_secret: string | null;
  rate_limit_rpm: number;
  daily_quota: number;
  mcp_mode: McpMode;
  codemode_price_usd: string;
  codemode_max_subcalls: number;
  cf_access_team_domain: string | null;
  cf_access_aud: string | null;
  tools: ToolRecord[];
  cached_at: string;
}

export interface TransactionRecord {
  id: string;
  tenant_id: string;
  tenant_subdomain?: string;
  tool_name: string;
  payer_wallet: string;
  amount_atomic: string;
  amount_usd: string;
  network: string;
  tx_hash: string;
  status: "settled" | "sandbox_settled" | "failed";
  latency_ms: number;
  is_platform_fee: number;
  created_at: string;
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface McpValidatedContext {
  protocolVersion: string;
  method: string;
  toolName: string | null;
  rpcId: string | number | null;
  arguments: Record<string, unknown>;
}

export interface X402PaymentRequirement {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    tenant: string;
    tool: string;
    priceUsd: string;
    isPlatformFee?: boolean;
  };
}

export interface X402PaymentRequired {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: X402PaymentRequirement[];
}

export interface X402PaymentSignaturePayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature?: string;
    transaction?: string;
    mode?: string;
    authorization?: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    [key: string]: unknown;
  };
}

export interface PaymentExecutionContext {
  tenantId: string;
  toolName: string;
  resourceUrl: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
}

export interface X402SettlementReceipt {
  success: boolean;
  settlementPending?: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason: string | null;
  mode: "facilitator" | "sandbox";
  isPlatformFee: boolean;
  payTo: string;
}

export interface AppVariables {
  user?: AuthUser;
  tenantSubdomain?: string;
  tenant?: TenantRoutingRecord;
  mcp?: McpValidatedContext;
  selectedTool?: ToolRecord;
  x402Receipt?: X402SettlementReceipt;
  paymentFingerprint?: string;
  paymentLeaseToken?: string;
  paymentContext?: PaymentExecutionContext;
  rateLimitSequence?: number;
  requestStartedAt?: number;
}

export interface AppEnv {
  Bindings: AppBindings;
  Variables: AppVariables;
}
