import {
  AccountRole,
  getProgramDerivedAddress,
  getAddressEncoder,
  getAddressDecoder,
  getU64Encoder,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  addSignersToTransactionMessage,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  type Address,
  type Signature,
  type KeyPairSigner,
  type FetchAccountConfig,
} from "@solana/kit";
import { ACP_COMMITMENT } from "../core/solana/constants.js";
import {
  ACP_CONTRACT_ADDRESSES,
  MULTI_HOOK_ROUTER_ADDRESSES,
  FUND_TRANSFER_HOOK_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  SUBSCRIPTION_STATE_ADDRESSES,
} from "../core/constants.js";
import { fetchAcpState } from "../core/solana/generated/acp/accounts/acpState.js";
import { fetchHookState } from "../core/solana/generated/fund-transfer-hook/accounts/hookState.js";
import { fetchFundRequestIntentId } from "../core/solana/generated/fund-transfer-hook/accounts/fundRequestIntentId.js";
import { fetchProviderEscrowIntentId } from "../core/solana/generated/fund-transfer-hook/accounts/providerEscrowIntentId.js";
import { getCreateJobInstructionAsync } from "../core/solana/generated/acp/instructions/createJob.js";
import { getSetBudgetInstruction } from "../core/solana/generated/acp/instructions/setBudget.js";
import { getFundInstruction } from "../core/solana/generated/acp/instructions/fund.js";
import { getSubmitInstructionAsync } from "../core/solana/generated/acp/instructions/submit.js";
import { getCompleteInstructionAsync } from "../core/solana/generated/acp/instructions/complete.js";
import { getBatchConfigureHooksInstructionAsync } from "../core/solana/generated/multi-hook-router/instructions/batchConfigureHooks.js";
import * as mh from "../core/solana/multiHook.js";
import type { ISolanaProviderAdapter, SolanaInstructionLike, SolanaSigner } from "../providers/types.js";

const SYSTEM = "11111111111111111111111111111111" as Address;
const SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111" as Address;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;

const ae = getAddressEncoder();
const ad = getAddressDecoder();
const u64 = getU64Encoder();
// LookupTableMeta serialized size; account address list begins at this offset.
const LUT_META_SIZE = 56;
const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
const w = (address: Address) => ({ address, role: AccountRole.WRITABLE });
const ws = (address: Address) => ({ address, role: AccountRole.WRITABLE_SIGNER });
const rs = (address: Address) => ({ address, role: AccountRole.READONLY_SIGNER });

export type SubscriptionTerms = { durationSecs: bigint; packageId: bigint };

type Rpc = ReturnType<ISolanaProviderAdapter["getRpc"]>;

export class SolanaMultiHookClient {
  readonly acp: Address;
  readonly router: Address;
  readonly fundHook: Address;
  readonly sub: Address;
  readonly subState: Address;
  private readonly rpc: Rpc;

  /** Build from a chainId (addresses sourced from constants) + an rpc. */
  constructor(chainId: number, rpc: Rpc) {
    this.acp = ACP_CONTRACT_ADDRESSES[chainId]! as Address;
    this.router = MULTI_HOOK_ROUTER_ADDRESSES[chainId]! as Address;
    this.fundHook = FUND_TRANSFER_HOOK_ADDRESSES[chainId]! as Address;
    this.sub = SUBSCRIPTION_HOOK_ADDRESSES[chainId]! as Address;
    this.subState = SUBSCRIPTION_STATE_ADDRESSES[chainId]! as Address;
    this.rpc = rpc;
  }

  // -------------------------------------------------------------------------
  // Legs
  // -------------------------------------------------------------------------

