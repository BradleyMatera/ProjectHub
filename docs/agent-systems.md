# Scout Local Agent System

Scout is a local-first recruiter assistant. Model inference runs exclusively through Ollama with `qwen2.5:0.5b`.

## Request flow

1. Normalize, typo-correct, classify, and contextually rewrite the question.
2. Load verified facts from the bundled knowledge file through BM25.
3. Recall up to five recent turns and retained topic stances.
4. Use deterministic read-only tools for comparisons, role evidence, briefs, and interview workflows.
5. Ask Ollama to phrase eligible open-ended answers.
6. Validate facts, entities, numbers, safety, scope, length, and tone.
7. Return the grounded deterministic answer when the generated draft is weak, unsupported, or slow.

The tools cannot write files, send messages, browse arbitrary websites, or execute commands. The private preview binds to loopback and is accessed through `scripts/open-agent-preview.sh`.

## Local learning

Think Mode stores weak relevant answers in the local learned file. It generates and judges proposed improvements locally, promotes only validated candidates, retains at most 100 learned answers, and performs no external writes.
