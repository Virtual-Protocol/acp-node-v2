import type { Address, Commitment } from "@solana/kit";

export const ACP_COMMITMENT: Commitment = "confirmed";

export const SOLANA_ACP_PROGRAM_ID = "EkJQUp3Xouu94Wt8vf2hxuZcFLL5Wk2h91bNdFiiS5Bp" as Address;
export const SOLANA_FUND_TRANSFER_HOOK_PROGRAM_ID = "7BYmFM1J2xCKTAmKHoxFPgsZG63feKx3iBfbW9cVZSHg" as Address;

export const JOB_CREATED_EVENT_DISC = new Uint8Array([48, 110, 162, 177, 67, 74, 159, 131]);
