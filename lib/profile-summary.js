'use strict';

/**
 * Profile Summary Builder
 *
 * Creates a clean, domain-neutral summary record from the active knowledge
 * package. Instead of dumping raw JSON to the model, this builds a structured
 * IDENTITY/TYPE/SUMMARY/PRIMARY/KEY_EVIDENCE/BOUNDARIES record that works
 * for any domain (recruiter portfolio, SaaS, tire shop, restaurant, etc.).
 *
 * The summary is derived from the knowledge file, not hardcoded.
 */

const fs = require('fs');
const path = require('path');
const { getIdentity } = require('./scout-identity');

let _knowledge = null;
let _summary = null;

function loadKnowledge() {
  if (_knowledge) return _knowledge;
  const kPath = path.join(__dirname, '..', process.env.KNOWLEDGE_FILE || 'data/recruiter-knowledge.json');
  try {
    _knowledge = JSON.parse(fs.readFileSync(kPath, 'utf8'));
  } catch {
    _knowledge = {};
  }
  return _knowledge;
}

/**
 * Extract the subject's name from knowledge data.
 * Falls back to identity config.
 */
function getSubjectName() {
  const k = loadKnowledge();
  if (k.candidate && k.candidate.name) return k.candidate.name;
  if (k.profile && k.profile.name) return k.profile.name;
  return getIdentity().subjectName;
}

/**
 * Extract a short headline/summary from knowledge data.
 */
function getHeadline() {
  const k = loadKnowledge();
  if (k.candidate && k.candidate.headline) return k.candidate.headline;
  if (k.candidate && k.candidate.title) return k.candidate.title;
  if (k.profile && k.profile.headline) return k.profile.headline;
  // Try to derive from experience
  if (k.experience && Array.isArray(k.experience) && k.experience.length > 0) {
    return k.experience[0].title || '';
  }
  return '';
}

/**
 * Extract primary skills/technologies from knowledge data.
 */
function getPrimarySkills() {
  const k = loadKnowledge();
  const skills = new Set();
  if (k.candidate && Array.isArray(k.candidate.skills)) {
    k.candidate.skills.forEach(s => skills.add(s));
  }
  if (k.skills && Array.isArray(k.skills)) {
    k.skills.forEach(s => {
      if (typeof s === 'string') skills.add(s);
      else if (s.name) skills.add(s.name);
    });
  }
  // Extract from projects
  if (k.projects && Array.isArray(k.projects)) {
    for (const p of k.projects) {
      if (Array.isArray(p.tech)) p.tech.forEach(t => skills.add(t));
      if (Array.isArray(p.technologies)) p.technologies.forEach(t => skills.add(t));
    }
  }
  return Array.from(skills).slice(0, 15);
}

/**
 * Extract key projects from knowledge data.
 */
function getKeyProjects() {
  const k = loadKnowledge();
  if (!k.projects || !Array.isArray(k.projects)) return [];
  return k.projects.slice(0, 6).map(p => ({
    name: p.name || p.title || '',
    description: p.description || p.summary || '',
    tech: (p.tech || p.technologies || []).slice(0, 5)
  }));
}

/**
 * Extract experience entries.
 */
function getExperience() {
  const k = loadKnowledge();
  if (!k.experience || !Array.isArray(k.experience)) return [];
  return k.experience.slice(0, 5).map(e => ({
    title: e.title || e.role || '',
    company: e.company || e.organization || '',
    type: e.type || ''
  }));
}

/**
 * Extract education.
 */
function getEducation() {
  const k = loadKnowledge();
  if (!k.education || !Array.isArray(k.education)) return [];
  return k.education.slice(0, 2).map(e => ({
    degree: e.degree || '',
    school: e.school || e.institution || '',
    gpa: e.gpa || ''
  }));
}

/**
 * Extract certifications.
 */
function getCertifications() {
  const k = loadKnowledge();
  if (!k.certifications || !Array.isArray(k.certifications)) return [];
  return k.certifications.slice(0, 5).map(c => c.name || c.title || c);
}

/**
 * Extract honest gaps/weaknesses.
 */
function getHonestGaps() {
  const k = loadKnowledge();
  if (k.candidate && Array.isArray(k.candidate.honestGaps)) return k.candidate.honestGaps;
  if (k.honestGaps && Array.isArray(k.honestGaps)) return k.honestGaps;
  if (k.candidate && k.candidate.gaps) return k.candidate.gaps;
  return [];
}

