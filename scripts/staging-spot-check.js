#!/usr/bin/env node
'use strict';

const API = 'https://dev.projecthub-chat.bradleymatera.dev/api/chat';
const ORIGIN = 'https://bradleymatera.github.io';
const queries = ['thanks', 'bye', 'can you tell me a joke', 'hello, my name is casey'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== Spot check 4 stress-test queries ===');
  for (const q of queries) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ message: q })
    });
    const text = await res.text();
    let policy = 'no-pipeline';
    try {
      const json = JSON.parse(text);
      policy = (json.pipeline || []).find(p => p.startsWith('policy:'))?.replace('policy:', '') || 'no-policy';
    } catch (_) { policy = `http-${res.status}`; }
    console.log(`${q} -> ${policy}`);
    await sleep(1500);
  }
})();
