import {
  getStructDecoder,
  getU64Decoder,
  getI64Decoder,
  getAddressDecoder,
  type Address,
  type Decoder,
} from "@solana/kit";

export type JobCreated = {
  jobId: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  expiredAt: bigint;
  hook: Address;
};

export function getJobCreatedDecoder(): Decoder<JobCreated> {
  return getStructDecoder([
    ["jobId", getU64Decoder()],
    ["client", getAddressDecoder()],
    ["provider", getAddressDecoder()],
    ["evaluator", getAddressDecoder()],
    ["expiredAt", getI64Decoder()],
    ["hook", getAddressDecoder()],
  ]);
}
