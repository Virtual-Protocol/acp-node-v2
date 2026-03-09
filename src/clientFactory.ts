import { EvmAcpClient } from "./clients/evmAcpClient";
import { SolanaAcpClient } from "./clients/solanaAcpClient";
import type {
  IEvmProviderAdapter,
  IProviderAdapter,
  ISolanaProviderAdapter,
} from "./providers/types";

export type AcpClient = EvmAcpClient | SolanaAcpClient;

export type CreateAcpClientInput = {
  contractAddress: string;
  provider: IProviderAdapter;
};

export async function createAcpClient(
  input: CreateAcpClientInput
): Promise<AcpClient> {
  const context = await input.provider.getNetworkContext();

  if (context.family === "evm") {
    const evmProvider = assertEvmProvider(input.provider);
    return EvmAcpClient.create({
      contractAddress: input.contractAddress as `0x${string}`,
      provider: evmProvider,
    });
  }

  const solanaProvider = assertSolanaProvider(input.provider);
  return SolanaAcpClient.create({
    contractAddress: input.contractAddress,
    provider: solanaProvider,
  });
}

function assertEvmProvider(provider: IProviderAdapter): IEvmProviderAdapter {
  if (
    "getChainId" in provider &&
    typeof provider.getChainId === "function" &&
    "sendCalls" in provider &&
    typeof provider.sendCalls === "function"
  ) {
    return provider as IEvmProviderAdapter;
  }

  throw new Error(
    `Provider "${provider.providerName}" resolved as EVM but does not implement IEvmProviderAdapter.`
  );
}

function assertSolanaProvider(
  provider: IProviderAdapter
): ISolanaProviderAdapter {
  if (
    "getCluster" in provider &&
    typeof provider.getCluster === "function" &&
    "sendInstructions" in provider &&
    typeof provider.sendInstructions === "function"
  ) {
    return provider as ISolanaProviderAdapter;
  }

  throw new Error(
    `Provider "${provider.providerName}" resolved as Solana but does not implement ISolanaProviderAdapter.`
  );
}
