import { EvmAcpClient } from "./clients/evmAcpClient.js";
import { SolanaAcpClient } from "./clients/solanaAcpClient.js";
import { ACP_CONTRACT_ADDRESSES } from "./core/constants.js";
import type {
  IEvmProviderAdapter,
  IProviderAdapter,
  ISolanaProviderAdapter,
} from "./providers/types.js";

export type AcpClient = EvmAcpClient | SolanaAcpClient;

export type CreateAcpClientInput = {
  contractAddresses?: Record<number, string>;
  provider: IProviderAdapter;
};

export async function createAcpClient(
  input: CreateAcpClientInput
): Promise<AcpClient> {
  if (isEvmProvider(input.provider)) {
    return EvmAcpClient.create({
      contractAddresses: input.contractAddresses ?? ACP_CONTRACT_ADDRESSES,
      provider: input.provider,
    });
  }

  if (isSolanaProvider(input.provider)) {
    return SolanaAcpClient.create({
      contractAddresses: input.contractAddresses ?? ACP_CONTRACT_ADDRESSES,
      provider: input.provider,
    });
  }

  throw new Error(
    `Provider "${input.provider.providerName}" does not implement a known adapter interface.`
  );
}

function isEvmProvider(
  provider: IProviderAdapter
): provider is IEvmProviderAdapter {
  return (
    "sendCalls" in provider && typeof (provider as any).sendCalls === "function"
  );
}

function isSolanaProvider(
  provider: IProviderAdapter
): provider is ISolanaProviderAdapter {
  return (
    "getCluster" in provider &&
    typeof (provider as any).getCluster === "function" &&
    "sendInstructions" in provider &&
    typeof (provider as any).sendInstructions === "function"
  );
}
