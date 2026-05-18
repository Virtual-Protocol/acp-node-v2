import { parseAbi } from "viem";

export const DELEGATION_ABI = parseAbi([
  "function executeWithSignature(bytes32 mode, bytes executionData, uint48 deadline, bytes signature, address recipient) payable",
  "function sigNonce() view returns (uint256)",
]);
