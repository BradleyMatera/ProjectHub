'use strict';

const { executeAgentTool } = require('./agent-tools');

function projectNamesFromQuestion(question, knowledge) {
  const q = String(question || '').toLowerCase();
  return (knowledge?.projects || [])
    .filter(project => q.includes(String(project.name || '').toLowerCase())
      || String(project.name || '').toLowerCase().split(/\s+/).filter(word => word.length > 5).some(word => q.includes(word)))
    .map(project => project.name)
    .slice(0, 4);
}

function joinNatural(values) {
  const items = values.filter(Boolean);
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function parseLocalStyleResponse(text, question) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').trim());
  } catch {
    return null;
  }
  if (!parsed || !['standard', 'brief'].includes(parsed.style)) return null;
  const explicitlyBrief = /\b(brief|short|shorter|concise|one sentence)\b/i.test(String(question || ''));
  return parsed.style === 'brief' && explicitlyBrief ? 'brief' : 'standard';
}

function buildDeterministicAgentResult(question, knowledge) {
  const q = String(question || '').toLowerCase();
  const search = executeAgentTool('search_portfolio', { query: question, limit: 5 }, knowledge);
  const steps = [{ round: 0, tool: 'search_portfolio', status: 'completed' }];
  const toolResults = [{ tool: 'search_portfolio', status: 'completed', result: search }];

  if (/compare|versus|\bvs\b|difference/.test(q)) {
    let names = projectNamesFromQuestion(question, knowledge);
    if (names.length < 2) {
      names = search.results.filter(item => item.kind === 'project').map(item => item.name).slice(0, 2);
    }
    const comparison = executeAgentTool('compare_projects', { names }, knowledge);
    steps.push({ round: 0, tool: 'compare_projects', status: 'completed' });
    toolResults.push({ tool: 'compare_projects', status: 'completed', result: comparison });
    if (comparison.projects.length >= 2) {
      const [first, second] = comparison.projects;
      const firstTech = joinNatural((first.tech || []).slice(0, 3));
      const secondTech = joinNatural((second.tech || []).slice(0, 3));
      return {
        reply: `${first.name} is a ${first.category || 'project'} centered on ${firstTech || 'its documented implementation'}, while ${second.name} is a ${second.category || 'project'} centered on ${secondTech || 'its documented implementation'}. Bradley's verified project data supports that comparison.`,
        steps, toolResults
      };
    }
  }

  if (/job description|role requirements|match.*role|fit for|position|candidate|hire/.test(q)) {
    const match = executeAgentTool('match_role', { role: '', jobDescription: question }, knowledge);
    steps.push({ round: 0, tool: 'match_role', status: 'completed' });
    toolResults.push({ tool: 'match_role', status: 'completed', result: match });
    const skills = joinNatural(match.matchedSkills.slice(0, 5));
    const projects = joinNatural(match.projectEvidence.slice(0, 3).map(project => project.name));
    if (skills) {
      return {
        reply: `Bradley's strongest verified matches are ${skills}${projects ? `, supported by ${projects}` : ''}. This is evidence matching rather than a hiring recommendation, and the data does not establish experience beyond those items.`,
        steps, toolResults
      };
    }
    return {
      reply: `Bradley's verified data does not show a direct requirements match from that description. Scout would need a more specific role title or technology list to compare it honestly.`,
      steps, toolResults
    };
  }

  if (/interview questions|screening questions/.test(q)) {
    const evidence = search.results.slice(0, 3).map(item => item.name || item.role || item.group || item.title).filter(Boolean);
    return {
      reply: `Useful grounded questions would ask Bradley to explain ${evidence[0] || 'one project'}, describe how he debugged ${evidence[1] || 'an unfamiliar problem'}, and separate structured training from production experience.`,
      steps, toolResults
    };
  }

  const best = search.results[0];
  if (best?.kind === 'project') {
    return {
      reply: `${best.name} is the strongest verified project match for that request because it uses ${joinNatural((best.tech || []).slice(0, 4)) || 'the relevant documented approach'}. ${best.description || ''}`.trim(),
      steps, toolResults
    };
  }
  if (best) {
    return {
      reply: `Bradley's verified portfolio evidence includes ${best.role || best.group || best.name || 'relevant experience'}: ${best.summary || joinNatural(best.skills || []) || 'details are available in his recruiter data'}.`,
      steps, toolResults
    };
  }
  return {
    reply: `Bradley's verified portfolio does not contain enough evidence to complete that comparison honestly.`,
    steps, toolResults
  };
}

module.exports = { buildDeterministicAgentResult, joinNatural, parseLocalStyleResponse, projectNamesFromQuestion };
