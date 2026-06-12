import {
  createSignableMessage,
  getBase58Decoder,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  createSolanaNetworkContext,
  type SolanaCluster,
} from "../../core/chains.js";
import type {
  ISolanaProviderAdapter,
  SolanaInstructionLike,
  SolanaSigner,
} from "../types.js";

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
    throw new Error(
      "getSupportedChainIds() not implemented. Override in subclass."
    );
  }

  getRpc(): Rpc<SolanaRpcApi> {
    throw new Error("getRpc() not implemented. Override in subclass.");
  }

  getSigner(): SolanaSigner {
    throw new Error("getSigner() not implemented. Override in subclass.");
  }

  async signMessage(message: string): Promise<string> {
    const signer = this.getSigner();
    const [dict] = await signer.signMessages([createSignableMessage(message)]);
    const sig = dict?.[signer.address];
    if (!sig) {
      throw new Error("Message signing returned no signature for the signer");
    }
    return getBase58Decoder().decode(sig);
  }

  async getNetworkContext(_chainId: number) {
    const cluster = await this.getCluster();
    return createSolanaNetworkContext(cluster);
  }

  async sendInstructions(
    _instructions: SolanaInstructionLike[]
  ): Promise<string | string[]> {
    throw new Error(
      "sendInstructions() not implemented. Override in subclass."
    );
  }
}
