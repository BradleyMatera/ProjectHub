'use strict';

const knowledgeAccess = require('./knowledge-access');

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_portfolio',
      description: 'Search the candidate\'s verified projects, experience, skills, and certifications for evidence relevant to a recruiter question.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The skills, project, or experience evidence to find.' },
          limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum results to return.' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_project',
      description: 'Get verified details for one named project.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name or an unambiguous part of it.' }
        },
        required: ['name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compare_projects',
      description: 'Compare two to four verified projects by purpose, technology, category, and public URL.',
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 4,
            description: 'Project names to compare.'
          }
        },
        required: ['names'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'match_role',
      description: 'Match a role or pasted job description against the candidate\'s verified skills, experience, projects, and honest gaps.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Role title or short label.' },
          jobDescription: { type: 'string', description: 'Job requirements or description to assess.' }
        },
        required: ['jobDescription'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_candidate_profile',
      description: 'Get a verified candidate profile section without exposing private or sensitive data.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['summary', 'skills', 'experience', 'education', 'certifications', 'goals'],
            description: 'Profile section to retrieve.'
          }
        },
        required: ['section'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_skill_evidence',
      description: 'Get verified evidence for whether the candidate knows or has used a specific technology or skill. Returns direct evidence, project evidence, work evidence, certification evidence, adjacent evidence, or unknown. Use this when asked "does he know X?" or "has he used X?"',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'The technology or skill to find evidence for (e.g. AWS, React, DynamoDB, JavaScript).' }
        },
        required: ['skill'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'build_recruiter_brief',
      description: 'Assemble a structured recruiter-facing candidate brief from verified data. Use when asked for a summary, brief, or overview for a hiring manager or recruiter.',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Optional focus area (e.g. "AWS", "frontend", "backend"). If omitted, returns a general brief.' }
        },
        required: [],
        additionalProperties: false
      }
    }
  }
];

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
}

function words(value) {
  return new Set(normalized(value).split(/\s+/).filter(word => word.length > 1));
}

