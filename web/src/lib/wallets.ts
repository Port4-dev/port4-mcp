export type NetworkFamily = "evm" | "solana";

export interface NetworkOption {
  id: string;
  label: string;
  shortLabel: string;
  family: NetworkFamily;
  isMainnet: boolean;
}

export interface PayoutWalletEntry {
  network: string;
  address: string;
}

export const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const NETWORK_OPTIONS: readonly NetworkOption[] = [
  { id: "eip155:84532", label: "Base Sepolia (Testnet)", shortLabel: "Base Sepolia", family: "evm", isMainnet: false },
  { id: "eip155:8453", label: "Base Mainnet (Real USDC)", shortLabel: "Base Mainnet", family: "evm", isMainnet: true },
  { id: "eip155:42161", label: "Arbitrum One (Real USDC)", shortLabel: "Arbitrum", family: "evm", isMainnet: true },
  { id: "eip155:421614", label: "Arbitrum Sepolia (Testnet)", shortLabel: "Arb Sepolia", family: "evm", isMainnet: false },
  { id: "eip155:10", label: "Optimism (Real USDC)", shortLabel: "Optimism", family: "evm", isMainnet: true },
  { id: "eip155:137", label: "Polygon PoS (Real USDC)", shortLabel: "Polygon", family: "evm", isMainnet: true },
  { id: "eip155:1", label: "Ethereum Mainnet (Real USDC)", shortLabel: "Ethereum", family: "evm", isMainnet: true },
  { id: "eip155:43114", label: "Avalanche C-Chain (Real USDC)", shortLabel: "Avalanche", family: "evm", isMainnet: true },
  { id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", label: "Solana Mainnet (Real USDC)", shortLabel: "Solana Mainnet", family: "solana", isMainnet: true },
  { id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", label: "Solana Devnet (Testnet)", shortLabel: "Solana Devnet", family: "solana", isMainnet: false }
] as const;

export function getNetworkOption(networkId: string): NetworkOption | undefined {
  return NETWORK_OPTIONS.find((n) => n.id === networkId);
}

export function getNetworkFamily(networkId: string): NetworkFamily {
  return getNetworkOption(networkId)?.family ?? (networkId.startsWith("solana:") ? "solana" : "evm");
}

export function isValidWalletAddress(networkId: string, address: string): boolean {
  const trimmed = address.trim();
  return getNetworkFamily(networkId) === "solana"
    ? SOLANA_ADDRESS_RE.test(trimmed)
    : EVM_ADDRESS_RE.test(trimmed);
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
  isBraveWallet?: boolean;
}

interface Eip6963ProviderDetail {
  info: { uuid: string; name: string; icon?: string; rdns?: string };
  provider: Eip1193Provider;
}

interface SolanaInjectedProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: { toBase58?: () => string; toString: () => string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toBase58?: () => string; toString: () => string } }>;
}

export interface DetectedWallet {
  id: string;
  name: string;
  family: NetworkFamily;
  connect: () => Promise<string>;
}

/**
 * Discover installed EVM wallets via EIP-6963 (MetaMask, Coinbase Wallet, Rabby, Rainbow, Brave, Trust)
 * with graceful fallback to legacy window.ethereum.
 */
export async function discoverEvmWallets(): Promise<DetectedWallet[]> {
  if (typeof window === "undefined") return [];
  const found = new Map<string, DetectedWallet>();

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.provider || !detail?.info?.name) return;
    const key = detail.info.rdns || detail.info.uuid || detail.info.name;
    if (found.has(key)) return;
    found.set(key, {
      id: key,
      name: detail.info.name,
      family: "evm",
      connect: async () => {
        const accounts = (await detail.provider.request({
          method: "eth_requestAccounts"
        })) as string[];
        if (!accounts?.[0]) throw new Error("No EVM account returned by wallet.");
        return accounts[0];
      }
    });
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, 120));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  if (found.size === 0) {
    const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (eth && typeof eth.request === "function") {
      const name = eth.isRabby
        ? "Rabby"
        : eth.isCoinbaseWallet
          ? "Coinbase Wallet"
          : eth.isBraveWallet
            ? "Brave Wallet"
            : eth.isMetaMask
              ? "MetaMask"
              : "Browser EVM Wallet";
      found.set("window.ethereum", {
        id: "window.ethereum",
        name,
        family: "evm",
        connect: async () => {
          const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
          if (!accounts?.[0]) throw new Error("No EVM account returned by wallet.");
          return accounts[0];
        }
      });
    }
  }

  return Array.from(found.values());
}

/**
 * Discover installed Solana browser wallets (Phantom, Solflare, Backpack, standard injected window.solana).
 */
export function discoverSolanaWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const win = window as unknown as {
    phantom?: { solana?: SolanaInjectedProvider };
    solflare?: SolanaInjectedProvider;
    backpack?: SolanaInjectedProvider;
    solana?: SolanaInjectedProvider;
  };
  const found: DetectedWallet[] = [];

  const extractPubkey = (provider: SolanaInjectedProvider, res?: { publicKey?: { toBase58?: () => string; toString: () => string } }) => {
    const pk = res?.publicKey ?? provider.publicKey;
    if (!pk) throw new Error("No Solana public key returned by wallet.");
    return typeof pk.toBase58 === "function" ? pk.toBase58() : pk.toString();
  };

  const phantom = win.phantom?.solana ?? (win.solana?.isPhantom ? win.solana : undefined);
  if (phantom && typeof phantom.connect === "function") {
    found.push({
      id: "phantom",
      name: "Phantom",
      family: "solana",
      connect: async () => extractPubkey(phantom, await phantom.connect())
    });
  }

  if (win.solflare && typeof win.solflare.connect === "function") {
    const sf = win.solflare;
    found.push({
      id: "solflare",
      name: "Solflare",
      family: "solana",
      connect: async () => extractPubkey(sf, await sf.connect())
    });
  }

  if (win.backpack && typeof win.backpack.connect === "function") {
    const bp = win.backpack;
    found.push({
      id: "backpack",
      name: "Backpack",
      family: "solana",
      connect: async () => extractPubkey(bp, await bp.connect())
    });
  }

  if (found.length === 0 && win.solana && typeof win.solana.connect === "function") {
    const sol = win.solana;
    found.push({
      id: "window.solana",
      name: "Solana Wallet",
      family: "solana",
      connect: async () => extractPubkey(sol, await sol.connect())
    });
  }

  return found;
}
