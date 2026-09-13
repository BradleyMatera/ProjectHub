/**
 * Deterministic arithmetic / general-reasoning fact extraction.
 *
 * This is a tool, not a writer: it scans user text for arithmetic or
 * simple quantity-reasoning subtasks and returns computed facts. The
 * model still owns all visible prose — these results are injected into
 * the evidence packet / control result so the model can state them.
 *
 * No answer strings or phrase tables are hardcoded here; only generic
 * operator/quantity grammar is recognized.
 */

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000
};

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?|' + Object.keys(NUMBER_WORDS).join('|') + ')';

// Operator vocabulary for binary expressions: symbol or word forms.
const OP_TOKENS = [
  [/^[+]$/, '+'], [/^(?:plus|added to)$/, '+'],
  [/^-$/, '-'], [/^(?:minus|subtract|subtracted)$/, '-'],
  [/^[*x×]$/, '*'], [/^(?:times|multiplied by)$/, '*'],
  [/^[/÷]$/, '/'], [/^divided by$/, '/'],
  [/^\^$/, '^'], [/^to the power of$/, '^'],
  [/^%$/, '%'], [/^(?:mod|modulo)$/, '%']
];
const OP_ALT = '\\+|\\-|\\*|x|×|/|÷|\\^|%|plus|minus|times|multiplied by|divided by|added to|subtracted?|mod(?:ulo)?|to the power of';

// Quantity-change verbs for word problems.
const REMOVE_VERB = /(?:closes?|loses?|lost|spends?|spent|uses?|used|removes?|sells?|sold|eats?|ate|completes?|finished|finishes|resolves?|resolved|pays?|paid|deletes?|drops?|gives? away|gave away|breaks?|broke|crosses? off|checks? off)\b/i;
const ADD_VERB = /(?:gets?|got|gains?|earns?|receives?|buys?|bought|finds?|found|adds?|collects?|wins?|won|acquires?|purchases?|picks? up|makes?|saves?)\b/i;
const HOLD_VERB = /(?:has|have|had|starts? with|begins? with|starts? off with|owns?|holds?|carries|keeps?|is given|was given|gets? dealt)\b/i;

function parseNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/,/g, '').trim();
  if (NUMBER_WORDS[s] != null) return NUMBER_WORDS[s];
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function applyOp(a, sym, b) {
  switch (sym) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? null : a / b;
    case '^': return Math.pow(a, b);
    case '%': return b === 0 ? null : a % b;
    default: return null;
  }
}

function resolveOp(token) {
  const t = String(token || '').toLowerCase();
  for (const [re, sym] of OP_TOKENS) if (re.test(t)) return sym;
  return null;
}

/**
 * Find arithmetic / quantity-reasoning subtasks in arbitrary user text.
 * @param {string} text user question (rewritten form is fine)
 * @returns {Array<{display:string, result:number, kind:string, index:number}>}
 */
function findArithmeticSubtasks(text) {
  const out = [];
  const src = String(text || '');
  if (!src) return out;

  // 1. Binary expressions: N <op> M — symbols or operator words, anywhere in
  //    the text (including mixed tenant + arithmetic questions).
  const binRe = new RegExp(NUM + '\\s*(' + OP_ALT + ')\\s*' + NUM, 'gi');
  let m;
  while ((m = binRe.exec(src)) !== null) {
    const a = parseNumber(m[1]);
    const b = parseNumber(m[3]);
    const sym = resolveOp(m[2]);
    if (a == null || b == null || sym == null) continue;
    const result = applyOp(a, sym, b);
    if (result == null || !Number.isFinite(result)) continue;
    out.push({ display: `${fmtNum(a)} ${sym} ${fmtNum(b)}`, result, kind: 'expression', index: m.index });
  }

  // 2. Quantity word problems: "has N <items> and <removal|addition verb> M".
  const wordRe = new RegExp(
    HOLD_VERB.source + '\\s+' + NUM +
    '((?:\\s+[a-z][a-z-]*){0,5})\\s*(?:,\\s*)?(?:and\\s+|then\\s+|,\\s*)?' +
    '(' + REMOVE_VERB.source + '|' + ADD_VERB.source + ')\\s+' + NUM,
    'gi'
  );
  while ((m = wordRe.exec(src)) !== null) {
    const a = parseNumber(m[1]);
    const verb = m[3];
    const b = parseNumber(m[4]);
    if (a == null || b == null) continue;
    const sym = REMOVE_VERB.test(verb) ? '-' : '+';
    const result = applyOp(a, sym, b);
    if (result == null || !Number.isFinite(result)) continue;
    // Word problems need a result cue so declarative statements like
    // "has 3 projects and uses 2 frameworks" are not misread as math tasks.
    if (!/\b(?:how many|how much|remains?|remaining|left|total|altogether|in all|tell me|what(?:'s| is| does| do| would| will)|now have|now has)\b/i.test(src)) continue;
    if (out.some(f => Math.abs(f.index - m.index) < 4)) continue;
    out.push({ display: `${fmtNum(a)} ${sym} ${fmtNum(b)}`, result, kind: 'word_problem', index: m.index });
  }

  return out;
}

/**
 * Compact "a op b = r" text used inside evidence packets.
 */
function formatComputedFacts(facts) {
  return (facts || []).map(f => `${f.display} = ${fmtNum(f.result)}`).join('; ');
}

// English surface forms for results so "fifty-six" satisfies "56" in
// completeness checks. Bounded to a practical range; beyond it only the
// digit form is offered.
const _UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const _TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n) {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 9999) return null;
  if (n < 20) return _UNITS[n];
  if (n < 100) {
    const u = n % 10;
    return u ? `${_TENS[Math.floor(n / 10)]}-${_UNITS[u]}` : _TENS[n / 10];
  }
  if (n < 1000) {
    const r = n % 100;
    return r ? `${_UNITS[Math.floor(n / 100)]} hundred ${numberToWords(r)}` : `${_UNITS[n / 100]} hundred`;
  }
  const r = n % 1000;
  return r ? `${_UNITS[Math.floor(n / 1000)]} thousand ${numberToWords(r)}` : `${_UNITS[n / 1000]} thousand`;
}

/**
 * Surface forms a model may legitimately use to state a computed result:
 * the digit form plus its English rendering (with and without hyphen).
 */
function resultSurfaceForms(n) {
  const forms = [fmtNum(n)];
  const words = numberToWords(n);
  if (words) {
    forms.push(words);
    if (words.includes('-')) forms.push(words.replace('-', ' '));
  }
  return forms;
}

/**
 * Does the user text ask for a computed result? Used to decide whether the
 * answer must state the tool's output.
 */
function asksForComputedResult(text) {
  return /\b(?:what|how many|how much|equals?|tell me|calculate|compute|solve|remains?|remaining|left|total|altogether|work out|figure out)\b/i.test(String(text || ''));
}

module.exports = { findArithmeticSubtasks, formatComputedFacts, resultSurfaceForms, asksForComputedResult, numberToWords };
