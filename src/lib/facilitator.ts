import type { AppBindings } from "../types";
import { getSupportedNetwork } from "./networks";

export interface FacilitatorEndpointConfig {
  baseUrl: string;
  headers: Record<string, string>;
  isMainnet: boolean;
}

/**
 * Resolves the appropriate x402 Facilitator URL & optional authentication headers
 * for the target settlement network (Mainnet vs. Testnet).
 */
export function resolveFacilitatorConfig(
  env: AppBindings,
  network: string
): FacilitatorEndpointConfig {
  const netInfo = getSupportedNetwork(network);
  const isMainnet = netInfo?.isMainnet ?? false;
  const defaultUrl = (env.FACILITATOR_URL || env.X402_FACILITATOR_URL || "https://x402.org/facilitator")
    .trim()
    .replace(/\/$/, "");
  const mainnetUrl = env.X402_MAINNET_FACILITATOR_URL?.trim().replace(/\/$/, "");

  const baseUrl = isMainnet && mainnetUrl ? mainnetUrl : defaultUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (env.X402_FACILITATOR_API_KEY && env.X402_FACILITATOR_API_KEY.trim().length > 0) {
    headers["Authorization"] = `Bearer ${env.X402_FACILITATOR_API_KEY.trim()}`;
  }

  return {
    baseUrl,
    headers,
    isMainnet
  };
}

/**
 * Calls `/verify` on the resolved facilitator with a 1-time retry on transient
 * network errors or 502/503/504 responses (safe because `/verify` is side-effect-free).
 */
export async function fetchFacilitatorVerify(
  config: FacilitatorEndpointConfig,
  payload: unknown
): Promise<Response> {
  const url = `${config.baseUrl}/verify`;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: config.headers,
        body,
        signal: AbortSignal.timeout(8_000)
      });
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Facilitator verify unreachable");
}
