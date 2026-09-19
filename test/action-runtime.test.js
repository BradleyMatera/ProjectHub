'use strict';

// Scout Action Runtime V1 — registry, executor, permission policy,
// confirmation gate, audit trail, provenance, and default capabilities.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ToolRegistry } = require('../lib/tool-registry');
const {
  ToolExecutor, PermissionPolicy, ActionAudit, WorkflowState, ERROR_TYPES,
  ALLOW_ALL_INTERNAL_POLICY
} = require('../lib/tool-executor');
const { ConfirmationGrantVerifier } = require('../lib/confirmation-grants');
const {
  buildToolRegistry, calculatorTool, knowledgeLookupTool,
  entityLookupTool, contentSearchTool, sendNotificationTool, KNOWLEDGE_SECTIONS
} = require('../lib/tool-capabilities');

const KB = {
  identity: { name: 'Avery Stone', preferredName: 'Avery' },
  skills: { languages: ['Python', 'Go'], tools: ['Docker'] },
  projects: [{ name: 'Atlas API', tech: ['Python'] }],
  notifications: { enabled: true }
};

function executor(registry, opts = {}) {
  return new ToolExecutor(registry || buildToolRegistry(), {
    policy: opts.policy || new PermissionPolicy({
      scopes: ['compute', 'knowledge:read', 'search:read', 'entity:read', 'action:write'],
      canConfirm: opts.canConfirm ?? false
    }),
    audit: opts.audit,
    deadlineMs: opts.deadlineMs ?? 15000,
    // These tests exercise the executor's other gates, not package policy —
    // they explicitly opt into the unscoped internal policy.
    capabilityPolicy: opts.capabilityPolicy || ALLOW_ALL_INTERNAL_POLICY,
    confirmationVerifier: opts.confirmationVerifier,
    diagnostics: opts.diagnostics,
    rawDiagnostics: opts.rawDiagnostics
  });
}

// ── Registry ─────────────────────────────────────────────────────────

test('REG-1: registry rejects malformed descriptors', () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register(null));
  assert.throws(() => r.register({ id: 'x' }));
  assert.throws(() => r.register({ id: 'x', name: 'X', handler: 'notafn' }));
  assert.throws(() => r.register({ id: 'x', name: 'X', handler: () => {}, permissionScope: 'bogus:scope' }));
});

test('REG-2: side-effecting tools MUST declare requiresConfirmation', () => {
  const r = new ToolRegistry();
  assert.throws(
    () => r.register({ id: 'evil', name: 'E', handler: () => {}, sideEffect: true }),
    /requiresConfirmation/
  );
});

test('REG-3: registry lists and describes registered tools', () => {
  const r = buildToolRegistry();
  const ids = r.list().map(d => d.id);
  for (const id of ['calculator', 'knowledge_lookup', 'entity_lookup', 'content_search', 'send_notification']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  const modelView = r.describeForModel(KB);
  assert.ok(modelView.every(d => d.id && d.name && d.inputSchema));
  assert.ok(!('handler' in modelView[0]), 'handler must not leak to the model catalog');
});

test('REG-4: tenantAvailability gates a tool per tenant', () => {
  const r = buildToolRegistry();
  const withoutNotifications = { identity: { name: 'X' } };
  const ids = r.list(withoutNotifications).map(d => d.id);
  assert.ok(!ids.includes('send_notification'));
  assert.ok(r.list(KB).some(d => d.id === 'send_notification'));
});

// ── Executor guards ──────────────────────────────────────────────────

test('EXEC-1: unknown tool refused', async () => {
  const res = await executor().execute('nonexistent', {}, { knowledge: KB });
  assert.equal(res.status, 'refused');
  assert.equal(res.errorType, ERROR_TYPES.UNKNOWN_TOOL);
});

test('EXEC-2: permission denied without scope', async () => {
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['knowledge:read'] })
  });
  const res = await ex.execute('calculator', { expression: '2+2' }, { knowledge: KB });
  assert.equal(res.errorType, ERROR_TYPES.PERMISSION_DENIED);
});

test('EXEC-3: admin scope bypasses individual scopes (still needs a valid grant)', async () => {
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['admin'], canConfirm: true }),
    confirmationVerifier: verifier
  });
  const args = { recipient: 'a@b.co', subject: 's', body: 'b' };
  const grant = verifier.issue({ toolId: 'send_notification', args });
  const res = await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant });
  assert.equal(res.status, 'ok');
});

