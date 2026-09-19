'use strict';

/**
 * ToolExecutor — deterministic gate between a model's tool intent and the
 * actual capability handler. The model may propose a tool call; only this
 * executor may run it, and only after every guard passes:
 *
 *   1. tool exists in the registry
 *   2. the active package/domain capability policy allows the tool
 *   3. tool is available for this tenant (always evaluated — omitting
 *      context.knowledge can never widen availability)
 *   4. caller's permission scopes cover the tool's scope
 *   5. arguments validate against the declared input schema
 *   6. remaining deadline budget covers the tool timeout
 *   7. side-effecting tools consume a valid one-time confirmation grant
 *      verified by an injected ConfirmationGrantVerifier — verified LAST,
 *      immediately before the side effect begins, so a failed arg/deadline
 *      check never burns a live grant; without an injected verifier,
 *      side effects are always refused
 *   8. handler executes under an AbortController signal
 *
 * The executor itself is the security boundary: every guard runs here, so
 * no caller can bypass package policy, tenant availability, or confirmation
 * semantics by skipping a pre-check. Every attempt (executed or refused) is
 * appended to the ActionAudit with provenance. Tool results are typed
 * ToolResult objects — never raw values — so provenance (TOOL_RESULT /
 * COMPUTED_FACT / TENANT_EVIDENCE) survives into the evidence packet
 * instead of flattening into untyped text.
 *
 * Handler exceptions are sanitized at this boundary: the model-facing
 * ToolResult and the audit trail carry a stable error category and a
 * generic message — never raw handler exception text. Diagnostics sinks
 * receive a safe record (tool, error category, timeout flag, duration,
 * opaque error fingerprint). Raw exception text is emitted ONLY when
 * `rawDiagnostics: true` is explicitly set — a development-only option
 * that must stay off in hosted deployments.
 *
 * A timeout limits how long the executor WAITS — it also aborts the
 * handler's AbortSignal so cooperative adapters can stop. For
 * side-effecting tools a timeout is ambiguous: the adapter may have
 * committed anyway. Those return EXECUTION_STATUS_UNKNOWN — never a false
 * "failed" — and the executor never retries a side effect on its own.
 */

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const { VALID_PROVENANCE } = require('./tool-registry');

const ERROR_TYPES = {
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  CAPABILITY_NOT_ALLOWED: 'CAPABILITY_NOT_ALLOWED',
  TENANT_UNAVAILABLE: 'TENANT_UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  EXECUTION_STATUS_UNKNOWN: 'EXECUTION_STATUS_UNKNOWN'
};

/** Explicit opt-in for standalone/internal executors that are deliberately
 *  NOT governed by a package capability policy (deterministic internal use
 *  or tests). Without this — or `unscopedCapabilities: true` — an executor
 *  with no injected capabilityPolicy fails closed. */
const ALLOW_ALL_INTERNAL_POLICY = Object.freeze({
  isAllowed() { return true; }
});

/** Caller-facing policy: which scopes does this session hold, and is the
 *  caller authorized to hold confirmation grants for side effects?
 *  Tenant-neutral and injectable. */
class PermissionPolicy {
  constructor({ scopes = [], canConfirm = false } = {}) {
    this.scopes = new Set(scopes);
    this.canConfirm = canConfirm;
  }

