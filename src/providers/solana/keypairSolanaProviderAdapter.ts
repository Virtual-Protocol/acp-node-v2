import {
  createSolanaRpc,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  addSignersToTransactionMessage,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import type { SolanaCluster } from "../../core/chains";
import type { SolanaInstructionLike } from "../types";
import { SolanaProviderAdapter } from "./solanaProviderAdapter";

export class KeypairSolanaProviderAdapter extends SolanaProviderAdapter {
  private readonly signer: KeyPairSigner;
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly cluster: SolanaCluster;

  constructor(signer: KeyPairSigner, rpcUrl: string, cluster: SolanaCluster) {
    super("keypair");
    this.signer = signer;
    this.rpc = createSolanaRpc(rpcUrl);
    this.cluster = cluster;
  }

  async getAddress(): Promise<string> {
    return this.signer.address;
  }

  async getCluster(): Promise<SolanaCluster> {
    return this.cluster;
  }

  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  getSigner(): KeyPairSigner {
    return this.signer;
  }

  async sendInstructions(
    instructions: SolanaInstructionLike[],
  ): Promise<string> {
    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(this.signer.address, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
      (msg) => addSignersToTransactionMessage([this.signer], msg),
    );

    const signedTx = await signTransactionMessageWithSigners(message);
    const encodedTx = getBase64EncodedWireTransaction(signedTx);

    let signature: Signature;
    try {
      signature = await this.rpc
        .sendTransaction(encodedTx, { encoding: "base64" })
        .send();
    } catch (err: unknown) {
      // Extract simulation logs from the RPC error for better diagnostics
      const errObj = err as Record<string, unknown>;
      const context = errObj?.context as Record<string, unknown> | undefined;
      const cause = errObj?.cause as Record<string, unknown> | undefined;
      const logs =
        (context?.logs as string[]) ??
        (cause?.logs as string[]) ??
        (errObj?.logs as string[]);
      if (logs?.length) {
        throw new Error(
          `Transaction simulation failed:\n${logs.join("\n")}`,
        );
      }
      throw err;
    }

    // Wait for transaction confirmation before returning
    for (let i = 0; i < 30; i++) {
      const { value } = await this.rpc
        .getSignatureStatuses([signature])
        .send();
      const status = value[0];
      if (status) {
        if (status.err) {
          throw new Error(
            `Transaction failed: ${JSON.stringify(status.err)}`,
          );
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return signature;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Transaction confirmation timeout: ${signature}`);
  }
}
