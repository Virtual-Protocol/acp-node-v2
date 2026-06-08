import type { TypedDataDefinition } from "viem";

export const AGENT_AUTH_DOMAIN_NAME = "ACP";
export const AGENT_AUTH_DOMAIN_VERSION = "1";
export const AGENT_AUTH_PRIMARY_TYPE = "AgentAuth" as const;

export const AGENT_AUTH_TYPES = {
  AgentAuth: [
    { name: "wallet", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export function buildAgentAuthTypedData(params: {
  wallet: string;
  chainId: number;
  issuedAt: number;
}): TypedDataDefinition {
  return {
    domain: {
      name: AGENT_AUTH_DOMAIN_NAME,
      version: AGENT_AUTH_DOMAIN_VERSION,
      chainId: params.chainId,
    },
    types: AGENT_AUTH_TYPES,
    primaryType: AGENT_AUTH_PRIMARY_TYPE,
    message: {
      wallet: params.wallet,
      chainId: BigInt(params.chainId),
      issuedAt: BigInt(params.issuedAt),
    },
  };
}
