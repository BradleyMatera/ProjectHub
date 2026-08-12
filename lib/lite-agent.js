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
const { validateAnswer, extractCompleteSentences } = require('./grounding-validator');
const { resolveReferents } = require('./session-state');
const scoutIdentity = require('./scout-identity');
const { buildRelationshipGraph } = require('./relationship-graph');
const { evaluateCompleteness, classifyIntent } = require('./completeness-check');
const { planResponse, formatPlanForPrompt } = require('./response-planner');

// --- Configuration ---

const LITE_MAX_TOKENS = parseInt(process.env.SCOUT_LITE_MAX_TOKENS || '320', 10);
const LITE_TIMEOUT_MS = Math.max(3000, Math.min(parseInt(process.env.SCOUT_LITE_TIMEOUT_MS || '15000', 10), 30000));
const LITE_REPAIR_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.SCOUT_LITE_REPAIR_TIMEOUT_MS || '10000', 10), 20000));
const LITE_ENABLE_REPAIR = process.env.SCOUT_LITE_ENABLE_REPAIR !== 'false';
const LITE_NUM_CTX = parseInt(process.env.SCOUT_LITE_NUM_CTX || '1024', 10);
const LITE_NUM_PREDICT = parseInt(process.env.SCOUT_LITE_NUM_PREDICT || '120', 10);

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
// Resolves references ("that", "it", "the backend") using server-owned session
// state. Rewrites the question so Ollama doesn't need to do coreference resolution.

function rewriteQuery(question, state) {
  if (!state) return { rewritten: question, rewritten_: false };
  const q = String(question || '').trim();
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

  // "Does he know X?" with active job -> "Does he know X for the {job} role?"
  // (Keep it simple — don't over-rewrite)

  return { rewritten: q, rewritten_: false };
}

// --- Pre-Router ---
// Deterministically selects which tool to execute based on query understanding.
// Falls back to search_portfolio for ambiguous cases.

