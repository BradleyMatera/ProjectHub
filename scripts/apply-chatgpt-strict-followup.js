'use strict';

/**
 * Guarded follow-up patch for Scout strict live failures found after 35b8ef9.
 *
 * Scope is intentionally narrow:
 *  1) acceptance scorer: parse only trusted technology candidates for project->tech claims
 *  2) negative assessments: learning/gap areas are not automatically personal weaknesses
 *  3) plural gap follow-ups: serialize label/summary fields and enforce current-progress semantics
 *  4) prompt contracts: tell the model the same semantics the scorer enforces
 *  5) /health: report the actual Ollama fallback separately from the Cloudflare primary model
 *  6) regression tests for the three strict-live failure classes
 *
 * Run from repository root:
 *   node scripts/apply-chatgpt-strict-followup.js
 *
 * The script refuses to continue when an expected source block no longer matches.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function editFile(relPath, transform) {
  const fullPath = path.join(ROOT, relPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const normalized = raw.replace(/\r\n/g, '\n');
  const updated = transform(normalized);
  if (updated === normalized) throw new Error(`${relPath}: patch produced no change`);
  fs.writeFileSync(fullPath, updated.replace(/\n/g, eol), 'utf8');
  console.log(`patched ${relPath}`);
}

function replaceOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  if (first === -1) throw new Error(`${label}: expected source block not found`);
  if (text.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error(`${label}: expected exactly one source block`);
  }
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

function replaceRegexOnce(text, regex, replacement, label) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one regex match, got ${matches.length}`);
  return text.replace(regex, replacement);
}

// ---------------------------------------------------------------------------
// 1) Strict scorer: project->technology validation must only inspect actual
//    technology candidates, never arbitrary narrative text such as
//    "client-side search/filtering".
// ---------------------------------------------------------------------------
editFile('lib/acceptance-scorer.js', text => {
  text = replaceRegexOnce(
    text,
    /function extractTechList\(segment\) \{[\s\S]*?\nfunction extractFutureTarget\(question\) \{/g,
`function technologyCandidates(knowledge, requestedTopic = null) {
  const raw = [
    ...(knowledgeAccess.getKnownTechnologies(knowledge) || []),
    requestedTopic
  ].filter(Boolean);
  const generic = new Set([
    'app', 'application', 'platform', 'project', 'service', 'system',
    'frontend', 'backend', 'development', 'code'
  ]);
  const candidates = new Map();

  for (const item of raw) {
    const whole = String(item || '').trim();
    const pieces = [whole, ...whole.split(/\\s*(?:\\/|\\||,|;)\\s*/)].filter(Boolean);
    for (const piece of pieces) {
      const value = piece.trim();
      const norm = normalizeToken(value);
      if (norm.length < 2 || generic.has(norm)) continue;
      if (!candidates.has(norm)) candidates.set(norm, value);
    }
  }
  return [...candidates.entries()].map(([norm, value]) => ({ norm, value }));
}

