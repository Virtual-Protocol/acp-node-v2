import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceFundPolicy,
  FundPolicyDeniedError,
} from "../dist/core/fundPolicy.js";

const context = {
  action: "fund",
  job: {},
  chainId: 8453,
  jobId: 17n,
  providerAddress: "0x1111111111111111111111111111111111111111",
  clientAddress: "0x2222222222222222222222222222222222222222",
  amount: {},
};

test("allows only an explicit allow decision", async () => {
  let received;
  await enforceFundPolicy(async value => {
    received = value;
    return { allow: true, evidence: { source: "policy" } };
  }, context);

  assert.equal(received, context);
});

test("throws a typed error for an explicit denial", async () => {
  const decision = { allow: false, reason: "counterparty rejected" };

  await assert.rejects(
    enforceFundPolicy(async () => decision, context),
    error => {
      assert.ok(error instanceof FundPolicyDeniedError);
      assert.equal(error.message, decision.reason);
      assert.equal(error.decision, decision);
      return true;
    },
  );
});

test("fails closed when a policy returns no decision", async () => {
  await assert.rejects(
    enforceFundPolicy(async () => undefined, context),
    /Funding policy returned no decision/,
  );
});

test("propagates policy failures and preserves opt-in compatibility", async () => {
  const failure = new Error("policy unavailable");
  await assert.rejects(
    enforceFundPolicy(async () => { throw failure; }, context),
    error => error === failure,
  );
  await enforceFundPolicy(undefined, context);
});
