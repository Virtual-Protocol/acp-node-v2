import type { NetworkContext } from "../core/chains";
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
  protected readonly contractAddress: string;
  protected readonly networkContext: NetworkContext;

  constructor(contractAddress: string, networkContext: NetworkContext) {
    this.contractAddress = contractAddress;
    this.networkContext = networkContext;
  }

  getContractAddress(): string {
    return this.contractAddress;
  }

  getNetworkContext(): NetworkContext {
    return this.networkContext;
  }

  getChainFamily(): NetworkContext["family"] {
    return this.networkContext.family;
  }

  abstract getAddress(): Promise<string>;

  abstract getCapabilities(): CapabilityFlags;

  abstract createJob(params: CreateJobParams): Promise<OperationResult<TTx>>;

  abstract setBudget(params: SetBudgetParams): Promise<OperationResult<TTx>>;

  abstract approveAllowance(
    params: ApproveAllowanceParams
  ): Promise<OperationResult<TTx>>;

  abstract fund(params: FundParams): Promise<OperationResult<TTx>>;

  abstract submit(params: SubmitParams): Promise<OperationResult<TTx>>;

  abstract complete(params: CompleteParams): Promise<OperationResult<TTx>>;

  abstract reject(params: RejectParams): Promise<OperationResult<TTx>>;

  abstract submitPrepared(
    prepared: PreparedTxInput
  ): Promise<string | string[]>;

  abstract getJobIdFromTxHash(
    txHash: string,
    filter?: JobCreatedFilter
  ): Promise<bigint | null>;

  abstract getJob(jobId: bigint): Promise<OnChainJob | null>;

  abstract getTokenDecimals(tokenAddress: string): Promise<number>;
}
