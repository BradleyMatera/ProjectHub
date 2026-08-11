'use strict';

function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function compactToolResult(result, maxChars) {
  const text = JSON.stringify(result === undefined ? null : result);
  if (text.length <= maxChars) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, maxChars) });
}

async function runAgentLoop(options) {
  const complete = options.complete;
  const execute = options.execute;
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const messages = Array.isArray(options.messages) ? options.messages.map(message => ({ ...message })) : [];
  const allowedTools = new Set(tools.map(tool => tool?.function?.name).filter(Boolean));
  const maxRounds = Math.max(1, Math.min(options.maxRounds || 2, 3));
  const maxToolCalls = Math.max(1, Math.min(options.maxToolCalls || 3, 5));
  const maxResultChars = Math.max(500, Math.min(options.maxResultChars || 6000, 10000));
  const steps = [];
  const toolResults = [];
  let callsUsed = 0;

  if (typeof complete !== 'function' || typeof execute !== 'function') {
    throw new Error('Agent runtime requires complete and execute functions.');
  }

  for (let round = 0; round < maxRounds; round++) {
    const response = await complete({ messages, tools, toolChoice: 'auto' });
    const message = response?.message || response;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length === 0) {
      const content = String(message?.content || '').trim();
      if (!content) throw new Error('Agent returned neither text nor tool calls.');
      return { reply: content, steps, toolResults, messages };
    }

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });
    for (const toolCall of toolCalls) {
      if (callsUsed >= maxToolCalls) break;
      callsUsed++;
      const name = String(toolCall?.function?.name || '');
      const args = parseToolArguments(toolCall?.function?.arguments);
      let result;
      let status = 'completed';
      if (!allowedTools.has(name)) {
        result = { error: 'Tool is not allowed.' };
        status = 'denied';
      } else if (args === null) {
        result = { error: 'Tool arguments were not valid JSON.' };
        status = 'invalid';
      } else {
        try {
          result = await execute(name, args);
        } catch (error) {
          result = { error: String(error?.message || 'Tool execution failed.').slice(0, 200) };
          status = 'failed';
        }
      }
      const content = compactToolResult(result, maxResultChars);
      steps.push({ round: round + 1, tool: name, status });
      toolResults.push({ tool: name, status, result });
      messages.push({
        role: 'tool',
        tool_call_id: String(toolCall?.id || `tool_${round}_${callsUsed}`),
        name,
        content
      });
    }

    if (callsUsed >= maxToolCalls) break;
  }

  const finalResponse = await complete({ messages, tools, toolChoice: 'none' });
  const finalMessage = finalResponse?.message || finalResponse;
  const reply = String(finalMessage?.content || '').trim();
  if (!reply) throw new Error('Agent did not produce a final answer.');
  return { reply, steps, toolResults, messages };
}

module.exports = { compactToolResult, parseToolArguments, runAgentLoop };
