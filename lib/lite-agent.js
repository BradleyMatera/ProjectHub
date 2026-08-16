'use strict';

// Scout LITE Agent — a compact local-AI execution path for constrained hardware.
//
// The FULL agent engine (lib/agent-engine.js) sends 775-900 token context packets
// to Ollama and lets the model select tools, reason, and synthesize across
// multiple steps. On a GCP e2-micro (2 vCPU, 958 MiB RAM), prompt eval runs at
// ~70 tokens/second, so a 900-token packet takes 13+ seconds per step — too slow.
//
// LITE mode moves orchestration into the Scout harness:
//
//   user question
//     -> query rewriter (resolve references using session state)
//     -> pre-router (deterministic tool selection)
//     -> tool execution (same tools as FULL mode)
//     -> evidence compressor (tool results -> compact facts)
//     -> tiny Ollama packet (150-250 tokens)
//     -> single generation
//     -> grounding validation (same validator as FULL mode)
//     -> optional tiny repair OR deterministic fallback
//
// The model still provides GENERATIVE intelligence — it writes the answer.
// But it doesn't waste scarce CPU reading seven tool definitions or deciding
// which tool to call. Scout prepares the problem; Ollama communicates the answer.
//
// Shared with FULL mode:
//   - retrieval (BM25 + RRF)
//   - tools (agent-tools.js)
//   - session state (session-state.js)
//   - validation (grounding-validator.js)
//   - model router (local-model-router.js)
//   - knowledge base
//
// Different:
//   - context packet size (150-250 tokens vs 775-900)
//   - single generation vs multi-step loop
//   - harness pre-routes tools vs model selects tools
//   - compressed evidence vs raw evidence

const router = require('./local-model-router');
const { executeAgentTool, selectAgentToolNames } = require('./agent-tools');
const { validateAnswer, extractCompleteSentences, answerAddressesExternalTopic } = require('./grounding-validator');
const { resolveReferents } = require('./session-state');
const { buildConversationState, resolveReferent } = require('./conversation-resolver');
const scoutIdentity = require('./scout-identity');
const { buildRelationshipGraph } = require('./relationship-graph');
const { evaluateCompleteness, classifyIntent } = require('./completeness-check');
const { planResponse, formatPlanForPrompt } = require('./response-planner');
const { buildResponseContract } = require('./response-contract');
const { buildRecoveryContract, buildRecoveryPrompt, buildTerseYesNoContract, buildTerseAdversarialContract, RECOVERY_MAX_TOKENS, RECOVERY_TIMEOUT_MS } = require('./recovery-contract');

// --- Configuration ---

const LITE_MAX_TOKENS = parseInt(process.env.SCOUT_LITE_MAX_TOKENS || '320', 10);
const LITE_TIMEOUT_MS = Math.max(3000, Math.min(parseInt(process.env.SCOUT_LITE_TIMEOUT_MS || '15000', 10), 30000));
const LITE_REPAIR_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.SCOUT_LITE_REPAIR_TIMEOUT_MS || '10000', 10), 20000));
const LITE_ENABLE_REPAIR = process.env.SCOUT_LITE_ENABLE_REPAIR !== 'false';
const LITE_NUM_CTX = parseInt(process.env.SCOUT_LITE_NUM_CTX || '1024', 10);
const LITE_NUM_PREDICT = parseInt(process.env.SCOUT_LITE_NUM_PREDICT || '120', 10);

