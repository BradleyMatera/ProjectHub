'use strict';

// Shared local RAG chunk builder used by the runtime and offline evaluator.
// System/runtime facts live in data so normal answer prose remains knowledge-grounded
// rather than being authored as hidden executable-code responses.
const scoutRuntimeKnowledge = require('../data/scout-runtime-knowledge.json');

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

function buildRagChunks(knowledge) {
  const { identity, summary, goals, education, certifications, skills, experience, projects, faq, interviewStories, rules, sourceMaterial, blogCatalog, directAnswers } = knowledge || {};
  const chunks = [];
  const add = (tag, text, meta = null) => {
    if (!text) return;
    const chunk = { tag, text: String(text) };
    if (meta && typeof meta === 'object') Object.assign(chunk, meta);
    chunks.push(chunk);
  };

  add('identity', `${identity?.name || 'the candidate'} is a ${identity?.title || 'candidate'} based in ${identity?.location || 'their location'}.`);
  const contactMethods = [];
  if (identity?.email) contactMethods.push(`email ${identity.email}`);
  if (identity?.phone) contactMethods.push(`phone ${identity.phone}`);
  if (identity?.linkedInUrl) contactMethods.push(`LinkedIn ${identity.linkedInUrl}`);
  if (identity?.gitHubUrl) contactMethods.push(`GitHub ${identity.gitHubUrl}`);
  if (identity?.portfolioUrl) contactMethods.push(`portfolio ${identity.portfolioUrl}`);
  if (contactMethods.length) add('contact', `Public contact methods for ${identity?.name || 'the candidate'}: ${contactMethods.join(', ')}.`);
  add('pitch', identity?.shortPitch);
  add('summary', summary?.whoIAm);
  add('what-he-does', summary?.whatIDo);
  add('looking-for', summary?.whatIAmLookingFor);
  add('target-roles', goals?.targetRoles?.length ? `Target roles: ${goals.targetRoles.join(', ')}.` : null);
  add('relocation', goals?.relocation);
  if (education?.degree) add('education', `Education: ${education.degree} from ${education.school}${education.gpa ? ` (GPA ${education.gpa})` : ''}.`);
  (certifications || []).forEach(c => add('certification', `Certification: ${c.name || c}${c.issued ? `, issued ${c.issued}` : ''}.`));
  // Skill groups are tenant-defined. Index every array group rather than relying
  // on a historical schema such as languagesAndFrameworks.
  for (const [group, values] of Object.entries(skills || {})) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const items = values.map(skillItemText).filter(Boolean);
    if (items.length === 0) continue;
    const groupLabel = humanizeIdentifier(group);
    const tag = `skills-${groupLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    add(tag, `${groupLabel}: ${items.join('; ')}.`);
  }
  (experience || []).forEach(e => add('experience', `${e.role}${e.company ? ` at ${e.company}` : ''}${e.dates ? ` (${e.dates})` : ''}: ${e.summary || ''}`));
  (projects || []).forEach(p => {
    const linkText = [p.url, p.repo, p.platform].filter(Boolean).join(', ');
    add('project', `Project ${p.name}: ${p.description || ''}${p.tech?.length ? ` Tech: ${p.tech.join(', ')}.` : ''}${linkText ? ` Links: ${linkText}.` : ''}`);
  });
  (faq || []).forEach(f => add('faq', `Q: ${f.question} A: ${f.answer}`));
  (interviewStories || []).forEach(s => add('story', `${s.title || s.topic || ''}: ${s.story || s.summary || ''}`));
  if (rules?.doNot?.length) add('boundaries', `Never claim: ${rules.doNot.slice(0, 4).join('; ')}.`);
  (sourceMaterial || []).forEach((m, i) => { if (m?.content) add('source', `[${m.title || 'source'}-${i}] ${m.content}`); });
  (blogCatalog?.records || []).forEach((post, i) => {
    if (post?.title || post?.brief) {
      add('blog', `[${post.platform || 'blog'}-${i}] ${post.title || 'Post'}: ${post.brief || ''}${post.url ? ` URL: ${post.url}` : ''}`);
    }
  });
  (directAnswers || []).forEach((da) => {
    if (da?.answer) {
      add('direct-answer', `[${da.id || 'direct'}] ${da.answer}`);
    }
  });

  // Runtime/system facts are retrievable RAG data, not hard-coded answer branches.
  // This lets Scout accurately explain its own architecture, free-tier usage,
  // providers, caps, and telemetry without guessing from general model knowledge.
  for (const fact of (scoutRuntimeKnowledge?.facts || [])) {
    if (!fact?.text) continue;
    add(fact.tag || 'scout-runtime', `[${fact.id || 'runtime'}] ${fact.text}`, {
      runtimeFact: true,
      runtimeFactId: fact.id || null
    });
  }

  return chunks;
}

module.exports = { buildRagChunks };