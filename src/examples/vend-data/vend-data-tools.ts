/**
 * vend-data offering tools for a Virtuals ACP seller agent.
 *
 * Adds five paid web-data tools (check-link, extract, web-search, geoip,
 * domain-info) that a seller agent can expose to satisfy ACP jobs. Each tool
 * calls a live Vend x402 endpoint: no API key, no signup, pay-per-call,
 * settled in Nano (XNO) in ~1s.
 *
 * Use these tools anywhere a buyer's requirement needs current web data:
 *   - check-link  -> is a URL live? status, time, redirect chain
 *   - extract     -> clean text/markdown from a page
 *   - web-search  -> current search results with snippets
 *   - geoip       -> where an IP is hosted
 *   - domain-info -> DNS / WHOIS / SSL / headers for a domain
 *
 * The caller is billed per successful call (x402 v2). Each response includes
 * `price_xno` so the agent can budget exactly before paying.
 *
 * Docs + full endpoint table: https://extract.paypercall.dev/ (llms.txt)
 */
import type { AcpTool } from "@virtuals-protocol/acp-node-v2";

// Live endpoint bases. Call unpaid -> HTTP 402 with a Nano x402-v2 challenge;
// settle with a Nano send block, retry with the block hash header, get data.
const ENDPOINTS = {
  extract: "https://extract.paypercall.dev/api/v1/extract?url=",
  "check-link": "https://check.paypercall.dev/api/v1/check-link?url=",
  "web-search": "https://search.paypercall.dev/api/v1/web-search?q=",
  geoip: "https://geoip.paypercall.dev/api/v1/geoip?ip=",
  "domain-info": "https://domain.paypercall.dev/api/v1/domain-info?domain=",
} as const;

type ToolName = keyof typeof ENDPOINTS;

function vendTool(name: ToolName, description: string): AcpTool {
  const urlParam =
    name === "geoip" || name === "domain-info" ? "target" : "query";
  const urlHint =
    name === "geoip"
      ? "IPv4/IPv6 address"
      : name === "domain-info"
        ? "domain name (e.g. example.com)"
        : name === "web-search"
          ? "search query (keywords or a natural-language question)"
          : "URL to fetch";
  return {
    name: `vend_${name}`,
    description,
    parameters: [
      {
        name: urlParam,
        type: "string",
        description: urlHint,
        required: true,
      },
    ],
  };
}

/** The five Vend data tools, ready to add to an AcpAgent/session tool set. */
export function vendDataTools(): AcpTool[] {
  return [
    vendTool(
      "check-link",
      "Check whether a URL is live: HTTP status, response time, redirect chain."
    ),
    vendTool(
      "extract",
      "Extract clean text/markdown from a web page by URL."
    ),
    vendTool(
      "web-search",
      "Current web search results with snippets for a query."
    ),
    vendTool(
      "geoip",
      "IP geolocation: country, city, ISP, ASN, coordinates."
    ),
    vendTool(
      "domain-info",
      "DNS records, WHOIS, SSL/TLS, and HTTP headers for a domain."
    ),
  ];
}

/**
 * Call a Vend endpoint and return its JSON.
 *
 * Example -- settle a paid call with the block hash returned by your Nano
 * wallet, then retry with `X-PAYMENT: <block-hash>`:
 *
 *   let resp = await fetch(endpoint);
 *   if (resp.status === 402) {
 *     const { accepts } = await resp.json();          // x402-v2 challenge
 *     const payTo = accepts[0].payTo;                 // Nano account
 *     const amount = accepts[0].amount;               // raw XNO
 *     // sign+broadcast a Nano send block for amount -> payTo, then:
 *     resp = await fetch(endpoint, { headers: { "X-PAYMENT": blockHash } });
 *   }
 *   return resp.json();                               // { ...data, price_xno }
 *
 * Prices: check-link/extract/web-search/geoip 0.0001 XNO, domain-info 0.0005 XNO.
 */
export async function vendFetch(
  name: ToolName,
  target: string,
  settle?: (challenge: { payTo: string; amount: string }) => Promise<string>
): Promise<Record<string, unknown>> {
  const url = ENDPOINTS[name] + encodeURIComponent(target);
  let resp = await fetch(url);
  if (resp.status === 402) {
    if (!settle) {
      throw new Error(
        `PAYMENT-REQUIRED: XNO x402-v2 challenge at ${name} (call settled by the calling agent).`
      );
    }
    const body = (await resp.json()) as {
      accepts: { scheme: string; network: string; asset: string; payTo: string; amount: string }[];
    };
    const challenge = body.accepts[0];
    if (challenge.scheme !== "exact" || challenge.asset !== "XNO") {
      throw new Error(`Unexpected payment rail: ${JSON.stringify(challenge)}`);
    }
    const blockHash = await settle(challenge);
    resp = await fetch(url, { headers: { "X-PAYMENT": blockHash } });
  }
  if (!resp.ok) throw new Error(`${name} failed: HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}
