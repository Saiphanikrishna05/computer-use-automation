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
export function catalogToolDefinitions(): ToolDefinition[] {
  return listArtifacts()
    .filter((a) => a.approval.state === 'approved')
    .map(toolDefinitionFor);
}
