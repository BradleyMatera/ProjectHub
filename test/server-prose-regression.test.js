const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * Static architecture regression test: scans ALL runtime JS files (not test
 * fixtures) for hardcoded recruiter-facing answer prose embedded in executable
 * source.
 *
 * Allowed in runtime JS:
 *   - Generic prompt instructions (system prompts, generation instructions)
 *   - Technical error messages (typed error codes, INFERENCE_UNAVAILABLE, etc.)
 *   - Enum labels / validation reason strings
 *   - Logging statements
 *   - Generic structural patterns (return { intent: ... }, return null, etc.)
 *
 * Flagged in runtime JS:
 *   - reply = "..." / reply: `...` with recruiter prose
 *   - answer = "..." with recruiter prose
 *   - return "No verified..." / return `${subject} has..." / return `${subject} should..."
 *   - return `He is a junior..." / return `She has experience..."
 *   - Hardcoded follow-up question strings tied to a specific tenant
 *   - Hardcoded entity lists (specific company names, specific tech names)
 *   - Hardcoded role-fit verdicts ("would be a strong fit", "not recommended")
 *
 * Files excluded: test files, node_modules, dist, data JSON, analytics dist
 */

const RUNTIME_EXCLUDES = new Set([
  'node_modules',
  'analytics',
  'dist',
  'test',
  'tests',
  'coverage',
  '.git',
  '.scout-finalization-snapshots',
  '.scout-experiment-snapshots',
  'scripts',
  'data',
]);

// Client-side widget files that legitimately contain Bradley's name (it's his portfolio)
const CLIENT_WIDGET_FILES = new Set([
  'ProjectHub.js',
  'logic.js',
  'ui.js',
  'data.js',
  'utils.js',
]);

const FILE_EXCLUDE_PATTERNS = [
  /test[-.]/i,
  /\.test\./i,
  /_refactor/i,
  /eval-/i,
  /test-full-flow/i,
  /original-claim/i,
];

function isRuntimeJs(filePath) {
  if (!filePath.endsWith('.js')) return false;
  const parts = filePath.split(path.sep);
  for (const exc of RUNTIME_EXCLUDES) {
    if (parts.includes(exc)) return false;
  }
  for (const pattern of FILE_EXCLUDE_PATTERNS) {
    if (pattern.test(filePath)) return false;
  }
  // Exclude client-side widget files (legitimately contain Bradley's name)
  if (CLIENT_WIDGET_FILES.has(path.basename(filePath))) return false;
  return true;
}