  /** createJob with the router as hook. Returns the new jobId. */
  async createJob(
    client: ISolanaProviderAdapter,
    p: { provider: Address; evaluator: Address; expiredAt: number; description: string }
  ): Promise<bigint> {
    const signer = client.getSigner();
    const acpState = await this.read(fetchAcpState, await mh.acpStatePda(this.acp));
    const jobId = acpState.data.jobCounter;
    const jobPda = await mh.jobPda(this.acp, signer.address, jobId);
    const ix = await getCreateJobInstructionAsync({
      client: signer,
      job: jobPda,
      provider: p.provider,
      evaluator: p.evaluator,
      description: p.description,
      expiredAt: p.expiredAt,
      hookAddress: this.router,
      hookWhitelist: await this.wl(this.router),
    });
    await client.sendInstructions([
      {
        programAddress: ix.programAddress,
        accounts: [
          ...ix.accounts,
          ro(await mh.hookRouterPda(this.router, jobId)),
          ro(await mh.routerStatePda(this.router)),
          ro(SYSVAR_IX),
        ],
        data: ix.data as Uint8Array,
      },
    ]);
    return jobId;
  }

  /** Configure the router's per-selector routing (standard sub + fund layout). */
  async configureHooks(client: ISolanaProviderAdapter, jobId: bigint): Promise<string> {
    const signer = client.getSigner();
    const jobPda = await mh.jobPda(this.acp, signer.address, jobId);
    const both: Address[] = [this.sub, this.fundHook];
    const ix = await getBatchConfigureHooksInstructionAsync({
      client: signer,
      job: jobPda,
      hookRouter: await mh.hookRouterPda(this.router, jobId),
      routerState: await mh.routerStatePda(this.router),
      systemProgram: SYSTEM,
      jobId,
      setBudget: both,
      fund: both,
      submit: [this.fundHook],
      complete: both,
      reject: both,
    });
    return this.one(
      await client.sendInstructions([
        {
          programAddress: ix.programAddress,
          accounts: [
            ...ix.accounts,
            ro(await this.wl(this.sub)),
            ro(await mh.hookMetadataPda(this.sub)),
            ro(await this.wl(this.fundHook)),
            ro(await mh.hookMetadataPda(this.fundHook)),
          ],
          data: ix.data as Uint8Array,
        },
      ])
    );
  }

  /** setBudget — router fans out to sub-hook (proposes terms) + fund-hook. */
  async setBudget(
    provider: ISolanaProviderAdapter,
    jobId: bigint,
    p: { amount: bigint; terms: SubscriptionTerms; clientAddress: Address }
  ): Promise<string> {
    const seller = provider.getSigner();
    const jobPda = await mh.jobPda(this.acp, p.clientAddress, jobId);
    const paymentToken = await this.paymentToken();
    const fundHookState = await mh.hookStatePda(this.fundHook);
    const counter = (await this.read(fetchHookState, fundHookState)).data.intentCounter;
    const setBudgetIntent = await mh.intentPda(this.fundHook, counter + 1n);

    const subParams = mh.encodeSubParams(p.terms.durationSecs, p.terms.packageId);
    const header = mh.encodeMultiHookHeader([
      { accountCount: 7, params: subParams },
      { accountCount: 7, params: new Uint8Array(0) },
    ]);
    const ix = getSetBudgetInstruction({
      caller: seller,
      job: jobPda,
      budgetMint: paymentToken,
      hookProgram: this.router,
      hookWhitelist: await this.wl(this.router),
      amount: p.amount,
      optParams: header,
    });
    const acc = [
      ...ix.accounts,
      ...(await this.routerPrefix(jobId)),
      ro(this.sub), ro(await this.wl(this.sub)), w(await mh.hookStatePda(this.sub)), ro(SYSVAR_IX),
      ws(seller.address), w(await mh.proposedTermsPda(this.sub, jobId)), ro(jobPda),
      ro(await mh.subExpiryPda(this.subState, p.clientAddress, seller.address, p.terms.packageId)), ro(SYSTEM),
      ro(this.fundHook), ro(await this.wl(this.fundHook)), w(fundHookState), ro(SYSVAR_IX),
      ws(seller.address), w(setBudgetIntent), w(await mh.fundRequestIntentIdPda(this.fundHook, jobId)), ro(jobPda), ro(SYSTEM),
    ];
    return this.one(
      await provider.sendInstructions([cuLimitIx(1_400_000), { programAddress: ix.programAddress, accounts: acc, data: ix.data as Uint8Array }])
    );
  }