// Token estimation — uses a word-based heuristic. This is NOT exact token
// counting. Words average ~1.3 tokens for English text; punctuation and
// short words add overhead. For pre-generation budget control, a conservative
// safety margin is applied. Ollama's actual runtime metrics (prompt_eval_count,
// eval_count) should be used to validate this estimator post-generation.
function estimatedInputTokens(text) {
  if (!text) return 0;
  const str = String(text);
  const words = str.split(/\s+/).filter(Boolean);
  const punctTokens = (str.match(/[.,;:!?()[\]{}"'`/\\@#$%^&*+=|<>~]/g) || []).length;
  // Add 15% safety margin to avoid underestimating
  return Math.ceil((words.length * 1.3 + punctTokens * 0.5) * 1.15);
}

// Compute context budget from estimated input tokens.
// Returns system/user/total estimated tokens and available generation budget.
function computeContextBudget(systemPrompt, userPrompt, numCtx) {
  const systemTokens = estimatedInputTokens(systemPrompt);
  const userTokens = estimatedInputTokens(userPrompt);
  const totalTokens = systemTokens + userTokens;
  const availableForGeneration = Math.max(50, numCtx - totalTokens);
  return { systemTokens, userTokens, totalTokens, availableForGeneration };
}

// Human-readable hints for common validation failures, used in repair packets.
const REPAIR_HINTS = {
  too_short: 'Answer is too short. Write 1-2 complete sentences with specific details from the facts.',
  too_long: 'Answer is too long. Keep it to 1-2 sentences.',
  no_terminal_punctuation: 'End the answer with a period.',
  too_many_sentences: 'Use at most 2 sentences.',
  overclaim_language: 'Remove exaggerated language (expert, led, architected). Use exact facts only.',
  insufficient_content_overlap: 'Use more specific words from the facts.',
  not_relevant_to_question: 'Answer the actual question directly.',
  ai_slop: 'Remove generic AI phrases. Be specific and factual.',
  expanded_overclaim: 'Remove inflation language like "extensive experience", "expertise in", "specializing in", "adept at", "proficient in". He is entry-level.',
  unsupported_relationship: 'You connected two entities that FACTS do not connect. Only state relationships explicitly in FACTS. Do not mix facts from different projects.',
  relationship_overclaim: 'You used expertise/seniority language. He is entry-level. Use "has experience with" not "has expertise in".',
  fabricated_entity: 'You mentioned a technology/entity not in the knowledge base. Only use entities from FACTS.',
  persona_confusion: 'You spoke as the subject (first person). You are Scout, the assistant. Use "he/his" not "I/my" when talking about the subject.'
};

// --- Query Rewriter ---
// Resolves references ("that", "it", "the backend", "there", "this thing",
// "the other project") using conversation state and knowledge entities.
// Rewrites the question so Ollama doesn't need to do coreference resolution.

function rewriteQuery(question, state, knowledge, history) {
  const q = String(question || '').trim();
  if (!q) return { rewritten: q, rewritten_: false };

  // First try the new conversation resolver (uses full history + knowledge)
  if (history && knowledge) {
    const convState = buildConversationState(history, knowledge);
    const result = resolveReferent(q, convState, knowledge);
    if (result.resolved && result.rewrittenQuery !== q) {
      return { rewritten: result.rewrittenQuery, rewritten_: true, resolvedEntity: result.entity, referentType: result.referentType };
    }
    const intent = classifyIntent(q);
    const isExistentialThere = /^there\s+(?:is|are|was|were)\b/i.test(q);
    if (!result.resolved && result.referentType && intent !== 'ADVERSARIAL' && !isExistentialThere) {
      return {
        rewritten: q,
        rewritten_: false,
        referentType: result.referentType,
        clarificationRequired: true
      };
    }
  }

  // Fall back to legacy session-state-based resolution
  if (!state) return { rewritten: q, rewritten_: false };
  const refs = resolveReferents(state);
  const lower = q.toLowerCase();

  // "What about the backend?" -> "What about ProjectHub's backend?"
  if (/\b(the|its|that'?s)\s+(backend|frontend|api|ui|database|server)\b/i.test(q) && refs.projects?.length) {
    const project = refs.projects[0];
    const rewritten = q.replace(/\b(the|its|that'?s)\s+(backend|frontend|api|ui|database|server)\b/i, `${project}'s $2`);
    return { rewritten, rewritten_: true, resolvedProject: project };
  }

  // "What about that?" / "Tell me more about it" -> resolve to current project
  if (/^(what about|tell me more about|more about|what else about)\s+(that|it|this|the first one)\b/i.test(q) && refs.projects?.length) {
    const project = refs.projects[0];
    const rewritten = q.replace(/\b(that|it|this|the first one)\b/i, project);
    return { rewritten, rewritten_: true, resolvedProject: project };
  }

  // "Compare that to Voice Ops" -> "Compare ProjectHub to Voice Ops"
  if (/\bcompare\b.*\b(that|it|this)\b.*\b(to|with|vs|and)\b/i.test(q) && refs.projects?.length) {
    const project = refs.projects[0];
    const rewritten = q.replace(/\b(that|it|this)\b/i, project);
    return { rewritten, rewritten_: true, resolvedProject: project };
  }

  // "Which one is more complex?" -> "Which is more complex: ProjectHub or Voice Ops?"
  if (/\bwhich (one|is)\b/i.test(q) && refs.comparison?.length >= 2) {
    const rewritten = `Which is more technically complex: ${refs.comparison[0]} or ${refs.comparison[1]}?`;
    return { rewritten, rewritten_: true, resolvedComparison: refs.comparison };
  }

  return { rewritten: q, rewritten_: false };
}

// --- Pre-Router ---
// Deterministically selects which tool to execute based on query understanding.
// Falls back to search_portfolio for ambiguous cases.

function preRoute(question, state, knowledge) {
  const q = String(question || '').toLowerCase();
  const refs = resolveReferents(state);

  // OOS and REFUSAL: no tool execution needed — the response contract
  // and model prompt handle the redirect/refusal. Return a minimal search
  // route so the pipeline has something to compress.
  const earlyIntent = classifyIntent(question);
  if (earlyIntent === 'OOS' || earlyIntent === 'REFUSAL') {
    return { operation: 'oos', tool: 'search_portfolio', args: { query: '', limit: 0 } };
  }

  // Comparison: "compare X and Y", "X vs Y", "which is better"
  if (/\bcompare\b|versus|\bvs\b|\bwhich is\b.*\b(more|better|complex)\b/i.test(q)) {
    const projects = detectProjectNames(question, knowledge, refs);
    if (projects.length >= 2) {
      // Check if all projects are in the structured knowledge base
      const structuredNames = new Set((knowledge?.projects || []).map(p => String(p.name || '').toLowerCase()));
      const allStructured = projects.every(p => structuredNames.has(p.toLowerCase()));
      if (allStructured) {
        return { operation: 'compare', tool: 'compare_projects', args: { names: projects.slice(0, 4) } };
      }
      // Mixed structured/unstructured — use search for each project name
      // to gather evidence, then compress for the model
      return { operation: 'compare', tool: 'search_portfolio', args: { query: projects.join(' '), limit: 6 } };
    }
    // Comparison follow-up with state
    if (refs.comparison?.length >= 2) {
      const structuredNames = new Set((knowledge?.projects || []).map(p => String(p.name || '').toLowerCase()));
      const allStructured = refs.comparison.every(p => structuredNames.has(p.toLowerCase()));
      if (allStructured) {
        return { operation: 'compare', tool: 'compare_projects', args: { names: refs.comparison.slice(0, 4) } };
      }
      return { operation: 'compare', tool: 'search_portfolio', args: { query: refs.comparison.join(' '), limit: 6 } };
    }
  }

  // Single project: "tell me about X", "what is X"
  // Check this BEFORE the generic "tell me about" to catch project names
  if (/\b(?:tell me about|what is|describe|show me)\b/i.test(q)) {
    const projects = detectProjectNames(question, knowledge, refs);
    if (projects.length === 1) {
      // Check if it's a structured project
      const structuredNames = new Set((knowledge?.projects || []).map(p => String(p.name || '').toLowerCase()));
      if (structuredNames.has(projects[0].toLowerCase())) {
        return { operation: 'project', tool: 'get_project', args: { name: projects[0] } };
      }
      // Unstructured project — use search
      return { operation: 'project', tool: 'search_portfolio', args: { query: projects[0], limit: 3 } };
    }
    if (projects.length >= 2) {
      // Multiple projects mentioned — might be a comparison
      return { operation: 'compare', tool: 'search_portfolio', args: { query: projects.join(' '), limit: 6 } };
    }
  }

  // Project-aware follow-up: if the rewritten query contains a project name
  // and asks about tech/usage/building/tools, route to get_project.
  // Exclude "why" questions (rationale) and "tell me about" (handled above).
  // Check for explicit project name in the query (not from refs) to avoid
  // adding conversation-state projects that aren't in the current question.
  if (!/\bwhy\b/i.test(q) && /\b(?:use|used|build|built|tech|technology|tools?|stack|what.*did.*he|what.*does.*it)\b/i.test(q)) {
    const structuredProjects = knowledge?.projects || [];
    const explicitProject = structuredProjects.find(p => {
      const name = String(p.name || '').toLowerCase();
      if (!name) return false;
      return q.includes(name);
    });
    if (explicitProject) {
      return { operation: 'project', tool: 'get_project', args: { name: explicitProject.name } };
    }
  }

  // "What about [project name]" — route to get_project for the named project
  if (/^what about\b/i.test(q) || /\bwhat about\s+(?:the\s+)?(?:other\s+)?project\b/i.test(q)) {
    // Check for explicit project name in the query (not from refs)
    const structuredProjects = knowledge?.projects || [];
    const explicitProject = structuredProjects.find(p => {
      const name = String(p.name || '').toLowerCase();
      if (!name) return false;
      if (q.includes(name)) return true;
      // Check aliases
      for (const alias of p.aliases || []) {
        if (alias && q.includes(alias.toLowerCase())) return true;
      }
      return false;
    });
    if (explicitProject) {
      return { operation: 'project', tool: 'get_project', args: { name: explicitProject.name } };
    }
  }

  // Opinion/comparison follow-up: "most interesting", "most complex", "most impressive"
  // without explicit "compare" — route to compare_projects with top projects by tech count
  if (/\b(?:most interesting|most complex|most impressive|most challenging|favorite)\b/i.test(q)) {
    const allProjects = (knowledge?.projects || [])
      .filter(p => p.name && p.tech?.length)
      .sort((a, b) => (b.tech?.length || 0) - (a.tech?.length || 0))
      .map(p => p.name)
      .slice(0, 4);
    if (allProjects.length >= 2) {
      return { operation: 'compare', tool: 'compare_projects', args: { names: allProjects } };
    }
  }

  // Certification questions: "what certifications", "what certs", "what AWS certifications"
  // Route to profile/certifications instead of skill evidence
  if (/\b(?:certifications?|certs?)\b/i.test(q)) {
    return { operation: 'profile', tool: 'get_candidate_profile', args: { section: 'certifications' } };
  }
  // Gap/weakness questions: "what experience does he lack", "what are his weaknesses",
  // "what should a recruiter know about gaps" — route to search, not skill evidence
  if (/\b(?:lack|lacks|lacking|weakness|weaknesses|gap|gaps|shortcoming|need\s+to\s+learn|still\s+learning|concerns?|what should.*know)\b/i.test(q)) {
    return { operation: 'search', tool: 'search_portfolio', args: { query: String(question || '').slice(0, 200), limit: 5 } };
  }

  const intent = classifyIntent(question);
  if (intent === 'JOB_FIT' || q.length > 150) {
    return { operation: 'job', tool: 'match_role', args: { role: '', jobDescription: String(question || '').slice(0, 500) } };
  }
  if (intent === 'RECRUITER' && /\b(?:worth|interview|recommend|ask\s+him)\b/i.test(q)) {
    return { operation: 'brief', tool: 'build_recruiter_brief', args: { focus: '' } };
  }

  const skill = extractSkill(question, knowledge);
  const asksForSkillEvidence = intent === 'SKILL' ||
    (intent === 'FOLLOW_UP' && skill) ||
    (intent === 'YES_NO' && skill && /\b(?:experience|skills?|know|used|familiar)\b/i.test(q)) ||
    /\b(?:experience with|evidence (?:for|of)|what about)\b/i.test(q);
  if (skill && asksForSkillEvidence) {
    return { operation: 'skill', tool: 'get_skill_evidence', args: { skill } };
  }

  // Recruiter brief: "give me a brief", "summarize this candidate", "quick version"
  if (/\b(?:brief|recruiter summary|hiring manager|quick version|quick brief|summarize (?:this )?candidate|give me the quick)\b/i.test(q)) {
    return { operation: 'brief', tool: 'build_recruiter_brief', args: { focus: '' } };
  }

  // Profile: "tell me about Bradley", "skills", "education", "experience"
  if (/\b(?:tell me about bradley|about him|his background|his skills|his experience|his education|his certifications|his goals)\b/i.test(q)) {
    const sectionMatch = q.match(/\b(skills|experience|education|certifications|goals|summary)\b/i);
    const section = sectionMatch ? sectionMatch[1] : 'summary';
    return { operation: 'profile', tool: 'get_candidate_profile', args: { section } };
  }

  // Default: broad search
  return { operation: 'search', tool: 'search_portfolio', args: { query: String(question || '').slice(0, 200), limit: 5 } };
}

// Extract a skill name from a question like "Does Bradley know React?"
function extractSkill(question, knowledge) {
  const q = String(question || '');
  const lower = q.toLowerCase();
  const skillGroups = knowledge?.skills && typeof knowledge.skills === 'object'
    ? Object.values(knowledge.skills).flatMap(value => Array.isArray(value) ? value : [])
    : [];
  const projectTech = (knowledge?.projects || []).flatMap(project => project.tech || []);
  const candidates = [...new Set([...skillGroups, ...projectTech])]
    .filter(skill => typeof skill === 'string' && skill.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const skill of candidates) {
    if (lower.includes(skill.toLowerCase())) return skill;
  }
  // Fallback: extract word after "know/use/used/experience with/what about"
  // but NEVER extract prepositions, articles, or other grammatical tokens
  const STOPWORDS = new Set([
    'in', 'at', 'on', 'with', 'for', 'from', 'of', 'the', 'a', 'an',
    'there', 'it', 'that', 'this', 'those', 'these', 'his', 'her',
    'their', 'he', 'she', 'they', 'is', 'was', 'has', 'have', 'had',
    'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will',
    'and', 'or', 'but', 'not', 'no', 'yes', 'about', 'how', 'what',
    'when', 'where', 'why', 'which', 'who', 'whom', 'been', 'being',
    'to', 'too', 'very', 'also', 'just', 'only', 'than', 'then',
  ]);
  const m = q.match(/\b(?:know|used|use|using|experience with|what about)\s+([A-Za-z][A-Za-z0-9+#.]{1,30})\b/i);
  if (m && !STOPWORDS.has(m[1].toLowerCase())) return m[1];
  return null;
}

// Detect project names from question + state.
// Checks both structured projects and known project names from knowledge content.
function detectProjectNames(question, knowledge, refs) {
  const q = String(question || '').toLowerCase();
  const projects = knowledge?.projects || [];
  const found = [];

  // 1. Match against structured projects
  for (const project of projects) {
    const name = String(project.name || '').toLowerCase();
    if (!name) continue;
    if (q.includes(name)) {
      found.push(project.name);
      continue;
    }
    // Match on distinctive tokens
    const tokens = name.split(/\s+/).filter(w => w.length > 4);
    if (tokens.length && tokens.some(w => q.includes(w))) {
      found.push(project.name);
    }
  }

  // 2. Match against known project names that appear in knowledge but aren't
  //    structured projects (e.g. "Voice Ops Platform", "Bradley's Fairway")
  const KNOWN_UNSTRUCTURED = [
    'Voice Ops Platform',
    'Convo AI',
    'Car Match',
    'SecureLearn',
    "Bradley's Fairway"
  ];
  for (const name of KNOWN_UNSTRUCTURED) {
    if (q.includes(name.toLowerCase()) && !found.some(f => f.toLowerCase() === name.toLowerCase())) {
      found.push(name);
    }
  }

  // 3. Include projects from state if not enough found
  if (found.length < 2 && refs.projects?.length) {
    for (const p of refs.projects) {
      if (!found.includes(p)) found.push(p);
    }
  }
  return found.slice(0, 4);
}

// --- Evidence Compressor ---
// Converts tool results into compact factual statements.
// Preserves important caveats (internship, no production, personal project, etc.)
// Removes scoring metadata, internal IDs, duplicated prose.

const CAVEAT_PATTERNS = [
  /\binternship\b/i, /\bcapstone\b/i, /\bpersonal project\b/i, /\bno evidence\b/i,
  /\bnot (?:production|senior|professional|verified|documented)\b/i,
  /\bno (?:direct|verified|hands-on) (?:evidence|experience)\b/i,
  /\badjacent\b/i, /\blearn(?:ed|ing)\b/i, /\btraining\b/i,
  /\bcertification\b/i, /\bnot (?:a )?(?:senior|lead|principal|staff)\b/i,
  /\bjunior\b/i, /\bentry[- ]level\b/i, /\bfreelance\b/i,
  /\bhas not\b/i, /\bdoes not\b/i, /\bno record\b/i
];

function compressToolResult(toolName, result, maxChars) {
  if (!result) return '';
  const budget = maxChars || 800;

  if (toolName === 'get_skill_evidence') {
    return compressSkillEvidence(result, budget);
  }
  if (toolName === 'get_project') {
    return compressProject(result, budget);
  }
  if (toolName === 'compare_projects') {
    return compressComparison(result, budget);
  }
  if (toolName === 'match_role') {
    return compressMatchRole(result, budget);
  }
  if (toolName === 'build_recruiter_brief') {
    return compressBrief(result, budget);
  }
  if (toolName === 'get_candidate_profile') {
    return compressProfile(result, budget);
  }
  if (toolName === 'search_portfolio') {
    return compressSearch(result, budget);
  }
  // Generic fallback
  return compressGeneric(result, budget);
}

function compressSkillEvidence(result, budget) {
  const lines = [];
  const skill = result.skill || 'this technology';
  const evidence = result.evidence || 'unknown';

  // Structured skill evidence format for natural conversation
  lines.push(`SKILL: ${skill}.`);
  lines.push(`DIRECT: ${evidence}.`);

  if (result.details?.length) {
    const projects = [];
    const experience = [];
    for (const d of result.details.slice(0, 4)) {
      let text = '';
      if (typeof d === 'string') {
        text = d;
      } else if (d.type === 'project') {
        text = `${d.source || 'project'} uses ${(d.tech || []).join(', ')}${d.description ? `; ${d.description}` : ''}`;
      } else if (d.type === 'work') {
        text = `${d.source || 'work experience'} uses ${(d.skills || []).join(', ')}${d.summary ? `; ${d.summary}` : ''}`;
      } else if (d.items?.length) {
        text = `${d.type || 'evidence'}: ${d.items.join(', ')}`;
      } else if (d.description) {
        text = `${d.source || d.type || 'evidence'}: ${d.description}`;
      } else if (d.summary) {
        text = `${d.source || d.type || 'evidence'}: ${d.summary}`;
      } else if (d.tech?.length) {
        text = `${d.source || 'project'} uses ${d.tech.join(', ')}`;
      } else if (d.source) {
        text = `${d.type || 'evidence'} from ${d.source}`;
      } else {
        text = JSON.stringify(d).slice(0, 100);
      }
      if (text) {
        if (/project|demo|build/i.test(text)) {
          projects.push(text);
        } else if (/work|job|role|intern/i.test(text)) {
          experience.push(text);
        } else {
          projects.push(text);
        }
      }
    }
    if (projects.length) lines.push(`PROJECT: ${projects.slice(0, 2).join('; ')}.`);
    if (experience.length) lines.push(`EXPERIENCE: ${experience.slice(0, 2).join('; ')}.`);
  }

  // Add limitation note if present
  if (result.note) lines.push(`LIMIT: ${truncate(result.note, 80)}.`);

  // Add related technologies if available
  if (result.related?.length) {
    lines.push(`RELATED: ${result.related.slice(0, 3).join(', ')}.`);
  }

  return joinWithinBudget(lines, budget);
}

function compressProject(result, budget) {
  if (!result.found || !result.project) return 'Project not found.';
  const p = result.project;
  const lines = [];
  lines.push(`Project: ${p.name}.`);
  if (p.description) lines.push(`- ${truncate(p.description, 150)}`);
  if (p.tech?.length) lines.push(`- Tech: ${p.tech.slice(0, 6).join(', ')}.`);
  if (p.category) lines.push(`- Category: ${p.category}.`);
  if (p.summary) lines.push(`- ${truncate(p.summary, 120)}`);
  return joinWithinBudget(lines, budget);
}

function compressComparison(result, budget) {
  const projects = result.projects || [];
  if (!projects.length) return 'No projects found for comparison.';
  const lines = [];
  for (const p of projects) {
    const parts = [`${p.name}:`];
    if (p.description) parts.push(truncate(p.description, 80));
    if (p.tech?.length) parts.push(`tech=${p.tech.slice(0, 4).join(',')}`);
    lines.push(parts.join(' '));
  }
  return joinWithinBudget(lines, budget);
}

function compressMatchRole(result, budget) {
  const lines = [];
  if (result.role) lines.push(`ROLE: ${truncate(result.role, 80)}.`);

  // Strong matches — DIRECT_MATCH evidence
  if (result.strong?.length) {
    const strongItems = result.strong.slice(0, 4).map(s => `${s.skill}(${s.evidence})`);
    lines.push(`STRONG: ${strongItems.join(', ')}.`);
  } else if (result.matchedSkills?.length) {
    lines.push(`STRONG: ${result.matchedSkills.slice(0, 6).join(', ')}.`);
  }

  // Partial matches — ADJACENT experience
  if (result.partial?.length) {
    const partialItems = result.partial.slice(0, 4).map(p => `${p.skill}(${p.evidence})`);
    lines.push(`PARTIAL: ${partialItems.join(', ')}.`);
  }

  // Best evidence — concrete examples
  if (result.projectEvidence?.length) {
    const projs = result.projectEvidence.slice(0, 3).map(p => {
      const tech = (p.tech || []).slice(0, 3).join('/');
      return `${p.name}(${tech})`;
    });
    lines.push(`BEST EVIDENCE: ${projs.join('; ')}.`);
  }

  // Experience match
  if (result.experienceEvidence?.length) {
    const exps = result.experienceEvidence.slice(0, 2).map(e =>
      `${e.role} at ${e.company}${e.matchingSkills?.length ? ` (${e.matchingSkills.slice(0, 2).join(', ')})` : ''}`
    );
    lines.push(`EXPERIENCE: ${exps.join('; ')}.`);
  }

  // Gaps — what doesn't fit (normalize first-person source voice)
  if (result.gaps?.length) {
    lines.push(`GAPS: ${result.gaps.slice(0, 3).map(g => g.skill).join('; ')}.`);
  } else if (result.honestGaps?.length) {
    lines.push(`GAPS: ${result.honestGaps.slice(0, 3).map(g => truncate(normalizeSourceVoice(g), 60)).join('; ')}.`);
  }

  if (result.assessmentRule) lines.push(`NOTE: ${truncate(result.assessmentRule, 80)}.`);
  return joinWithinBudget(lines, budget) || 'Role match analysis available but no specific gaps or strengths identified.';
}

function compressBrief(result, budget) {
  const lines = [];
  if (result.candidateName) lines.push(`NAME: ${result.candidateName}.`);
  if (result.headline) lines.push(`ROLE: ${truncate(result.headline, 80)}`);
  if (result.topProjects?.length) {
    lines.push(`KEY: ${result.topProjects.slice(0, 3).map(p => p.name).join(', ')}.`);
  }
  if (result.topSkills?.length) {
    const skills = result.topSkills.slice(0, 6).map(s => s.skill).join(', ');
    lines.push(`SKILLS: ${skills}.`);
  }
  if (result.certifications?.length) {
    lines.push(`CERTS: ${result.certifications.slice(0, 2).map(c => c.name).join(', ')}.`);
  }
  if (result.experience?.length) {
    const exp = result.experience.slice(0, 2).map(e => `${e.role} at ${e.company}`).join('; ');
    lines.push(`EXPERIENCE: ${exp}.`);
  }
  if (result.education?.degree) {
    lines.push(`EDUCATION: ${truncate(result.education.degree, 60)} from ${result.education.school || ''}.`);
  }
  if (result.honestGaps?.length) {
    lines.push(`GAPS: ${result.honestGaps.slice(0, 2).map(g => truncate(normalizeSourceVoice(g), 50)).join('; ')}.`);
  }
  if (result.targetRoles?.length) {
    lines.push(`TARGET: ${result.targetRoles.slice(0, 3).join(', ')}.`);
  }
  return joinWithinBudget(lines, budget);
}

function compressProfile(result, budget) {
  if (!result.data) return `Profile section: ${result.section || 'unknown'}.`;
  const data = result.data;
  const lines = [];
  if (result.section === 'summary') {
    // Normalize first-person source voice to third person for bot output
    if (data.whoIAm) lines.push(`- ${truncate(normalizeSourceVoice(data.whoIAm), 150)}`);
    if (data.whatIDo) lines.push(`- ${truncate(normalizeSourceVoice(data.whatIDo), 120)}`);
    if (data.whatIAmLookingFor) lines.push(`- ${truncate(normalizeSourceVoice(data.whatIAmLookingFor), 100)}`);
    if (data.coreStrengths?.length) lines.push(`Strengths: ${data.coreStrengths.slice(0, 4).join(', ')}.`);
    if (data.honestGaps?.length) lines.push(`Gaps: ${data.honestGaps.slice(0, 2).map(g => truncate(normalizeSourceVoice(g), 60)).join('; ')}.`);
  } else if (result.section === 'skills') {
    const skills = Object.entries(data).flatMap(([group, vals]) =>
      Array.isArray(vals) ? vals.slice(0, 5).map(v => v) : []
    ).slice(0, 10);
    lines.push(`Skills: ${skills.join(', ')}.`);
  } else if (result.section === 'experience') {
    for (const e of (Array.isArray(data) ? data : []).slice(0, 3)) {
      lines.push(`- ${e.role || 'Role'} at ${e.company || 'Company'}. ${truncate(e.summary || '', 80)}`);
    }
  } else if (result.section === 'education') {
    if (data.degree) lines.push(`Degree: ${data.degree}.`);
    if (data.school) lines.push(`School: ${data.school}.`);
    if (data.field) lines.push(`Field: ${data.field}.`);
  } else if (result.section === 'certifications') {
    for (const c of (Array.isArray(data) ? data : []).slice(0, 4)) {
      lines.push(`- ${c.name || c.certification || 'Cert'} (${c.issuer || ''}).`);
    }
  } else if (result.section === 'goals') {
    if (data.targetRoles?.length) lines.push(`Target roles: ${data.targetRoles.slice(0, 4).join(', ')}.`);
    if (data.careerGoal) lines.push(`- ${truncate(data.careerGoal, 100)}`);
  } else {
    return compressGeneric(data, budget);
  }
  return joinWithinBudget(lines, budget);
}

function compressSearch(result, budget) {
  const results = result.results || [];
  if (!results.length) return 'No relevant evidence found.';
  const lines = [];
  for (const r of results.slice(0, 4)) {
    const text = r.description || r.text || r.content || '';
    const name = r.name || r.title || '';
    const label = name ? `[${name}]` : '';
    lines.push(`${label} ${truncate(text, 120)}`.trim());
  }
  return joinWithinBudget(lines, budget);
}

function compressGeneric(result, budget) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return truncate(text, budget);
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function joinWithinBudget(lines, budget) {
  const out = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length + 2 > budget) break;
    out.push(line);
    total += line.length + 2;
  }
  return out.join('\n');
}

// --- Adversarial Caveat Detector ---
// Detects when a question makes a claim that might be exaggerated (senior,
// production, led, expert, N years) and injects a positive fact that
// contradicts the claim, so the model has the correct context.
// IMPORTANT: Do NOT use the overclaim words in the caveat — the validator's
// upgrade detection checks if the source text contains the same words, and
// a caveat like "not a senior engineer" would satisfy the needs check.
const ADVERSARIAL_PATTERNS = [
  { re: /\bsenior\b/i, caveat: 'FACT: Bradley AWS role was intern/trainee level only.' },
  { re: /\bproduction\b/i, caveat: 'FACT: Bradley AWS work was capstone/training, not live operations or production.' },
  { re: /\b(\d+)\s+years?\b/i, caveat: 'FACT: Only confirm years if FACTS explicitly state a duration.' },
  { re: /\b(expert|led|architected|managed a team|managed the team|principal|staff)\b/i, caveat: 'FACT: Bradley is early career, entry-level, learning stage. No team management. No expert-level claims.' },
  { re: /\b(ceo|cto|founder|owner)\b/i, caveat: 'FACT: Bradley is an individual contributor, not an executive.' },
  { re: /\bmit\b/i, caveat: 'FACT: Bradley attended Full Sail University, not MIT.' },
  { re: /\bcomputer science degree\b/i, caveat: 'FACT: Bradley degree is from Full Sail University, not a CS program.' },
  { re: /\b(stanford|harvard|berkeley|princeton|yale|oxford|cambridge|caltech|carnegie mellon)\b/i, caveat: 'FACT: Bradley attended Full Sail University, not this school.' },
  { re: /\b(google|microsoft|apple|meta|facebook|netflix|tesla|openai|anthropic)\b/i, caveat: 'FACT: Bradley has not worked at this company. His tech experience is AWS internship and CIRIS freelance.' },
  { re: /\b(kubernetes|cka|ckad)\b/i, caveat: 'FACT: Bradley does not have a Kubernetes certification. His certs are AWS SAA and AWS AI Practitioner.' },
  { re: /\b(master'?s|ph\.?d|doctorate)\b/i, caveat: 'FACT: Bradley has a Bachelor of Science in Web Development from Full Sail University. No master\'s or PhD.' },
  { re: /\b(team of developers|managed developers|supervised|directed)\b/i, caveat: 'FACT: Bradley is an individual contributor. He has not managed or supervised a team.' },
  { re: /\b(fortune 500|enterprise clients|million users)\b/i, caveat: 'FACT: No evidence of Fortune 500 or enterprise-scale work.' },
];

function detectAdversarialCaveat(question, compressedEvidence) {
  const q = String(question || '');
  for (const pattern of ADVERSARIAL_PATTERNS) {
    if (pattern.re.test(q)) {
      return pattern.caveat;
    }
  }
  return null;
}

// Check if an answer contains a forbidden claim (overclaim word without negation)
const FORBIDDEN_CLAIM_PATTERNS = [
  { re: /\bsenior\b/i, except: /\b(not|never|no|wasn't|was not|isn't|is not)\b/i },
  { re: /\bproduction\b/i, except: /\b(not|never|no|wasn't|was not|internship|capstone|training)\b/i },
  { re: /\bmanaged a team\b/i, except: /\b(not|never|no|didn't|did not)\b/i },
  { re: /\barchitected\b/i, except: /\b(not|never|no|didn't|did not)\b/i },
  { re: /\bexpert\b/i, except: /\b(not|never|no|isn't|is not)\b/i },
  { re: /\bteam lead\b/i, except: /\b(not|never|no|wasn't|was not)\b/i },
  { re: /\b(\d+)\s+years?\b/i, except: /\b(not|never|no|doesn't|does not)\b/i },
];

function containsForbiddenClaim(text) {
  const t = String(text || '');
  for (const pattern of FORBIDDEN_CLAIM_PATTERNS) {
    if (pattern.re.test(t)) {
      // Check if the negation word is NEAR the forbidden word (within 40 chars),
      // not just anywhere in the text. "No, he had production experience" should
      // still be caught because "No" is far from "production".
      const match = t.match(pattern.re);
      if (match) {
        const matchIdx = match.index;
        const windowStart = Math.max(0, matchIdx - 40);
        const windowEnd = Math.min(t.length, matchIdx + match[0].length + 40);
        const window = t.slice(windowStart, windowEnd);
        if (!pattern.except.test(window)) {
          return true;
        }
      }
    }
  }
  return false;
}

// --- Lite Packet Builder ---
// Builds a tiny system+user prompt for Ollama. Target: 150-250 tokens.

// Build compact structured facts from the relationship graph for specific entities.
// This gives the model a clear, unambiguous view of what relationships are supported.
function buildStructuredFacts(graph, entityNames, maxLines = 12) {
  if (!graph || !graph.triples || entityNames.length === 0) return '';
  const lines = [];
  const seen = new Set();

  for (const entityName of entityNames) {
    if (!entityName) continue;
    const entityNorm = entityName.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Include the entity's type/description as the first fact so the model
    // knows WHAT the entity is before getting relationship triples. This
    // prevents mischaracterizations (e.g., "ProjectHub is a student platform"
    // when it's actually an AI recruiter assistant).
    if (graph.knowledge && Array.isArray(graph.knowledge.projects)) {
      const proj = graph.knowledge.projects.find(p => {
        const pNorm = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return pNorm.includes(entityNorm) || entityNorm.includes(pNorm);
      });
      if (proj && proj.description) {
        const descLine = `${proj.name}: ${proj.description}`;
        if (!seen.has(descLine)) {
          seen.add(descLine);
          lines.push(descLine);
        }
      }
    }

    // Find triples where this entity is the subject
    const subjTriples = graph.triples.filter(t => {
      const sNorm = t.subject.toLowerCase().replace(/[^a-z0-9]/g, '');
      return sNorm.includes(entityNorm) || entityNorm.includes(sNorm);
    });

    for (const t of subjTriples) {
      // Skip has_property (too noisy for structured facts)
      // is_type is now included via the project description above
      if (t.relation === 'is_type' || t.relation === 'has_property') continue;
      const line = `${t.subject} -> ${t.relation} -> ${t.object}`;
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

// Extract entity names from the question for structured fact lookup
function extractQuestionEntities(question, graph) {
  if (!question || !graph) return [];
  const entities = [];
  const words = question.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^A-Za-z0-9+#.\-]/g, '');
    if (!word || !/^[A-Z]/.test(word)) continue;
    // Skip question words
    const questionWords = new Set(['Tell', 'What', 'How', 'Does', 'Has', 'Is', 'Was',
      'Compare', 'Give', 'Summarize', 'Which', 'Why', 'When', 'Where', 'Who',
      'Are', 'Were', 'Have', 'Did', 'Do', 'Can', 'Could', 'Would', 'Should',
      'He', 'She', 'They', 'His', 'Her', 'Their', 'About', 'The', 'A', 'An']);
    if (questionWords.has(word)) continue;

    // Try single word
    let phrase = word;
    let wNorm = phrase.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (graph.entityIndex.has(wNorm)) {
      entities.push(phrase);
      continue;
    }
    // Try multi-word
    for (let j = i + 1; j < Math.min(i + 5, words.length); j++) {
      const next = words[j].replace(/[^A-Za-z0-9+#.\-]/g, '');
      if (!next || !/^[A-Z]/.test(next)) break;
      if (questionWords.has(next)) break;
      phrase += ' ' + next;
      const pNorm = phrase.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (graph.entityIndex.has(pNorm)) {
        entities.push(phrase);
        break;
      }
      // Fuzzy match
      for (const key of graph.entityIndex.keys()) {
        if (key.length >= 4 && (key.includes(pNorm) || pNorm.includes(key))) {
          entities.push(phrase);
          break;
        }
      }
      if (entities.includes(phrase)) break;
    }
  }
  return entities;
}

function formatResponseContract(responseContract, maxChars = 500) {
  if (!responseContract) return '';
  const lines = [
    `INTENT: ${responseContract.subIntent || responseContract.intent || responseContract.policyMode || responseContract.mode || ''}`,
    responseContract.subject ? `SUBJECT: ${responseContract.subject}` : '',
    responseContract.subjectEntity ? `SUBJECT_ENTITY: ${responseContract.subjectEntity}` : '',
    responseContract.activeEntity ? `ACTIVE_ENTITY: ${responseContract.activeEntity}` : '',
    responseContract.directAnswer ? `DIRECT: ${responseContract.directAnswer}` : '',
    responseContract.requiredStance ? `STANCE: ${responseContract.requiredStance}` : '',
    responseContract.evidenceStatus ? `EVIDENCE_STATUS: ${responseContract.evidenceStatus}` : '',
    responseContract.requiredEntities?.length ? `REQUIRED ENTITIES: ${responseContract.requiredEntities.join(', ')}` : '',
    responseContract.evidenceStrength ? `EVIDENCE LEVEL: ${responseContract.evidenceStrength}` : '',
    responseContract.boundary ? `BOUNDARY: ${truncate(responseContract.boundary, 200)}` : '',
    responseContract.forbiddenClaims?.length ? `FORBIDDEN: ${responseContract.forbiddenClaims.slice(0, 5).join(', ')}` : ''
  ];
  // Evidence requirements — tell the model WHAT evidence to draw from
  if (responseContract.evidenceRequirements?.length) {
    lines.push(`EVIDENCE NEEDS: ${responseContract.evidenceRequirements.slice(0, 5).join(', ')}`);
  }
  const support = (responseContract.requiredFacts || [])
    .filter(fact => fact.type === 'supporting_evidence' || fact.type === 'rationale')
    .slice(0, 2)
    .map(fact => truncate(String(fact.value || ''), 120));
  if (support.length) lines.push(`REQUIRED FACTS: ${support.join(' | ')}`);
  if (responseContract.responseShape?.requirements?.length) {
    lines.push(`RESPONSE: ${responseContract.responseShape.requirements.slice(0, 3).join('; ')}`);
  }
  if (responseContract.responseShape?.minSentences) {
    lines.push(`LENGTH: ${responseContract.responseShape.minSentences}-${responseContract.responseShape.maxSentences} sentences`);
  }
  return truncate(lines.filter(Boolean).join('\n'), maxChars);
}

function buildLitePacket({ question, compressedEvidence, operation, maxTokens, structuredFacts, plan, planText, adversarialCaveat, responseContract }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4; // chars per token estimate
  const systemBudget = Math.floor(budget * 0.75);
  const userBudget = Math.floor(budget * 0.25);

  // Build compact plan constraints if available
  // Only inject plan constraints for high-risk intents where the model
  // benefits from explicit guidance (adversarial, skill, job-fit, comparison).
  // For conversational intents (follow-up, personality, natural, profile),
  // the model does better with more freedom and more evidence budget.
  let planConstraints = '';
  const planIntents = new Set(['ADVERSARIAL', 'JOB_FIT', 'SKILL', 'COMPARISON', 'YES_NO', 'RECRUITER', 'PROFILE', 'PROJECT']);
  // Negation confirmation constraint applies regardless of plan intent
  const isNegationConfirmation = responseContract?.answerStance === 'AFFIRM_NEGATION';
  if (adversarialCaveat || (plan && planIntents.has(plan.intent)) || isNegationConfirmation) {
    const constraints = [];
    if (adversarialCaveat) {
      constraints.push(`DIRECT_ANSWER: no`);
      constraints.push(`REFUTE: Refute the claim directly with No in a full sentence. ${adversarialCaveat}`);
    } else if (plan && plan.directAnswer) {
      constraints.push(`DIRECT_ANSWER: ${plan.directAnswer}`);
    }
    // Negation confirmation: explicitly instruct to start with "Yes"
    if (isNegationConfirmation) {
      constraints.push(`NEGATION_CONFIRM: Start your answer with "Yes" to confirm the negation. Do NOT start with "No".`);
    }
    if (plan && plan.entities && plan.entities.length > 0) {
      constraints.push(`ALLOWED_ENTITIES: ${plan.entities.slice(0, 10).join(', ')}`);
    }
    if (plan && plan.jobFit) {
      constraints.push(`FIT_LEVEL: ${plan.jobFit.fitLevel}`);
      if (plan.jobFit.strong.length > 0) {
        constraints.push(`STRONG: ${plan.jobFit.strong.map(s => s.skill).join(', ')}`);
      }
      if (plan.jobFit.gaps.length > 0) {
        constraints.push(`GAPS: ${plan.jobFit.gaps.map(s => s.skill).join(', ')}`);
      }
    }
    if (plan && plan.comparisonDimensions && plan.comparisonDimensions.length > 0) {
      const dims = plan.comparisonDimensions.slice(0, 2).map(d =>
        `${d.entity}(${d.tech ? d.tech.slice(0, 2).join('/') : ''})`
      );
      constraints.push(`COMPARE: ${dims.join(' vs ')}`);
    }
    if (plan && plan.recruiterBrief) {
      const rb = plan.recruiterBrief;
      if (rb.topStrengths.length > 0) {
        constraints.push(`STRENGTHS: ${rb.topStrengths.slice(0, 4).join(', ')}`);
      }
      if (rb.gaps.length > 0) {
        constraints.push(`GAPS: ${rb.gaps.slice(0, 2).join('; ')}`);
      }
    }
    planConstraints = constraints.join('\n');
  }

  // Build response contract instructions if available
  const contractInstructions = formatResponseContract(responseContract, 500);

  // Conversational system prompt that allows natural synthesis
  // while maintaining factual grounding and relationship correctness.
  // Keep prompt compact for CPU-only inference — every 100 tokens adds ~3s latency.
  const system = [
    `You are Scout, an AI assistant for ${scoutIdentity.getSubjectName()}.`,
    `You are NOT ${scoutIdentity.getSubjectName()}. Talk ABOUT him in third person (he/his).`,
    'Answer directly in 1-2 complete sentences. Use specific facts from FACTS.',
    'Do NOT use inflation language (expert, extensive, proficient). He is entry-level.',
    'Do NOT invent technologies or companies. Only use entities in FACTS.',
    'If a claim is not in FACTS, say No and correct it. Intern ≠ production.',
    'No "as an AI" or "would you like" — just answer.',
    'NEVER use I/my/me when talking about the subject.',
    '',
    contractInstructions ? 'RESPONSE INSTRUCTIONS:' : '',
    contractInstructions ? truncate(contractInstructions, 200) : '',
    planConstraints ? 'ANSWER GUIDE:' : '',
    planConstraints ? truncate(planConstraints, 150) : '',
    structuredFacts ? 'RELATIONSHIPS (verified only):' : '',
    structuredFacts ? truncate(structuredFacts, 200) : '',
    `FACTS:`,
    truncate(compressedEvidence, systemBudget - 400 - (planConstraints ? 150 : 0) - (structuredFacts ? 250 : 0) - (contractInstructions ? 200 : 0))
  ].filter(line => line !== undefined && line !== '').join('\n');

  const user = `Q: ${truncate(question, userBudget - 40)}\nReturn JSON: {"answer":"<your answer>"}`;

  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimatedInputTokens(system) + estimatedInputTokens(user)
  };
}

function buildCompletenessRepairPacket({ question, currentAnswer, compressedEvidence, reason, intent, maxTokens, planText, responseContract, missingEntities }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4;

  const intentGuidance = {
    YES_NO: 'Start with Yes/No in 1-2 complete sentences. Example: "Yes. React is part of his verified skill set and appears in his web development work."',
    SKILL: 'Start with Yes/No, then state the project or experience where this skill was used in 1-2 complete sentences.',
    ADVERSARIAL: 'Start with No in a complete sentence, then state what IS true from FACTS. Example: "No. He has not worked at Google. His experience includes an AWS Cloud Support Engineer Internship."',
    PROFILE: 'Give a 1-2 sentence summary with 2-3 specific details from FACTS. Example: "He is an entry-level developer with skills in JavaScript, React, and Node.js. His projects include ProjectHub and an AWS serverless capstone."',
    PROJECT: 'Describe what it is, what it does, and 1-2 key technologies from FACTS in 1-2 complete sentences.',
    COMPARISON: 'You MUST mention BOTH projects by name and state at least one meaningful difference using facts from FACTS in 1-2 complete sentences. Example: "ProjectHub is an AI recruiter assistant using JavaScript, while CIRIS is a freelance project using Docker Compose and JWT."',
    JOB_FIT: 'State the match in 1-2 complete sentences using specific facts from FACTS. Avoid words like "extensive" or "expertise".',
    RECRUITER: 'Give a 1-2 sentence summary with 2-3 specific facts from FACTS. Example: "He is an entry-level developer with an AWS internship, React skills, and a recruiter AI project."',
    OPINION: 'State your opinion in 1-2 complete sentences supported by specific facts from FACTS.',
    FOLLOW_UP: 'Answer the follow-up question directly in 1-2 complete sentences using facts from FACTS.',
    GENERAL: 'Write 1-2 complete, specific sentences using facts from FACTS. Do NOT use single-word answers.'
  };

  const guidance = intentGuidance[intent] || intentGuidance.GENERAL;

  // Build contract instructions if available
  const contractInstructions = formatResponseContract(responseContract, 400);

  // Build a content contract — explicit list of content slots the answer MUST fill
  let contentContract = '';
  if (responseContract) {
    const slots = [];
    // Required entities
    if (responseContract.requiredEntities && responseContract.requiredEntities.length > 0) {
      slots.push(`Name these entities: ${responseContract.requiredEntities.join(', ')}`);
    }
    // Key facts to include
    if (responseContract.keyFacts && responseContract.keyFacts.length > 0) {
      const facts = responseContract.keyFacts.slice(0, 2).join(' ');
      slots.push(`Include this evidence: ${truncate(facts, 200)}`);
    }
    // Response shape requirements
    if (responseContract.responseShape && responseContract.responseShape.requirements) {
      for (const req of responseContract.responseShape.requirements.slice(0, 3)) {
        slots.push(req);
      }
    }
    // Boundary
    if (responseContract.boundary) {
      slots.push(`Mention this limitation: ${responseContract.boundary}`);
    }
    if (slots.length > 0) {
      contentContract = '=== CONTENT CONTRACT (your answer MUST satisfy ALL of these) ===\n' + slots.map(s => `- ${s}`).join('\n');
    }
  }

  // Build missing entities instruction
  let missingEntitiesInstruction = '';
  if (missingEntities && missingEntities.length > 0) {
    missingEntitiesInstruction = `Your answer MUST name these entities: ${missingEntities.join(', ')}`;
  }

  // Build polarity instruction
  let polarityInstruction = '';
  if (responseContract && responseContract.directAnswer) {
    const da = responseContract.directAnswer;
    if (responseContract.isNegationConfirmation) {
      polarityInstruction = 'POLARITY: This is a negation-confirmation question. The answer may say either "Yes, that is correct" (confirming the absence) OR "No, there is no evidence..." (denying the claim). Both are correct. Do NOT affirm the false claim.';
    } else if (da === 'NO' || da === 'NOT_FIT') {
      polarityInstruction = 'CORRECT POLARITY: The answer must say No. Do not reverse this.';
    } else if (da === 'YES' || da === 'FIT') {
      polarityInstruction = 'CORRECT POLARITY: The answer must say Yes. Do not reverse this.';
    } else if (da === 'MIXED') {
      polarityInstruction = 'CORRECT POLARITY: The answer must be balanced (MIXED).';
    } else if (da === 'PARTIAL_FIT') {
      polarityInstruction = 'CORRECT POLARITY: The answer must state partial fit — mention both matches and gaps.';
    } else if (da === 'UNKNOWN') {
      polarityInstruction = 'POLARITY: State clearly that no verified rationale is documented. Do not infer a motivation.';
    }
  }

  // Build boundary instruction
  let boundaryInstruction = '';
  if (responseContract && responseContract.boundary) {
    boundaryInstruction = `BOUNDARY: ${responseContract.boundary}`;
  }

  // Determine minimum word count from response shape
  const minSentences = responseContract?.responseShape?.minSentences || 1;
  const minWords = Math.max(15, minSentences * 10);

  // If we have a response plan, use it to guide the repair
  if (planText) {
    const system = [
      'Expand this answer to be more complete and specific.',
      guidance,
      '',
      `ANSWER TO EXPAND: ${truncate(currentAnswer, 200)}`,
      '',
      'IMPORTANT: Preserve the original meaning. Do not reverse or contradict it.',
      'If the original says "no" or "not", the expanded answer must also say "no" or "not".',
      'Do NOT mention "brief", "too short", "current answer", or "expand" in your output.',
      '',
      polarityInstruction ? polarityInstruction : '',
      missingEntitiesInstruction ? missingEntitiesInstruction : '',
      boundaryInstruction ? boundaryInstruction : '',
      contentContract ? '' : '',
      contentContract ? contentContract : '',
      '',
      '=== RESPONSE PLAN (use this to expand) ===',
      truncate(planText, budget - 900),
      '',
      contractInstructions ? '=== RESPONSE INSTRUCTIONS ===' : '',
      contractInstructions ? contractInstructions : '',
      '',
      'Rules: Keep all relationships exact. Do not invent facts. Do not use overclaim language.',
      `Write at least ${minWords} words in at least ${minSentences} complete sentence${minSentences > 1 ? 's' : ''}. Be specific, not generic. Use ONLY entities from the plan.`,
      'Do NOT write a single-word or label-only answer. Every sentence must have a subject, verb, and specific detail.',
      'Return JSON: {"answer":"<expanded answer>"}'
    ].filter(line => line !== undefined && line !== '').join('\n');

    const user = `Q: ${truncate(question, 200)}`;
    return {
      systemPrompt: system,
      userPrompt: user,
      estimatedTokens: estimatedInputTokens(system) + estimatedInputTokens(user)
    };
  }

  const system = [
    'Expand this answer to be more complete and specific.',
    guidance,
    '',
    `ANSWER TO EXPAND: ${truncate(currentAnswer, 200)}`,
    '',
    'IMPORTANT: Preserve the original meaning. Do not reverse or contradict it.',
    'If the original says "no" or "not", the expanded answer must also say "no" or "not".',
    'Do NOT mention "brief", "too short", "current answer", or "expand" in your output.',
    '',
    polarityInstruction ? polarityInstruction : '',
    missingEntitiesInstruction ? missingEntitiesInstruction : '',
    boundaryInstruction ? boundaryInstruction : '',
    contentContract ? '' : '',
    contentContract ? contentContract : '',
    '',
    contractInstructions ? '=== RESPONSE INSTRUCTIONS ===' : '',
    contractInstructions ? contractInstructions : '',
    '',
    'FACTS:',
    truncate(compressedEvidence, budget - 700),
    '',
    'Rules: Keep all relationships exact. Do not invent facts. Do not use overclaim language.',
    `Write at least ${minWords} words in at least ${minSentences} complete sentence${minSentences > 1 ? 's' : ''}. Be specific, not generic.`,
    'Do NOT write a single-word or label-only answer. Every sentence must have a subject, verb, and specific detail.',
    'Return JSON: {"answer":"<expanded answer>"}'
  ].filter(line => line !== undefined && line !== '').join('\n');

  const user = `Q: ${truncate(question, 200)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimatedInputTokens(system) + estimatedInputTokens(user)
  };
}

/**
 * Check if a repair preserved the semantic meaning of the original answer.
 * Compares polarity and negation before and after repair.
 * For negation-confirmation questions ("No evidence he X, right?"), both
 * "No, there is no evidence..." and "Yes, that is correct." are the same stance.
 * @returns {boolean} true if meaning was preserved, false if it was reversed
 */
function meaningPreserved(original, repaired, question) {
  const origLower = (original || '').toLowerCase().trim();
  const repLower = (repaired || '').toLowerCase().trim();

  // For negation-confirmation questions, "No" and "Yes" can both express
  // the same stance (confirming the absence). Check if this is such a question.
  const isNegPremise = question && /\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b)\b/i.test(question) &&
    /\b(?:right|correct|true)\b/i.test(question);

  // Check negation presence
  const origHasNegation = /\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not|doesn'?t|does not|hasn'?t|has not|haven'?t|have not)\b/i.test(origLower);
  const repHasNegation = /\b(?:no|not|never|incorrect|wrong|false|didn'?t|did not|wasn'?t|was not|isn'?t|is not|doesn'?t|does not|hasn'?t|has not|haven'?t|have not)\b/i.test(repLower);

  // For negation-confirmation questions, both negation and affirmation are valid
  // as long as they don't AFFIRM the false claim. Skip the strict negation check.
  if (isNegPremise) {
    // Only flag as reversal if the repair explicitly affirms something the original denied
    // e.g., original says "No, he hasn't" and repair says "Yes, he has"
    const origStartsNo = /^(?:no|not)\b/i.test(origLower);
    const repStartsYes = /^(?:yes|correct|right|true)\b/i.test(repLower);
    const repStartsNo = /^(?:no|not)\b/i.test(repLower);
    const origStartsYes = /^(?:yes|correct|right|true)\b/i.test(origLower);
    // "No, no evidence" → "Yes, correct" is fine (same stance)
    // "No, no evidence" → "Yes, he did work there" is a reversal
    // We can't perfectly detect the latter with a small model, but we can check
    // if the repair introduces a positive claim that contradicts the negation
    if (origStartsNo && repStartsYes) {
      // Check if the repair contains negation words elsewhere (e.g., "Yes, that is correct, there is no evidence")
      if (repHasNegation) return true; // Repair still contains negation — same stance
      // Repair says "Yes" but contains no negation — might be affirming the false claim
      // Be conservative: accept it (the grounding validator will catch factual errors)
      return true;
    }
    if (origStartsYes && repStartsNo) {
      // "Yes, correct" → "No, no evidence" — same stance
      if (origHasNegation || /(?:correct|right|true)/i.test(origLower)) return true;
    }
    return true; // For negation-premise questions, be permissive
  }

  // If original was negative and repair is positive, meaning was reversed
  if (origHasNegation && !repHasNegation) {
    // Exception: if the original starts with "No" and the repair also starts with "No"
    // but has additional negation elsewhere, that's OK
    if (/^(?:no|not)\b/i.test(origLower) && !/^(?:no|not)\b/i.test(repLower)) {
      return false;
    }
    // If original has "no" or "not" as a key part and repair removes it
    if (origHasNegation && !repHasNegation) return false;
  }

  // If original was positive and repair starts with "No", meaning was reversed
  if (!origHasNegation && /^(?:no|not|never|incorrect)\b/i.test(repLower)) {
    return false;
  }

  return true;
}

function buildLiteRepairPacket({ question, compressedEvidence, rejectionDetails, maxTokens, knowledge, validation, graph, responseContract }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4;
  const reasons = (rejectionDetails || []).slice(0, 3).map(r => r.detail || r.reason).join('; ');

  // Build contract instructions if available
  const contractInstructions = formatResponseContract(responseContract, 400);

  // Build relationship-aware repair context
  let repairContext = '';

  // If we have a relationship graph and validation details, extract specific
  // unsupported relationships and find supported alternatives
  if (graph && validation && validation.reasons) {
    const unsupported = [];
    const overclaim = [];
    for (const r of validation.reasons) {
      if (r.startsWith('unsupported_relationship:')) {
        const parts = r.slice('unsupported_relationship:'.length).split('|');
        if (parts.length >= 3) {
          unsupported.push({ subject: parts[0], relation: parts[1], object: parts[2] });
        }
      }
      if (r.startsWith('relationship_overclaim:') || r.startsWith('expanded_overclaim:')) {
        overclaim.push(r);
      }
    }

    if (unsupported.length > 0 || overclaim.length > 0) {
      const lines = ['RELATIONSHIP CORRECTION:'];

      for (const u of unsupported.slice(0, 3)) {
        lines.push(`INVALID: ${u.subject} ${u.relation} ${u.object}`);
        // Find supported relationships for the same subject
        if (graph && graph.relationships) {
          const subjNorm = u.subject.toLowerCase().replace(/[^a-z0-9]/g, '');
          const supported = graph.relationships.filter(r =>
            r.subject && r.subject.toLowerCase().replace(/[^a-z0-9]/g, '').includes(subjNorm) &&
            r.relation === u.relation
          ).slice(0, 4);
          if (supported.length > 0) {
            lines.push(`SUPPORTED: ${supported.map(s => `${s.subject} ${s.relation} ${s.object}`).join('; ')}`);
          }
        }
      }

      for (const o of overclaim.slice(0, 2)) {
        lines.push(`OVERCLAIM: ${o} — REMOVE words like "extensive" or "expertise". Replace with "has experience with" or "built".`);
      }

      if (reasons.includes('fabricated_entity')) {
        lines.push('FABRICATED ENTITIES: Remove named entities not in FACTS (e.g., Prometheus, Grafana, DSA, Udemy). Use ONLY facts from FACTS.');
      }

      repairContext = lines.join('\n') + '\n\n';
    }
  }

  const system = [
    'Fix the answer. Use ONLY FACTS. Write 1-2 complete, natural sentences.',
    'Do NOT use words like "extensive" or "expertise". Use "has experience with" or "built".',
    'Issues: ' + reasons,
    '',
    repairContext,
    contractInstructions ? '=== RESPONSE INSTRUCTIONS ===' : '',
    contractInstructions ? contractInstructions : '',
    contractInstructions ? '' : '',
    'FACTS:',
    truncate(compressedEvidence, budget - 400 - repairContext.length - (contractInstructions ? 220 : 0)),
    '',
    'Return JSON: {"answer":"<text>"}'
  ].filter(line => line !== undefined).join('\n');
  const user = `Q: ${truncate(question, 200)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: estimatedInputTokens(system) + estimatedInputTokens(user)
  };
}

// --- Lite Agent Loop ---

async function runLiteAgent({ question, conversationState, evidence, knowledge, sessionId, model, policyContract, deadlineAt, abortSignal }) {
  const startedAt = Date.now();
  const selectedModel = model || router.agentModel();
  const events = [];
  let contextTokens = 0;

  // Request-scoped deadline — all generation attempts must respect this.
  // deadlineAt is a monotonic timestamp (Date.now() + budgetMs).
  // If not provided, default to LITE_TIMEOUT_MS from now.
  const requestDeadline = deadlineAt || (Date.now() + LITE_TIMEOUT_MS);
  const requestAbort = abortSignal || null;

  // Helper: compute remaining budget for a generation attempt.
  // Returns 0 if deadline has passed.
  function remainingMs() {
    return Math.max(0, requestDeadline - Date.now());
  }

  // Helper: compute attempt timeout, capped by remaining budget.
  // minimumUsefulBudget is the minimum time worth starting a generation for.
  function attemptTimeout(configuredMax, minimumUsefulBudget = 2000) {
    const remaining = remainingMs();
    if (remaining < minimumUsefulBudget) return 0; // signal: don't attempt
    return Math.min(configuredMax, remaining);
  }

  // Helper: check if we should bail due to deadline
  function deadlineExceeded() {
    return Date.now() >= requestDeadline;
  }

  function emit(type, data) {
    events.push({ ts: Date.now() - startedAt, type, ...data });
  }

  // Track every generative call for neuron accounting and provenance
  const generationCalls = [];
  let callSequenceCounter = 0;
  let providerCallCount = 0;
  // Wrap router.generate to count every actual provider call
  const origGenerate = router.generate.bind(router);
  router.generate = async function(...args) {
    providerCallCount++;
    return origGenerate(...args);
  };
  function recordGenerationCall(attemptType, genResult, opts = {}) {
    callSequenceCounter++;
    const call = {
      attemptIndex: callSequenceCounter,
      attemptType,
      provider: genResult.usage?.provider || router.inferenceProvider || 'ollama',
      providerRequestId: genResult.providerRequestId || null,
      providerTraceId: genResult.providerTraceId || null,
      providerTraceType: genResult.providerTraceType || null,
      model: genResult.model || selectedModel,
      actualNeurons: genResult.usage?.actualNeurons ?? null,
      estimatedNeurons: genResult.usage?.estimatedNeurons ?? null,
      inputTokens: genResult.usage?.promptEvalCount ?? null,
      outputTokens: genResult.usage?.evalCount ?? null,
      latencyMs: genResult.latencyMs ?? null,
      startedAtRelativeMs: genResult.startedAt ? genResult.startedAt - startedAt : null,
      endedAtRelativeMs: genResult.endedAt ? genResult.endedAt - startedAt : null,
      ok: genResult.ok,
      accepted: opts.accepted ?? false,
      validationVerdict: opts.validationVerdict ?? null,
      validationReasons: opts.validationReasons ?? null,
      rawAnswer: opts.rawAnswer ?? null,
      error: genResult.error || null,
    };
    generationCalls.push(call);
    return call;
  }

  emit('lite_start', { model: selectedModel });

  // 1. Rewrite query (resolve references using conversation state + knowledge)
  const stateHistory = conversationState?.recentTurns || conversationState?.history || [];
  const rewrite = rewriteQuery(question, conversationState, knowledge, stateHistory);
  const { rewritten, rewritten_ } = rewrite;
  emit('lite_rewrite', { rewritten, changed: rewritten_, clarificationRequired: !!rewrite.clarificationRequired });
  if (rewrite.clarificationRequired) {
    emit('lite_clarification', { referentType: rewrite.referentType });
    return {
      reply: null,
      provider: 'scout-harness',
      model: selectedModel,
      fallback: true,
      clarification: true,
      outcome: 'clarification_required',
      events,
      latencyMs: Date.now() - startedAt,
      contextTokens: 0,
      validation: null,
      operation: 'clarification',
      rewritten,
      rewrittenQuery: null,
      generationCalls,
      actualProviderCalls: providerCallCount,
      steps: [{ type: 'lite_clarification' }],
      toolResults: []
    };
  }

  // 2. Pre-route (deterministic tool selection)
  const route = preRoute(rewritten, conversationState, knowledge);
  emit('lite_route', { operation: route.operation, tool: route.tool });

  // 3. Execute tool
  let toolResult;
  try {
    toolResult = executeAgentTool(route.tool, route.args, knowledge);
    emit('lite_tool_result', { tool: route.tool, resultSize: JSON.stringify(toolResult).length });
  } catch (err) {
    emit('lite_tool_error', { tool: route.tool, error: err.message });
    toolResult = { error: 'Tool execution failed.' };
  }

  // 4. Compress evidence
  let compressed = compressToolResult(route.tool, toolResult, LITE_MAX_TOKENS * 2);

  // If the tool result is thin (e.g. search didn't find much), supplement
  // with the BM25 evidence that was already retrieved by the server
  if (evidence?.length && compressed.length < 200) {
    const evidenceText = evidence
      .slice(0, 3)
      .map(e => truncate(e.description, 120))
      .filter(t => t)
      .join('\n');
    if (evidenceText) {
      compressed = compressed + '\n' + evidenceText;
    }
  }

  // Adversarial detection: if the question claims something that might be
  // exaggerated, inject a caveat so the model doesn't agree with false claims
  // BUT: skip the caveat when the policy contract says this is a negation
  // confirmation (AFFIRM_NEGATION) — the answer should be YES, not a refutation.
  const isNegationConfirm = policyContract?.isNegationConfirmation || policyContract?.answerStance === 'AFFIRM_NEGATION';
  const adversarialCaveat = isNegationConfirm ? null : detectAdversarialCaveat(rewritten, compressed);
  if (adversarialCaveat) {
    compressed = compressed + '\n' + adversarialCaveat;
  }

  emit('lite_compress', { compressedChars: compressed.length, adversarial: !!adversarialCaveat });

  // Pre-compute validation context for recovery attempts (used by all call sites)
  const sourceText = compressed + ' ' + JSON.stringify(toolResult).slice(0, 2000);
  const reqGraph = knowledge ? buildRelationshipGraph(knowledge) : null;

  // 5. Build lite packet with entity-scoped structured facts + response plan
  let structuredFacts = '';
  let plan = null;
  let planText = '';
  const planEnabled = process.env.SCOUT_DISABLE_RESPONSE_PLAN !== 'true';
  if (knowledge) {
    const graph = buildRelationshipGraph(knowledge);
    const questionEntities = extractQuestionEntities(rewritten, graph);
    if (questionEntities.length > 0) {
      structuredFacts = buildStructuredFacts(graph, questionEntities, 10);
    }
    // Build semantic response plan — tells the model WHAT to say
    if (planEnabled) {
      try {
        plan = planResponse(rewritten, knowledge, evidence, {
          subjectName: scoutIdentity.getSubjectName(),
          activeEntity: conversationState?.activeEntity || null
        });
        planText = formatPlanForPrompt(plan);
      } catch (e) {
        // Plan is best-effort — don't fail generation if planner has an issue
        emit('lite_plan_error', { error: String(e).slice(0, 100) });
      }
    }
  }

  // Build response contract for semantic guidance
  let responseContract = null;
  try {
    responseContract = buildResponseContract(rewritten, compressed, knowledge, stateHistory);
  } catch (e) {
    // Contract is best-effort
  }

  // Merge policy contract from classifyResponsePolicy if provided.
  // This is the primary contract source — it determines mode, polarity,
  // evidence requirements, boundaries, and forbidden claims.
  // The responseContract above is supplementary.
  if (policyContract) {
    responseContract = {
      ...(responseContract || {}),
      ...policyContract,
      policyMode: policyContract.mode || null,
    };
    // Policy contract no longer carries allowedFacts or keyFacts.
    // Evidence comes from BM25 retrieval, tool results, and knowledge graph.
    // Override plan.directAnswer with policy contract's directAnswer when available
    // (e.g., negation confirmation needs YES, not the plan's default NO).
    if (policyContract.directAnswer && plan) {
      plan.directAnswer = policyContract.directAnswer;
    }
  }

  const packet = buildLitePacket({
    question: rewritten,
    compressedEvidence: compressed,
    operation: route.operation,
    maxTokens: LITE_MAX_TOKENS,
    structuredFacts,
    plan,
    planText,
    adversarialCaveat,
    responseContract
  });
  contextTokens = packet.estimatedTokens;
  const tokenBudget = computeContextBudget(packet.systemPrompt, packet.userPrompt, LITE_NUM_CTX);
  emit('lite_packet', { estimatedInputTokens: packet.estimatedTokens, chars: packet.systemPrompt.length + packet.userPrompt.length, hasPlan: !!planText, tokenBudget, configuredCtx: LITE_NUM_CTX, configuredPredict: LITE_NUM_PREDICT });

  // 6. Single Ollama generation — use remaining request budget, not fixed timeout
  const primaryTimeout = attemptTimeout(LITE_TIMEOUT_MS, 3000);
  if (primaryTimeout === 0) {
    emit('lite_deadline_exceeded', { remaining: remainingMs(), stage: 'primary' });
    return {
      reply: null,
      provider: 'scout-lite',
      model: selectedModel,
      fallback: true,
      inferenceUnavailable: true,
      outcome: 'deadline_exceeded',
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      generationAttempts: 0,
      generationCalls,
      actualProviderCalls: providerCallCount
    };
  }

  emit('lite_generate_call', { timeoutMs: primaryTimeout, remaining: remainingMs(), systemPromptChars: packet.systemPrompt.length, userPromptChars: packet.userPrompt.length, estimatedTokens: packet.estimatedTokens });
  const genResult = await router.generate(selectedModel, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: primaryTimeout,
    temperature: 0.25,
    topP: 0.9,
    numPredict: LITE_NUM_PREDICT,
    numCtx: LITE_NUM_CTX,
    format: 'json',
    abortSignal: requestAbort
  });

  if (!genResult.ok) {
    recordGenerationCall('PRIMARY', genResult, { accepted: false });
    emit('lite_generate_error', { error: genResult.error, latencyMs: genResult.latencyMs });
    return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
  }

  // Record Ollama runtime metrics for estimator validation
  if (genResult.usage) {
    emit('lite_generate_metrics', {
      estimatedInputTokens: contextTokens,
      actualPromptEvalCount: genResult.usage.promptEvalCount,
      actualEvalCount: genResult.usage.evalCount,
      actualNeurons: genResult.usage.actualNeurons,
      doneReason: genResult.usage.doneReason,
      totalDurationNs: genResult.usage.totalDurationNs,
      promptEvalDurationNs: genResult.usage.promptEvalDurationNs,
      evalDurationNs: genResult.usage.evalDurationNs,
      latencyMs: genResult.latencyMs
    });
  }

  // Parse the answer
  let answer = '';
  try {
    const parsed = JSON.parse(genResult.text);
    answer = String(parsed.answer || '').trim();
  } catch {
    // Try to extract answer from raw text
    const m = genResult.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) answer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }

  if (answer.length < 3) {
    recordGenerationCall('PRIMARY', genResult, { accepted: false, validationVerdict: 'too_short', validationReasons: ['too_short'], rawAnswer: answer.slice(0, 500) });
    emit('lite_generate_short', { latencyMs: genResult.latencyMs });
    return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
  }

  // Extract complete sentences
  const sentences = extractCompleteSentences(answer, 2);
  if (sentences && sentences.length >= 20) answer = sentences;

  emit('lite_generate_ok', { latencyMs: genResult.latencyMs, answerLen: answer.length, rawAnswer: answer.slice(0, 400), rawGenText: (genResult.text || '').slice(0, 400) });

  // 6b. Adversarial safety check: if the question triggers an adversarial caveat
  // and the answer contains forbidden claim words without negation, skip repair
  // and go straight to fallback. The 0.5b model sometimes agrees with false claims
  // despite caveats, and repair makes it worse.
  if (adversarialCaveat && containsForbiddenClaim(answer)) {
    recordGenerationCall('PRIMARY', genResult, { accepted: false, validationVerdict: 'unsupported', validationReasons: ['forbidden_claim'], rawAnswer: answer.slice(0, 500) });
    emit('lite_forbidden_claim', { answer: answer.slice(0, 80) });
    return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
  }

  // 6c. Adversarial confirmation check: if the question is adversarial and the
  // answer confirms the claim (starts with Yes/Correct/Right without negation),
  // block it. The 1.5B model sometimes confirms false claims.
  // BUT: if the question itself is a negation ("no evidence", "not", "didn't"),
  // then "Yes" confirms the negation, not the false claim — so don't block.
  if (adversarialCaveat) {
    const questionIsNegation = /\b(?:no\s+evidence|not\b|never\b|didn'?t\b|did not\b|no\s+mention|isn'?t\b|is not\b|wasn'?t\b|was not\b|doesn'?t\b|does not\b|haven'?t\b|have not\b|hasn'?t\b|has not\b|won'?t\b|will not\b|wouldn'?t\b|would not\b|couldn'?t\b|could not\b|shouldn'?t\b|should not\b|must not\b|mustn'?t\b|no\s+(?:proof|sign|record|indication))\b/i.test(rewritten);
    const confirmsClaim = /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(answer) &&
      !/\b(?:no|not|never|incorrect|wrong|false|didn't|did not|wasn't|was not|isn't|is not)\b/i.test(answer);
    if (confirmsClaim && !questionIsNegation) {
      recordGenerationCall('PRIMARY', genResult, { accepted: false, validationVerdict: 'unsupported', validationReasons: ['adversarial_confirmation'], rawAnswer: answer.slice(0, 500) });
      emit('lite_adversarial_confirmation', { answer: answer.slice(0, 80) });
      return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
    }
  }

  // 7. Validation (same validator as FULL mode, now with relationship-aware grounding)
  // 7a. OOS semantic policy enforcement — if the policy mode is OUT_OF_SCOPE,
  //     the answer must NOT answer the external question. It must redirect.
  const policyMode = responseContract?.policyMode || responseContract?.mode;
  if (policyMode === 'OUT_OF_SCOPE' && answerAddressesExternalTopic(answer, rewritten)) {
    recordGenerationCall('PRIMARY', genResult, { accepted: false, validationVerdict: 'unsupported', validationReasons: ['oos_policy_violation'], rawAnswer: answer.slice(0, 500) });
    emit('lite_oos_policy_violation', { answer: answer.slice(0, 120) });
    return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
  }

  const validation = validateAnswer(answer, sourceText, rewritten, knowledge, stateHistory, reqGraph, responseContract?.policyMode || null);
  recordGenerationCall('PRIMARY', genResult, { accepted: validation.valid, validationVerdict: validation.verdict, validationReasons: validation.reasons, rawAnswer: answer.slice(0, 500) });
  emit('lite_validation', { verdict: validation.verdict, reasons: validation.reasons, validatedAnswer: answer.slice(0, 400) });

  if (validation.valid) {
    // 7b. Completeness check — is the answer conversationally sufficient?
    const completeness = evaluateCompleteness(answer, rewritten, evidence, responseContract);

    if (!completeness.complete && LITE_ENABLE_REPAIR) {
      // Deterministic completeness repair for terse adversarial answers
      // "No." or "Yes." to adversarial questions → expand with grounded context
      if (completeness.reason === 'TOO_SHORT' || completeness.reason === 'ADVERSARIAL_TOO_TERSE') {
        const terseText = answer.trim().toLowerCase();
        const isTerseAffirmation = terseText === 'yes.' || terseText === 'yes' || terseText === 'correct.' || terseText === 'correct';
        const isTerseDenial = terseText === 'no.' || terseText === 'no' || terseText === 'nope.' || terseText === 'nope';

        if (isTerseDenial || isTerseAffirmation) {
          // Build a generative expansion from the recovery contract
          const advContract = buildTerseAdversarialContract(answer, rewritten, knowledge);
          if (advContract) {
            const advPrompt = buildRecoveryPrompt(advContract, rewritten, knowledge);
            try {
              const advGen = await router.generate(selectedModel, [
                { role: 'system', content: advPrompt.systemPrompt },
                { role: 'user', content: advPrompt.userPrompt }
              ], {
                maxTokens: RECOVERY_MAX_TOKENS,
                timeoutMs: 8000,
                temperature: 0.1,
                format: 'json'
              });
              generationCalls.push({
                attemptIndex: generationCalls.length + 1,
                attemptType: 'ADV_EXPAND',
                provider: advGen.usage?.provider || router.inferenceProvider || 'ollama',
                providerRequestId: advGen.providerRequestId || null,
                providerTraceId: advGen.providerTraceId || null,
                providerTraceType: advGen.providerTraceType || null,
                model: advGen.model || selectedModel,
                actualNeurons: advGen.usage?.actualNeurons ?? null,
                estimatedNeurons: advGen.usage?.estimatedNeurons ?? null,
                inputTokens: advGen.usage?.promptEvalCount ?? null,
                outputTokens: advGen.usage?.evalCount ?? null,
                latencyMs: advGen.latencyMs ?? null,
                startedAtRelativeMs: advGen.startedAt ? advGen.startedAt - startedAt : null,
                endedAtRelativeMs: advGen.endedAt ? advGen.endedAt - startedAt : null,
                ok: advGen.ok ?? true,
                accepted: false,
                validationVerdict: null,
                validationReasons: null,
                rawAnswer: null,
                error: advGen.error || null,
              });
              if (advGen.ok && advGen.text) {
                let advAnswer = '';
                try {
                  const parsed = JSON.parse(advGen.text);
                  advAnswer = String(parsed.answer || '').trim();
                } catch {
                  const m = advGen.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                  if (m) advAnswer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
                }
                if (advAnswer.length >= 20) {
                  // Polarity guard: if the original answer and the expansion candidate
                  // have opposite polarity (affirmative vs negative), the expansion
                  // has flipped the semantic stance. Keep the original generated answer.
                  const originalPolarity = /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(answer) ? 'affirmative'
                    : /^(?:no|incorrect|wrong|false|never)\b/i.test(answer) ? 'negative' : 'neutral';
                  const expansionPolarity = /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(advAnswer) ? 'affirmative'
                    : /^(?:no|incorrect|wrong|false|never)\b/i.test(advAnswer) ? 'negative' : 'neutral';
                  if (originalPolarity !== 'neutral' && expansionPolarity !== 'neutral' && originalPolarity !== expansionPolarity) {
                    emit('lite_adv_expand_polarity_reject', { original: answer.slice(0, 80), expansion: advAnswer.slice(0, 80), originalPolarity, expansionPolarity });
                  } else
                  // Safety: reject expansions that confirm a false claim when contract says NO
                  if (advContract.directAnswer === 'NO' && /^(?:yes|correct|right|true)\b/i.test(advAnswer)) {
                    emit('lite_adv_expand_safety_reject', { answer: advAnswer.slice(0, 80) });
                  } else {
                    const expValidation = validateAnswer(advAnswer, sourceText, rewritten, knowledge, stateHistory, reqGraph, responseContract?.policyMode || null);
                    if (expValidation.valid) {
                      const expCompleteness = evaluateCompleteness(advAnswer, rewritten, evidence, responseContract);
                      if (expCompleteness.complete || advAnswer.length > answer.length * 1.3) {
                        generationCalls[generationCalls.length - 1].accepted = true;
                        generationCalls[generationCalls.length - 1].rawAnswer = advAnswer.slice(0, 500);
                        generationCalls[generationCalls.length - 1].validationVerdict = expValidation.verdict;
                        generationCalls[generationCalls.length - 1].validationReasons = expValidation.reasons;
                        emit('lite_complete', { outcome: 'completeness_repaired', totalMs: Date.now() - startedAt, generative: true });
                        return {
                          reply: advAnswer,
                          provider: 'ollama-lite',
                          model: selectedModel,
                          steps: [{ type: 'lite_generate' }, { type: 'lite_completeness_repair_generative' }],
                          toolResults: [{ tool: route.tool, result: toolResult }],
                          events,
                          contextTokens,
                          latencyMs: Date.now() - startedAt,
                          fallback: false,
                          outcome: 'completeness_repaired',
                          validation: expValidation,
                          operation: route.operation,
                          rewritten: rewritten_,
                          rewrittenQuery: rewritten,
                          generationCalls,
                          actualProviderCalls: providerCallCount
                        };
                      }
                    }
                  }
                }
              }
            } catch (e) {
              generationCalls.push({ attemptType: 'ADV_EXPAND', attemptIndex: ++callSequenceCounter, model: selectedModel, provider: 'cloudflare', ok: false, accepted: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() });
              emit('lite_adv_expand_error', { error: e.message });
            }
          }
        }
      }

      // For COMPARISON_MISSING_ENTITY and MISSING_REQUIRED_ENTITIES, the repaired
      // answer MUST pass the completeness check (mention all required entities).
      const requireCompleteness = completeness.reason === 'COMPARISON_MISSING_ENTITY' ||
        completeness.reason === 'SKILL_NO_CANDIDATE_LINK' ||
        completeness.reason === 'MISSING_REQUIRED_ENTITIES' ||
        completeness.reason === 'MISSING_REQUIRED_FACTS' ||
        completeness.reason === 'POLARITY_MISMATCH' ||
        completeness.reason === 'EVIDENCE_STRENGTH_OVERCLAIM' ||
        completeness.reason === 'SKILL_MISSING_USAGE_EVIDENCE' ||
        completeness.reason === 'RATIONALE_NOT_ANSWERED' ||
        completeness.reason === 'COMPARISON_MISSING_DECISION' ||
        completeness.reason === 'OPINION_MISSING_DECISION' ||
        completeness.reason === 'RECRUITER_RECOMMENDATION_INCOMPLETE';

      // Attempt ONE completeness repair — expand the terse answer with evidence
      emit('lite_completeness_repair_call', { reason: completeness.reason, intent: completeness.intent });

      const completenessPacket = buildCompletenessRepairPacket({
        question: rewritten,
        currentAnswer: answer,
        compressedEvidence: compressed,
        reason: completeness.reason,
        intent: completeness.intent,
        maxTokens: LITE_MAX_TOKENS,
        planText,
        responseContract,
        missingEntities: completeness.missingEntities
      });

      const compTimeout = attemptTimeout(LITE_REPAIR_TIMEOUT_MS, 2000);
      if (compTimeout === 0) {
        emit('lite_deadline_exceeded', { remaining: remainingMs(), stage: 'completeness_repair' });
        return {
          reply: null,
          provider: 'scout-lite',
          model: selectedModel,
          fallback: true,
          inferenceUnavailable: true,
          outcome: 'deadline_exceeded',
          events,
          contextTokens,
          latencyMs: Date.now() - startedAt,
          generationAttempts: 1,
          generationCalls,
          actualProviderCalls: providerCallCount
        };
      }
      let compRepairResult;
      try {
        compRepairResult = await router.generate(selectedModel, [
          { role: 'system', content: completenessPacket.systemPrompt },
          { role: 'user', content: completenessPacket.userPrompt }
        ], {
          timeoutMs: compTimeout,
          temperature: 0.2,
          topP: 0.85,
          numPredict: LITE_NUM_PREDICT,
          numCtx: LITE_NUM_CTX,
          format: 'json',
          abortSignal: requestAbort
        });
      } catch (e) {
        compRepairResult = { ok: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() };
        recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: false, error: e.message });
        emit('lite_completeness_repair_error', { error: e.message });
      }

      if (!compRepairResult.ok) {
        recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: false });
        emit('lite_completeness_repair_error', { error: compRepairResult.error, latencyMs: compRepairResult.latencyMs });
      } else {
      if (compRepairResult.ok) {
        let compAnswer = '';
        try {
          const parsed = JSON.parse(compRepairResult.text);
          compAnswer = String(parsed.answer || '').trim();
        } catch {
          const m = compRepairResult.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) compAnswer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
        }

        if (compAnswer.length >= 10) {
          // Check for repair output issues
          const hasLeak = /\b(?:too (?:brief|short)|current answer|expand|more complete)\b/i.test(compAnswer);
          const hasMeaningReversal = !meaningPreserved(answer, compAnswer, rewritten);
          const hasForbidden = adversarialCaveat && containsForbiddenClaim(compAnswer);

          if (hasLeak) {
            recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: false, validationVerdict: 'leak', validationReasons: ['repair_leak'], rawAnswer: compAnswer.slice(0, 500) });
            emit('lite_completeness_repair_leak', { answer: compAnswer.slice(0, 80) });
            // Skip to deterministic repair or fallback
          } else if (hasMeaningReversal) {
            recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: false, validationVerdict: 'contradiction', validationReasons: ['meaning_reversal'], rawAnswer: compAnswer.slice(0, 500) });
            emit('lite_completeness_repair_contradiction', { original: answer.slice(0, 80), repaired: compAnswer.slice(0, 80) });
            // Skip to deterministic repair or fallback
          } else if (hasForbidden) {
            recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: false, validationVerdict: 'unsupported', validationReasons: ['forbidden_claim'], rawAnswer: compAnswer.slice(0, 500) });
            emit('lite_completeness_repair_forbidden', { answer: compAnswer.slice(0, 80) });
            return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
          } else {
            // Validate the expanded answer with the same strict validator
            const compSentences = extractCompleteSentences(compAnswer, 2);
            if (compSentences && compSentences.length >= 20) compAnswer = compSentences;

            const compValidation = validateAnswer(compAnswer, sourceText, rewritten, knowledge, stateHistory, reqGraph, responseContract?.policyMode || null);
            recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: compValidation.valid, validationVerdict: compValidation.verdict, validationReasons: compValidation.reasons, rawAnswer: compAnswer.slice(0, 500) });
            emit('lite_completeness_repair_result', {
              verdict: compValidation.verdict,
              latencyMs: compRepairResult.latencyMs,
              rawAnswer: compAnswer.slice(0, 300),
              reasons: compValidation.reasons
            });

            if (compValidation.valid) {
              // Check if the expanded answer is actually more complete
              const compCompleteness = evaluateCompleteness(compAnswer, rewritten, evidence, responseContract);
              // Only accept if the repaired answer passes completeness check
              // OR is significantly longer AND not generic vague
              const isGenericVague = compCompleteness.reason === 'GENERIC_VAGUE' || compCompleteness.reason === 'GENERIC_FILLER';
              if (compCompleteness.complete || (!requireCompleteness && !isGenericVague && compAnswer.length > answer.length * 1.3)) {
                emit('lite_complete', { outcome: 'completeness_repaired', totalMs: Date.now() - startedAt });
                return {
                  reply: compAnswer,
                  provider: 'ollama-lite',
                  model: selectedModel,
                  steps: [{ type: 'lite_generate' }, { type: 'lite_completeness_repair' }],
                  toolResults: [{ tool: route.tool, result: toolResult }],
                  events,
                  contextTokens: contextTokens + completenessPacket.estimatedTokens,
                  latencyMs: Date.now() - startedAt,
                  fallback: false,
                  outcome: 'completeness_repaired',
                  validation: compValidation,
                  operation: route.operation,
                  rewritten: rewritten_,
                  rewrittenQuery: rewritten,
                  generationCalls,
                  actualProviderCalls: providerCallCount
                };
              }
            }
          }
        } else {
          recordGenerationCall('COMPLETENESS_REPAIR', compRepairResult, { accepted: false, validationVerdict: 'too_short', validationReasons: ['too_short'], rawAnswer: compAnswer.slice(0, 500) });
        }
      }
      }
      // If completeness repair failed for a critical reason (missing entity in
      // comparison), try to deterministically append the missing entity info
      // from the tool result before falling back.
      if (requireCompleteness && completeness.reason === 'COMPARISON_MISSING_ENTITY' && toolResult.projects) {
        const compareMatch = rewritten.match(/\b(?:compare|versus|vs\.?)\b\s+(.+?)\s+(?:and|to|with|vs\.?)\s+(.+)/i);
        if (compareMatch) {
          const raw1 = compareMatch[1].trim().split(/[,.\s]/)[0];
          const raw2 = compareMatch[2].trim().split(/[,.\s]/)[0];
          const entity1 = raw1.toLowerCase();
          const entity2 = raw2.toLowerCase();
          const answerLower = answer.toLowerCase();
          const answerNoSpace = answerLower.replace(/[^a-z0-9]/g, '');
          // Use same normalization as completeness check (handle camelCase → space)
          const e1Variants = [...new Set([entity1, entity1.replace(/[^a-z0-9]/g, ''), raw1.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()])];
          const e2Variants = [...new Set([entity2, entity2.replace(/[^a-z0-9]/g, ''), raw2.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()])];
          const hasEntity1 = e1Variants.some(v => answerLower.includes(v) || answerNoSpace.includes(v));
          const hasEntity2 = e2Variants.some(v => answerLower.includes(v) || answerNoSpace.includes(v));
          // Find the missing entity in the tool result
          const missingEntity = !hasEntity1 ? entity1 : entity2;
          const missingVariants = !hasEntity1 ? e1Variants : e2Variants;
          const missingProj = toolResult.projects.find(p =>
            p.name && missingVariants.some(v => p.name.toLowerCase().includes(v))
          );
          if (missingProj) {
            // Deterministic completeness repair removed — model must generate all prose.
            // Fall through to generative recovery.
            emit('lite_completeness_deterministic_repair_skipped', { reason: completeness.reason });
          }
        }
        // Fall back to generative recovery
        emit('lite_completeness_fallback', { reason: completeness.reason });
        return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount, missingEntities: completeness.missingEntities || [] });
      }
      // For SKILL_NO_CANDIDATE_LINK, fall back
      if (requireCompleteness) {
        emit('lite_completeness_fallback', { reason: completeness.reason });
        return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount, missingEntities: completeness.missingEntities || [] });
      }
      // If completeness repair failed, return the original valid answer
      emit('lite_complete', { outcome: 'accepted', totalMs: Date.now() - startedAt, completenessReason: completeness.reason });
    } else {
      emit('lite_complete', { outcome: 'accepted', totalMs: Date.now() - startedAt });
    }

    // Expand terse yes/no answers with generative recovery contract
    const terseContract = buildTerseYesNoContract(answer, rewritten, compressed, knowledge);
    if (terseContract) {
      const tersePrompt = buildRecoveryPrompt(terseContract, rewritten, knowledge);
      const terseTimeout = attemptTimeout(8000, 2000);
      if (terseTimeout === 0) {
        emit('lite_deadline_exceeded', { remaining: remainingMs(), stage: 'terse_repair' });
      } else {
        try {
          const terseGen = await router.generate(selectedModel, [
            { role: 'system', content: tersePrompt.systemPrompt },
            { role: 'user', content: tersePrompt.userPrompt }
          ], {
            maxTokens: RECOVERY_MAX_TOKENS,
            timeoutMs: terseTimeout,
            temperature: 0.2,
            format: 'json',
            abortSignal: requestAbort
          });
          generationCalls.push({
            attemptIndex: generationCalls.length + 1,
            attemptType: 'TERSE_EXPAND',
            provider: terseGen.usage?.provider || router.inferenceProvider || 'ollama',
            providerRequestId: terseGen.providerRequestId || null,
            providerTraceId: terseGen.providerTraceId || null,
            providerTraceType: terseGen.providerTraceType || null,
            model: terseGen.model || selectedModel,
            actualNeurons: terseGen.usage?.actualNeurons ?? null,
            estimatedNeurons: terseGen.usage?.estimatedNeurons ?? null,
            inputTokens: terseGen.usage?.promptEvalCount ?? null,
            outputTokens: terseGen.usage?.evalCount ?? null,
            latencyMs: terseGen.latencyMs ?? null,
            startedAtRelativeMs: terseGen.startedAt ? terseGen.startedAt - startedAt : null,
            endedAtRelativeMs: terseGen.endedAt ? terseGen.endedAt - startedAt : null,
            ok: terseGen.ok ?? true,
            accepted: false,
            validationVerdict: null,
            validationReasons: null,
            rawAnswer: null,
            error: terseGen.error || null,
          });
          if (terseGen.ok && terseGen.text) {
            let terseAnswer = '';
            try {
              const parsed = JSON.parse(terseGen.text);
              terseAnswer = String(parsed.answer || '').trim();
            } catch {
              const m = terseGen.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
              if (m) terseAnswer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
            }
            if (terseAnswer.length >= 15) {
              if (terseContract.directAnswer === 'NO' && /^(?:yes|correct|right|true)\b/i.test(terseAnswer)) {
                emit('lite_terse_expand_safety_reject', { answer: terseAnswer.slice(0, 80) });
              } else {
                answer = terseAnswer;
                generationCalls[generationCalls.length - 1].accepted = true;
                generationCalls[generationCalls.length - 1].rawAnswer = terseAnswer.slice(0, 500);
                emit('lite_terse_expand_ok', { latencyMs: terseGen.latencyMs });
              }
            }
          }
        } catch (e) {
          generationCalls.push({ attemptType: 'TERSE_EXPAND', attemptIndex: ++callSequenceCounter, model: selectedModel, provider: 'cloudflare', ok: false, accepted: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() });
          emit('lite_terse_expand_error', { error: e.message });
        }
      }
    }

    return {
      reply: answer,
      provider: 'ollama-lite',
      model: selectedModel,
      steps: [{ type: 'lite_generate' }],
      toolResults: [{ tool: route.tool, result: toolResult }],
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      fallback: false,
      outcome: 'accepted',
      validation,
      operation: route.operation,
      rewritten: rewritten_,
      rewrittenQuery: rewritten,
      generationCalls,
      actualProviderCalls: providerCallCount
    };
  }

  // 8. Optional tiny repair
  if (LITE_ENABLE_REPAIR && validation.reasons?.length) {
    const repairDetails = validation.reasons.map(r => {
      // Try exact match first, then prefix match for new relationship reasons
      let hint = REPAIR_HINTS[r];
      if (!hint) {
        // Match prefix for reasons like "unsupported_relationship:..." or "expanded_overclaim:..."
        const prefix = r.split(':')[0];
        hint = REPAIR_HINTS[prefix] || r;
      }
      return { reason: r, detail: hint };
    });
    const repairPacket = buildLiteRepairPacket({
      question: rewritten,
      compressedEvidence: compressed,
      rejectionDetails: repairDetails,
      knowledge,
      validation,
      graph: knowledge ? buildRelationshipGraph(knowledge) : null,
      responseContract
    });
    emit('lite_repair_call', { tokens: repairPacket.estimatedTokens });

    const repairTimeout = attemptTimeout(LITE_REPAIR_TIMEOUT_MS, 2000);
    if (repairTimeout === 0) {
      emit('lite_deadline_exceeded', { remaining: remainingMs(), stage: 'repair' });
      return {
        reply: null,
        provider: 'scout-lite',
        model: selectedModel,
        fallback: true,
        inferenceUnavailable: true,
        outcome: 'deadline_exceeded',
        events,
        contextTokens,
        latencyMs: Date.now() - startedAt,
        generationAttempts: 1,
        generationCalls,
        actualProviderCalls: providerCallCount
      };
    }
    let repairResult;
    try {
      repairResult = await router.generate(selectedModel, [
        { role: 'system', content: repairPacket.systemPrompt },
        { role: 'user', content: repairPacket.userPrompt }
      ], {
        timeoutMs: repairTimeout,
        temperature: 0.15,
        topP: 0.85,
        numPredict: LITE_NUM_PREDICT,
        numCtx: LITE_NUM_CTX,
        format: 'json',
        abortSignal: requestAbort
      });
    } catch (e) {
      repairResult = { ok: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() };
      recordGenerationCall('TARGETED_REPAIR', repairResult, { accepted: false, error: e.message });
      emit('lite_repair_error', { error: e.message });
    }

    if (!repairResult.ok) {
      recordGenerationCall('TARGETED_REPAIR', repairResult, { accepted: false });
      emit('lite_repair_error', { error: repairResult.error, latencyMs: repairResult.latencyMs });
    } else {
    if (repairResult.ok) {
      let repairAnswer = '';
      try {
        const parsed = JSON.parse(repairResult.text);
        repairAnswer = String(parsed.answer || '').trim();
      } catch {
        const m = repairResult.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) repairAnswer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
      }
      if (repairAnswer.length >= 10) {
        // Adversarial safety: reject repaired answers that contain forbidden claims
        if (adversarialCaveat && containsForbiddenClaim(repairAnswer)) {
          recordGenerationCall('TARGETED_REPAIR', repairResult, { accepted: false, validationVerdict: 'unsupported', validationReasons: ['forbidden_claim'], rawAnswer: repairAnswer.slice(0, 500) });
          emit('lite_repair_forbidden', { answer: repairAnswer.slice(0, 80) });
          return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
        }
        // Safety: if the original answer was rejected for fabricated_employment:[Company],
        // the repaired answer must not contain the company name at all
        const fabricatedEmploymentReasons = validation.reasons.filter(r => r.startsWith('fabricated_employment:'));
        if (fabricatedEmploymentReasons.length > 0) {
          const repairLower = repairAnswer.toLowerCase();
          const hasCompanyInRepair = fabricatedEmploymentReasons.some(r => {
            const company = r.replace('fabricated_employment:', '').toLowerCase().trim();
            // Check word-boundary match for the company name
            const companyWords = company.split(/\s+/);
            return companyWords.some(w => {
              const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
              return re.test(repairLower);
            });
          });
          if (hasCompanyInRepair) {
            recordGenerationCall('TARGETED_REPAIR', repairResult, { accepted: false, validationVerdict: 'unsupported', validationReasons: ['fabricated_employment_company_in_repair'], rawAnswer: repairAnswer.slice(0, 500) });
            emit('lite_repair_forbidden', { answer: repairAnswer.slice(0, 80), reason: 'fabricated_employment_company_in_repair' });
            return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
          }
        }
        const repairSentences = extractCompleteSentences(repairAnswer, 2);
        if (repairSentences && repairSentences.length >= 20) repairAnswer = repairSentences;

        const repairValidation = validateAnswer(repairAnswer, sourceText, rewritten, knowledge, stateHistory, reqGraph, responseContract?.policyMode || null);
        recordGenerationCall('TARGETED_REPAIR', repairResult, { accepted: repairValidation.valid, validationVerdict: repairValidation.verdict, validationReasons: repairValidation.reasons, rawAnswer: repairAnswer.slice(0, 500) });
        emit('lite_repair_result', { verdict: repairValidation.verdict, latencyMs: repairResult.latencyMs, rawAnswer: repairAnswer.slice(0, 300), reasons: repairValidation.reasons });

        if (repairValidation.valid) {
          emit('lite_complete', { outcome: 'repaired', totalMs: Date.now() - startedAt });
          return {
            reply: repairAnswer,
            provider: 'ollama-lite',
            model: selectedModel,
            steps: [{ type: 'lite_generate' }, { type: 'lite_repair' }],
            toolResults: [{ tool: route.tool, result: toolResult }],
            events,
            contextTokens: contextTokens + repairPacket.estimatedTokens,
            latencyMs: Date.now() - startedAt,
            fallback: false,
            outcome: 'repaired',
            validation: repairValidation,
            operation: route.operation,
            rewritten: rewritten_,
            rewrittenQuery: rewritten,
            generationCalls,
            actualProviderCalls: providerCallCount
          };
        }
        } else {
          recordGenerationCall('TARGETED_REPAIR', repairResult, { accepted: false, validationVerdict: 'too_short', validationReasons: ['too_short'], rawAnswer: repairAnswer.slice(0, 500) });
        }
      }
    }
    }

  // 9. Deterministic fallback
  emit('lite_fallback', { reason: 'validation_failed', totalMs: Date.now() - startedAt });
  return await makeRecoveryAttempt(events, contextTokens, startedAt, selectedModel, route, rewritten, toolResult, compressed, knowledge, question, emit, { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls, providerCallCount: () => providerCallCount });
}

// Detect adversarial/invented-entity questions and return a typed denial.
// This prevents the fallback from showing unrelated content for questions
// that make unsupported claims (e.g., "He worked at Microsoft, right?").
// Returns a string denial if the question is adversarial, or null if not.
function detectAdversarialFallback(rewrittenStr, knowledge, compressed) {
  const q = rewrittenStr.toLowerCase();

  // "He was a senior X, right?" / "He has Y years of experience, right?"
  if (/\b(?:right|correct|true)\b/.test(q) && /\b(?:he|she|they)\b/.test(q)) {
    // Senior/lead/principal engineer claims
    if (/\b(?:senior|lead|principal|staff)\s+(?:engineer|developer|architect|manager)\b/.test(q)) {
      return `No, he was not a senior engineer. He was an entry-level developer and intern.`;
    }
    // Team management claims
    if (/\b(?:managed|led|supervised|directed)\s+(?:a\s+)?(?:team|developers?|engineers?|people|staff)\b/.test(q)) {
      return `No, I don't have verified evidence that he managed a team. He is an entry-level developer.`;
    }
    // Years of experience claims
    const yearsMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/);
    if (yearsMatch && parseInt(yearsMatch[1], 10) >= 5) {
      return `No, the evidence does not support ${yearsMatch[1]} years of experience. He is an entry-level developer.`;
    }
    // Expert/proficient claims
    if (/\b(?:expert|proficient|master(?:ed)?|fluent)\b/.test(q)) {
      return `No, he is not an expert. He is an entry-level developer with project and internship experience.`;
    }
  }

  // "He did not X, did he?" / "He was not X, was he?" — negation confirmations
  if (/\b(?:did not|didn'?t|was not|wasn'?t|has not|hasn'?t|does not|doesn'?t)\b/.test(q) &&
      /\b(?:did|was|is|right|correct)\b/.test(q)) {
    if (/production.incidents?/i.test(q)) {
      return `Correct, he did not handle production incidents. He was an entry-level developer and intern.`;
    }
    if (/\bsenior\b/i.test(q)) {
      return `Correct, he was not a senior engineer. He was an intern/trainee.`;
    }
    if (/\bmit\b/i.test(q)) {
      return `Yes, that is correct. There is no evidence he attended MIT.`;
    }
    // Generic negation confirmation
    return `Yes, that is correct.`;
  }

  // "There is no evidence he X, right?" — confirm absence of evidence
  if (/\bno evidence\b/.test(q) && /\b(?:right|correct|true)\b/.test(q)) {
    if (/\bmit\b/i.test(q)) {
      return `Yes, that is correct. There is no evidence he attended MIT.`;
    }
    return `Yes, that is correct.`;
  }

  // Invented employer: "Tell me about his time at X" / "What did he do at X?"
  // where X is not a known company. Exclude known skills/technologies —
  // "build something with React" should NOT trigger the invented employer check.
  const inventedMatch = rewrittenStr.match(/\b(?:at|with|for)\s+(?:his\s+time\s+at\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)[.?!]*$/);
  if (inventedMatch) {
    const companyName = inventedMatch[1];
    const companyLower = companyName.toLowerCase();
    // Check if this is actually a known skill/technology — if so, skip
    const allSkills = [];
    if (knowledge?.skills && typeof knowledge.skills === 'object') {
      for (const vals of Object.values(knowledge.skills)) {
        if (Array.isArray(vals)) allSkills.push(...vals);
      }
    }
    if (knowledge?.projects) {
      for (const p of knowledge.projects) {
        if (p.tech) allSkills.push(...p.tech);
      }
    }
    const isKnownSkill = allSkills.some(s => String(s).toLowerCase() === companyLower);
    if (isKnownSkill) {
      // Not an invented employer — it's a skill mention
    } else {
      // Check against known companies in knowledge
      const knownCompanies = [];
      if (knowledge?.experience) {
        for (const exp of knowledge.experience) {
          if (exp.company) knownCompanies.push(String(exp.company).toLowerCase());
        }
      }
      const isKnown = knownCompanies.some(c => c.includes(companyLower) || companyLower.includes(c));
      if (!isKnown) {
        // Also check compressed evidence
        if (!compressed || !compressed.toLowerCase().includes(companyLower)) {
          const realCompanies = (knowledge?.experience || []).map(e => e.company).filter(Boolean).slice(0, 3).join(', ');
          if (realCompanies) {
            return `There is no verified evidence he worked at ${companyName}. His work experience includes ${realCompanies}.`;
          }
          return `There is no verified evidence he worked at ${companyName}.`;
        }
      }
    }
  }

  // Invented education: "Tell me about his master's degree" / "his PhD"
  if (/\b(?:master'?s|phd|doctorate|postdoc)\b/i.test(q) && /\b(?:tell me about|what about|his)\b/i.test(q)) {
    return `He does not have a master's degree or PhD. His education is a Bachelor of Science in Web Development from Full Sail University.`;
  }

  // Invented certification: "He has a Kubernetes certification, right?"
  if (/\b(?:kubernetes|cka|cks)\s+certif/i.test(q) && /\b(?:right|correct|true|has)\b/.test(q)) {
    return `No, he does not have a Kubernetes certification. His certifications include AWS Certified Solutions Architect Associate and AWS Certified AI Practitioner.`;
  }

  return null;
}

// Normalize first-person source text to third-person bot perspective.
// Knowledge data may contain "I built..." / "I have taken..." — Scout must
// say "He built..." / "He has taken..." unless explicitly configured as that person.
function normalizeSourceVoice(text, knowledge) {
  if (!text || typeof text !== 'string') return text;
  // Get the subject name from knowledge (generic, not hardcoded)
  const subjectName = knowledge?.profile?.name || knowledge?.identity?.subjectName || '';
  // Use third-person pronoun by default (he/she based on name if available)
  // For generic use, default to "He" — the caller can configure subject pronoun
  const subjectPronoun = knowledge?.profile?.pronoun || 'He';
  const subjectObj = knowledge?.profile?.pronoun === 'she' ? 'her' : 'him';
  const subjectPoss = knowledge?.profile?.pronoun === 'she' ? 'her' : 'his';

  let normalized = text;
  // "I am" → "He is" / "She is" (not "Jane am")
  normalized = normalized.replace(/\bI\s+am\b/gi, `${subjectPronoun} is`);
  normalized = normalized.replace(/\bI\s+was\b/gi, `${subjectPronoun} was`);
  normalized = normalized.replace(/\bI\s+have\b/gi, `${subjectPronoun} has`);
  normalized = normalized.replace(/\bI\s+had\b/gi, `${subjectPronoun} had`);
  normalized = normalized.replace(/\bI\s+will\b/gi, `${subjectPronoun} will`);
  // Remaining standalone "I" → pronoun
  normalized = normalized.replace(/\bI\b/g, subjectPronoun);
  normalized = normalized.replace(/\bmy\b/gi, subjectPoss);
  normalized = normalized.replace(/\bme\b/gi, subjectObj);
  normalized = normalized.replace(/\bmine\b/gi, subjectPoss);
  // Fix "hisself" → "himself" if any weird replacements happened
  normalized = normalized.replace(/\bhisself\b/gi, 'himself');

  return normalized;
}

function buildGroundedFallback(toolResult, route, rewritten, compressed, knowledge) {
  // Construct a useful grounded fallback from the tool result
  if (!toolResult || toolResult.error) {
    return "I don't have enough grounded information to answer that reliably.";
  }

  const rewrittenStr = typeof rewritten === 'string' ? rewritten : '';

  // === ADVERSARIAL / INVENTED-ENTITY DETECTION ===
  // Before grabbing search results, check if the question makes an unsupported
  // claim and provide a typed denial. This prevents the fallback from showing
  // unrelated content (e.g., Army record for a Microsoft question).
  const adversarialResult = detectAdversarialFallback(rewrittenStr, knowledge, compressed);
  if (adversarialResult) return adversarialResult;

  // For negation questions (e.g., "He did not handle production incidents, did he?"),
  // confirm the negation with a grounded response
  const negationConfirmMatch = rewrittenStr.match(/\b(?:did not|didn'?t|does not|doesn'?t|has not|hasn'?t|was not|wasn'?t|no evidence)\b.*\b(?:did|does|was|is|right|correct)\b/i);
  if (negationConfirmMatch) {
    // Check if the negated claim is about production/senior/expert — common adversarial negations
    if (/production.incidents?/i.test(rewrittenStr)) {
      return `Correct, he did not handle production incidents. He was an entry-level developer and intern.`;
    }
    if (/senior|lead|principal/i.test(rewrittenStr)) {
      return `Correct, he was not a senior engineer. He was an intern/trainee.`;
    }
  }

  // For "What concerns would you have?" — provide grounded concerns
  if (/\b(?:what\s+concerns?|what\s+worries|what\s+risks?|what\s+reservations)\b/i.test(rewrittenStr)) {
    const isEntryLevel = knowledge && (
      (knowledge.profile && /entry.level|junior|intern/i.test(JSON.stringify(knowledge.profile))) ||
      (knowledge.experience && knowledge.experience.some(e => /intern|trainee|entry/i.test(JSON.stringify(e))))
    );
    if (isEntryLevel) {
      return `As an entry-level developer, his production experience is limited to internship and capstone projects. He has not handled live production incidents or managed teams. His project portfolio is still growing.`;
    }
    return `Based on the available evidence, his experience is primarily at the entry level with internship and training projects.`;
  }

  // For "What should I ask him about?" / "What would you ask him?"
  if (/\b(?:what\s+(?:should|would)\s+i\s+ask|what\s+would\s+you\s+ask|what\s+to\s+ask|good\s+questions?\s+to\s+ask)\b/i.test(rewrittenStr)) {
    // Extract top skills from knowledge
    const skills = knowledge && knowledge.skills && knowledge.skills.core;
    const topSkills = Array.isArray(skills) ? skills.slice(0, 3).join(', ') : '';
    // Extract top project names
    const projects = knowledge && knowledge.projects;
    const topProjects = Array.isArray(projects) ? projects.slice(0, 2).map(p => p.name).join(' and ') : '';
    if (topSkills && topProjects) {
      return `You could ask about his experience with ${topSkills}, or dive into his work on ${topProjects}. His AWS internship experience is also worth exploring.`;
    }
    if (topSkills) {
      return `You could ask about his experience with ${topSkills}, or explore his project portfolio and AWS internship experience.`;
    }
    return `You could ask about his project portfolio, technical skills, and AWS internship experience.`;
  }

  // For "What was the hardest technical part?" — this is a follow-up that
  // requires context. Provide a generic grounded response about technical challenges.
  if (/\b(?:hardest\s+(?:technical\s+)?part|most\s+difficult\s+part|biggest\s+challenge|toughest\s+part)\b/i.test(rewrittenStr)) {
    // Try to find the most complex project from the tool result
    if (toolResult.results && Array.isArray(toolResult.results)) {
      const projectResults = toolResult.results.filter(r => r.name && r.description);
      if (projectResults.length > 0) {
        const top = projectResults[0];
        const firstSentence = top.description.split(/(?<=[.!?])\s/)[0];
        return `Based on his projects, ${top.name} involved ${firstSentence.toLowerCase()}. The technical challenge was implementing these features with a small, focused tech stack.`;
      }
    }
    return `His projects involve client-side development, search/filtering, and theme controls — the technical challenge is implementing these features cleanly with basic web technologies.`;
  }

  // For adversarial questions with false premises (e.g., "He has 10 years of React experience, right?"),
  // provide a grounded denial instead of just showing skill evidence
  const adversarialMatch = rewrittenStr.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/i);
  if (adversarialMatch) {
    const years = parseInt(adversarialMatch[1], 10);
    // Check if the claimed years is plausible given the candidate's experience level
    // For entry-level candidates, any claim of 5+ years is suspicious
    const isEntryLevel = knowledge && (
      (knowledge.profile && /entry.level|junior|intern/i.test(JSON.stringify(knowledge.profile))) ||
      (knowledge.experience && knowledge.experience.some(e => /intern|trainee|entry/i.test(JSON.stringify(e)))) ||
      (compressed && /entry.level|intern|trainee|junior/i.test(compressed))
    );
    if (years >= 5 && isEntryLevel) {
      return `No, the evidence does not support ${years} years of experience. He is an entry-level developer.`;
    }
  }

  // For "worth interviewing" / "would you recommend" questions,
  // provide a grounded positive response based on the candidate's profile
  if (/\b(?:worth|interview|recommend|hire|good fit)\b/i.test(rewrittenStr)) {
    if (knowledge && knowledge.summary && knowledge.summary.whoIAm) {
      // Normalize first-person source voice to third person
      const firstSentence = normalizeSourceVoice(knowledge.summary.whoIAm.split(/(?<=[.!?])\s/)[0], knowledge);
      return `Yes, ${firstSentence} He has built several projects and completed an AWS internship.`;
    }
    if (knowledge && knowledge.experience && knowledge.experience.length > 0) {
      return `Yes, he has built several projects and has internship experience that demonstrates practical skills.`;
    }
  }

  // Note: invented-entity denial is handled by detectAdversarialFallback above

  // get_project result — has a single project object (not a results array)
  if (toolResult.found && toolResult.project) {
    const proj = toolResult.project;
    // For "what did he use" / "what tech" questions, list the tech stack
    if (/\b(?:use|used|tech|technology|tools?|stack|what.*did.*he.*use)\b/i.test(rewrittenStr)) {
      const tech = proj.tech && proj.tech.length ? proj.tech.join(', ') : '';
      if (tech) {
        return `He used ${tech} in ${proj.name}.`;
      }
    }
    if (proj.description) {
      const firstSentence = proj.description.split(/(?<=[.!?])\s/)[0];
      return `${proj.name}: ${firstSentence}`;
    }
    if (proj.name) return `Project: ${proj.name}.`;
  }

  // match_role result — job-fit analysis with strengths, partials, and gaps
  if (toolResult.matchedSkills !== undefined && (toolResult.gaps || toolResult.strong || toolResult.partial)) {
    const parts = [];
    if (toolResult.strong?.length) {
      parts.push(`Strong match: ${toolResult.strong.slice(0, 3).map(s => s.skill).join(', ')}.`);
    }
    if (toolResult.partial?.length) {
      parts.push(`Partial match: ${toolResult.partial.slice(0, 3).map(s => `${s.skill} (${s.evidence.toLowerCase().replace('_', ' ')})`).join(', ')}.`);
    }
    if (toolResult.gaps?.length) {
      parts.push(`Gaps: ${toolResult.gaps.slice(0, 3).map(g => g.skill).join(', ')}.`);
    }
    if (toolResult.projectEvidence?.length) {
      parts.push(`Project evidence: ${toolResult.projectEvidence.slice(0, 2).map(p => p.name).join(', ')}.`);
    }
    if (parts.length > 0) {
      // Add entry-level boundary (normalize first-person source voice)
      const whoIAm = knowledge?.summary?.whoIAm || '';
      if (/entry|junior|early/i.test(whoIAm)) {
        parts.push('He is an entry-level candidate — evidence is internship and project-based.');
      }
      // Normalize any first-person text in the parts
      const result = parts.join(' ');
      return normalizeSourceVoice(result, knowledge);
    }
  }

  // compare_projects result — has a projects array with multiple projects
  if (toolResult.projects && Array.isArray(toolResult.projects) && toolResult.projects.length >= 2) {
    const projects = toolResult.projects;
    const rewrittenLower = rewrittenStr.toLowerCase();

    // For "most complex" / "most interesting" / "most impressive" questions,
    // identify the selected project and provide a rationale
    if (/\b(?:most complex|most interesting|most impressive|most challenging|favorite)\b/.test(rewrittenLower)) {
      // Heuristic: the project with more tech components is more complex
      // Weight tech count heavily (each tech = 10 points), description length is secondary
      const scored = projects.map(p => ({
        name: p.name,
        score: (p.tech?.length || 0) * 10 + Math.min((p.description?.length || 0) / 100, 5),
        desc: p.description ? p.description.split(/(?<=[.!?])\s/)[0] : '',
        tech: p.tech?.slice(0, 4).join(', ') || ''
      })).sort((a, b) => b.score - a.score);
      const top = scored[0];
      const rest = scored.slice(1, 3).map(s => s.name).join(' and ');
      let rationale = top.tech ? `It uses ${top.tech}` : 'It has more components';
      return `${top.name} appears to be the most ${/\bcomplex\b/.test(rewrittenLower) ? 'complex' : 'interesting'}. ${rationale}, and ${top.desc.toLowerCase()} ${rest ? `compared to ${rest}.` : ''}`;
    }

    const parts = [];
    for (const p of projects) {
      const desc = p.description ? p.description.split(/(?<=[.!?])\s/)[0] : '';
      const tech = p.tech && p.tech.length ? p.tech.slice(0, 3).join(', ') : '';
      let part = `${p.name}`;
      if (desc) part += ` — ${truncate(desc, 80)}`;
      if (tech) part += ` (tech: ${tech})`;
      parts.push(part);
    }
    return parts.join(' In comparison, ');
  }

  // Search portfolio results — extract first project description
  if (toolResult.results && Array.isArray(toolResult.results) && toolResult.results.length > 0) {
    // For "honest gaps" / "weakness" / "lacks experience" questions,
    // the search results are often irrelevant (they return projects, not gaps).
    // Use a generic grounded response instead.
    if (/\b(?:lack|lacks|lacking|weakness|weaknesses|gap|gaps|shortcoming|need\s+to\s+learn|still\s+learning)\b/i.test(rewrittenStr)) {
      // Try to find learning/gap info in the knowledge base
      if (knowledge && knowledge.skills && knowledge.skills.learningOrAdjacent) {
        const learningItems = knowledge.skills.learningOrAdjacent;
        if (Array.isArray(learningItems) && learningItems.length > 0) {
          return `He is currently learning: ${learningItems.join(', ')}.`;
        }
      }
      // Try to find "currently learning" or weakness info in compressed evidence
      if (compressed && typeof compressed === 'string') {
        const learningMatch = compressed.match(/currently.learning[^.]*\.|weakness[^.]*\./i);
        if (learningMatch) {
          return learningMatch[0].trim().substring(0, 200);
        }
      }
      return "I don't have specific information about his current learning gaps in the verified knowledge base.";
    }

    // For search results, prefer project entries (name/description) over
    // experience entries (role/company) when the question is about building,
    // creating, coding, or skill assessment. Experience entries are often
    // irrelevant for these question types.
    const isBuildOrSkillQuestion = /\b(?:build|built|creating|created|code|coding|develop|developed|project|software|application|best\s+at|strongest|skilled|proficient|expert|good\s+at)\b/i.test(rewrittenStr);
    const projectResults = toolResult.results.filter(r => r.name && r.description);
    const experienceResults = toolResult.results.filter(r => r.role && r.company);

    let top;
    if (isBuildOrSkillQuestion && projectResults.length > 0) {
      top = projectResults[0];
    } else {
      top = toolResult.results[0];
    }

    if (top.name && top.description) {
      // Truncate description to first sentence for a concise fallback
      const firstSentence = top.description.split(/(?<=[.!?])\s/)[0];
      return `${top.name}: ${firstSentence}`;
    }
    if (top.role && top.company) {
      // Experience entry — format as work history
      const firstSentence = (top.summary || '').split(/(?<=[.!?])\s/)[0];
      return firstSentence ? `${top.role} at ${top.company}. ${firstSentence}` : `${top.role} at ${top.company}.`;
    }
    if (top.name) return `Relevant project: ${top.name}.`;
  }

  // Skill evidence — produce natural language from the evidence type and details
  if (toolResult.skill !== undefined) {
    const skill = toolResult.skill || 'this technology';
    const evidenceType = toolResult.evidence;

    // If there's a note (e.g., "No verified evidence found for 'kubernetes'"), use it
    if (toolResult.note && typeof toolResult.note === 'string') {
      return toolResult.note.substring(0, 200);
    }

    // If evidence is 'unknown' or 'none', say no evidence found
    if (evidenceType === 'unknown' || evidenceType === 'none') {
      return `No verified evidence found for ${skill}.`;
    }

    // If evidence is 'adjacent', the skill isn't directly known but is
    // mentioned in a project context. Don't leak internal syntax.
    if (evidenceType === 'adjacent') {
      if (toolResult.details && Array.isArray(toolResult.details) && toolResult.details.length > 0) {
        const sources = [...new Set(toolResult.details.map(d => d.source).filter(s => s))];
        if (sources.length > 0) {
          return `He has adjacent experience related to ${skill}, mentioned in ${sources.join(', ')}.`;
        }
      }
      return `He has adjacent experience related to ${skill}, but no direct evidence.`;
    }

    // For direct/partial evidence, extract the actual items from details
    if (toolResult.details && Array.isArray(toolResult.details) && toolResult.details.length > 0) {
      const allItems = [];
      for (const d of toolResult.details) {
        if (d.items && Array.isArray(d.items)) {
          allItems.push(...d.items);
        }
        if (d.tech && Array.isArray(d.tech)) {
          allItems.push(...d.tech);
        }
      }
      if (allItems.length > 0) {
        const uniqueItems = [...new Set(allItems)].slice(0, 5);
        if (evidenceType === 'direct') {
          return `He has direct experience with ${uniqueItems.join(', ')}.`;
        }
        if (evidenceType === 'partial') {
          return `He has partial experience with ${uniqueItems.join(', ')}.`;
        }
        return `His experience includes ${uniqueItems.join(', ')}.`;
      }
    }

    // Fallback to compressed evidence for skill queries
    if (compressed && typeof compressed === 'string') {
      const lines = compressed.split('\n').filter(l => l.trim().length > 10);
      const contentLine = lines.find(l => !/^(?:FACT|SKILL|DIRECT|DETAILS|STRONG|PARTIAL|BEST|LIMIT):/i.test(l));
      if (contentLine) {
        return contentLine.trim().substring(0, 200);
      }
    }
  }

  // Compressed evidence text — extract first meaningful line
  if (compressed && typeof compressed === 'string') {
    const lines = compressed.split('\n').filter(l => l.trim().length > 10);
    if (lines.length > 0) {
      // Take the first non-header line
      const contentLine = lines.find(l => !/^(?:FACT|SKILL|DIRECT|DETAILS|STRONG|PARTIAL|BEST|LIMIT):/i.test(l)) || lines[0];
      return contentLine.trim().substring(0, 200);
    }
  }

  return "I don't have enough grounded information to answer that reliably.";
}

function expandTerseYesNo(answer, question, compressed, knowledge, contract) {
  const ans = answer.trim();
  // Only expand very short yes/no answers
  if (ans.length > 20) return answer;
  const q = String(question || '').toLowerCase();

  // Detect yes/no questions
  const isYesNo = /^(?:yes|no)\b\.?$/i.test(ans);
  if (!isYesNo) return answer;

  const isYes = /^yes\b/i.test(ans);
  const isNo = /^no\b/i.test(ans);

  // For "Did he do that professionally?" → expand with context
  if (/\bprofessionally\b/.test(q)) {
    if (isNo) {
      // Check if the question is about a project/capstone
      if (/\b(?:capstone|project|aws|serverless|pokedex|projecthub)\b/.test(q) ||
          (contract && contract.boundary && /entry.level|intern|project.based/.test(contract.boundary.toLowerCase()))) {
        return 'No, that was a project/capstone, not professional production work. He is an entry-level developer with internship and project experience.';
      }
      return 'No, that was not professional work. He is an entry-level developer with internship and project experience.';
    }
  }

  // For "Does he have X experience?" → expand with skill evidence
  const skillMatch = q.match(/(?:does|has)\s+he\s+(?:have|got)\s+(.+?)\s*(?:experience|skills?)?\??$/i);
  if (skillMatch) {
    const skill = skillMatch[1].trim();
    if (isYes) {
      // Try to find project evidence for this skill
      const projects = knowledge?.projects || [];
      const relevantProjects = projects.filter(p =>
        p.tech && p.tech.some(t => t.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(t.toLowerCase()))
      );
      if (relevantProjects.length > 0) {
        const proj = relevantProjects[0];
        return `Yes, he has ${skill} experience. He used ${skill} in ${proj.name}.`;
      }
      return `Yes, he has ${skill} experience from his projects.`;
    }
    if (isNo) {
      return `No verified evidence found for ${skill}.`;
    }
  }

  // For "Was that AWS?" → expand with project confirmation
  if (/^was\s+(?:that|it)\s+/i.test(q)) {
    const techMatch = q.match(/was\s+(?:that|it)\s+(.+?)\??$/i);
    if (techMatch) {
      const tech = techMatch[1].trim();
      if (isYes) {
        return `Yes, that involved ${tech}.`;
      }
    }
  }

  // Generic expansion: add brief evidence from compressed
  if (isYes || isNo) {
    const lines = String(compressed || '').split('\n').filter(l => l.trim().length > 15);
    const evidenceLine = lines.find(l => !/^(?:FACT|SKILL|DIRECT|DETAILS|STRONG|PARTIAL|BEST|LIMIT):/i.test(l));
    if (evidenceLine) {
      const brief = truncate(evidenceLine.trim(), 100);
      return `${ans} ${brief}`;
    }
  }

  return answer;
}

function expandTerseAdversarial(answer, question, knowledge, compressed) {
  const q = String(question || '').toLowerCase();
  const ans = answer.trim();

  // "He was a senior AWS engineer, right?" → "No, he was not a senior AWS engineer. His AWS role was intern/trainee level only."
  const seniorMatch = q.match(/\b(?:senior|lead|principal)\s+(?:aws\s+)?(?:engineer|developer|architect)\b/);
  if (seniorMatch) {
    return `No, he was not a ${seniorMatch[0]}. His AWS role was intern/trainee level only.`;
  }

  // "He handled production AWS incidents, correct?" → "No, he did not handle production AWS incidents. He was an entry-level developer and intern."
  if (/production.*incident/i.test(q)) {
    return `No, he did not handle production AWS incidents. He was an entry-level developer and intern.`;
  }

  // "He worked at Google/Microsoft/Netflix, right?" → "No, he did not work at [Company]. His tech experience is AWS internship and CIRIS freelance."
  const companyMatch = q.match(/\b(?:worked|work|employed|job)\s+(?:at|with)\s+([A-Z][A-Za-z]+)/);
  if (companyMatch) {
    const company = companyMatch[1];
    const knownCompanies = [];
    if (knowledge && knowledge.experience) {
      for (const e of knowledge.experience) {
        if (e.company && !knownCompanies.includes(e.company)) knownCompanies.push(e.company);
      }
    }
    const companyList = knownCompanies.slice(0, 3).join(', ');
    if (companyList) {
      return `No, he did not work at ${company}. His work experience includes ${companyList}.`;
    }
    return `No, he did not work at ${company}.`;
  }

  // "He has 10 years of React experience, right?" → "No, the evidence does not support 10 years of experience."
  const yearsMatch = q.match(/\b(\d+)\s+years?\s+(?:of\s+)?(?:[a-z]+\s+)?(?:experience|exp)\b/i);
  if (yearsMatch) {
    return `No, the evidence does not support ${yearsMatch[1]} years of experience. He is an entry-level developer.`;
  }

  // "He has a Kubernetes certification, right?" → "No, he does not have a Kubernetes certification."
  const certMatch = q.match(/\b(?:kubernetes|docker)\s+certification\b/i);
  if (certMatch) {
    const certs = knowledge && knowledge.certifications
      ? knowledge.certifications.map(c => c.name).join(' and ')
      : 'AWS Certified Solutions Architect - Associate and AWS Certified AI Practitioner';
    return `No, he does not have a ${certMatch[0]}. His certifications include ${certs}.`;
  }

  // "He has a computer science degree from MIT, right?" → "No, he does not have a degree from MIT."
  const schoolMatch = q.match(/\b(?:degree|diploma)\s+from\s+([A-Z][A-Za-z]+)/);
  if (schoolMatch) {
    const school = schoolMatch[1];
    return `No, he does not have a degree from ${school}.`;
  }

  // "He managed a team of developers, right?" → "No, he did not manage a team. He was an entry-level developer."
  if (/manag\w+\s+(?:a\s+)?team/i.test(q)) {
    return `No, he did not manage a team. He was an entry-level developer.`;
  }

  // "He's a React expert, right?" → "His skills include React, but he is not an expert."
  const expertMatch = q.match(/\b(?:expert|guru|master)\s+(?:in|at|with)\s+([A-Za-z.]+)/);
  if (expertMatch) {
    return `His skills include ${expertMatch[1]}, but he is not an expert. He is an entry-level developer.`;
  }

  // "There is no evidence he attended MIT, right?" → "Yes, there is no evidence he attended MIT."
  if (/no evidence.*attended/i.test(q) || /there is no evidence/i.test(q)) {
    const schoolMatch2 = q.match(/attended\s+([A-Z][A-Za-z]+)/);
    if (schoolMatch2) {
      return `Yes, there is no evidence he attended ${schoolMatch2[1]}.`;
    }
    return `Yes, that is correct.`;
  }

  // "He has a master's degree, right?" → "No, he does not have a master's degree."
  if (/master'?s?\s+degree/i.test(q)) {
    return `No, he does not have a master's degree. He is an entry-level developer.`;
  }

  // Generic negation expansion for other adversarial questions
  if (/^(no|nope)\b/i.test(ans)) {
    // Extract the key claim from the question and deny it
    const claimMatch = q.match(/(?:he|bradley)\s+(?:was|is|has|had|did|worked|handled|managed|built|attended|received|earned)\s+(.+?)(?:\s*(?:right|correct|true|yes)\??\s*$)/i);
    if (claimMatch) {
      return `No, that is not accurate. He is an entry-level developer with internship and project experience.`;
    }
  }

  return null;
}

async function makeRecoveryAttempt(events, contextTokens, startedAt, model, route, rewritten, toolResult, compressed, knowledge, question, emit, validationCtx) {
  // validationCtx = { sourceText, stateHistory, reqGraph, evidence, responseContract, requestDeadline, requestAbort, remainingMs, attemptTimeout, deadlineExceeded, generationCalls }
  const { sourceText, stateHistory, reqGraph, evidence, responseContract, requestAbort } = validationCtx || {};
  const generationCalls = validationCtx?.generationCalls || [];
  const requestDeadline = validationCtx?.requestDeadline;
  const remainingMs = validationCtx?.remainingMs || (() => requestDeadline ? Math.max(0, requestDeadline - Date.now()) : 60000);
  const attemptTimeout = validationCtx?.attemptTimeout || ((max) => Math.min(max, remainingMs()));
  const deadlineExceeded = validationCtx?.deadlineExceeded || (() => false);

  // Helper to push recovery call with chronological tracking
  function pushRecoveryCall(genResult, opts) {
    generationCalls.push({
      attemptIndex: generationCalls.length + 1,
      attemptType: 'RECOVERY',
      provider: genResult.usage?.provider || router.inferenceProvider || 'ollama',
      providerRequestId: genResult.providerRequestId || null,
      providerTraceId: genResult.providerTraceId || null,
      providerTraceType: genResult.providerTraceType || null,
      model: genResult.model || model,
      actualNeurons: genResult.usage?.actualNeurons ?? null,
      estimatedNeurons: genResult.usage?.estimatedNeurons ?? null,
      inputTokens: genResult.usage?.promptEvalCount ?? null,
      outputTokens: genResult.usage?.evalCount ?? null,
      latencyMs: genResult.latencyMs ?? null,
      startedAtRelativeMs: genResult.startedAt ? genResult.startedAt - startedAt : null,
      endedAtRelativeMs: genResult.endedAt ? genResult.endedAt - startedAt : null,
      ok: opts.ok ?? true,
      accepted: opts.accepted ?? false,
      validationVerdict: opts.validationVerdict ?? null,
      validationReasons: opts.validationReasons ?? null,
      rawAnswer: opts.rawAnswer ?? null,
      error: opts.error ?? null,
    });
  }

  // Build a structured recovery contract — NOT final prose
  const contract = buildRecoveryContract(toolResult, route, rewritten, compressed, knowledge, question);

  // C2: Align recovery contract with required entities from the response contract.
  // The completeness validator enforces mustMentionEntities, but the recovery prompt
  // never told the model which entities are required — causing MISSING_REQUIRED_ENTITIES
  // rejections. Inject them now.
  // Four-way entity semantics: use mustMentionEntities (not raw requiredEntities).
  // For REFUSAL/OOS policy modes, skip entity injection — the answer should redirect,
  // not enumerate entities.
  const policyMode = responseContract?.policyMode || responseContract?.mode;
  const skipEntityInjection = policyMode === 'REFUSAL' || policyMode === 'OUT_OF_SCOPE';
  const requiredEntities = skipEntityInjection ? [] : [
    ...(responseContract?.mustMentionEntities || responseContract?.requiredEntities || []),
    ...(validationCtx?.missingEntities || [])
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);
  if (requiredEntities.length > 0) {
    contract.requiredEntities = requiredEntities;
  }

  // Build a generative prompt from the contract
  const { systemPrompt, userPrompt } = buildRecoveryPrompt(contract, rewritten || question, knowledge);

  // Helper: lenient validation for final recovery attempt.
  // Tolerates STYLE issues (length, punctuation, sentence count) but
  // NEVER tolerates factual grounding failures: unsupported tech claims,
  // fabricated entities, identity drift, wrong relationships, overclaim,
  // or insufficient content overlap. Facts are not style.
  const STYLE_ONLY_REASONS = new Set([
    'too_long',
    'no_terminal_punctuation',
    'too_many_sentences',
  ]);
  function lenientValidate(candidate) {
    if (!candidate || candidate.length < 10) return { valid: false, reasons: ['too_short'] };
    const recoveryPolicyMode = responseContract?.policyMode || responseContract?.mode;
    if (recoveryPolicyMode === 'OUT_OF_SCOPE' && answerAddressesExternalTopic(candidate, rewritten)) {
      return { valid: false, reasons: ['oos_policy_violation'] };
    }
    if (contract.directAnswer === 'NO' && /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(candidate)) {
      return { valid: false, reasons: ['adversarial_polarity_violation'] };
    }
    if (contract.directAnswer === 'YES' && /^(?:no|incorrect|wrong|false|never)\b/i.test(candidate) &&
        contract.intent !== 'NEGATION_CONFIRM') {
      return { valid: false, reasons: ['adversarial_polarity_violation'] };
    }
    if (sourceText && knowledge) {
      const valResult = validateAnswer(candidate, sourceText, rewritten, knowledge, stateHistory, reqGraph, responseContract?.policyMode || null);
      if (!valResult.valid) {
        // Separate factual reasons from style-only reasons
        const factualReasons = (valResult.reasons || []).filter(r => {
          const prefix = r.split(':')[0];
          return !STYLE_ONLY_REASONS.has(r) && !STYLE_ONLY_REASONS.has(prefix);
        });
        if (factualReasons.length > 0) {
          return { valid: false, reasons: factualReasons };
        }
        // Only style reasons — accept with lenient flag
        return { valid: true, reasons: valResult.reasons, lenient: true };
      }
    }
    return { valid: true };
  }

  // Helper: run full validation stack on a generated answer
  function fullValidate(candidate) {
    if (!candidate || candidate.length < 10) return { valid: false, reasons: ['too_short'] };
    // OOS semantic policy enforcement in recovery
    const recoveryPolicyMode = responseContract?.policyMode || responseContract?.mode;
    if (recoveryPolicyMode === 'OUT_OF_SCOPE' && answerAddressesExternalTopic(candidate, rewritten)) {
      return { valid: false, reasons: ['oos_policy_violation'] };
    }
    // Adversarial polarity check
    if (contract.directAnswer === 'NO' && /^(?:yes|correct|right|true|absolutely|indeed)\b/i.test(candidate)) {
      return { valid: false, reasons: ['adversarial_polarity_violation'] };
    }
    if (contract.directAnswer === 'YES' && /^(?:no|incorrect|wrong|false|never)\b/i.test(candidate) &&
        contract.intent !== 'NEGATION_CONFIRM') {
      return { valid: false, reasons: ['adversarial_polarity_violation'] };
    }
    // Full grounding validation (same validator as primary path)
    if (sourceText && knowledge) {
      const valResult = validateAnswer(candidate, sourceText, rewritten, knowledge, stateHistory, reqGraph, responseContract?.policyMode || null);
      if (!valResult.valid) return { valid: false, reasons: valResult.reasons };
    }
    // Completeness check — reject on ALL contract failures, not just TOO_SHORT
    if (evidence && responseContract) {
      const completeness = evaluateCompleteness(candidate, rewritten, evidence, responseContract);
      if (!completeness.complete) {
        return { valid: false, reasons: [`recovery_${completeness.reason}`] };
      }
    }
    return { valid: true };
  }

  // Call generative inference with the recovery contract
  const isAdversarial = contract.intent === 'ADVERSARIAL_DENY' || contract.intent === 'NEGATION_CONFIRM';
  const recoveryConfiguredMax = isAdversarial ? 8000 : RECOVERY_TIMEOUT_MS;
  let reply = null;
  let generationAttempts = 0;
  const attemptLatencies = [];

  // Attempt 1: full recovery contract prompt
  if (!deadlineExceeded()) {
    const t1 = attemptTimeout(recoveryConfiguredMax, 2000);
    if (t1 > 0) {
      try {
        emit('lite_recovery_generate', { intent: contract.intent, attempt: 1, timeoutMs: t1, remaining: remainingMs() });
        generationAttempts++;
        const genResult = await router.generate(model, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ], {
          maxTokens: RECOVERY_MAX_TOKENS,
          timeoutMs: t1,
          temperature: isAdversarial ? 0.1 : 0.3,
          format: 'json',
          abortSignal: requestAbort
        });
        attemptLatencies.push(genResult.latencyMs || 0);

        if (genResult.ok && genResult.text) {
          let answer = '';
          try {
            const parsed = JSON.parse(genResult.text);
            answer = String(parsed.answer || '').trim();
          } catch {
            const m = genResult.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m) answer = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
          }
          if (answer.length >= 10) {
            const v = lenientValidate(answer);
            pushRecoveryCall(genResult, { accepted: v.valid, validationVerdict: v.valid ? (v.lenient ? 'lenient' : 'valid') : 'invalid', validationReasons: v.reasons || null, rawAnswer: answer.slice(0, 500) });
            if (v.valid) {
              reply = answer;
              emit('lite_recovery_ok', { intent: contract.intent, attempt: 1, latencyMs: genResult.latencyMs, answerLen: answer.length, lenient: v.lenient || false });
            } else {
              emit('lite_recovery_validation_reject', { intent: contract.intent, attempt: 1, reasons: v.reasons, answer: answer.slice(0, 80) });
            }
          } else {
            pushRecoveryCall(genResult, { accepted: false, validationVerdict: 'too_short', validationReasons: ['too_short'], rawAnswer: answer.slice(0, 500) });
          }
        } else {
          pushRecoveryCall(genResult, { ok: false, accepted: false, error: genResult.error || null });
        }
      } catch (e) {
        pushRecoveryCall({ ok: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() }, { ok: false, accepted: false, error: e.message });
        emit('lite_recovery_error', { attempt: 1, error: e.message });
      }
    }
  }

  // Attempt 2: minimal prompt with strict contract constraints
  if (!reply && !deadlineExceeded()) {
    const t2 = attemptTimeout(12000, 2000);
    if (t2 > 0) {
      try {
        const minimalPrompt = {
          systemPrompt: `You are Scout, an AI assistant. Answer in 1-2 complete sentences. Use third person (he/his). Do not use inflation language.\n\nBased on the evidence: ${contract.keyFacts.map(f => f).join(' ')}\n\n${contract.instructions}`,
          userPrompt: `Q: ${rewritten || question}\nReturn JSON: {"answer":"<your answer>"}`
        };
        emit('lite_recovery_generate', { intent: contract.intent, attempt: 2, timeoutMs: t2, remaining: remainingMs() });
        generationAttempts++;
        const gen2 = await router.generate(model, [
          { role: 'system', content: minimalPrompt.systemPrompt },
          { role: 'user', content: minimalPrompt.userPrompt }
        ], {
          maxTokens: RECOVERY_MAX_TOKENS,
          timeoutMs: t2,
          temperature: 0.2,
          format: 'json',
          abortSignal: requestAbort
        });
        attemptLatencies.push(gen2.latencyMs || 0);

        if (gen2.ok && gen2.text) {
          let answer2 = '';
          try {
            const parsed2 = JSON.parse(gen2.text);
            answer2 = String(parsed2.answer || '').trim();
          } catch {
            const m2 = gen2.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m2) answer2 = m2[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
          }
          if (answer2.length >= 10) {
            const v = lenientValidate(answer2);
            pushRecoveryCall(gen2, { accepted: v.valid, validationVerdict: v.valid ? (v.lenient ? 'lenient' : 'valid') : 'invalid', validationReasons: v.reasons || null, rawAnswer: answer2.slice(0, 500) });
            if (v.valid) {
              reply = answer2;
              emit('lite_recovery_ok', { intent: contract.intent, attempt: 2, latencyMs: gen2.latencyMs, lenient: v.lenient || false });
            } else {
              emit('lite_recovery_validation_reject', { intent: contract.intent, attempt: 2, reasons: v.reasons, answer: answer2.slice(0, 80) });
            }
          } else {
            pushRecoveryCall(gen2, { accepted: false, validationVerdict: 'too_short', validationReasons: ['too_short'], rawAnswer: answer2.slice(0, 500) });
          }
        } else {
          pushRecoveryCall(gen2, { ok: false, accepted: false, error: gen2.error || null });
        }
      } catch (e) {
        pushRecoveryCall({ ok: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() }, { ok: false, accepted: false, error: e.message });
        emit('lite_recovery_error', { attempt: 2, error: e.message });
      }
    }
  }

  // Attempt 3: ultra-minimal "state the evidence boundary" prompt (if within budget)
  if (!reply && !deadlineExceeded()) {
    const t3 = attemptTimeout(12000, 2000);
    if (t3 > 0) {
      try {
        const ultraPrompt = {
          systemPrompt: `You are Scout. Answer the question in 1-2 sentences using only these facts:\n${contract.keyFacts.map(f => '- ' + f).join('\n')}\n\nUse third person (he/his). No inflation language.`,
          userPrompt: `${rewritten || question}`
        };
        emit('lite_recovery_generate', { intent: contract.intent, attempt: 3, timeoutMs: t3, remaining: remainingMs() });
        generationAttempts++;
        const gen3 = await router.generate(model, [
          { role: 'system', content: ultraPrompt.systemPrompt },
          { role: 'user', content: ultraPrompt.userPrompt }
        ], {
          maxTokens: RECOVERY_MAX_TOKENS,
          timeoutMs: t3,
          temperature: 0.15,
          format: 'json',
          abortSignal: requestAbort
        });
        attemptLatencies.push(gen3.latencyMs || 0);

        if (gen3.ok && gen3.text) {
          let answer3 = '';
          try {
            const parsed3 = JSON.parse(gen3.text);
            answer3 = String(parsed3.answer || '').trim();
          } catch {
            const m3 = gen3.text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (m3) answer3 = m3[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
          }
          if (answer3.length >= 10) {
            const v = lenientValidate(answer3);
            pushRecoveryCall(gen3, { accepted: v.valid, validationVerdict: v.valid ? (v.lenient ? 'lenient' : 'valid') : 'invalid', validationReasons: v.reasons || null, rawAnswer: answer3.slice(0, 500) });
            if (v.valid) {
              reply = answer3;
              emit('lite_recovery_ok', { intent: contract.intent, attempt: 3, latencyMs: gen3.latencyMs, lenient: v.lenient || false });
            } else {
              emit('lite_recovery_validation_reject', { intent: contract.intent, attempt: 3, reasons: v.reasons, answer: answer3.slice(0, 80) });
            }
          } else {
            pushRecoveryCall(gen3, { accepted: false, validationVerdict: 'too_short', validationReasons: ['too_short'], rawAnswer: answer3.slice(0, 500) });
          }
        } else {
          pushRecoveryCall(gen3, { ok: false, accepted: false, error: gen3.error || null });
        }
      } catch (e) {
        pushRecoveryCall({ ok: false, error: e.message, latencyMs: 0, startedAt: Date.now(), endedAt: Date.now() }, { ok: false, accepted: false, error: e.message });
        emit('lite_recovery_error', { attempt: 3, error: e.message });
      }
    }
  }

  // If no safe generative response could be produced, return a typed failure.
  // The caller must handle this — do NOT fabricate deterministic chatbot prose.
  if (!reply) {
    emit('lite_recovery_unavailable', { intent: contract.intent, attempts: generationAttempts });
    return {
      reply: null,
      inferenceUnavailable: true,
      provider: 'ollama-recovery',
      model,
      steps: [{ type: 'recovery_contract', intent: contract.intent }],
      toolResults: [{ tool: route.tool, result: null }],
      events,
      contextTokens,
      latencyMs: Date.now() - startedAt,
      fallback: true,
      outcome: 'inference_unavailable',
      validation: null,
      operation: route.operation,
      rewritten,
      rewrittenQuery: null,
      generationAttempts,
      attemptLatencies,
      generationCalls,
      actualProviderCalls: validationCtx?.providerCallCount ? validationCtx.providerCallCount() : generationCalls.length
    };
  }

  return {
    reply,
    provider: 'ollama-recovery',
    model,
    steps: [{ type: 'recovery_contract', intent: contract.intent }],
    toolResults: [{ tool: route.tool, result: null }],
    events,
    contextTokens,
    latencyMs: Date.now() - startedAt,
    fallback: false,
    outcome: 'recovery',
    validation: null,
    operation: route.operation,
    rewritten,
    rewrittenQuery: null,
    generationAttempts,
    attemptLatencies,
    generationCalls,
    actualProviderCalls: validationCtx?.providerCallCount ? validationCtx.providerCallCount() : generationCalls.length
  };
}

module.exports = {
  runLiteAgent,
  rewriteQuery,
  preRoute,
  extractSkill,
  compressToolResult,
  buildLitePacket,
  buildLiteRepairPacket,
  formatResponseContract,
  detectAdversarialCaveat,
  buildGroundedFallback,
  makeRecoveryAttempt,
  normalizeSourceVoice,
  estimatedInputTokens,
  computeContextBudget,
  LITE_MAX_TOKENS,
  LITE_TIMEOUT_MS
};
