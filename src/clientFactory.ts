import { EvmAcpClient } from "./clients/evmAcpClient";
import { SolanaAcpClient } from "./clients/solanaAcpClient";
import {
  ACP_CONTRACT_ADDRESSES,
  type ChainFamily,
  getChainFamily,
} from "./core/constants";
import type {
  IEvmProviderAdapter,
  ISolanaProviderAdapter,
} from "./providers/types";

export type AcpClient = EvmAcpClient | SolanaAcpClient;

export type CreateAcpClientInput = {
  contractAddresses?: Record<number, string>;
  evmProvider?: IEvmProviderAdapter;
  solanaProvider?: ISolanaProviderAdapter;
};

export async function createAcpClients(
  input: CreateAcpClientInput
): Promise<Map<ChainFamily, AcpClient>> {
  const { evmProvider, solanaProvider } = input;
  if (!evmProvider && !solanaProvider) {
    throw new Error("At least one provider (evmProvider or solanaProvider) must be provided.");
  }

  const allAddresses = input.contractAddresses ?? ACP_CONTRACT_ADDRESSES;

  const evmAddresses: Record<number, string> = {};
  const solanaAddresses: Record<number, string> = {};
  for (const [chainIdStr, addr] of Object.entries(allAddresses)) {
    const chainId = Number(chainIdStr);
    if (getChainFamily(chainId) === "solana") {
      solanaAddresses[chainId] = addr;
    } else {
      evmAddresses[chainId] = addr;
    }
  }

  const clients = new Map<ChainFamily, AcpClient>();

  if (evmProvider && Object.keys(evmAddresses).length > 0) {
    clients.set(
      "evm",
      await EvmAcpClient.create({
        contractAddresses: evmAddresses,
        provider: evmProvider,
      })
    );
  }

  if (solanaProvider && Object.keys(solanaAddresses).length > 0) {
    clients.set(
      "solana",
      await SolanaAcpClient.create({
        contractAddresses: solanaAddresses,
        provider: solanaProvider,
      })
    );
  }

  if (clients.size === 0) {
    throw new Error(
      "No clients could be created. Check that contractAddresses match the provided providers."
    );
  }

  return clients;
}