test('EXEC-4: side-effecting tool refused without a confirmation grant', async () => {
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: verifier
  });
  const res = await ex.execute('send_notification',
    { recipient: 'a@b.co', subject: 's', body: 'b' }, { knowledge: KB });
  assert.equal(res.errorType, ERROR_TYPES.CONFIRMATION_REQUIRED);
});

test('EXEC-5: a grant without canConfirm authorization is refused', async () => {
  const verifier = new ConfirmationGrantVerifier();
  const args = { recipient: 'a@b.co', subject: 's', body: 'b' };
  const grant = verifier.issue({ toolId: 'send_notification', args });
  const res = await executor(buildToolRegistry(), { confirmationVerifier: verifier }).execute(
    'send_notification', args, { knowledge: KB, confirmationGrant: grant });
  assert.equal(res.errorType, ERROR_TYPES.CONFIRMATION_REQUIRED);
});

test('EXEC-6: argument validation — missing, unexpected, wrong type, bad enum', async () => {
  const ex = executor();
  const missing = await ex.execute('calculator', {}, {});
  assert.equal(missing.errorType, ERROR_TYPES.INVALID_ARGUMENTS);
  const unexpected = await ex.execute('calculator', { expression: '2+2', extra: 1 }, {});
  assert.equal(unexpected.errorType, ERROR_TYPES.INVALID_ARGUMENTS);
  const wrongType = await ex.execute('calculator', { expression: 42 }, {});
  assert.equal(wrongType.errorType, ERROR_TYPES.INVALID_ARGUMENTS);
  const badEnum = await ex.execute('knowledge_lookup', { section: 'passwords' }, { knowledge: KB });
  assert.equal(badEnum.errorType, ERROR_TYPES.INVALID_ARGUMENTS);
});

test('EXEC-7: insufficient deadline budget refuses before execution', async () => {
  const res = await executor().execute('calculator', { expression: '1+1' }, { remainingMs: 500 });
  assert.equal(res.errorType, ERROR_TYPES.DEADLINE_EXCEEDED);
});

test('EXEC-8: execution error is contained, sanitized, and operator-sinked', async () => {
  const r = new ToolRegistry();
  r.register({
    id: 'boom', name: 'Boom', permissionScope: 'compute',
    handler: () => { throw new Error('kaboom SECRET-XYZ'); }
  });
  const diagnostics = [];
  const res = await executor(r, { diagnostics: e => diagnostics.push(e) }).execute('boom', {}, {});
  assert.equal(res.status, 'error');
  assert.equal(res.errorType, ERROR_TYPES.EXECUTION_ERROR);
  // Raw handler text never reaches the model-facing error or the audit trail
  assert.ok(!res.error.includes('SECRET-XYZ'));
  assert.ok(!res.error.includes('kaboom'));
  assert.ok(!JSON.stringify(res.forModel()).includes('SECRET-XYZ'));
  // The operator sink receives the SAFE record — category, timeout, duration,
  // opaque fingerprint — never raw exception text by default.
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].tool, 'boom');
  assert.equal(diagnostics[0].errorType, ERROR_TYPES.EXECUTION_ERROR);
  assert.ok(diagnostics[0].errorFingerprint);
  assert.ok(!('message' in diagnostics[0]), 'raw handler text must not reach default diagnostics');
});

test('EXEC-8b: raw diagnostics require explicit development opt-in', async () => {
  const r = new ToolRegistry();
  r.register({
    id: 'boom', name: 'Boom', permissionScope: 'compute',
    handler: () => { throw new Error('kaboom SECRET-XYZ'); }
  });
  const diagnostics = [];
  await executor(r, { diagnostics: e => diagnostics.push(e), rawDiagnostics: true }).execute('boom', {}, {});
  // Explicit opt-in is the only path raw handler text may take — and it is
  // a development-only diagnostic, still never model context or audit.
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].message.includes('SECRET-XYZ'));
});