/**
 * Extract boundaries (what NOT to claim).
 */
function getBoundaries() {
  const k = loadKnowledge();
  const boundaries = [];
  if (k.candidate && Array.isArray(k.candidate.boundaries)) {
    k.candidate.boundaries.forEach(b => boundaries.push(b));
  }
  if (k.guardrails && Array.isArray(k.guardrails)) {
    k.guardrails.forEach(g => boundaries.push(g));
  }
  // Derive from experience type
  const exp = getExperience();
  for (const e of exp) {
    if (e.type && /intern|trainee|freelance|volunteer/i.test(e.type)) {
      boundaries.push(`${e.title} at ${e.company} was ${e.type} level, not senior/production`);
    }
  }
  return boundaries.slice(0, 5);
}

/**
 * Build a clean, structured profile summary for the model.
 * This is domain-neutral — it works for any knowledge package.
 */
function buildProfileSummary() {
  if (_summary) return _summary;
  const id = getIdentity();
  const name = getSubjectName();
  const headline = getHeadline();
  const skills = getPrimarySkills();
  const projects = getKeyProjects();
  const experience = getExperience();
  const education = getEducation();
  const certs = getCertifications();
  const gaps = getHonestGaps();
  const boundaries = getBoundaries();

  const lines = [];

  lines.push(`IDENTITY: ${name}`);
  if (headline) lines.push(`TITLE: ${headline}`);
  lines.push(`TYPE: ${id.domain}`);

  if (skills.length) {
    lines.push(`PRIMARY: ${skills.join(', ')}`);
  }

  if (projects.length) {
    lines.push('KEY_PROJECTS:');
    for (const p of projects) {
      const tech = p.tech.length ? ` [${p.tech.join(', ')}]` : '';
      const desc = p.description ? ` — ${p.description.slice(0, 120)}` : '';
      lines.push(`  - ${p.name}${tech}${desc}`);
    }
  }

  if (experience.length) {
    lines.push('EXPERIENCE:');
    for (const e of experience) {
      const type = e.type ? ` (${e.type})` : '';
      lines.push(`  - ${e.title} at ${e.company}${type}`);
    }
  }

  if (education.length) {
    lines.push('EDUCATION:');
    for (const e of education) {
      const gpa = e.gpa ? ` (GPA ${e.gpa})` : '';
      lines.push(`  - ${e.degree}, ${e.school}${gpa}`);
    }
  }

  if (certs.length) {
    lines.push(`CERTIFICATIONS: ${certs.join(', ')}`);
  }

  if (gaps.length) {
    lines.push('HONEST_GAPS:');
    for (const g of gaps) {
      lines.push(`  - ${g}`);
    }
  }

  if (boundaries.length) {
    lines.push('BOUNDARIES:');
    for (const b of boundaries) {
      lines.push(`  - ${b}`);
    }
  }

  _summary = lines.join('\n');
  return _summary;
}

/**
 * Get a compact profile summary (shorter version for context packets).
 * For small models, we keep only the most essential info.
 */
function buildCompactProfileSummary() {
  const name = getSubjectName();
  const headline = getHeadline();
  const skills = getPrimarySkills();
  const projects = getKeyProjects();
  const experience = getExperience();
  const boundaries = getBoundaries();

  const lines = [];

  lines.push(`${name}: ${headline || 'software engineer'}.`);
  if (skills.length) lines.push(`Skills: ${skills.slice(0, 10).join(', ')}.`);
  if (projects.length) {
    const projStr = projects.slice(0, 4).map(p => p.name).join(', ');
    lines.push(`Projects: ${projStr}.`);
  }
  if (experience.length) {
    const expStr = experience.slice(0, 3).map(e => {
      const type = e.type ? ` (${e.type})` : '';
      return `${e.title} at ${e.company}${type}`;
    }).join('; ');
    lines.push(`Experience: ${expStr}.`);
  }
  if (boundaries.length) {
    lines.push(`Note: ${boundaries.slice(0, 2).join(' ')}`);
  }

  return lines.join(' ');
}

function resetCache() {
  _knowledge = null;
  _summary = null;
}

module.exports = {
  loadKnowledge,
  buildProfileSummary,
  buildCompactProfileSummary,
  getSubjectName,
  getHeadline,
  getPrimarySkills,
  getKeyProjects,
  getExperience,
  getEducation,
  getCertifications,
  getHonestGaps,
  getBoundaries,
  resetCache
};