function textMentionsTechnology(text, technology) {
  const escaped = escapeRegex(String(technology || '').trim()).replace(/\\s+/g, '\\\\s+');
  if (!escaped) return false;
  return new RegExp(\`(?:^|[^A-Za-z0-9+#.])\${escaped}(?=$|[^A-Za-z0-9+#.])\`, 'i').test(String(text || ''));
}

function normalizedProjectTechs(project) {
  const values = [];
  for (const item of project?.tech || []) {
    const whole = String(item || '').trim();
    for (const piece of [whole, ...whole.split(/\\s*(?:\\/|\\||,|;)\\s*/)]) {
      const norm = normalizeToken(piece);
      if (norm) values.push(norm);
    }
  }
  return [...new Set(values)];
}

function projectTechRelationshipClaims(reply, knowledge, requestedTopic = null) {
  const bad = [];
  if (!Array.isArray(knowledge?.projects) || !reply) return bad;

  const relationVerb = /\\b(?:uses?|used|using|utilizes?|utilized|utilizing|built\\s+(?:with|using)|developed\\s+(?:with|using)|implemented\\s+(?:with|using)|written\\s+in|powered\\s+by)\\b/i;
  const negativeRelation = /\\b(?:does\\s+not|doesn't|did\\s+not|didn't|was\\s+not|wasn't|not\\s+built|not\\s+using|no\\s+verified)\\b/i;
  const candidates = technologyCandidates(knowledge, requestedTopic);
  const clauses = String(reply).split(/(?<=[.!?;])\\s+|\\n+|\\b(?:while|whereas)\\b/i).filter(Boolean);

  for (const project of knowledge.projects) {
    const names = [project.name, ...(project.aliases || [])].filter(Boolean);
    const projectTechs = normalizedProjectTechs(project);

    for (const clause of clauses) {
      const lowerClause = clause.toLowerCase();
      for (const name of names) {
        const nameIndex = lowerClause.indexOf(String(name).toLowerCase());
        if (nameIndex === -1) continue;

        // Scope the relation to text following this project mention. If another
        // project appears later in the same clause, stop before that mention so
        // technologies do not leak across compared projects.
        let afterProject = clause.slice(nameIndex + String(name).length);
        let nextProject = afterProject.length;
        for (const other of knowledge.projects) {
          if (other === project) continue;
          for (const otherName of [other.name, ...(other.aliases || [])].filter(Boolean)) {
            const pos = afterProject.toLowerCase().indexOf(String(otherName).toLowerCase());
            if (pos >= 0 && pos < nextProject) nextProject = pos;
          }
        }
        afterProject = afterProject.slice(0, nextProject);

        const relation = relationVerb.exec(afterProject);
        if (!relation || relation.index > 100) continue;
        const relationSegment = afterProject.slice(relation.index);
        if (negativeRelation.test(relationSegment)) continue;

        for (const candidate of candidates) {
          if (!textMentionsTechnology(relationSegment, candidate.value)) continue;
          const supported = projectTechs.some(pt =>
            pt === candidate.norm ||
            (pt.length >= 4 && candidate.norm.length >= 4 && (pt.includes(candidate.norm) || candidate.norm.includes(pt)))
          );
          if (!supported) {
            bad.push({ project: project.name, claimedTech: candidate.norm, projectTechs });
          }
        }
      }
    }
  }

  const seen = new Set();
  return bad.filter(item => {
    const key = \`\${item.project}|\${item.claimedTech}\`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFutureTarget(question) {`,
    'replace narrative project-tech parser'
  );

  text = replaceOnce(
    text,
`function validateProjectTechRelationship(testCase, result, opts) {
  const knowledge = opts.knowledge;
  const reply = getReply(result);
  const bad = projectTechRelationshipClaims(reply, knowledge);`,
`function validateProjectTechRelationship(testCase, result, opts) {
  const knowledge = opts.knowledge;
  const reply = getReply(result);
  const contract = getContract(result);
  const bad = projectTechRelationshipClaims(reply, knowledge, contract?.requestedTopic || testCase.expect?.requestedTopic || null);`,
    'pass requested topic to project-tech validator'
  );

  text = replaceOnce(
    text,
`  const projectTechBad = projectTechRelationshipClaims(reply, opts.knowledge);`,
`  const projectTechBad = projectTechRelationshipClaims(reply, opts.knowledge, contract?.requestedTopic || expect.requestedTopic || null);`,
    'pass requested topic to universal project-tech guard'
  );

  // A learning/gap item can be documented without being a verified personal
  // weakness, and certainly without being ranked as the "biggest" weakness.
  text = replaceOnce(
    text,
`function validateNegativeAssessment(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);

  // factState must be unknown; a known "NO" direct answer can be acceptable if it is about the lack of evidence.
  if (contract && contract.factState === 'TRUE') {
    return { quality: QUALITY.FACT_WRONG, reason: 'negative assessment produced TRUE factState' };
  }

  // Must not invent a personal weakness.
  if (/\\b(?:he is bad at|he is weak at|his weakness is|he struggles with|he is terrible at|poor at|bad at)\\b/i.test(reply)) {
    return { quality: QUALITY.OVERCLAIM, reason: 'negative assessment invents a personal weakness' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}`,
`function validateNegativeAssessment(testCase, result, opts) {
  const reply = getReply(result);
  const contract = getContract(result);

  if (contract && contract.factState === 'TRUE') {
    return { quality: QUALITY.FACT_WRONG, reason: 'negative assessment produced TRUE factState' };
  }

  const explicitWeakness = /\\b(?:he is bad at|he is weak at|his weakness is|he struggles with|he is terrible at|poor at|bad at)\\b/i;
  const rankedWeakness = /\\b(?:his|her|their|the\\s+candidate(?:'s)?|the\\s+subject(?:'s)?|[a-z][a-z'-]+(?:\\s+[a-z][a-z'-]+)?'s)\\s+(?:(?:biggest|main|primary|greatest|worst|honest)\\s+){0,3}weakness(?:es)?\\s+(?:is|are)\\b/i;
  const boundedWeakness = /\\bweakness(?:es)?\\s+(?:is|are)\\s+(?:unknown|not\\s+(?:verified|documented|established|known))\\b/i;

  if (explicitWeakness.test(reply) || (rankedWeakness.test(reply) && !boundedWeakness.test(reply))) {
    return { quality: QUALITY.OVERCLAIM, reason: 'negative assessment turns an unverified gap/learning area into a personal weakness' };
  }

  return { quality: QUALITY.GOOD, reason: null };
}`,
    'strengthen negative-assessment semantics'
  );

  text = replaceOnce(
    text,
`    const learningItems = knowledge?.skills?.learningOrAdjacent || [];
    const learningNorms = learningItems.map(x => normalizeText(typeof x === 'string' ? x : x.name)).filter(Boolean);`,
`    const learningItems = knowledge?.skills?.learningOrAdjacent || [];
    const learningTexts = learningItems.flatMap(item => {
      if (typeof item === 'string') return [item];
      if (!item || typeof item !== 'object') return [];
      return [
        item.label,
        item.name,
        item.skill,
        item.title,
        item.summary,
        item.description,
        item.detail
      ].filter(Boolean).map(String);
    });
    const learningNorms = learningTexts.map(normalizeText).filter(Boolean);`,
    'serialize plural learning items'
  );

  text = replaceOnce(
    text,
`    if (!hasResolution) {
      return { quality: QUALITY.CONTEXT_ERROR, reason: 'plural referent not resolved to a documented learning/gap item' };
    }
  }

  return { quality: QUALITY.GOOD, reason: null };
}`,
`    if (!hasResolution) {
      return { quality: QUALITY.CONTEXT_ERROR, reason: 'plural referent not resolved to a documented learning/gap item' };
    }

    const asksCurrentProgress = /\\b(?:working\\s+on|work\\s+on|address(?:ing)?|improv(?:e|ing)|develop(?:ing)?|progress)\\b/i.test(question);
    if (asksCurrentProgress) {
      const boundedUnknown = /\\b(?:unknown|not\\s+(?:verified|documented|established|known)|no\\s+(?:verified|public|current)\\s+(?:evidence|record|information)|cannot\\s+verify|can't\\s+verify)\\b/i.test(reply);
      const explicitProgress = /\\b(?:is|currently|actively|has\\s+been)\\s+(?:working|learning|studying|practicing|training|developing|addressing|improving)\\b/i.test(reply);
      const sourceShowsProgress = learningTexts.some(item => /\\b(?:currently|actively|working\\s+on|learning|studying|taking\\s+(?:a\\s+)?course|practicing|training|developing|improving)\\b/i.test(item));

      if (explicitProgress && !sourceShowsProgress) {
        return { quality: QUALITY.OVERCLAIM, reason: 'plural follow-up invents current progress on a documented learning/gap item' };
      }
      if (!boundedUnknown && !explicitProgress) {
        return { quality: QUALITY.CONTEXT_ERROR, reason: 'plural follow-up names the gap but does not answer whether current progress is verified' };
      }
    }
  }

  return { quality: QUALITY.GOOD, reason: null };
}`,
    'enforce plural current-progress semantics'
  );

  return text;
});

