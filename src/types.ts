export type UserPlan = "free" | "pro";
export type TenantStatus = "active" | "suspended";

export interface AppBindings extends CloudflareBindings {
  PORT4_TREASURY_WALLET?: string;
  DEMO_PAYER_PRIVATE_KEY?: string;
}

export interface AuthUser {
  id: string;
  github_id: string;
  login: string;
  avatar_url: string | null;
  email: string | null;
  is_admin: number;
  plan: UserPlan;
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
  created_at?: string;
}

export interface TenantRecord {
  id: string;
  user_id: string;
  subdomain: string;
  name: string;
  upstream_base_url: string;
  payout_wallet: string;
  network: string;
  auth_mode: "x402" | "x402+oauth_v2";
  is_active: number;
  status: TenantStatus;
  is_featured: number;
  call_count: number;
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
  network: string;
  auth_mode: "x402" | "x402+oauth_v2";
  status: TenantStatus;
  is_featured: number;
  call_count: number;
  owner_plan: UserPlan;
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

export interface X402SettlementReceipt {
  success: boolean;
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
  requestStartedAt?: number;
}

export interface AppEnv {
  Bindings: AppBindings;
  Variables: AppVariables;
}
