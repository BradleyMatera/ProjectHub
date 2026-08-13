'use strict';

// Response Policy Classifier
//
// Converts the old mustStayGrounded() + buildGroundedFallbackPayload() pattern
// into a semantic policy contract. Deterministic code decides WHAT to say
// (facts, polarity, entities, refusal mode) but does NOT write the final prose.
// The model generates all user-visible conversational text.

// Policy modes:
//   VERIFIED_FACT      — answer using specific verified facts
//   REFUSAL            — refuse to answer (private data, safety)
//   FALSE_CLAIM_DENIAL — deny an unsupported claim with evidence
//   CONTACT            — provide verified contact info
//   GREETING           — respond to greeting
//   OUT_OF_SCOPE       — redirect to professional topics
//   CLARIFICATION      — ask which entity/topic the user means
//   META               — answer about Scout's own capabilities/nature
//   CONVERSATIONAL     — casual chat (pizza, jokes, etc.)
//   PROFILE            — general profile summary

// Helper: detect technology topic from question + history
function findTechnologyTopic(question, history) {
  const q = String(question || '').toLowerCase();
  const recentContext = (history || []).slice(-5).map(t => `${t?.user || ''} ${t?.assistant || ''}`).join(' ').toLowerCase();
  const techTopics = ['cobol','rust','go','kotlin','swift','java','python','c#','c++','ruby','php','scala','elixir','haskell','clojure','perl','r','matlab','fortran','pascal','delphi','objective-c','dart','flutter','android','ios','kubernetes','terraform','ansible','chef','puppet','jenkins','vault','consul','prometheus','grafana','elasticsearch','kafka','rabbitmq','redis','cassandra','mongodb','postgresql','mysql','oracle','sql server'];
  for (const topic of techTopics) {
    if (q.includes(topic) || recentContext.includes(topic)) return topic.charAt(0).toUpperCase() + topic.slice(1);
  }
  return null;
}

function hasVerifiedTechnologyExperience(knowledge, topic) {
  if (!topic) return false;
  const allSkills = [
    ...(knowledge?.skills?.languagesAndFrameworks || []),
    ...(knowledge?.skills?.cloudAndInfrastructure || []),
    ...(knowledge?.skills?.toolsAndWorkflows || []),
    ...(knowledge?.skills?.aiAndAutomation || []),
    ...(knowledge?.skills?.learningOrAdjacent || [])
  ].map(s => s.toLowerCase());
  return allSkills.some(s => s.includes(topic.toLowerCase()) || topic.toLowerCase().includes(s));
}

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

function isProbablyRelevant(question) {
  const q = String(question || '').toLowerCase();
  return /brad|matera|recruit|job|role|skill|languages|databases|project|portfolio|contact|email|phone|cert|education|degree|aws|cloud|react|javascript|typescript|intern|experience|hire|candidate|kitten|rescue|animal|shelter|volunteer|paid|blog|blogs|article|writing|publication|dev\.to|dev community|write about|linux|unix|terminal|shell|command line|bash|powershell|computer|stack|frontend|backend|full.?stack|senior|junior|support|helpdesk|debug|troubleshoot|production|leetcode|data structures|algorithms|dsa|weakness|strength|gap|risk|fit|interview|mentor|work style|work habit|army|military|veteran|68w|combat medic|relocation|available|salary|gpa|full sail|location|davis|illinois|github|linkedin|pizza|favorite|joke|how are you|hello|hi|hey|scout|ai wrapper|quantum|cobol/.test(q);
}

const { classifyResponsePolicy, findRoleInQuestion } = require('./response-policy-classifier');

module.exports = { classifyResponsePolicy, findRoleInQuestion, findTechnologyTopic, hasVerifiedTechnologyExperience, detectRepair, isProbablyRelevant };
