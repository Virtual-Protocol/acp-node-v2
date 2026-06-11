import type { Address } from "@solana/kit";

export const SOLANA_ACP_PROGRAM_ID = "EkJQUp3Xouu94Wt8vf2hxuZcFLL5Wk2h91bNdFiiS5Bp" as Address;
export const SOLANA_FUND_TRANSFER_HOOK_PROGRAM_ID = "9gX4rKCkXuxwQpSSfVET2KFsiTm8eFs93pp3h6yB3hwr" as Address;

// sha256("event:JobCreated")[0..8]
export const JOB_CREATED_EVENT_DISC = new Uint8Array([48, 110, 162, 177, 67, 74, 159, 131]);
