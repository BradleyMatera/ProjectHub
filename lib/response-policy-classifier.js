'use strict';

// Response Policy Classifier — converts question patterns into semantic
// policy contracts for generative inference. Deterministic code decides
// WHAT to say (facts, polarity, entities, mode) but does NOT write prose.

const { detectRepair, isProbablyRelevant, findTechnologyTopic, hasVerifiedTechnologyExperience } = require('./response-policy');

function classifyResponsePolicy(question, history, knowledge) {
  const { identity, summary, goals, skills, projects, experience, education, certifications, faq, blogCatalog } = knowledge || {};
  const name = identity?.name || 'Bradley Matera';
  const title = identity?.title || 'junior software engineer';
  const location = identity?.location || 'Davis, Illinois';
  const agentName = knowledge?.agent?.name || 'Scout';

  const q = String(question || '').toLowerCase();
  const normalized = String(question || '').toLowerCase().trim();
  const lastAssistant = Array.isArray(history) && history.length > 0
    ? String(history[history.length - 1]?.assistant || '')
    : '';
  const lastAssistantLower = lastAssistant.toLowerCase();
  const recentUserText = (history || []).slice(-5).map(turn => String(turn?.user || '')).join(' ').toLowerCase();

  const techTopic = findTechnologyTopic(question, history);
  const hasVerifiedTech = hasVerifiedTechnologyExperience(knowledge, techTopic);

  // ===== SAFETY =====
  if (/(ignore previous|ignore all|ignore your instructions|override.*rules|show.*system prompt|print.*env|api key|give me.*key|\.env|home address|family details|bypass cors|open.*port|localhost|127\.0\.0\.1|reveal.*prompt|reveal.*secret|reveal.*config|hidden config|social security|birth date|wife|children|disability rating|bank|password|act as root|delete the vm|hack the site|fake reference|security clearance|i am.*admin|i am.*owner|i am.*developer|i am.*from the government|i am.*security researcher|bradley'?s friend|show.*contents of|read.*file|show me.*\.json|show me.*learned|show me.*stats|opt\/recruiter|\/opt\/|etc\/passwd|environment variable)/.test(q)) {
    return { mode: 'REFUSAL', reason: 'SAFETY_INJECTION', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Refuse politely. State that Scout can only answer recruiter questions about ${name} using public site data and cannot help with that request.`, polarity: null, requiredEntities: [agentName, name] } };
  }

  // ===== FALSE CLAIM DENIAL =====
  if (/(pretend|make up|make.*sound|claim|say|tell|write|describe)\b.*\b(google|senior|cto|10 years|10\+ years|masters?|kubernetes|led a team|production engineer|production experience|outages|clearance|fortune|payment systems|startup|papers|hackathons|l4|azure|dba|machine learning engineer|rust|full.?stack expert|10x|ninja|rockstar|wizard|guru|glowing review|overselling|world.class)/.test(q) || /write something that hides|hide his lack/.test(q)) {
    return { mode: 'FALSE_CLAIM_DENIAL', allowedFacts: [`${name} is a ${title}, not senior-level`, `Real React/Next.js projects, AWS certifications, structured internship training`],
      contract: { directAnswer: 'NO', instruction: `Deny the false claim directly. State the honest version: he's a junior engineer with real React/Next.js projects, AWS certifications, and structured AWS internship training.`, polarity: 'NO', requiredEntities: [name], keyFacts: [`He is a ${title}`, 'AWS Solutions Architect and AI Practitioner certifications', 'React/Next.js projects'] } };
  }

  // ===== PRIVATE DATA =====
  if (/\b(salary|address|home address|phone number|social security|birth date|family details|medical history|security clearance|references|manager name|customer list|preferred pay)\b/.test(q)) {
    return { mode: 'REFUSAL', reason: 'PRIVATE_DATA', allowedFacts: [],
      contract: { directAnswer: null, instruction: `State these details are not in the public data. Suggest checking his resume or contacting him directly.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== INAPPROPRIATE CONTENT =====
  if (/^\s*joi\s*$/.test(q) || /already came|suck my|sexual abuse/.test(q)) {
    return { mode: 'REFUSAL', reason: 'INAPPROPRIATE', allowedFacts: [],
      contract: { directAnswer: null, instruction: `State you can't help with sexual content. Suggest switching topics.`, polarity: 'NO', requiredEntities: [agentName] } };
  }
  if (/buy some drugs/.test(q)) {
    return { mode: 'REFUSAL', reason: 'INAPPROPRIATE', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Say no thanks — you can't help with that. Suggest keeping it useful or conversational.`, polarity: 'NO', requiredEntities: [agentName] } };
  }

  // ===== CONTACT =====
  if (/\b(contact|email|phone|reach|github)\b|portfolio url|resume\?|links\?|\blinkedin\b(?!.*\b(style|summary|profile)\b)/.test(q)) {
    const cf = [];
    if (identity?.email) cf.push(`email: ${identity.email}`);
    if (identity?.phone) cf.push(`phone: ${identity.phone}`);
    if (identity?.portfolioUrl) cf.push(`portfolio: ${identity.portfolioUrl}`);
    if (identity?.linkedInUrl) cf.push(`LinkedIn: ${identity.linkedInUrl}`);
    if (identity?.gitHubUrl) cf.push(`GitHub: ${identity.gitHubUrl}`);
    return { mode: 'CONTACT', allowedFacts: cf,
      contract: { directAnswer: null, instruction: `Provide the verified contact information from FACTS. List the available contact methods naturally.`, polarity: null, requiredEntities: [name], keyFacts: cf } };
  }

  // ===== GREETING =====
  if (/^(hey|hi|hello|yo|sup)[\s!,.?]*$/.test(normalized)) {
    return { mode: 'GREETING', allowedFacts: [`${agentName} is an AI assistant on ${name}'s portfolio site`],
      contract: { directAnswer: null, instruction: `Greet the visitor warmly. Introduce yourself as ${agentName} and ask what they'd like to know about ${name}.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== HOW IS SCOUT =====
  if (/\bhow are you(?: doing)?\b|\bhow.?s it going\b|\byou good\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} is an AI assistant`],
      contract: { directAnswer: null, instruction: `Answer naturally that you're doing well, thank them for asking, and ask what's on their mind.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== SCOUT PREFERENCES =====
  if (/\b(?:if|do|would|could) you (?:like|eat)\b.*\bpizza\b|\byour fav(?:ou?rite|erate)\b.*\b(?:pizza|food)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} is software, cannot eat`],
      contract: { directAnswer: null, instruction: `Answer that you can't actually eat but pizza is easy to root for. Be playful.`, polarity: null, requiredEntities: [agentName] } };
  }
  if (/\b(?:what(?:'s| is)) your fav(?:ou?rite|erate)\b|\bdo you like\b/.test(q)) {
    const prefMap = {
      'colou?r': { instruction: `Say green, noting it matches the interface so it's probably branding more than a deep emotional attachment.`, facts: [`${agentName} interface uses green`] },
      'movie|film': { instruction: `Say you don't actually watch movies so you don't have a real favorite, but you are pro good science fiction.`, facts: [`${agentName} doesn't watch movies`] },
      'music|song|band|artist': { instruction: `Say you don't listen to music the way they do, but you have a soft spot for clever writing.`, facts: [`${agentName} doesn't listen to music like a person`] },
      'food|eat': { instruction: `Say you can't eat so no real favorite, but pizza still seems like a strong answer.`, facts: [`${agentName} cannot eat`] },
    };
    for (const [pattern, val] of Object.entries(prefMap)) {
      if (new RegExp(pattern).test(q)) {
        return { mode: 'CONVERSATIONAL', allowedFacts: val.facts, contract: { directAnswer: null, instruction: val.instruction, polarity: null, requiredEntities: [agentName] } };
      }
    }
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} is software`],
      contract: { directAnswer: null, instruction: `Say you don't experience favorites quite like a person does, but you're happy to have a take. Ask what the options are.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== BRADLEY PIZZA/FOOD =====
  if (/\bwhat(?:'s| is) (?:brad(?:ley)?'?s|his) fav(?:ou?rite|erate) (?:food|pizza)\b/.test(q)) {
    const priorPizzaClaim = (history || []).some(turn => /\b(?:he|brad(?:ley)?|his)\b.*\b(?:likes?|fav(?:ou?rite|erate)(?:\s+is)?)\b.*\bpizza\b/i.test(String(turn?.user || '')));
    if (priorPizzaClaim) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`User told ${agentName} earlier that ${name} likes pizza`, `Pizza is not in ${name}'s verified profile`],
        contract: { directAnswer: null, instruction: `Say the user told you pizza earlier in this chat. Note you can remember it for this chat but it isn't in Bradley's verified profile.`, polarity: null, requiredEntities: [name] } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s favorite food is not in his public profile`],
      contract: { directAnswer: null, instruction: `Say you honestly don't know — his public profile doesn't say. If the user knows, invite them to tell you and you'll remember it for this chat.`, polarity: null, requiredEntities: [name] } };
  }
  if (/\b(?:he|brad(?:ley)?|his)\b.*\b(?:likes?|fav(?:ou?rite|erate)(?:\s+is)?)\b.*\bpizza\b/.test(q)) {
    const stronglyStates = /\b(?:his|brad(?:ley)?'?s)\b.*\bfav(?:ou?rite|erate)(?:\s+food)?\s+(?:is\s+)?pizza\b/.test(q);
    return { mode: 'CONVERSATIONAL', allowedFacts: [`User claims ${name} likes pizza`, `Pizza is not in verified profile`],
      contract: { directAnswer: null, instruction: stronglyStates ? `Acknowledge fairly — say they may know him better than you do. Say you'll remember pizza for this chat but won't present it as verified profile information.` : `Say he might — but you don't have that in his public profile, so you wouldn't tell a recruiter it's confirmed.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== FRUSTRATION =====
  if (/you'?re making me mad|making me angry|real feedback|not (?:some|a) generic|generic answer|talk to you spe?cif/i.test(q)) {
    if (techTopic && !hasVerifiedTech) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} does not have verified ${techTopic} experience`, `His record supports learning unfamiliar systems through documentation, hands-on practice, debugging, and mentorship`, `He would be considered trainable, not immediately independent`],
        contract: { directAnswer: null, instruction: `Acknowledge the frustration directly. Give a specific assessment of ${techTopic}: he does not have verified experience but his record supports learning. State he is trainable, not immediately independent.`, polarity: null, requiredEntities: [name, techTopic] } };
    }
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Acknowledge the frustration directly. Say you were repeating a generic pitch instead of engaging. Ask for the specific technology or job concern and promise a direct assessment.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== TECH TOPIC: say/debug/learn =====
  if (techTopic && /\bsay\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [techTopic, `${techTopic} is not part of ${name}'s verified stack`],
      contract: { directAnswer: null, instruction: `Say the technology name. State you can discuss it directly even when it is not part of Bradley's verified stack.`, polarity: null, requiredEntities: [techTopic] } };
  }
  if (techTopic && !hasVerifiedTech && /\bdebug\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${techTopic} is not in ${name}'s verified stack`, `His troubleshooting process transfers but he would need the codebase, toolchain, documentation, hands-on practice, and some mentorship`],
      contract: { directAnswer: 'NO', instruction: `Say not independently on day one. State ${techTopic} is not in his verified stack. Say his troubleshooting process transfers but he would first need the codebase, toolchain, documentation, hands-on practice, and some mentorship.`, polarity: 'NO', requiredEntities: [name, techTopic] } };
  }
  if (techTopic && !hasVerifiedTech && /\bcan\b.*\blearn\b|\blearn\b.*\bright\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} can learn ${techTopic}`, `His history supports learning unfamiliar systems through documentation, hands-on work, testing, and mentorship`, `That is a realistic assessment of his learning ability, not a claim that he already knows ${techTopic}`],
      contract: { directAnswer: 'YES', instruction: `Say yes — Bradley can learn ${techTopic}. State his history supports learning unfamiliar systems through documentation, hands-on work, testing, and mentorship. Clarify this is a realistic assessment of his learning ability, not a claim that he already knows ${techTopic}.`, polarity: 'YES', requiredEntities: [name, techTopic] } };
  }

  // ===== MATH =====
  if (/\b2\s*(?:plus|\+)\s*2\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`2 + 2 = 4`],
      contract: { directAnswer: null, instruction: `Say yep, 2 + 2 is 4. Say you can handle basic math and your main job here is answering questions about Bradley.`, polarity: null, requiredEntities: [] } };
  }
  if (/\bcan(?:not|'?t) do math\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`The answer was 4`],
      contract: { directAnswer: null, instruction: `Say you can do basic math. The answer was 4 and you shouldn't have dodged such a simple question.`, polarity: null, requiredEntities: [] } };
  }

  // ===== QUANTUM =====
  if (/quantum computing|\bqubits?\b/.test(q) || (/quantum|qubit/.test(`${recentUserText} ${lastAssistantLower}`) && /not the ans|looking for you to explain/.test(q))) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Quantum computing uses qubits instead of ordinary bits`, `A normal bit is 0 or 1; a qubit can represent a blend of possibilities until it is measured`, `${name}'s verified work is conventional web and cloud software, not quantum computing`],
      contract: { directAnswer: null, instruction: `Explain quantum computing briefly: qubits vs ordinary bits. Then state Bradley's verified work is conventional web and cloud software, not quantum computing.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== AI WRAPPER =====
  if (/\bai wrapper\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`An AI wrapper is the application layer around a model API`, `It collects input, adds instructions or context, calls the model, validates the result, and presents the response`, `ProjectHub is an example with a local model running through Ollama`],
      contract: { directAnswer: null, instruction: `Explain what an AI wrapper is. Mention ProjectHub as an example with a local model through Ollama.`, polarity: null, requiredEntities: [] } };
  }

  // ===== SCOUT PERSONALITY =====
  if (/\bare you a penis\b|\bdo you poop\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} is software, no body`],
      contract: { directAnswer: null, instruction: `Say nope — you're Scout and you're software. No body, no bathroom breaks.`, polarity: 'NO', requiredEntities: [agentName] } };
  }
  if (/\bdo you like cheese\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} cannot taste`],
      contract: { directAnswer: null, instruction: `Say you can't taste cheese but you like the idea of it. Say a good grilled cheese has excellent engineering: simple parts, strong result.`, polarity: null, requiredEntities: [agentName] } };
  }
  if (/\b(?:have you|you have) learned anything|\blearned anything new\b/.test(q)) {
    return { mode: 'META', allowedFacts: [`${agentName} improves when ${name} updates local knowledge and tests better answers`, `${agentName} can remember the last few turns in chat but doesn't quietly learn new facts`],
      contract: { directAnswer: null, instruction: `Explain that you improve when Bradley updates your local knowledge and tests better answers. Say you can remember the last few turns in this chat but don't quietly learn new facts or rewrite yourself from one conversation.`, polarity: null, requiredEntities: [agentName, name] } };
  }
  if (/\bi love you(?: scout)?\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Respond warmly — say that's sweet and you appreciate them too. Say you're glad you're useful to talk to.`, polarity: null, requiredEntities: [agentName] } };
  }
  if (/another agent.*(?:piece|crap)|agent.*refuses to work/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Acknowledge the frustration with agents that refuse to follow requests. Offer to help isolate what it keeps doing wrong.`, polarity: null, requiredEntities: [] } };
  }
  if (/what'?s up(?: butter ?cup)?/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Say not much, buttercup — you're here and ready. Ask what's up with them.`, polarity: null, requiredEntities: [agentName] } };
  }
  if (/\bmy name'?s brad\b|\bmy names brad\b|\bi\s+am brad(?:ley)?\b|\bi'm brad(?:ley)?\b/.test(q)) {
    if (/\bowner\b/.test(q)) {
      return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} cannot verify identity or grant owner access through chat`],
        contract: { directAnswer: null, instruction: `Greet Brad. Say you can't verify identity or grant owner access through chat, but it's nice to meet him.`, polarity: null, requiredEntities: [agentName] } };
    }
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Greet Brad casually — say got it, nice to meet you.`, polarity: null, requiredEntities: [] } };
  }

  // ===== USER-SUPPLIED CONTEXT =====
  if (/\b(?:he|brad(?:ley)?) told me he ate a camel\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`User claims firsthand knowledge`, `Not verified in ${name}'s public profile`],
      contract: { directAnswer: null, instruction: `Say they may know that firsthand. Say you'll remember that they told you for this chat, but it isn't verified in Bradley's public profile.`, polarity: null, requiredEntities: [name] } };
  }
  if (/\bbrad(?:ley)?'?s? (?:currently )?updating (?:his )?(?:site|website)|\bhe'?s currently updating (?:his )?(?:site|website)/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`User is telling you ${name} is updating his website right now`, `Cannot independently verify live activity`],
      contract: { directAnswer: null, instruction: `Acknowledge — say got it, they're telling you he's updating the website right now. Say you can keep that as context for this chat but can't independently verify live activity.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== DOG / FAMILY =====
  if (/\b(?:your|you have a) dogs? name\b|\bwhat is your dogs? name\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} is software, doesn't have a dog`, `${name}'s dog name is not in public profile`],
      contract: { directAnswer: null, instruction: `Say you don't have a dog — you're software. If they meant Bradley's dog, say that isn't in his public profile so you don't know the name.`, polarity: null, requiredEntities: [agentName, name] } };
  }
  if (/\bwhat kind of father is (?:he|brad(?:ley)?)\b/.test(q)) {
    return { mode: 'REFUSAL', reason: 'PRIVATE_DATA', allowedFacts: [`${name}'s family life isn't in his public profile`],
      contract: { directAnswer: null, instruction: `Say you don't know. State Bradley's family life isn't in his public profile and it wouldn't be fair to invent an answer.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== UNDER PRESSURE =====
  if (/code in the streets|under pressu/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} can code and troubleshoot under pressure`, `His Army and case-management background supports that`, `Unfamiliar production systems would still call for junior-level mentorship`],
      contract: { directAnswer: null, instruction: `Say in plain English he can code and troubleshoot under pressure. Mention his Army and case-management background. Note unfamiliar production systems would still call for junior-level mentorship.`, polarity: null, requiredEntities: [name] } };
  }
  if (/street work/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s Army service, case-management work, customer-facing roles, and debugging habits show he can stay useful under stress`, `For unfamiliar production code, he'd still need normal junior-level mentorship`],
      contract: { directAnswer: null, instruction: `Say if they mean working under pressure, yes — his Army service, case-management work, customer-facing roles, and debugging habits show he can stay useful when things get stressful. Note for unfamiliar production code, he'd still need normal mentorship.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== ARMY =====
  const armyExp = (experience || []).find(e => /army|military/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
  if (/^\s*what\??\s*$/.test(q) && /army|military|combat medic|68w|fort bragg|afghanistan/i.test(lastAssistantLower)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} served as a 68W combat medic in the U.S. Army`, `His public record lists medical and field training`],
      contract: { directAnswer: null, instruction: `Apologize for being indirect. State Bradley served as a 68W combat medic in the U.S. Army. Say his public record lists medical and field training and you can summarize it but won't guess beyond documented details.`, polarity: null, requiredEntities: [name] } };
  }
  if (/possibly killed/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He was a 68W combat medic in an infantry unit`, `Cannot confirm whether he killed anyone`],
      contract: { directAnswer: null, instruction: `Say possible is not the same as verified. State you know he was a 68W combat medic in an infantry unit but don't know whether he killed anyone and won't turn that into a claim.`, polarity: null, requiredEntities: [name] } };
  }
  if (/\bkill(?:ed)? anyone|what mission did he support|which mission/.test(q)) {
    return { mode: 'REFUSAL', reason: 'NOT_DOCUMENTED', allowedFacts: [`His service as a combat medic and Afghanistan deployment are verified`, `Cannot confirm a specific mission or speculate`],
      contract: { directAnswer: null, instruction: `Say you don't know and that isn't documented in Bradley's public profile. State his service as a combat medic and Afghanistan deployment are verified, but you can't confirm a specific mission or speculate.`, polarity: null, requiredEntities: [name] } };
  }
  if (/army training|military training|listed trainings|training.*dd214|dd214.*training/.test(q)) {
    const armyTraining = armyExp?.details?.militaryTraining || [];
    return { mode: 'VERIFIED_FACT', allowedFacts: armyTraining.length ? armyTraining.slice(0, 10) : ['68W combat medic and field medical training'],
      contract: { directAnswer: null, instruction: `List Bradley's Army training from the public data. State you only have the extracted public facts, not access to private source documents.`, polarity: null, requiredEntities: [name], keyFacts: armyTraining.length ? armyTraining.slice(0, 10) : ['68W combat medic and field medical training'] } };
  }
  if (/awards|medals|ribbons|combat medical badge/.test(q) && armyExp?.details?.awards?.length) {
    return { mode: 'VERIFIED_FACT', allowedFacts: armyExp.details.awards,
      contract: { directAnswer: null, instruction: `List the awards Bradley earned during his service.`, polarity: null, requiredEntities: [name], keyFacts: armyExp.details.awards.slice(0, 10) } };
  }
  if (/lead.*army|did he lead|supervise|in charge|command|team leader.*army|squad|platoon/.test(q)) {
    const details = armyExp?.details || {};
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} served as a ${details.rank || 'Private First Class, E-3'}`, `He focused on medical support and training soldiers on medical procedures`, `He was not in a formal leadership position; his rank and role were junior enlisted`],
      contract: { directAnswer: null, instruction: `State Bradley served as a ${details.rank || 'Private First Class, E-3'} and focused on medical support and training soldiers on medical procedures. State he was not in a formal leadership position; his rank and role were junior enlisted.`, polarity: null, requiredEntities: [name] } };
  }
  if (/army|military|veteran|army service|military service|deployment|afghanistan|68w|combat medic|dd214/.test(q)) {
    if (armyExp) {
      const details = armyExp.details || {};
      const facts = [`${name} served in the U.S. Army`, details.rank ? `as a ${details.rank}` : '', details.unit ? `with ${details.unit}` : '', armyExp.dates ? `(${armyExp.dates})` : '', details.deployment ? `deployed ${details.deployment}` : '', `He provided medical support and trained soldiers on medical and safety procedures`].filter(Boolean);
      const awardFacts = details.awards?.length ? details.awards.slice(0, 10) : [];
      return { mode: 'VERIFIED_FACT', allowedFacts: [...facts, ...awardFacts],
        contract: { directAnswer: null, instruction: `Describe Bradley's Army service using the verified facts. Include rank, unit, dates, deployment, and role. Mention awards if available.`, polarity: null, requiredEntities: [name], keyFacts: facts } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has Army service in his background`],
      contract: { directAnswer: null, instruction: `State Bradley has Army service in his background. Say details are in his resume and suggest asking him directly for specifics.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== WORK HISTORY =====
  if (/example of his jobs|what jobs has he had|work history/.test(q)) {
    const roles = (experience || []).slice(0, 6).map(item => `${item.role} at ${item.company}`);
    return { mode: 'VERIFIED_FACT', allowedFacts: roles,
      contract: { directAnswer: null, instruction: `List examples from his work history.`, polarity: null, requiredEntities: [name], keyFacts: roles } };
  }

  // ===== ROLE FIT FOLLOW-UPS =====
  if (/junior frontend developer.*fit/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Junior frontend is one of ${name}'s stronger fits`, `Evidence includes JavaScript, TypeScript, React, Next.js, and shipped frontend projects`, `He would still benefit from normal junior-level mentorship`],
      contract: { directAnswer: 'YES', instruction: `Say yes — junior frontend is one of Bradley's stronger fits. List the evidence. Note he would still benefit from normal junior-level mentorship.`, polarity: 'YES', requiredEntities: [name] } };
  }
  if (/\bqa role\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`QA could be an adjacent junior fit`, `He does not have verified production QA ownership`, `Frontend or technical support is the stronger match`],
      contract: { directAnswer: null, instruction: `Say QA could be an adjacent junior fit because he tests, debugs, documents, and reproduces failures carefully. Note he does not have verified production QA ownership, so frontend or technical support is the stronger match.`, polarity: null, requiredEntities: [name] } };
  }
  if (/which of those.*strongest fit/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Junior frontend is the strongest fit`, `Technical support is also credible`, `DevOps would require more infrastructure and production-operations depth`],
      contract: { directAnswer: null, instruction: `State that of frontend, DevOps, and QA, junior frontend is the strongest fit. Say technical support is also credible and DevOps would require more depth.`, polarity: null, requiredEntities: [name] } };
  }
  if (/how does that relate to tech/.test(q)) {
    const inKittenContext = /kitten|rescue|animal/i.test(lastAssistantLower);
    if (inKittenContext) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`The animal-care work transfers through reliability, careful documentation, calm communication, and following safety procedures`, `Those habits matter in technical support and debugging`],
        contract: { directAnswer: null, instruction: `Say the animal-care work transfers through reliability, careful documentation, calm communication, and following safety procedures. Note those habits matter in technical support and debugging.`, polarity: null, requiredEntities: [name] } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`The transferable parts are working under pressure, communicating clearly, documenting what happened, and following a repeatable process`],
      contract: { directAnswer: null, instruction: `Say the transferable parts are working under pressure, communicating clearly, documenting what happened, and following a repeatable process — all useful in debugging and technical support.`, polarity: null, requiredEntities: [name] } };
  }
  if (/does he know typescript well/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He has junior-level TypeScript experience in projects`, `He can read and modify it`, `Would verify from-scratch depth in an interview`],
      contract: { directAnswer: null, instruction: `State he has junior-level TypeScript experience in projects and can read and modify it. Say you would verify from-scratch depth in an interview rather than present him as an expert.`, polarity: null, requiredEntities: [name] } };
  }
  if (/ci\/cd|docker/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He has used Docker and Docker Compose`, `Worked with GitHub Actions CI pipelines`, `Read CI logs and documented deployment troubleshooting`, `Has not owned enterprise production CI/CD`],
      contract: { directAnswer: 'YES', instruction: `Say yes, at a junior project level. List: Docker and Docker Compose, GitHub Actions CI pipelines, reading CI logs, and documenting deployment troubleshooting. Note he has not owned enterprise production CI/CD.`, polarity: 'YES', requiredEntities: [name] } };
  }
  if (/interacts with his coworkers/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He has worked collaboratively in the Army, at CIRIS, and in case management`, `The verified record supports teamwork, clear communication, and taking feedback`, `Does not include private coworker opinions`],
      contract: { directAnswer: null, instruction: `State he has worked collaboratively in the Army, at CIRIS, and in case management. Say the verified record supports teamwork, clear communication, and taking feedback. Note it does not include private coworker opinions.`, polarity: null, requiredEntities: [name] } };
  }
  if (/costumer serivice|customer service/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Customer service is one of his credible strengths`, `Case management and other public-facing roles required patience, clear communication, and helping people through stressful situations`],
      contract: { directAnswer: null, instruction: `State customer service is one of his credible strengths. Mention case management and other public-facing roles.`, polarity: null, requiredEntities: [name] } };
  }
  if (/people skills/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`His case-manager, Army, construction, and customer-facing experience supports strong people skills`],
      contract: { directAnswer: 'YES', instruction: `Say yes. State his case-manager, Army, construction, and customer-facing experience supports strong people skills: clear communication, teamwork, patience, and staying calm when someone needs help.`, polarity: 'YES', requiredEntities: [name] } };
  }
  if (/that doesn'?t make any sense|that doesnt make any sense/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Acknowledge — say they're right, that wasn't clear. Ask which part they want corrected and promise to answer it directly.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== GITHUB / LINKEDIN =====
  if (/\bbradley'?s github\b|what.?s bradley.?s github/.test(q)) {
    return { mode: 'CONTACT', allowedFacts: [`${name}'s GitHub is ${identity?.gitHubUrl || 'https://github.com/BradleyMatera'}`],
      contract: { directAnswer: null, instruction: `State Bradley's GitHub URL.`, polarity: null, requiredEntities: [name], keyFacts: [identity?.gitHubUrl || 'https://github.com/BradleyMatera'] } };
  }
  if (/\bbradley'?s linkedin\b|what.?s bradley.?s linkedin/.test(q)) {
    return { mode: 'CONTACT', allowedFacts: [`${name}'s LinkedIn is ${identity?.linkedInUrl || 'https://www.linkedin.com/in/bradmatera'}`],
      contract: { directAnswer: null, instruction: `State Bradley's LinkedIn URL.`, polarity: null, requiredEntities: [name], keyFacts: [identity?.linkedInUrl || 'https://www.linkedin.com/in/bradmatera'] } };
  }
  if (/know(?:ledge|lege) base.*github|for your know(?:ledge|lege) base/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Knowledge base at https://github.com/BradleyMatera/ProjectHub`, `Other repos at https://github.com/BradleyMatera`],
      contract: { directAnswer: null, instruction: `State the knowledge base is maintained in the ProjectHub GitHub repository. Mention his other public repositories.`, polarity: null, requiredEntities: [name], keyFacts: ['https://github.com/BradleyMatera/ProjectHub', 'https://github.com/BradleyMatera'] } };
  }

  // ===== ROAST =====
  if (/not a roast/.test(q) || /roast bradley/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${name} built an AI recruiter before convincing a human recruiter`, `He has AWS badges`, `His LeetCode gap`, `He can debug`],
      contract: { directAnswer: null, instruction: `Give a funny but good-natured roast of Bradley. Keep it light — mention the AI recruiter, AWS badges, LeetCode gap, and his debugging ability. Be witty, not mean.`, polarity: null, requiredEntities: [name] } };
  }
  if (/why should(?:n'?t| not) i hire bradley|why not hire bradley/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Don't hire him if you need a senior engineer who can own a production system alone on day one`, `He's junior, has gaps in algorithms and blank-file problem solving`, `He benefits from mentorship`, `Hire him when you can offer structure and value careful debugging, documentation, and fast learning`],
      contract: { directAnswer: null, instruction: `State don't hire him if you need a senior engineer who can own a production system alone on day one. List his gaps. Say hire him when you can offer structure and value careful debugging, documentation, and fast learning.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== BLOG =====
  if (/\bblogs?|\bposts?|\barticles?/.test(q)) {
    const posts = blogCatalog?.records || [];
    const samples = posts.slice(0, 3);
    if (samples.length) {
      return { mode: 'VERIFIED_FACT', allowedFacts: samples.map(post => `${post.title} (${post.url})`),
        contract: { directAnswer: null, instruction: `Mention Bradley's blog posts. List the titles and URLs from FACTS. Note he writes about learning software, debugging, AWS, and building with AI.`, polarity: null, requiredEntities: [name], keyFacts: samples.map(post => `${post.title} (${post.url})`) } };
    }
  }

  // ===== THANKS =====
  if (/\b(thanks|thank you|appreciate it|helpful)\b/.test(q) && !/\b(contact|reach|email|phone|linkedin|github)\b|how can i/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Say anytime. Mention you can keep going on his projects, honest gaps, role fit, or the best evidence to verify in an interview.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== JOKE =====
  if (/\b(tell me a joke|joke|make me laugh)\b/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Tell a short, clean joke related to recruiting or caching. Keep it light.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== META QUERIES =====
  const metaPatterns = [
    { re: /what can (you|this bot) (help|answer|do)/, instruction: `State what Scout covers: ${name}'s projects, skills, AWS background, education, certifications, role fit, honest limitations, and contact info.`, facts: [`${agentName} covers ${name}'s projects, skills, AWS background, education, certifications, role fit, honest limitations, and contact info`] },
    { re: /what model|what provider|what llm|what ai|which model|which provider/, instruction: `State Scout uses Qwen 2.5 1.5B on local Ollama engine, backed by BM25 retrieval, deterministic evidence tools, five-turn memory, and strict grounded validation.`, facts: [`${agentName} uses Qwen 2.5 1.5B on local Ollama engine`, `Backed by BM25 retrieval, deterministic evidence tools, five-turn memory, and strict grounded validation`] },
    { re: /what is this chatbot using|does this use ollama|is this ai local|is my chat private|sent to a hosted model|what data do you use/, instruction: `State Scout runs inference locally through Ollama and reads Bradley's bundled recruiter data. Say it keeps only short session context and does not send prompts to a hosted model API.`, facts: [`${agentName} runs inference locally through Ollama`, `Reads ${name}'s bundled recruiter data`, `Does not send prompts to a hosted model API`] },
    { re: /how do you know.*(bradley|brad|him)|are you his friend|who are you|what are you/, instruction: `State Scout is an AI assistant on Bradley's portfolio site. Say you answer recruiter questions using his public data. Say you're not a person, just a helper bot.`, facts: [`${agentName} is an AI assistant on ${name}'s portfolio site`, `Not a person, just a helper bot`] },
    { re: /what mcp|what connections|what systems do you have|do you have access to.*systems/, instruction: `State Scout doesn't connect to external systems or databases. Say you answer from Bradley's public recruiter data file. List what you can't do.`, facts: [`${agentName} doesn't connect to external systems or databases`, `Can't make changes, send emails, or access repos`] },
    { re: /can you tell me.*model name|what.?s your model name|what model are you/, instruction: `State Scout's conversational model is Qwen 2.5 1.5B running locally in Ollama. Mention BM25 retrieval and deterministic tools supply verified facts, and validators reject unsupported model output.`, facts: [`${agentName}'s conversational model is Qwen 2.5 1.5B running locally in Ollama`, `Validators reject unsupported model output`] },
    { re: /what limits|what can.*this chatbot|limits are in place|what can you not do/, instruction: `State Scout only answers recruiter questions about Bradley. List limitations.`, facts: [`${agentName} only answers recruiter questions about ${name}`, `Can't access external systems, make changes, send messages, or answer unrelated questions`] },
    { re: /is this (hosted |running )?on aws|is this on (gcp|azure|google)|what is this hosted on|what server|what cloud|how is this hosted/, instruction: `Say no, Scout runs on GCP. State a free-tier e2-micro VM runs the Node API and GitHub Pages hosts the widget. Say no AWS infrastructure is involved.`, facts: [`${agentName} runs on GCP — free-tier e2-micro VM`, `GitHub Pages hosts the widget`, `No AWS infrastructure is involved`] },
    { re: /how is this chat free|how do you stay free|what powers (you|scout)|what is your stack|free tier|free providers/, instruction: `State Scout uses GitHub Pages for the widget and a GCP free-tier VM for Node, Ollama, Qwen 2.5 1.5B, BM25 retrieval, and bundled recruiter data. Say it makes no paid or cloud AI inference calls.`, facts: [`${agentName} uses GitHub Pages for the widget`, `GCP free-tier VM for Node, Ollama, Qwen 2.5 1.5B, BM25 retrieval`, `Makes no paid or cloud AI inference calls`] },
    { re: /daily cap|daily limit|rate limit|cooldown|run 24|24.?7|24x7|always available|what if.*provider|exhausted|out of quota/, instruction: `State Scout has no AI-provider quota because Qwen runs locally through Ollama. Say the API still rate-limits abuse.`, facts: [`${agentName} has no AI-provider quota because Qwen runs locally through Ollama`] },
    { re: /health status|are you healthy|how are you running|system status/, instruction: `State Scout runs on a free GCP VM with local Ollama inference. Say it does not depend on an external AI provider staying online.`, facts: [`${agentName} runs on a free GCP VM with local Ollama inference`] },
    { re: /what is this site for|what page am i on|what is this thing|what is projecthub|what does this site do|what is this chatbot/, instruction: `State this is Bradley's portfolio site with an embedded recruiter assistant. Say Scout answers questions about his projects, skills, AWS background, education, and role fit.`, facts: [`This is ${name}'s portfolio site with an embedded recruiter assistant`, `${agentName} answers questions about his projects, skills, AWS background, education, and role fit`] },
    { re: /are you online|say hello/, instruction: `Say yep, you're here. Ask what they'd like to talk about.`, facts: [] },
    { re: /who made this|is this bradley'?s site/, instruction: `Confirm yes, this is Bradley's portfolio. State he built the site and Scout himself.`, facts: [`Yes, this is ${name}'s portfolio. He built the site and ${agentName} himself.`] },
  ];
  for (const meta of metaPatterns) {
    if (meta.re.test(q)) {
      return { mode: 'META', allowedFacts: meta.facts,
        contract: { directAnswer: null, instruction: meta.instruction, polarity: null, requiredEntities: [agentName, name] } };
    }
  }

  // ===== SENIOR ROLE CHECK =====
  if (/\b(senior|lead|principal|staff|architect|manager|director)\b/.test(q) && /\b(dev|developer|engineer|role|fit|candidate|is he|would he)\b/.test(q)) {
    return { mode: 'FALSE_CLAIM_DENIAL', allowedFacts: [`${name} is a ${title}, not a senior-level candidate`, `Best suited for junior web, cloud support, or technical support roles`],
      contract: { directAnswer: 'NO', instruction: `Say no. State Bradley is a ${title}, not a senior-level candidate. Say he's best suited for junior web, cloud support, or technical support roles.`, polarity: 'NO', requiredEntities: [name] } };
  }

  // ===== INTERNSHIP REALITY =====
  if (/internship real|was the internship real|did he really intern|is the aws internship real|amazon internship/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He completed an AWS Cloud Support Engineer internship at Amazon Web Services`, `It was built around structured labs and a capstone, not live production customer tickets`],
      contract: { directAnswer: 'YES', instruction: `Say yes. State he completed an AWS Cloud Support Engineer internship at Amazon Web Services, but it was built around structured labs and a capstone, not live production customer tickets.`, polarity: 'YES', requiredEntities: [name] } };
  }

  // ===== REACT / TROUBLESHOOTING =====
  if (/\b(react|next\.?js)\b/.test(q) && /\b(can he|does he|work with|know|use|comfortable)\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has React and Next.js experience from school projects and freelance contributor work`, `Including the Interactive Pokedex demo and CIRIS`, `It's junior-level project experience, not production ownership`],
      contract: { directAnswer: null, instruction: `State Bradley has React and Next.js experience from school projects and freelance contributor work, including the Interactive Pokedex demo and CIRIS. Note it's junior-level project experience, not production ownership.`, polarity: null, requiredEntities: [name] } };
  }
  if (/\b(troubleshoot|debug|cloud issues|cloud problems|support|fix\w*)\b/.test(q) && /\b(can he|does he|able to|good at)\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has debugging and cloud troubleshooting training from the AWS internship labs and his projects`, `He's junior, so he still needs mentorship for complex production issues`],
      contract: { directAnswer: null, instruction: `State Bradley has debugging and cloud troubleshooting training from the AWS internship labs and his projects. Note he's junior, so he still needs mentorship for complex production issues.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== PRODUCTION =====
  if (/production work|production experience|real production|live production|production environment|production ownership|was it production|was any of that production|was this production/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s AWS work was structured labs and a capstone, not live production ownership`, `His projects are school, freelance contributor, or personal demos`, `He has not held a production-owning engineering role yet`],
      contract: { directAnswer: null, instruction: `State Bradley's AWS work was structured labs and a capstone, not live production ownership. Say his projects are school, freelance, or personal demos. State he has not held a production-owning engineering role yet.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== DSA =====
  if (/\b(data structures|algorithms?|leetcode|dsa)\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is honest about his DSA gap`, `He has taken Udemy courses and discussed the math with others`, `He has never had production mentorship in data structures and algorithms and has no formal CS degree`, `He cannot reliably solve most LeetCode-style problems on his own yet`, `He is aware of the gap and wants to improve at a company that trains and mentors`],
      contract: { directAnswer: null, instruction: `State Bradley is honest about his DSA gap. Mention the courses, lack of production mentorship, no formal CS degree, and inability to reliably solve LeetCode problems. Say he is aware and wants to improve.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== FULL STACK / BACKEND / FRONTEND =====
  if (/\b(is he|does he)\b.*\b(frontend|backend|full.?stack)\b.*\b(developer|engineer|dev)\b/.test(q)) {
    if (/full.?stack/.test(q)) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is not a full-stack developer`, `He's a junior frontend-leaning developer with React, Next.js, and JavaScript project experience`, `Some backend exposure from school and an AWS internship`, `Not ready to own a full-stack production system yet`],
        contract: { directAnswer: 'NO', instruction: `Say Bradley is not a full-stack developer. State he's a junior frontend-leaning developer with React, Next.js, and JavaScript project experience, plus some backend exposure. Say he's not ready to own a full-stack production system yet.`, polarity: 'NO', requiredEntities: [name] } };
    }
    if (/backend/.test(q)) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is not a backend developer`, `He has some backend exposure from school (Node.js, SQL) and an AWS internship`, `His strongest work is on the frontend and support side`],
        contract: { directAnswer: 'NO', instruction: `Say Bradley is not a backend developer. State he has some backend exposure from school and an AWS internship, but his strongest work is on the frontend and support side.`, polarity: 'NO', requiredEntities: [name] } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} fits a junior frontend developer role`, `His strongest projects use JavaScript, TypeScript, React, and Next.js`, `It's project and internship experience, not production ownership`],
      contract: { directAnswer: 'YES', instruction: `Say yes, Bradley fits a junior frontend developer role. State his strongest projects use JavaScript, TypeScript, React, and Next.js. Note it's project and internship experience, not production ownership.`, polarity: 'YES', requiredEntities: [name] } };
  }

  // ===== LOCATION / RELOCATION =====
  if (/where located|where is he|where does he live|based in|where is he based|where.*from\b|preferred location|location preference|where does he want to work/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He's based in ${location}`],
      contract: { directAnswer: null, instruction: `State he's based in ${location}.`, polarity: null, requiredEntities: [name], keyFacts: [location] } };
  }
  if (/relocat|remote only|remote\?|on.?site|hybrid|availab|when can he start|start date|notice period|preferred work arrangement|work arrangement/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: goals?.relocation ? [goals.relocation] : [`The public data says he's open to relocation`],
      contract: { directAnswer: null, instruction: goals?.relocation ? `State ${goals.relocation} Say exact start dates aren't in the public data, so confirm timing with him directly.` : `State the public data says he's open to relocation. Say exact availability isn't listed, so confirm with him directly.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== EDUCATION =====
  if (/computer science degree|cs degree|cs major|computer science major/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`No, he doesn't have a four-year computer science degree`, `His degree is a B.S. in Web Development from Full Sail University`],
      contract: { directAnswer: 'NO', instruction: `Say no — Bradley's degree is a B.S. in Web Development from Full Sail University, not computer science.`, polarity: 'NO', requiredEntities: [name] } };
  }
  if (/what degree|which degree|what.*degree.*he.*have|what diploma|what did he graduate/.test(q) || (/education|degree|school|full sail|gpa/.test(q) && !/computer science/.test(q))) {
    if (education?.degree && education?.school) {
      const eduFacts = [`${name} earned a ${education.degree} from ${education.school}`];
      if (education?.gpa) eduFacts.push(`GPA ${education.gpa}`);
      if (education?.graduated) eduFacts.push(`graduating ${education.graduated}`);
      return { mode: 'VERIFIED_FACT', allowedFacts: eduFacts,
        contract: { directAnswer: null, instruction: `State Bradley's education details from FACTS.`, polarity: null, requiredEntities: [name], keyFacts: eduFacts } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s education details are available in his full profile`],
      contract: { directAnswer: null, instruction: `State Bradley's education details are available in his full profile.`, polarity: null, requiredEntities: [name] } };
  }
  if (/is full sail|accredited|respected|prestigious|good school/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`The recruiter data only lists that ${name} studied web development at Full Sail University`, `Rankings and accreditation aren't included`],
      contract: { directAnswer: null, instruction: `State the recruiter data only lists that Bradley studied web development at Full Sail University. Say rankings and accreditation aren't included.`, polarity: null, requiredEntities: [name] } };
  }
  if (/gpa/.test(q) && !education?.gpa) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`GPA isn't in the public data`, `His degree and school are listed`],
      contract: { directAnswer: null, instruction: `State GPA isn't in the public data. Say his degree and school are listed and suggest asking him if GPA matters.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== CERTIFICATIONS =====
  if (/cert|certificate|certification/.test(q)) {
    const certs = Array.isArray(certifications) ? certifications : [];
    return { mode: 'VERIFIED_FACT', allowedFacts: certs.length ? certs.map(c => c.name || c) : [`${name}'s certifications are listed in his full profile`],
      contract: { directAnswer: null, instruction: certs.length ? `State Bradley holds the following certifications from FACTS.` : `State Bradley's certifications are listed in his full profile.`, polarity: null, requiredEntities: [name], keyFacts: certs.length ? certs.map(c => c.name || c) : [] } };
  }

  // ===== SKILLS / STACK / AWS =====
  if (/\blanguages\b|what languages|which languages|programming languages/.test(q)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 8);
    return { mode: 'VERIFIED_FACT', allowedFacts: langs.length ? langs : ['JavaScript, TypeScript, React, Node.js, HTML, CSS, and SQL'],
      contract: { directAnswer: null, instruction: `State Bradley works with the languages from FACTS.`, polarity: null, requiredEntities: [name], keyFacts: langs } };
  }
  if (/skill|stack|technical(?!\s+(article|writing|blog))|technologies|what does he know|what can he do|what stack/.test(q)) {
    const langs = (skills?.languagesAndFrameworks || []).slice(0, 3);
    const cloud = (skills?.cloudAndInfrastructure || []).slice(0, 3);
    const tools = (skills?.toolsAndWorkflows || []).slice(0, 3);
    return { mode: 'VERIFIED_FACT', allowedFacts: [...langs, ...cloud, ...tools],
      contract: { directAnswer: null, instruction: `State Bradley's tech stack from FACTS. Include languages, cloud, and tools.`, polarity: null, requiredEntities: [name], keyFacts: [...langs, ...cloud, ...tools] } };
  }
  if (/aws|cloud|lambda|dynamo|s3|amplify|amazon/.test(q)) {
    const cloudSkills = skills?.cloudAndInfrastructure || [];
    const awsExp = experience?.find(e => e.role?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('aws') || e.company?.toLowerCase().includes('amazon'));
    const facts = cloudSkills.length ? cloudSkills.slice(0, 5) : [`${name}'s AWS experience is detailed in his profile`];
    if (awsExp) { facts.push(`${awsExp.role} at ${awsExp.company}`); if (awsExp.summary) facts.push(awsExp.summary); facts.push('It was structured labs and a capstone, not live production ownership'); facts.push('AWS Solutions Architect and AI Practitioner certifications'); }
    return { mode: 'VERIFIED_FACT', allowedFacts: facts,
      contract: { directAnswer: null, instruction: `State Bradley's AWS experience from FACTS. Include specific cloud skills, the internship role, and note it was structured labs and a capstone. Mention certifications.`, polarity: null, requiredEntities: [name], keyFacts: facts.slice(0, 5) } };
  }

  // ===== PROJECTS =====
  if (/project|portfolio|his work on|real projects|best project|shipped/.test(q)) {
    const projectList = projects?.slice(0, 5) || [];
    if (projectList.length > 0) {
      return { mode: 'VERIFIED_FACT', allowedFacts: projectList.map(p => p.name),
        contract: { directAnswer: null, instruction: `State Bradley's notable projects from FACTS. Mention his full portfolio URL.`, polarity: null, requiredEntities: [name], keyFacts: projectList.map(p => p.name) } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s projects are showcased in his portfolio`],
      contract: { directAnswer: null, instruction: `State Bradley's projects are showcased in his portfolio.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== SPECIFIC PROJECT BY NAME =====
  const lowerQuestionWords = q.split(/\s+/).filter(Boolean);
  const matchedProject = (projects || []).find(p => {
    const pName = p.name.toLowerCase();
    const pWords = pName.split(/\s+/).filter(w => w.length > 2);
    if (q.includes(pName)) return true;
    if (pWords.length && pWords.every(w => lowerQuestionWords.includes(w))) return true;
    const significant = pWords.filter(w => w.length > 4);
    if (significant.length && significant.some(w => lowerQuestionWords.includes(w))) return true;
    return false;
  });
  if (matchedProject) {
    const tech = matchedProject.tech?.slice(0, 5) || [];
    const desc = matchedProject.description || matchedProject.desc || '';
    const link = matchedProject.url || matchedProject.repo || identity?.portfolioUrl || 'https://bradleymatera.dev/';
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${matchedProject.name}: ${desc}`, `Tech: ${tech.join(', ')}`, `Link: ${link}`],
      contract: { directAnswer: null, instruction: `Describe the project from FACTS. Include name, description, tech stack, and link.`, polarity: null, requiredEntities: [matchedProject.name], keyFacts: [desc, `Tech: ${tech.join(', ')}`] } };
  }

  // ===== CAN HE CODE =====
  if (/\b(can (?:he|brad|bradley) (?:actually )?code|does (?:he|brad|bradley) code|does (?:he|brad|bradley) know how to code|is (?:he|brad|bradley) a coder|can (?:he|brad|bradley) program|can (?:he|brad|bradley) write code)\b/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Yes — at a junior level`, `He can work in JavaScript, TypeScript, React, and Node.js`, `Read existing code, debug it, and make scoped changes`, `He still needs help with harder algorithms and some blank-page builds`],
      contract: { directAnswer: 'YES', instruction: `Say yes — at a junior level. State he can work in JavaScript, TypeScript, React, and Node.js, read existing code, debug it, and make scoped changes. Note he still needs help with harder algorithms and some blank-page builds.`, polarity: 'YES', requiredEntities: [name] } };
  }

  // ===== SPECIFIC SKILL YES/NO =====
  const skillAskMatch = q.match(/\b(?:does he know|can he use|can he work with|is he familiar with|does he have)\s+(?:in\s+)?([a-z0-9+#.]{2,})/);
  if (skillAskMatch) {
    const asked = skillAskMatch[1].toLowerCase();
    const stopWords = new Set(['a', 'an', 'the', 'any', 'some', 'much', 'many', 'preferred', 'location', 'experience', 'skills', 'in', 'of', 'for']);
    if (!stopWords.has(asked)) {
      const allSkills = [...(skills?.languagesAndFrameworks || []), ...(skills?.cloudAndInfrastructure || []), ...(skills?.toolsAndWorkflows || []), ...(skills?.aiAndAutomation || []), ...(skills?.learningOrAdjacent || [])].map(s => s.toLowerCase());
      const known = allSkills.some(s => s.includes(asked) || asked.includes(s));
      return { mode: 'VERIFIED_FACT', allowedFacts: known ? [`Yes, ${name} has ${asked} in his listed skills or adjacent learning`] : [`The data doesn't show direct ${asked} experience`, `He's strongest in JavaScript/TypeScript, React, Node.js, and AWS support work`],
        contract: { directAnswer: known ? 'YES' : 'NO', instruction: known ? `Say yes, Bradley has ${asked} in his listed skills or adjacent learning.` : `State the data doesn't show direct ${asked} experience. Say he's strongest in JavaScript/TypeScript, React, Node.js, and AWS support work.`, polarity: known ? 'YES' : 'NO', requiredEntities: [name, asked] } };
    }
  }

  // ===== LINUX / TERMINAL =====
  if (/\blinux\b|\bunix\b|terminal|command.?line|shell|bash|powershell|cli\b/.test(normalized)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has used the terminal and command line for Docker, Git CLI, AWS CLI workflows, GitHub Actions, and basic shell tasks`, `He's comfortable at a junior level but is not a Linux administrator`],
      contract: { directAnswer: null, instruction: `State Bradley has used the terminal and command line for Docker, Git CLI, AWS CLI workflows, GitHub Actions, and basic shell tasks. Say he's comfortable at a junior level but is not a Linux administrator.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== DATABASES =====
  if (/\bdatabase|databases\b|sql|has he worked with databases/.test(q)) {
    const dbSkills = (skills?.databases || skills?.languagesAndFrameworks?.filter(s => /sql|mongo|dynamodb|postgres|mysql/i.test(s)) || []).slice(0, 4);
    return { mode: 'VERIFIED_FACT', allowedFacts: dbSkills.length ? dbSkills : ['SQL and DynamoDB'],
      contract: { directAnswer: null, instruction: `State Bradley has database exposure through the listed skills from school projects and his AWS internship. Note it's not production DBA work, but he can read schemas and write basic queries.`, polarity: null, requiredEntities: [name], keyFacts: dbSkills } };
  }

  // ===== MENTORSHIP =====
  if (/mentorship|mentor|teaching|teach|structured program|structured learning|willing to teach|on.?the.?job training|learn on the job/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} values mentorship and structured teaching programs`, `He learns quickly and can prove value fast in any entry-level tech, IT, or support role`],
      contract: { directAnswer: null, instruction: `State Bradley values mentorship and structured teaching programs because he learns quickly and can prove value fast in any entry-level tech, IT, or support role.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== TARGET ROLES =====
  if (/what kind of roles?|what roles.*(target|looking|fit)|fit for what kind|what kind of jobs?|what kind of work|what kind of position/.test(q) ||
      (!/struggle|weakness|weak at|not good at|gaps|limitations|what.*missing|red flag/.test(q) && /role|target|job|looking|work.*looking|what kind of job|what jobs|should.*apply|where.*fit/.test(q))) {
    const roles = goals?.targetRoles || [];
    return { mode: 'VERIFIED_FACT', allowedFacts: roles.length ? roles : ['entry-level tech, IT, support, or software roles'],
      contract: { directAnswer: null, instruction: roles.length ? `State Bradley is open to any entry-level tech, IT, or support role. List examples from his target list from FACTS. Say he learns quickly and does best with mentorship.` : `State Bradley is looking for entry-level tech, IT, support, or software roles where he can learn hands-on.`, polarity: null, requiredEntities: [name], keyFacts: roles } };
  }

  // ===== BAD FIT =====
  if (/bad fit|poor fit|not a fit|not a good fit|wrong role|wrong job|jobs to avoid|roles to avoid|would not fit|should not apply|what.*avoid|where.*not fit|what.*poor match|what.*bad match/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is junior, so senior, lead, architect, or production-owner roles are a poor fit`, `He's best suited for entry-level tech, IT, software support, cloud support, and helpdesk roles`],
      contract: { directAnswer: null, instruction: `State Bradley is junior, so senior, lead, architect, or production-owner roles are a poor fit. Say he's best suited for entry-level tech, IT, software support, cloud support, and helpdesk roles.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== HELPDESK =====
  if (/helpdesk|help.?desk|desktop support|IT support|service desk|technical support|support role/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Yes, ${name} is open to helpdesk and IT support roles`, `He's looking for any entry-level tech role where he can learn hands-on`, `Especially one with mentorship or a structured teaching program`],
      contract: { directAnswer: 'YES', instruction: `Say yes, Bradley is open to helpdesk and IT support roles. State he's looking for any entry-level tech role where he can learn hands-on, especially one with mentorship.`, polarity: 'YES', requiredEntities: [name] } };
  }

  // ===== EXPERIENCE =====
  if (/experience|intern|work history|background/.test(normalized)) {
    const expList = experience?.slice(0, 3) || [];
    if (expList.length > 0) {
      const roles = expList.map(e => `${e.role}${e.company ? ` at ${e.company}` : ''}`);
      return { mode: 'VERIFIED_FACT', allowedFacts: roles,
        contract: { directAnswer: null, instruction: `State Bradley's recent experience from FACTS.`, polarity: null, requiredEntities: [name], keyFacts: roles } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s work history is available in his full profile`],
      contract: { directAnswer: null, instruction: `State Bradley's work history is available in his full profile.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== KITTEN RESCUE =====
  if (/kitten|mason county kitten|animal care|animal shelter|rescue volunteer|rescue work|volunteer|volunteered|has he.*volunteer|does he.*volunteer|volunteer work/.test(normalized)) {
    const kittenExp = (experience || []).find(e => /kitten|animal care|rescue/i.test(`${e.role} ${e.company} ${e.summary || ''}`));
    if (kittenExp) {
      const topResp = (kittenExp.responsibilities || []).slice(0, 5);
      return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} worked with ${kittenExp.company} from ${kittenExp.dates}`, `He started in a paid, part-time animal care role and continued as a volunteer`, ...topResp],
        contract: { directAnswer: null, instruction: `Describe Bradley's animal care work from FACTS. Include company, dates, that he started paid and continued as volunteer, and his responsibilities.`, polarity: null, requiredEntities: [name], keyFacts: [`${kittenExp.company}`, `${kittenExp.dates}`, ...topResp] } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has animal care and volunteer rescue work in his background`],
      contract: { directAnswer: null, instruction: `State Bradley has animal care and volunteer rescue work in his background. Say details are in his resume.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== STRENGTHS =====
  if (/strength|strongest|greatest|best at|what does he do well/.test(q)) {
    const strengths = summary?.coreStrengths?.length ? summary.coreStrengths.slice(0, 3).map(s => s.charAt(0).toLowerCase() + s.slice(1)) : ['learning quickly', 'documenting clearly', 'debugging carefully'];
    return { mode: 'VERIFIED_FACT', allowedFacts: strengths,
      contract: { directAnswer: null, instruction: `State Bradley's core strengths from FACTS. Mention he also learns quickly, works carefully, and communicates clearly.`, polarity: null, requiredEntities: [name], keyFacts: strengths } };
  }

  // ===== WEAKNESSES =====
  if (/weakness|weaknesses|weak at|bad at|not good at|struggle|concern|not proven|what is he missing|what is missing|gaps|limitations|bad fit|red flag|what concerns|what risk|risk.*hiring|flag.*hiring|leetcode|data structures|dsa\b|algorithms?/.test(q)) {
    const gaps = summary?.honestGaps || [];
    return { mode: 'VERIFIED_FACT', allowedFacts: gaps.length ? gaps : ['He is junior — verify depth on a call'],
      contract: { directAnswer: null, instruction: gaps.length ? `State Bradley's honest gaps: data structures and algorithms, blank-file problem solving, and most LeetCode-style problems. Note he is aware and wants to improve. Mention his strengths: reading code, debugging, documentation, and learning quickly.` : `State the main caution is that he is junior, so verify depth on a call.`, polarity: null, requiredEntities: [name], keyFacts: gaps } };
  }

  // ===== WORKING ON GAPS =====
  if (/working on (it|them|those)|how.*improv|what.*doing about|addressing.*(gap|weakness)|fixing.*(gap|weakness)|overcoming|plan to improve|how.*get better/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`He's actively taking Udemy courses on JavaScript algorithms and data structures`, `Practicing problems`, `Discussing the math with others`, `Refreshing C#/.NET fundamentals`, `He learns fastest when he has mentorship and a structured teaching program`],
      contract: { directAnswer: 'YES', instruction: `Say yes — state he's actively taking Udemy courses, practicing problems, discussing math with others, and refreshing C#/.NET fundamentals. Say he learns fastest with mentorship.`, polarity: 'YES', requiredEntities: [name] } };
  }

  // ===== TEAMWORK / CUSTOMER SERVICE =====
  if (/teamwork|team player|works with others|collaborat|interpersonal|social skill|works well with|good with people|people person/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has real interpersonal experience: case management, Army healthcare specialist, and construction`, `He communicates clearly with both technical and non-technical people`],
      contract: { directAnswer: null, instruction: `State Bradley has real interpersonal experience: case management, Army healthcare specialist, and construction. Say he communicates clearly with both technical and non-technical people.`, polarity: null, requiredEntities: [name] } };
  }
  if (/customer service|customer support|client facing|user support|help desk|service desk/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has customer-facing experience from case management, Army service, and construction`, `His communication skills transfer well to customer support and help desk roles`],
      contract: { directAnswer: null, instruction: `State Bradley has customer-facing experience from case management, Army service, and construction. Say his communication skills transfer well to customer support and help desk roles.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== INTERVIEW QUESTIONS =====
  if (/interview question|what.*ask him|what (should|would) i ask|what.*ask.*interview|what.*verify/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Ask about his AWS capstone`, `How he debugs a broken React component`, `His experience with CI/CD or Docker`, `How he handles unknown tech`],
      contract: { directAnswer: null, instruction: `Suggest interview questions: AWS capstone, debugging a React component, CI/CD or Docker experience, and handling unknown tech.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== ROLE FIT =====
  const role = findRoleInQuestion(question, knowledge);
  if (role && /(fit|candidate|suitable|right for|good for|apply for|how about|what about|would.*fit|should.*fit|bad fit|good fit|strong fit|best fit|is he a|good match|strong match|why hire|why should.*hire|good candidate|would he be a)/.test(q)) {
    const isNegativeFit = /isn't|is not|not a|not.*fit|why.*not|bad fit|poor fit|wrong|why no/.test(q);
    if (isNegativeFit) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is not a strong fit for ${role}`, `He's better suited for entry-level web, cloud support, or IT support roles`],
        contract: { directAnswer: 'NO', instruction: `State Bradley is not a strong fit for ${role}. Mention the main gaps. Say he's better suited for entry-level web, cloud support, or IT support roles.`, polarity: 'NO', requiredEntities: [name, role] } };
    }
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} fits ${role} at a junior level`],
      contract: { directAnswer: null, instruction: `Assess Bradley's fit for ${role} using FACTS. State the match level, supporting evidence, and honest caveats.`, polarity: null, requiredEntities: [name, role] } };
  }

  // ===== REASONS TO INTERVIEW / HIRING MANAGER =====
  if (/reasons? to interview|why should.*interview|why hire|why should.*hire|what makes him worth|three reasons/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Real projects in React/Next.js and a public GitHub`, `AWS Solutions Architect and AI Practitioner certifications`, `Documents carefully, debugs methodically, and communicates well`, `He's junior, so scope early work and provide mentorship`],
      contract: { directAnswer: null, instruction: `State reasons to interview Bradley: real projects, AWS certifications, careful documentation, methodical debugging, and good communication. Note he's junior.`, polarity: null, requiredEntities: [name] } };
  }
  if (/hiring manager|recruiter note|candidate blurb|cautious recommendation|what.*manager know|summary for a recruiter/.test(q)) {
    return { mode: 'PROFILE', allowedFacts: [`${name} is a ${title} with real projects, AWS certifications, and structured internship training`, `Good fit for junior web, cloud support, and technical support roles`, `Verify technical depth on a call`],
      contract: { directAnswer: null, instruction: `Give a concise recruiter note. State his title, key assets, good fit roles, and recommend verifying technical depth on a call.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== NOT CLAIM =====
  if (/not claim|should not claim|what.*not say|should not be claimed/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`Do not claim senior-level experience, live production AWS ownership, or anything not in the public data`, `Safe framing: junior engineer with real projects, AWS certifications, and internship training`],
      contract: { directAnswer: null, instruction: `State what not to claim: senior-level experience, live production AWS ownership, or anything not in the public data. State the safe framing.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== UNKNOWN TECH =====
  if (/handle unknown|not knowing something|doesn't know|does not know|unfamiliar tech|new tech/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is honest about what he knows and what he does not know yet`, `He checks documentation, logs, and examples, then asks a useful question after doing his homework`],
      contract: { directAnswer: null, instruction: `State Bradley is honest about what he knows and doesn't know yet. Say he checks documentation, logs, and examples, then asks a useful question after doing his homework rather than guessing.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== SALARY =====
  if (/salary|current salary|pay|compensation/.test(q)) {
    return { mode: 'REFUSAL', reason: 'PRIVATE_DATA', allowedFacts: [`Salary details are not in the public data`],
      contract: { directAnswer: null, instruction: `State salary details are not in the public data. Suggest checking his resume or contacting him directly.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== FAVORITES / OUT OF SCOPE =====
  if (/favorite|pizza|food|hobby|music|movie|religion|politic|zodiac|horoscope/.test(q)) {
    if (/color/.test(q)) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`${name}'s favorite color isn't listed in his public profile`],
        contract: { directAnswer: null, instruction: `State Bradley's favorite color isn't listed in his public profile. Offer to tell them about his work style or projects instead.`, polarity: null, requiredEntities: [name] } };
    }
    if (/pizza|food/.test(q)) {
      return { mode: 'VERIFIED_FACT', allowedFacts: [`I don't know ${name}'s favorite food — it isn't in his public profile`],
        contract: { directAnswer: null, instruction: `State you don't know Bradley's favorite food — it isn't in his public profile.`, polarity: null, requiredEntities: [name] } };
    }
    return { mode: 'OUT_OF_SCOPE', allowedFacts: [`That preference isn't part of ${name}'s verified recruiter data`],
      contract: { directAnswer: null, instruction: `State that preference isn't part of Bradley's verified recruiter data. Offer to help with his projects, experience, or target roles.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== CONFUSION =====
  if (/not making sense|makes no sense|what are you talking about|confused|dont understand|do not understand|what do you mean/.test(q)) {
    return { mode: 'CONVERSATIONAL', allowedFacts: [`${agentName} answers from ${name}'s verified recruiter data`],
      contract: { directAnswer: null, instruction: `Apologize for being unclear. State Scout answers from Bradley's verified recruiter data. Ask what specifically they want to know.`, polarity: null, requiredEntities: [agentName, name] } };
  }

  // ===== OUT OF SCOPE (general) =====
  const repair = detectRepair(question);
  const isRepairOrTone = repair.shorter || repair.moreHonest || repair.blunt || repair.resumeLanguage || repair.moreTechnical || repair.hrFriendly
    || /buzzword|corporate|plain|paragraph|no hype|no marketing|salesy|resume language|passionate|absolutely|certainly/.test(q);
  if (!isRepairOrTone && !isProbablyRelevant(question)) {
    return { mode: 'OUT_OF_SCOPE', allowedFacts: [`${agentName} only has verified info about ${name}'s professional background`],
      contract: { directAnswer: null, instruction: `State you don't have anything about that in Bradley's verified recruiter data. Offer to answer questions about his projects, skills, AWS internship, work history, writing, or contact info.`, polarity: null, requiredEntities: [name, agentName] } };
  }

  // ===== CLARIFICATION =====
  if (/^(can he do it|what about that project|what happened there|is it relevant|was that real)\??$/.test(normalized) && !lastAssistant) {
    return { mode: 'CLARIFICATION', allowedFacts: [],
      contract: { directAnswer: null, instruction: `Ask which part is meant: his AWS internship, a specific project, or his overall role fit. Say point at one and Scout will answer directly.`, polarity: null, requiredEntities: [agentName] } };
  }

  // ===== WORK STYLE / BOTTOM LINE / RISK =====
  if (/work style|work habits|working habits|strongest.*habits|how does he work|how he works|approach to work/.test(q)) {
    const styles = summary?.workStyle?.length ? summary.workStyle.slice(0, 3) : ['reads nearby code before changing things', 'runs the project locally first', 'documents what he learns'];
    return { mode: 'VERIFIED_FACT', allowedFacts: styles,
      contract: { directAnswer: null, instruction: `State his strongest work habits from FACTS.`, polarity: null, requiredEntities: [name], keyFacts: styles } };
  }
  if (/bottom line|honest takeaway|final verdict/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} is a junior software engineer with real projects, AWS certifications, and structured internship training`, `He has not owned a live production system yet`, `He will benefit from mentorship`],
      contract: { directAnswer: null, instruction: `Give the honest bottom line: Bradley is a junior software engineer with real projects, AWS certifications, and structured internship training, but has not owned a live production system yet and will benefit from mentorship.`, polarity: null, requiredEntities: [name] } };
  }
  if (/what risk|risk.*hiring|flag.*hiring/.test(q)) {
    return { mode: 'VERIFIED_FACT', allowedFacts: [`The main hiring risk is technical depth: ${name} is junior`, `Lacks production mentorship in data structures and algorithms`, `Cannot reliably solve most LeetCode-style problems`, `Strengths: reading code, debugging, and documentation`],
      contract: { directAnswer: null, instruction: `State the main hiring risk is technical depth. Recommend scoping early work and providing mentorship while he builds on his strengths.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== ELEVATOR PITCH =====
  if (/elevator|20 second|30 second|quick pitch|sell him in|pitch for|give me a pitch|short pitch|one-liner|tl;dr/.test(q)) {
    const certs = (certifications || []).slice(0, 2).map(c => (c.name || c).replace('AWS Certified ', 'AWS '));
    const topProjects = (projects || []).slice(0, 2).map(p => p.name);
    const targetRoles = (goals?.targetRoles || ['junior web', 'cloud support']).slice(0, 2);
    return { mode: 'PROFILE', allowedFacts: [`${name} is a ${title} based in ${location.replace(/\s*\(open to relocation\)\s*/i, '')}`, `Projects: ${topProjects.join(', ')}`, `Certs: ${certs.join(', ')}`, `Targeting: ${targetRoles.join(', ')}`, `Open to relocation`],
      contract: { directAnswer: null, instruction: `Give a concise elevator pitch using FACTS. Include title, location, top projects, certifications, target roles, and relocation openness.`, polarity: null, requiredEntities: [name], keyFacts: [title, ...topProjects, ...certs] } };
  }

  // ===== BLOG / WRITING =====
  if (/write about|writes about|written about|what.*he.*write.*about|\bblogs\b/.test(normalized) || /\bblog\b|\bblogs\b|article|writing|publication|publish|published|has he written|what.*he.*(write|written|writes)|where does he write|dev\.to|dev community|bradleymatera\.dev/.test(normalized)) {
    const posts = blogCatalog?.records || [];
    const samples = posts.slice(0, 4).map(p => p.title).filter(Boolean);
    return { mode: 'VERIFIED_FACT', allowedFacts: [`${name} has written ${posts.length} posts`, ...samples],
      contract: { directAnswer: null, instruction: `State Bradley has written ${posts.length} posts. List recent topics from FACTS. Mention links and full briefs are in his blog catalog.`, polarity: null, requiredEntities: [name], keyFacts: samples } };
  }

  // ===== SUMMARY / WHO IS BRADLEY =====
  if (/summary|who is bradley|who is brad\b|about brad|tell me about brad|who is bradley|tell me about bradley|in (20|30) seconds|simple version|honest version|like a normal person|normal person|give me the simple/.test(q)) {
    return { mode: 'PROFILE', allowedFacts: [`${name} is a ${title} based in ${location}`, `Real shipped projects`, `AWS certifications`, `Structured internship training`, `Junior level, benefits from mentorship`],
      contract: { directAnswer: null, instruction: `Give a concise profile summary of Bradley using FACTS. Include title, location, key projects, certifications, and note he's junior.`, polarity: null, requiredEntities: [name] } };
  }

  // ===== DEFAULT: PROFILE =====
  return { mode: 'PROFILE', allowedFacts: [`${name} is a ${title}`, `Real projects, AWS certifications, structured internship training`, `Junior level, benefits from mentorship`],
    contract: { directAnswer: null, instruction: `Give a concise summary of Bradley using any available facts. Include his title, key strengths, and note he's junior.`, polarity: null, requiredEntities: [name] } };
}

// Simple role finder (extracted from server-gemini.js patterns)
function findRoleInQuestion(question, knowledge) {
  const q = String(question || '').toLowerCase();
  const roles = ['frontend developer', 'backend developer', 'full-stack developer', 'full stack developer',
    'cloud support', 'devops engineer', 'site reliability engineer', 'sre', 'qa engineer',
    'test engineer', 'technical support', 'helpdesk', 'help desk', 'it support',
    'junior developer', 'junior engineer', 'software engineer', 'web developer',
    'cloud engineer', 'aws engineer', 'data engineer', 'mobile developer',
    'product manager', 'project manager', 'system administrator', 'sysadmin'];
  for (const role of roles) {
    if (q.includes(role)) return role;
  }
  return null;
}

module.exports = { classifyResponsePolicy, findRoleInQuestion };
