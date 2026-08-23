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

function matchRole(knowledge, args) {
  const description = String(args.jobDescription || '').slice(0, 4000);
  const role = String(args.role || '').slice(0, 120) || null;
  const rawDesc = String(args.jobDescription || args.role || '').slice(0, 4000);
  const skillValues = Object.values(knowledge?.skills || {}).flatMap(value => Array.isArray(value) ? value.map(skillItemName).filter(Boolean) : []);
  const projectTech = (knowledge?.projects || []).flatMap(project => project.tech || []);
  const knownSkills = [...new Set([...skillValues, ...projectTech])];

  // Role hints expand a generic role (e.g. "frontend") into the skills that
  // evidence can actually match. These are signals, not mandatory checklists.
  const ROLE_HINTS = {
    frontend: ['javascript', 'html', 'css', 'react', 'typescript', 'vue', 'angular', 'front-end', 'sass', 'less', 'webpack', 'vite'],
    'front-end': ['javascript', 'html', 'css', 'react', 'typescript', 'vue', 'angular', 'sass', 'less', 'webpack', 'vite'],
    backend: ['node.js', 'node', 'python', 'sql', 'database', 'api', 'express', 'django', 'mongodb', 'postgresql', 'rest', 'graphql', 'aws', 'lambda'],
    'back-end': ['node.js', 'node', 'python', 'sql', 'database', 'api', 'express', 'django', 'mongodb', 'postgresql', 'rest', 'graphql', 'aws', 'lambda'],
    fullstack: ['javascript', 'node.js', 'react', 'html', 'css', 'node', 'typescript', 'python', 'sql', 'api', 'mongodb', 'postgresql'],
    'full-stack': ['javascript', 'node.js', 'react', 'html', 'css', 'node', 'typescript', 'python', 'sql', 'api', 'mongodb', 'postgresql'],
    devops: ['docker', 'kubernetes', 'aws', 'ci/cd', 'cicd', 'github actions', 'terraform', 'jenkins', 'ansible'],
    'ci/cd': ['github actions', 'cicd', 'jenkins', 'docker', 'kubernetes'],
    data: ['python', 'sql', 'database', 'pandas', 'machine learning', 'data analysis', 'tableau', 'power bi', 'numpy', 'jupyter']
  };

  // Identify role tokens from the input, ignoring qualifiers like junior/senior.
  const roleNorm = normalized(`${role || ''} ${description}`);
  const roleWords = roleNorm.split(/[\s,;.|/()-]+/)
    .filter(w => w.length >= 2 && !['junior', 'senior', 'developer', 'engineer', 'software', 'web', 'full', 'stack', 'the', 'and', 'for', 'with', 'role', 'position', 'job', 'fit', 'his', 'he', 'is', 'a', 'an', 'does', 'do', 'can', 'could'].includes(w));

  const roleTokens = [...new Set(roleWords)].filter(w => ROLE_HINTS[w]);

  // Build the set of target skills from role hints and from explicit known-skill
  // mentions in the description.
  const explicitKnownSkills = knownSkills.filter(skill =>
    rawDesc.toLowerCase().includes(normalized(skill))
  );
  const targetSkills = [...new Set([
    ...roleTokens,
    ...roleTokens.flatMap(t => ROLE_HINTS[t] || []),
    ...explicitKnownSkills
  ])];

  // Match the candidate's known skills against the target skills.
  const matchedSkills = knownSkills.filter(skill => {
    const s = skill.toLowerCase();
    return targetSkills.some(target => {
      const t = target.toLowerCase();
      return s === t || s.includes(t) || t.includes(s);
    });
  }).slice(0, 15);

  // Extract required skills only when the user supplies explicit job requirements.
  const hasJobContext = /\b(?:requiring|requires?|needs?|must have|position|job\s+description|role\s+(?:requiring|needs))\b/i.test(rawDesc);
  const slashTerms = rawDesc.match(/\b[A-Za-z]+\/[A-Za-z]+(?:\/[A-Za-z]+)*\b/g) || [];

  const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'will', 'must', 'have', 'able',
    'work', 'role', 'team', 'years', 'year', 'experience', 'including', 'etc',
    'strong', 'excellent', 'good', 'ability', 'plus', 'preferred', 'nice', 'how',
    'does', 'fit', 'requiring', 'required', 'require', 'needs', 'need', 'null',
    'what', 'would', 'should', 'could', 'might', 'may', 'can', 'will', 'shall',
    'bet', 'succeeding', 'succeed', 'success', 'one', 'type', 'kind', 'sort',
    'best', 'worst', 'most', 'least', 'better', 'worse', 'think', 'believe',
    'opinion', 'recommend', 'recommendation', 'suggest', 'suggestion',
    'honest', 'thing', 'tell', 'about', 'into', 'onto', 'upon', 'within',
    'without', 'because', 'since', 'however', 'therefore', 'moreover',
    'additionally', 'furthermore', 'nevertheless', 'nonetheless',
    'developer', 'engineer', 'software', 'web', 'frontend', 'backend',
    'full', 'stack', 'cloud', 'support', 'junior', 'senior', 'devops',
    'data', 'design', 'product', 'manager', 'business', 'customer',
    'service', 'solutions', 'system', 'application', 'platform',
    'you', 'him', 'his', 'her', 'she', 'they', 'them', 'their',
    'was', 'were', 'been', 'being', 'is', 'are', 'am',
    'did', 'does', 'do', 'done', 'has', 'had', 'having',
  ]);

  const wordTerms = roleNorm.split(/[\s,;.|/()-]+/)
    .filter(w => w.length >= 3)
    .filter(w => !STOPWORDS.has(w));

  const recognizedTerms = wordTerms.filter(w => {
    const wNorm = normalized(w);
    return knownSkills.some(s => {
      const sNorm = normalized(s);
      return sNorm.includes(wNorm) || wNorm.includes(sNorm);
    });
  });

  const requiredTerms = [
    ...slashTerms,
    ...(hasJobContext ? wordTerms : recognizedTerms)
  ];

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

  // Identify gaps — required terms not in known skills.
  // Only terms that come from explicit job requirements or recognized skills
  // in the description become gaps; generic role hints are never gaps.
  for (const term of requiredTerms) {
    const termNorm = normalized(term);
    if (termNorm.length < 4 && !termNorm.includes('/')) continue;
    if (STOPWORDS.has(termNorm)) continue;
    const isKnown = knownSkills.some(s => normalized(s).includes(termNorm) || termNorm.includes(normalized(s)));
    if (!isKnown && !gaps.find(g => normalized(g.skill) === termNorm)) {
      gaps.push({ skill: term, evidence: 'UNKNOWN', detail: 'No verified experience with this skill' });
    }
  }

  const projectEvidence = (knowledge?.projects || []).filter(project => (project.tech || []).some(skill => matchedSkills.includes(skill))).slice(0, 5).map(publicProject);
  const experienceEvidence = (knowledge?.experience || []).filter(item => (item.skills || []).some(skill => matchedSkills.includes(skill))).slice(0, 4).map(item => ({ role: item.role, company: item.company, summary: item.summary, matchingSkills: (item.skills || []).filter(skill => matchedSkills.includes(skill)) }));

  return {
    role,
    matchedSkills,
    strong: strong.slice(0, 6),
    partial: partial.slice(0, 6),
    gaps: gaps.slice(0, 5),
    projectEvidence,
    experienceEvidence,
    assessmentRule: 'Treat this as evidence matching, not a hiring recommendation. Distinguish DIRECT_MATCH from ADJACENT from GAP. Do not claim unstated experience. Generic role hints (e.g. frontend) are signals, not mandatory requirements. Do not treat candidate summary gaps as job-specific gaps unless the user explicitly asked about them.',
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
    const allowed = ['summary', 'skills', 'experience', 'education', 'certifications', 'goals'];
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