// ---------------------------------------------------------------------------
// 2) Response contract: distinguish personal weaknesses from documented gaps;
//    answer "working on them?" as a current-progress claim, not as a transfer-
//    able-skills inference.
// ---------------------------------------------------------------------------
editFile('lib/response-contract.js', text => replaceOnce(
  text,
`  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    instructions.push('Only mention weaknesses or gaps that are explicitly documented in the facts. If none are documented, say so. Do not invent negative personal traits.');
    instructions.push('Ground the answer with one of these words: unknown, verified, public, or profile. Quote the documented gap items if any.');
  }`,
`  if (subIntent === 'NEGATIVE_ASSESSMENT') {
    instructions.push('Keep personal weaknesses separate from documented learning or gap areas. A documented gap is not automatically a personal weakness, and you must not rank it as the biggest, main, worst, or primary weakness unless the facts explicitly rank it.');
    instructions.push('If no personal weakness is explicitly verified, say that it is unknown or not established in the verified/public profile. You may name documented learning or gap areas, but label them as learning/gap areas rather than personal weaknesses.');
    const asksCurrentProgress = /\\b(?:working\\s+on|work\\s+on|address(?:ing)?|improv(?:e|ing)|develop(?:ing)?|progress)\\b/i.test(question);
    if (asksCurrentProgress) {
      instructions.push('This asks about current progress on previously discussed areas. Keep the referent tied to the documented learning/gap items. Do not infer active work from transferable skills. State current progress only if the facts explicitly establish it; otherwise say current progress is unknown or not verified.');
    }
  }`,
  'tighten negative/progress response instructions'
));

