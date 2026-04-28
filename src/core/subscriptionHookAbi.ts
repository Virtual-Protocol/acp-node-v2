export const SUBSCRIPTION_HOOK_ABI = [
  {
    inputs: [
      { internalType: "address", name: "coreAddress", type: "address" },
      {
        internalType: "address",
        name: "subscriptionState_",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  { inputs: [], name: "OnlyACPContract", type: "error" },
  { inputs: [], name: "TermsMismatch", type: "error" },
  { inputs: [], name: "TermsNotProposed", type: "error" },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "uint256",
        name: "jobId",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "uint256",
        name: "packageId",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "address",
        name: "client",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "provider",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "duration",
        type: "uint256",
      },
    ],
    name: "SubscriptionActivated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "uint256",
        name: "jobId",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "uint256",
        name: "packageId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "duration",
        type: "uint256",
      },
    ],
    name: "SubscriptionTermsProposed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "uint256",
        name: "jobId",
        type: "uint256",
      },
      {
        indexed: true,
        internalType: "uint256",
        name: "packageId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "currentExpiry",
        type: "uint256",
      },
    ],
    name: "SubscriptionTermsSkipped",
    type: "event",
  },
  {
    inputs: [],
    name: "acpContract",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes4", name: "selector", type: "bytes4" },
      { internalType: "bytes", name: "data", type: "bytes" },
    ],
    name: "afterAction",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "jobId", type: "uint256" },
      { internalType: "bytes4", name: "selector", type: "bytes4" },
      { internalType: "bytes", name: "data", type: "bytes" },
    ],
    name: "beforeAction",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "getProposedTerms",
    outputs: [
      {
        components: [
          { internalType: "uint256", name: "duration", type: "uint256" },
          { internalType: "uint256", name: "packageId", type: "uint256" },
        ],
        internalType: "struct SubscriptionHook.SubscriptionTerms",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "client", type: "address" },
      { internalType: "address", name: "provider", type: "address" },
      { internalType: "uint256", name: "packageId", type: "uint256" },
    ],
    name: "getSubscriptionExpiry",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "jobId", type: "uint256" }],
    name: "proposedTerms",
    outputs: [
      { internalType: "uint256", name: "duration", type: "uint256" },
      { internalType: "uint256", name: "packageId", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "requiredSelectors",
    outputs: [{ internalType: "bytes4[]", name: "", type: "bytes4[]" }],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [],
    name: "subscriptionState",
    outputs: [
      {
        internalType: "contract SubscriptionState",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes4", name: "interfaceId", type: "bytes4" }],
    name: "supportsInterface",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
