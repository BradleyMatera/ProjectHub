'use strict';

// Output Parser — robust extraction of answer text from small-model output.
//
// Small models (0.5B) produce inconsistent output:
//   - Clean JSON: {"answer":"Yes, the candidate has used DynamoDB."}
//   - Malformed JSON: {"answer":"Yes"},{"answer":"No"}
//   - JSON with prose: Here is the answer: {"answer":"..."}
//   - Plain text: Yes, the candidate has used DynamoDB.
//   - Fenced JSON: ```json\n{"answer":"..."}\n```
//   - Very short: Yes.
//
// This parser safely extracts a clean answer string from any of these.
// Everything eventually becomes a plain candidate answer string that is
// validated normally by the grounding validator.

function parseModelOutput(raw) {
  if (!raw) return '';
  let text = String(raw).trim();
  if (!text) return '';

  // 1. Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 2. Try to extract JSON {"answer":"..."} from the text
  const jsonAnswer = extractJsonAnswer(text);
  if (jsonAnswer) return cleanAnswerText(jsonAnswer);

  // 3. If the text looks like JSON but is malformed, try repair
  if (text.startsWith('{') || text.includes('"answer"')) {
    const repaired = tryJsonRepair(text);
    if (repaired && repaired.answer) return cleanAnswerText(repaired.answer);
  }

  // 4. If no JSON found, treat the entire text as a plain-text answer
  // Strip common preamble phrases that small models add
  return cleanAnswerText(stripPreamble(text));
}

function extractJsonAnswer(text) {
  // Find the first {"answer":"..."} pattern
  // Handle escaped quotes inside the answer
  const match = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .trim();
  }
  return null;
}

function tryJsonRepair(text) {
  // Extract the first {...} block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    let jsonStr = text.slice(start, end + 1);
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Try removing trailing commas
      try {
        return JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        // Try extracting just the answer field
        const answerMatch = jsonStr.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (answerMatch) {
          return { answer: answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') };
        }
      }
    }
  }
  return null;
}

function stripPreamble(text) {
  // Remove common preamble phrases that small models add
  const preambles = [
    /^(?:here(?:'s| is) the answer\s*[::]?\s*)/i,
    /^(?:based on the (?:facts|evidence|information)\s*(?:provided|given)?\s*[::]?\s*)/i,
    /^(?:according to the (?:facts|evidence)\s*[::]?\s*)/i,
    /^(?:answer\s*[::]\s*)/i,
    /^(?:sure[,\.]?\s*)/i,
    /^(?:yes[,\.]?\s*)/i,  // Only strip if followed by more text
  ];

  let cleaned = text;
  for (const preamble of preambles) {
    cleaned = cleaned.replace(preamble, '');
  }
  return cleaned.trim();
}

function cleanAnswerText(text) {
  if (!text) return '';
  let cleaned = String(text).trim();
  // Remove leading/trailing quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // Ensure terminal punctuation
  if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }
  return cleaned;
}

module.exports = {
  parseModelOutput,
  extractJsonAnswer,
  tryJsonRepair,
  stripPreamble,
  cleanAnswerText
};
