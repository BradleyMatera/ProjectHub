'use strict';

// Scout Action Runtime V1 — registry, executor, permission policy,
// confirmation gate, audit trail, provenance, and default capabilities.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ToolRegistry } = require('../lib/tool-registry');
const {
  ToolExecutor, PermissionPolicy, ActionAudit, WorkflowState, ERROR_TYPES
} = require('../lib/tool-executor');
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
    deadlineMs: opts.deadlineMs ?? 15000
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

test('EXEC-3: admin scope bypasses individual scopes', async () => {
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['admin'], canConfirm: true })
  });
  const res = await ex.execute('send_notification',
    { recipient: 'a@b.co', subject: 's', body: 'b' },
    { knowledge: KB, confirmationToken: 'tok-1' });
  assert.equal(res.status, 'ok');
});

test('EXEC-4: side-effecting tool refused without confirmation token', async () => {
  const ex = executor(buildToolRegistry(), {
    policy: new PermissionPolicy({ scopes: ['action:write'], canConfirm: true })
  });
  const res = await ex.execute('send_notification',
    { recipient: 'a@b.co', subject: 's', body: 'b' }, { knowledge: KB });
  assert.equal(res.errorType, ERROR_TYPES.CONFIRMATION_REQUIRED);
});

test('EXEC-5: confirmation without canConfirm is refused', async () => {
  const res = await executor().execute('send_notification',
    { recipient: 'a@b.co', subject: 's', body: 'b' },
    { knowledge: KB, confirmationToken: 'tok' });
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

test('EXEC-8: execution error is contained, not thrown', async () => {
  const r = new ToolRegistry();
  r.register({
    id: 'boom', name: 'Boom', permissionScope: 'compute',
    handler: () => { throw new Error('kaboom'); }
  });
  const res = await executor(r).execute('boom', {}, {});
  assert.equal(res.status, 'error');
  assert.equal(res.errorType, ERROR_TYPES.EXECUTION_ERROR);
  assert.match(res.error, /kaboom/);
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

test('CAP-6: send_notification executes with confirmation and returns TOOL_RESULT', async () => {
  let delivered = null;
  const registry = new ToolRegistry();
  registry.register(sendNotificationTool(args => { delivered = args; return { queued: true }; }));
  const ex = executor(registry, { canConfirm: true });
  const res = await ex.execute('send_notification',
    { recipient: 'ops@x.co', subject: 's', body: 'b' },
    { knowledge: KB, confirmationToken: 'confirm-1' });
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
