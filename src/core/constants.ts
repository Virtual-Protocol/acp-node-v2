import { EVM_CHAIN_IDS } from "./chains";

// ---------------------------------------------------------------------------
// Chain-keyed address registries
// ---------------------------------------------------------------------------

export const USDC_ADDRESSES: Record<number, string> = {
  [EVM_CHAIN_IDS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [EVM_CHAIN_IDS.base]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [EVM_CHAIN_IDS.bsc]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  [EVM_CHAIN_IDS.bscTestnet]: "0x64544969ed7EBf5f083679233325356EbE738930",
};

export const ACP_CONTRACT_ADDRESSES: Record<number, string> = {
  [EVM_CHAIN_IDS.baseSepolia]: "0x2A58201D603eDFb4F7B0d65edCeFea79E6368541",
  [EVM_CHAIN_IDS.bscTestnet]: "0x6d8a718Bf031258921A1321d833Cf893B56d6f09",
};

export const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string> = {
  [EVM_CHAIN_IDS.baseSepolia]: "0x37F8D776D101094C2c0164803BfA0b731398E411",
  [EVM_CHAIN_IDS.bscTestnet]: "0x1CDf636Fdf2050597De5EC858B559d1a724E10a6",
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
