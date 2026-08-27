/**
 * The agent-facing capability catalog.
 *
 * A saved artifact is turned into a tool definition an LLM can discover and
 * call by name with typed arguments. The generation is mechanical and derived
 * from the same artifact replay executes, which is the whole point, a
 * hand-written tool schema sitting next to an automation is a second source of
 * truth, and the two drift the moment either changes.
 *
 * Two rules shape what gets published:
 *
 *  - **Injected parameters are omitted.** Operator credentials are resolved at
 *    execution time from the credential store. The agent cannot supply them,
 *    so it is not told they exist.
 *  - **The declared outcomes are in the description.** A calling agent needs to
 *    know that `MEMBER_NOT_FOUND` is a real answer and not an error, or it will
 *    retry a lookup that will never succeed.
 */

import { listArtifacts } from '../artifact/store.js';
import type { CapabilityArtifact, ParamSpec, ValueType } from '../artifact/schema.js';

/** The application a catalog is being published for, when it is being published
 *  for one in particular. */
export interface CatalogScope {
  vendor: string;
  product: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; pattern?: string }>;
    required: string[];
    additionalProperties: false;
  };
}

function jsonType(type: ValueType): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'money':
      return 'number';
  }
}

function agentVisible(inputs: ParamSpec[]): ParamSpec[] {
  return inputs.filter((i) => !i.injected);
}

export function toolDefinitionFor(artifact: CapabilityArtifact): ToolDefinition {
  const visible = agentVisible(artifact.inputs);

  const outputLines = artifact.outputs
    .map((o) => `  - ${o.name} (${o.type}): ${o.description}`)
    .join('\n');

  const outcomeLines = artifact.outcomes
    .map((o) => `  - ${o.code}: ${o.description}`)
    .join('\n');

  const description = [
    artifact.description,
    '',
    'Returns on success:',
    outputLines || '  (no outputs)',
    '',
    // Naming these explicitly is what stops an agent from treating a valid
    // answer as a transient failure and retrying it forever.
    'May instead return one of these expected outcomes, which are legitimate answers rather than errors:',
    outcomeLines || '  (none declared)',
    '',
    `Risk classification: ${artifact.maxRisk}. Approval state: ${artifact.approval.state}.`,
  ].join('\n');

  const properties: ToolDefinition['input_schema']['properties'] = {};
  for (const input of visible) {
    properties[input.name] = {
      type: jsonType(input.type),
      description: input.example !== undefined ? `${input.description} Example: ${input.example}.` : input.description,
      ...(input.pattern ? { pattern: input.pattern } : {}),
    };
  }

  return {
    name: artifact.id,
    description,
    input_schema: {
      type: 'object',
      properties,
      required: visible.filter((i) => i.required).map((i) => i.name),
      additionalProperties: false,
    },
  };
}

/**
 * Only approved capabilities are published. A draft is visible to a human via
 * `catalog list` but is not offered to an agent, so the approval gate is
 * enforced at discovery time rather than only at execution time, an agent
 * cannot call something it was never told about.
 */
/**
 * The catalog an agent is handed.
 *
 * Scoped to one application when a scope is given, because a capability
 * recorded against a different vendor product cannot work against this host,
 * and an agent offered one will try it. That is not hypothetical: asked to
 * check a balance and then move money on Meridian Core, the chatbot reached
 * first for a capability recorded against a different console entirely, failed,
 * and recovered by trying another. It got there, but it spent a call learning
 * something the catalog already knew.
 *
 * Unscoped still returns everything, which is what the CLI and the dashboard
 * want: a person looking at the whole estate should see the whole estate.
 */
export function catalogToolDefinitions(scope?: CatalogScope): ToolDefinition[] {
  return listArtifacts()
    .filter((a) => a.approval.state === 'approved')
    .filter((a) => !scope || (a.target.app.vendor === scope.vendor && a.target.app.product === scope.product))
    .map(toolDefinitionFor);
}
