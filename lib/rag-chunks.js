'use strict';

// Shared RAG chunk builder — used by server-gemini.js and scripts/build-embeddings.js
// Extracted from server-gemini.js to avoid duplication between runtime and build-time.

function buildRagChunks(knowledge) {
  const { identity, summary, goals, education, certifications, skills, experience, projects, faq, interviewStories, rules, sourceMaterial, blogCatalog } = knowledge || {};
  const chunks = [];
  const add = (tag, text) => { if (text) chunks.push({ tag, text: String(text) }); };

  add('identity', `${identity?.name || 'Bradley Matera'} is a ${identity?.title || 'junior software engineer'} based in ${identity?.location || 'Davis, Illinois'}.`);
  add('pitch', identity?.shortPitch);
  add('summary', summary?.whoIAm);
  add('what-he-does', summary?.whatIDo);
  add('looking-for', summary?.whatIAmLookingFor);
  add('target-roles', goals?.targetRoles?.length ? `Target roles: ${goals.targetRoles.join(', ')}.` : null);
  add('relocation', goals?.relocation);
  if (education?.degree) add('education', `Education: ${education.degree} from ${education.school}${education.gpa ? ` (GPA ${education.gpa})` : ''}.`);
  (certifications || []).forEach(c => add('certification', `Certification: ${c.name || c}${c.issued ? `, issued ${c.issued}` : ''}.`));
  if (skills?.languagesAndFrameworks?.length) add('skills-web', `Web skills: ${skills.languagesAndFrameworks.join(', ')}.`);
  if (skills?.cloudAndInfrastructure?.length) add('skills-cloud', `Cloud skills: ${skills.cloudAndInfrastructure.join(', ')}.`);
  if (skills?.toolsAndWorkflows?.length) add('skills-tools', `Tools: ${skills.toolsAndWorkflows.join(', ')}.`);
  if (skills?.aiAndAutomation?.length) add('skills-ai', `AI workflow: ${skills.aiAndAutomation.join(', ')}.`);
  (experience || []).forEach(e => add('experience', `${e.role}${e.company ? ` at ${e.company}` : ''}${e.dates ? ` (${e.dates})` : ''}: ${e.summary || ''}`));
  (projects || []).forEach(p => add('project', `Project ${p.name}: ${p.description || ''}${p.tech?.length ? ` Tech: ${p.tech.join(', ')}.` : ''}`));
  (faq || []).forEach(f => add('faq', `Q: ${f.question} A: ${f.answer}`));
  (interviewStories || []).forEach(s => add('story', `${s.title || s.topic || ''}: ${s.story || s.summary || ''}`));
  if (rules?.doNot?.length) add('boundaries', `Never claim: ${rules.doNot.slice(0, 4).join('; ')}.`);
  (sourceMaterial || []).forEach((m, i) => { if (m?.content) add('source', `[${m.title || 'source'}-${i}] ${m.content}`); });
  (blogCatalog?.records || []).forEach((post, i) => {
    if (post?.title || post?.brief) {
      add('blog', `[${post.platform || 'blog'}-${i}] ${post.title || 'Post'}: ${post.brief || ''}${post.url ? ` URL: ${post.url}` : ''}`);
    }
  });
  return chunks;
}

module.exports = { buildRagChunks };