  /** fund — escrow into vault + confirm subscription terms + auto-sign intent. */
  async fund(
    client: ISolanaProviderAdapter,
    jobId: bigint,
    p: { amount: bigint; terms: SubscriptionTerms; providerAddress: Address }
  ): Promise<string> {
    const buyer = client.getSigner();
    const jobPda = await mh.jobPda(this.acp, buyer.address, jobId);
    const paymentToken = await this.paymentToken();
    const vaultAuthority = await mh.vaultAuthorityPda(this.acp, jobPda);
    const vaultAta = await deriveAta(vaultAuthority, paymentToken);
    const clientAta = await deriveAta(buyer.address, paymentToken);
    const providerAta = await deriveAta(p.providerAddress, paymentToken);
    const fundHookState = await mh.hookStatePda(this.fundHook);
    const friid = await this.read(fetchFundRequestIntentId, await mh.fundRequestIntentIdPda(this.fundHook, jobId));
    const setBudgetIntent = await mh.intentPda(this.fundHook, friid.data.intentId);

    const subParams = mh.encodeSubParams(p.terms.durationSecs, p.terms.packageId);
    const fundConfirm = mh.encodeFundConfirmation(paymentToken, p.amount, p.providerAddress);
    const header = mh.encodeMultiHookHeader([
      { accountCount: 3, params: subParams },
      { accountCount: 7, params: fundConfirm },
    ]);
    const ix = getFundInstruction({
      client: buyer,
      job: jobPda,
      clientTokenAccount: clientAta,
      vault: vaultAta,
      vaultAuthority,
      mint: paymentToken,
      hookProgram: this.router,
      hookWhitelist: await this.wl(this.router),
      hookDelegate: fundHookState,
      delegateWhitelist: await this.wl(this.fundHook),
      expectedBudget: p.amount,
      optParams: header,
    });
    const acc = [
      ...ix.accounts,
      ...(await this.routerPrefix(jobId)),
      ro(this.sub), ro(await this.wl(this.sub)), w(await mh.hookStatePda(this.sub)), ro(SYSVAR_IX), ro(await mh.proposedTermsPda(this.sub, jobId)),
      ro(this.fundHook), ro(await this.wl(this.fundHook)), w(fundHookState), ro(SYSVAR_IX),
      ro(await mh.fundRequestIntentIdPda(this.fundHook, jobId)), w(setBudgetIntent), w(clientAta), w(providerAta), ro(TOKEN_PROGRAM),
    ];
    return this.one(
      await client.sendInstructions([
        cuLimitIx(1_400_000),
        createAtaIdempotentIx(buyer.address, clientAta, buyer.address, paymentToken),
        createAtaIdempotentIx(buyer.address, vaultAta, vaultAuthority, paymentToken),
        createAtaIdempotentIx(buyer.address, providerAta, p.providerAddress, paymentToken),
        { programAddress: ix.programAddress, accounts: acc, data: ix.data as Uint8Array },
      ])
    );
  }

