const ENTRYPOINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
// keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
const USER_OPERATION_EVENT_TOPIC =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const DEFAULT_BASE_PRECONF_RPC = "https://mainnet-preconf.base.org";
const BASE_MAINNET_CHAIN_ID = 8453;
const POLL_MS = 200;

interface PendingTx {
  hash?: string;
  to?: string | null;
  input?: string;
}

export function preconfRpcFor(chainId: number): string | undefined {
  if (process.env.USE_PRECONF_RPC !== "1") return undefined;
  if (chainId !== BASE_MAINNET_CHAIN_ID) return undefined;
  return process.env.BASE_PRECONF_RPC?.trim() || DEFAULT_BASE_PRECONF_RPC;
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await res.json()) as { result?: T };
    return j.result;
  } catch {
    return undefined;
  }
}

export async function watchPreconfUserOp(
  url: string,
  sender: string,
  signal: AbortSignal,
): Promise<`0x${string}`> {
  const senderWord = sender.slice(2).toLowerCase();
  const senderTopic = `0x${senderWord.padStart(64, "0")}`;
  const checked = new Set<string>();

  while (!signal.aborted) {
    const block = await rpc<{ transactions?: PendingTx[] }>(
      url,
      "eth_getBlockByNumber",
      ["pending", true],
    );

    for (const tx of block?.transactions ?? []) {
      if (signal.aborted) break;
      if (!tx.hash || checked.has(tx.hash)) continue;
      if (tx.to?.toLowerCase() !== ENTRYPOINT_V07) continue;
      if (!tx.input?.toLowerCase().includes(senderWord)) continue;

      checked.add(tx.hash);

      const receipt = await rpc<{
        logs?: { address?: string; topics?: string[] }[];
      }>(url, "eth_getTransactionReceipt", [tx.hash]);

      const matched = receipt?.logs?.some(
        (l) =>
          l.address?.toLowerCase() === ENTRYPOINT_V07 &&
          l.topics?.[0] === USER_OPERATION_EVENT_TOPIC &&
          l.topics?.[2]?.toLowerCase() === senderTopic,
      );

      if (matched) {
        return tx.hash as `0x${string}`;
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return new Promise<never>(() => {});
}
