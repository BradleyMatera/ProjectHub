'use strict';

/**
 * ToolExecutor — deterministic gate between a model's tool intent and the
 * actual capability handler. The model may propose a tool call; only this
 * executor may run it, and only after every guard passes:
 *
 *   1. tool exists in the registry
 *   2. tool is available for this tenant
 *   3. caller's permission scopes cover the tool's scope
 *   4. side-effecting tools require an explicit confirmation token
 *   5. arguments validate against the declared input schema
 *   6. remaining deadline budget covers the tool timeout
 *
 * Every attempt (executed or refused) is appended to the ActionAudit with
 * provenance. Tool results are typed ToolResult objects — never raw values —
 * so provenance (TOOL_RESULT / COMPUTED_FACT / TENANT_EVIDENCE) survives
 * into the evidence packet instead of flattening into untyped text.
 */

const { performance } = require('node:perf_hooks');
const { VALID_PROVENANCE } = require('./tool-registry');

const ERROR_TYPES = {
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TENANT_UNAVAILABLE: 'TENANT_UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  EXECUTION_ERROR: 'EXECUTION_ERROR'
};

/** Caller-facing policy: which scopes does this session hold, and can the
 *  caller confirm side-effecting actions? Tenant-neutral and injectable. */
class PermissionPolicy {
  constructor({ scopes = [], canConfirm = false } = {}) {
    this.scopes = new Set(scopes);
    this.canConfirm = canConfirm;
  }

  allows(descriptor) {
    if (this.scopes.has('admin')) return true;
    return this.scopes.has(descriptor.permissionScope);
  }

  /** A side-effecting tool needs both permission AND a live confirmation. */
  confirmationSatisfied(descriptor, context) {
    if (!descriptor.requiresConfirmation) return true;
    return !!(this.canConfirm && context && context.confirmationToken);
  }
}

/** Bounded audit trail — one entry per execution attempt, executed or not. */
class ActionAudit {
  constructor(limit = 200) {
    this._limit = limit;
    this._entries = [];
  }

  record(entry) {
    this._entries.push({ timestamp: new Date().toISOString(), ...entry });
    if (this._entries.length > this._limit) this._entries.shift();
  }

  entries() { return this._entries.slice(); }
}

/** Ordered, provenance-typed record of a multi-step workflow. */
class WorkflowState {
  constructor() { this._steps = []; }

  push(provenance, label, data) {
    if (!VALID_PROVENANCE.has(provenance)) {
      throw new Error(`WorkflowState: invalid provenance "${provenance}"`);
    }
    this._steps.push({ provenance, label, data });
    return this;
  }

  steps() { return this._steps.slice(); }

  byProvenance(provenance) {
    return this._steps.filter(s => s.provenance === provenance);
  }
}

class ToolResult {
  constructor(fields) {
    this.status = fields.status;               // 'ok' | 'refused' | 'error'
    this.toolId = fields.toolId;
    this.provenance = fields.provenance;       // VALID_PROVENANCE member
    this.durationMs = fields.durationMs ?? null;
    this.data = fields.data ?? null;           // model-visible payload
    this.errorType = fields.errorType ?? null; // ERROR_TYPES member
    this.error = fields.error ?? null;         // human-readable reason
  }

  get ok() { return this.status === 'ok'; }

  /** Minimal model-facing view — audit internals stay internal. */
  forModel() {
    return this.ok
      ? { tool: this.toolId, status: 'ok', data: this.data }
      : { tool: this.toolId, status: this.status, error: this.error };
  }
}

/** Structural validation against the descriptor's inputSchema. Deliberately
 *  small — covers object/required/primitive types/enum, no $ref/oneOf. */
