# Offering requirement validation

`createJobFromOffering` validates every payload against an object-valued
`offering.requirements` schema before preparing a job or posting its requirement
message. `createJobByOfferingName` first discovers the offering, then uses the
same validation. A primitive payload must not bypass an object schema, and
scalar schemas must still enforce their constraints. Inputs are neither parsed
as JSON nor coerced; permitted scalar and array values keep their original
serialization.

The existing `AcpAgentOffering` contract declares requirements as an object or
legacy description string. Boolean schemas are outside that declared contract;
this change does not expand the supported schema types. Missing/null requirements
from JavaScript consumers and legacy description strings retain their existing
behavior. A string containing JSON is still a description, not a parsed schema.

Run the focused regression suite and public declaration checks with:

```sh
npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
npm run test:requirements
```

The current upstream lockfile fails ordinary `npm ci` because it lacks the peer
entry `utf-8-validate@5.0.10`. `--legacy-peer-deps` installs that unchanged lockfile
without resolving peer dependencies; it does not demonstrate that ordinary
`npm ci` succeeds. No dependency or lockfile change is needed for these tests.
The existing `npm test` remains its unrelated placeholder failure.

The suite imports the built public entry, constructs an agent through
`AcpAgent.create`, and exercises both offering methods through the real EVM
client, ABI encoding, receipt parsing, API authentication and requirement-message
transport. A fake provider and intercepted `https://acp.invalid` fetches are the
only execution boundaries. No wallet, live RPC, listener or real signer is used.
Rejected direct calls make no HTTP request or signature. Rejected by-name calls
may perform discovery authentication (one fake authentication signature and
authentication POST) and an offering GET; those are distinct from job creation,
funding, state-changing signing and requirement-message POSTs, all of which must
remain absent on rejection.

Positive cases verify exact requirement-message bytes, selected evaluator and
working-funds hook, one creation dispatch and no automatic funding or submission.
A rejection followed by a valid request on the same agent proves recovery. Raw
`createJob` independently retains its existing behavior without a requirement
message. The tests qualify the source and declarations, not a live provider,
installed package replacement, upstream merge/release or buyer acceptance.

For a negative control, run this identical test file against the built parent
source in a disposable checkout with the same dependencies. At source
`392dcc6eb17a6884c214c21aff31afa1b99f45ae`, the 77-test suite has 55 passes and
22 failures; the corrected source passes all 77. The failing cases include
stringified objects and other primitives against an object schema, skipped
scalar constraints, invalid schemas paired with strings, and the corresponding
creation/recovery boundaries on both public entry points. Null and array object
schema rejections already worked and remain covered.

## JSON transport preflight

The requirement is serialized once before job creation. Unsupported top-level
values and serialization failures therefore cannot leave an orphan creation.
The supplied value and its parsed JSON representation must both satisfy the
declared schema; this does not parse a caller's JSON-looking string into an
object or mutate the caller's value. A changing or throwing toJSON cannot
bypass validation or change the posted content on retry. Retrying a message is
not proof of idempotent server handling; these tests establish stable content,
not delivery uniqueness or live settlement.

The full suite now passes91/91. The14 transport controls fail against the first
input-type correction, which otherwise passes77/77. The unchanged original
77-test harness independently gives55passes/22failures against392dcc6e.
The positive expiry assertion brackets the invocation window to avoid a
second-boundary clock race. No dependency or lockfile change is involved.
