'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');

test('generated widget matches the canonical source modules', () => {
  const root = path.join(__dirname, '..');
  const normalize = text => text.replace(/\r\n/g, '\n');
  const expected = ['data.js', 'utils.js', 'logic.js', 'ui.js']
    .map(file => normalize(fs.readFileSync(path.join(root, file), 'utf8'))).join('\n');
  assert.equal(normalize(fs.readFileSync(path.join(root, 'ProjectHub.js'), 'utf8')), expected);
});

function initializerHarness(setup) {
  const events = new Map();
  const errors = [];
  const context = vm.createContext({
    window: {},
    document: { readyState: 'loading', addEventListener: (name, handler) => events.set(name, handler) },
    console: { error: (...args) => errors.push(args) },
    AbortController,
    projects: [], codePens: [], suggestions: [], handleQuery() {}, fetchAllGitHubData() {}
  });
  vm.runInContext(source, context);
  context.setupChatUI = () => setup(context);
  return { context, errors, events };
}

test('initializer runs once across explicit calls and the pending DOM ready callback', () => {
  let calls = 0;
  const { context, events } = initializerHarness(() => { calls += 1; });
  assert.equal(calls, 0);
  context.window.initProjectHub();
  context.window.initProjectHub();
  events.get('DOMContentLoaded')();
  assert.equal(calls, 1);
  assert.equal(context.window.__projectHubInitialized, true);
  assert.equal(context.window.__projectHubInitializing, false);
});

test('initializer guards reentry without claiming success during setup', () => {
  let calls = 0;
  const states = [];
  const { context } = initializerHarness(ctx => {
    calls += 1;
    states.push([Boolean(ctx.window.__projectHubInitialized), ctx.window.__projectHubInitializing]);
    ctx.window.initProjectHub();
  });
  context.window.initProjectHub();
  assert.equal(calls, 1);
  assert.deepEqual(states, [[false, true]]);
  assert.equal(context.window.__projectHubInitialized, true);
  assert.equal(context.window.__projectHubInitializing, false);
});

test('initializer logs setup failure and allows a successful retry', () => {
  let calls = 0;
  const failure = new Error('setup failure');
  const { context, errors } = initializerHarness(() => {
    if (++calls === 1) throw failure;
  });
  context.window.initProjectHub();
  assert.equal(context.window.__projectHubInitialized, false);
  assert.equal(context.window.__projectHubInitializing, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], failure);
  context.window.initProjectHub();
  context.window.initProjectHub();
  assert.equal(calls, 2);
  assert.equal(context.window.__projectHubInitialized, true);
});

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

async function browserHarness(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent('<!doctype html><html><head><style id="host-style">body { margin: 0; }</style></head><body><main id="host-content">Host page</main></body></html>');
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.evaluate(() => {
    window.projects = [];
    window.codePens = [];
    window.suggestions = [];
    window.fetchAllGitHubData = async () => [];
    window.queryCalls = [];
    window.handleQuery = async query => {
      window.queryCalls.push(query);
      return { reply: 'Unique regression response.', newTopic: 'projects' };
    };
    window.initErrors = [];
    console.error = (...args) => window.initErrors.push(args.map(String));
    window.readyEvents = 0;
    document.addEventListener('DOMContentLoaded', () => { window.readyEvents += 1; });
    const matchMedia = window.matchMedia.bind(window);
    window.mediaQueries = [];
    window.matchMedia = query => {
      const media = matchMedia(query);
      window.mediaQueries.push(media);
      return media;
    };
  });
  const session = await page.context().newCDPSession(page);
  async function listenerCount(expression, type) {
    const { result } = await session.send('Runtime.evaluate', { expression });
    const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.filter(listener => listener.type === type).length;
  }
  return { page, listenerCount };
}

async function assertWorkingWidget(page, listenerCount) {
  assert.equal(await page.locator('#bradley-chat').count(), 1);
  assert.equal(await page.locator('#projecthub-chat-styles').count(), 1);
  assert.equal(await listenerCount('document.querySelector(".projecthub-composer")', 'submit'), 1);
  assert.equal(await listenerCount('window', 'resize'), 1);
  await page.locator('#chat-input').fill('Tell me about ProjectHub');
  await page.locator('.send-button').click();
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#chat-output .bot-row');
    return rows.length === 2 && rows[1].querySelector('.message-content').textContent === 'Unique regression response.';
  });
  assert.deepEqual(await page.evaluate(() => window.queryCalls), ['Tell me about ProjectHub']);
  assert.equal(await page.locator('#chat-output .user-row').count(), 1);
  assert.equal(await page.locator('#chat-output .bot-row').count(), 2);
  assert.equal(await page.locator('#host-content').textContent(), 'Host page');
  assert.equal(await page.locator('#host-style').count(), 1);
  assert.equal(await page.evaluate(() => window.__projectHubInitialized), true);
  assert.equal(await page.evaluate(() => window.__projectHubInitializing), false);
}