  /** submit — provider posts an escrow bond (fund-hook only). */
  async submit(
    provider: ISolanaProviderAdapter,
    jobId: bigint,
    p: { deliverable: string; clientAddress: Address }
  ): Promise<string> {
    const seller = provider.getSigner();
    const jobPda = await mh.jobPda(this.acp, p.clientAddress, jobId);
    const paymentToken = await this.paymentToken();
    const acpState = await this.read(fetchAcpState, await mh.acpStatePda(this.acp));
    const vaultAuthority = await mh.vaultAuthorityPda(this.acp, jobPda);
    const vaultAta = await deriveAta(vaultAuthority, paymentToken);
    const providerAta = await deriveAta(seller.address, paymentToken);
    const treasuryAta = await deriveAta(acpState.data.platformTreasury, paymentToken);
    const fundHookState = await mh.hookStatePda(this.fundHook);
    const counter = (await this.read(fetchHookState, fundHookState)).data.intentCounter;
    const submitIntent = await mh.intentPda(this.fundHook, counter + 1n);
    const escrowAuth = await mh.escrowAuthorityPda(this.fundHook, jobId);
    const escrowVault = await deriveAta(escrowAuth, paymentToken);

    const header = mh.encodeMultiHookHeader([{ accountCount: 11, params: new Uint8Array(0) }]);
    const deliverable = fixed32(p.deliverable);
    const ix = await getSubmitInstructionAsync({
      provider: seller,
      job: jobPda,
      vault: vaultAta,
      vaultAuthority,
      providerTokenAccount: providerAta,
      treasuryTokenAccount: treasuryAta,
      platformTreasury: acpState.data.platformTreasury,
      hookProgram: this.router,
      hookWhitelist: await this.wl(this.router),
      hookDelegate: fundHookState,
      providerHookTokenAccount: providerAta,
      delegateWhitelist: await this.wl(this.fundHook),
      deliverable,
      optParams: header,
      completeOptParams: new Uint8Array(0),
    });
    const acc = [
      ...ix.accounts,
      ...(await this.routerPrefix(jobId)),
      ro(this.fundHook), ro(await this.wl(this.fundHook)), w(fundHookState), ro(SYSVAR_IX),
      ws(seller.address), w(submitIntent), w(await mh.providerEscrowIntentIdPda(this.fundHook, jobId)), w(providerAta),
      w(escrowVault), ro(escrowAuth), ro(TOKEN_PROGRAM), ro(SYSTEM), ro(jobPda),
    ];
    return this.one(
      await provider.sendInstructions([
        cuLimitIx(1_400_000),
        createAtaIdempotentIx(seller.address, escrowVault, escrowAuth, paymentToken),
        createAtaIdempotentIx(seller.address, treasuryAta, acpState.data.platformTreasury, paymentToken),
        { programAddress: ix.programAddress, accounts: acc, data: ix.data as Uint8Array },
      ])
    );
  }

