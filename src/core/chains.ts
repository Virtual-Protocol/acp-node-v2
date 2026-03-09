export type ChainFamily = "evm" | "solana";

const EVM_MAINNET_CHAIN_IDS = {
  base: 8453,
  polygon: 137,
  bsc: 56,
} as const;

const EVM_TESTNET_CHAIN_IDS = {
  baseSepolia: 84532,
} as const;

export const EVM_CHAIN_IDS = {
  ...EVM_MAINNET_CHAIN_IDS,
  ...EVM_TESTNET_CHAIN_IDS,
} as const;

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
  const entries = Object.entries(EVM_CHAIN_IDS) as [EvmNetworkName, number][];
  const match = entries.find(([, id]) => id === chainId);
  return match?.[0] ?? null;
}

export function createEvmNetworkContext(chainId: number): NetworkContext {
  const network = getEvmNetworkNameByChainId(chainId);
  if (!network) {
    throw new Error(`Unsupported EVM chainId: ${chainId}`);
  }

  return {
    family: "evm",
    network,
    chainId: EVM_CHAIN_IDS[network],
    label: `${network}:${chainId}`,
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
