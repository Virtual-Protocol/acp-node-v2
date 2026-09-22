/**
 * Tests for the vend-data offering tools.
 *
 * - Shape: vendDataTools() returns five AcpTool-shaped definitions.
 * - Live 402: an unpaid call to a live endpoint returns HTTP 402 with the
 *   x402-v2 Nano challenge (proves the endpoint is reachable and priced).
 *
 * Run: npx tsx examples/vend-data-offering.test.ts
 */
import assert from "node:assert/strict";
import { vendDataTools, vendFetch } from "./vend-data-tools.js";
import type { AcpTool } from "@virtuals-protocol/acp-node-v2";

async function live402(name: string): Promise<void> {
  const target = name === "geoip" ? "8.8.8.8" : "https://example.com";
  const url =
    name === "geoip"
      ? "https://geoip.paypercall.dev/api/v1/geoip?ip=" + encodeURIComponent(target)
      : name === "domain-info"
        ? "https://domain.paypercall.dev/api/v1/domain-info?domain=example.com"
        : name === "web-search"
          ? "https://search.paypercall.dev/api/v1/web-search?q=nano"
          : `https://${
              name === "extract" ? "extract" : "check"
            }.paypercall.dev/api/v1/${name}?url=` + encodeURIComponent(target);

  const resp = await fetch(url);
  assert.equal(resp.status, 402, `${name} should require payment (HTTP 402)`);
  const body = (await resp.json()) as {
    accepts: { scheme: string; network: string; asset: string }[];
  };
  assert.equal(body.accepts[0].network, "nano:mainnet", `${name} settles on Nano`);
  assert.equal(body.accepts[0].asset, "XNO", `${name} asset is XNO`);
  console.log(`  ok  ${name} -> 402 nano:mainnet XNO`);
}

async function main(): Promise<void> {
  // 1. Shape
  const tools = vendDataTools();
  assert.equal(tools.length, 5);
  for (const t of tools) {
    const tool: AcpTool = t;
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.startsWith("vend_"));
    assert.ok(tool.description.length > 10);
    assert.equal(tool.parameters.length, 1);
    assert.equal(tool.parameters[0].required, true);
  }
  console.log("  ok  vendDataTools() -> 5 well-formed AcpTools");

  // 2. Live 402 challenge for each endpoint (read-only, unpaid)
  const names = ["check-link", "extract", "web-search", "geoip", "domain-info"] as const;
  for (const n of names) await live402(n);

  // 3. vendFetch without a settle callback correctly raises on 402
  await assert.rejects(
    () => vendFetch("geoip", "8.8.8.8"),
    /PAYMENT-REQUIRED/
  );
  console.log("  ok  vendFetch() raises PAYMENT-REQUIRED until settled");

  console.log("\nAll vend-data offering tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