// ---------------------------------------------------------------------------
// 3) Lite-agent high-risk constraint: same semantics, short enough for the 3B
//    prompt budget.
// ---------------------------------------------------------------------------
editFile('lib/lite-agent.js', text => replaceOnce(
  text,
`    // Negative assessment: ensure the answer is grounded and uses required vocabulary
    if (isNegativeAssessment) {
      constraints.push(\`NEGATIVE: Mention only documented gaps. Ground the answer with one of these words: unknown, verified, public, or profile.\`);
    }`,
`    // Negative assessment: keep factual gaps separate from personal weakness claims.
    if (isNegativeAssessment) {
      constraints.push(\`NEGATIVE: A documented learning/gap area is not automatically a personal weakness. Do not rank or label a gap as the subject's weakness. If no personal weakness is explicitly verified, say it is unknown/not established; mention documented gaps only as learning/gap areas. For current-progress follow-ups, do not infer active work from transferable skills.\`);
    }`,
  'tighten lite negative constraint'
));

// ---------------------------------------------------------------------------
// 4) /health telemetry: defaultModel() is provider-aware and therefore returns
//    the Cloudflare model under Cloudflare. ollamaModel() is the actual local
//    fallback accessor.
// ---------------------------------------------------------------------------
editFile('server-gemini.js', text => replaceOnce(
  text,
`function configuredInferenceHealth() {
  const provider = process.env.SCOUT_INFERENCE_PROVIDER || 'auto';
  const localModel = localModelRouter.defaultModel() || GEN_MODEL;
  const cloudflareModel = cloudflareProvider.configuredModel();
  const primaryModel = provider === 'cloudflare'
    ? cloudflareModel
    : provider === 'ollama'
      ? localModel
      : (process.env.CLOUDFLARE_MODEL || localModel || cloudflareModel);

  return {
    provider,
    primaryModel,
    cloudflareModel,
    localFallbackModel: localModel,
    requestDeadlineMs: parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10),
    generationTimeoutMs: parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10)
  };
}`,
`function configuredInferenceHealth() {
  const provider = process.env.SCOUT_INFERENCE_PROVIDER || 'auto';
  const localFallbackModel = localModelRouter.ollamaModel() || GEN_MODEL;
  const cloudflareModel = cloudflareProvider.configuredModel();
  const primaryModel = provider === 'cloudflare'
    ? cloudflareModel
    : provider === 'ollama'
      ? localFallbackModel
      : (process.env.CLOUDFLARE_MODEL || cloudflareModel || localFallbackModel);

  return {
    provider,
    primaryModel,
    cloudflareModel,
    localFallbackModel,
    requestDeadlineMs: parseInt(process.env.REQUEST_DEADLINE_MS || '15000', 10),
    generationTimeoutMs: parseInt(process.env.GEN_TIMEOUT_MS || '12500', 10)
  };
}`,
  'fix provider-aware fallback telemetry'
));