const browserOptions = { skip: !chromium && 'Playwright is optional; install the existing QA browser tooling to run real-DOM coverage' };

async function delayedReplyHarness(t) {
  const harness = await browserHarness(t);
  const { page } = harness;
  await page.clock.install();
  await page.evaluate(() => {
    window.replyResolvers = [];
    window.handleQuery = query => {
      window.queryCalls.push(query);
      return new Promise(resolve => window.replyResolvers.push(resolve));
    };
  });
  await page.addScriptTag({ content: source });
  await page.clock.runFor(6000);
  return harness;
}

async function resolveReply(page, index, reply) {
  await page.evaluate(({ index, reply }) => {
    window.replyResolvers[index]({ reply, newTopic: 'projects' });
  }, { index, reply });
}

async function scrollMetrics(page) {
  return page.locator('#chat-output').evaluate(output => ({
    top: output.scrollTop,
    height: output.scrollHeight,
    gap: output.scrollHeight - output.clientHeight - output.scrollTop
  }));
}

const longReply = Array.from({ length: 24 }, (_, index) => `<p>Regression paragraph ${index}: a sufficiently long response for checking the scroll position.</p>`).join('');

async function scrollHarness(t) {
  const harness = await delayedReplyHarness(t);
  const { page } = harness;
  await page.locator('#chat-input').fill('Tell me about ProjectHub');
  await page.locator('.send-button').click();
  await resolveReply(page, 0, longReply);
  await page.clock.runFor(30000);
  assert.equal(await page.locator('.send-button').isEnabled(), true);
  assert.ok((await scrollMetrics(page)).height > 1000);
  return harness;
}

test('composer remains editable and preserves a newer draft when a delayed response arrives', browserOptions, async t => {
  const { page } = await delayedReplyHarness(t);
  const input = page.locator('#chat-input');
  await input.fill('Tell me about ProjectHub');
  await page.locator('.send-button').click();
  await page.clock.runFor(1000);
  assert.equal(await input.isEnabled(), true);
  assert.equal(await page.locator('.send-button').isDisabled(), true);
  await input.fill('What AWS experience');
  await input.press('End');
  await input.pressSequentially(' does Bradley have?');
  const draft = await input.inputValue();
  assert.equal(draft, 'What AWS experience does Bradley have?');
  await resolveReply(page, 0, 'First delayed response.');
  await page.clock.runFor(2000);
  assert.equal(await input.inputValue(), draft);
  assert.equal(await page.locator('.send-button').isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.queryCalls), ['Tell me about ProjectHub']);
});

test('composer queues Enter after cooldown and submits it without overwriting a newer draft', browserOptions, async t => {
  const { page, listenerCount } = await delayedReplyHarness(t);
  const input = page.locator('#chat-input');
  await input.fill('Tell me about ProjectHub');
  await page.locator('.send-button').click();
  await page.clock.runFor(1000);
  await input.fill('What AWS experience does Bradley have?');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '');
  assert.match(await input.getAttribute('placeholder'), /queued/);
  assert.deepEqual(await page.evaluate(() => window.queryCalls), ['Tell me about ProjectHub']);
  await input.fill('How can I contact Bradley?');
  await resolveReply(page, 0, 'First delayed response.');
  await page.clock.runFor(2000);
  assert.deepEqual(await page.evaluate(() => window.queryCalls), ['Tell me about ProjectHub', 'What AWS experience does Bradley have?']);
  assert.equal(await input.inputValue(), 'How can I contact Bradley?');
  assert.equal(await input.isEnabled(), true);
  assert.equal(await listenerCount('document.querySelector("#chat-input")', 'keydown'), 1);
  await resolveReply(page, 1, 'Second delayed response.');
  await page.clock.runFor(2000);
  assert.equal(await input.inputValue(), 'How can I contact Bradley?');
  assert.equal(await page.locator('#chat-output .user-row').count(), 2);
  assert.equal(await page.locator('#chat-output .bot-row').count(), 3);
  assert.equal(await page.locator('.send-button').isEnabled(), true);
});

test('scroll follows a tall inserted message when the reader starts near the bottom', browserOptions, async t => {
  const { page } = await scrollHarness(t);
  await page.locator('#chat-input').fill(`Tell me about ProjectHub\n${'An additional project question with detail.\n'.repeat(20)}`);
  await page.locator('#chat-output').evaluate(output => {
    output.scrollTo({ top: output.scrollHeight - output.clientHeight - 60, behavior: 'instant' });
  });
  const before = await scrollMetrics(page);
  assert.ok(before.gap >= 59 && before.gap <= 61);
  await page.locator('#chat-input').press('Enter');
  await page.clock.runFor(1000);
  const after = await scrollMetrics(page);
  assert.ok(after.height > before.height + 200);
  assert.ok(after.gap <= 2, `Expected to follow the inserted message, gap=${after.gap}`);
});

