import { createSolanaNetworkContext, type SolanaCluster } from "../../core/chains";
import type {
  ISolanaProviderAdapter,
  SolanaInstructionLike,
} from "../types";

export class SolanaProviderAdapter implements ISolanaProviderAdapter {
  public readonly providerName: string;

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  async getAddress(): Promise<string> {
    throw new Error("getAddress() not implemented. Override in subclass.");
  }

  async getCluster(): Promise<SolanaCluster> {
    throw new Error("getCluster() not implemented. Override in subclass.");
  }

  async getSupportedChainIds(): Promise<number[]> {
    throw new Error("getSupportedChainIds() not implemented. Override in subclass.");
  }

  async getNetworkContext(_chainId: number) {
    const cluster = await this.getCluster();
    return createSolanaNetworkContext(cluster);
  }

  async sendInstructions(
    _instructions: SolanaInstructionLike[]
  ): Promise<string | string[]> {
    throw new Error("sendInstructions() not implemented. Override in subclass.");
  }
}