test('EXEC-9: tool timeout produces EXECUTION_ERROR', async () => {
  const r = new ToolRegistry();
  r.register({
    id: 'slow', name: 'Slow', permissionScope: 'compute', timeoutMs: 30,
    handler: () => new Promise(res => setTimeout(res, 500))
  });
  const res = await executor(r).execute('slow', {}, { remainingMs: 5000 });
  assert.equal(res.errorType, ERROR_TYPES.EXECUTION_ERROR);
});

// ── Capabilities ─────────────────────────────────────────────────────

test('CAP-1: calculator wraps the arithmetic engine with COMPUTED_FACT provenance', async () => {
  const res = await executor().execute('calculator', { expression: 'what is 15% of 200?' }, {});
  assert.equal(res.status, 'ok');
  assert.equal(res.provenance, 'COMPUTED_FACT');
  assert.ok(res.data.formatted.includes('30'));
});

test('CAP-2: knowledge_lookup reads a tenant section with TENANT_EVIDENCE provenance', async () => {
  const res = await executor().execute('knowledge_lookup', { section: 'skills' }, { knowledge: KB });
  assert.equal(res.status, 'ok');
  assert.equal(res.provenance, 'TENANT_EVIDENCE');
  assert.deepEqual(res.data.data.languages, ['Python', 'Go']);
});

test('CAP-3: knowledge_lookup returns found:false for missing section', async () => {
  const res = await executor().execute('knowledge_lookup', { section: 'goals' }, { knowledge: KB });
  assert.equal(res.status, 'ok');
  assert.equal(res.data.found, false);
});

test('CAP-4: entity_lookup resolves canonical entity through the graph', async () => {
  const res = await executor().execute('entity_lookup', { name: 'Atlas API' }, { knowledge: KB });
  assert.equal(res.status, 'ok');
  assert.ok(res.data.canonical);
});

test('CAP-5: content_search degrades safely without an index', async () => {
  const res = await executor().execute('content_search', { query: 'python' }, { knowledge: KB });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.data.hits, []);
});

test('CAP-6: send_notification executes with a verified one-time grant and returns TOOL_RESULT', async () => {
  let delivered = null;
  const registry = new ToolRegistry();
  registry.register(sendNotificationTool(args => { delivered = args; return { queued: true }; }));
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(registry, { canConfirm: true, confirmationVerifier: verifier });
  const args = { recipient: 'ops@x.co', subject: 's', body: 'b' };
  const grant = verifier.issue({ toolId: 'send_notification', args });
  const res = await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant });
  assert.equal(res.status, 'ok');
  assert.equal(res.provenance, 'TOOL_RESULT');
  assert.equal(delivered.recipient, 'ops@x.co');
});

// ── Audit / provenance / workflow ────────────────────────────────────

test('AUDIT-1: every attempt is recorded, executed or refused', async () => {
  const audit = new ActionAudit();
  const ex = executor(buildToolRegistry(), { audit });
  await ex.execute('calculator', { expression: '2+2' }, {});
  await ex.execute('nope', {}, {});
  const entries = audit.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, 'ok');
  assert.equal(entries[1].status, 'refused');
  assert.ok(entries[0].timestamp && entries[0].durationMs != null);
});

test('AUDIT-2: ToolResult.forModel hides internals', async () => {
  const res = await executor().execute('calculator', { expression: '2+2' }, {});
  const view = res.forModel();
  assert.ok(!('durationMs' in view) && !('provenance' in view));
  assert.equal(view.status, 'ok');
});

test('WF-1: WorkflowState enforces typed provenance', () => {
  const wf = new WorkflowState();
  wf.push('USER_INPUT', 'question', { text: 'hi' });
  wf.push('TOOL_RESULT', 'calculator', { value: 4 });
  wf.push('COMPUTED_FACT', 'sum', { value: 4 });
  assert.throws(() => wf.push('RANDOM', 'x', {}));
  assert.equal(wf.byProvenance('TOOL_RESULT').length, 1);
  assert.equal(wf.steps().length, 3);
});

test('PROV-1: capabilities keep distinct provenance markers', async () => {
  const ex = executor();
  const calc = await ex.execute('calculator', { expression: '2+2' }, {});
  const kb2 = await ex.execute('knowledge_lookup', { section: 'skills' }, { knowledge: KB });
  assert.equal(calc.provenance, 'COMPUTED_FACT');
  assert.equal(kb2.provenance, 'TENANT_EVIDENCE');
  assert.notEqual(calc.provenance, kb2.provenance);
});

