import { Address } from "viem";
import { base, baseSepolia, bsc, bscTestnet } from "viem/chains";

// ---------------------------------------------------------------------------
// Chain-keyed address registries
// ---------------------------------------------------------------------------

export const USDC_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xB270EDc833056001f11a7828DFdAC9D4ac2b8344",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [bsc.id]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  [bscTestnet.id]: "0x64544969ed7EBf5f083679233325356EbE738930",
};

export const ACP_CONTRACT_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x81b06b2085438cef320f2A91a69f84eF6431b8e6",
  [bscTestnet.id]: "0x6d8a718Bf031258921A1321d833Cf893B56d6f09",
};

export const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x17DcAC666DB5958d80Ec99A1d372dd9686237c7C",
  [bscTestnet.id]: "0xfd966805D55a3445092F0285b25658a22b5f0985",
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

export const USDC_DECIMALS = 6;
export const USDC_SYMBOL = "USDC";

export const ACP_SERVER_URL = "https://api-dev.acp.virtuals.io";
