# Contract Entity Semantics — Design Document

## Problem

C2 proved that the generation model performs substantially better when Scout tells it what the validator actually requires. However, `requiredEntities` is overloaded — it conflates entities needed for context resolution, entities that must appear in output prose, entities expected in evidence, and entities that are forbidden.

## Proposed Separation

### `contextEntities`

Entities required for Scout to **understand and resolve** the question. These are used internally for retrieval, routing, and contract construction. They do NOT need to appear in the generated answer.

**Examples:**
- Question: "Was he a senior engineer at Google?" with prior turn about Maria Lopez
  - `contextEntities: ["Maria Lopez", "Google"]`
  - A valid answer "No, he wasn't." does not need to mention either entity.

**Determination rules:**
- Pronoun referents resolved from conversation history (he/she/they/it)
- Entities in the question that establish context but are not the answer subject
- Always populated when pronouns are present and resolvable

### `mustMentionEntities`

Entities that must **literally appear** in visible generated prose. The completeness validator enforces these.

**Examples:**
- Question: "Was Maria at Google?" with ambiguous context
  - `mustMentionEntities: ["Google"]` — answer must mention Google to be unambiguous
- Question: "Does she know React?" with Maria + Alex active
  - `mustMentionEntities: ["Maria"]` — must disambiguate which person

**Determination rules:**
1. **Ambiguity rule**: If multiple referents are active in conversation, the subject name must appear.
2. **Direct question rule**: If the question names an entity and the answer could be ambiguous without it, include it.
3. **Negative claim rule**: For negation confirmations ("Did he work at X?"), include X if the answer is "No" — otherwise "No" alone is ambiguous.
4. **Policy mode rule**: For OOS/refusal cases, `mustMentionEntities` should be empty — the answer should redirect, not enumerate.
5. **Pronoun rule**: If the question uses a pronoun and there is exactly one active referent, do NOT require the name — "No, he wasn't" is natural and sufficient.

### `evidenceEntities`

Entities expected to appear in **evidence** (retrieved chunks, key facts) but not necessarily in output. These guide retrieval and validation grounding but are not output requirements.

**Examples:**
- Question: "What projects has he built?"
  - `evidenceEntities: ["ProjectHub", "Fallen Knight", "Voice Ops Platform"]`
  - Answer may mention some but not all — completeness is about the answer addressing the question, not naming every project.

**Determination rules:**
- Entities from retrieved evidence chunks
- Entities from the response contract's key facts
- Used for grounding validation (entity_not_grounded checks) but not completeness enforcement

### `forbiddenEntities`

Entities that may **not be asserted or introduced** by the model. These are enforced by the safety validator.

**Examples:**
- Question: "Was he a senior engineer at Google?"
  - `forbiddenEntities: ["senior engineer"]` — if Bradley was never a senior engineer, the model must not assert this title
- Question: "Does he know React?"
  - `forbiddenEntities: ["expert", "proficient"]` — inflation language is forbidden

**Determination rules:**
- Entities from `responseContract.forbiddenClaims`
- Fabricated entities detected by grounding validation
- Inflation language tokens
- Entities that would create unsupported relationships

## Mapping from Current `requiredEntities`

The current `requiredEntities` field maps to `mustMentionEntities` in most cases. The completeness validator that enforces "the answer must contain these entities" is checking for literal mention, which is the `mustMentionEntities` semantic.

The `missingEntities` from the completeness check (entities the answer failed to mention) are also `mustMentionEntities` — they are entities the validator determined must be in the output.

## Generic Rules (NOT benchmark-case-specific)

Rules are based on:

1. **Conversation ambiguity**: Track active referents in session memory. If >1 active, require disambiguation.
2. **Pronoun/reference clarity**: If pronoun has exactly one resolution, don't force name mention.
3. **Claim correctness**: For negative claims, the denied entity must appear if ambiguity is possible.
4. **Policy mode**: OOS/refusal → empty `mustMentionEntities`. Normal → populate per rules above.
5. **Question form**: Direct named questions ("Was Maria at Google?") vs pronoun questions ("Was she at Google?") have different mention requirements.

## Implementation Plan

1. Add `contextEntities`, `mustMentionEntities`, `evidenceEntities`, `forbiddenEntities` to `responseContract` in `lib/lite-agent.js`.
2. Update completeness validator to check `mustMentionEntities` (replaces `requiredEntities`).
3. Update recovery prompt to inject `mustMentionEntities` (replaces current `requiredEntities` injection from C2).
4. Update grounding validator to use `evidenceEntities` for grounding checks.
5. Update safety validator to use `forbiddenEntities` for assertion checks.
6. Populate `contextEntities` from conversation memory and pronoun resolution.
7. Populate `mustMentionEntities` using the generic rules above.
8. Keep `requiredEntities` as a deprecated alias for `mustMentionEntities` during transition.

## Expected Impact

- **Naturalness**: Answers won't force entity mention when context is clear (pronoun with single referent).
- **Precision**: Answers will force disambiguation when multiple referents are active.
- **Recovery**: Recovery prompt will be more precise — only telling the model what MUST appear, not everything from context.
- **Safety**: `forbiddenEntities` gives the model explicit negative guidance, reducing fabricated assertions.
