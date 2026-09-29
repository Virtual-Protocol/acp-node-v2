/**
 * Kit RPC transport for the ACP server's authenticated Solana RPC proxy.
 *
 * A non-2xx response is only handed to Kit when it is a JSON-RPC error, which
 * Kit decodes itself. Anything else (a server error envelope, plain text) is
 * thrown here with its status and message: Kit would read the envelope's
 * `error` string as a malformed JSON-RPC error and drop the message.
 */
export function createProxyRpcTransport(
  proxyUrl: string,
  getToken: () => Promise<string>,
) {
  return async (config: { payload: unknown }): Promise<any> => {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getToken()}`,
      },
      body: JSON.stringify(config.payload),
    });
    if (res.ok) return await res.json();

    const text = await res.text().catch(() => "");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (isJsonRpcError(body)) return body;

    const method = (config.payload as { method?: unknown } | null)?.method;
    const detail = serverMessage(body) ?? (text.slice(0, 300) || res.statusText);
    const err = new Error(
      `RPC proxy ${typeof method === "string" ? method : "request"} failed (HTTP ${res.status}): ${detail}`,
    ) as Error & { cause?: unknown; status?: number };
    err.cause = body ?? text;
    err.status = res.status;
    throw err;
  };
}

function isJsonRpcError(body: unknown): boolean {
  const error = (body as { error?: unknown } | null)?.error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function serverMessage(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(String).join("; ");
  return null;
}
