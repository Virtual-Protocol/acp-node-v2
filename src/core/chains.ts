import { base, baseSepolia, bsc, bscTestnet, Chain } from "viem/chains";

export type ChainFamily = "evm" | "solana";

export const EVM_MAINNET_CHAINS: Chain[] = [base, bsc] as const;

export const EVM_TESTNET_CHAINS: Chain[] = [baseSepolia, bscTestnet] as const;

export const EVM_CHAINS = [
  ...EVM_MAINNET_CHAINS,
  ...EVM_TESTNET_CHAINS,
] as const;

export const EVM_CHAIN_IDS = [
  ...EVM_CHAINS.map((chain) => chain.name),
] as const;

export type EvmNetworkName = keyof typeof EVM_CHAIN_IDS;
export type EvmChainId = (typeof EVM_CHAIN_IDS)[EvmNetworkName];

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
  context: NetworkContext
): context is Extract<NetworkContext, { family: "evm" }> {
  return context.family === "evm";
}

export function isSolanaNetworkContext(
  context: NetworkContext
): context is Extract<NetworkContext, { family: "solana" }> {
  return context.family === "solana";
}

export function getEvmNetworkNameByChainId(
  chainId: number
): EvmNetworkName | null {
  const chain = EVM_CHAINS.find((chain) => chain.id === chainId);
  if (!chain) {
    return null;
  }
  return chain.name as EvmNetworkName;
}

export function createEvmNetworkContext(chainId: number): NetworkContext {
  const network = getEvmNetworkNameByChainId(chainId);
  if (!network) {
    throw new Error(`Unsupported EVM chainId: ${chainId}`);
  }

  return {
    family: "evm",
    network,
    chainId: EVM_CHAIN_IDS[network]!,
    label: `${network.toString()}:${chainId}`,
  };
}

export function createSolanaNetworkContext(
  cluster: SolanaCluster
): NetworkContext {
  return {
    family: "solana",
    network: cluster,
    cluster,
    label: `solana:${cluster}`,
  };
}
