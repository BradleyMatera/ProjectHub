#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const args = ['compute', 'ssh', 'projecthub-dev-vm', '--zone=us-central1-a', '--project=ollamaapi-501903', '--command', 'sudo journalctl -u recruiter-chat-api-dev -n 50 --no-pager'];
execSync(['gcloud', ...args.map(a => a.includes(' ') ? `"${a}"` : a)].join(' '), { stdio: 'inherit' });
