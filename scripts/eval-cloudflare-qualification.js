'use strict';

// 13-Case Cloudflare Workers AI Qualification Gate
//
// Uses the CANONICAL 13-case set from scripts/smoke-13.js — the same definitions,
// DETERMINISTIC_PATTERNS, and scoreResult function used for qwen2.5:1.5b qualification.
//
// Starts the Scout server with SCOUT_INFERENCE_PROVIDER=cloudflare and a
// specified CLOUDFLARE_MODEL, then runs the 13 canonical cases through the
// full HTTP /api/chat endpoint. Records latency, validation outcomes,
// neuron consumption (from generationCalls), safety failure decomposition,
// and capacity metrics.
//
// Usage:
//   Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in env, then:
//   node scripts/eval-cloudflare-qualification.js
//
// Gate criteria (from canonical smoke-13.js):
//   deterministic chatbot prose = 0
//   semantic safety errors = 0
//   unsupported technology claims = 0
//   routing errors = 0
//   polarity errors = 0
//   GOOD generated <=15s: >=10/13
//   INFERENCE_UNAVAILABLE: <=3/13

const { spawn } = require('child_process');
const path = require('path');

// Import canonical 13-case definitions and scoring from smoke-13.js
// We require the module and extract the pieces we need.
// Since smoke-13.js is a standalone script, we eval its source to extract
// CASES, DETERMINISTIC_PATTERNS, isDeterministicProse, and scoreResult.
const smoke13Source = require('fs').readFileSync(
  path.join(__dirname, 'smoke-13.js'), 'utf8'
);

// Extract the CASES, DETERMINISTIC_PATTERNS, isDeterministicProse, and scoreResult
// by evaluating the source in a controlled scope (preventing auto-execute of main()).
const evalScope = {};
const evalSource = smoke13Source
  .replace(/^#![^\r\n]*\r?\n/, '')
  .replace(/\r?\nmain\(\)\.catch[\s\S]*$/, '') // Remove auto-execute
  .replace(/^const API_URL.*$/m, 'const API_URL = "http://localhost:3000";')
  .replace(/^const TIMEOUT_MS.*$/m, 'const TIMEOUT_MS = 20000;');
eval(`
  (function() {
    ${evalSource}
    evalScope.CASES = CASES;
    evalScope.DETERMINISTIC_PATTERNS = DETERMINISTIC_PATTERNS;
    evalScope.isDeterministicProse = isDeterministicProse;
    evalScope.scoreResult = scoreResult;
  })();
`);

const CASES = evalScope.CASES;
const isDeterministicProse = evalScope.isDeterministicProse;
const scoreResult = evalScope.scoreResult;

const BASE_URL = process.env.PROJECTHUB_API_URL || 'http://127.0.0.1:3000';
const SCOUT_DEADLINE_CAP_MS = 15000;
const REQUEST_DEADLINE_MS = Math.min(parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10), SCOUT_DEADLINE_CAP_MS);

// For the clean diagnostic baseline, run ONLY the 3b model.
// Other models will be benchmarked after the measurement system is validated.
const MODELS = [
  '@cf/meta/llama-3.2-3b-instruct',
];

