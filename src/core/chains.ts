import {
  arbitrum,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  mainnet,
  monad,
  optimism,
  polygon,
  sepolia,
  Chain,
} from "viem/chains";
import { defineChain } from "viem";

export type ChainFamily = "evm" | "solana";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: true,
});

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://explorer.chain.robinhood.com/",
    },
  },
});

export const EVM_MAINNET_CHAINS: Chain[] = [base, robinhood] as const;

export const EVM_TESTNET_CHAINS: Chain[] = [
  baseSepolia,
  bscTestnet,
  robinhoodTestnet,
] as const;

export const ERC20_SPONSORED_CHAINS: Chain[] = [
  base,
  baseSepolia,
  mainnet,
  sepolia,
  arbitrum,
  bsc,
  polygon,
  optimism,
  monad,
  robinhood,
  robinhoodTestnet,
] as const;

export const EVM_CHAINS = [
  ...EVM_MAINNET_CHAINS,
  ...EVM_TESTNET_CHAINS,
] as const;

export const EVM_CHAIN_NAMES = [
  ...EVM_CHAINS.map((chain) => chain.name),
] as const;

export type EvmNetworkName = keyof typeof EVM_CHAIN_NAMES;
export type EvmChainId = (typeof EVM_CHAIN_NAMES)[EvmNetworkName];

export const SOLANA_CLUSTERS = {
  devnet: "devnet",
  testnet: "testnet",
  "mainnet-beta": "mainnet-beta",
} as const;

export type SolanaCluster = keyof typeof SOLANA_CLUSTERS;

export type SupportedNetwork = EvmNetworkName | SolanaCluster;

export type NetworkContext =
  | {
      family: "evm";
      network: EvmNetworkName;
      chainId: EvmChainId;
      label: string;
    }
  | {
      family: "solana";
      network: SolanaCluster;
      cluster: SolanaCluster;
      label: string;
    };

export function isEvmNetworkContext(
  context: NetworkContext,
): context is Extract<NetworkContext, { family: "evm" }> {
  return context.family === "evm";
}

export function isSolanaNetworkContext(
  context: NetworkContext,
): context is Extract<NetworkContext, { family: "solana" }> {
  return context.family === "solana";
}

export function getEvmChainByChainId(chainId: number): Chain | null {
  const chain = EVM_CHAINS.find((chain) => chain.id === chainId);
  if (!chain) {
    return null;
  }
  return chain;
}

export function createEvmNetworkContext(chainId: number): NetworkContext {
  const chain = getEvmChainByChainId(chainId);
  if (!chain) {
    throw new Error(`Unsupported EVM chainId: ${chainId}`);
  }

  return {
    family: "evm",
    network: chain.name as EvmNetworkName,
    chainId: chain.id,
    label: `${chain.name}:${chainId}`,
  };
}

export function createSolanaNetworkContext(
  cluster: SolanaCluster,
): NetworkContext {
  return {
    family: "solana",
    network: cluster,
    cluster,
    label: `solana:${cluster}`,
  };
}
