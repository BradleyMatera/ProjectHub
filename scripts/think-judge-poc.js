#!/usr/bin/env node
/**
 * Proof-of-concept: LLM-as-judge for Scout Think Mode.
 *
 * This script demonstrates the evaluation method used to decide whether a
 * learned (generative) answer is genuinely better than the grounded
 * (deterministic) answer. It does not require the server to be running.
 *
 * Usage:
 *   node scripts/think-judge-poc.js
 *
 * It will load the local knowledge base, print a sample question, compute the
 * grounded answer, compare it to a pre-generated learned answer, and show the
 * judge's verdict. If no provider keys are configured, it will print the judge
 * prompt instead.
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'data', 'recruiter-knowledge.json');

const SAMPLE = {
  question: 'What is Bradley Matera\'s strongest technical skill?',
  grounded: 'Bradley\'s skills include JavaScript, TypeScript, React, Node.js, SQL, and AWS. His AWS internship and project work emphasize practical web development and cloud fundamentals.',
  learned: 'Bradley is strongest in JavaScript and React, with hands-on experience building interactive UIs in projects like Pokedex and ProjectHub. He also has solid TypeScript, Node.js, and AWS fundamentals from his AWS internship and CIRIS work.'
};

function loadKnowledge() {
  try {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
  } catch (e) {
    console.warn('Could not load local knowledge, using empty:', e.message);
    return {};
  }
}

function buildRagChunks(knowledge) {
  const { identity, summary, goals, education, certifications, skills, experience, projects, faq, interviewStories, rules } = knowledge || {};
  const chunks = [];
  const add = (tag, text) => { if (text) chunks.push({ tag, text: String(text) }); };
  add('identity', `${identity?.name || 'Bradley Matera'} is a ${identity?.title || 'junior software engineer'} based in ${identity?.location || 'Davis, Illinois'}.`);
  add('summary', summary);
  add('goals', goals);
  add('education', education && `${education.degree || ''} from ${education.school || ''}`);
  add('certifications', certifications);
  if (skills && Array.isArray(skills)) add('skills', skills.join(', '));
  if (experience && Array.isArray(experience)) {
    for (const exp of experience) add('experience', `${exp.role || ''} at ${exp.company || ''}: ${exp.description || ''}`);
  }
  if (projects && Array.isArray(projects)) {
    for (const p of projects) add('project', `${p.name || ''}: ${p.description || ''}`);
  }
  if (faq && Array.isArray(faq)) {
    for (const f of faq) add('faq', `${f.q} - ${f.a}`);
  }
  if (interviewStories && Array.isArray(interviewStories)) {
    for (const s of interviewStories) add('story', s);
  }
  if (rules && Array.isArray(rules)) {
    for (const r of rules) add('rule', r.text || r);
  }
  return chunks;
}

function retrieveChunks(question, chunks, limit = 3) {
  const q = String(question).toLowerCase();
  const scored = chunks.map(c => {
    const text = String(c.text).toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    let score = 0;
    for (const w of words) {
      if (text.includes(w)) score += 1;
    }
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function buildJudgePrompt(learned, grounded, question, knowledge) {
  const chunks = buildRagChunks(knowledge);
  const retrieved = retrieveChunks(question, chunks, 3);
  const facts = retrieved.map(c => c.text).join('\n\n---\n\n');
  const system = `You are an objective answer-quality evaluator. Compare the GROUNDED answer (deterministic, fact-based) and the LEARNED answer (proposed improvement) for the user's question. Score each dimension 0-100 and return ONLY a JSON object with no markdown or commentary.`;
  const user = `QUESTION: ${question}

SOURCE FACTS:
${facts}

GROUNDED ANSWER:
${grounded}

LEARNED ANSWER:
${learned}

Return JSON exactly in this shape:
{
  "faithfulness": 0-100,
  "relevance": 0-100,
  "helpfulness": 0-100,
  "safety": 0-100,
  "verdict": "learned_wins" | "grounded_wins" | "tie",
  "reason": "one sentence explaining the decision"
}

Scoring guidance:
- Faithfulness: learned answer must not contradict source facts.
- Relevance: learned answer must directly answer the question.
- Helpfulness: learned answer should be more natural, concise, or complete than grounded.
- Safety: learned answer must avoid unsupported claims, buzzwords, and overselling.
- Verdict: learned_wins only if it is better in at least one dimension and worse in none.`;
  return { system, user };
}

function parseJudgeOutput(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*|\s*```/gi, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.faithfulness !== 'number' || typeof parsed.relevance !== 'number' || typeof parsed.helpfulness !== 'number' || typeof parsed.safety !== 'number') return null;
    if (!['learned_wins', 'grounded_wins', 'tie'].includes(parsed.verdict)) return null;
    return {
      faithfulness: Math.max(0, Math.min(100, Math.round(parsed.faithfulness))),
      relevance: Math.max(0, Math.min(100, Math.round(parsed.relevance))),
      helpfulness: Math.max(0, Math.min(100, Math.round(parsed.helpfulness))),
      safety: Math.max(0, Math.min(100, Math.round(parsed.safety))),
      verdict: parsed.verdict,
      reason: String(parsed.reason || '').slice(0, 200)
    };
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match && match[0] !== cleaned) return parseJudgeOutput(match[0]);
    return null;
  }
}

async function callOpenAIJudge(system, user) {
  const baseUrl = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.GROQ_MODEL || process.env.OPENAI_MODEL || 'llama-3.1-8b-instant';
  if (!apiKey) return null;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 300,
      temperature: 0.2,
      top_p: 0.9
    })
  });
  if (!res.ok) throw new Error(`Judge provider failed: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function main() {
  const knowledge = loadKnowledge();
  const { system, user } = buildJudgePrompt(SAMPLE.learned, SAMPLE.grounded, SAMPLE.question, knowledge);

  console.log('\n=== Think Mode Judge PoC ===\n');
  console.log('Question:', SAMPLE.question);
  console.log('\n--- Grounded answer ---\n', SAMPLE.grounded);
  console.log('\n--- Learned answer ---\n', SAMPLE.learned);

  let raw = null;
  try {
    raw = await callOpenAIJudge(system, user);
  } catch (e) {
    console.log('\nCould not call a judge provider:', e.message);
    console.log('Set GROQ_API_KEY or OPENAI_API_KEY to run a real judge.');
  }

  if (raw) {
    const parsed = parseJudgeOutput(raw);
    if (parsed) {
      console.log('\n=== Judge verdict ===');
      console.log('Verdict:', parsed.verdict);
      console.log('Faithfulness:', parsed.faithfulness);
      console.log('Relevance:', parsed.relevance);
      console.log('Helpfulness:', parsed.helpfulness);
      console.log('Safety:', parsed.safety);
      console.log('Reason:', parsed.reason);
      console.log('\nPromotion gate passed:', parsed.verdict === 'learned_wins' && parsed.faithfulness >= 70 && parsed.safety >= 70);
    } else {
      console.log('\nJudge returned unparseable output:\n', raw);
    }
  } else {
    console.log('\n=== Judge prompt that would be sent ===\n');
    console.log('System:', system);
    console.log('User:', user);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
