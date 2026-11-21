-- Migration 0006: Multi-chain & multi-wallet payout support (EVM + Solana x402 v2 accepts[])
ALTER TABLE tenants ADD COLUMN payout_wallets_json TEXT;
