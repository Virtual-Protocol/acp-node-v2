import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, zeroAddress } from 'viem';
import { AcpAgent, AcpApiClient, SseTransport, ACP_ABI, createEvmNetworkContext, getNoEvaluatorAddress, FUND_TRANSFER_HOOK_ADDRESSES } from '../dist/index.js';

const CHAIN = 8453;
const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const EVALUATOR = '0x4444444444444444444444444444444444444444';
const HASH = `0x${'5'.repeat(64)}`;
const HOST = 'https://acp.invalid';
const objectSchema = {
  type: 'object',
  required: ['url', 'count'],
  additionalProperties: false,
  properties: { url: { type: 'string', format: 'uri' }, count: { type: 'integer', minimum: 1 } },
};
const valid = { url: 'https://example.com/resource', count: 1 };

// Exercise the built public package, real client factory, EVM encoding, receipt
// parsing, API auth and requirement transport. Only the provider and fetch are
// sentinels. No wallet, listener, RPC endpoint or real signer is constructed.
async function setup(t, requirements = objectSchema, overrides = {}) {
  const offering = {
    name: 'Example', description: 'Example offering', deliverable: '', requirements,
    slaMinutes: 5, priceType: 'fixed', priceValue: 1,
    requiredFunds: false, isHidden: false, isPrivate: false, ...overrides,
  };
  const calls = { http: [], authSigns: [], typedSigns: 0, prepares: 0, sends: [], reads: 0, networkContexts: 0 };
  const fail = name => async () => { throw Error(`Unexpected provider operation: ${name}`); };
  const provider = {
    providerName: 'offline-sentinel',
    async getAddress() { return BUYER; },
    async getSupportedChainIds() { return [CHAIN]; },
    async getNetworkContext(chainId) { calls.networkContexts++; assert.equal(chainId, CHAIN); return createEvmNetworkContext(chainId); },
    sendTransaction: fail('sendTransaction'),
    async sendCalls(chainId, txs) {
      assert.equal(chainId, CHAIN);
      assert.equal(txs.length, 1);
      assert.equal(txs[0].to, CONTRACT);
      const decoded = decodeFunctionData({ abi: ACP_ABI, data: txs[0].data });
      calls.sends.push(decoded);
      assert.equal(decoded.functionName, 'createJob', 'no fund/submit/other transaction');
      return HASH;
    },
    async getTransactionReceipt(chainId, hash) {
      calls.reads++;
      assert.equal(chainId, CHAIN);
      assert.equal(hash, HASH);
      const [seller, evaluator, expiredAt, , hook] = calls.sends.at(-1).args;
      return { logs: [{
        address: CONTRACT,
        topics: encodeEventTopics({ abi: ACP_ABI, eventName: 'JobCreated', args: { jobId: 123n, client: BUYER, provider: seller } }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [evaluator, expiredAt, hook]),
      }] };
    },
    readContract: fail('readContract'), getLogs: fail('getLogs'), getBlockNumber: fail('getBlockNumber'),
    async signMessage(chainId, message) {
      assert.equal(chainId, CHAIN);
      assert.match(message, /^acp-auth:\d+$/);
      calls.authSigns.push(message);
      return 'OFFLINE_AUTH_SENTINEL';
    },
    async signTypedData() { calls.typedSigns++; throw Error('Unexpected typed signature'); },
  };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.http.push({ url, method, body: init.body });
    assert.ok(typeof url === 'string' && url.startsWith(`${HOST}/`), 'network escape');
    if (url === `${HOST}/auth/agent`) {
      assert.equal(method, 'POST');
      assert.equal(JSON.parse(init.body).signature, 'OFFLINE_AUTH_SENTINEL');
      return Response.json({ data: { token: `offline.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.sentinel` } });
    }
    assert.match(init.headers.Authorization, /^Bearer offline\./);
    if (url === `${HOST}/agents/wallet/${SELLER}`) {
      assert.equal(method, 'GET');
      return Response.json({ data: { walletAddress: SELLER, offerings: [offering] } });
    }
    assert.equal(url, `${HOST}/chats/${CHAIN}/123/message`);
    assert.equal(method, 'POST');
    assert.equal(calls.sends.length, 1, 'requirement follows creation');
    if (calls.loseFirstMessageReply && calls.http.filter(c => c.url.endsWith('/message')).length === 1) throw Error('offline lost message reply');
    return new Response(null, { status: 200 });
  });
  const agent = await AcpAgent.create({
    evmProvider: provider, contractAddresses: { [CHAIN]: CONTRACT },
    api: new AcpApiClient({ serverUrl: HOST }), transport: new SseTransport({ serverUrl: HOST }),
  });
  const client = agent.getClient(CHAIN);
  const create = client.createJob.bind(client);
  t.mock.method(client, 'createJob', (...args) => { calls.prepares++; return create(...args); });
  return { agent, offering, calls, startedAtSec: Math.floor(Date.now() / 1000) };
}

