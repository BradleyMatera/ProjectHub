const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server-gemini.js'), 'utf8');
const route = source.slice(source.indexOf("app.post('/api/chat',"), source.indexOf('// Flush stats after each request'));

function harness(serverFlag, direct = false) {
  let handler;
  const cache = new Map();
  const context = {
    app: { post: (_, callback) => { handler = callback; } },
    process: { env: { SCOUT_GATE_DEBUG: serverFlag } },
    console: { error() {} },
    setTimeout, clearTimeout, AbortController,
    extractReferrer: () => '',
    getConversationHistory: () => [],
    fetchKnowledge: async () => ({}),
    sessionState: { getState: () => ({}), updateState() {}, applyControlIntent() {} },
    SCOUT_AGENT_MODE: 'lite',
    localModelRouter: { inferenceProvider: 'cloudflare', agentModel: () => 'fixture-model' },
    getStanceContext: () => '',
    understandQuery: () => ({}),
    ragChunks: [],
    bm25Index: null,
    runRagPrimaryAgent: async () => ({ reply: 'Generated fixture.', model: 'fixture-model', steps: [], proseSource: 'MODEL_GENERATION' }),
    shapeReply: reply => reply,
    stanceStore: new Map(),
    detectVisitorIntent: () => 'fixture',
    trackSession() {},
    RESPONSE_CACHE_LIMIT: 200,
    classifyResponsePolicy: () => ({ mode: 'GREETING' }),
    normalizeQuery: q => q,
    SCOUT_AGENT_ENGINE_ENABLED: true,
    DIRECT_KB_ENABLED: direct,
    findDirectAnswer: () => ({ intents: ['direct'], answer: 'Verified fixture.' }),
    buildResponseContract: () => ({ intent: 'PROFILE' }),
    responseCache: cache,
    RESPONSE_CACHE_MS: 60000,
    CONVERSATION_MAX_TURNS: 10,
    rememberConversation() {},
    recordRequest() {},
    safeContractProjection: () => null
  };
  vm.runInNewContext(route, context);
  return {
    cache,
    setFlag(value) { context.process.env.SCOUT_GATE_DEBUG = value; },
    async request(body = {}, query = {}) {
      let payload;
      const res = {
        headersSent: false,
        status() { return this; },
        set() { return this; },
        json(value) { payload = JSON.parse(JSON.stringify(value)); this.headersSent = true; return value; }
      };
      await handler({ body: { message: 'hello', sessionId: 'fixture', ...body }, query }, res);
      return payload;
    }
  };
}

for (const flag of [undefined, 'false']) {
  for (const [label, body, query] of [['body', { gateDebug: true }, {}], ['query', {}, { gateDebug: '1' }]]) {
    test(`public ${label} debug request with server flag ${flag} cannot expose diagnostics or bypass cache`, async () => {
      const app = harness(flag);
      app.cache.set('hello', { ts: Date.now(), payload: { reply: 'Cached fixture.', proseSource: 'MODEL_GENERATION' } });
      const result = await app.request(body, query);
      assert.equal(result.diagnostics, undefined);
      assert.equal(result.cached, true);
      assert.equal(result.reply, 'Cached fixture.');
    });
  }
}

test('server authorization alone does not enable per-request diagnostics', async () => {
  const app = harness('true', true);
  const result = await app.request();
  assert.equal(result.diagnostics, undefined);
});

for (const [label, body, query, direct] of [
  ['body/direct', { gateDebug: true }, {}, true],
  ['query/direct', {}, { gateDebug: '1' }, true],
  ['body/generated', { gateDebug: true }, {}, false],
  ['query/generated', {}, { gateDebug: '1' }, false]
]) {
  test(`authorized ${label} diagnostic response cannot contaminate the shared cache`, async () => {
    const app = harness('true', direct);
    const result = await app.request(body, query);
    assert.equal(result.ok, true);
    assert.equal(result.reply, direct ? 'Verified fixture.' : 'Generated fixture.');
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics.question, 'hello');
    assert.equal(app.cache.size, 0);
    app.setFlag('false');
    const normal = await app.request();
    assert.equal(normal.diagnostics, undefined);
    assert.equal(app.cache.get('hello').payload.diagnostics, undefined);
  });
}

test('both generated and direct response cache writes exclude authorized debug turns', () => {
  const writes = [...route.matchAll(/if \(!hasHistory([^)]*)\) \{\s*responseCache\.set/g)];
  assert.equal(writes.length, 2);
  for (const write of writes) assert.match(write[1], /&& !gateDebug/);
});

test('dead timeout wrappers are absent and the actual 15-second deadline remains', () => {
  assert.doesNotMatch(source, /\b(?:CHAT_GENERATION_BUDGET_MS|CHAT_RESPONSE_BUDGET_MS|resolveWithin)\b/);
  assert.match(source, /const REQUEST_DEADLINE_MS = Math\.min\(parseInt\(process\.env\.REQUEST_DEADLINE_MS \|\| '15000', 10\), 15000\)/);
});
