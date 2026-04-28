import { encodeAbiParameters, type Address, type Hex } from "viem";
import {
  ACP_SELECTORS,
  FUND_TRANSFER_HOOK_ADDRESSES,
  getAddressForChain,
  SUBSCRIPTION_HOOK_ADDRESSES,
} from "./constants";

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