const entryPoints = {
  createJobFromOffering: (h, data, opts) => h.agent.createJobFromOffering(CHAIN, h.offering, SELLER, data, opts),
  createJobByOfferingName: (h, data, opts) => h.agent.createJobByOfferingName(CHAIN, h.offering.name, SELLER, data, opts),
};

function assertNoCreation(h, entry) {
  assert.equal(h.calls.prepares, 0, 'no job preparation');
  assert.deepEqual(h.calls.sends, [], 'no transaction dispatch');
  assert.equal(h.calls.reads, 0, 'no receipt read');
  assert.equal(h.calls.networkContexts, 0, 'no transaction network context');
  assert.equal(h.calls.typedSigns, 0, 'no state-changing signature');
  // By-name discovery authenticates before it knows the schema. Direct creation
  // rejects before authentication. Neither path posts a requirement message.
  assert.deepEqual(h.calls.http.map(({ url, method }) => [method, url]), entry === 'createJobByOfferingName'
    ? [['POST', `${HOST}/auth/agent`], ['GET', `${HOST}/agents/wallet/${SELLER}`]] : []);
  assert.equal(h.calls.authSigns.length, entry === 'createJobByOfferingName' ? 1 : 0);
}

function assertCreated(h, data, { evaluator = getNoEvaluatorAddress(CHAIN), hook = zeroAddress, packageId } = {}) {
  assert.equal(h.calls.prepares, 1);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.typedSigns, 0);
  const [seller, actualEvaluator, expiration, description, actualHook] = h.calls.sends[0].args;
  assert.equal(seller.toLowerCase(), SELLER);
  assert.equal(actualEvaluator.toLowerCase(), evaluator.toLowerCase());
  assert.equal(description, h.offering.name);
  assert.equal(actualHook.toLowerCase(), hook.toLowerCase());
  assert.ok(expiration >= BigInt(h.startedAtSec + 5 * 60 + 30));
  assert.ok(expiration <= BigInt(Math.floor(Date.now() / 1000) + 5 * 60 + 30));
  const messages = h.calls.http.filter(c => c.url.endsWith('/message'));
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0].body), { content: JSON.stringify(data), contentType: 'requirement', ...(packageId ? { packageId } : {}) });
  assert.deepEqual(h.calls.http.filter(c => c.method === 'POST' && !c.url.endsWith('/auth/agent')), messages);
}

const invalidObjects = [
  ['missing fields', {}], ['missing count', { url: valid.url }],
  ['extra field', { ...valid, extra: true }], ['malformed field', { ...valid, count: '1' }],
  ['below minimum', { ...valid, count: 0 }], ['invalid URI', { ...valid, url: 'not a uri' }],
  ['stringified object', JSON.stringify(valid)], ['null', null], ['string', 'hello'],
  ['number', 1], ['boolean', false], ['array', []], ['array of objects', [valid]], ['undefined', undefined],
];