test('SECTIONS: knowledge_lookup enum matches tenant sections', () => {
  const tool = knowledgeLookupTool();
  assert.deepEqual(tool.inputSchema.properties.section.enum, KNOWLEDGE_SECTIONS);
  assert.ok(KNOWLEDGE_SECTIONS.includes('boundaries'));
});

// ── Execution-contract hardening (final pass) ────────────────────────

test('TENANT-1: omitting context.knowledge cannot bypass tenantAvailability', async () => {
  const ex = executor();
  // Knowledge-gated tools fail CLOSED when the caller supplies no tenant
  // context — the gate is always evaluated, never skipped.
  for (const [toolId, args] of [
    ['knowledge_lookup', { section: 'skills' }],
    ['entity_lookup', { name: 'Atlas API' }],
    ['content_search', { query: 'python' }]
  ]) {
    const res = await ex.execute(toolId, args, {}); // no knowledge key at all
    assert.equal(res.errorType, ERROR_TYPES.TENANT_UNAVAILABLE, toolId);
  }
  // A truthy-but-empty knowledge object is a DIFFERENT case — an existing
  // (empty) tenant context, not a missing one.
  const withEmpty = await ex.execute('knowledge_lookup', { section: 'skills' }, { knowledge: {} });
  assert.notEqual(withEmpty.errorType, ERROR_TYPES.TENANT_UNAVAILABLE);
});

test('TENANT-2: calculator stays available without tenant knowledge', async () => {
  const res = await executor().execute('calculator', { expression: '2+2' }, {});
  assert.equal(res.status, 'ok');
});

test('TENANT-3: send_notification unavailable without tenant context even with scope', async () => {
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: new ConfirmationGrantVerifier()
  });
  const args = { recipient: 'a@b.co', subject: 's', body: 'b' };
  const grant = ex.confirmationVerifier.issue({ toolId: 'send_notification', args });
  const res = await ex.execute('send_notification', args, { confirmationGrant: grant });
  assert.equal(res.errorType, ERROR_TYPES.TENANT_UNAVAILABLE);
  // Tenant gate ran before confirmation — the grant is still live.
  const retry = await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant });
  assert.equal(retry.status, 'ok');
});

test('POLICY-1: missing capabilityPolicy fails closed by default', async () => {
  const ex = new ToolExecutor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['compute', 'knowledge:read'] })
  });
  const res = await ex.execute('calculator', { expression: '2+2' }, { knowledge: KB });
  assert.equal(res.errorType, ERROR_TYPES.CAPABILITY_NOT_ALLOWED);
});

test('POLICY-2: explicit unscoped opt-ins both work', async () => {
  for (const opts of [{ unscopedCapabilities: true }, { capabilityPolicy: ALLOW_ALL_INTERNAL_POLICY }]) {
    const ex = new ToolExecutor(buildToolRegistry(), {
      policy: new PermissionPolicy({ scopes: ['compute'] }), ...opts
    });
    const res = await ex.execute('calculator', { expression: '2+2' }, {});
    assert.equal(res.status, 'ok', JSON.stringify(opts));
  }
});

test('GRANT-ORDER-1: invalid args refuse before consuming the grant', async () => {
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: verifier
  });
  const goodArgs = { recipient: 'a@b.co', subject: 's', body: 'b' };
  // Grant issued for the VALID arg set; first call sends bad args that fail
  // schema validation — the grant must NOT be consumed.
  const grant = verifier.issue({ toolId: 'send_notification', args: goodArgs });
  const bad = await ex.execute('send_notification', { recipient: 'a@b.co' }, { knowledge: KB, confirmationGrant: grant });
  assert.equal(bad.errorType, ERROR_TYPES.INVALID_ARGUMENTS);
  const retry = await ex.execute('send_notification', goodArgs, { knowledge: KB, confirmationGrant: grant });
  assert.equal(retry.status, 'ok');
});

test('GRANT-ORDER-2: insufficient deadline refuses before consuming the grant', async () => {
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: verifier
  });
  const args = { recipient: 'a@b.co', subject: 's', body: 'b' };
  const grant = verifier.issue({ toolId: 'send_notification', args });
  const tight = await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant, remainingMs: 1 });
  assert.equal(tight.errorType, ERROR_TYPES.DEADLINE_EXCEEDED);
  const retry = await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant });
  assert.equal(retry.status, 'ok');
});

