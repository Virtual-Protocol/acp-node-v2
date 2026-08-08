import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  computePercentageFee,
  readFeeBasis,
  parseSettlementDeliverable,
  type AcpAgentOffering,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";
import {
  DEFAULT_FEE_RATE,
  FEE_UNIT,
  buildTransferOffering,
  exampleTransferRequirement,
  parseTransferRequirement,
  type TransferRequirement,
} from "./jobTypes.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Off-escrow proportional-fee buyer.
//
//   1. buildTransferOffering()   → local percentage offering (requiredFunds:false)
//   2. createJobFromOffering()   → plain job (hook=0); the requirement carries
//                                  the signed intent + fee notional
//   3. budget.set                → recompute the fee from the notional and the
//                                  offering rate; fund only if it matches the
//                                  seller's proposed budget (buyer sees the
//                                  exact fee before paying)
//   4. job.submitted             → verify the settlement proof, then complete()
//   5. job.completed             → transcript, buyer.stop()
//
// The transferred value never enters ACP escrow; ACP escrows only the fee. In
// this stub the principal does not actually move; see the folder README.
//
// Required env: BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY,
//   SELLER_WALLET_ADDRESS. Optional: OFF_ESCROW_FEE_RATE (default 8).
// ---------------------------------------------------------------------------

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const shortAddr = (a: string): string =>
  !a || !a.startsWith("0x") || a.length < 12
    ? a
    : `${a.slice(0, 6)}…${a.slice(-4)}`;

const log = {
  info: (m: string) => console.log(`[buyer-offesc] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[buyer-offesc] [job ${id}] ${m}`),
  warn: (m: string) => console.warn(`[buyer-offesc] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer-offesc] [error] ${m}`, e ?? ""),
};

/** Recover the transfer requirement from the job's own requirement message. */
function extractTransferRequirement(
  session: JobSession
): TransferRequirement | null {
  for (const e of session.entries) {
    if (e.kind === "message" && e.contentType === "requirement") {
      try {
        return parseTransferRequirement(JSON.parse(e.content));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Fee the buyer expects for a job, from that job's declared notional. */
function expectedFeeFor(
  offering: AcpAgentOffering,
  req: TransferRequirement
): bigint {
  return computePercentageFee(
    readFeeBasis(offering, { ...req }),
    offering.priceValue,
    FEE_UNIT
  );
}

async function main(): Promise<void> {
  const feeRate = Number(process.env.OFF_ESCROW_FEE_RATE ?? DEFAULT_FEE_RATE);
  const offering = buildTransferOffering(feeRate);
  const requirement: TransferRequirement = { ...exampleTransferRequirement };
  const requirementData: Record<string, unknown> = { ...requirement };

  const buyer = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("BUYER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("BUYER_WALLET_ID"),
      signerPrivateKey: requireEnv("BUYER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  const buyerAddress = await buyer.getAddress();
  const buyerAddressLower = buyerAddress.toLowerCase();
  log.info(`address: ${buyerAddress}`);
  log.info(
    `fee rate ${feeRate} ${FEE_UNIT}; expected fee ` +
      `${expectedFeeFor(offering, requirement)} atomic on notional ` +
      `${requirement.notionalAtomic}`
  );

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind !== "system") return;

    switch (entry.event.type) {
      case "budget.set": {
        try {
          await session.fetchJob();
          // Recompute the fee from THIS job's requirement, not a value cached
          // for another job.
          const req = extractTransferRequirement(session);
          if (!req) {
            log.job(session.jobId, "no transfer requirement in job — rejecting");
            await session.reject("Could not recover the transfer requirement");
            return;
          }
          const expectedFee = expectedFeeFor(offering, req);
          const proposed = session.job?.budget.rawAmount;
          log.job(
            session.jobId,
            `seller proposed budget ${proposed} atomic; expected fee ${expectedFee}`
          );
          // Fund only when the proposed fee equals the fee derived from the
          // notional and the offering rate.
          if (proposed !== expectedFee) {
            log.job(session.jobId, "budget != expected fee — rejecting");
            await session.reject(
              `Proposed budget ${proposed} != expected fee ${expectedFee}`
            );
            return;
          }
          await session.fund();
          log.job(session.jobId, `funded the fee (${expectedFee} atomic)`);
        } catch (err) {
          log.error(`funding failed on job ${session.jobId}`, err);
        }
        break;
      }

      case "job.submitted": {
        // The destination chain comes from THIS job's requirement, not a cached
        // constant.
        const req = extractTransferRequirement(session);
        if (!req) {
          log.job(session.jobId, "no transfer requirement in job — rejecting");
          try {
            await session.reject("Could not recover the transfer requirement");
          } catch (err) {
            log.error(`reject failed on job ${session.jobId}`, err);
          }
          return;
        }
        const expectedDestChainId = req.toChainId;
        const proof = parseSettlementDeliverable(entry.event.deliverable);
        if (!proof) {
          log.job(session.jobId, "deliverable is not a settlement proof — rejecting");
          try {
            await session.reject("Deliverable is not a valid settlement proof");
          } catch (err) {
            log.error(`reject failed on job ${session.jobId}`, err);
          }
          return;
        }
        // The settlement must be on the transfer's destination chain. A
        // well-formed proof mined on any other chain does not settle this job.
        if (proof.chainId !== expectedDestChainId) {
          log.job(
            session.jobId,
            `settlement on chain ${proof.chainId}, expected destination ${expectedDestChainId} — rejecting`
          );
          try {
            await session.reject(
              `Settlement proof chain ${proof.chainId} != expected destination ${expectedDestChainId}`
            );
          } catch (err) {
            log.error(`reject failed on job ${session.jobId}`, err);
          }
          return;
        }
        // A production evaluator confirms proof.settlementTxHash exists on
        // proof.chainId (via RPC / explorer) and moved the expected notional to
        // the recipient. This example only checks the proof's shape and
        // destination chain, so completing here does not prove the transfer
        // happened. This is why the job needs an evaluator: this buyer
        // self-evaluates via evaluatorAddress, and under skip-evaluation the
        // fee would auto-release on submit with no settlement check.
        log.job(
          session.jobId,
          `settlement proof: ${proof.settlementTxHash} on chain ${proof.chainId}`
        );
        try {
          await session.complete("Settlement verified");
        } catch (err) {
          log.error(`completion failed on job ${session.jobId}`, err);
        }
        break;
      }

      case "job.completed":
        log.job(session.jobId, "completed");
        log.info("---- transcript ----");
        console.log(await session.toContext());
        log.info("---- end transcript ----");
        await buyer.stop();
        break;

      case "job.rejected":
        log.job(
          session.jobId,
          `rejected by ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
        );
        await buyer.stop();
        break;

      case "job.expired":
        log.job(session.jobId, "expired");
        await buyer.stop();
        break;
    }
  });

  await buyer.start();
  log.info("ready");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    await buyer.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const sellerWallet = requireEnv("SELLER_WALLET_ADDRESS");
  log.info(`creating transfer job with seller ${shortAddr(sellerWallet)}`);
  log.info(`requirement: ${JSON.stringify(requirementData)}`);

  try {
    const jobId = await buyer.createJobFromOffering(
      chain.id,
      offering,
      sellerWallet,
      requirementData,
      { evaluatorAddress: buyerAddress }
    );
    log.job(jobId.toString(), "created — waiting for seller to set the fee");
  } catch (err) {
    log.error("createJobFromOffering failed", err);
    await buyer.stop();
  }
}

main().catch(console.error);
