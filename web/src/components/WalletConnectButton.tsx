import { useEffect, useState } from "react";
import { Wallet, X } from "lucide-react";
import {
  discoverEvmWallets,
  discoverSolanaWallets,
  type DetectedWallet,
  type NetworkFamily
} from "../lib/wallets";

interface WalletConnectButtonProps {
  family: NetworkFamily;
  onConnected: (address: string) => void;
  compact?: boolean;
}

export function WalletConnectButton({
  family,
  onConnected,
  compact = false
}: WalletConnectButtonProps) {
  const [connecting, setConnecting] = useState(false);
  const [picker, setPicker] = useState<DetectedWallet[] | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    setPicker(null);
    setWalletError(null);
  }, [family]);

  const connectOne = async (wallet: DetectedWallet) => {
    setConnecting(true);
    setWalletError(null);
    try {
      const addr = await wallet.connect();
      onConnected(addr);
      setPicker(null);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Wallet connection cancelled.");
    } finally {
      setConnecting(false);
    }
  };

  const handleTrigger = async () => {
    setWalletError(null);
    setConnecting(true);
    try {
      const wallets =
        family === "solana" ? discoverSolanaWallets() : await discoverEvmWallets();

      if (wallets.length === 0) {
        setWalletError(
          family === "solana"
            ? "No Solana wallet detected (install Phantom, Solflare, or Backpack) — or paste your address."
            : "No EVM wallet detected (install MetaMask, Coinbase Wallet, or Rabby) — or paste your 0x address."
        );
        return;
      }

      if (wallets.length === 1) {
        await connectOne(wallets[0]);
      } else {
        setPicker(wallets);
      }
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="relative flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void handleTrigger()}
        disabled={connecting}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-zinc-50 hover:border-[#F6821F] hover:text-[#C25906] font-mono text-zinc-700 cursor-pointer disabled:opacity-60 whitespace-nowrap ${
          compact ? "px-2 min-h-[34px] text-[10px]" : "px-2.5 min-h-[38px] sm:min-h-[36px] text-[11px]"
        }`}
        title={`Connect installed ${family === "solana" ? "Solana" : "EVM"} wallet`}
      >
        <Wallet className="w-3.5 h-3.5 text-[#F6821F] shrink-0" />
        {connecting ? "Connecting..." : compact ? "Connect" : `Connect ${family === "solana" ? "Solana" : "EVM"}`}
      </button>

      {picker && picker.length > 1 && (
        <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-xl bg-white border border-zinc-200 shadow-lg p-2 flex flex-col gap-1">
          <div className="flex items-center justify-between px-1.5 py-1 border-b border-zinc-100">
            <span className="font-mono text-[10px] font-semibold text-zinc-500 uppercase">
              Choose Wallet
            </span>
            <button
              type="button"
              aria-label="Close wallet picker"
              onClick={() => setPicker(null)}
              className="text-zinc-400 hover:text-zinc-700 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {picker.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => void connectOne(w)}
              className="w-full text-left px-2.5 py-1.5 rounded-lg font-mono text-xs text-zinc-800 hover:bg-orange-50 hover:text-[#C25906] cursor-pointer"
            >
              {w.name}
            </button>
          ))}
        </div>
      )}

      {walletError && (
        <span role="alert" className="text-[10px] font-mono text-rose-600 leading-snug">
          {walletError}
        </span>
      )}
    </div>
  );
}