test('scroll follows large streamed response growth when already at the bottom', browserOptions, async t => {
  const { page } = await scrollHarness(t);
  await page.locator('#chat-input').fill('What AWS experience does Bradley have?');
  await page.locator('.send-button').click();
  await page.locator('#chat-output').evaluate(output => {
    output.scrollTo({ top: output.scrollHeight, behavior: 'instant' });
  });
  const before = await scrollMetrics(page);
  await resolveReply(page, 1, `<p style="min-height: 240px">Large response section</p>${longReply}`);
  await page.clock.runFor(30000);
  const after = await scrollMetrics(page);
  assert.ok(after.height > before.height + 1000);
  assert.ok(after.gap <= 2, `Expected to follow streamed growth, gap=${after.gap}`);
});

test('scroll preserves a manually chosen position while a long response keeps growing', browserOptions, async t => {
  const { page } = await scrollHarness(t);
  await page.locator('#chat-input').fill('What AWS experience does Bradley have?');
  await page.locator('.send-button').click();
  await resolveReply(page, 1, longReply);
  await page.clock.runFor(1500);
  await page.locator('#chat-output').evaluate(output => {
    output.scrollTo({ top: 100, behavior: 'instant' });
  });
  const before = await scrollMetrics(page);
  await page.clock.runFor(4000);
  const during = await scrollMetrics(page);
  assert.ok(during.height > before.height + 100);
  assert.ok(Math.abs(during.top - before.top) <= 2, `Manual scroll moved from ${before.top} to ${during.top}`);
  await page.clock.runFor(30000);
  const after = await scrollMetrics(page);
  assert.ok(after.height > during.height + 100);
  assert.ok(Math.abs(after.top - before.top) <= 2, `Manual scroll moved from ${before.top} to ${after.top}`);
});

test('dynamic injection after DOM ready and duplicate init produce one real submit handler and response', browserOptions, async t => {
  const { page, listenerCount } = await browserHarness(t);
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.initProjectHub();
    window.initProjectHub();
  });
  assert.equal(await page.evaluate(() => window.readyEvents), 0);
  assert.deepEqual(await page.evaluate(() => window.initErrors), []);
  await assertWorkingWidget(page, listenerCount);
});

test('real setup ignores synchronous reentry during widget insertion', browserOptions, async t => {
  const { page, listenerCount } = await browserHarness(t);
  await page.evaluate(() => {
    const appendChild = document.body.appendChild;
    document.body.appendChild = function(node) {
      if (node.id === 'bradley-chat') {
        window.stateDuringSetup = [Boolean(window.__projectHubInitialized), window.__projectHubInitializing];
        window.initProjectHub();
      }
      return appendChild.call(this, node);
    };
  });
  await page.addScriptTag({ content: source });
  assert.deepEqual(await page.evaluate(() => window.stateDuringSetup), [false, true]);
  await assertWorkingWidget(page, listenerCount);
});

for (const failurePoint of ['widget insertion', 'suggestion rendering after listener registration']) {
  test(`real setup rolls back ${failurePoint} failure before retry`, browserOptions, async t => {
    const { page, listenerCount } = await browserHarness(t);
    await page.evaluate(point => {
      function fail() {
        window.failedWidget = document.getElementById('bradley-chat');
        window.failedComposer = window.failedWidget.querySelector('.projecthub-composer');
        window.failedMedia = window.mediaQueries.at(-1);
        throw new Error('Injected partial setup failure');
      }
      if (point === 'widget insertion') {
        const appendChild = document.body.appendChild;
        document.body.appendChild = function(node) {
          const result = appendChild.call(this, node);
          if (node.id === 'bradley-chat') {
            document.body.appendChild = appendChild;
            fail();
          }
          return result;
        };
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        Object.defineProperty(Element.prototype, 'innerHTML', {
          ...descriptor,
          set(value) {
            if (this.classList.contains('projecthub-suggestions')) {
              Object.defineProperty(Element.prototype, 'innerHTML', descriptor);
              fail();
            }
            descriptor.set.call(this, value);
          }
        });
      }
    }, failurePoint);
    await page.addScriptTag({ content: source });
    assert.match((await page.evaluate(() => window.initErrors))[0].join(' '), /Injected partial setup failure/);
    assert.equal(await page.locator('#bradley-chat').count(), 0);
    assert.equal(await page.locator('#projecthub-chat-styles').count(), 0);
    assert.equal(await listenerCount('window', 'resize'), 0);
    assert.equal(await listenerCount('window.failedComposer', 'submit'), 0);
    assert.equal(await listenerCount('window.failedMedia', 'change'), 0);
    assert.deepEqual(await page.evaluate(() => [window.__projectHubInitialized, window.__projectHubInitializing]), [false, false]);
    await page.evaluate(() => {
      window.initProjectHub();
      window.initProjectHub();
    });
    await assertWorkingWidget(page, listenerCount);
    assert.equal(await page.evaluate(() => window.failedWidget.isConnected), false);
    assert.equal(await page.evaluate(() => window.initErrors.length), 1);
  });
}
