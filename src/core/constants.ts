import { Address, toFunctionSelector } from "viem";
import { base, baseSepolia, bscTestnet } from "viem/chains";
import type { Commitment } from "@solana/kit";
import type { ChainFamily, SolanaCluster } from "./chains.js";
import { robinhood, robinhoodTestnet } from "./chains.js";

// ---------------------------------------------------------------------------
// Solana chain ids / clusters
// ---------------------------------------------------------------------------

export const SOLANA_DEVNET_CHAIN_ID = 500;
export const SOLANA_MAINNET_CHAIN_ID = 501;

export const SOLANA_CHAIN_ID_CLUSTERS: Record<number, SolanaCluster> = {
  [SOLANA_DEVNET_CHAIN_ID]: "devnet",
  [SOLANA_MAINNET_CHAIN_ID]: "mainnet-beta",
};

export class UnknownChainIdError extends Error {
  constructor(readonly chainId: number) {
    super(
      `Unknown chain id ${chainId}. Register it in ACP_CONTRACT_ADDRESSES ` +
        `or SOLANA_CHAIN_ID_CLUSTERS before use.`,
    );
    this.name = "UnknownChainIdError";
  }
}

/**
 * Resolve a chain id to its family. Fails closed.
 *
 * This used to return "evm" for anything that was not Solana, so an
 * unregistered id silently reached the EVM client and failed later with an
 * unrelated-looking error rather than at the point of the mistake.
 */
export function getChainFamily(chainId: number): ChainFamily {
  if (chainId in SOLANA_CHAIN_ID_CLUSTERS) return "solana";
  if (chainId in ACP_CONTRACT_ADDRESSES) return "evm";
  throw new UnknownChainIdError(chainId);
}

// ---------------------------------------------------------------------------
// No-evaluator sentinels
// ---------------------------------------------------------------------------

// "Skip evaluation" is expressed per chain family: EVM contracts use the zero
// address, the Solana program uses the default (all-zero-byte) pubkey.
export const EVM_NO_EVALUATOR_ADDRESS =
  "0x0000000000000000000000000000000000000000";
export const SOLANA_NO_EVALUATOR_ADDRESS = "11111111111111111111111111111111";

export function getNoEvaluatorAddress(chainId: number): string {
  return getChainFamily(chainId) === "solana"
    ? SOLANA_NO_EVALUATOR_ADDRESS
    : EVM_NO_EVALUATOR_ADDRESS;
}

// ---------------------------------------------------------------------------
// Solana on-chain constants
// ---------------------------------------------------------------------------

export const ACP_COMMITMENT: Commitment = "confirmed";

export const JOB_CREATED_EVENT_DISC = new Uint8Array([
  48, 110, 162, 177, 67, 74, 159, 131,
]);

// ---------------------------------------------------------------------------
// Chain-keyed address registries
// ---------------------------------------------------------------------------

export const USDC_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [bscTestnet.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [SOLANA_DEVNET_CHAIN_ID]: "6f19R51nWkC9fXPK4xNodMuxsMeeyST5aqBU7t978cok",
  [SOLANA_MAINNET_CHAIN_ID]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  [robinhoodTestnet.id]: "0xECc22a8F6fD62388498fBa19813E214605a2BDb3",
  [robinhood.id]: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

export const ACP_CONTRACT_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
  [bscTestnet.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
  [base.id]: "0x238E541BfefD82238730D00a2208E5497F1832E0",
  [SOLANA_DEVNET_CHAIN_ID]: "FVd3tKVfUWH7DDPrUodQqv6uJT2efd6Bw8mYuiUWFf8Y",
  [SOLANA_MAINNET_CHAIN_ID]: "2heRZzq7QY8EX2hLceTron7jkzQe8uqsRztQnseavCcx",
  [robinhoodTestnet.id]: "0x0b93793923CD5De81850aF8604a233f3f24d461e",
  [robinhood.id]: "0x238E541BfefD82238730D00a2208E5497F1832E0",
};

export const FUND_TRANSFER_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0xbbeC2c985F9483473B9e0Da0704395943034266B",
  [bscTestnet.id]: "0xaD1d2BB31C40e3D0f14631721Babc4b889F38796",
  [base.id]: "0x0EaD25150985Bce0B4925c54E4ee1D856381A86B",
  [SOLANA_DEVNET_CHAIN_ID]: "HaNGaZnXPBkZBU75BB3XJ8oah3yRuqDHqBfeeHL7f41Q",
  [SOLANA_MAINNET_CHAIN_ID]: "Bq83ckifu1yS5WrUiG46eFPmtfFMzpaSUTJQHot6f14",
  [robinhoodTestnet.id]: "0xbbeC2c985F9483473B9e0Da0704395943034266B",
  [robinhood.id]: "0x0EaD25150985Bce0B4925c54E4ee1D856381A86B",
};