  allows(descriptor) {
    if (this.scopes.has('admin')) return true;
    return this.scopes.has(descriptor.permissionScope);
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
  /**
   * @param {ToolRegistry} registry
   * @param {object} [opts]
   * @param {PermissionPolicy} [opts.policy] — caller scopes/authorization
   * @param {ActionAudit} [opts.audit]
   * @param {number} [opts.deadlineMs]
   * @param {object|function} [opts.capabilityPolicy] — injected tenant/domain
   *   capability gate: a `(toolId, descriptor) => boolean` function or an
   *   object with `isAllowed(toolId, descriptor)`. Evaluated on EVERY call
   *   so a package switch takes effect immediately. OMITTED POLICY FAILS
   *   CLOSED — a package-governed runtime must inject one. For deliberate
   *   standalone/internal executors, pass ALLOW_ALL_INTERNAL_POLICY or
   *   `unscopedCapabilities: true`. A throwing/non-true policy fails closed.
   * @param {boolean} [opts.unscopedCapabilities] — explicit opt-in to run
   *   without a package capability gate (standalone internal executor).
   * @param {object} [opts.confirmationVerifier] — ConfirmationGrantVerifier
   *   (or any { verify }) for side-effecting tools. Not injected = all
   *   side effects refused.
   * @param {function} [opts.diagnostics] — operator-only sink for safe
   *   diagnostic records (tool, category, timeout, duration, fingerprint).
   *   Never model context.
   * @param {boolean} [opts.rawDiagnostics] — development-only: include the
   *   raw handler exception text in the diagnostic record. Default OFF;
   *   hosted deployments must not enable it.
   */
  constructor(registry, { policy, audit, deadlineMs = 15000, capabilityPolicy, unscopedCapabilities = false, confirmationVerifier, diagnostics, rawDiagnostics = false } = {}) {
    if (!registry) throw new Error('ToolExecutor requires a ToolRegistry');
    this.registry = registry;
    this.policy = policy || new PermissionPolicy();
    this.audit = audit || new ActionAudit();
    this.deadlineMs = deadlineMs;
    this.capabilityPolicy = capabilityPolicy || null;
    this.unscopedCapabilities = unscopedCapabilities === true || capabilityPolicy === ALLOW_ALL_INTERNAL_POLICY;
    this.confirmationVerifier = confirmationVerifier || null;
    this.diagnostics = typeof diagnostics === 'function' ? diagnostics : null;
    this.rawDiagnostics = rawDiagnostics === true;
  }

  _capabilityAllowed(toolId, descriptor) {
    const gate = this.capabilityPolicy;
    if (!gate) return this.unscopedCapabilities; // fail closed unless explicitly unscoped
    try {
      const allowed = typeof gate === 'function' ? gate(toolId, descriptor) : gate.isAllowed(toolId, descriptor);
      return allowed === true;
    } catch {
      return false; // a broken policy gate fails closed
    }
  }

  _confirmationSatisfied(descriptor, toolId, args, context) {
    if (!descriptor.requiresConfirmation) return { ok: true };
    if (!this.policy.canConfirm || !this.confirmationVerifier) {
      return { ok: false, reason: `tool "${toolId}" requires a confirmation grant` };
    }
    const verdict = this.confirmationVerifier.verify(context && context.confirmationGrant, {
      toolId,
      args,
      principal: context && (context.principal ?? context.sessionId ?? null)
    });
    if (!verdict || verdict.ok !== true) {
      return { ok: false, reason: `tool "${toolId}" confirmation grant rejected` };
    }
    return { ok: true };
  }

  _refuse(descriptor, id, errorType, error, startedAt, extra = {}) {
    const isExecutionFailure = errorType === ERROR_TYPES.EXECUTION_ERROR || errorType === ERROR_TYPES.EXECUTION_STATUS_UNKNOWN;
    const result = new ToolResult({
      status: isExecutionFailure ? 'error' : 'refused',
      toolId: id,
      provenance: descriptor?.resultProvenance || 'TOOL_RESULT',
      durationMs: Math.round(performance.now() - startedAt),
      errorType, error
    });
    this.audit.record({
      tool: id, status: result.status, errorType, error,
      durationMs: result.durationMs, provenance: result.provenance,
      ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {})
    });
    return result;
  }

  /** Safe operator diagnostic record — never contains raw exception text
   *  unless rawDiagnostics was explicitly enabled (development only). */
  _diagnose(toolId, errorType, err, timedOut, durationMs) {
    if (!this.diagnostics) return;
    const raw = String(err?.message || err);
    const record = {
      tool: toolId,
      errorType,
      timedOut: timedOut === true,
      durationMs,
      // Opaque, one-way fingerprint — lets operators correlate identical
      // failures across requests without logging payload text.
      errorFingerprint: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
    };
    if (this.rawDiagnostics) record.message = raw;
    try {
      this.diagnostics(record);
    } catch { /* a broken diagnostics sink must not break the boundary */ }
  }