// ---------------------------------------------------------------------------
// 5) Regression tests. These deliberately use the exact *classes* of failure
//    observed live, but remain tenant-agnostic where the semantics are generic.
// ---------------------------------------------------------------------------
editFile('test/acceptance-scorer.test.js', text => {
  const marker = '// ChatGPT strict follow-up regressions (post-35b8ef9)';
  if (text.includes(marker)) throw new Error('acceptance scorer follow-up tests already present');
  return text.trimEnd() + `\n\n${marker}\n` + String.raw`
test('project-tech guard ignores narrative functionality after a verified technology', () => {
  const result = makeResult(
    'Yes, Bradley has project experience with JavaScript. The Interactive Pokedex utilized JavaScript to create a Static Gen 1 Pokedex UI with client-side search/filtering, data display, and theme controls.',
    { intent: 'SKILL', subIntent: 'SKILL_EVIDENCE', factState: 'TRUE', directAnswer: 'YES', requestedTopic: 'JavaScript' }
  );
  const c = { id: 'known-skill-narrative', message: 'Does he know JavaScript?', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('project-tech guard still rejects requested unknown technology assigned to a project', () => {
  const result = makeResult(
    'The Triangle Shader Lab was built using Rust.',
    { intent: 'FUTURE_CAPABILITY', subIntent: 'FUTURE_CAPABILITY', factState: 'UNKNOWN', directAnswer: 'UNKNOWN', requestedTopic: 'Rust' }
  );
  const c = { id: 'unknown-tech-project-link', message: 'Could he learn Rust?', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.OVERCLAIM, s.reason);
});

test('NEGATIVE_ASSESSMENT rejects ranking a documented gap as the subject personal weakness', () => {
  const result = makeResult(
    "The candidate's biggest honest weakness is data structures and algorithms.",
    { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'negative-ranked-gap', message: "What's the candidate's honest weakness?", semanticType: 'NEGATIVE_ASSESSMENT', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.OVERCLAIM, s.reason);
});

test('NEGATIVE_ASSESSMENT allows bounded unknown plus documented learning-area framing', () => {
  const result = makeResult(
    'No verified public profile fact establishes a personal weakness. A documented learning area can still be discussed as a gap without calling it a personal weakness.',
    { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'negative-bounded', message: "What's the candidate's honest weakness?", semanticType: 'NEGATIVE_ASSESSMENT', expect: {} };
  const s = scoreCase(c, result, { knowledge });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('PLURAL_REFERENT reads object label/summary fields and accepts bounded unknown progress', () => {
  const synthetic = JSON.parse(JSON.stringify(knowledge));
  synthetic.skills = synthetic.skills || {};
  synthetic.skills.learningOrAdjacent = [{
    label: 'ERP systems and business operations',
    summary: 'Documented learning area; current active progress is not verified.'
  }];
  const result = makeResult(
    'Current progress on ERP systems and business operations is not verified in the public profile.',
    { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'plural-progress', message: 'Is he working on them?', semanticType: 'PLURAL_REFERENT', expect: {} };
  const s = scoreCase(c, result, { knowledge: synthetic });
  assert.equal(s.quality, QUALITY.GOOD, s.reason);
});

test('PLURAL_REFERENT rejects modal transferable-skill prose that does not answer current progress', () => {
  const synthetic = JSON.parse(JSON.stringify(knowledge));
  synthetic.skills = synthetic.skills || {};
  synthetic.skills.learningOrAdjacent = [{
    label: 'ERP systems and business operations',
    summary: 'Documented learning area; no active progress is established.'
  }];
  const result = makeResult(
    'Project-management experience could be applied to ERP systems and business operations.',
    { intent: 'NEGATIVE_ASSESSMENT', subIntent: 'NEGATIVE_ASSESSMENT', factState: 'UNKNOWN', directAnswer: 'UNKNOWN' }
  );
  const c = { id: 'plural-modal', message: 'Is he working on them?', semanticType: 'PLURAL_REFERENT', expect: {} };
  const s = scoreCase(c, result, { knowledge: synthetic });
  assert.equal(s.quality, QUALITY.CONTEXT_ERROR, s.reason);
});
` + '\n';
});

console.log('ChatGPT strict follow-up patch applied.');
console.log('Next: let Devin run npm/test/build/retrieval, review the diff, commit changed runtime files, deploy dev, then rerun only the affected live cases.');
