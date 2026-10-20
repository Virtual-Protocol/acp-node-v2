import type { AcpAgentOffering, FeeUnit } from "../../index.js";

/**
 * Shared types + constants for the off-escrow proportional-fee example.
 *
 * The offering sells a cross-chain stablecoin transfer as a pure storefront:
 * the buyer signs a Xochi intent (ERC-3009 / Permit2), the principal moves
 * off-escrow directly from the buyer's wallet to the destination chain, and ACP
 * only ever escrows the proportional facilitator fee (a few bps). See the
 * folder README and Raxol issue #373.
 */

export type HexAddress = `0x${string}`;

/**
 * Fee unit for this example. Whether a percentage offering's priceValue is
 * basis points or percent is a registry convention that must be confirmed
 * before relying on it. Buyer and seller share this one constant so they always
 * agree, and `computePercentageFee` takes the unit explicitly.
 */
export const FEE_UNIT: FeeUnit = "bps";

/** Default fee rate in `FEE_UNIT` (8 bps). Override with OFF_ESCROW_FEE_RATE. */
export const DEFAULT_FEE_RATE = 8;

/** Offering name === on-chain `job.description`; the seller routes on it. */
export const XOCHI_TRANSFER_OFFERING_NAME =
  "xochi_cross_chain_transfer" as const;

/** Requirement field the offering points `feeBasisField` at. */
export const FEE_BASIS_FIELD = "notionalAtomic" as const;

/**
 * Stub for the buyer's signed Xochi intent (an ERC-3009 / Permit2 bundle). In
 * the real flow this is produced by
 * `Raxol.Payments.Protocols.Xochi.quote_and_sign/3` and its signature binds
 * `boundNotionalAtomic`. Here we keep only the bound notional so the seller can
 * cross-check it against the declared notional.
 *
 * TODO: replace with the real signed intent bundle + on-chain intent decode.
 */
export type SignedIntentStub = {
  boundNotionalAtomic: string;
  signature: string;
};

export type TransferRequirement = {
  fromChainId: number;
  toChainId: number;
  token: HexAddress;
  /** Fee notional in atomic units, decimal string (the `feeBasisField`). */
  notionalAtomic: string;
  recipient: HexAddress;
  signedIntent: SignedIntentStub;
};

function isHexAddress(x: unknown): x is HexAddress {
  return typeof x === "string" && /^0x[a-fA-F0-9]{40}$/.test(x);
}

export function parseTransferRequirement(
  data: unknown
): TransferRequirement | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const si = o.signedIntent as Record<string, unknown> | undefined;
  if (
    typeof o.fromChainId !== "number" ||
    typeof o.toChainId !== "number" ||
    !isHexAddress(o.token) ||
    typeof o.notionalAtomic !== "string" ||
    !/^\d+$/.test(o.notionalAtomic) ||
    !isHexAddress(o.recipient) ||
    !si ||
    typeof si.boundNotionalAtomic !== "string" ||
    typeof si.signature !== "string"
  ) {
    return null;
  }
  return {
    fromChainId: o.fromChainId,
    toChainId: o.toChainId,
    token: o.token,
    notionalAtomic: o.notionalAtomic,
    recipient: o.recipient,
    signedIntent: {
      boundNotionalAtomic: si.boundNotionalAtomic,
      signature: si.signature,
    },
  };
}

/**
 * Notional bound in the (stub) signed intent, as bigint atomic units.
 *
 * This reads a plaintext field the buyer supplied, so it is not a real check on
 * its own: the buyer can set `boundNotionalAtomic` to any value. It stands in
 * for recovering the notional from the verified intent signature (Permit2 /
 * ERC-3009), which the buyer cannot forge. `assertNotionalMatches` is only as
 * trustworthy as the value this returns, so replace the stub with signature
 * verification before using it with live funds.
 */
export function boundNotionalFromIntent(intent: SignedIntentStub): bigint {
  return BigInt(intent.boundNotionalAtomic);
}

/**
 * Locally-constructed percentage offering (`requiredFunds: false`).
 *
 * The registry does not yet allow listing this shape, but the SDK and the
 * on-chain contract already support the job flow, so the offering is built here
 * to run the demo end to end without a registry row.
 */
export function buildTransferOffering(feeRate: number): AcpAgentOffering {
  return {
    name: XOCHI_TRANSFER_OFFERING_NAME,
    description:
      "Off-escrow cross-chain stablecoin transfer. ACP escrows only the " +
      "proportional facilitator fee; the principal moves via the buyer's " +
      "signed intent.",
    requirements: {
      type: "object",
      required: [
        "fromChainId",
        "toChainId",
        "token",
        FEE_BASIS_FIELD,
        "recipient",
        "signedIntent",
      ],
      properties: {
        fromChainId: { type: "number" },
        toChainId: { type: "number" },
        token: { type: "string" },
        [FEE_BASIS_FIELD]: { type: "string", pattern: "^\\d+$" },
        recipient: { type: "string" },
        signedIntent: { type: "object" },
      },
    },
    deliverable: {
      type: "object",
      required: ["kind", "settlementTxHash", "chainId"],
      properties: {
        kind: { const: "settlement" },
        settlementTxHash: { type: "string" },
        chainId: { type: "number" },
      },
    },
    slaMinutes: 5,
    priceType: "percentage",
    priceValue: feeRate,
    requiredFunds: false,
    feeBasisField: FEE_BASIS_FIELD,
    isHidden: false,
    isPrivate: false,
  };
}

/** Sample requirement: transfer 1000 USDC (6-dec atomic) Base -> Arbitrum. */
export const exampleTransferRequirement: TransferRequirement = {
  fromChainId: 8453,
  toChainId: 42161,
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as HexAddress,
  notionalAtomic: "1000000000",
  recipient: "0x000000000000000000000000000000000000dEaD" as HexAddress,
  signedIntent: {
    boundNotionalAtomic: "1000000000",
    signature: "0xstub",
  },
};