export const INTENT_KIND_FUND_REQUEST = 0;
export const INTENT_KIND_ESCROW = 1;

export const MULTI_HOOK_ROUTER_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x5Af0589bD265d2B5Abb617570Ceef8f34Ac6BcdD",
  [base.id]: "0x77F67252a8d3A6b049f4383FD50Fb9Bf784D29D1",
  [SOLANA_DEVNET_CHAIN_ID]: "EfaW12djNhjHhyw8oTmxBLABqN1uUXofGGpbbnvw6QU5",
  [SOLANA_MAINNET_CHAIN_ID]: "6gP86dzKK28nuAxNueEUt2vdr5FADAjrFUZr2VBgbzxZ",
  [robinhoodTestnet.id]: "0x5Af0589bD265d2B5Abb617570Ceef8f34Ac6BcdD",
  [robinhood.id]: "0x77F67252a8d3A6b049f4383FD50Fb9Bf784D29D1",
};

export const SUBSCRIPTION_HOOK_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x6eA4c9C6dA120B193e3C2249CCA81ead3Cfb318f",
  [base.id]: "0xD087363615f36F2b0265Bb4AC78Cd730C6C0cc1D",
  [SOLANA_DEVNET_CHAIN_ID]: "6XdTqLDQDXpd312sspR6MZ1LuDb16FAHPdDYegMXFATP",
  [SOLANA_MAINNET_CHAIN_ID]: "wiBJusTQ5ZzyvVT7nUwQsvyHTgb4wM617GgHXYZ2MXg",
  [robinhoodTestnet.id]: "0x6eA4c9C6dA120B193e3C2249CCA81ead3Cfb318f",
  [robinhood.id]: "0xD087363615f36F2b0265Bb4AC78Cd730C6C0cc1D",
};

export const SUBSCRIPTION_STATE_ADDRESSES: Record<number, string> = {
  [baseSepolia.id]: "0x6f254046aA8A9c253f839eb64Da1FE284930100F",
  [base.id]: "0x52c2C68f4f7fF3C70760E3D0B9b2FA91CFE443Ad",
  [SOLANA_DEVNET_CHAIN_ID]: "5L694HKw4DvqDCUXAQ5XJhXgkYH3N4RuogrcJDsuTTU1",
  [SOLANA_MAINNET_CHAIN_ID]: "5E9txkfq1RafMXXMWWij8kcJxuDcR6EaKUoxTJ3do9zc",
  [robinhoodTestnet.id]: "0x6f254046aA8A9c253f839eb64Da1FE284930100F",
  [robinhood.id]: "0x52c2C68f4f7fF3C70760E3D0B9b2FA91CFE443Ad",
};

export const MULTI_HOOK_COMPLETE_ALT_ADDRESSES: Record<number, string> = {
  [SOLANA_DEVNET_CHAIN_ID]: "BXxVuLL76ue6ixDRanyYAmx2DLXdsaELj6eyPTZUMUwP",
  [SOLANA_MAINNET_CHAIN_ID]: "HvtMFzNA3xwvuXT55rPxJL4qYhSP6s1hhFnfijgV4b9D",
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
  [robinhoodTestnet.id]: 6,
  [robinhood.id]: 6,
};

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export function getAddressForChain(
  registry: Record<number, string>,
  chainId: number,
  label: string,
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
  {
    id: robinhoodTestnet.id,
    name: robinhoodTestnet.name,
  },
  {
    id: robinhood.id,
    name: robinhood.name,
  },
];

export const MIN_SLA_MINS = 5;

export const BUFFER_SECONDS = 30;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
