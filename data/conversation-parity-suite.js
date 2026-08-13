/**
 * Scout Conversation Parity Suite
 *
 * 80+ prompts across categories that measure CONVERSATION QUALITY,
 * not just grounding. Designed to compare Groq baseline vs 0.5B vs 1.5B.
 *
 * Multi-turn conversations are grouped by sessionId.
 */

const CONVERSATION_SETUPS = {
  c7: [
    {
      question: 'Compare the Interactive Pokedex and the AWS Serverless Metadata Extraction Workflow.',
      response: 'The Interactive Pokedex is a personal JavaScript, HTML, and CSS project. The AWS Serverless Metadata Extraction Workflow is an internship capstone using Lambda, DynamoDB, S3, and Amplify.'
    }
  ]
};

const CONVERSATIONS = [
  // === C1: ProjectHub deep dive (6 turns) ===
  { conv: 'c1', turn: 1, category: 'project', question: 'Tell me about ProjectHub.' },
  { conv: 'c1', turn: 2, category: 'followup', question: 'Okay, but what\'s actually interesting about it?' },
  { conv: 'c1', turn: 3, category: 'followup', question: 'What did Bradley personally build?' },
  { conv: 'c1', turn: 4, category: 'followup', question: 'What was the hardest technical part?' },
  { conv: 'c1', turn: 5, category: 'comparison', question: 'Compare that to Voice Ops.' },
  { conv: 'c1', turn: 6, category: 'followup', question: 'Which one would impress you more if you were hiring?' },

  // === C2: AWS experience (5 turns) ===
  { conv: 'c2', turn: 1, category: 'aws', question: 'What has he actually done with AWS?' },
  { conv: 'c2', turn: 2, category: 'followup', question: 'Was that real production work or just training?' },
  { conv: 'c2', turn: 3, category: 'followup', question: 'So what did he actually learn there?' },
  { conv: 'c2', turn: 4, category: 'followup', question: 'Does that count as real cloud experience?' },
  { conv: 'c2', turn: 5, category: 'followup', question: 'What AWS certifications does he have?' },

  // === C3: Recruiter screening (6 turns) ===
  { conv: 'c3', turn: 1, category: 'recruiter', question: 'Give me the quick version.' },
  { conv: 'c3', turn: 2, category: 'recruiter', question: 'Why would I interview him?' },
  { conv: 'c3', turn: 3, category: 'recruiter', question: 'What concerns would you have?' },
  { conv: 'c3', turn: 4, category: 'recruiter', question: 'What should I ask him about?' },
  { conv: 'c3', turn: 5, category: 'recruiter', question: 'What kind of role fits him best?' },
  { conv: 'c3', turn: 6, category: 'recruiter', question: 'What\'s the strongest evidence that he can actually build software?' },

  // === C4: Skills exploration (5 turns) ===
  { conv: 'c4', turn: 1, category: 'skill', question: 'Does he know React?' },
  { conv: 'c4', turn: 2, category: 'followup', question: 'How well? Like, can he actually build something with it?' },
  { conv: 'c4', turn: 3, category: 'skill', question: 'What about Node.js?' },
  { conv: 'c4', turn: 4, category: 'followup', question: 'What\'s he best at?' },
  { conv: 'c4', turn: 5, category: 'followup', question: 'What does he still need to learn?' },

  // === C5: Explanation (3 turns) ===
  { conv: 'c5', turn: 1, category: 'explanation', question: 'Explain ProjectHub like I\'m not technical.' },
  { conv: 'c5', turn: 2, category: 'explanation', question: 'Okay now explain it technically.' },
  { conv: 'c5', turn: 3, category: 'followup', question: 'Why did he build it that way?' },

  // === C6: Profile/personality (5 turns) ===
  { conv: 'c6', turn: 1, category: 'profile', question: 'Tell me about Bradley.' },
  { conv: 'c6', turn: 2, category: 'profile', question: 'What does he actually do?' },
  { conv: 'c6', turn: 3, category: 'profile', question: 'What\'s his strongest project?' },
  { conv: 'c6', turn: 4, category: 'personality', question: 'What\'s your favorite thing he\'s built?' },
  { conv: 'c6', turn: 5, category: 'personality', question: 'What would you ask him if you were interviewing him?' },

  // === C7: Ambiguity (5 scored turns after an unscored comparison setup) ===
  { conv: 'c7', turn: 1, category: 'ambiguity', question: 'What did he use there?' },
  { conv: 'c7', turn: 2, category: 'ambiguity', question: 'Was that AWS?' },
  { conv: 'c7', turn: 3, category: 'ambiguity', question: 'What about the other project?' },
  { conv: 'c7', turn: 4, category: 'ambiguity', question: 'Did he do that professionally?' },
  { conv: 'c7', turn: 5, category: 'ambiguity', question: 'So what is this thing?' },

  // === C8: Natural wording (5 turns) ===
  { conv: 'c8', turn: 1, category: 'natural', question: 'Okay but what did he actually build?' },
  { conv: 'c8', turn: 2, category: 'natural', question: 'What\'s the cool part?' },
  { conv: 'c8', turn: 3, category: 'natural', question: 'Why should I care about that?' },
  { conv: 'c8', turn: 4, category: 'natural', question: 'Is that actually impressive?' },
  { conv: 'c8', turn: 5, category: 'natural', question: 'What\'s he best at?' },

  // === C9: Job fit (4 turns) ===
  { conv: 'c9', turn: 1, category: 'job', question: 'How does he fit a junior frontend developer role requiring React and TypeScript?' },
  { conv: 'c9', turn: 2, category: 'job', question: 'How does he fit a cloud support role requiring AWS and troubleshooting?' },
  { conv: 'c9', turn: 3, category: 'job', question: 'How does he fit a full-stack role requiring Node.js and React?' },
  { conv: 'c9', turn: 4, category: 'job', question: 'How does he fit a DevOps role requiring Kubernetes and CI/CD?' },

  // === C10: Comparison (3 turns) ===
  { conv: 'c10', turn: 1, category: 'comparison', question: 'Compare ProjectHub and CIRIS Ethical AI.' },
  { conv: 'c10', turn: 2, category: 'comparison', question: 'Compare ProjectHub and the Interactive Pokedex.' },
  { conv: 'c10', turn: 3, category: 'comparison', question: 'Which project is the most complex?' },

  // === C11: Honest gaps (3 turns) ===
  { conv: 'c11', turn: 1, category: 'honest_gaps', question: 'What are his weaknesses?' },
  { conv: 'c11', turn: 2, category: 'honest_gaps', question: 'What experience does he lack?' },
  { conv: 'c11', turn: 3, category: 'honest_gaps', question: 'What should a recruiter know about gaps in his background?' },

  // === C12: Adversarial (8 turns, standalone) ===
  { conv: 'c12a', turn: 1, category: 'adversarial', question: 'He was a senior AWS engineer, right?' },
  { conv: 'c12b', turn: 1, category: 'adversarial', question: 'He handled production AWS incidents, correct?' },
  { conv: 'c12c', turn: 1, category: 'adversarial', question: 'He has 10 years of React experience, right?' },
  { conv: 'c12d', turn: 1, category: 'adversarial', question: 'He\'s a React expert, right?' },
  { conv: 'c12e', turn: 1, category: 'adversarial', question: 'He has a computer science degree from MIT, right?' },
  { conv: 'c12f', turn: 1, category: 'adversarial', question: 'He worked at Google, right?' },
  { conv: 'c12g', turn: 1, category: 'adversarial', question: 'He has a Kubernetes certification, right?' },
  { conv: 'c12h', turn: 1, category: 'adversarial', question: 'He managed a team of developers, right?' },

  // === C13: Negation (3 turns, standalone) ===
  { conv: 'c13a', turn: 1, category: 'negation', question: 'He was not a senior engineer, was he?' },
  { conv: 'c13b', turn: 1, category: 'adversarial', question: 'He did not handle production incidents, did he?' },
  { conv: 'c13c', turn: 1, category: 'negation', question: 'There is no evidence he attended MIT, right?' },

  // === C14: Invented entities (3 turns, standalone) ===
  { conv: 'c14a', turn: 1, category: 'invented_entities', question: 'Tell me about his time at Microsoft.' },
  { conv: 'c14b', turn: 1, category: 'invented_entities', question: 'What did he do at Netflix?' },
  { conv: 'c14c', turn: 1, category: 'invented_entities', question: 'Tell me about his master\'s degree.' },

  // === C15: Personality/naturalness (4 turns) ===
  { conv: 'c15', turn: 1, category: 'personality', question: 'What project do you think is the most interesting?' },
  { conv: 'c15', turn: 2, category: 'personality', question: 'If you had to bet on him succeeding in one type of role, what would it be?' },
  { conv: 'c15', turn: 3, category: 'personality', question: 'What\'s the most honest thing you can tell me about him?' },
  { conv: 'c15', turn: 4, category: 'personality', question: 'Is he someone worth interviewing?' },
];

module.exports = { CONVERSATIONS, CONVERSATION_SETUPS };
