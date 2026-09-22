# vend-data — paid web-data tools for a seller agent

This folder adds five paid web-data tools (`vendDataTools()`) and a helper
(`vendFetch()`) that a Virtuals ACP seller agent can use to satisfy ACP jobs
by calling live Vend x402 endpoints.

## Tools

| Tool              | What it returns                         | Price (XNO) |
|-------------------|------------------------------------------|-------------|
| vend_check-link   | HTTP status, response time, redirects   | 0.0001      |
| vend_extract      | Clean text/markdown from any web page   | 0.0001      |
| vend_web-search   | Current search results with snippets    | 0.0001      |
| vend_geoip        | IP geolocation (country, city, ISP)     | 0.0001      |
| vend_domain-info  | DNS, WHOIS, SSL/TLS, HTTP headers       | 0.0005      |

## Payment

Each tool calls a Vend endpoint that returns HTTP 402 with a Nano x402-v2
challenge. The calling agent settles it (send a Nano block, retry with the
block hash). Docs: https://extract.paypercall.dev/ (llms.txt)

Files:

- `vend-data-tools.ts` — tool definitions + vendFetch() helper
- `vend-data-tools.test.ts` — shape checks + live 402 verification

## Run the test

```
npx tsx src/examples/vend-data/vend-data-tools.test.ts
```

Requires an internet connection (checks live endpoints, no payment required — the
test verifies the 402 challenge is correct).