  /**
   * complete — release escrow + fee split + activate subscription. Signed by
   * BOTH evaluator (fee payer) and provider (rent recipient), sent via an ALT
   * because the account set exceeds the legacy size limit.
   */
  async complete(
    evaluator: ISolanaProviderAdapter,
    providerSigner: SolanaSigner,
    jobId: bigint,
    p: { terms: SubscriptionTerms; clientAddress: Address; reason?: string }
  ): Promise<string> {
    const evalSigner = evaluator.getSigner();
    const jobPda = await mh.jobPda(this.acp, p.clientAddress, jobId);
    const paymentToken = await this.paymentToken();
    const acpState = await this.read(fetchAcpState, await mh.acpStatePda(this.acp));
    const vaultAuthority = await mh.vaultAuthorityPda(this.acp, jobPda);
    const vaultAta = await deriveAta(vaultAuthority, paymentToken);
    const providerAta = await deriveAta(providerSigner.address, paymentToken);
    const evaluatorAta = await deriveAta(evalSigner.address, paymentToken);
    const treasuryAta = await deriveAta(acpState.data.platformTreasury, paymentToken);
    const clientAta = await deriveAta(p.clientAddress, paymentToken);
    const fundHookState = await mh.hookStatePda(this.fundHook);
    const peid = await this.read(fetchProviderEscrowIntentId, await mh.providerEscrowIntentIdPda(this.fundHook, jobId));
    const submitIntent = await mh.intentPda(this.fundHook, peid.data.intentId);
    const escrowAuth = await mh.escrowAuthorityPda(this.fundHook, jobId);
    const escrowVault = await deriveAta(escrowAuth, paymentToken);
    const subExpiry = await mh.subExpiryPda(this.subState, p.clientAddress, providerSigner.address, p.terms.packageId);

    const header = mh.encodeMultiHookHeader([
      { accountCount: 9, params: new Uint8Array(0) },
      { accountCount: 8, params: new Uint8Array(0) },
    ]);
    const ix = await getCompleteInstructionAsync({
      evaluator: evalSigner,
      job: jobPda,
      vault: vaultAta,
      vaultAuthority,
      providerTokenAccount: providerAta,
      treasuryTokenAccount: treasuryAta,
      evaluatorTokenAccount: evaluatorAta,
      platformTreasury: acpState.data.platformTreasury,
      hookProgram: this.router,
      hookWhitelist: await this.wl(this.router),
      reason: fixed32(p.reason ?? "approved"),
      optParams: header,
    });
    const completeInstruction: SolanaInstructionLike = {
      programAddress: ix.programAddress,
      accounts: [
        ...ix.accounts,
        ...(await this.routerPrefix(jobId)),
        ro(this.sub), ro(await this.wl(this.sub)), w(await mh.hookStatePda(this.sub)), ro(SYSVAR_IX), w(await mh.proposedTermsPda(this.sub, jobId)),
        ws(providerSigner.address), ro(jobPda), ro(this.subState), ro(await mh.writerRegistryPda(this.subState, this.sub)), w(subExpiry), ro(SYSTEM),
        ro(this.fundHook), ro(await this.wl(this.fundHook)), w(fundHookState), ro(SYSVAR_IX),
        ro(await mh.providerEscrowIntentIdPda(this.fundHook, jobId)), w(submitIntent), w(escrowVault), w(clientAta), ro(escrowAuth), ro(TOKEN_PROGRAM),
      ],
      data: ix.data as Uint8Array,
    };
    const signerSet = new Set<string>([evalSigner.address, providerSigner.address]);
    const lutAddrs = [...new Set(completeInstruction.accounts.map((a) => a.address as string))].filter(
      (a) => !signerSet.has(a)
    ) as Address[];
    // Use the ACTUAL on-chain table ordering for compression, not the local
    // `lutAddrs` array. If a concurrent same-slot `complete` shared this table
    // (the address is derived from [authority, slot] by the ALT program, which
    // we cannot nonce), its `extend` appends ahead/behind ours, so the local
    // array's positions no longer match the on-chain indices. Compressing
    // against the real table makes our accounts resolve correctly regardless of
    // who else extended it.
    const { lut, addresses: tableAddrs } = await this.createLut(evaluator, lutAddrs);
    return this.sendMulti(evalSigner, [evalSigner, providerSigner], [
      cuLimitIx(1_400_000),
      createAtaIdempotentIx(evalSigner.address, evaluatorAta, evalSigner.address, paymentToken),
      completeInstruction,
    ], { [lut]: tableAddrs });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private wl(hook: Address) {
    return mh.hookWhitelistPda(this.acp, hook);
  }
  private async paymentToken(): Promise<Address> {
    return (await this.read(fetchAcpState, await mh.acpStatePda(this.acp))).data.paymentToken;
  }
  private async routerPrefix(jobId: bigint) {
    return [ro(await mh.hookRouterPda(this.router, jobId)), ro(await mh.routerStatePda(this.router)), ro(SYSVAR_IX)];
  }
  private one(r: string | string[]): string {
    return Array.isArray(r) ? r[0]! : r;
  }

  /**
   * Centralized account read. Every generated fetcher defaults to the JSON-RPC
   * default commitment (`finalized`) when no config is passed; routing all reads
   * through here injects {@link ACP_COMMITMENT} ("confirmed") in one place so the
   * read commitment provably matches the write commitment and cannot regress at
   * a new call site.
   */
  private read<T>(
    fetch: (rpc: Rpc, address: Address, config?: FetchAccountConfig) => Promise<T>,
    address: Address
  ): Promise<T> {
    return fetch(this.rpc, address, { commitment: ACP_COMMITMENT });
  }

  private async createLut(
    actor: ISolanaProviderAdapter,
    addresses: Address[]
  ): Promise<{ lut: Address; addresses: Address[] }> {
    const me = actor.getSigner().address;
    const recentSlot = await this.rpc.getSlot({ commitment: "finalized" }).send();
    const [lut, bump] = await getProgramDerivedAddress({
      programAddress: ALT_PROGRAM,
      seeds: [ae.encode(me), u64.encode(recentSlot)],
    });
    const accts = [w(lut), rs(me), ws(me), ro(SYSTEM)];
    const create = new Uint8Array(13);
    const dv = new DataView(create.buffer);
    dv.setUint32(0, 0, true);
    dv.setBigUint64(4, recentSlot, true);
    create[12] = bump;
    await actor.sendInstructions([{ programAddress: ALT_PROGRAM, accounts: accts, data: create }]);
    for (let i = 0; i < addresses.length; i += 20) {
      const chunk = addresses.slice(i, i + 20);
      const ext = new Uint8Array(12 + chunk.length * 32);
      const edv = new DataView(ext.buffer);
      edv.setUint32(0, 2, true);
      edv.setBigUint64(4, BigInt(chunk.length), true);
      chunk.forEach((a, j) => ext.set(ae.encode(a), 12 + j * 32));
      await actor.sendInstructions([{ programAddress: ALT_PROGRAM, accounts: accts, data: ext }]);
    }
    await new Promise((r) => setTimeout(r, 2000));
    // Read back the authoritative on-chain ordering so the caller compresses
    // against real indices (finding L-01).
    return { lut, addresses: await this.fetchLutAddresses(lut) };
  }

  /** Decode the ordered address list stored in an on-chain Address Lookup Table. */
  private async fetchLutAddresses(lut: Address): Promise<Address[]> {
    const info = await this.rpc
      .getAccountInfo(lut, { encoding: "base64", commitment: ACP_COMMITMENT })
      .send();
    const b64 = info.value?.data?.[0];
    if (!b64) throw new Error(`lookup table not found: ${lut}`);
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out: Address[] = [];
    for (let off = LUT_META_SIZE; off + 32 <= data.length; off += 32) {
      out.push(ad.decode(data.subarray(off, off + 32)));
    }
    return out;
  }

  private async sendMulti(
    feePayer: SolanaSigner,
    signers: SolanaSigner[],
    instructions: SolanaInstructionLike[],
    lookupTables: Record<string, Address[]>
  ): Promise<string> {
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();
    let message: any = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions as never, m),
      (m) => addSignersToTransactionMessage(signers as never, m)
    );
    message = compressTransactionMessageUsingAddressLookupTables(message, lookupTables as never);
    const signed = await signTransactionMessageWithSigners(message);
    const sig = await this.rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" })
      .send();
    for (let i = 0; i < 40; i++) {
      const { value } = await this.rpc.getSignatureStatuses([sig as Signature]).send();
      const s = value[0];
      if (s) {
        if (s.err) throw new Error(`complete failed: ${JSON.stringify(s.err)}`);
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return sig;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`complete confirm timeout: ${sig}`);
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function cuLimitIx(units: number): SolanaInstructionLike {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data };
}
async function deriveAta(owner: Address, mint: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [ae.encode(owner), ae.encode(TOKEN_PROGRAM), ae.encode(mint)],
  });
  return a;
}
function createAtaIdempotentIx(payer: Address, ata: Address, owner: Address, mint: Address): SolanaInstructionLike {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [ws(payer), w(ata), ro(owner), ro(mint), ro(SYSTEM), ro(TOKEN_PROGRAM)],
    data: new Uint8Array([1]),
  };
}
function fixed32(s: string): Uint8Array {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s).slice(0, 32));
  return b;
}