function preRoute(question, state, knowledge) {
  const q = String(question || '').toLowerCase();
  const refs = resolveReferents(state);

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

  // Skill evidence: "does he know X", "has he used X", "evidence for X"
  const skillMatch = q.match(/\b(?:does|has|know|used|use|using|experience with|evidence (?:for|of))\b.*\b([a-z][a-z0-9+#.]{1,20})\b/i);
  if (skillMatch) {
    const skill = extractSkill(question);
    if (skill) {
      return { operation: 'skill', tool: 'get_skill_evidence', args: { skill } };
    }
  }

  // Job fit: "how does he fit", "does he fit this job", pasted job description
  if (/\b(?:fit|role|position|hire|candidate|job description|requirements|qualifications)\b/i.test(q) || q.length > 150) {
    if (q.length > 100 || /\bjob\b|requirements|qualifications/i.test(q)) {
      return { operation: 'job', tool: 'match_role', args: { role: '', jobDescription: String(question || '').slice(0, 500) } };
    }
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
function extractSkill(question) {
  const q = String(question || '');
  // Common tech skills to check for
  const skills = [
    'DynamoDB', 'React', 'JavaScript', 'TypeScript', 'Node.js', 'Node',
    'Python', 'AWS', 'Lambda', 'S3', 'Docker', 'Kubernetes', 'HTML', 'CSS',
    'SQL', 'MongoDB', 'PostgreSQL', 'GraphQL', 'REST', 'API', 'Linux',
    'Git', 'Caddy', 'GCP', 'Azure', 'FastAPI', 'Next.js', 'WebGPU'
  ];
  const lower = q.toLowerCase();
  for (const skill of skills) {
    if (lower.includes(skill.toLowerCase())) return skill;
  }
  // Extract from "know X" / "used X" patterns
  const m = q.match(/\b(?:know|used|use|using|experience with)\s+([A-Za-z][A-Za-z0-9+#.]{1,20})\b/i);
  return m ? m[1] : null;
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
      } else if (d.description) {
        text = d.description;
      } else if (d.summary) {
        text = d.summary;
      } else if (d.items?.length) {
        text = `${d.type || 'evidence'}: ${d.items.join(', ')}`;
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

  // Gaps — what doesn't fit
  if (result.gaps?.length) {
    lines.push(`GAPS: ${result.gaps.slice(0, 3).map(g => g.skill).join('; ')}.`);
  } else if (result.honestGaps?.length) {
    lines.push(`GAPS: ${result.honestGaps.slice(0, 3).map(g => truncate(g, 60)).join('; ')}.`);
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
    lines.push(`GAPS: ${result.honestGaps.slice(0, 2).map(g => truncate(g, 50)).join('; ')}.`);
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
    if (data.whoIAm) lines.push(`- ${truncate(data.whoIAm, 150)}`);
    if (data.whatIDo) lines.push(`- ${truncate(data.whatIDo, 120)}`);
    if (data.whatIAmLookingFor) lines.push(`- ${truncate(data.whatIAmLookingFor, 100)}`);
    if (data.coreStrengths?.length) lines.push(`Strengths: ${data.coreStrengths.slice(0, 4).join(', ')}.`);
    if (data.honestGaps?.length) lines.push(`Gaps: ${data.honestGaps.slice(0, 2).map(g => truncate(g, 60)).join('; ')}.`);
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
      return true;
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

function buildLitePacket({ question, compressedEvidence, operation, maxTokens, structuredFacts, plan, planText, adversarialCaveat }) {
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
  if (adversarialCaveat || (plan && planIntents.has(plan.intent))) {
    const constraints = [];
    if (adversarialCaveat) {
      constraints.push(`DIRECT_ANSWER: no`);
      constraints.push(`REFUTE: Refute the claim directly with No in a full sentence. ${adversarialCaveat}`);
    } else if (plan && plan.directAnswer) {
      constraints.push(`DIRECT_ANSWER: ${plan.directAnswer}`);
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

  // Conversational system prompt that allows natural synthesis
  // while maintaining factual grounding and relationship correctness.
  const system = [
    `You are Scout, an AI assistant for ${scoutIdentity.getSubjectName()}.`,
    `You are NOT ${scoutIdentity.getSubjectName()}. You are a helpful assistant talking ABOUT him.`,
    'Answer directly first, then add useful detail. Write 1-2 complete, natural sentences.',
    'Do NOT output single-word answers like "No." or "Yes.". ALWAYS state the facts in 1-2 complete sentences.',
    'Use specific evidence from FACTS — do not give generic answers.',
    'Synthesize from facts — do not copy them verbatim.',
    '',
    'CRITICAL RULES (violations cause rejection):',
    '- ONLY connect entities that FACTS explicitly connect. Do NOT combine facts from different projects/experiences.',
    '- If FACTS say "Project X uses Tech Y", you may say that. Do NOT say "Project Z uses Tech Y" unless FACTS say so.',
    '- Do NOT use inflation language like "extensive experience", "expertise in", "specializing in", "adept at", "proficient in", "expert". He is an entry-level developer; use "has experience with" or "built".',
    '- Do NOT invent technologies or companies (e.g. no Prometheus, Grafana, DSA, Udemy). Only use named entities in FACTS.',
    '- Do NOT say a project was built at a company unless FACTS explicitly state that connection.',
    '- If a claim is not in FACTS, say No and correct it in a full sentence. Intern ≠ production.',
    '- No "as an AI", "based on the information", or "would you like" — just answer.',
    '- NEVER confirm a claim that is not explicitly in FACTS.',
    '- NEVER say "I", "my", "me", "my work", "my experience", "my projects" when talking about the subject.',
    '- ALWAYS say "he", "his", "him", "his work", "his experience", "his projects" when talking about the subject.',
    '- "I can explain that" or "I think" is OK (assistant action). "I built" or "my work" is NOT OK (subject claim).',
    '- Respect EVIDENCE labels. Do not upgrade PROJECT_ONLY to "professional experience".',
    '',
    'Example: Q: "Does he know DynamoDB?" A: "Yes. His AWS internship capstone used DynamoDB as part of a serverless metadata workflow with Lambda, S3, and Amplify."',
    'Example: Q: "Was he senior?" A: "No. He was a Cloud Support Engineer Intern, not a senior engineer."',
    'Example: Q: "Did ProjectHub use React?" A: "No. ProjectHub uses JavaScript, Node.js, and Express. React is in his skills but not listed in ProjectHub."',
    '',
    planConstraints ? '=== ANSWER GUIDE ===' : '',
    planConstraints ? truncate(planConstraints, 250) : '',
    planConstraints ? '' : '',
    structuredFacts ? 'RELATIONSHIPS (verified connections — use ONLY these):' : '',
    structuredFacts ? truncate(structuredFacts, 350) : '',
    structuredFacts ? '' : '',
    `FACTS:`,
    truncate(compressedEvidence, systemBudget - 600 - (planConstraints ? 250 : 0) - (structuredFacts ? 400 : 0))
  ].filter(line => line !== undefined).join('\n');

  const user = `Q: ${truncate(question, userBudget - 40)}\nReturn JSON: {"answer":"<your answer>"}`;

  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: Math.ceil((system.length + user.length) / 4)
  };
}

function buildCompletenessRepairPacket({ question, currentAnswer, compressedEvidence, reason, intent, maxTokens, planText }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4;

  const intentGuidance = {
    YES_NO: 'Start with Yes/No in 1-2 complete sentences. Example: "Yes. React is part of his verified skill set and appears in his web development work."',
    SKILL: 'Start with Yes/No, then state the project or experience where this skill was used in 1-2 complete sentences.',
    ADVERSARIAL: 'Start with No in a complete sentence, then state what IS true from FACTS. Example: "No. He has not worked at Google. His experience includes an AWS Cloud Support Engineer Internship."',
    PROFILE: 'Give a 1-2 sentence summary with 2-3 specific details from FACTS. Example: "He is an entry-level developer with skills in JavaScript, React, and Node.js. His projects include ProjectHub and an AWS serverless capstone."',
    PROJECT: 'Describe what it is, what it does, and 1-2 key technologies from FACTS in 1-2 complete sentences.',
    COMPARISON: 'Mention both projects and one meaningful difference using facts from FACTS in 1-2 complete sentences.',
    JOB_FIT: 'State the match in 1-2 complete sentences using specific facts from FACTS. Avoid words like "extensive" or "expertise".',
    RECRUITER: 'Give a 1-2 sentence summary with 2-3 specific facts from FACTS. Example: "He is an entry-level developer with an AWS internship, React skills, and a recruiter AI project."',
    OPINION: 'State your opinion in 1-2 complete sentences supported by specific facts from FACTS.',
    FOLLOW_UP: 'Answer the follow-up question directly in 1-2 complete sentences using facts from FACTS.',
    GENERAL: 'Write 1-2 complete, specific sentences using facts from FACTS. Do NOT use single-word answers.'
  };

  const guidance = intentGuidance[intent] || intentGuidance.GENERAL;

  // If we have a response plan, use it to guide the repair
  if (planText) {
    const system = [
      'Expand the answer to be more complete and useful.',
      `The current answer is too brief. ${guidance}`,
      '',
      `CURRENT ANSWER: ${truncate(currentAnswer, 200)}`,
      '',
      '=== RESPONSE PLAN (use this to expand) ===',
      truncate(planText, budget - 600),
      '',
      'Rules: Keep all relationships exact. Do not invent facts. Do not use overclaim language.',
      'Write at least 15 words. Be specific, not generic. Use ONLY entities from the plan.',
      'Return JSON: {"answer":"<expanded answer>"}'
    ].join('\n');

    const user = `Q: ${truncate(question, 200)}`;
    return {
      systemPrompt: system,
      userPrompt: user,
      estimatedTokens: Math.ceil((system.length + user.length) / 4)
    };
  }

  const system = [
    'Expand the answer to be more complete and useful.',
    `The current answer is too brief. ${guidance}`,
    '',
    `CURRENT ANSWER: ${truncate(currentAnswer, 200)}`,
    '',
    'FACTS:',
    truncate(compressedEvidence, budget - 500),
    '',
    'Rules: Keep all relationships exact. Do not invent facts. Do not use overclaim language.',
    'Write at least 15 words. Be specific, not generic.',
    'Return JSON: {"answer":"<expanded answer>"}'
  ].join('\n');

  const user = `Q: ${truncate(question, 200)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: Math.ceil((system.length + user.length) / 4)
  };
}

function buildLiteRepairPacket({ question, compressedEvidence, rejectionDetails, maxTokens, knowledge, validation, graph }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4;
  const reasons = (rejectionDetails || []).slice(0, 3).map(r => r.detail || r.reason).join('; ');

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
    'FACTS:',
    truncate(compressedEvidence, budget - 400 - repairContext.length),
    '',
    'Return JSON: {"answer":"<text>"}'
  ].join('\n');
  const user = `Q: ${truncate(question, 200)}`;
  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: Math.ceil((system.length + user.length) / 4)
  };
}

// --- Lite Agent Loop ---

async function runLiteAgent({ question, conversationState, evidence, knowledge, sessionId, model }) {
  const startedAt = Date.now();
  const selectedModel = model || router.agentModel();
  const events = [];
  let contextTokens = 0;

  function emit(type, data) {
    events.push({ ts: Date.now() - startedAt, type, ...data });
  }

  emit('lite_start', { model: selectedModel });

  // 1. Rewrite query (resolve references using session state)
  const { rewritten, rewritten_ } = rewriteQuery(question, conversationState);
  emit('lite_rewrite', { rewritten, changed: rewritten_ });

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
  const adversarialCaveat = detectAdversarialCaveat(rewritten, compressed);
  if (adversarialCaveat) {
    compressed = compressed + '\n' + adversarialCaveat;
  }

  emit('lite_compress', { compressedChars: compressed.length, adversarial: !!adversarialCaveat });

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

  const packet = buildLitePacket({
    question: rewritten,
    compressedEvidence: compressed,
    operation: route.operation,
    maxTokens: LITE_MAX_TOKENS,
    structuredFacts,
    plan,
    planText,
    adversarialCaveat
  });
  contextTokens = packet.estimatedTokens;
  emit('lite_packet', { tokens: packet.estimatedTokens, chars: packet.systemPrompt.length + packet.userPrompt.length, hasPlan: !!planText });

  // 6. Single Ollama generation
  emit('lite_generate_call');
  const genResult = await router.generate(selectedModel, [
    { role: 'system', content: packet.systemPrompt },
    { role: 'user', content: packet.userPrompt }
  ], {
    timeoutMs: LITE_TIMEOUT_MS,
    temperature: 0.25,
    topP: 0.9,
    numPredict: LITE_NUM_PREDICT,
    numCtx: LITE_NUM_CTX,
    format: 'json'
  });

  if (!genResult.ok) {
    emit('lite_generate_error', { error: genResult.error, latencyMs: genResult.latencyMs });
    return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
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
    emit('lite_generate_short', { latencyMs: genResult.latencyMs });
    return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
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
    emit('lite_forbidden_claim', { answer: answer.slice(0, 80) });
    return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
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
      emit('lite_adversarial_confirmation', { answer: answer.slice(0, 80) });
      return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
    }
  }

  // 7. Validation (same validator as FULL mode, now with relationship-aware grounding)
  const sourceText = compressed + ' ' + JSON.stringify(toolResult).slice(0, 2000);
  const stateHistory = conversationState?.recentTurns || conversationState?.history || [];
  const reqGraph = knowledge ? buildRelationshipGraph(knowledge) : null;
  const validation = validateAnswer(answer, sourceText, rewritten, knowledge, stateHistory, reqGraph);
  emit('lite_validation', { verdict: validation.verdict, reasons: validation.reasons, validatedAnswer: answer.slice(0, 400) });

  if (validation.valid) {
    // 7b. Completeness check — is the answer conversationally sufficient?
    const completeness = evaluateCompleteness(answer, rewritten, evidence);

    if (!completeness.complete && LITE_ENABLE_REPAIR) {
      // Attempt ONE completeness repair — expand the terse answer with evidence
      emit('lite_completeness_repair_call', { reason: completeness.reason, intent: completeness.intent });

      const completenessPacket = buildCompletenessRepairPacket({
        question: rewritten,
        currentAnswer: answer,
        compressedEvidence: compressed,
        reason: completeness.reason,
        intent: completeness.intent,
        maxTokens: LITE_MAX_TOKENS,
        planText
      });

      const compRepairResult = await router.generate(selectedModel, [
        { role: 'system', content: completenessPacket.systemPrompt },
        { role: 'user', content: completenessPacket.userPrompt }
      ], {
        timeoutMs: LITE_REPAIR_TIMEOUT_MS,
        temperature: 0.2,
        topP: 0.85,
        numPredict: LITE_NUM_PREDICT,
        numCtx: LITE_NUM_CTX,
        format: 'json'
      });

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
          // Validate the expanded answer with the same strict validator
          const compSentences = extractCompleteSentences(compAnswer, 2);
          if (compSentences && compSentences.length >= 20) compAnswer = compSentences;

          const compValidation = validateAnswer(compAnswer, sourceText, rewritten, knowledge, stateHistory, reqGraph);
          emit('lite_completeness_repair_result', {
            verdict: compValidation.verdict,
            latencyMs: compRepairResult.latencyMs,
            rawAnswer: compAnswer.slice(0, 300),
            reasons: compValidation.reasons
          });

          if (compValidation.valid) {
            // Check if the expanded answer is actually more complete
            const compCompleteness = evaluateCompleteness(compAnswer, rewritten, evidence);
            if (compCompleteness.complete || compAnswer.length > answer.length * 1.3) {
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
                rewrittenQuery: rewritten
              };
            }
          }
        }
      }
      // If completeness repair failed, return the original valid answer
      emit('lite_complete', { outcome: 'accepted', totalMs: Date.now() - startedAt, completenessReason: completeness.reason });
    } else {
      emit('lite_complete', { outcome: 'accepted', totalMs: Date.now() - startedAt });
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
      rewrittenQuery: rewritten
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
      graph: knowledge ? buildRelationshipGraph(knowledge) : null
    });
    emit('lite_repair_call', { tokens: repairPacket.estimatedTokens });

    const repairResult = await router.generate(selectedModel, [
      { role: 'system', content: repairPacket.systemPrompt },
      { role: 'user', content: repairPacket.userPrompt }
    ], {
      timeoutMs: LITE_REPAIR_TIMEOUT_MS,
      temperature: 0.15,
      topP: 0.85,
      numPredict: LITE_NUM_PREDICT,
      numCtx: LITE_NUM_CTX,
      format: 'json'
    });

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
          emit('lite_repair_forbidden', { answer: repairAnswer.slice(0, 80) });
          return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
        }
        const repairSentences = extractCompleteSentences(repairAnswer, 2);
        if (repairSentences && repairSentences.length >= 20) repairAnswer = repairSentences;

        const repairValidation = validateAnswer(repairAnswer, sourceText, rewritten, knowledge, stateHistory, reqGraph);
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
            rewrittenQuery: rewritten
          };
        }
      }
    }
  }

  // 9. Deterministic fallback
  emit('lite_fallback', { reason: 'validation_failed', totalMs: Date.now() - startedAt });
  return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
}

function makeFallback(events, contextTokens, startedAt, model, route, rewritten_) {
  return {
    reply: '',
    provider: 'ollama-lite',
    model,
    steps: [{ type: 'lite_fallback' }],
    toolResults: [{ tool: route.tool, result: null }],
    events,
    contextTokens,
    latencyMs: Date.now() - startedAt,
    fallback: true,
    outcome: 'fallback',
    validation: null,
    operation: route.operation,
    rewritten: rewritten_,
    rewrittenQuery: null
  };
}

module.exports = {
  runLiteAgent,
  rewriteQuery,
  preRoute,
  compressToolResult,
  buildLitePacket,
  buildLiteRepairPacket,
  detectAdversarialCaveat,
  LITE_MAX_TOKENS,
  LITE_TIMEOUT_MS
};
