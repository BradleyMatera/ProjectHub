'use strict';

// lib/agent-fallback.js is deprecated.
// Scout no longer uses a deterministic local-agent fallback to author final
// prose. All visible conversational replies come from DIRECT_KB, MODEL_GENERATION,
// or TECHNICAL_ERROR.
//
// The previous reply-building functions (buildDeterministicAgentResult, etc.)
// have been removed. This file is retained only as a compatibility shim so any
// stale import does not crash the process. It will be removed in a follow-up
// cleanup once all call sites are gone.

module.exports = {};