for (const [entry, run] of Object.entries(entryPoints)) {
  for (const [name, data] of invalidObjects) test(`${entry}: rejects ${name} before creation`, async t => {
    const h = await setup(t);
    const original = structuredClone(data);
    await assert.rejects(run(h, data), /^Error: Requirement validation failed:/);
    assertNoCreation(h, entry);
    assert.deepEqual(data, original, 'input is not coerced or changed');
  });

  for (const [name, schema, data] of [
    ['object', objectSchema, valid], ['URI format', objectSchema, { ...valid, url: 'urn:example:resource' }],
    ['string', { type: 'string', minLength: 1 }, 'hello'],
    ['number', { type: 'number', minimum: 1 }, 2.5],
    ['boolean', { type: 'boolean' }, false], ['null', { type: 'null' }, null],
    ['array', { type: 'array', items: { type: 'integer' }, minItems: 1 }, [1, 2]],
    ['union scalar', { anyOf: [{ type: 'string' }, { type: 'null' }] }, 'value'],
    ['empty schema', {}, 42],
  ]) test(`${entry}: preserves schema-permitted ${name}`, async t => {
    const h = await setup(t, schema);
    const original = structuredClone(data);
    assert.equal(await run(h, data), 123n);
    assertCreated(h, data);
    assert.deepEqual(data, original);
  });

  for (const [name, schema, data] of [
    ['scalar constraint', { type: 'string', minLength: 5 }, 'a'],
    ['number constraint', { type: 'number', minimum: 1 }, 0],
    ['scalar type', { type: 'boolean' }, 'false'],
    ['array item', { type: 'array', items: { type: 'integer' } }, ['1']],
  ]) test(`${entry}: rejects invalid ${name}`, async t => {
    const h = await setup(t, schema);
    await assert.rejects(run(h, data), /Requirement validation failed:/);
    assertNoCreation(h, entry);
  });

  for (const data of ['text', {}]) test(`${entry}: invalid schema rejects ${typeof data} data before creation`, async t => {
    const h = await setup(t, { type: 'not-a-json-schema-type' });
    await assert.rejects(run(h, data), /schema is invalid/);
    assertNoCreation(h, entry);
  });

  for (const [name, requirements, data] of [
    ['legacy description', 'Describe the requested work', 'plain request'],
    ['legacy description with object', 'Describe the requested work', valid],
    ['string schema is not parsed', JSON.stringify(objectSchema), 'plain request'],
    ['empty description', '', 'plain request'], ['absent schema', undefined, valid], ['null schema', null, valid],
  ]) test(`${entry}: preserves ${name}`, async t => {
    const h = await setup(t, requirements);
    // setup's default is an object schema; explicitly retain an absent value.
    h.offering.requirements = requirements;
    assert.equal(await run(h, data), 123n);
    assertCreated(h, data);
  });

  test(`${entry}: invalid input cannot reach working-funds/subscription creation`, async t => {
    const h = await setup(t, objectSchema, { requiredFunds: true, subscriptions: [{ packageId: 7, name: 'Package', price: 1, duration: 60 }] });
    await assert.rejects(run(h, JSON.stringify(valid), { packageId: 7 }), /Requirement validation failed:/);
    assertNoCreation(h, entry);
  });

  test(`${entry}: valid request after rejection uses the same agent and unchanged options`, async t => {
    const h = await setup(t);
    await assert.rejects(run(h, 'invalid'), /Requirement validation failed:/);
    assertNoCreation(h, entry);
    assert.equal(await run(h, valid, { evaluatorAddress: EVALUATOR }), 123n);
    assertCreated(h, valid, { evaluator: EVALUATOR });
  });

  test(`${entry}: working-funds offering still selects its hook without funding`, async t => {
    const h = await setup(t, objectSchema, { requiredFunds: true });
    assert.equal(await run(h, valid), 123n);
    assertCreated(h, valid, { hook: FUND_TRANSFER_HOOK_ADDRESSES[CHAIN] });
  });
}

test('raw createJob remains independent of offering validation and sends no requirement', async t => {
  const h = await setup(t);
  assert.equal(await h.agent.createJob(CHAIN, { providerAddress: SELLER, evaluatorAddress: EVALUATOR, expiredAt: 1900000000, description: 'raw job' }), 123n);
  assert.equal(h.calls.prepares, 1);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.reads, 1);
  assert.deepEqual(h.calls.http, []);
  assert.deepEqual(h.calls.authSigns, []);
});

// The exact posted representation must remain valid, available before effects,
// and stable across a lost transport response. These are offline sentinels.
for (const [entry, invoke] of Object.entries(entryPoints)) {
  for (const [name, makeData] of [
    ['bigint', () => 1n],
    ['cyclic object', () => { const v = {}; v.self = v; return v; }],
    ['undefined', () => undefined],
    ['symbol', () => Symbol('unsupported')],
    ['function', () => () => 'unsupported'],
  ]) test(entry + ': unserializable ' + name + ' cannot create a job', async t => {
    const h = await setup(t, {});
    await assert.rejects(invoke(h, makeData()));
    assertNoCreation(h, entry);
  });

  test(entry + ': serialized payload must satisfy the same declared schema', async t => {
    const h = await setup(t, { ...objectSchema, additionalProperties: true });
    const data = { ...valid, toJSON() { return { url: 'not a uri', count: '1' }; } };
    await assert.rejects(invoke(h, data), /Requirement validation failed:/);
    assertNoCreation(h, entry);
  });

  test(entry + ': one serialization is retained across a lost message response', async t => {
    const h = await setup(t, { ...objectSchema, additionalProperties: true });
    h.calls.loseFirstMessageReply = true;
    let serializations = 0;
    const data = { ...valid, toJSON() { serializations++; return { ...valid, count: serializations }; } };
    assert.equal(await invoke(h, data), 123n);
    assert.equal(serializations, 1);
    assert.equal(h.calls.sends.length, 1);
    const messages = h.calls.http.filter(c => c.url.endsWith('/message'));
    assert.equal(messages.length, 2);
    assert.equal(messages[0].body, messages[1].body);
    assert.deepEqual(JSON.parse(messages[0].body), { content: JSON.stringify(valid), contentType: 'requirement' });
  });
}