  /**
   * Validate + run one tool call.
   * @param {string} toolId
   * @param {object} args
   * @param {object} context — { knowledge, confirmationGrant, principal, sessionId, remainingMs, ...handlerContext }
   * @returns {ToolResult}
   */
  async execute(toolId, args = {}, context = {}) {
    const startedAt = performance.now();
    const descriptor = this.registry.get(toolId);
    if (!descriptor) {
      return this._refuse(null, toolId, ERROR_TYPES.UNKNOWN_TOOL, `unknown tool "${toolId}"`, startedAt);
    }
    if (!this._capabilityAllowed(toolId, descriptor)) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.CAPABILITY_NOT_ALLOWED,
        `capability "${toolId}" is not enabled by the active package policy`, startedAt);
    }
    // Tenant availability is ALWAYS evaluated — a caller that omits
    // context.knowledge cannot widen access, only lose it.
    if (!this.registry.isAvailableForTenant(descriptor, context.knowledge ?? null)) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.TENANT_UNAVAILABLE, `tool "${toolId}" not available for this tenant`, startedAt);
    }
    if (!this.policy.allows(descriptor)) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.PERMISSION_DENIED, `missing scope "${descriptor.permissionScope}"`, startedAt);
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
    // The one-time confirmation grant is consumed LAST — immediately before
    // the authorized side effect begins — so an args/deadline failure can
    // never burn a live grant.
    const confirmation = this._confirmationSatisfied(descriptor, toolId, args, context);
    if (!confirmation.ok) {
      return this._refuse(descriptor, toolId, ERROR_TYPES.CONFIRMATION_REQUIRED, confirmation.reason, startedAt);
    }

    // Cancellation-aware execution: the handler receives an AbortSignal
    // (context.signal) plus, for side effects, a stable idempotency key.
    const controller = new AbortController();
    const execContext = { ...context, signal: controller.signal };
    let idempotencyKey = null;
    if (descriptor.sideEffect) {
      idempotencyKey = `exec-${crypto.randomBytes(8).toString('hex')}`;
      execContext.idempotencyKey = idempotencyKey;
    }
    let data;
    let timedOut = false;
    let timer = null;
    try {
      data = await Promise.race([
        Promise.resolve(descriptor.handler(args, execContext)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort(); // cooperative adapters stop; uncontrolled ones get STATUS_UNKNOWN
            reject(new Error('timeout'));
          }, descriptor.timeoutMs);
        })
      ]);
    } catch (err) {
      // Handler exceptions are sanitized at the boundary: the model-facing
      // result and the audit record get a stable category + generic text.
      // A timed-out SIDE EFFECT is ambiguous — the adapter may have
      // committed — so it is EXECUTION_STATUS_UNKNOWN, never a false
      // "failed", and never auto-retried.
      const errorType = timedOut && descriptor.sideEffect
        ? ERROR_TYPES.EXECUTION_STATUS_UNKNOWN
        : ERROR_TYPES.EXECUTION_ERROR;
      const error = timedOut
        ? (descriptor.sideEffect
            ? 'capability did not complete within its time budget; final state could not be confirmed'
            : 'capability did not complete within its time budget')
        : 'capability execution failed';
      this._diagnose(toolId, errorType, err, timedOut, Math.round(performance.now() - startedAt));
      return this._refuse(descriptor, toolId, errorType, error, startedAt, { idempotencyKey });
    } finally {
      if (timer !== null) clearTimeout(timer); // no dangling timer after success OR failure
    }
    const result = new ToolResult({
      status: 'ok', toolId,
      provenance: descriptor.resultProvenance,
      durationMs: Math.round(performance.now() - startedAt),
      data
    });
    this.audit.record({
      tool: toolId, status: 'ok', args: Object.keys(args || {}),
      durationMs: result.durationMs, provenance: result.provenance,
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    return result;
  }
}

module.exports = {
  ToolExecutor, ToolResult, PermissionPolicy, ActionAudit, WorkflowState,
  validateArgs, ERROR_TYPES, ALLOW_ALL_INTERNAL_POLICY
};
