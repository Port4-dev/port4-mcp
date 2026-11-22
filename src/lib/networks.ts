export type NetworkFamily = "evm" | "solana";

export interface SupportedNetwork {
  id: string;
  label: string;
  shortLabel: string;
  family: NetworkFamily;
  isMainnet: boolean;
  usdcAsset: string;
  explorerTxPrefix: string;
}

export interface PayoutWalletEntry {
  network: string;
  address: string;
}

export const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const SUPPORTED_NETWORKS: readonly SupportedNetwork[] = [
  {
    id: "eip155:84532",
    label: "Base Sepolia (Testnet)",
    shortLabel: "Base Sepolia",
    family: "evm",
    isMainnet: false,
    usdcAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerTxPrefix: "https://sepolia.basescan.org/tx/"
  },
  {
    id: "eip155:8453",
    label: "Base Mainnet (Real USDC)",
    shortLabel: "Base Mainnet",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorerTxPrefix: "https://basescan.org/tx/"
  },
  {
    id: "eip155:42161",
    label: "Arbitrum One (Real USDC)",
    shortLabel: "Arbitrum",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorerTxPrefix: "https://arbiscan.io/tx/"
  },
  {
    id: "eip155:421614",
    label: "Arbitrum Sepolia (Testnet)",
    shortLabel: "Arb Sepolia",
    family: "evm",
    isMainnet: false,
    usdcAsset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorerTxPrefix: "https://sepolia.arbiscan.io/tx/"
  },
  {
    id: "eip155:10",
    label: "Optimism (Real USDC)",
    shortLabel: "Optimism",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    explorerTxPrefix: "https://optimistic.etherscan.io/tx/"
  },
  {
    id: "eip155:137",
    label: "Polygon PoS (Real USDC)",
    shortLabel: "Polygon",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    explorerTxPrefix: "https://polygonscan.com/tx/"
  },
  {
    id: "eip155:1",
    label: "Ethereum Mainnet (Real USDC)",
    shortLabel: "Ethereum",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    explorerTxPrefix: "https://etherscan.io/tx/"
  },
  {
    id: "eip155:43114",
    label: "Avalanche C-Chain (Real USDC)",
    shortLabel: "Avalanche",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0xB97EF9Ef8734C71904D8002F8b6bc66Dd9c48a6E",
    explorerTxPrefix: "https://snowtrace.io/tx/"
  },
  {
    id: "eip155:4217",
    label: "Tempo Mainnet (Visa CLI OUSD)",
    shortLabel: "Tempo OUSD",
    family: "evm",
    isMainnet: true,
    usdcAsset: "0x20c0000000000000000000006a37da5c996874be",
    explorerTxPrefix: "https://explorer.tempo.xyz/tx/"
  },
  {
    id: "eip155:42431",
    label: "Tempo Testnet (Visa CLI OUSD)",
    shortLabel: "Tempo Testnet",
    family: "evm",
    isMainnet: false,
    usdcAsset: "0x20c0000000000000000000006a37da5c996874be",
    explorerTxPrefix: "https://testnet.explorer.tempo.xyz/tx/"
  },
  {
    id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    label: "Solana Mainnet (Real USDC)",
    shortLabel: "Solana Mainnet",
    family: "solana",
    isMainnet: true,
    usdcAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    explorerTxPrefix: "https://solscan.io/tx/"
  },
  {
    id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    label: "Solana Devnet (Testnet)",
    shortLabel: "Solana Devnet",
    family: "solana",
    isMainnet: false,
    usdcAsset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    explorerTxPrefix: "https://solscan.io/tx/"
  }
] as const;

const NETWORK_BY_ID = new Map<string, SupportedNetwork>(
  SUPPORTED_NETWORKS.map((net) => [net.id, net])
);

export function getSupportedNetwork(networkId: string): SupportedNetwork | undefined {
  return NETWORK_BY_ID.get(networkId);
}

export function isSupportedNetwork(networkId: string): boolean {
  return NETWORK_BY_ID.has(networkId);
}

export function getNetworkFamily(networkId: string): NetworkFamily {
  return NETWORK_BY_ID.get(networkId)?.family ?? (networkId.startsWith("solana:") ? "solana" : "evm");
}

export function isValidWalletForNetwork(networkId: string, address: string): boolean {
  const net = NETWORK_BY_ID.get(networkId);
  if (!net) return false;
  const trimmed = address.trim();
  return net.family === "solana"
    ? SOLANA_ADDRESS_RE.test(trimmed)
    : EVM_ADDRESS_RE.test(trimmed);
}

export function resolveUsdcAssetForNetwork(networkId: string, fallback: string): string {
  return NETWORK_BY_ID.get(networkId)?.usdcAsset ?? fallback;
}

export function normalizePayoutWallets(
  primaryNetwork: string,
  primaryWallet: string,
  extras?: PayoutWalletEntry[] | null
): PayoutWalletEntry[] {
  const seen = new Set<string>();
  const out: PayoutWalletEntry[] = [];

  const pushIfValid = (network: string, address: string) => {
    const net = network.trim();
    const addr = address.trim();
    if (!isValidWalletForNetwork(net, addr)) return;
    if (seen.has(net)) return;
    seen.add(net);
    out.push({ network: net, address: addr });
  };

  pushIfValid(primaryNetwork, primaryWallet);
  if (Array.isArray(extras)) {
    for (const item of extras) {
      if (item && typeof item.network === "string" && typeof item.address === "string") {
        pushIfValid(item.network, item.address);
      }
    }
  }
  return out;
}

export function parsePayoutWalletsJson(
  raw: string | null | undefined,
  primaryNetwork: string,
  primaryWallet: string
): PayoutWalletEntry[] {
  if (!raw) {
    return normalizePayoutWallets(primaryNetwork, primaryWallet);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return normalizePayoutWallets(
        primaryNetwork,
        primaryWallet,
        parsed as PayoutWalletEntry[]
      );
    }
  } catch {
    // Fallback to primary wallet only
  }
  return normalizePayoutWallets(primaryNetwork, primaryWallet);
}
