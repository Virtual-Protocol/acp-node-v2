import { Address } from "viem";
import { base, baseSepolia, bsc, bscTestnet } from "viem/chains";

// ---------------------------------------------------------------------------
// Chain-keyed address registries
// ---------------------------------------------------------------------------

export const USDC_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [bscTestnet.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [bsc.id]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};

export const ACP_CONTRACT_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
  [bscTestnet.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
};

export const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xaD1d2BB31C40e3D0f14631721Babc4b889F38796",
  [bscTestnet.id]: "0xaD1d2BB31C40e3D0f14631721Babc4b889F38796",
};

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export function getAddressForChain(
  registry: Record<number, string>,
  chainId: number,
  label: string
): Address {
  const addr = registry[chainId];
  if (!addr)
    throw new Error(`No ${label} address configured for chainId ${chainId}`);
  return addr as Address;
}

export const USDC_DECIMALS: Record<number, number> = {
  [baseSepolia.id]: 6,
  [base.id]: 6,
  [bsc.id]: 18,
  [bscTestnet.id]: 18,
};
export const USDC_SYMBOL = "USDC";

export const ACP_SERVER_URL = "https://api.acp.virtuals.io";

export const ACP_TESTNET_SERVER_URL = "https://api-dev.acp.virtuals.io";

export const PRIVY_APP_ID = "clsakj3e205soyepnl23x2itv";

export const TESTNET_PRIVY_APP_ID = "clsakj3e205soyepnl23x2itv";

export const ALCHEMY_POLICY_ID = "186aaa4a-5f57-4156-83fb-e456365a8820";

export const SUPPORTED_CHAINS = [
  {
    id: baseSepolia.id,
    name: baseSepolia.name,
  },
  {
    id: bscTestnet.id,
    name: bscTestnet.name,
  },
  {
    id: bsc.id,
    name: bsc.name,
  },
  {
    id: base.id,
    name: base.name,
  },
];