function humanizeIdentifier(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function skillItemText(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const label = item.label || item.name || item.skill || item.title || '';
  const summary = item.summary || item.description || item.detail || '';
  if (label && summary) return `${label}: ${summary}`;
  return String(label || summary || '').trim();
}

function skillItemName(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  return String(item.label || item.name || item.skill || item.title || '').trim();
}

function publicProject(project) {
  return {
    name: project.name || '',
    description: project.description || '',
    category: project.category || '',
    tech: Array.isArray(project.tech) ? project.tech.slice(0, 12) : [],
    url: project.url || null,
    repo: project.repo || null,
    platform: project.platform || null,
    deploymentUrl: project.deploymentUrl || project.url || null
  };
}

function findProject(knowledge, name) {
  const projects = Array.isArray(knowledge?.projects) ? knowledge.projects : [];
  const target = normalized(name);
  if (!target) return null;
  return projects.find(project => normalized(project.name) === target)
    || projects.find(project => normalized(project.name).includes(target) || target.includes(normalized(project.name)))
    || null;
}

function buildSearchRecords(knowledge) {
  const records = [];
  for (const project of knowledge?.projects || []) {
    const linkText = [project.url, project.repo, project.deploymentUrl, project.platform]
      .filter(Boolean)
      .join(' ');
    records.push({ kind: 'project', title: project.name, text: `${project.description || ''} ${(project.tech || []).join(' ')} ${project.category || ''} ${linkText}`, data: publicProject(project) });
  }
  for (const item of knowledge?.experience || []) {
    const data = {
      role: item.role || '', company: item.company || '', dates: item.dates || '',
      summary: item.summary || '', responsibilities: (item.responsibilities || []).slice(0, 5),
      skills: (item.skills || []).slice(0, 12)
    };
    records.push({ kind: 'experience', title: `${item.role || ''} at ${item.company || ''}`, text: JSON.stringify(data), data });
  }
  for (const [group, values] of Object.entries(knowledge?.skills || {})) {
    if (!Array.isArray(values)) continue;
    const serialized = values.map(skillItemText).filter(Boolean);
    if (serialized.length === 0) continue;
    records.push({
      kind: 'skills',
      title: humanizeIdentifier(group),
      text: serialized.join(' '),
      data: { group, skills: serialized.slice(0, 20) }
    });
  }
  for (const certification of knowledge?.certifications || []) {
    records.push({ kind: 'certification', title: certification.name || 'Certification', text: JSON.stringify(certification), data: certification });
  }
  return records;
}

function searchPortfolio(knowledge, args) {
  const queryWords = words(String(args.query || '').slice(0, 500));
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 5));
  if (queryWords.size === 0) return { query: '', results: [] };
  const ranked = buildSearchRecords(knowledge).map(record => {
    const haystack = normalized(`${record.title} ${record.text}`);
    let score = 0;
    for (const word of queryWords) {
      if (haystack.includes(word)) score += haystack.startsWith(word) ? 3 : 1;
    }
    return { record, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return { query: String(args.query || '').slice(0, 500), results: ranked.slice(0, limit).map(item => ({ ...item.record.data, kind: item.record.kind, evidenceScore: item.score })) };
}

// Words that carry no criterion meaning: English function words plus generic
// request/requirement syntax (a job-request frame, not a domain ontology).
// Domain vocabulary (frontend, cloud, devops, data, ...) is deliberately NOT
// listed — whether a domain word is a criterion is decided by whether the
// user supplied it in a requirement clause, never by a vocabulary list.
const REQUEST_SYNTAX_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'have',
  'has', 'had', 'having', 'do', 'does', 'did', 'done', 'will', 'would', 'can',
  'could', 'shall', 'should', 'may', 'might', 'must', 'not', 'no', 'etc',
  'such', 'like', 'including', 'plus', 'minimum', 'least', 'year', 'years',
  'yrs', 'experience', 'experienced', 'knowledge', 'proficiency', 'proficient',
  'familiarity', 'familiar', 'ability', 'able', 'strong', 'solid', 'good',
  'excellent', 'working', 'hands', 'preferred', 'nice', 'bonus', 'required',
  'requirements', 'requirement', 'requires', 'require', 'requiring', 'needs',
  'need', 'skills', 'skill', 'proven', 'demonstrated', 'deep', 'understanding',
  'exposure', 'background', 'you', 'your', 'they', 'them', 'their', 'he',
  'his', 'him', 'she', 'her', 'it', 'its', 'this', 'that', 'these', 'those',
  'there', 'here', 'what', 'when', 'where', 'which', 'who', 'how', 'about',
  'into', 'onto', 'upon', 'within', 'without', 'because', 'since', 'however',
  'therefore', 'moreover', 'additionally', 'furthermore', 'nevertheless',
  'nonetheless', 'one', 'type', 'kind', 'sort', 'best', 'worst', 'most',
  'more', 'better', 'worse', 'think', 'believe', 'opinion', 'recommend',
  'recommendation', 'suggest', 'suggestion', 'honest', 'thing', 'tell', 'bet',
  'succeed', 'succeeding', 'success', 'fit', 'fits', 'fitting', 'work', 'team',
  'role', 'roles', 'position', 'positions', 'job', 'jobs', 'candidate',
  'apply', 'applied', 'applying', 'hire', 'hiring', 'open', 'opening', 'null',
  'if', 'any',
  'all', 'both', 'each', 'few', 'other', 'some', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'only', 'now', 'then', 'once', 'again', 'also',
]);

// Explicit criteria are only the terms a user actually supplied: slash-joined
// terms, clauses following a requirement marker, or a skill name written
// verbatim. A requested role title never contributes criteria — it is context.
const REQUIREMENT_MARKER = /\b(?:requiring|requires?|needs?|must\s+(?:have|know)|looking\s+for|seeking|experience\s+(?:with|in)|proficiency\s+(?:with|in)|familiar(?:ity)?\s+with|skilled\s+(?:with|in)|knowledge\s+of|expertise\s+(?:in|with)|(?:job\s+)?requirements?|qualifications?|job\s+description|positions?|postings?)\b\s*:?/gi;

