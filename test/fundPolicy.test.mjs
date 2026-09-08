import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceFundPolicy,
  FundPolicyDeniedError,
} from "../dist/core/fundPolicy.js";
import { JobSession } from "../dist/jobSession.js";

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

test("fund uses the exact job snapshot approved by a slow policy", async () => {
  let releasePolicy;
  const policyPending = new Promise(resolve => {
    releasePolicy = resolve;
  });
  let policyStarted;
  const policyStartedPromise = new Promise(resolve => {
    policyStarted = resolve;
  });
  let approvedJob;
  let funded;
  const agent = {
    enforceFundPolicy: async job => {
      approvedJob = job;
      policyStarted();
      await policyPending;
    },
    internalFund: async (_chainId, input) => {
      funded = input;
    },
  };
  const makeJob = clientAddress => ({
    budget: { source: clientAddress },
    clientAddress,
    hookAddress: "0x0000000000000000000000000000000000000000",
    hookConfigs: null,
    getFundRequestIntent: () => null,
  });
  const approvedSnapshot = makeJob(
    "0x1111111111111111111111111111111111111111",
  );
  const refreshedSnapshot = makeJob(
    "0x2222222222222222222222222222222222222222",
  );
  const session = new JobSession(agent, [], "17", 8453, ["client"]);
  session._job = approvedSnapshot;

  const funding = session.fund();
  await policyStartedPromise;
  session._job = refreshedSnapshot;
  releasePolicy();
  await funding;

  assert.equal(approvedJob, approvedSnapshot);
  assert.equal(funded.clientAddress, approvedSnapshot.clientAddress);
  assert.equal(funded.amount, approvedSnapshot.budget);
});
