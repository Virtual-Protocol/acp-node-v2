/**
 * General Solana wallet helpers — balances + transfer instruction builders.
 *
 * These are EVM-consistent: like the EVM provider keeps a generic
 * `sendTransaction(call)` and relies on encoders to build the call, the Solana
 * provider keeps a generic `sendInstructions(instructions)` and these pure
 * helpers build the instructions / read balances. Compose them and pass to
 * `adapter.sendInstructions(...)`; read balances with `adapter.getRpc()`.
 *
 * Amounts are raw base units: lamports for SOL, token base units for SPL.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  AccountRole,
  getProgramDerivedAddress,
  getAddressEncoder,
} from "@solana/kit";
import type { SolanaInstructionLike } from "../../providers/types.js";

// ---------------------------------------------------------------------------
// Program ids
// ---------------------------------------------------------------------------

export const SYSTEM_PROGRAM_ID =
  "11111111111111111111111111111111" as Address;
export const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const ATA_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

// ---------------------------------------------------------------------------
// Associated Token Account helpers
// ---------------------------------------------------------------------------

/** Derive the Associated Token Account address for (owner, mint). */
export async function deriveAta(
  owner: Address,
  mint: Address
): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM_ID,
    seeds: [enc.encode(owner), enc.encode(TOKEN_PROGRAM_ID), enc.encode(mint)],
  });
  return pda;
}

/**
 * Build an idempotent "create ATA" instruction (succeeds even if the ATA
 * already exists). `payer` funds the rent.
 */
export function buildCreateAtaIdempotentIx(
  payer: Address,
  ata: Address,
  owner: Address,
  mint: Address
): SolanaInstructionLike {
  return {
    programAddress: ATA_PROGRAM_ID,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]), // CreateIdempotent
  };
}

// ---------------------------------------------------------------------------
// Transfer instruction builders
// ---------------------------------------------------------------------------

/** Build a System-program SOL transfer instruction. `lamports` is base units. */
export function buildSolTransferIx(
  from: Address,
  to: Address,
  lamports: bigint
): SolanaInstructionLike {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // System Transfer instruction index
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * Build the instructions to send an SPL token from `owner` to `recipient`:
 * an idempotent create of the recipient's ATA (no EVM analog — a token account
 * must exist before it can receive) followed by the SPL Token transfer.
 * Uses TransferChecked so the program verifies `mint` and `decimals` against the
 * token accounts; `amount` is token base units. `payer` funds the recipient-ATA
 * rent.
 */
export async function buildSplTransferInstructions(params: {
  owner: Address;
  recipient: Address;
  mint: Address;
  amount: bigint;
  decimals: number;
  payer: Address;
}): Promise<SolanaInstructionLike[]> {
  const { owner, recipient, mint, amount, decimals, payer } = params;
  const source = await deriveAta(owner, mint);
  const dest = await deriveAta(recipient, mint);

  const data = new Uint8Array(10);
  data[0] = 12; // SPL Token TransferChecked instruction index
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;

  const transferIx: SolanaInstructionLike = {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: dest, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };

  return [buildCreateAtaIdempotentIx(payer, dest, recipient, mint), transferIx];
}

// ---------------------------------------------------------------------------
// Balance reads
// ---------------------------------------------------------------------------

/** Native SOL balance in lamports. */
export async function getSolBalance(
  rpc: Rpc<SolanaRpcApi>,
  address: Address
): Promise<bigint> {
  const { value } = await rpc.getBalance(address).send();
  return BigInt(value);
}

/**
 * SPL token balance for (owner, mint). Returns raw base units + decimals.
 * A missing token account is reported as zero (decimals resolved from the mint).
 */
export async function getSplTokenBalance(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  mint: Address
): Promise<{ amount: bigint; decimals: number }> {
  const ata = await deriveAta(owner, mint);
  try {
    const { value } = await rpc.getTokenAccountBalance(ata).send();
    return { amount: BigInt(value.amount), decimals: value.decimals };
  } catch {
    try {
      const { value } = await rpc.getTokenSupply(mint).send();
      return { amount: 0n, decimals: value.decimals };
    } catch {
      return { amount: 0n, decimals: 0 };
    }
  }
}
