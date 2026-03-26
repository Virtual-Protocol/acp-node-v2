import { EvmAcpClient } from "./clients/evmAcpClient";
import { SolanaAcpClient } from "./clients/solanaAcpClient";
import type {
  IEvmProviderAdapter,
  IProviderAdapter,
  ISolanaProviderAdapter,
} from "./providers/types";

export type AcpClient = EvmAcpClient | SolanaAcpClient;

export type CreateAcpClientInput = {
  contractAddresses: Record<number, string>;
  provider: IProviderAdapter;
};

export async function createAcpClient(
  input: CreateAcpClientInput
): Promise<AcpClient> {
  if (isEvmProvider(input.provider)) {
    return EvmAcpClient.create({
      contractAddresses: input.contractAddresses,
      provider: input.provider,
    });
  }

  if (isSolanaProvider(input.provider)) {
    return SolanaAcpClient.create({
      contractAddresses: input.contractAddresses,
      provider: input.provider,
    });
  }

  throw new Error(
    `Provider "${input.provider.providerName}" does not implement a known adapter interface.`
  );
}

function isEvmProvider(provider: IProviderAdapter): provider is IEvmProviderAdapter {
  return (
    "sendCalls" in provider &&
    typeof (provider as any).sendCalls === "function"
  );
}

function isSolanaProvider(provider: IProviderAdapter): provider is ISolanaProviderAdapter {
  return (
    "getCluster" in provider &&
    typeof (provider as any).getCluster === "function" &&
    "sendInstructions" in provider &&
    typeof (provider as any).sendInstructions === "function"
  );
}
