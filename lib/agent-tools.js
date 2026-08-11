'use strict';

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_portfolio',
      description: 'Search Bradley Matera\'s verified projects, experience, skills, and certifications for evidence relevant to a recruiter question.',
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
      description: 'Get verified details for one named Bradley Matera project.',
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
      description: 'Match a role or pasted job description against Bradley\'s verified skills, experience, projects, and honest gaps.',
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
  }
];

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
}

function words(value) {
  return new Set(normalized(value).split(/\s+/).filter(word => word.length > 1));
}

function publicProject(project) {
  return {
    name: project.name || '',
    description: project.description || '',
    category: project.category || '',
    tech: Array.isArray(project.tech) ? project.tech.slice(0, 12) : [],
    url: project.url || null
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
    records.push({ kind: 'project', title: project.name, text: `${project.description || ''} ${(project.tech || []).join(' ')} ${project.category || ''}`, data: publicProject(project) });
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
    records.push({ kind: 'skills', title: group, text: values.join(' '), data: { group, skills: values.slice(0, 20) } });
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
  const haystack = normalized(`${args.role || ''} ${description}`);
  const skillValues = Object.values(knowledge?.skills || {}).flatMap(value => Array.isArray(value) ? value : []);
  const projectTech = (knowledge?.projects || []).flatMap(project => project.tech || []);
  const knownSkills = [...new Set([...skillValues, ...projectTech])];
  const matchedSkills = knownSkills.filter(skill => haystack.includes(normalized(skill))).slice(0, 15);
  const projectEvidence = (knowledge?.projects || []).filter(project => (project.tech || []).some(skill => matchedSkills.includes(skill))).slice(0, 5).map(publicProject);
  const experienceEvidence = (knowledge?.experience || []).filter(item => (item.skills || []).some(skill => matchedSkills.includes(skill))).slice(0, 4).map(item => ({ role: item.role, company: item.company, summary: item.summary, matchingSkills: (item.skills || []).filter(skill => matchedSkills.includes(skill)) }));
  return {
    role: String(args.role || '').slice(0, 120) || null,
    matchedSkills,
    projectEvidence,
    experienceEvidence,
    honestGaps: (knowledge?.summary?.honestGaps || []).slice(0, 4),
    assessmentRule: 'Treat this as evidence matching, not a hiring recommendation. Do not claim unstated experience.'
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
  if (name === 'get_candidate_profile') {
    const section = String(args?.section || '');
    const allowed = ['summary', 'skills', 'experience', 'education', 'certifications', 'goals'];
    return allowed.includes(section) ? { section, data: knowledge?.[section] || null } : { error: 'Unsupported profile section.' };
  }
  return { error: 'Tool is not allowed.' };
}

function selectAgentToolNames(question) {
  const q = normalized(question);
  const names = ['search_portfolio'];
  if (/project|portfolio|pokedex|ciris|serverless|codepen|compare/.test(q)) names.push('get_project');
  if (/compare|versus| vs |difference/.test(` ${q} `)) names.push('compare_projects');
  if (/job description|requirements|role|position|fit|hire|candidate/.test(q)) names.push('match_role');
  if (/summary|skills|experience|background|education|certification|goals/.test(q)) names.push('get_candidate_profile');
  return [...new Set(names)].slice(0, 5);
}

function getAgentToolDefinitions(names) {
  const allowed = new Set(names || []);
  return TOOL_DEFINITIONS.filter(tool => allowed.has(tool.function.name));
}

module.exports = { TOOL_DEFINITIONS, executeAgentTool, getAgentToolDefinitions, selectAgentToolNames };
