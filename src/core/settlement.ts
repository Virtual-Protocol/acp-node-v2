/**
 * Settlement-proof deliverable convention for off-escrow facilitator jobs.
 *
 * For jobs where the transferred value moves outside ACP escrow (the provider
 * only relays the buyer's signed intent), the deliverable is a proof that the
 * facilitated settlement happened on-chain: a settlement tx hash on the
 * destination chain, so an evaluator / reputation layer can verify it
 * independently even though no ACP escrow moved the principal.
 */
export interface SettlementDeliverable {
  kind: "settlement";
  /** Settlement transaction hash on the destination chain. */
  settlementTxHash: string;
  /** Destination chain id the settlement tx was mined on. */
  chainId: number;
  /** Optional: notional settled, in atomic units (as a decimal string). */
  notional?: string;
  /** Optional: token address the notional settled in. */
  token?: string;
}

/** Serialize a settlement proof for `session.submit(...)`. */
export function buildSettlementDeliverable(
  proof: Omit<SettlementDeliverable, "kind">
): string {
  const payload: SettlementDeliverable = { kind: "settlement", ...proof };
  return JSON.stringify(payload);
}

/**
 * Parse and shape-validate a settlement deliverable. Returns `null` when the
 * string is not a well-formed settlement proof (mirrors the `parse*` helpers in
 * the fund-transfer example). Use this in an evaluator before releasing the fee.
 */
export function parseSettlementDeliverable(
  deliverable: string
): SettlementDeliverable | null {
  let data: unknown;
  try {
    data = JSON.parse(deliverable);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.kind !== "settlement") return null;
  if (
    typeof o.settlementTxHash !== "string" ||
    o.settlementTxHash.length === 0
  ) {
    return null;
  }
  if (typeof o.chainId !== "number" || !Number.isInteger(o.chainId) || o.chainId <= 0) {
    return null;
  }

  const out: SettlementDeliverable = {
    kind: "settlement",
    settlementTxHash: o.settlementTxHash,
    chainId: o.chainId,
  };
  if (typeof o.notional === "string") out.notional = o.notional;
  if (typeof o.token === "string") out.token = o.token;
  return out;
}

/**
 * JSON schema usable as `AcpAgentOffering.deliverable` so an off-escrow
 * offering documents the settlement-proof shape it returns.
 */
export const SETTLEMENT_DELIVERABLE_SCHEMA = {
  type: "object",
  required: ["kind", "settlementTxHash", "chainId"],
  properties: {
    kind: { const: "settlement" },
    settlementTxHash: { type: "string" },
    // chain ids are positive integers (incl. the synthetic Solana ids 500/501)
    chainId: { type: "integer", minimum: 1 },
    notional: { type: "string" },
    token: { type: "string" },
  },
} as const;