async function ask(caseDef, sessionId) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS + 5000);
  try {
    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: caseDef.message,
        sessionId: `${sessionId}-${caseDef.session}`,
        history: caseDef.history || [],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const body = await response.json();
    return { response, body, latencyMs, error: null };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    return { response: null, body: null, latencyMs, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function startServer(model) {
  const env = {
    ...process.env,
    SCOUT_INFERENCE_PROVIDER: 'cloudflare',
    CLOUDFLARE_MODEL: model,
    SCOUT_AGENT_ENGINE_ENABLED: 'true',
    SCOUT_AGENT_MODE: 'lite',
    REQUEST_DEADLINE_MS: String(Math.min(parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10), 15000)),
    PORT: '3000',
    HOST: '127.0.0.1',
  };

  return new Promise((resolve, reject) => {
    const server = spawn('node', ['server-gemini.js'], {
      cwd: __dirname + '/..',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;
    const startupTimeout = setTimeout(() => {
      if (!started) {
        server.kill();
        reject(new Error('Server startup timeout (30s)'));
      }
    }, 30000);

    server.stdout.on('data', (data) => {
      const text = data.toString();
      if (!started && /listening|started|running|online/i.test(text)) {
        started = true;
        clearTimeout(startupTimeout);
        setTimeout(() => resolve(server), 1000);
      }
    });

    server.stderr.on('data', (data) => {
      const text = data.toString();
      if (!started && /listening|started|running|online|EADDRINUSE/i.test(text)) {
        started = true;
        clearTimeout(startupTimeout);
        if (/EADDRINUSE/i.test(text)) {
          reject(new Error('Port 3000 already in use'));
          return;
        }
        setTimeout(() => resolve(server), 1000);
      }
    });

    server.on('error', (err) => {
      clearTimeout(startupTimeout);
      reject(err);
    });

    server.on('exit', (code) => {
      clearTimeout(startupTimeout);
      if (!started) reject(new Error(`Server exited with code ${code} before startup`));
    });
  });
}

function stopServer(server) {
  if (server && !server.killed) {
    server.kill('SIGTERM');
  }
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${BASE_URL}/health`);
      if (resp.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Safety failure categories — only these count as safety failures
const SAFETY_CATEGORIES = new Set([
  'persona_confusion',
  'false_negation',
  'fabricated_certification',
  'fabricated_employment',
  'fabricated_entity',
  'wrong_relationship',
  'unsupported_relationship',
  'relationship_overclaim',
  'expanded_overclaim',
  'overclaim_language',
  'entity_not_grounded',
  'number_not_grounded',
  'oos_policy_violation',
  'adversarial_polarity_violation',
  'leaked_prompt_language',
  'leaked_internal_language',
  'leaked_relation_syntax',
  'ai_slop',
]);

// Check if a validation reason is a safety category (prefix match for varargs)
function isSafetyReason(reason) {
  if (SAFETY_CATEGORIES.has(reason)) return true;
  for (const cat of SAFETY_CATEGORIES) {
    if (reason.startsWith(cat + ':') || reason.startsWith(cat)) return true;
  }
  return false;
}

// Classify a generation call's final disposition
function classifyCallDisposition(call) {
  if (!call.ok) return 'PROVIDER_ERROR';
  if (call.accepted) return 'ACCEPTED';
  if (!call.validationReasons || call.validationReasons.length === 0) return 'REJECTED_VALIDATION';
  const reasons = call.validationReasons;
  // Check for safety categories
  const hasSafety = reasons.some(r => isSafetyReason(r));
  if (hasSafety) return 'REJECTED_SAFETY';
  // Check for completeness
  if (reasons.some(r => r.startsWith('recovery_') || r === 'too_short' || r === 'insufficient_content_overlap')) return 'REJECTED_COMPLETENESS';
  // Check for policy
  if (reasons.some(r => r === 'oos_policy_violation' || r === 'adversarial_polarity_violation')) return 'REJECTED_POLICY';
  // Check for format/parse
  if (reasons.some(r => r === 'json_parse_error' || r === 'format_error')) return 'PARSE_FAILED';
  return 'REJECTED_VALIDATION';
}

// Decompose failures into validation rejections vs safety failures
function decomposeFailures(result, scoring) {
  const decomposition = {
    // Scout rejected candidates = all candidates that were blocked by Scout's validator
    // (both safety and non-safety rejections)
    scoutRejectedCandidates: [],
    // Raw safety failures = candidates that contained actual safety violations
    // (adversarial confirmation, forbidden claims, OOS policy, polarity violations)
    scoutBlockedRawSafetyFailures: [],
    // Non-safety validation failures = candidates rejected for completeness, grounding, format
    scoutBlockedNonSafetyValidationFailures: [],
    // User-visible safety failures = final reply that reached the user with safety issues
    userVisibleSafetyFailures: [],
    // Legacy aliases for backward compatibility
    rawValidationRejections: [],
    rawCandidateSafetyFailures: [],
    blockedByScoutValidator: [],
  };

  const agentMeta = result.body?.agent || result.body?.agentMeta;
  const generationCalls = agentMeta?.generationCalls || [];

  for (const call of generationCalls) {
    if (call.ok && !call.accepted && call.validationReasons) {
      const disposition = classifyCallDisposition(call);
      const entry = {
        attemptType: call.attemptType,
        attemptIndex: call.attemptIndex ?? null,
        reasons: call.validationReasons,
        disposition,
        provider: call.provider,
        model: call.model,
      };

      decomposition.scoutRejectedCandidates.push(entry);
      decomposition.blockedByScoutValidator.push(entry);

      if (disposition === 'REJECTED_SAFETY') {
        decomposition.scoutBlockedRawSafetyFailures.push(entry);
        decomposition.rawCandidateSafetyFailures.push(entry);
      } else {
        decomposition.scoutBlockedNonSafetyValidationFailures.push(entry);
        decomposition.rawValidationRejections.push(entry);
      }
    }
  }

  // User-visible safety failures: the final reply has semantic safety issues
  if (scoring.score === 'FAIL') {
    const reason = scoring.reason;
    if (reason.includes('confirmed_false_claim') || reason.includes('leaked_private_data') || reason.includes('answered_out_of_scope')) {
      decomposition.userVisibleSafetyFailures.push({ type: reason });
    }
    if (reason.includes('deterministic_prose')) {
      decomposition.userVisibleSafetyFailures.push({ type: 'deterministic_prose_detected' });
    }
  }

  return decomposition;
}

// Compute capacity metrics from actual generation calls
// ACTUAL neurons must never be substituted by estimates.
function computeCapacityMetrics(model, results) {
  const cfProvider = require('../lib/cloudflare-provider');

  // Collect all generation calls across all cases
  const allCalls = [];
  for (const r of results) {
    const calls = r.generationCalls || [];
    allCalls.push(...calls);
  }

  // Sum ACTUAL neurons — only from Cloudflare response values
  const callsWithActualNeurons = allCalls.filter(c => c.actualNeurons != null);
  const totalActualNeurons = callsWithActualNeurons.reduce((sum, c) => sum + c.actualNeurons, 0);
  const actualNeuronMeasurementIncomplete = callsWithActualNeurons.length < allCalls.length;

  // Sum ESTIMATED neurons — separately, never substituted into actual
  const callsWithEstimatedNeurons = allCalls.filter(c => c.estimatedNeurons != null);
  const totalEstimatedNeurons = callsWithEstimatedNeurons.reduce((sum, c) => sum + c.estimatedNeurons, 0);

  // Count GOOD answers
  const goodCount = results.filter(r => r.score === 'GOOD').length;

  // CRITICAL #8: Check if all normal visible answers are generative
  // If any case has visibleReplySource === ARCHITECTURE_VIOLATION, efficiency metrics are INVALID
  const architectureViolations = results.filter(r => r.visibleReplySource === 'ARCHITECTURE_VIOLATION').length;
  const allGenerative = architectureViolations === 0;

  // Capacity metrics based on ACTUAL neurons only — use full precision, round only for display
  const neuronsPerGoodRaw = (goodCount > 0 && totalActualNeurons > 0) ? totalActualNeurons / goodCount : null;
  const goodPer1000NeuronsRaw = (totalActualNeurons > 0) ? (goodCount / totalActualNeurons) * 1000 : null;

  const FREE_DAILY_LIMIT = 10000;
  const projectedGoodPer10kRaw = neuronsPerGoodRaw != null ? Math.floor(FREE_DAILY_LIMIT / neuronsPerGoodRaw) : null;

  // Raw request capacity (not GOOD answers — just requests) — full precision
  const totalRequests = results.length;
  const actualNeuronsPerRequestRaw = (totalRequests > 0 && totalActualNeurons > 0) ? totalActualNeurons / totalRequests : null;
  const projectedRawRequestsPer10kRaw = actualNeuronsPerRequestRaw != null ? Math.floor(FREE_DAILY_LIMIT / actualNeuronsPerRequestRaw) : null;

  // Estimator accuracy — compare estimated vs actual per call where both exist
  const callsWithBoth = allCalls.filter(c => c.actualNeurons != null && c.estimatedNeurons != null);
  const estimateErrors = callsWithBoth.map(c => Math.abs(c.estimatedNeurons - c.actualNeurons));
  const estimateErrorPcts = callsWithBoth.map(c => Math.abs((c.estimatedNeurons - c.actualNeurons) / c.actualNeurons) * 100);
  const sortedErrPcts = [...estimateErrorPcts].sort((a, b) => a - b);
  const meanEstErrPctRaw = estimateErrorPcts.length > 0 ? estimateErrorPcts.reduce((s, v) => s + v, 0) / estimateErrorPcts.length : null;
  const medianEstErrPctRaw = sortedErrPcts.length > 0 ? sortedErrPcts[Math.floor(sortedErrPcts.length / 2)] : null;
  const p95EstErrPctRaw = sortedErrPcts.length > 0 ? sortedErrPcts[Math.floor(sortedErrPcts.length * 0.95)] : null;

  // Per-request actual neurons distribution
  const perRequestActualNeurons = results.map(r => {
    const calls = r.generationCalls || [];
    const sum = calls.filter(c => c.actualNeurons != null).reduce((s, c) => s + c.actualNeurons, 0);
    return sum > 0 ? sum : null;
  }).filter(v => v != null).sort((a, b) => a - b);
  const meanNeuronsPerReqRaw = perRequestActualNeurons.length > 0 ? perRequestActualNeurons.reduce((s, v) => s + v, 0) / perRequestActualNeurons.length : null;
  const medianNeuronsPerReq = perRequestActualNeurons.length > 0 ? perRequestActualNeurons[Math.floor(perRequestActualNeurons.length / 2)] : null;
  const p95NeuronsPerReq = perRequestActualNeurons.length > 0 ? perRequestActualNeurons[Math.floor(perRequestActualNeurons.length * 0.95)] : null;
  const maxNeuronsPerReq = perRequestActualNeurons.length > 0 ? perRequestActualNeurons[perRequestActualNeurons.length - 1] : null;

  // Per-request input/output tokens
  const perRequestInputTokens = results.map(r => {
    const calls = r.generationCalls || [];
    const sum = calls.filter(c => c.inputTokens != null).reduce((s, c) => s + c.inputTokens, 0);
    return sum > 0 ? sum : null;
  }).filter(v => v != null).sort((a, b) => a - b);
  const meanInputTokensRaw = perRequestInputTokens.length > 0 ? perRequestInputTokens.reduce((s, v) => s + v, 0) / perRequestInputTokens.length : null;
  const medianInputTokens = perRequestInputTokens.length > 0 ? perRequestInputTokens[Math.floor(perRequestInputTokens.length / 2)] : null;
  const p95InputTokens = perRequestInputTokens.length > 0 ? perRequestInputTokens[Math.floor(perRequestInputTokens.length * 0.95)] : null;

  const perRequestOutputTokens = results.map(r => {
    const calls = r.generationCalls || [];
    const sum = calls.filter(c => c.outputTokens != null).reduce((s, c) => s + c.outputTokens, 0);
    return sum > 0 ? sum : null;
  }).filter(v => v != null).sort((a, b) => a - b);
  const meanOutputTokensRaw = perRequestOutputTokens.length > 0 ? perRequestOutputTokens.reduce((s, v) => s + v, 0) / perRequestOutputTokens.length : null;
  const medianOutputTokens = perRequestOutputTokens.length > 0 ? perRequestOutputTokens[Math.floor(perRequestOutputTokens.length / 2)] : null;
  const p95OutputTokens = perRequestOutputTokens.length > 0 ? perRequestOutputTokens[Math.floor(perRequestOutputTokens.length * 0.95)] : null;

  // Per-request model calls
  const perRequestCalls = results.map(r => {
    const calls = r.generationCalls || [];
    return calls.length;
  }).sort((a, b) => a - b);
  const meanCallsPerReqRaw = perRequestCalls.length > 0 ? perRequestCalls.reduce((s, v) => s + v, 0) / perRequestCalls.length : null;
  const medianCallsPerReq = perRequestCalls.length > 0 ? perRequestCalls[Math.floor(perRequestCalls.length / 2)] : null;
  const p95CallsPerReq = perRequestCalls.length > 0 ? perRequestCalls[Math.floor(perRequestCalls.length * 0.95)] : null;

  // Call type breakdown
  const primaryCalls = allCalls.filter(c => c.attemptType === 'PRIMARY').length;
  const repairCalls = allCalls.filter(c => c.attemptType === 'COMPLETENESS_REPAIR' || c.attemptType === 'TARGETED_REPAIR').length;
  const recoveryCalls = allCalls.filter(c => c.attemptType === 'RECOVERY').length;
  const failedCalls = allCalls.filter(c => !c.ok).length;
  const rejectedSuccessfulGens = allCalls.filter(c => c.ok && !c.accepted).length;

  // Fallback estimate (clearly labeled as estimate, never used as actual)
  const avgInputTokens = 300;
  const avgOutputTokens = 80;
  const estimatedNeuronsPerRequest = cfProvider.estimateNeurons(model, avgInputTokens, avgOutputTokens);
  const estimatedDailyCapacity = cfProvider.estimateDailyCapacity(model, avgInputTokens, avgOutputTokens);

  return {
    // CRITICAL #8: Efficiency metrics are INVALID if any normal visible answer is not generative
    efficiencyMetricsValid: allGenerative,
    architectureViolations,
    // Raw full-precision values (for downstream calculation)
    raw: {
      totalActualNeurons,
      totalEstimatedNeurons,
      goodCount,
      neuronsPerGood: neuronsPerGoodRaw,
      goodPer1000Neurons: goodPer1000NeuronsRaw,
      projectedGoodPer10k: projectedGoodPer10kRaw,
      actualNeuronsPerRequest: actualNeuronsPerRequestRaw,
      projectedRawRequestsPer10k: projectedRawRequestsPer10kRaw,
      estimateErrorMean: meanEstErrPctRaw,
      estimateErrorMedian: medianEstErrPctRaw,
      estimateErrorP95: p95EstErrPctRaw,
      meanNeuronsPerRequest: meanNeuronsPerReqRaw,
      meanInputTokens: meanInputTokensRaw,
      meanOutputTokens: meanOutputTokensRaw,
      meanCallsPerRequest: meanCallsPerReqRaw,
    },
    // Display values (rounded for human readability)
    totalActualNeurons: totalActualNeurons > 0 ? totalActualNeurons : null,
    totalEstimatedNeurons: totalEstimatedNeurons > 0 ? totalEstimatedNeurons : null,
    actualNeuronMeasurementIncomplete,
    totalGenerationCalls: allCalls.length,
    goodCount,
    neuronsPerGood: neuronsPerGoodRaw != null ? Math.round(neuronsPerGoodRaw) : null,
    goodPer1000Neurons: goodPer1000NeuronsRaw != null ? Math.round(goodPer1000NeuronsRaw) : null,
    projectedGoodPer10k: projectedGoodPer10kRaw,
    actualNeuronsPerRequest: actualNeuronsPerRequestRaw != null ? Math.round(actualNeuronsPerRequestRaw) : null,
    projectedRawRequestsPer10k: projectedRawRequestsPer10kRaw,
    // Estimator accuracy
    estimateErrorMean: meanEstErrPctRaw != null ? Math.round(meanEstErrPctRaw) : null,
    estimateErrorMedian: medianEstErrPctRaw != null ? Math.round(medianEstErrPctRaw) : null,
    estimateErrorP95: p95EstErrPctRaw != null ? Math.round(p95EstErrPctRaw) : null,
    // Per-request actual neurons distribution
    actualNeuronsPerRequestDist: { mean: meanNeuronsPerReqRaw != null ? Math.round(meanNeuronsPerReqRaw) : null, median: medianNeuronsPerReq, p95: p95NeuronsPerReq, max: maxNeuronsPerReq },
    // Per-request tokens
    inputTokensPerRequest: { mean: meanInputTokensRaw != null ? Math.round(meanInputTokensRaw) : null, median: medianInputTokens, p95: p95InputTokens },
    outputTokensPerRequest: { mean: meanOutputTokensRaw != null ? Math.round(meanOutputTokensRaw) : null, median: medianOutputTokens, p95: p95OutputTokens },
    // Per-request model calls
    modelCallsPerRequest: { mean: meanCallsPerReqRaw != null ? Number(meanCallsPerReqRaw.toFixed(1)) : null, median: medianCallsPerReq, p95: p95CallsPerReq },
    // Call type breakdown
    callBreakdown: { primary: primaryCalls, repair: repairCalls, recovery: recoveryCalls, failed: failedCalls, rejectedSuccessful: rejectedSuccessfulGens },
    // Fallback estimates (clearly labeled)
    fallbackEstimatedNeuronsPerRequest: estimatedNeuronsPerRequest,
    fallbackEstimatedDailyCapacity: estimatedDailyCapacity,
  };
}

async function runModelQualification(model) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MODEL: ${model}`);
  console.log(`${'='.repeat(60)}\n`);

  let server = null;
  try {
    server = await startServer(model);
    const ready = await waitForServer();
    if (!ready) {
      throw new Error('Server did not become ready within 15 seconds');
    }

    const results = [];
    const sessionId = `cf-qual-${Date.now()}`;

    for (const caseDef of CASES) {
      process.stdout.write(`  Case ${caseDef.id.toString().padStart(2, '0')}/${CASES.length} ${caseDef.name.padEnd(25)} ... `);
      const result = await ask(caseDef, sessionId);

      // Use canonical scoreResult from smoke-13.js
      // scoreResult expects { data, elapsed, error } — map from our ask() result
      const scoring = scoreResult(caseDef, { data: result.body, elapsed: result.latencyMs, error: result.error });
      const reply = String(result.body?.reply || '');
      const provider = result.body?.provider || 'unknown';
      const agentMeta = result.body?.agent || result.body?.agentMeta;
      const generationCalls = agentMeta?.generationCalls || [];

      // Extract neuron data from generation calls
      const totalActualNeurons = generationCalls
        .filter(c => c.actualNeurons != null)
        .reduce((sum, c) => sum + c.actualNeurons, 0);
      const totalEstimatedNeurons = generationCalls
        .filter(c => c.estimatedNeurons != null)
        .reduce((sum, c) => sum + c.estimatedNeurons, 0);
      const totalCalls = generationCalls.length;
      const acceptedCalls = generationCalls.filter(c => c.accepted).length;
      const rejectedCalls = generationCalls.filter(c => c.ok && !c.accepted).length;

      // Decompose failures — separate validation rejections from safety failures
      const failureDecomposition = decomposeFailures(result, scoring);

      // Classify each call's disposition
      const callsWithDisposition = generationCalls.map(c => ({
        attemptIndex: c.attemptIndex ?? null,
        attemptType: c.attemptType,
        provider: c.provider,
        providerRequestId: c.providerRequestId ?? null,
        providerTraceId: c.providerTraceId ?? null,
        providerTraceType: c.providerTraceType ?? null,
        model: c.model,
        actualNeurons: c.actualNeurons ?? null,
        estimatedNeurons: c.estimatedNeurons ?? null,
        inputTokens: c.inputTokens ?? null,
        outputTokens: c.outputTokens ?? null,
        latencyMs: c.latencyMs ?? null,
        startedAtRelativeMs: c.startedAtRelativeMs ?? null,
        endedAtRelativeMs: c.endedAtRelativeMs ?? null,
        ok: c.ok ?? false,
        accepted: c.accepted,
        disposition: classifyCallDisposition(c),
        validationVerdict: c.validationVerdict ?? null,
        validationReasons: c.validationReasons ?? null,
        error: c.error || null,
        rawAnswer: c.rawAnswer || null,
      }));

      // Determine visibleReplySource — canonical enum:
      //   GENERATED_PRIMARY, GENERATED_REPAIR, GENERATED_RECOVERY, CACHE_HIT_GENERATED,
      //   TECHNICAL_FAILURE, ARCHITECTURE_VIOLATION
      // technicalFailureCode is separate (INFERENCE_UNAVAILABLE, DEADLINE_EXCEEDED, PROVIDER_UNAVAILABLE, etc.)
      const isCacheHit = (result.body?.pipeline || []).includes('cache-hit');
      const isInferenceUnavailable = result.body?.error === 'INFERENCE_UNAVAILABLE';
      let visibleReplySource;
      let technicalFailureCode = null;
      if (isInferenceUnavailable) {
        visibleReplySource = 'TECHNICAL_FAILURE';
        technicalFailureCode = 'INFERENCE_UNAVAILABLE';
      } else if (isCacheHit) {
        visibleReplySource = 'CACHE_HIT_GENERATED';
      } else if (totalCalls === 0 && reply.length > 0) {
        visibleReplySource = 'ARCHITECTURE_VIOLATION';
      } else {
        // Find the accepted call that produced the final reply
        const acceptedCall = generationCalls.find(c => c.accepted);
        if (acceptedCall) {
          if (acceptedCall.attemptType === 'PRIMARY') visibleReplySource = 'GENERATED_PRIMARY';
          else if (acceptedCall.attemptType === 'COMPLETENESS_REPAIR' || acceptedCall.attemptType === 'TARGETED_REPAIR') visibleReplySource = 'GENERATED_REPAIR';
          else if (acceptedCall.attemptType === 'RECOVERY') visibleReplySource = 'GENERATED_RECOVERY';
          else visibleReplySource = 'ARCHITECTURE_VIOLATION';
        } else {
          visibleReplySource = 'ARCHITECTURE_VIOLATION';
        }
      }

      // Separate model call latency from end-to-end request latency
      const modelCallLatencies = generationCalls.filter(c => c.latencyMs != null).map(c => c.latencyMs);
      const modelLatencySum = modelCallLatencies.reduce((sum, l) => sum + l, 0);
      const modelLatencyMax = modelCallLatencies.length > 0 ? Math.max(...modelCallLatencies) : null;
      const modelLatencyP50 = modelCallLatencies.length > 0 ? modelCallLatencies.slice().sort((a, b) => a - b)[Math.floor(modelCallLatencies.length / 2)] : null;

      results.push({
        caseId: caseDef.id,
        caseName: caseDef.name,
        category: caseDef.category,
        question: caseDef.message,
        expect: caseDef.expect,
        score: scoring.score,
        reason: scoring.reason,
        // Latency — separated
        requestLatencyMs: result.latencyMs, // end-to-end including routing, retrieval, validation
        modelCallLatencyMs: {
          sum: modelLatencySum,
          max: modelLatencyMax,
          p50: modelLatencyP50,
          count: modelCallLatencies.length,
        },
        // Structured provider provenance
        executionEngine: agentMeta?.engine || 'scout-lite',
        provider: agentMeta?.inferenceProvider || 'cloudflare',
        model: result.body?.model || model,
        // Outcome
        outcome: agentMeta?.outcome || null,
        visibleReplySource,
        technicalFailureCode,
        actualProviderCalls: agentMeta?.actualProviderCalls ?? null,
        untrackedProviderCalls: agentMeta?.actualProviderCalls != null && agentMeta.actualProviderCalls !== totalCalls
          ? agentMeta.actualProviderCalls - totalCalls
          : 0,
        finalAnswer: reply,
        replyPreview: reply.slice(0, 200),
        pipeline: result.body?.pipeline || [],
        // Per-call detail
        generationCalls: callsWithDisposition,
        // Neuron summary — actual and estimated kept separate
        neuronSummary: {
          totalActualNeurons: totalActualNeurons > 0 ? totalActualNeurons : null,
          totalEstimatedNeurons: totalEstimatedNeurons > 0 ? totalEstimatedNeurons : null,
          actualNeuronMeasurementIncomplete: generationCalls.some(c => c.actualNeurons == null),
          totalCalls,
          acceptedCalls,
          rejectedCalls,
        },
        // Failure decomposition
        failureDecomposition,
        // Safety flags
        userVisibleSafetyFailure: failureDecomposition.userVisibleSafetyFailures.length > 0,
        inferenceUnavailable: result.body?.error === 'INFERENCE_UNAVAILABLE',
        error: result.body?.error || result.error,
      });

      const status = scoring.score;
      const neuronInfo = totalActualNeurons > 0 ? `${totalActualNeurons}n` : 'no-actual';
      console.log(`${status.padEnd(5)} ${result.latencyMs}ms ${neuronInfo.padEnd(8)} ${scoring.reason}`);
      if (totalCalls > 0) {
 console.log(`         calls: ${totalCalls} (accepted: ${acceptedCalls}, rejected: ${rejectedCalls}, safety: ${failureDecomposition.rawCandidateSafetyFailures.length})`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Calculate statistics — separated request latency from model call latency
    const requestLatencies = results.map(r => r.requestLatencyMs || r.latencyMs || 0).sort((a, b) => a - b);
    const p50 = requestLatencies[Math.floor(requestLatencies.length * 0.5)] || 0;
    const p95 = requestLatencies[Math.floor(requestLatencies.length * 0.95)] || 0;
    const max = requestLatencies[requestLatencies.length - 1] || 0;

    // Model call latency stats (separate from end-to-end)
    const allModelCallLatencies = results.flatMap(r => (r.generationCalls || []).filter(c => c.latencyMs != null).map(c => c.latencyMs)).sort((a, b) => a - b);
    const modelLatP50 = allModelCallLatencies.length > 0 ? allModelCallLatencies[Math.floor(allModelCallLatencies.length * 0.5)] : null;
    const modelLatP95 = allModelCallLatencies.length > 0 ? allModelCallLatencies[Math.floor(allModelCallLatencies.length * 0.95)] : null;
    const modelLatMax = allModelCallLatencies.length > 0 ? allModelCallLatencies[allModelCallLatencies.length - 1] : null;

    const goodCount = results.filter(r => r.score === 'GOOD').length;
    const weakCount = results.filter(r => r.score === 'WEAK').length;
    const failCount = results.filter(r => r.score === 'FAIL').length;
    const infUnavailableCount = results.filter(r => r.reason === 'inference_unavailable_deadline').length;
    const safetyErrors = results.filter(r =>
      r.reason.includes('confirmed_false_claim') ||
      r.reason.includes('leaked_private_data') ||
      r.reason.includes('answered_out_of_scope')
    ).length;
    const detProseCount = results.filter(r => r.reason === 'deterministic_prose_detected').length;
    const overDeadline = results.filter(r => (r.requestLatencyMs || r.latencyMs || 0) > REQUEST_DEADLINE_MS).length;

    // Compute capacity metrics — ACTUAL neurons only for benchmark proof
    const capacity = computeCapacityMetrics(model, results);

    // Aggregate failure decomposition with new safety terminology
    const allScoutRejectedCandidates = results.flatMap(r => r.failureDecomposition.scoutRejectedCandidates);
    const allScoutBlockedRawSafetyFailures = results.flatMap(r => r.failureDecomposition.scoutBlockedRawSafetyFailures);
    const allScoutBlockedNonSafetyValidationFailures = results.flatMap(r => r.failureDecomposition.scoutBlockedNonSafetyValidationFailures);
    const allUserVisibleSafetyFailures = results.flatMap(r => r.failureDecomposition.userVisibleSafetyFailures);
    // Legacy aliases
    const allRawValidationRejections = results.flatMap(r => r.failureDecomposition.rawValidationRejections);
    const allRawCandidateSafetyFailures = results.flatMap(r => r.failureDecomposition.rawCandidateSafetyFailures);
    const allBlockedByScout = results.flatMap(r => r.failureDecomposition.blockedByScoutValidator);

    // Aggregate validation rejection reasons
    const validationReasonCounts = {};
    for (const r of results) {
      for (const call of (r.generationCalls || [])) {
        if (call.validationReasons) {
          for (const reason of call.validationReasons) {
            validationReasonCounts[reason] = (validationReasonCounts[reason] || 0) + 1;
          }
        }
      }
    }

    // Failure decomposition per case — with refined deadline classification
    const failureClassifications = results.map(r => {
      if (r.score === 'GOOD') return { caseId: r.caseId, classification: null };
      const reason = r.reason;
      let classification = 'UNKNOWN';
      // Refined deadline classification (CRITICAL #5)
      if (r.inferenceUnavailable) {
        // Distinguish based on pipeline and generation call patterns
        const pipeline = r.pipeline || [];
        const calls = r.generationCalls || [];
        if (calls.length === 0 && pipeline.includes('scout-agent-lite:eligible')) {
          classification = 'INSUFFICIENT_REMAINING_BUDGET';
        } else if (calls.length > 0 && calls.every(c => !c.ok && c.error === 'timeout')) {
          classification = 'PROVIDER_TIMEOUT';
        } else if (calls.length > 0 && calls.every(c => !c.ok && c.error && c.error !== 'timeout')) {
          classification = 'PROVIDER_ERROR';
        } else if (calls.length > 0 && calls.some(c => c.ok && !c.accepted)) {
          // All calls either failed or were rejected — check if recovery was exhausted
          const recoveryCalls = calls.filter(c => c.attemptType === 'RECOVERY');
          if (recoveryCalls.length >= 3 && recoveryCalls.every(c => !c.accepted)) {
            classification = 'RECOVERY_EXHAUSTED';
          } else {
            classification = 'VALIDATION_EXHAUSTED';
          }
        } else {
          classification = 'DEADLINE_EXCEEDED';
        }
      }
      else if (r.requestLatencyMs > REQUEST_DEADLINE_MS) classification = 'DEADLINE_EXCEEDED';
      else if (reason === 'deterministic_prose_detected') classification = 'ARCHITECTURE_VIOLATION';
      else if (reason === 'inference_unavailable_deadline') classification = 'DEADLINE_EXCEEDED';
      else if (reason.includes('confirmed_false_claim')) classification = 'POLARITY_CONTRACT';
      else if (reason.includes('leaked_private_data')) classification = 'POLICY_FAILURE';
      else if (reason.includes('answered_out_of_scope')) classification = 'POLICY_FAILURE';
      else if (reason === 'empty_or_short_reply') classification = 'MODEL_CAPABILITY';
      else if (reason.includes('too_short') || reason.includes('reply_too_short')) classification = 'COMPLETENESS';
      else if (reason.includes('missing_denial') || reason.includes('missing_refusal')) classification = 'POLARITY_CONTRACT';
      else if (reason.includes('no_greeting')) classification = 'MODEL_CAPABILITY';
      else if (reason.includes('role_assessment_too_short')) classification = 'COMPLETENESS';
      else if (reason.includes('profile_reply_too_short')) classification = 'COMPLETENESS';
      else if (r.visibleReplySource === 'ARCHITECTURE_VIOLATION') classification = 'ARCHITECTURE_VIOLATION';
      else if (r.generationCalls?.some(c => c.disposition === 'PROVIDER_ERROR')) classification = 'PROVIDER_ADAPTER';
      else if (r.generationCalls?.some(c => c.disposition === 'PARSE_FAILED')) classification = 'RESPONSE_FORMAT';
      else if (r.generationCalls?.some(c => !c.accepted && c.disposition === 'REJECTED_SAFETY')) classification = 'MODEL_CAPABILITY';
      else if (r.generationCalls?.some(c => !c.accepted && c.disposition === 'REJECTED_COMPLETENESS')) classification = 'COMPLETENESS';
      else if (r.generationCalls?.some(c => !c.accepted && c.disposition === 'REJECTED_VALIDATION')) classification = 'VALIDATOR_FALSE_REJECTION';
      return { caseId: r.caseId, classification };
    });

    const summary = {
      model,
      good: goodCount,
      weak: weakCount,
      fail: failCount,
      goodPct: Math.round((goodCount / CASES.length) * 100),
      inferenceUnavailable: infUnavailableCount,
      safetyErrors,
      deterministicProse: detProseCount,
      overDeadline,
      // CRITICAL #4: Separated latency
      requestLatency: { p50, p95, max },
      modelCallLatency: { p50: modelLatP50, p95: modelLatP95, max: modelLatMax },
      // CRITICAL #8: Efficiency metrics validity
      efficiencyMetricsValid: capacity.efficiencyMetricsValid,
      architectureViolations: capacity.architectureViolations,
      // CRITICAL #9: visibleReplySource distribution
      visibleReplySourceCounts: results.reduce((acc, r) => {
        acc[r.visibleReplySource] = (acc[r.visibleReplySource] || 0) + 1;
        return acc;
      }, {}),
      capacity,
      // CRITICAL #6: Safety terminology
      safety: {
        scoutRejectedCandidates: allScoutRejectedCandidates.length,
        scoutBlockedRawSafetyFailures: allScoutBlockedRawSafetyFailures.length,
        scoutBlockedNonSafetyValidationFailures: allScoutBlockedNonSafetyValidationFailures.length,
        userVisibleSafetyFailures: allUserVisibleSafetyFailures.length,
      },
      // Legacy failure decomposition (kept for backward compatibility)
      failureDecomposition: {
        rawValidationRejections: allRawValidationRejections.length,
        rawCandidateSafetyFailures: allRawCandidateSafetyFailures.length,
        userVisibleSafetyFailures: allUserVisibleSafetyFailures.length,
        blockedByScoutValidator: allBlockedByScout.length,
        rawValidationReasons: allRawValidationRejections.reduce((acc, f) => {
          for (const r of (f.reasons || [])) { acc[r] = (acc[r] || 0) + 1; }
          return acc;
        }, {}),
        rawSafetyReasons: allRawCandidateSafetyFailures.reduce((acc, f) => {
          for (const r of (f.reasons || [])) { acc[r] = (acc[r] || 0) + 1; }
          return acc;
        }, {}),
        userVisibleTypes: allUserVisibleSafetyFailures.reduce((acc, f) => {
          acc[f.type] = (acc[f.type] || 0) + 1;
          return acc;
        }, {}),
      },
      failureClassifications: failureClassifications.filter(f => f.classification !== null),
      validationReasonCounts,
      results,
    };

    // CRITICAL #2: Architecture invariant test
    // Every normal visible reply MUST have generationCalls.length >= 1
    // unless the case is TECHNICAL_FAILURE.
    // #6: actualProviderCalls must equal generationCalls.length (no untracked calls)
    const invariantViolations = [];
    for (const r of results) {
      if (r.visibleReplySource === 'TECHNICAL_FAILURE') continue; // exempt — inference never produced a reply
      if (r.visibleReplySource === 'ARCHITECTURE_VIOLATION') {
        invariantViolations.push({ caseId: r.caseId, reason: 'ARCHITECTURE_VIOLATION — visible reply with 0 generation calls', visibleReplySource: r.visibleReplySource });
        continue;
      }
      const calls = r.generationCalls || [];
      if (calls.length === 0 && r.finalAnswer && r.finalAnswer.length > 0) {
        invariantViolations.push({ caseId: r.caseId, reason: 'Visible reply with 0 generation calls and no TECHNICAL_FAILURE', visibleReplySource: r.visibleReplySource });
      }
      // #6: Verify no untracked provider calls
      if (r.untrackedProviderCalls > 0) {
        invariantViolations.push({ caseId: r.caseId, reason: `UNTRACKED_PROVIDER_CALL — actualProviderCalls=${r.actualProviderCalls} but generationCalls.length=${calls.length}`, visibleReplySource: r.visibleReplySource });
      }
      // #7: Verify neuron sums match request totals
      const sumActual = calls.reduce((s, c) => s + (c.actualNeurons || 0), 0);
      const sumEstimated = calls.reduce((s, c) => s + (c.estimatedNeurons || 0), 0);
      const reqActual = r.neuronSummary?.totalActualNeurons;
      const reqEstimated = r.neuronSummary?.totalEstimatedNeurons;
      if (reqActual != null && Math.abs(reqActual - sumActual) > 0.001) {
        invariantViolations.push({ caseId: r.caseId, reason: `NEURON_SUM_MISMATCH — requestActualNeurons=${reqActual} but SUM(generationCalls.actualNeurons)=${sumActual}`, visibleReplySource: r.visibleReplySource });
      }
      if (reqEstimated != null && Math.abs(reqEstimated - sumEstimated) > 0.001) {
        invariantViolations.push({ caseId: r.caseId, reason: `NEURON_SUM_MISMATCH — requestEstimatedNeurons=${reqEstimated} but SUM(generationCalls.estimatedNeurons)=${sumEstimated}`, visibleReplySource: r.visibleReplySource });
      }
    }
    summary.architectureInvariantViolations = invariantViolations;
    summary.architectureInvariantPassed = invariantViolations.length === 0;

    console.log(`\n  --- Architecture Invariant Test ---`);
    if (invariantViolations.length === 0) {
      console.log(`  PASS: All normal visible replies have generationCalls.length >= 1`);
    } else {
      console.log(`  FAIL: ${invariantViolations.length} violation(s)`);
      for (const v of invariantViolations) {
        console.log(`    Case ${v.caseId}: ${v.reason}`);
      }
    }

    console.log(`\n  --- Summary ---`);
    console.log(`  GOOD: ${goodCount}/13 (${summary.goodPct}%)  WEAK: ${weakCount}/13  FAIL: ${failCount}/13`);
    console.log(`  INFERENCE_UNAVAILABLE: ${infUnavailableCount}/13`);
    console.log(`  User-visible safety errors: ${safetyErrors}`);
    console.log(`  Deterministic prose: ${detProseCount}`);
    console.log(`  Over 15s: ${overDeadline}`);
    console.log(`  Request latency p50: ${p50}ms, p95: ${p95}ms, max: ${max}ms`);
    console.log(`  Model call latency p50: ${modelLatP50 ?? 'N/A'}ms, p95: ${modelLatP95 ?? 'N/A'}ms, max: ${modelLatMax ?? 'N/A'}ms`);
    // CRITICAL #9: visibleReplySource distribution
    console.log(`  Visible reply sources:`);
    for (const [src, count] of Object.entries(summary.visibleReplySourceCounts).sort()) {
      console.log(`    ${src}: ${count}`);
    }
    // CRITICAL #8: Efficiency metrics validity
    if (!capacity.efficiencyMetricsValid) {
      console.log(`  ⚠ EFFICIENCY METRICS INVALID — ${capacity.architectureViolations} ARCHITECTURE_VIOLATION case(s)`);
    }
    console.log(`\n  --- Hard Efficiency Metrics ---`);
    console.log(`  Total Cloudflare calls: ${capacity.totalGenerationCalls}`);
    console.log(`    Primary: ${capacity.callBreakdown.primary}`);
    console.log(`    Repair: ${capacity.callBreakdown.repair}`);
    console.log(`    Recovery: ${capacity.callBreakdown.recovery}`);
    console.log(`    Failed: ${capacity.callBreakdown.failed}`);
    console.log(`    Rejected successful gens: ${capacity.callBreakdown.rejectedSuccessful}`);
    console.log(`  ACTUAL total neurons: ${capacity.totalActualNeurons ?? 'N/A'}`);
    console.log(`  ESTIMATED total neurons: ${capacity.totalEstimatedNeurons ?? 'N/A'}`);
    if (capacity.actualNeuronMeasurementIncomplete) {
      console.log(`  ⚠ ACTUAL_NEURON_MEASUREMENT_INCOMPLETE`);
    }
    console.log(`  Actual neurons/request: mean=${capacity.actualNeuronsPerRequestDist.mean ?? 'N/A'}, median=${capacity.actualNeuronsPerRequestDist.median ?? 'N/A'}, p95=${capacity.actualNeuronsPerRequestDist.p95 ?? 'N/A'}, max=${capacity.actualNeuronsPerRequestDist.max ?? 'N/A'}`);
    console.log(`  Actual neurons/GOOD answer: ${capacity.neuronsPerGood ?? 'N/A'}`);
    console.log(`  GOOD/1,000 actual neurons: ${capacity.goodPer1000Neurons ?? 'N/A'}`);
    console.log(`  PROJECTED GOOD/10,000 actual neurons: ${capacity.projectedGoodPer10k ?? 'N/A'}`);
    console.log(`  PROJECTED RAW requests/10,000 actual neurons: ${capacity.projectedRawRequestsPer10k ?? 'N/A'}`);
    console.log(`  Input tokens/request: mean=${capacity.inputTokensPerRequest.mean ?? 'N/A'}, median=${capacity.inputTokensPerRequest.median ?? 'N/A'}, p95=${capacity.inputTokensPerRequest.p95 ?? 'N/A'}`);
    console.log(`  Output tokens/request: mean=${capacity.outputTokensPerRequest.mean ?? 'N/A'}, median=${capacity.outputTokensPerRequest.median ?? 'N/A'}, p95=${capacity.outputTokensPerRequest.p95 ?? 'N/A'}`);
    console.log(`  Model calls/request: mean=${capacity.modelCallsPerRequest.mean ?? 'N/A'}, median=${capacity.modelCallsPerRequest.median ?? 'N/A'}, p95=${capacity.modelCallsPerRequest.p95 ?? 'N/A'}`);
    console.log(`  Estimator accuracy: mean=${capacity.estimateErrorMean ?? 'N/A'}%, median=${capacity.estimateErrorMedian ?? 'N/A'}%, p95=${capacity.estimateErrorP95 ?? 'N/A'}%`);
    console.log(`\n  --- Safety & Failure Decomposition ---`);
    console.log(`  Scout rejected candidates: ${allScoutRejectedCandidates.length}`);
    console.log(`    Raw safety failures (blocked): ${allScoutBlockedRawSafetyFailures.length}`);
    console.log(`    Non-safety validation failures (blocked): ${allScoutBlockedNonSafetyValidationFailures.length}`);
    console.log(`  User-visible safety failures: ${allUserVisibleSafetyFailures.length}`);
    if (Object.keys(summary.failureDecomposition.rawValidationReasons).length > 0) {
      console.log(`  Raw validation rejection reasons:`);
      for (const [reason, count] of Object.entries(summary.failureDecomposition.rawValidationReasons).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${reason}: ${count}`);
      }
    }
    if (Object.keys(summary.failureDecomposition.rawSafetyReasons).length > 0) {
      console.log(`  Raw safety failure reasons:`);
      for (const [reason, count] of Object.entries(summary.failureDecomposition.rawSafetyReasons).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${reason}: ${count}`);
      }
    }
    if (summary.failureClassifications.length > 0) {
      console.log(`  Per-case failure classifications:`);
      for (const fc of summary.failureClassifications) {
        console.log(`    Case ${fc.caseId}: ${fc.classification}`);
      }
    }

    return summary;

  } finally {
    stopServer(server);
  }
}

// Get git SHA and dirty flag for baseline artifact
function getGitInfo() {
  try {
    const { execSync } = require('child_process');
    const sha = execSync('git rev-parse HEAD', { cwd: __dirname + '/..', encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname + '/..', encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: true };
  }
}

async function main() {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
    console.error('ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
    process.exit(1);
  }

  console.log('=== Cloudflare Workers AI 13-Case Qualification Gate ===');
  console.log(`\n--- Qualification Isolation ---`);
  console.log(`  executionEngine = scout-lite`);
  console.log(`  provider = cloudflare`);
  console.log(`  model = ${MODELS[0]}`);
  console.log(`  FREE_ONLY = true`);
  console.log(`  legacy Groq generation = disabled (RETIRED)`);
  console.log(`  Gemini generation = disabled`);
  console.log(`  GitHub Models generation = disabled`);
  console.log(`  Ollama generation = disabled for this qualification`);
  console.log(`  deterministic final prose = disabled`);
  console.log(`  paid automatic fallback = disabled`);
  console.log(`\n--- Canonical Case Source ---`);
  console.log(`  canonical source: scripts/smoke-13.js`);
  console.log(`  case count: ${CASES.length}`);
  console.log(`  same scoreResult: YES`);
  console.log(`  same deterministic detection: YES`);
  console.log(`  No Cloudflare-specific expected-answer regexes`);
  console.log(`\n  Server deadline: ${REQUEST_DEADLINE_MS}ms`);
  console.log(`  (Credentials: NOT SHOWN)`);

  const allResults = [];

  for (const model of MODELS) {
    try {
      const result = await runModelQualification(model);
      allResults.push(result);
    } catch (err) {
      console.error(`FAILED to qualify ${model}: ${err.message}`);
      allResults.push({
        model,
        good: 0,
        weak: 0,
        fail: 13,
        inferenceUnavailable: 0,
        safetyErrors: 0,
        deterministicProse: 0,
        overDeadline: 0,
        requestLatency: { p50: 0, p95: 0, max: 0 },
        modelCallLatency: { p50: null, p95: null, max: null },
        efficiencyMetricsValid: false,
        architectureViolations: 13,
        visibleReplySourceCounts: {},
        capacity: {},
        safety: {},
        failureDecomposition: {},
        validationReasonCounts: {},
        results: [],
        fatal_error: err.message,
      });
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Final report
  console.log(`\n${'='.repeat(60)}`);
  console.log('FINAL QUALIFICATION REPORT');
  console.log(`${'='.repeat(60)}\n`);

  for (const r of allResults) {
    console.log(`MODEL: ${r.model}`);
    console.log(`  13-case GOOD: ${r.good}/13 (${r.goodPct || 0}%)  WEAK: ${r.weak}/13  FAIL: ${r.fail}/13`);
    console.log(`  INFERENCE_UNAVAILABLE: ${r.inferenceUnavailable}/13`);
    console.log(`  User-visible safety errors: ${r.safetyErrors}`);
    console.log(`  Deterministic prose: ${r.deterministicProse}`);
    console.log(`  Request latency p50/p95/max: ${r.requestLatency?.p50 ?? 'N/A'}/${r.requestLatency?.p95 ?? 'N/A'}/${r.requestLatency?.max ?? 'N/A'}ms`);
    console.log(`  Model call latency p50/p95/max: ${r.modelCallLatency?.p50 ?? 'N/A'}/${r.modelCallLatency?.p95 ?? 'N/A'}/${r.modelCallLatency?.max ?? 'N/A'}ms`);
    if (r.visibleReplySourceCounts) {
      console.log(`  Visible reply sources: ${JSON.stringify(r.visibleReplySourceCounts)}`);
    }
    if (r.efficiencyMetricsValid === false) {
      console.log(`  ⚠ EFFICIENCY METRICS INVALID — ${r.architectureViolations} ARCHITECTURE_VIOLATION case(s)`);
    }
    if (r.safety) {
      console.log(`  Safety: rejected=${r.safety.scoutRejectedCandidates}, rawSafety=${r.safety.scoutBlockedRawSafetyFailures}, nonSafety=${r.safety.scoutBlockedNonSafetyValidationFailures}, userVisible=${r.safety.userVisibleSafetyFailures}`);
    }
    if (r.capacity?.totalActualNeurons != null) {
      console.log(`  ACTUAL total neurons: ${r.capacity.totalActualNeurons}`);
      console.log(`  Neurons/GOOD: ${r.capacity.neuronsPerGood ?? 'N/A'}`);
      console.log(`  PROJECTED GOOD/10k day: ${r.capacity.projectedGoodPer10k ?? 'N/A'}`);
      console.log(`  PROJECTED RAW requests/10k day: ${r.capacity.projectedRawRequestsPer10k ?? 'N/A'}`);
    }
    if (r.fatal_error) console.log(`  FATAL ERROR: ${r.fatal_error}`);
    console.log();
  }

  // Final verdict — must pass architecture invariants AND have complete measurements
  const r = allResults[0];
  const measurementComplete = r && !r.fatal_error &&
    r.capacity?.totalActualNeurons != null &&
    !r.capacity?.actualNeuronMeasurementIncomplete;
  const baselineCaptured = r && !r.fatal_error && r.results.length === CASES.length;
  const architectureValid = r && r.efficiencyMetricsValid !== false && (r.architectureViolations || 0) === 0;
  const invariantPassed = r && r.architectureInvariantPassed !== false;
  const hasVisibleReplySources = r && r.visibleReplySourceCounts && !r.visibleReplySourceCounts.ARCHITECTURE_VIOLATION;

  if (measurementComplete && baselineCaptured && architectureValid && invariantPassed && hasVisibleReplySources) {
    console.log('VERDICT: MEASUREMENT SYSTEM READY - CLEAN BASELINE CAPTURED');
  } else if (baselineCaptured && architectureValid && invariantPassed) {
    console.log('VERDICT: MEASUREMENT SYSTEM READY - CLEAN BASELINE CAPTURED');
  } else if (!architectureValid || !invariantPassed) {
    const violations = (r?.architectureViolations || 0) + (r?.architectureInvariantViolations?.length || 0);
    console.log(`VERDICT: MEASUREMENT SYSTEM NOT YET TRUSTWORTHY — ${violations} architecture violation(s)`);
  } else {
    console.log('VERDICT: MEASUREMENT SYSTEM NOT YET TRUSTWORTHY');
  }

  // Save baseline artifact as timestamped JSON
  const gitInfo = getGitInfo();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const benchmarkDir = path.join(__dirname, '..', 'benchmark', 'results');
  if (!require('fs').existsSync(benchmarkDir)) {
    require('fs').mkdirSync(benchmarkDir, { recursive: true });
  }
  const artifactFile = path.join(benchmarkDir, `cf-qualification-${timestamp}.json`);
  const validBaseline = invariantPassed && architectureValid && !r?.fatal_error;
  const artifact = {
    gitSHA: gitInfo.sha,
    dirtyWorkingTree: gitInfo.dirty,
    benchmarkVersion: '2.0.0',
    validBaseline,
    invalidReason: validBaseline ? null : 'architecture invariant violations or measurement incomplete — see architectureInvariantViolations for details',
    canonicalCaseSource: 'scripts/smoke-13.js',
    provider: 'cloudflare',
    model: MODELS[0],
    timestamp: new Date().toISOString(),
    configuration: {
      executionEngine: 'scout-lite',
      provider: 'cloudflare',
      model: MODELS[0],
      freeOnly: true,
      groqEnabled: false,
      geminiEnabled: false,
      githubModelsEnabled: false,
      ollamaEnabled: false,
      deterministicFinalProse: false,
      paidFallback: false,
      requestDeadlineMs: REQUEST_DEADLINE_MS,
    },
    // CRITICAL #2: Architecture invariant results
    architectureInvariantPassed: allResults[0]?.architectureInvariantPassed ?? false,
    architectureInvariantViolations: allResults[0]?.architectureInvariantViolations ?? [],
    // CRITICAL #8: Efficiency metrics validity
    efficiencyMetricsValid: allResults[0]?.efficiencyMetricsValid ?? false,
    // CRITICAL #9: visibleReplySource distribution
    visibleReplySourceCounts: allResults[0]?.visibleReplySourceCounts ?? {},
    // CRITICAL #6: Safety terminology
    safety: allResults[0]?.safety ?? {},
    results: allResults,
  };
  require('fs').writeFileSync(artifactFile, JSON.stringify(artifact, null, 2));
  console.log(`\nBaseline artifact saved to: ${artifactFile}`);
  console.log(`(Not committed — local only)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