function extractExplicitCriteria(rawDesc, knownSkills, role) {
  const criteria = [];
  const add = term => {
    const t = String(term || '').trim();
    if (t && !criteria.some(c => normalized(c) === normalized(t))) criteria.push(t);
  };

  for (const term of rawDesc.match(/\b[A-Za-z]+\/[A-Za-z]+(?:\/[A-Za-z]+)*\b/g) || []) add(term);

  REQUIREMENT_MARKER.lastIndex = 0;
  let m;
  while ((m = REQUIREMENT_MARKER.exec(rawDesc)) !== null) {
    const clause = rawDesc.slice(m.index + m[0].length).split(/[.!?;\n]/)[0];
    for (const chunk of clause.split(/,|\s+and\s+|\s+or\s+/)) {
      const kept = normalized(chunk).split(/\s+/)
        .filter(w => w && !REQUEST_SYNTAX_WORDS.has(w) && !/^\d+\+?$/.test(w));
      if (kept.length) add(kept.join(' '));
    }
  }

  // A skill name written verbatim is an explicit criterion — unless it only
  // appears inside the requested role title. A role title is context, so
  // strip the title span before scanning for verbatim skill mentions.
  let criteriaText = ` ${normalized(rawDesc)} `;
  if (role) criteriaText = criteriaText.replace(normalized(role), ' ');
  criteriaText = criteriaText.replace(/\b(?:a|an|the|our|this|that|for|as)\s+[a-z0-9+#.-]+(?:\s+[a-z0-9+#.-]+){0,4}\s+(?:role|position|job)\b/g, ' role ');
  for (const skill of knownSkills) {
    const s = normalized(skill);
    if (s.length >= 2 && criteriaText.includes(s)) add(skill);
  }

  return criteria;
}

function matchRole(knowledge, args) {
  const description = String(args.jobDescription || '').slice(0, 4000);
  const role = String(args.role || '').slice(0, 120) || null;
  const rawDesc = String(args.jobDescription || args.role || '').slice(0, 4000);
  const skillValues = Object.values(knowledge?.skills || {}).flatMap(value => Array.isArray(value) ? value.map(skillItemName).filter(Boolean) : []);
  const projectTech = (knowledge?.projects || []).flatMap(project => project.tech || []);
  const knownSkills = [...new Set([...skillValues, ...projectTech])];

  const explicitCriteria = extractExplicitCriteria(rawDesc, knownSkills, role);

  const skillOverlaps = (skill, term) => {
    const s = normalized(skill);
    const t = normalized(term);
    return s === t || s.includes(t) || t.includes(s);
  };

  // Tenant skills named inside an explicit criterion are requirements;
  // tenant skills that merely share a word with the request are context —
  // they surface as relevant evidence but are never reported as requirements.
  const criteriaSkills = knownSkills.filter(skill =>
    explicitCriteria.some(c => skillOverlaps(skill, c))
  );
  const requestWords = normalized(rawDesc).split(/[\s,;.|/()-]+/)
    .filter(w => w.length >= 2 && !REQUEST_SYNTAX_WORDS.has(w));
  const contextMatches = knownSkills.filter(skill => {
    if (criteriaSkills.includes(skill)) return false;
    const s = normalized(skill);
    return requestWords.some(w => s === w || s.includes(w) || w.includes(s));
  });
  const matchedSkills = [...new Set([...criteriaSkills, ...contextMatches])].slice(0, 15);

  // Required terms are exactly the user-supplied criteria — nothing inferred
  // from the role title or from domain vocabulary.
  const requiredTerms = explicitCriteria;

  // Classify evidence strength for each matched skill
  const strong = [];
  const partial = [];
  const gaps = [];

  for (const skill of matchedSkills) {
    const skillNorm = normalized(skill);
    const inExperience = (knowledge?.experience || []).some(item => (item.skills || []).some(s => normalized(s) === skillNorm));
    const inProject = (knowledge?.projects || []).some(p => (p.tech || []).some(t => normalized(t) === skillNorm));
    const inCert = (knowledge?.certifications || []).some(c => normalized(c.name || c).includes(skillNorm));
    const inDirectSkills = skillValues.some(s => normalized(s) === skillNorm);

    if (inExperience && inProject) {
      strong.push({
        skill,
        evidence: 'DIRECT_MATCH',
        detail: 'Used in work experience and projects'
      });
    } else if (inExperience || inProject || inCert || inDirectSkills) {
      const evidence = inExperience ? 'EXPERIENCE_BASED' :
        (inProject ? 'PROJECT_BASED' : (inCert ? 'CERTIFICATION_BASED' : 'DIRECT_LISTING'));
      const detail = inExperience ? 'Used in work experience' :
        (inProject ? 'Used in projects' : (inCert ? 'Has certification' : 'Listed in verified skills'));
      partial.push({ skill, evidence, detail });
    }
  }

  // Identify gaps — only against user-supplied explicit criteria. A role
  // title can never manufacture a gap; context matches are evidence, not
  // requirements.
  for (const term of requiredTerms) {
    const termNorm = normalized(term);
    if (termNorm.length < 4 && !termNorm.includes('/')) continue;
    const isKnown = knownSkills.some(s => normalized(s).includes(termNorm) || termNorm.includes(normalized(s)));
    if (!isKnown && !gaps.find(g => normalized(g.skill) === termNorm)) {
      gaps.push({ skill: term, evidence: 'UNKNOWN', detail: 'No verified experience with this skill' });
    }
  }

  const projectEvidence = (knowledge?.projects || []).filter(project => (project.tech || []).some(skill => matchedSkills.includes(skill))).slice(0, 5).map(publicProject);
  const experienceEvidence = (knowledge?.experience || []).filter(item => (item.skills || []).some(skill => matchedSkills.includes(skill))).slice(0, 4).map(item => ({ role: item.role, company: item.company, summary: item.summary, matchingSkills: (item.skills || []).filter(skill => matchedSkills.includes(skill)) }));

  return {
    role,
    requestedRole: role,
    explicitCriteria: explicitCriteria.slice(0, 12),
    contextMatches: contextMatches.slice(0, 10),
    matchedSkills,
    strong: strong.slice(0, 6),
    partial: partial.slice(0, 6),
    gaps: gaps.slice(0, 5),
    projectEvidence,
    experienceEvidence,
    assessmentRule: 'Treat this as evidence matching, not a hiring recommendation. The requested role is context, not a requirements list: only criteria the user explicitly supplied become requirements or gaps. Distinguish DIRECT_MATCH from ADJACENT from GAP. Do not claim unstated experience. Do not infer exact role requirements that were not supplied. Do not treat candidate summary gaps as job-specific gaps unless the user explicitly asked about them.',
    honestGaps: []
  };
}

// get_skill_evidence: deterministically retrieve verified evidence for a
// requested technology or skill. Distinguishes direct, project, work,
// certification, adjacent, and unknown evidence.
function getSkillEvidence(knowledge, args) {
  const skill = normalized(String(args.skill || '').slice(0, 120));
  if (!skill) return { skill: '', evidence: 'unknown', details: [] };

  // Normalize common aliases
  const ALIASES = {
    'js': 'javascript', 'node': 'node.js', 'nodejs': 'node.js',
    'ts': 'typescript', 'reactjs': 'react', 'vuejs': 'vue',
    'aws lambda': 'lambda', 'amazon web services': 'aws',
    'amazon dynamodb': 'dynamodb', 'amazon s3': 's3',
  };
  const target = ALIASES[skill] || skill;
  const targetWords = target.split(/\s+/).filter(w => w.length > 1);

  const matchesSkill = (s) => {
    const ns = normalized(s);
    if (ns === target || ns === skill) return true;
    return targetWords.every(w => ns.includes(w));
  };

  const details = [];

  // 1. Direct skill listing
  for (const [group, values] of Object.entries(knowledge?.skills || {})) {
    if (!Array.isArray(values)) continue;
    const matched = values
      .map(item => ({ name: skillItemName(item), text: skillItemText(item) }))
      .filter(entry => entry.name && matchesSkill(entry.name));
    if (matched.length > 0) {
      details.push({
        type: 'direct',
        source: `skills.${group}`,
        items: matched.slice(0, 5).map(entry => entry.text || entry.name)
      });
    }
  }

  // 2. Project evidence
  for (const project of knowledge?.projects || []) {
    const tech = (project.tech || []).filter(t => matchesSkill(t));
    if (tech.length > 0) {
      details.push({ type: 'project', source: project.name, tech, description: (project.description || '').slice(0, 200) });
    }
  }

  // 3. Work/internship evidence
  for (const item of knowledge?.experience || []) {
    const skills = (item.skills || []).filter(s => matchesSkill(s));
    if (skills.length > 0) {
      details.push({ type: 'work', source: `${item.role} at ${item.company}`, skills, summary: (item.summary || '').slice(0, 200) });
    }
  }

  // 4. Certification evidence
  for (const cert of knowledge?.certifications || []) {
    if (matchesSkill(cert.name) || (cert.skills || []).some(s => matchesSkill(s))) {
      details.push({ type: 'certification', source: cert.name, skills: cert.skills || [] });
    }
  }

  // 5. Adjacent evidence (skill appears in project descriptions or experience summaries)
  if (details.length === 0) {
    for (const project of knowledge?.projects || []) {
      if (normalized(project.description || '').includes(target)) {
        details.push({ type: 'adjacent', source: project.name, note: `Mentioned in project description` });
      }
    }
  }

  const evidenceLevel = details.length === 0 ? 'unknown' :
    details.some(d => d.type === 'direct') ? 'direct' :
    details.some(d => d.type === 'project' || d.type === 'work') ? 'project' :
    details.some(d => d.type === 'certification') ? 'certification' :
    'adjacent';

  return {
    skill: String(args.skill || '').slice(0, 120),
    evidence: evidenceLevel,
    details: details.slice(0, 8),
    note: details.length === 0 ? `No verified evidence found for "${skill}".` : null
  };
}

// build_recruiter_brief: assemble structured verified candidate information
// for a recruiter-facing brief. Ollama generates the final readable text.
function buildRecruiterBrief(knowledge, args) {
  const focus = normalized(String(args?.focus || '').slice(0, 120));
  const summary = knowledge?.summary || {};
  const topProjects = (knowledge?.projects || [])
    .filter(p => !focus || normalized(`${p.name} ${p.description} ${(p.tech||[]).join(' ')}`).includes(focus))
    .slice(0, 4)
    .map(publicProject);
  const topSkills = Object.entries(knowledge?.skills || {})
    .flatMap(([group, values]) => Array.isArray(values) ? values.slice(0, 8).map(v => ({ group, skill: v })) : [])
    .slice(0, 15);
  const certs = (knowledge?.certifications || []).slice(0, 4).map(c => ({ name: c.name, issuer: c.issuer }));
  const experience = (knowledge?.experience || []).slice(0, 3).map(e => ({ role: e.role, company: e.company, summary: (e.summary || '').slice(0, 150) }));
  const education = knowledge?.education ? { degree: knowledge.education.degree, school: knowledge.education.school, field: knowledge.education.field } : null;

  return {
    focus: focus || null,
    candidateName: summary.name || 'the candidate',
    headline: summary.headline || null,
    topProjects,
    topSkills,
    certifications: certs,
    experience,
    education,
    honestGaps: (summary.honestGaps || []).slice(0, 3),
    targetRoles: (summary.targetRoles || []).slice(0, 4),
    assessmentRule: 'Use only verified data. Do not invent experience. Distinguish direct vs adjacent evidence.'
  };
}

function executeAgentTool(name, args, knowledge) {
  if (name === 'search_portfolio') return searchPortfolio(knowledge, args || {});
  if (name === 'get_project') {
    const project = findProject(knowledge, args?.name);
    return project ? { found: true, project: publicProject(project) } : { found: false, project: null };
  }
  if (name === 'compare_projects') {
    const names = Array.isArray(args?.names) ? args.names.slice(0, 4) : [];
    return { projects: names.map(name => findProject(knowledge, name)).filter(Boolean).map(publicProject), requested: names };
  }
  if (name === 'match_role') return matchRole(knowledge, args || {});
  if (name === 'get_skill_evidence') return getSkillEvidence(knowledge, args || {});
  if (name === 'build_recruiter_brief') return buildRecruiterBrief(knowledge, args || {});
  if (name === 'get_candidate_profile') {
    const section = String(args?.section || '');
    const allowed = ['summary', 'skills', 'experience', 'education', 'certifications', 'goals', 'qualifications'];
    if (section === 'qualifications') {
      return {
        section,
        data: {
          education: knowledge?.education || null,
          certifications: knowledge?.certifications || null,
          skills: knowledge?.skills || null,
          experience: knowledge?.experience || null
        }
      };
    }
    return allowed.includes(section) ? { section, data: knowledge?.[section] || null } : { error: 'Unsupported profile section.' };
  }
  return { error: 'Tool is not allowed.' };
}

function selectAgentToolNames(question, knowledge = null) {
  const q = normalized(question);
  const names = ['search_portfolio'];
  if (/project|portfolio|compare/.test(q)) names.push('get_project');
  if (/compare|versus| vs |difference/.test(` ${q} `)) names.push('compare_projects');
  if (/job description|requirements|role|position|fit|hire|candidate/.test(q)) names.push('match_role');
  if (/summary|skills|experience|background|education|certification|goals/.test(q)) names.push('get_candidate_profile');

  // Trigger skill-evidence lookup when a skill verb appears alongside a
  // technology the configured tenant actually knows.
  const skillVerbs = /\b(?:does|has|know|used|use|using|experience with|familiar|proficient|expert|skilled in|evidence)\b/;
  if (skillVerbs.test(q) && knowledge) {
    const knownTechs = (knowledgeAccess.getKnownTechnologies(knowledge) || []).map(t => String(t).toLowerCase());
    if (knownTechs.some(t => q.includes(t))) names.push('get_skill_evidence');
  } else if (skillVerbs.test(q)) {
    names.push('get_skill_evidence');
  }

  if (/brief|recruiter summary|hiring manager|quick version|quick brief|summarize (this )?candidate/.test(q)) names.push('build_recruiter_brief');
  return [...new Set(names)].slice(0, 7);
}

function getAgentToolDefinitions(names) {
  const allowed = new Set(names || []);
  return TOOL_DEFINITIONS.filter(tool => allowed.has(tool.function.name));
}

module.exports = { TOOL_DEFINITIONS, executeAgentTool, getAgentToolDefinitions, selectAgentToolNames };