function validateArgs(schema, args) {
  const errors = [];
  const a = args && typeof args === 'object' ? args : {};
  for (const req of schema.required || []) {
    if (a[req] === undefined || a[req] === null || a[req] === '') {
      errors.push(`missing required argument "${req}"`);
    }
  }
  const props = schema.properties || {};
  for (const [key, value] of Object.entries(a)) {
    const spec = props[key];
    if (!spec) { errors.push(`unexpected argument "${key}"`); continue; }
    if (spec.enum && !spec.enum.includes(value)) {
      errors.push(`argument "${key}" must be one of ${spec.enum.join(', ')}`);
      continue;
    }
    const t = spec.type;
    const bad =
      (t === 'string' && typeof value !== 'string') ||
      (t === 'number' && typeof value !== 'number') ||
      (t === 'integer' && !Number.isInteger(value)) ||
      (t === 'boolean' && typeof value !== 'boolean') ||
      (t === 'array' && !Array.isArray(value)) ||
      (t === 'object' && (typeof value !== 'object' || Array.isArray(value) || value === null));
    if (bad) errors.push(`argument "${key}" must be ${t}`);
  }
  return errors;
}

class ToolExecutor {
  constructor(registry, { policy, audit, deadlineMs = 15000 } = {}) {
    if (!registry) throw new Error('ToolExecutor requires a ToolRegistry');
    this.registry = registry;
    this.policy = policy || new PermissionPolicy();
    this.audit = audit || new ActionAudit();
    this.deadlineMs = deadlineMs;
  }

  _refuse(descriptor, id, errorType, error, startedAt) {
    const result = new ToolResult({
      status: errorType === ERROR_TYPES.EXECUTION_ERROR ? 'error' : 'refused',
      toolId: id,
      provenance: descriptor?.resultProvenance || 'TOOL_RESULT',
      durationMs: Math.round(performance.now() - startedAt),
      errorType, error
    });
    this.audit.record({
      tool: id, status: result.status, errorType, error,
      durationMs: result.durationMs, provenance: result.provenance
    });
    return result;
  }

  /**
   * Validate + run one tool call.
   * @param {string} toolId
   * @param {object} args
   * @param {object} context — { knowledge, confirmationToken, remainingMs, ...handlerContext }
   * @returns {ToolResult}
   */
  async execute(toolId, args = {}, context = {}) {
    const startedAt = performance.now();
    const descriptor = this.registry.get(toolId);
    if (!descriptor) {
      return this._refuse(null, toolId, ERROR_TYPES.UNKNOWN_TOOL, `unknown tool "${toolId}"`, startedAt);
    }
    if (context.knowledge && !this.registry.isAvailableForTenant(descriptor, context.knowledge)) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.TENANT_UNAVAILABLE, `tool "${toolId}" not available for this tenant`, startedAt);
    }
    if (!this.policy.allows(descriptor)) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.PERMISSION_DENIED, `missing scope "${descriptor.permissionScope}"`, startedAt);
    }
    if (!this.policy.confirmationSatisfied(descriptor, context)) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.CONFIRMATION_REQUIRED, `tool "${toolId}" requires confirmation`, startedAt);
    }
    const argErrors = validateArgs(descriptor.inputSchema, args);
    if (argErrors.length) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.INVALID_ARGUMENTS, argErrors.join('; '), startedAt);
    }
    const remaining = context.remainingMs ?? this.deadlineMs;
    if (remaining < descriptor.timeoutMs) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.DEADLINE_EXCEEDED,
        `insufficient budget: ${remaining}ms remaining, tool needs ${descriptor.timeoutMs}ms`, startedAt);
    }

    let data;
    try {
      data = await Promise.race([
        Promise.resolve(descriptor.handler(args, context)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('tool timeout')), descriptor.timeoutMs))
      ]);
    } catch (err) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.EXECUTION_ERROR, String(err?.message || err), startedAt);
    }
    const result = new ToolResult({
      status: 'ok', toolId,
      provenance: descriptor.resultProvenance,
      durationMs: Math.round(performance.now() - startedAt),
      data
    });
    this.audit.record({
      tool: toolId, status: 'ok', args: Object.keys(args || {}),
      durationMs: result.durationMs, provenance: result.provenance
    });
    return result;
  }
}

module.exports = {
  ToolExecutor, ToolResult, PermissionPolicy, ActionAudit, WorkflowState,
  validateArgs, ERROR_TYPES
};
