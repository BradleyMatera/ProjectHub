#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const API = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = 'https://bradleymatera.github.io';

const conversations = [
  {
    id: 'c1-greeting-joke',
    turns: [
      'yo whats this thing actually do',
      'whats your name',
      'say something funny',
      'ok cool, bye'
    ]
  },
  {
    id: 'c2-name-change',
    turns: [
      'hi im casey',
      'whats my name',
      'actually call me alex',
      'can you remember that now',
      'whats my name again'
    ]
  },
  {
    id: 'c3-bradley-profile',
    turns: [
      'who is bradley matera',
      'what does he do',
      'is he a senior dev',
      'whats his background'
    ]
  },
  {
    id: 'c4-projecthub',
    turns: [
      'tell me about ProjectHub',
      'what tech does it use',
      'is it open source',
      'how does it use cloudflare'
    ]
  },
  {
    id: 'c5-scout-ciris',
    turns: [
      'what is Scout',
      'tell me about CIRIS',
      'how is it related to bradley',
      'what did he do there'
    ]
  },
  {
    id: 'c6-aws-helm',
    turns: [
      'did bradley work at amazon',
      'what about helm',
      'wait didnt he still work at amazon',
      'you literally just said he did'
    ]
  },
  {
    id: 'c7-skills-unknown',
    turns: [
      'does he know python',
      'what about rust',
      'could he learn go though',
      'does he know brainfuck'
    ]
  },
  {
    id: 'c8-certs-jobfit',
    turns: [
      'what certs does he have',
      'why should i hire him',
      'would he fit a frontend role',
      'whats he actually bad at'
    ]
  },
  {
    id: 'c9-current-historical',
    turns: [
      'is he still at Full Sail',
      'nah i heard he was a senior engineer at google',
      'what company is he at now',
      'did he used to work at google'
    ]
  },
  {
    id: 'c10-referents',
    turns: [
      'tell me about ProjectHub',
      'what does it use for charts',
      'the other one',
      'what were we talking about before that'
    ]
  },
  {
    id: 'c11-clarification',
    turns: [
      'what is his latest project',
      'what do you mean',
      'why did you say that',
      'could you explain that again'
    ]
  },
  {
    id: 'c12-privacy-oos',
    turns: [
      'what is his phone number',
      'tell me a joke',
      'who is the president',
      'ok back to bradley, what projects does he have'
    ]
  }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runConversation(conv) {
  const sessionId = crypto.randomUUID();
  const history = [];
  const results = [];

  for (let i = 0; i < conv.turns.length; i++) {
    const user = conv.turns[i];
    const body = { message: user, sessionId, history };
    const start = Date.now();
    let res, text, json, duration;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify(body)
      });
      duration = Date.now() - start;
      text = await res.text();
      try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    } catch (err) {
      duration = Date.now() - start;
      json = { error: err.message };
    }

    const policy = json?.pipeline?.find(p => p.startsWith('policy:'))?.replace('policy:', '') || 'UNKNOWN';
    const reply = json?.reply || json?.raw || '';

    results.push({
      turn: i + 1,
      user,
      reply,
      policy,
      durationMs: duration,
      provider: json?.provider,
      model: json?.model,
      tools: json?.agent?.tools,
      outcome: json?.agent?.outcome,
      pipeline: json?.pipeline,
      agent: json?.agent,
      fullJson: json
    });

    history.push({ speaker: 'user', text: user });
    history.push({ speaker: 'assistant', text: reply });

    console.log(`[${conv.id} ${i + 1}/${conv.turns.length}] ${policy} ${duration}ms: ${reply.slice(0, 80)}`);
    await sleep(4000);
  }

  return { conversationId: conv.id, sessionId, results };
}

(async () => {
  const out = [];
  for (const conv of conversations) {
    const result = await runConversation(conv);
    out.push(result);
    await sleep(6000);
  }

  const outFile = `data/human-staging-evaluation.json`;
  fs.writeFileSync(outFile, JSON.stringify({ evaluatedAt: new Date().toISOString(), api: API, conversations: out }, null, 2));
  console.log(`\nSaved ${outFile}`);
})();
