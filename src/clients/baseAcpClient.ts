import type {
  ApproveAllowanceParams,
  CapabilityFlags,
  CompleteParams,
  CreateJobParams,
  FundParams,
  OnChainJob,
  OperationResult,
  PreparedTxInput,
  RejectParams,
  SetBudgetParams,
  SubmitParams,
} from "../core/operations";
import type { JobCreatedFilter } from "../utils/events";

export enum JobStatus {
  OPEN = 0,
  FUNDED = 1,
  SUBMITTED = 2,
  COMPLETED = 3,
  REJECTED = 4,
  EXPIRED = 5,
}

export abstract class BaseAcpClient<TTx> {
  protected readonly contractAddresses: Record<number, string>;

  constructor(contractAddresses: Record<number, string>) {
    this.contractAddresses = contractAddresses;
  }

  getContractAddress(chainId: number): string {
    const addr = this.contractAddresses[chainId];
    if (!addr)
      throw new Error(`No contract address configured for chainId ${chainId}`);
    return addr;
  }

  getContractAddresses(): Record<number, string> {
    return this.contractAddresses;
  }

  getSupportedChainIds(): number[] {
    return Object.keys(this.contractAddresses).map(Number);
  }

  abstract getAddress(): Promise<string>;

  abstract getCapabilities(): CapabilityFlags;

  abstract createJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<OperationResult<TTx>>;

  abstract setBudget(
    chainId: number,
    params: SetBudgetParams
  ): Promise<OperationResult<TTx>>;

  abstract approveAllowance(
    chainId: number,
    params: ApproveAllowanceParams
  ): Promise<OperationResult<TTx>>;

  abstract fund(
    chainId: number,
    params: FundParams
  ): Promise<OperationResult<TTx>>;

  abstract submit(
    chainId: number,
    params: SubmitParams
  ): Promise<OperationResult<TTx>>;

  abstract complete(
    chainId: number,
    params: CompleteParams
  ): Promise<OperationResult<TTx>>;

  abstract reject(
    chainId: number,
    params: RejectParams
  ): Promise<OperationResult<TTx>>;

  abstract submitPrepared(
    chainId: number,
    prepared: PreparedTxInput
  ): Promise<string | string[]>;

  abstract getJobIdFromTxHash(
    chainId: number,
    txHash: string,
    filter?: JobCreatedFilter
  ): Promise<bigint | null>;

  abstract getJob(chainId: number, jobId: bigint): Promise<OnChainJob | null>;

  abstract getTokenDecimals(
    chainId: number,
    tokenAddress: string
  ): Promise<number>;
}
