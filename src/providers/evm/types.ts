import type { Address, Hex, LocalAccount } from "viem";

export type UserOperationV07 = {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterData?: Hex;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
};

export type SignUserOperationParams = {
  chainId: number;
  contract: Address;
  userOperation: UserOperationV07;
};

export type RemoteSigner = LocalAccount<"privy-remote"> & {
  signUserOperation(params: SignUserOperationParams): Promise<Hex>;
};
