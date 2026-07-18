import { encodeAbiParameters, toHex, type Address, type Hex } from "viem";
import {
  getAddressDecoder as getSolAddressDecoder,
  getAddressEncoder as getSolAddressEncoder,
  getU64Decoder as getSolU64Decoder,
  getU64Encoder as getSolU64Encoder,
} from "@solana/kit";
import {
  ACP_SELECTORS,
  FUND_TRANSFER_HOOK_ADDRESSES,
  getAddressForChain,
  getChainFamily,
  SUBSCRIPTION_HOOK_ADDRESSES,
} from "./constants.js";

export type MultiHookConfig = {
  selectors: Hex[];
  hooksPerSelector: string[][];
};

export function encodeRouterOptParams(slices: Hex[]): Hex {
  return encodeAbiParameters(
    [{ type: "bytes[]", name: "perHookData" }],
    [slices]
  );
}

export function encodeSubscriptionOptParams(
  duration: bigint,
  packageId: bigint
): Hex {
  return encodeAbiParameters(
    [
      { type: "uint256", name: "duration" },
      { type: "uint256", name: "packageId" },
    ],
    [duration, packageId]
  );
}

export function buildSubscriptionWithFundsHookConfig(
  chainId: number
): MultiHookConfig {
  const subHook = getAddressForChain(
    SUBSCRIPTION_HOOK_ADDRESSES,
    chainId,
    "SubscriptionHook"
  );
  const fundHook = getAddressForChain(
    FUND_TRANSFER_HOOK_ADDRESSES,
    chainId,
    "FundTransferHook"
  );
  const both = [subHook, fundHook];
  return {
    selectors: [
      ACP_SELECTORS.setBudget,
      ACP_SELECTORS.fund,
      ACP_SELECTORS.submit,
      ACP_SELECTORS.complete,
      ACP_SELECTORS.reject,
    ],
    hooksPerSelector: [both, both, [fundHook], both, both],
  };
}

export function encodeFundTransferOptParams(
  token: Address,
  amount: bigint,
  destination: Address
): Hex {
  return encodeAbiParameters(
    [
      { type: "address", name: "token" },
      { type: "uint256", name: "amount" },
      { type: "address", name: "destination" },
    ],
    [token, amount, destination]
  );
}

function encodeSolanaBorsh(fields: Array<{ type: "pubkey"; value: string } | { type: "u64"; value: bigint }>): Hex {
  const addrEnc = getSolAddressEncoder();
  const u64Enc = getSolU64Encoder();
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    if (f.type === "pubkey") {
      parts.push(new Uint8Array(addrEnc.encode(f.value as Parameters<typeof addrEnc.encode>[0])));
    } else {
      parts.push(new Uint8Array(u64Enc.encode(f.value)));
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return toHex(buf);
}

export function encodeFundTransferSetBudgetOptParams(
  chainId: number,
  token: string,
  amount: bigint,
  destination: string
): Hex {
  if (getChainFamily(chainId) === "solana") {
    // The Solana hook decodes the fund-request proposal from opt_params
    // exactly like the EVM hook — [token (32)] [amount u64 LE (8)]
    // [destination (32)] = 72 bytes. Empty opt_params proposes nothing;
    // token = the default pubkey (all zeros / system program address) cancels
    // a live proposal. F-82: budget-mint amounts may exceed the job budget —
    // fund() authorizes over-budget intents with a client-signed
    // Approve/Revoke bracket (hook_delegate omitted from the core ix).
    return encodeSolanaBorsh([
      { type: "pubkey", value: token },
      { type: "u64", value: amount },
      { type: "pubkey", value: destination },
    ]);
  }
  return encodeFundTransferOptParams(token as Address, amount, destination as Address);
}

/** Decoded Solana fund-transfer submit escrow proposal (token, amount). */
export type SolanaEscrowOptParams = { token: string; amount: bigint };

/**
 * Decode the Solana submit escrow opt_params layout
 * ([token (32)] [amount u64 LE (8)] = 40 bytes) so the client can derive the
 * escrow vault, the provider's source token account, and the delegate
 * approval amount from a caller-supplied proposal. Returns null for empty or
 * short payloads (empty = no escrow proposed).
 */
export function decodeSolanaEscrowOptParams(
  bytes: Uint8Array
): SolanaEscrowOptParams | null {
  if (bytes.length < 40) {
    return null;
  }
  const token = getSolAddressDecoder().decode(bytes.subarray(0, 32));
  const amount = getSolU64Decoder().decode(bytes.subarray(32, 40));
  return { token, amount };
}

export function encodeFundTransferFundOptParams(
  chainId: number,
  expectedToken: string,
  expectedAmount: bigint,
  expectedRecipient: string
): Hex {
  if (getChainFamily(chainId) === "solana") {
    return encodeSolanaBorsh([
      { type: "pubkey", value: expectedToken },
      { type: "u64", value: expectedAmount },
      { type: "pubkey", value: expectedRecipient },
    ]);
  }
  return encodeAbiParameters(
    [
      { type: "address", name: "expectedToken" },
      { type: "uint256", name: "expectedAmount" },
      { type: "address", name: "expectedRecipient" },
    ],
    [expectedToken as Address, expectedAmount, expectedRecipient as Address]
  );
}

export function encodeFundTransferSubmitOptParams(
  chainId: number,
  token: string,
  amount: bigint
): Hex {
  if (getChainFamily(chainId) === "solana") {
    return encodeSolanaBorsh([
      { type: "pubkey", value: token },
      { type: "u64", value: amount },
    ]);
  }
  return encodeAbiParameters(
    [
      { type: "address", name: "token" },
      { type: "uint256", name: "amount" },
    ],
    [token as Address, amount]
  );
}
