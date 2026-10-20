import type { AcpAgent, AcpAgentOffering } from '../dist/index.js';

function acceptsSchemaPermittedValues(agent: AcpAgent, offering: AcpAgentOffering) {
  const values: unknown[] = [{ url: 'https://example.com' }, 'text', 1, false, null, [1, 2]];
  for (const value of values) {
    void agent.createJobFromOffering(8453, offering, 'provider', value);
    void agent.createJobByOfferingName(8453, offering.name, 'provider', value);
  }
}
void acceptsSchemaPermittedValues;
