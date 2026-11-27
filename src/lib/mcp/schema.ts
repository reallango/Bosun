/** JSON Schemas for MCP tools, derived from the widget spec's parameter declarations. */
import type { ActionSpec, ParamSpec } from '@/lib/widgets/runtime/spec';
import type { JsonSchema, ObjectJsonSchema } from './types';

const SERVER_ID: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Server id (call servers_list to find one).',
};

export function paramSchema(p: ParamSpec): JsonSchema {
  const description = p.description;
  if (p.type === 'text') {
    return {
      type: 'string',
      maxLength: p.maxLength,
      ...(description ? { description } : {}),
      // The spec limits this to maxLines lines and may restrict each line; JSON Schema cannot express that portably.
      title: `Up to ${p.maxLines} line${p.maxLines === 1 ? '' : 's'}`,
    };
  }
  if (p.type === 'boolean') return { type: 'boolean', ...(description ? { description } : {}) };
  if (p.type === 'number') {
    return {
      type: p.integer ? 'integer' : 'number',
      minimum: p.min,
      maximum: p.max,
      ...(description ? { description } : {}),
    };
  }
  return {
    type: 'string',
    maxLength: p.maxLength,
    ...(p.pattern ? { pattern: p.pattern } : {}),
    ...(p.values ? { enum: p.values } : {}),
    ...(description ? { description } : {}),
  };
}

function paramProperties(params: Record<string, ParamSpec>): { properties: JsonSchema; required: string[] } {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(params)) {
    properties[name] = paramSchema(spec);
    if (spec.default === undefined) required.push(name);
  }
  return { properties, required };
}

/** A dataset tool: server_id plus the dataset script's arguments. Defaults stay optional (loadDataset fills them). */
export function datasetInputSchema(params: Record<string, ParamSpec>): ObjectJsonSchema {
  const { properties, required } = paramProperties(params);
  return {
    type: 'object',
    properties: { server_id: SERVER_ID, ...(properties as Record<string, JsonSchema>) },
    required: ['server_id', ...required],
    additionalProperties: false,
  };
}

/**
 * An action tool: server_id plus every declared parameter. Action defaults are never filled by Bosun, so every
 * parameter is required. Destructive actions also take the same `confirm: true` the REST action route requires.
 */
export function actionInputSchema(action: ActionSpec): ObjectJsonSchema {
  const properties: JsonSchema = { server_id: SERVER_ID };
  const required: string[] = ['server_id'];
  if (action.kind === 'terminal') {
    properties.ref = {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: `The ${action.target?.kind ?? 'target'} to open the terminal in (its name or id).`,
    };
    required.push('ref');
  } else {
    const { properties: params, required: paramNames } = paramProperties(action.params);
    Object.assign(properties, params);
    required.push(...paramNames);
    if (action.confirm) {
      properties.confirm = {
        type: 'boolean',
        const: true,
        description: `Must be true. ${action.confirm.title}${action.confirm.text ? ` ${action.confirm.text}` : ''}`,
      };
      required.push('confirm');
    }
    if (action.kind === 'script') {
      properties.widget_id = {
        type: 'string',
        description: 'Optional widget instance whose settings the action reads, when it uses any.',
      };
    }
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
