import { base, baseSepolia, bsc, bscTestnet } from "viem/chains";

// ---------------------------------------------------------------------------
// Chain-keyed address registries
// ---------------------------------------------------------------------------

export const USDC_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [bsc.id]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  [bscTestnet.id]: "0x64544969ed7EBf5f083679233325356EbE738930",
};

export const ACP_CONTRACT_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xeAC3Af001B16b7ca0c0d17A3Cd049961FEb3983D",
  [bscTestnet.id]: "0x6d8a718Bf031258921A1321d833Cf893B56d6f09",
};

export const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x1cC6C9204D3fD587888b33CeeE97606c9369844B",
  [bscTestnet.id]: "0x1CDf636Fdf2050597De5EC858B559d1a724E10a6",
};

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export function getAddressForChain(
  registry: Record<number, string>,
  chainId: number,
  label: string
): string {
  const addr = registry[chainId];
  if (!addr)
    throw new Error(`No ${label} address configured for chainId ${chainId}`);
  return addr;
}

export const USDC_DECIMALS = 6;

export const SOCKET_SERVER_URL = "https://api-dev.acp.virtuals.io";
