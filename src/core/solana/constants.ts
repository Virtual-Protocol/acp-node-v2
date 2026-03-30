import type { Address } from "@solana/kit";

export const SOLANA_ACP_PROGRAM_ID = "CBcKZ1iHGaPti2RZ1jfVn1YrYtATueGtHtgRJeTFCshi" as Address;
export const SOLANA_MEMO_HOOK_PROGRAM_ID = "AVYJZVBxBrWHSni8zuqXLvhAJk5npbUDUpWkUcCSdvQP" as Address;

// sha256("event:JobCreated")[0..8]
export const JOB_CREATED_EVENT_DISC = new Uint8Array([48, 110, 162, 177, 67, 74, 159, 131]);
