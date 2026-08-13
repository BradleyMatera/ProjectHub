'use strict';

// Response Policy — helper functions for the policy classifier.
//
// All helpers are generic and domain-neutral. No subject-specific content.

// Detect repair/tone requests (generic linguistic patterns, no entity names).
function detectRepair(question) {
  const q = String(question || '').toLowerCase().trim();
  return {
    shorter: /^no,? shorter|^shorter[.!?]?$|cut it in half|too long|^again[.!?]?$|faster please/.test(q),
    moreHonest: /more honest|honest version|rough edges|less salesy|less pitchy|sounds fake|sounds like ai|make it (more )?normal|less formal|make it sound less ai|like a normal person|normal person|try again|be fair|do not oversell|use plain english|no hype|no marketing|less ai|more direct/.test(q),
    moreTechnical: /more technical|like a technical|technical interviewer/.test(q),
    hrFriendly: /like i am hr|hr friendly|like hr|non.?technical/.test(q),
    blunt: /be blunt|no[-\s]?bs|no bullshit|tell me straight|dont give me marketing|do not waste my time|just tell me straight|give me the no[-\s]?bs version/.test(q),
    resumeLanguage: /no resume language|no corporate tone|less corporate|not corporate/.test(q),
    isBareFollowup: /^(why|how|like what|prove it|examples?\??|what else|so what|and\??|meaning\??|which one|what project|what cert|how long|where|what role|what stack|what risk|what strength)[.!?]?$/.test(q)
  };
}

// Export helpers BEFORE requiring the classifier to avoid circular dependency issues.
module.exports = { detectRepair };

const { classifyResponsePolicy, findRoleInQuestion, parseClaim, checkClaimAgainstGraph } = require('./response-policy-classifier');

module.exports = { classifyResponsePolicy, findRoleInQuestion, detectRepair, parseClaim, checkClaimAgainstGraph };
