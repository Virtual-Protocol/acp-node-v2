import { encodeAbiParameters, toHex, type Address, type Hex } from "viem";
import {
  getAddressEncoder as getSolAddressEncoder,
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
    // The Solana FundTransferHook's set_budget path takes NO opt_params: it
    // auto-derives the fund request from the job (full budget amount, paid by
    // the client to the provider, using the job's budget mint). The EVM-style
    // (token, amount, destination) tuple does not apply here. Sending a
    // non-empty payload makes after_action reject the job (InvalidJob).
    void token;
    void amount;
    void destination;
    return "0x";
  }
  return encodeFundTransferOptParams(token as Address, amount, destination as Address);
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
