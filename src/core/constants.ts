import { Address, toFunctionSelector } from "viem";
import { base, baseSepolia, bscTestnet } from "viem/chains";
import type { ChainFamily, SolanaCluster } from "./chains.js";
export type { ChainFamily } from "./chains.js";

export const SOLANA_DEVNET_CHAIN_ID = 500;
export const SOLANA_MAINNET_CHAIN_ID = 501;

export const SOLANA_CHAIN_ID_CLUSTERS: Record<number, SolanaCluster> = {
  [SOLANA_DEVNET_CHAIN_ID]: "devnet",
  [SOLANA_MAINNET_CHAIN_ID]: "mainnet-beta",
};

export function getChainFamily(chainId: number): ChainFamily {
  return chainId in SOLANA_CHAIN_ID_CLUSTERS ? "solana" : "evm";
}

// ---------------------------------------------------------------------------
// Chain-keyed address registries
// ---------------------------------------------------------------------------

export const USDC_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [bscTestnet.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [SOLANA_DEVNET_CHAIN_ID]: "EUYp7jidumYn6m7APhGYpVR7P6eqBS81Y4u1d99SNo8s",
  [SOLANA_MAINNET_CHAIN_ID]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export const ACP_CONTRACT_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
  [bscTestnet.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
  [base.id]: "0x238E541BfefD82238730D00a2208E5497F1832E0",
  [SOLANA_DEVNET_CHAIN_ID]: "EkJQUp3Xouu94Wt8vf2hxuZcFLL5Wk2h91bNdFiiS5Bp",
  [SOLANA_MAINNET_CHAIN_ID]: "EkJQUp3Xouu94Wt8vf2hxuZcFLL5Wk2h91bNdFiiS5Bp",
};

export const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xbbeC2c985F9483473B9e0Da0704395943034266B",
  [bscTestnet.id]: "0xaD1d2BB31C40e3D0f14631721Babc4b889F38796",
  [base.id]: "0x0EaD25150985Bce0B4925c54E4ee1D856381A86B",
  [SOLANA_DEVNET_CHAIN_ID]: "9gX4rKCkXuxwQpSSfVET2KFsiTm8eFs93pp3h6yB3hwr",
  [SOLANA_MAINNET_CHAIN_ID]: "9gX4rKCkXuxwQpSSfVET2KFsiTm8eFs93pp3h6yB3hwr",
};

export const MULTI_HOOK_ROUTER_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x5Af0589bD265d2B5Abb617570Ceef8f34Ac6BcdD",
  [base.id]: "0x77F67252a8d3A6b049f4383FD50Fb9Bf784D29D1",
  [SOLANA_DEVNET_CHAIN_ID]: "6Qmycqb8UEio4V6wCboi2xWHo4YoSb69s39HzkB9Fzwu",
  [SOLANA_MAINNET_CHAIN_ID]: "6Qmycqb8UEio4V6wCboi2xWHo4YoSb69s39HzkB9Fzwu",
};

export const SUBSCRIPTION_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x6eA4c9C6dA120B193e3C2249CCA81ead3Cfb318f",
  [base.id]: "0xD087363615f36F2b0265Bb4AC78Cd730C6C0cc1D",
  [SOLANA_DEVNET_CHAIN_ID]: "FLhbbnw4NFvVtJHjK1CtxmnXUVbitMFc4FYN9fQTudm8",
  [SOLANA_MAINNET_CHAIN_ID]: "FLhbbnw4NFvVtJHjK1CtxmnXUVbitMFc4FYN9fQTudm8",
};

export const SUBSCRIPTION_STATE_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x6f254046aA8A9c253f839eb64Da1FE284930100F",
  [base.id]: "0x52c2C68f4f7fF3C70760E3D0B9b2FA91CFE443Ad",
  [SOLANA_DEVNET_CHAIN_ID]: "5L694HKw4DvqDCUXAQ5XJhXgkYH3N4RuogrcJDsuTTU1",
  [SOLANA_MAINNET_CHAIN_ID]: "5L694HKw4DvqDCUXAQ5XJhXgkYH3N4RuogrcJDsuTTU1",
};

export const ACP_SELECTORS = {
  setBudget: toFunctionSelector("setBudget(uint256,uint256,bytes)"),
  fund: toFunctionSelector("fund(uint256,uint256,bytes)"),
  submit: toFunctionSelector("submit(uint256,bytes32,bytes)"),
  complete: toFunctionSelector("complete(uint256,bytes32,bytes)"),
  reject: toFunctionSelector("reject(uint256,bytes32,bytes)"),
} as const;

export const USDC_DECIMALS: Record<number, number> = {
  [baseSepolia.id]: 6,
  [base.id]: 6,
  [bscTestnet.id]: 18,
  [SOLANA_DEVNET_CHAIN_ID]: 6,
  [SOLANA_MAINNET_CHAIN_ID]: 6,
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

export const USDC_SYMBOL = "USDC";

export const ACP_SERVER_URL = "https://api.acp.virtuals.io";

export const ACP_TESTNET_SERVER_URL = "https://api-dev.acp.virtuals.io";

export const PRIVY_APP_ID = "cltsev9j90f67yhyw4sngtrpv";

// Account implementation / EIP-7702 delegate (Alchemy ModularAccountV2). Passed as
// `contract` to Privy's eth_signUserOperation so it computes the userOpHash for this
// account. Must match the backend's ALCHEMY_SIGNING_CONTRACT.
export const ALCHEMY_SIGNING_CONTRACT =
  "0x69007702764179f14F51cdce752f4f775d74E139";

export const TESTNET_PRIVY_APP_ID = "clsakj3e205soyepnl23x2itv";

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
    id: base.id,
    name: base.name,
  },
];

export const MIN_SLA_MINS = 5;

export const BUFFER_SECONDS = 30;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
