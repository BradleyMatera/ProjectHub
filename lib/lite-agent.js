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

// --- Configuration ---

const LITE_MAX_TOKENS = parseInt(process.env.SCOUT_LITE_MAX_TOKENS || '220', 10);
const LITE_TIMEOUT_MS = Math.max(3000, Math.min(parseInt(process.env.SCOUT_LITE_TIMEOUT_MS || '15000', 10), 30000));
const LITE_REPAIR_TIMEOUT_MS = Math.max(2000, Math.min(parseInt(process.env.SCOUT_LITE_REPAIR_TIMEOUT_MS || '10000', 10), 20000));
const LITE_ENABLE_REPAIR = process.env.SCOUT_LITE_ENABLE_REPAIR !== 'false';
const LITE_NUM_CTX = parseInt(process.env.SCOUT_LITE_NUM_CTX || '512', 10);
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
  ai_slop: 'Remove generic AI phrases. Be specific and factual.'
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
  lines.push(`Bradley ${skill} evidence: ${evidence}.`);

  if (result.details?.length) {
    for (const d of result.details.slice(0, 4)) {
      // Extract the most useful text from the detail object
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
      if (text) lines.push(`- ${truncate(text, 120)}`);
    }
  }
  if (result.note) lines.push(`- ${truncate(result.note, 100)}`);
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
  if (result.role) lines.push(`ROLE: ${truncate(result.role, 80)}`);
  if (result.matchedSkills?.length) {
    lines.push(`MATCH: ${result.matchedSkills.slice(0, 6).join(', ')}.`);
  }
  if (result.projectEvidence?.length) {
    const projs = result.projectEvidence.slice(0, 3).map(p => {
      const tech = (p.tech || []).slice(0, 3).join('/');
      return `${p.name}(${tech})`;
    });
    lines.push(`PROJECTS: ${projs.join('; ')}.`);
  }
  if (result.experienceEvidence?.length) {
    const exps = result.experienceEvidence.slice(0, 2).map(e =>
      `${e.role} at ${e.company}${e.matchingSkills?.length ? ` (${e.matchingSkills.slice(0, 2).join(', ')})` : ''}`
    );
    lines.push(`EXPERIENCE: ${exps.join('; ')}.`);
  }
  if (result.honestGaps?.length) {
    lines.push(`GAPS: ${result.honestGaps.slice(0, 3).map(g => truncate(g, 60)).join('; ')}.`);
  }
  if (result.assessmentRule) lines.push(`NOTE: ${truncate(result.assessmentRule, 80)}`);
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
    if (pattern.re.test(t) && !pattern.except.test(t)) {
      return true;
    }
  }
  return false;
}

// --- Lite Packet Builder ---
// Builds a tiny system+user prompt for Ollama. Target: 150-250 tokens.

function buildLitePacket({ question, compressedEvidence, operation, maxTokens }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4; // chars per token estimate
  const systemBudget = Math.floor(budget * 0.75);
  const userBudget = Math.floor(budget * 0.25);

  // Ultra-compact system prompt for e2-micro (target: 80-120 tokens)
  // The full rules are compressed to the essentials
  const system = [
    'You are Scout for Bradley Matera.',
    'Answer from FACTS only. 1-2 sentences. Never invent.',
    'If claim not in FACTS, say No. Intern ≠ production.',
    'Return JSON: {"answer":"<text>"}',
    '',
    `FACTS:`,
    truncate(compressedEvidence, systemBudget - 130)
  ].join('\n');

  const user = `Q: ${truncate(question, userBudget - 10)}`;

  return {
    systemPrompt: system,
    userPrompt: user,
    estimatedTokens: Math.ceil((system.length + user.length) / 4)
  };
}

function buildLiteRepairPacket({ question, compressedEvidence, rejectionDetails, maxTokens }) {
  const budget = (maxTokens || LITE_MAX_TOKENS) * 4;
  const reasons = (rejectionDetails || []).slice(0, 2).map(r => r.detail || r.reason).join('; ');
  const system = [
    'Fix the answer. Use ONLY FACTS. Never confirm claims not in FACTS.',
    'Issues: ' + reasons,
    '',
    'FACTS:',
    truncate(compressedEvidence, budget - 200),
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

  // 5. Build lite packet
  const packet = buildLitePacket({
    question: rewritten,
    compressedEvidence: compressed,
    operation: route.operation,
    maxTokens: LITE_MAX_TOKENS
  });
  contextTokens = packet.estimatedTokens;
  emit('lite_packet', { tokens: packet.estimatedTokens, chars: packet.systemPrompt.length + packet.userPrompt.length });

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

  emit('lite_generate_ok', { latencyMs: genResult.latencyMs, answerLen: answer.length });

  // 6b. Adversarial safety check: if the question triggers an adversarial caveat
  // and the answer contains forbidden claim words without negation, skip repair
  // and go straight to fallback. The 0.5b model sometimes agrees with false claims
  // despite caveats, and repair makes it worse.
  if (adversarialCaveat && containsForbiddenClaim(answer)) {
    emit('lite_forbidden_claim', { answer: answer.slice(0, 80) });
    return makeFallback(events, contextTokens, startedAt, selectedModel, route, rewritten_);
  }

  // 7. Validation (same validator as FULL mode)
  const sourceText = compressed + ' ' + JSON.stringify(toolResult).slice(0, 2000);
  const validation = validateAnswer(answer, sourceText, rewritten);
  emit('lite_validation', { verdict: validation.verdict, reasons: validation.reasons });

  if (validation.valid) {
    emit('lite_complete', { outcome: 'accepted', totalMs: Date.now() - startedAt });
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
    const repairDetails = validation.reasons.map(r => ({
      reason: r,
      detail: REPAIR_HINTS[r] || r
    }));
    const repairPacket = buildLiteRepairPacket({
      question: rewritten,
      compressedEvidence: compressed,
      rejectionDetails: repairDetails
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

        const repairValidation = validateAnswer(repairAnswer, sourceText, rewritten);
        emit('lite_repair_result', { verdict: repairValidation.verdict, latencyMs: repairResult.latencyMs });

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