function collectRuntimeJs(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeJs(fullPath, acc);
    } else if (entry.isFile() && isRuntimeJs(fullPath)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

// Patterns that indicate recruiter-facing answer prose in executable code.
// These are suspicious constructs that require review.
const PROSE_PATTERNS = [
  // return "No verified evidence shows..."
  { re: /return\s+["'`]No verified evidence shows/i, label: 'return "No verified evidence shows..."' },
  // return `${subject} has...` / return `${subject} should...`
  { re: /return\s+[`"]\$\{.*\}\s+(has|should|is|worked|built|knows|does not|can)/i, label: 'return `${subject} has/should/is...`' },
  // reply = "..." or reply: `...` with prose (not just variable assignment)
  { re: /reply\s*=\s*["'`](?:He|She|They)\s+(is|has|worked|built|knows|can)/i, label: 'reply = "He/She/They is/has..."' },
  // answer = "..." with prose
  { re: /answer\s*=\s*["'`](?:He|She|They)\s+(is|has|worked|built|knows|can)/i, label: 'answer = "He/She/They is/has..."' },
  // Hardcoded follow-up question strings (tenant-specific)
  { re: /["'`](?:What (tech stack|certifications|projects|AWS)|Tell me about (his|her))/i, label: 'hardcoded follow-up question' },
  // Hardcoded role-fit verdicts
  { re: /["'`](?:would be a strong fit|not recommended|good fit for|great candidate for)/i, label: 'hardcoded role-fit verdict' },
  // return `He is a junior software engineer...`
  { re: /return\s+[`]"He is a junior/i, label: 'return "He is a junior..."' },
  // return `She has experience with...`
  { re: /return\s+[`]"She has experience/i, label: 'return "She has experience..."' },
];

// Specific Bradley-tenant terms that should never appear in runtime JS
// (except in data files, test fixtures, or knowledge-access which reads from data)
const TENANT_SPECIFIC_TERMS = [
  'bradley matera', 'bradley matera\'s', 'davis, illinois', 'full sail',
  'mason county kitten rescue', 'projecthub chat', 'ciris project',
];

// Files allowed to contain tenant-specific terms (they read from data or config)
const TENANT_TERM_ALLOWED = new Set([
  'knowledge-access.js',
  'scout-identity.js',
  'session-state.js',
  'conversation-resolver.js',
]);

test('PROSE-REGRESSION: No recruiter-facing answer prose in runtime JS', () => {
  const root = path.resolve(__dirname, '..');
  const files = collectRuntimeJs(root);

  assert.ok(files.length > 0, 'Should find runtime JS files');

  const violations = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comments
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      for (const { re, label } of PROSE_PATTERNS) {
        if (re.test(line)) {
          violations.push({
            file: path.relative(root, file),
            line: i + 1,
            label,
            content: trimmed.slice(0, 120),
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    const msg = violations.map(v =>
      `  ${v.file}:${v.line} [${v.label}] ${v.content}`
    ).join('\n');
    assert.fail(`Found ${violations.length} suspicious prose constructs in runtime JS:\n${msg}`);
  }
});

test('PROSE-REGRESSION: No Bradley-tenant-specific terms in runtime JS (except data readers)', () => {
  const root = path.resolve(__dirname, '..');
  const files = collectRuntimeJs(root);

  const violations = [];

  for (const file of files) {
    const basename = path.basename(file);
    if (TENANT_TERM_ALLOWED.has(basename)) continue;

    const content = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const term of TENANT_SPECIFIC_TERMS) {
      if (content.includes(term.toLowerCase())) {
        // Find the line
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(term.toLowerCase())) {
            // Skip comments
            const originalLines = fs.readFileSync(file, 'utf8').split('\n');
            const origTrimmed = originalLines[i]?.trim() || '';
            if (origTrimmed.startsWith('//') || origTrimmed.startsWith('/*') || origTrimmed.startsWith('*')) continue;
            violations.push({
              file: path.relative(root, file),
              line: i + 1,
              term,
              content: origTrimmed.slice(0, 120),
            });
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    const msg = violations.map(v =>
      `  ${v.file}:${v.line} [term: "${v.term}"] ${v.content}`
    ).join('\n');
    assert.fail(`Found ${violations.length} Bradley-tenant-specific terms in runtime JS:\n${msg}`);
  }
});

test('PROSE-REGRESSION: server-gemini.js does not author recruiter answers', () => {
  const serverPath = path.resolve(__dirname, '..', 'server-gemini.js');
  const content = fs.readFileSync(serverPath, 'utf8');

  // The server must not contain functions that construct recruiter-facing prose
  const FORBIDDEN_PATTERNS = [
    { re: /function\s+buildSkillReply/i, label: 'buildSkillReply function' },
    { re: /function\s+buildGroundedFallback\b/i, label: 'buildGroundedFallback function' },
    { re: /function\s+buildContextualGroundedReply/i, label: 'buildContextualGroundedReply function' },
    { re: /function\s+handleRoleFit/i, label: 'handleRoleFit function' },
    { re: /function\s+analyzeRoleFit/i, label: 'analyzeRoleFit function' },
    { re: /function\s+concisePitch/i, label: 'concisePitch function' },
    { re: /function\s+generateWithAgent/i, label: 'generateWithAgent function' },
    { re: /function\s+buildGroundedFallbackPayload/i, label: 'buildGroundedFallbackPayload function' },
    { re: /function\s+shouldUseGroundedAnswer/i, label: 'shouldUseGroundedAnswer function' },
    { re: /function\s+cleanModelReply/i, label: 'cleanModelReply function' },
    { re: /function\s+validateGenerative/i, label: 'validateGenerative function' },
    { re: /function\s+validateNetworkReply/i, label: 'validateNetworkReply function' },
    { re: /function\s+mustStayGrounded/i, label: 'mustStayGrounded function' },
    { re: /function\s+findTechnologyTopic/i, label: 'findTechnologyTopic function' },
    { re: /function\s+hasVerifiedTechnologyExperience/i, label: 'hasVerifiedTechnologyExperience function' },
    { re: /TECHNOLOGY_TOPICS\s*=/i, label: 'TECHNOLOGY_TOPICS array' },
    { re: /function\s+removeSlop/i, label: 'removeSlop function' },
    { re: /function\s+normalizeQuestion/i, label: 'normalizeQuestion function (moved to query-understanding)' },
    { re: /function\s+isProbablyRelevant/i, label: 'isProbablyRelevant function (moved to query-understanding)' },
    { re: /function\s+detectRepair/i, label: 'detectRepair function' },
    { re: /function\s+applyLocalAgentStyleWithOllama/i, label: 'applyLocalAgentStyleWithOllama function' },
    { re: /function\s+callOllamaRaw/i, label: 'callOllamaRaw function' },
    { re: /function\s+buildJudgePrompt/i, label: 'buildJudgePrompt function' },
    { re: /function\s+judgeLearnedAnswer/i, label: 'judgeLearnedAnswer function' },
  ];

  const violations = [];
  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(content)) {
      violations.push(label);
    }
  }

  if (violations.length > 0) {
    assert.fail(`server-gemini.js still contains forbidden functions/patterns:\n  ${violations.join('\n  ')}`);
  }
});

test('PROSE-REGRESSION: server-gemini.js has no hardcoded follow-up question strings', () => {
  const serverPath = path.resolve(__dirname, '..', 'server-gemini.js');
  const content = fs.readFileSync(serverPath, 'utf8');

  // The followUpMap should not exist with tenant-specific follow-up strings
  const followUpMapMatch = content.match(/followUpMap\s*=\s*\{/);
  if (followUpMapMatch) {
    // Check if it contains hardcoded question strings
    const blockEnd = content.indexOf('};', followUpMapMatch.index);
    const block = content.slice(followUpMapMatch.index, blockEnd + 2);
    if (/'What (tech|certif|project|AWS|skill|role|gap|strength|weakness)/i.test(block)) {
      assert.fail('server-gemini.js still contains hardcoded follow-up question strings in followUpMap');
    }
  }
});

test('PROSE-REGRESSION: server-gemini.js AGENT_ENGINE_UNAVAILABLE on disabled engine', () => {
  const serverPath = path.resolve(__dirname, '..', 'server-gemini.js');
  const content = fs.readFileSync(serverPath, 'utf8');

  assert.ok(
    content.includes('AGENT_ENGINE_UNAVAILABLE'),
    'server-gemini.js must return AGENT_ENGINE_UNAVAILABLE when agent engine is disabled'
  );

  // Must not fall back to legacy chatbot prose when engine is disabled
  assert.ok(
    /SCOUT_AGENT_ENGINE_ENABLED[\s\S]*?AGENT_ENGINE_UNAVAILABLE/.test(content),
    'Should have a block that returns AGENT_ENGINE_UNAVAILABLE for disabled engine'
  );
});
