/**
 * Optional structured requirement shapes for sample fund-transfer flows.
 * When using `FUND_TRANSFER_DEMO`, the on-chain `job.description` should match
 * the corresponding identifier (`swap_token`, `open_position`, `close_position`).
 */

export type HexAddress = `0x${string}`;

export type TpSlConfig = {
  percentage?: number;
  price?: number;
};

export type SwapTokenRequirement = {
  fromSymbol: string;
  fromContractAddress: HexAddress;
  amount: number;
  toSymbol: string;
  toContractAddress: HexAddress;
};

export type OpenPositionRequirement = {
  symbol: string;
  amount: number;
  tp: TpSlConfig;
  sl: TpSlConfig;
  direction: "long" | "short";
};

export type ClosePositionRequirement = {
  symbol: string;
};

export type StructuredFundTransferRequirement =
  | SwapTokenRequirement
  | OpenPositionRequirement
  | ClosePositionRequirement;

export const JOB_SWAP_TOKEN = "swap_token" as const;
export const JOB_OPEN_POSITION = "open_position" as const;
export const JOB_CLOSE_POSITION = "close_position" as const;

/**
 * Sample `job.description` string used in documentation snippets (e.g. main
 * README). The seller matches this when handling jobs created outside
 * `createJobFromOffering`.
 */
export const EXAMPLE_SDK_JOB_DESCRIPTION = "Example job from SDK" as const;

function isHexAddress(x: unknown): x is HexAddress {
  return typeof x === "string" && /^0x[a-fA-F0-9]{40}$/.test(x);
}

export function parseSwapPayload(data: unknown): SwapTokenRequirement | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (
    typeof o.fromSymbol !== "string" ||
    !isHexAddress(o.fromContractAddress) ||
    typeof o.amount !== "number" ||
    typeof o.toSymbol !== "string" ||
    !isHexAddress(o.toContractAddress)
  ) {
    return null;
  }
  return {
    fromSymbol: o.fromSymbol,
    fromContractAddress: o.fromContractAddress,
    amount: o.amount,
    toSymbol: o.toSymbol,
    toContractAddress: o.toContractAddress,
  };
}

export function parseOpenPositionPayload(
  data: unknown
): OpenPositionRequirement | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const tp = o.tp;
  const sl = o.sl;
  if (
    typeof o.symbol !== "string" ||
    typeof o.amount !== "number" ||
    typeof o.direction !== "string" ||
    (o.direction !== "long" && o.direction !== "short") ||
    typeof tp !== "object" ||
    tp === null ||
    typeof sl !== "object" ||
    sl === null
  ) {
    return null;
  }
  return {
    symbol: o.symbol,
    amount: o.amount,
    tp: tp as TpSlConfig,
    sl: sl as TpSlConfig,
    direction: o.direction,
  };
}

export function parseClosePositionPayload(
  data: unknown
): ClosePositionRequirement | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (typeof o.symbol !== "string") return null;
  return { symbol: o.symbol };
}

/** Sample requirement bodies for local testing (Base USDC / VIRTUAL). */
export const exampleSwapTokenRequirement: SwapTokenRequirement = {
  fromSymbol: "USDC",
  fromContractAddress:
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as HexAddress,
  amount: 0.008,
  toSymbol: "VIRTUAL",
  toContractAddress: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" as HexAddress,
};

export const exampleOpenPositionRequirement: OpenPositionRequirement = {
  symbol: "BTC",
  amount: 0.009,
  tp: { percentage: 5 },
  sl: { percentage: 2 },
  direction: "long",
};

export const exampleClosePositionRequirement: ClosePositionRequirement = {
  symbol: "BTC",
};