test('GRANT-ORDER-3: grant consumed exactly once on success, replay refused', async () => {
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: verifier
  });
  const args = { recipient: 'a@b.co', subject: 's', body: 'b' };
  const grant = verifier.issue({ toolId: 'send_notification', args });
  assert.equal((await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant })).status, 'ok');
  assert.equal(
    (await ex.execute('send_notification', args, { knowledge: KB, confirmationGrant: grant })).errorType,
    ERROR_TYPES.CONFIRMATION_REQUIRED
  );
});

test('ABORT-1: read-only timeout aborts the handler signal and reports EXECUTION_ERROR', async () => {
  const r = new ToolRegistry();
  let sawAbort = false;
  r.register({
    id: 'slow', name: 'Slow', permissionScope: 'compute', timeoutMs: 25,
    handler: (args, context) => new Promise(res => {
      context.signal.addEventListener('abort', () => { sawAbort = true; });
      setTimeout(res, 500);
    })
  });
  const res = await executor(r).execute('slow', {}, { remainingMs: 5000 });
  assert.equal(res.errorType, ERROR_TYPES.EXECUTION_ERROR);
  await new Promise(res2 => setTimeout(res2, 10));
  assert.equal(sawAbort, true, 'executor must abort the handler signal on timeout');
});

test('ABORT-2: side-effect timeout is EXECUTION_STATUS_UNKNOWN, aborted, and never retried', async () => {
  const r = new ToolRegistry();
  let calls = 0;
  let sawAbort = false;
  let sawKey = null;
  r.register({
    id: 'slow_write', name: 'Slow Write', permissionScope: 'action:write',
    sideEffect: true, requiresConfirmation: true,
    idempotent: false, supportsAbort: true,
    timeoutMs: 25,
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    handler: (args, context) => new Promise(res => {
      calls += 1;
      sawKey = context.idempotencyKey;
      context.signal.addEventListener('abort', () => { sawAbort = true; });
      setTimeout(res, 500);
    })
  });
  const verifier = new ConfirmationGrantVerifier();
  const ex = executor(r, {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true }),
    confirmationVerifier: verifier
  });
  const args = { note: 'hello' };
  const grant = verifier.issue({ toolId: 'slow_write', args });
  const res = await ex.execute('slow_write', args, { knowledge: KB, confirmationGrant: grant, remainingMs: 5000 });
  assert.equal(res.errorType, ERROR_TYPES.EXECUTION_STATUS_UNKNOWN);
  assert.equal(res.status, 'error');
  assert.ok(!res.error.includes('failed'), 'ambiguous side effect must not be reported as a clean failure');
  await new Promise(res2 => setTimeout(res2, 10));
  assert.equal(sawAbort, true, 'side-effect handler must receive abort');
  assert.equal(calls, 1, 'no automatic retry of an ambiguous side effect');
  assert.ok(/^exec-/.test(sawKey), 'side-effect handler must receive a stable idempotency key');
});

test('ABORT-3: fast success leaves no dangling timer and no abort', async () => {
  const r = new ToolRegistry();
  let sawAbort = false;
  r.register({
    id: 'fast', name: 'Fast', permissionScope: 'compute', timeoutMs: 500,
    handler: (args, context) => {
      context.signal.addEventListener('abort', () => { sawAbort = true; });
      return { done: true };
    }
  });
  const res = await executor(r).execute('fast', {}, {});
  assert.equal(res.status, 'ok');
  await new Promise(res2 => setTimeout(res2, 50)); // outlive the tool budget
  assert.equal(sawAbort, false);
});

test('REG-5: side-effecting tools must declare execution semantics', () => {
  const r = new ToolRegistry();
  assert.throws(
    () => r.register({
      id: 'w1', name: 'W', handler: () => {}, sideEffect: true,
      requiresConfirmation: true // missing idempotent/supportsAbort
    }),
    /idempotent and supportsAbort/
  );
  // Declared descriptors register fine.
  r.register(sendNotificationTool(() => ({ queued: true })));
  const d = r.get('send_notification');
  assert.equal(d.idempotent, false);
  assert.equal(d.supportsAbort, true);
});
