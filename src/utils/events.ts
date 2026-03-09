import { decodeEventLog, type Address, type TransactionReceipt } from "viem";
import { ACP_ABI } from "../core/acpAbi";

export type JobCreatedFilter = {
  provider?: string;
  evaluator?: string;
  expiredAt?: number | bigint;
  hook?: string;
};

type JobCreatedArgs = {
  jobId: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  expiredAt: bigint;
  hook: Address;
};

function addressEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function matchesFilter(
  args: JobCreatedArgs,
  filter: JobCreatedFilter
): boolean {
  if (filter.provider && !addressEq(args.provider, filter.provider))
    return false;
  if (filter.evaluator && !addressEq(args.evaluator, filter.evaluator))
    return false;
  if (filter.expiredAt != null && args.expiredAt !== BigInt(filter.expiredAt))
    return false;
  if (filter.hook && !addressEq(args.hook, filter.hook)) return false;
  return true;
}

/**
 * Extracts a `jobId` from a transaction receipt by decoding `JobCreated` event
 * logs emitted by the ACP contract.
 *
 * When multiple `JobCreated` events exist in a single receipt (batched calls),
 * pass a `filter` with the original `CreateJobParams` values to match the
 * correct event.
 */
export function parseJobIdFromReceipt(
  receipt: TransactionReceipt,
  contractAddress: Address,
  filter?: JobCreatedFilter
): bigint | null {
  for (const log of receipt.logs) {
    if (!addressEq(log.address, contractAddress)) continue;

    try {
      const decoded = decodeEventLog({
        abi: ACP_ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== "JobCreated") continue;

      const args = decoded.args as unknown as JobCreatedArgs;

      if (filter && !matchesFilter(args, filter)) continue;

      return args.jobId;
    } catch {
      // Log doesn't match any ABI event — skip
    }
  }

  return null;
}
