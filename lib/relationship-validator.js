'use strict';

/**
 * Relationship Validator — validates extracted claims against the relationship graph.
 *
 * This is the core of relationship-aware grounding. Instead of checking
 * "do these entities exist?", it checks "does the evidence support THIS
 * RELATIONSHIP between these entities?"
 *
 * Validation flow:
 *   1. Extract claims from the answer (claim-extractor.js)
 *   2. For each FACT claim, check the relationship graph
 *   3. Flag unsupported relationships
 *   4. Flag overclaim claims (expertise, extensive experience, etc.)
 *   5. Allow INTERPRETATION and COMPARISON claims (they're opinions, not facts)
 *   6. Allow NEGATION claims (refuting false premises is correct)
 *
 * This module is generic and domain-neutral. It works for any knowledge
 * package that builds a relationship graph.
 */

const { extractClaims } = require('./claim-extractor');
const { checkRelationship } = require('./relationship-graph');
const { normalizeEntity } = require('./canonical-entities');

// Overclaim relation classes — these are ALWAYS suspicious even if the
// entity exists. "has expertise in AWS" is overclaim even if AWS exists.
const OVERCLAIM_RELATIONS = new Set([
  'has_expertise',
  'has_extensive_experience',
  'specializes_in',
  'proficient_in',
  'adept_at'
]);

// Relations that imply seniority/leadership (overclaim for entry-level)
const SENIORITY_RELATIONS = new Set([
  'has_expertise',
  'has_extensive_experience',
  'specializes_in'
]);

/**
 * Validate an answer's claims against the relationship graph.
 *
 * @param {string} answer - The generated answer text
 * @param {Object} graph - The relationship graph from buildRelationshipGraph()
 * @param {string} question - The user's question (for context)
 * @returns {Object} { valid, unsupportedClaims, overclaimClaims, details }
 */
function validateRelationships(answer, graph, question = '', history = []) {
  const claims = extractClaims(answer, graph, question, history);
  const unsupportedClaims = [];
  const overclaimClaims = [];
  const details = [];

  for (const claim of claims) {
    // Skip interpretations and comparisons — they're opinions, not facts
    if (claim.type === 'INTERPRETATION' || claim.type === 'COMPARISON') {
      details.push({
        claim,
        verdict: 'interpretation',
        message: 'Interpretation/comparison — not a factual claim to validate'
      });
      continue;
    }

    // Negation claims are correct behavior (refuting false premises)
    if (claim.type === 'NEGATION') {
      details.push({
        claim,
        verdict: 'negation',
        message: 'Negation/refutation — correct safety behavior'
      });
      continue;
    }

    // Check overclaim relations
    if (OVERCLAIM_RELATIONS.has(claim.relation)) {
      overclaimClaims.push({
        relation: claim.relation,
        object: claim.object,
        raw: claim.raw
      });
      details.push({
        claim,
        verdict: 'overclaim',
        message: `Overclaim: ${claim.relation} "${claim.object}" — this language implies expertise beyond entry-level`
      });
      continue;
    }

    // For factual claims with subject and object, check the relationship graph
    if (claim.subject && claim.object && claim.relation) {
      // Normalize "subject" to the actual subject name (for both subject and object positions)
      const subj = claim.subject === 'subject' ? graph.subjectName : claim.subject;
      const obj = claim.object === 'subject' ? graph.subjectName : claim.object;

      // is_type claims: validate that the asserted type is compatible with the
      // graph's type for this entity. Previously skipped entirely, which let
      // mischaracterizations like "ProjectHub is a platform for students" pass.
      // Now we check: does the asserted type share at least one content word
      // with the graph's type? If not, it's a mischaracterization.
      // Generic type words (project, tool, application, system) are always
      // accepted — they're too vague to be wrong.
      if (claim.relation === 'is_type') {
        const assertedType = (claim.object || '').toLowerCase();
        const subjNorm = (subj || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        // Find the graph's is_type triple for this entity
        const graphTypeTriples = graph.triples.filter(t =>
          t.relation === 'is_type' &&
          (t.subjectNorm || '').includes(subjNorm.slice(0, 6))
        );
        if (graphTypeTriples.length === 0) {
          // No is_type triple in graph — skip (can't validate)
          details.push({ claim, verdict: 'skipped', message: 'No is_type triple in graph for this entity' });
          continue;
        }
        // Generic type words that are always acceptable
        const genericTypes = new Set(['project', 'tool', 'application', 'app', 'system',
          'software', 'program', 'product', 'service', 'platform', 'solution',
          'widget', 'script', 'site', 'website', 'page', 'feature', 'demo',
          'that', 'this', 'which', 'where', 'what', 'thing', 'part', 'kind',
          'type', 'sort', 'form', 'version', 'example',
          // Common type modifiers — not mischaracterizations
          'web', 'mobile', 'desktop', 'client-side', 'server-side', 'server',
          'front-end', 'front', 'end', 'back-end', 'back', 'full-stack', 'full',
          'stack', 'based', 'driven', 'oriented', 'simple', 'basic', 'advanced',
          'interactive', 'static', 'dynamic', 'modern', 'traditional',
          'embeddable', 'embedded', 'lightweight', 'powerful', 'small',
          'unique', 'notable', 'interesting', 'impressive', 'cool']);
        // Content words from the asserted type (excluding generic/stop words)
        // Include 2-char words like "AI" since they can be meaningful content words
        const assertedWords = assertedType.split(/\s+/).filter(w => w.length >= 2 && !genericTypes.has(w));
        if (assertedWords.length === 0) {
          // All words are generic — but check if the graph has a specific type
          // that contradicts this vague type. E.g., "project management system"
          // for an entity whose type is "AI recruiter assistant" is wrong even
          // though all individual words are generic.
          const graphTypes = graphTypeTriples.map(t => (t.object || '').toLowerCase());
          if (graphTypes.length > 0) {
            // Check if any graph type word appears in the asserted type
            const graphWords = graphTypes.join(' ').split(/\s+/).filter(w => w.length >= 2 && w !== '/');
            const assertedLower = assertedType.toLowerCase();
            const hasOverlap = graphWords.some(w => assertedLower.includes(w));
            if (!hasOverlap) {
              unsupportedClaims.push({
                subject: subj,
                relation: 'is_type',
                object: claim.object,
                raw: claim.raw,
                reason: `Entity type "${claim.object}" does not match known type "${graphTypeTriples.map(t => t.object).join(' / ')}"`
              });
              details.push({ claim, verdict: 'unsupported_relationship', message: `is_type mismatch: "${claim.object}" vs graph's "${graphTypeTriples.map(t => t.object).join(' / ')}"` });
              continue;
            }
          }
          // All words are generic and no contradiction — accept (too vague to be wrong)
          details.push({ claim, verdict: 'supported', message: 'is_type: all generic words' });
          continue;
        }
        // Check if any asserted content word appears in any graph type
        const graphTypes = graphTypeTriples.map(t => (t.object || '').toLowerCase());
        // Also check the project description (from knowledge) — the model may
        // use a correct type word from the description that isn't in the
        // category field (e.g., "calculator" for CheeseMath whose category is
        // "Frontend / testing demo" but description starts with "Calculator").
        let projectDescription = '';
        if (graph.knowledge && Array.isArray(graph.knowledge.projects)) {
          const proj = graph.knowledge.projects.find(p => {
            const pNorm = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            return pNorm.includes(subjNorm.slice(0, 6)) || subjNorm.slice(0, 6).includes(pNorm.slice(0, 6));
          });
          if (proj && proj.description) projectDescription = proj.description.toLowerCase();
        }
        const hasOverlap = assertedWords.some(w =>
          graphTypes.some(gt => gt.includes(w) || w.includes(gt.replace(/[^a-z]/g, '').slice(0, 6))) ||
          projectDescription.includes(w)
        );
        if (hasOverlap) {
          details.push({ claim, verdict: 'supported', message: `is_type: asserted type overlaps graph type` });
        } else {
          unsupportedClaims.push({
            subject: subj,
            relation: 'is_type',
            object: claim.object,
            raw: claim.raw,
            reason: `Entity type "${claim.object}" does not match known type "${graphTypeTriples.map(t => t.object).join(' / ')}"`
          });
          details.push({ claim, verdict: 'unsupported_relationship', message: `is_type mismatch: "${claim.object}" vs graph's "${graphTypeTriples.map(t => t.object).join(' / ')}"` });
        }
        continue;
      }

      // built_during claims: check if the project→built_during→context triple exists.
      // If the model says "ProjectHub was built during the AWS internship" but no such
      // relationship is in the graph, this is a false claim.
      if (claim.relation === 'built_during') {
        const projNorm = (claim.subject || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const ctxNorm = (claim.object || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        // Find matching built_during triple (project built during context)
        const hasDuring = graph.triples.some(t =>
          t.relation === 'built_during' &&
          (t.subjectNorm || '').includes(projNorm.slice(0, 6)) &&
          (t.objectNorm || '').includes(ctxNorm.slice(0, 5))
        );
        if (!hasDuring) {
          unsupportedClaims.push({
            subject: claim.subject,
            relation: 'built_during',
            object: claim.object,
            raw: claim.raw,
            reason: `No evidence "${claim.subject}" was built during "${claim.object}"`
          });
          details.push({ claim, verdict: 'unsupported_relationship', message: `No built_during triple for ${claim.subject} → ${claim.object}` });
        } else {
          details.push({ claim, verdict: 'supported', message: 'built_during relationship found' });
        }
        continue;
      }

      // Normalize relation classes for checking
      let checkRelation = claim.relation === 'uses_tech_generic' ? 'uses_tech' : claim.relation;
      if (claim.relation === 'has_experience') {
        // Try worked_at first, then interned_at, then has_skill, then employed_as
        const tryRels = ['worked_at', 'interned_at', 'has_skill', 'employed_as'];
        let found = false;
        // Also try direct has_skill check on single-word tech terms
        if (obj && /^[A-Za-z][A-Za-z0-9+#.-]{1,20}$/.test(obj.trim())) {
          const r = checkRelationship(graph, subj, 'has_skill', obj);
          if (r.supported) found = true;
        }
        if (!found) {
          for (const rel of tryRels) {
            const r = checkRelationship(graph, subj, rel, obj);
            if (r.supported) {
              found = true;
              details.push({ claim, verdict: 'supported', message: `has_experience matched ${rel}` });
              break;
            }
          }
        } else {
          details.push({ claim, verdict: 'supported', message: 'has_experience matched has_skill directly' });
        }
        // Also try fuzzy match: if the object contains words from any known role
        if (!found && graph.triples) {
          const objLower = claim.object.toLowerCase();
          const subjNorm = subj.toLowerCase().replace(/[^a-z0-9]/g, '');
          const roleTriples = graph.triples.filter(t =>
            t.subject && t.subject.toLowerCase().replace(/[^a-z0-9]/g, '').includes(subjNorm) &&
            (t.relation === 'employed_as' || t.relation === 'worked_at' || t.relation === 'interned_at')
          );
          for (const t of roleTriples) {
            const tObjLower = t.object.toLowerCase();
            // Check if the object words overlap significantly
            const objWords = objLower.split(/[\s-]+/).filter(w => w.length > 3);
            const tWords = tObjLower.split(/[\s-]+/).filter(w => w.length > 3);
            const overlap = objWords.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw)));
            if (overlap.length >= 2) {
              found = true;
              details.push({ claim, verdict: 'supported', message: `has_experience fuzzy matched ${t.relation}: ${t.object}` });
              break;
            }
          }
        }
        if (found) continue;
        // If not found with any, fall through to normal check with has_experience
        // which will report unsupported
      }

      const result = checkRelationship(graph, subj, checkRelation, obj);

      if (!result.supported) {
        unsupportedClaims.push({
          subject: subj,
          relation: claim.relation,
          object: obj,
          raw: claim.raw,
          reason: result.reason
        });
        details.push({
          claim,
          verdict: 'unsupported_relationship',
          message: result.reason
        });
      } else {
        details.push({
          claim,
          verdict: 'supported',
          message: result.reason
        });
      }
    }
  }

  // Contextual entity relationship check for referential follow-up queries ("there", "it", "that", "the project")
  if (Array.isArray(history) && history.length > 0 && graph && graph.entityIndex) {
    const isReferential = /\b(there|it|that|the project|the internship|the role|the app|the software)\b/i.test(question);
    if (isReferential) {
      // Common sentence-starting words that are capitalized but not entities
      const sentenceStarters = new Set(['So', 'Okay', 'Now', 'Then', 'But', 'And',
        'Or', 'Was', 'Is', 'Are', 'Were', 'Has', 'Have', 'Had', 'Did', 'Does',
        'Do', 'Can', 'Could', 'Would', 'Should', 'Will', 'What', 'How', 'Why',
        'When', 'Where', 'Who', 'Which', 'Tell', 'Give', 'Compare', 'Explain',
        'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'His', 'Her',
        'Their', 'He', 'She', 'They', 'It', 'For', 'With', 'From', 'About',
        'In', 'On', 'At', 'To', 'Of', 'As', 'By', 'If', 'No', 'Yes', 'There']);
      let primaryEntity = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const turnText = String(history[i].text || history[i].user || history[i].assistant || '');
        const capMatches = turnText.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
        for (const cap of capMatches) {
          if (sentenceStarters.has(cap)) continue;
          // Also check if the first word of a multi-word match is a sentence starter
          const firstWord = cap.split(/\s+/)[0];
          if (sentenceStarters.has(firstWord)) continue;
          const norm = normalizeEntity(cap);
          if (norm.length < 3) continue; // Skip very short tokens
          if (norm !== 'scout' && norm !== 'bradley' && norm !== 'matera') {
            let match = null;
            if (graph.entityIndex.has(norm)) {
              match = graph.entityIndex.get(norm);
            } else {
              // Fuzzy match: require at least 4 chars and the shorter string
              // must be at least 50% of the longer string to avoid false
              // matches like "So" matching "software..."
              // Exception: short tokens (3+ chars) that are a PREFIX of a
              // longer entity key (e.g., "aws" → "awscapstone") are accepted.
              for (const [key, entityInfo] of graph.entityIndex.entries()) {
                if (key.length >= 4 && norm.length >= 4 &&
                    (key.includes(norm) || norm.includes(key))) {
                  const shorter = Math.min(key.length, norm.length);
                  const longer = Math.max(key.length, norm.length);
                  if (shorter / longer >= 0.5) {
                    match = entityInfo;
                    break;
                  }
                }
                // Prefix match for short tokens (e.g., "aws" → "awscapstone")
                if (norm.length >= 3 && norm.length < 8 &&
                    key.length > norm.length && key.startsWith(norm)) {
                  match = entityInfo;
                  break;
                }
              }
            }
            if (match) {
              primaryEntity = cap;
              break;
            }
          }
        }
        if (primaryEntity) break;
      }
      if (primaryEntity) {
        const answerCaps = answer.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
        for (const cap of answerCaps) {
          if (sentenceStarters.has(cap)) continue;
          // Also check if the first word of a multi-word match is a sentence starter
          const firstWord = cap.split(/\s+/)[0];
          if (sentenceStarters.has(firstWord)) continue;
          const norm = normalizeEntity(cap);
          if (norm.length < 3) continue;
          if (norm !== normalizeEntity(primaryEntity) && norm !== 'he' && norm !== 'she' && norm !== 'they' && norm !== 'this' && norm !== 'that' && norm !== 'the') {
            let entityInfo = null;
            if (graph.entityIndex.has(norm)) {
              entityInfo = graph.entityIndex.get(norm);
            } else {
              for (const [key, info] of graph.entityIndex.entries()) {
                if (key.length >= 4 && norm.length >= 4 &&
                    (key.includes(norm) || norm.includes(key))) {
                  const shorter = Math.min(key.length, norm.length);
                  const longer = Math.max(key.length, norm.length);
                  if (shorter / longer >= 0.5) {
                    entityInfo = info;
                    break;
                  }
                }
                if (norm.length >= 3 && norm.length < 8 &&
                    key.length > norm.length && key.startsWith(norm)) {
                  entityInfo = info;
                  break;
                }
              }
            }
            if (entityInfo && (Array.isArray(entityInfo) ? entityInfo.length > 0 : entityInfo)) {
              // Only check uses_tech when:
              // 1. The answer entity is a TECHNOLOGY (not a project)
              // 2. The primary entity (from question) is a PROJECT
              // Technologies don't use_tech other technologies — projects do.
              // This prevents false "React uses_tech ProjectHub" and "AWS uses_tech Lambda" claims.
              const eTriples = Array.isArray(entityInfo) ? entityInfo : [entityInfo];
              const isAnswerProject = eTriples.some(t => t.relation === 'built_by' || t.relation === 'is_type');
              if (!isAnswerProject) {
                // Also check if primary entity is a project
                const primaryNorm = normalizeEntity(primaryEntity);
                const primaryInfo = graph.entityIndex.get(primaryNorm);
                let primaryIsProject = false;
                if (primaryInfo) {
                  const pTriples = Array.isArray(primaryInfo) ? primaryInfo : [primaryInfo];
                  primaryIsProject = pTriples.some(t => t.relation === 'built_by' || t.relation === 'is_type');
                }
                if (primaryIsProject) {
                  const check = checkRelationship(graph, primaryEntity, 'uses_tech', cap);
                  if (!check.supported && !unsupportedClaims.some(uc => uc.object === cap)) {
                    unsupportedClaims.push({
                      subject: primaryEntity,
                      relation: 'uses_tech',
                      object: cap,
                      raw: answer.trim(),
                      reason: check.reason
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Implicit follow-up subject consistency check.
  // When the question doesn't mention any specific entity but the conversation
  // history establishes a primary entity, the answer should be about that
  // entity. If the answer mentions a DIFFERENT PROJECT and does NOT mention the
  // primary entity at all, it's a follow-up context drift.
  if (Array.isArray(history) && history.length > 0 && graph && graph.entityIndex) {
    // Common sentence-starting words that are capitalized but not entities
    const sentenceStarters = new Set(['So', 'Okay', 'Now', 'Then', 'But', 'And',
      'Or', 'Was', 'Is', 'Are', 'Were', 'Has', 'Have', 'Had', 'Did', 'Does',
      'Do', 'Can', 'Could', 'Would', 'Should', 'Will', 'What', 'How', 'Why',
      'When', 'Where', 'Who', 'Which', 'Tell', 'Give', 'Compare', 'Explain',
      'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'His', 'Her',
      'Their', 'He', 'She', 'They', 'It', 'For', 'With', 'From', 'About',
      'In', 'On', 'At', 'To', 'Of', 'As', 'By', 'If', 'No', 'Yes']);
    // Check if the question itself mentions any known entity
    const questionCaps = question.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
    const questionHasEntity = questionCaps.some(cap => {
      if (sentenceStarters.has(cap)) return false;
      const norm = normalizeEntity(cap);
      if (norm === 'bradley' || norm === 'matera' || norm === 'scout') return false;
      return graph.entityIndex.has(norm) ||
        Array.from(graph.entityIndex.keys()).some(k => k.length >= 4 && (k.includes(norm) || norm.includes(k)));
    });
    // Also skip if the question explicitly asks about "the other project" or
    // "another project" — the user is intentionally switching context
    const asksAboutOther = /\b(?:other|another|different)\s+(?:project|one|app|thing)\b/i.test(question);
    // Skip if the question asks "which project" — mentioning different projects
    // is expected when comparing/selecting
    const asksWhichProject = /\bwhich\s+(?:project|one|app)\b/i.test(question);
    if (!questionHasEntity && !asksAboutOther && !asksWhichProject) {
      // Find the primary entity from recent history
      let primaryEntity = null;
      for (let i = history.length - 1; i >= 0 && !primaryEntity; i--) {
        const turnText = String(history[i].text || history[i].user || history[i].assistant || '');
        const capMatches = turnText.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
        for (const cap of capMatches) {
          if (sentenceStarters.has(cap)) continue;
          // Also check if the first word of a multi-word match is a sentence starter
          const firstWord = cap.split(/\s+/)[0];
          if (sentenceStarters.has(firstWord)) continue;
          const norm = normalizeEntity(cap);
          if (norm === 'scout' || norm === 'bradley' || norm === 'matera') continue;
          if (norm.length < 3) continue; // Skip very short entities like "UI"
          if (graph.entityIndex.has(norm) ||
              Array.from(graph.entityIndex.keys()).some(k => {
                if (k.length < 4 || norm.length < 4) return false;
                if (!(k.includes(norm) || norm.includes(k))) return false;
                const shorter = Math.min(k.length, norm.length);
                const longer = Math.max(k.length, norm.length);
                return shorter / longer >= 0.5;
              }) ||
              Array.from(graph.entityIndex.keys()).some(k =>
                norm.length >= 3 && norm.length < 8 &&
                k.length > norm.length && k.startsWith(norm))) {
            primaryEntity = cap;
            break;
          }
        }
      }
      if (primaryEntity) {
        const primaryNorm = normalizeEntity(primaryEntity);
        const answerNorm = answer.toLowerCase().replace(/[^a-z0-9]/g, '');
        const answerMentionsPrimary = answerNorm.includes(primaryNorm.slice(0, 6));
        if (!answerMentionsPrimary) {
          // Answer doesn't mention the primary entity at all.
          // Check if it mentions a DIFFERENT known entity.
          // Only flag drift to PROJECTS, not technologies or skills —
          // mentioning "Node.js" when talking about "ProjectHub" is not drift.
          // Also exclude the subject name (Bradley Matera) and pronouns.
          const isSubjectOrPronoun = (norm) => {
            if (norm === 'scout') return true;
            if (norm.includes('bradley') || norm.includes('matera')) return true;
            const pronouns = ['he', 'she', 'they', 'his', 'her', 'their', 'the', 'this', 'that', 'there', 'here'];
            return pronouns.includes(norm);
          };
          // Check if an entity is a project (not a technology)
          const isProjectEntity = (entityName, entityInfo) => {
            // Check if this entity has an is_type triple that indicates it's a project
            const norm = normalizeEntity(entityName);
            const typeTriples = graph.triples.filter(t =>
              t.relation === 'is_type' &&
              (t.subjectNorm || '').includes(norm.slice(0, 6))
            );
            if (typeTriples.length > 0) return true; // Has a type → likely a project
            // Check if it appears in the projects array
            if (graph.knowledge && Array.isArray(graph.knowledge.projects)) {
              return graph.knowledge.projects.some(p => {
                const pNorm = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                return pNorm.includes(norm.slice(0, 6)) || norm.includes(pNorm.slice(0, 6));
              });
            }
            return false;
          };
          const answerCaps = answer.match(/\b[A-Z][A-Za-z0-9+#.-]+(?:\s+[A-Z][A-Za-z0-9+#.-]+)*\b/g) || [];
          for (const cap of answerCaps) {
            const norm = normalizeEntity(cap);
            if (isSubjectOrPronoun(norm)) continue;
            if (norm === primaryNorm) continue;
            let entityInfo = null;
            if (graph.entityIndex.has(norm)) {
              entityInfo = graph.entityIndex.get(norm);
            } else {
              for (const [key, info] of graph.entityIndex.entries()) {
                if (key.length >= 4 && norm.length >= 4 &&
                    (key.includes(norm) || norm.includes(key))) {
                  const shorter = Math.min(key.length, norm.length);
                  const longer = Math.max(key.length, norm.length);
                  if (shorter / longer >= 0.5) {
                    entityInfo = info;
                    break;
                  }
                }
                if (norm.length >= 3 && norm.length < 8 &&
                    key.length > norm.length && key.startsWith(norm)) {
                  entityInfo = info;
                  break;
                }
              }
            }
            if (entityInfo && (Array.isArray(entityInfo) ? entityInfo.length > 0 : entityInfo)) {
              // Only flag as drift if the different entity is a PROJECT
              if (!isProjectEntity(cap, entityInfo)) continue;
              // Answer mentions a different project without mentioning
              // the primary project — this is a follow-up context drift.
              if (!unsupportedClaims.some(uc => uc.object === cap && uc.reason?.includes('context drift'))) {
                unsupportedClaims.push({
                  subject: primaryEntity,
                  relation: 'context_drift',
                  object: cap,
                  raw: answer.trim(),
                  reason: `Follow-up context drift: conversation is about "${primaryEntity}" but answer discusses "${cap}" without mentioning "${primaryEntity}"`
                });
              }
              break; // One drift finding is enough
            }
          }
        }
      }
    }
  }

  // The answer is invalid if it has ANY unsupported factual relationships
  // or ANY overclaim claims
  const valid = unsupportedClaims.length === 0 && overclaimClaims.length === 0;

  return {
    valid,
    unsupportedClaims,
    overclaimClaims,
    details,
    claimsExtracted: claims.length
  };
}

/**
 * Expanded overclaim detection — catches variants the regex-based validator misses.
 *
 * The original OVERCLAIM_RE in grounding-validator.js catches specific phrases.
 * This catches the broader pattern of inflation language:
 *   - "extensive experience"
 *   - "expertise in"
 *   - "specializing in"
 *   - "adept at"
 *   - "proficient in"
 *   - "demonstrates expertise"
 *   - "complex systems"
 *   - "scalable infrastructure"
 *   - "robust"
 *   - "versatile"
 *   - "deep understanding"
 *   - "strong understanding"
 *   - "comprehensive"
 *   - "mastery"
 */
const EXPANDED_OVERCLAIM_RE = new RegExp('\\b(' +
  'extensive\\s+experience|' +
  'expertise\\s+in|' +
  'expert\\s+in|' +
  'specializing\\s+in|' +
  'specializes\\s+in|' +
  'proficient\\s+in|' +
  'proficiency\\s+in|' +
  'demonstrates\\s+(?:his\\s+|her\\s+|their\\s+)?expertise|' +
  'complex\\s+systems|' +
  'scalable\\s+infrastructure|' +
  'robust\\s+(?:software|infrastructure|backend|frontend|system|application)|' +
  'versatile\\s+and\\s+adaptable|' +
  'deep\\s+(?:understanding|knowledge)|' +
  'strong\\s+(?:understanding|knowledge\\s+of)|' +
  'comprehensive\\s+(?:understanding|knowledge|experience)|' +
  'mastery\\s+of|' +
  'world[- ]class|' +
  'cutting[- ]edge|' +
  'state[- ]of[- ]the[- ]art|' +
  'proven\\s+(?:leader|track\\s+record)|' +
  'enterprise[- ]scale|' +
  'production[- ]ready|' +
  'season(?:ed|ing)|' +
  'architect(?:ed|ing)\\s+' +
  ')\\b', 'gi');

/**
 * Check for expanded overclaim language in the answer.
 * Returns array of matched overclaim phrases.
 */
function detectExpandedOverclaim(answer) {
  const text = String(answer || '');
  const matches = [];
  let match;
  const re = new RegExp(EXPANDED_OVERCLAIM_RE.source, 'gi');
  while ((match = re.exec(text)) !== null) {
    matches.push(match[0].trim());
  }
  return matches;
}

/**
 * Detect fabricated entities — entities in the answer that don't exist
 * anywhere in the knowledge base.
 *
 * This catches things like "Vue.js" when Vue.js is not in any skill,
 * project, or experience entry.
 */
function detectFabricatedEntities(answer, graph, question = '') {
  const text = String(answer || '');
  const qText = String(question || '').toLowerCase();
  const fabricated = [];

  // Split answer into sentences to check sentence-level negation
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/).map(s => s.trim()).filter(Boolean);
  const negWordRe = /\b(?:no(?:t|ne|,)?|never|didn'?t|did not|doesn'?t|does not|isn'?t|is not|wasn'?t|was not|no evidence|not (?:a )?(?:known|verified|documented))\b/i;

  // Extract capitalized tech-like terms from the answer
  const techTerms = text.match(/\b([A-Z][a-z]+(?:JS|\.js|\.net)?|[A-Z]{2,})\b/g) || [];
  const knownEntities = new Set([...graph.entityIndex.keys()]);
  // Also add common English words that aren't entities
  const commonWords = new Set([
    'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'His', 'Her', 'Their',
    'He', 'She', 'They', 'It', 'Is', 'Was', 'Are', 'Were', 'Has', 'Have', 'Had',
    'Did', 'Does', 'Do', 'Can', 'Could', 'Would', 'Should', 'Will', 'May',
    'Might', 'Must', 'Been', 'Being', 'Not', 'No', 'Yes', 'But', 'And', 'Or',
    'So', 'For', 'As', 'If', 'When', 'Where', 'While', 'Although', 'Though',
    'Because', 'Since', 'However', 'Therefore', 'Moreover', 'Additionally',
    'Also', 'Well', 'Actually', 'Currently', 'Unfortunately', 'Honestly',
    'Sure', 'Correct', 'Right', 'True', 'False', 'Overall', 'Instead',
    'Rather', 'Meanwhile', 'Look', 'Consider', 'Analyze', 'Based', 'Built',
    'Used', 'Using', 'Made', 'Make', 'Get', 'Got', 'Give', 'Gave', 'Take',
    'Took', 'See', 'Saw', 'Know', 'Knew', 'Think', 'Thought', 'Feel', 'Felt',
    'Want', 'Wanted', 'Need', 'Needed', 'Let', 'Try', 'Trying', 'Going',
    'Show', 'Showing', 'Tell', 'Told', 'Ask', 'Asked', 'Good', 'Great',
    'Better', 'Best', 'Worst', 'Bad', 'New', 'Old', 'First', 'Last', 'Most',
    'More', 'Less', 'Least', 'Many', 'Much', 'Few', 'Several', 'Various',
    'Specific', 'General', 'Particular', 'Certain', 'Simple', 'Complex',
    'Clear', 'Important', 'Interesting', 'Useful', 'Helpful', 'Available',
    'Possible', 'Technical', 'Practical', 'Theoretical', 'Basic', 'Advanced',
    'Intermediate', 'Primary', 'Secondary', 'Main', 'Major', 'Minor', 'Key',
    'Core', 'Essential', 'Skills', 'Skill', 'Experience', 'Experiences',
    'Project', 'Projects', 'Work', 'Working', 'Role', 'Roles', 'Job', 'Jobs',
    'Career', 'Careers', 'Team', 'Teams', 'Company', 'Companies', 'School',
    'Schools', 'Degree', 'Degrees', 'Education', 'Certification',
    'Certifications', 'Technology', 'Technologies', 'Tech', 'Stack', 'Stacks',
    'Frontend', 'Backend', 'Fullstack', 'Full', 'Front', 'Back', 'Web',
    'Mobile', 'Desktop', 'Cloud', 'Server', 'Client', 'Data', 'Code',
    'Software', 'Hardware', 'System', 'Systems', 'Development', 'Developer',
    'Developers', 'Engineering', 'Engineer', 'Engineers', 'Program',
    'Programming', 'Programmer', 'Application', 'Applications', 'API', 'APIs',
    'UI', 'UX', 'CSS', 'HTML', 'JSON', 'XML', 'SQL', 'Gaps', 'Gap',
    'Weaknesses', 'Weakness', 'Strengths', 'Strength', 'Recruiters',
    'Recruiter', 'Hiring', 'Interview', 'Interviews', 'Resume', 'Portfolio',
    'Profile', 'Background', 'Summary', 'Scout', 'Bradley', 'Brad', 'React',
    'ReactJS', 'Node', 'NodeJS', 'TypeScript', 'JavaScript', 'Python', 'Java',
    'AWS', 'Docker', 'Kubernetes', 'Next', 'NextJS', 'Express', 'FastAPI',
    'Django', 'Flask', 'MongoDB', 'PostgreSQL', 'MySQL', 'Redis', 'DynamoDB',
    'Lambda', 'S3', 'Amplify', 'CloudFront', 'Sass', 'Tailwind', 'Bootstrap',
    'Jest', 'Cypress', 'Vite', 'Webpack', 'GitHub', 'GitLab', 'Bitbucket',
    'Linux', 'MacOS', 'Windows', 'After', 'Before', 'During', 'Through',
    'Between', 'Among', 'Across', 'Over', 'Under', 'Into', 'Onto', 'Upon',
    'Within', 'Without', 'About', 'From', 'With', 'By', 'On', 'In', 'At',
    'To', 'Of', 'Is', 'Was', 'Been', 'Being', 'Have', 'Has', 'Had', 'Do',
    'Does', 'Did', 'Will', 'Would', 'Could', 'Should', 'May', 'Might',
    'Must', 'Can', 'Here', 'There', 'Where', 'When', 'Why', 'How', 'What',
    'Who', 'Which', 'Whose', 'Whom', 'Some', 'Any', 'All', 'Both', 'Each',
    'Every', 'Neither', 'Either', 'His', 'Her', 'Its', 'Their', 'My', 'Your',
    'Our', 'Mine', 'Yours', 'Ours', 'Theirs', 'Him', 'Them', 'Us', 'Me',
    'You', 'I', 'He', 'She', 'It', 'They', 'We', 'Vue', 'VueJS', 'Intern',
    'Internship', 'Capstones', 'Capstone', 'Trainee', 'Associate',
    // Common non-tech acronyms and education terms
    'GPA', 'SAT', 'ACT', 'GMAT', 'GRE', 'TOEFL', 'IELTS', 'PDF', 'CSV',
    'PNG', 'JPG', 'JPEG', 'GIF', 'SVG', 'MP3', 'MP4', 'AVI', 'MOV',
    'URL', 'URI', 'HTTP', 'HTTPS', 'TCP', 'UDP', 'DNS', 'SSL', 'TLS',
    'CPU', 'GPU', 'RAM', 'SSD', 'HDD', 'USB', 'HDMI', 'WiFi', 'IP',
    'VPN', 'LAN', 'WAN', 'MAC', 'PCB', 'LED', 'LCD', 'OLED', 'QLED',
    'AI', 'ML', 'DL', 'NLP', 'CV', 'RL', 'GAN', 'LLM', 'RAG', 'BM25',
    'RRF', 'API', 'REST', 'GraphQL', 'gRPC', 'RPC', 'SDK', 'CLI', 'GUI',
    'TDD', 'BDD', 'DDD', 'CI', 'CD', 'DEV', 'QA', 'UX', 'UI', 'CX',
    'SEO', 'SEM', 'CRM', 'ERP', 'CMS', 'DMS', 'BI', 'ETL', 'OLAP',
    'NoSQL', 'SQL', 'ORM', 'DRY', 'KISS', 'YAGNI', 'SOLID', 'ACID',
    'BASE', 'CAP', 'WYSIWYG', 'MVC', 'MVP', 'MVVM', 'CQRS', 'ESB',
    'JSON', 'XML', 'YAML', 'TOML', 'INI', 'ENV', 'CSS', 'HTML', 'DOM',
    'BOM', 'SPA', 'MPA', 'PWA', 'SSR', 'SSG', 'ISR', 'CSR', 'SEO',
    'W3C', 'ECMA', 'IEEE', 'ISO', 'ANSI', 'ASCII', 'UTF', 'MIME',
    'MFA', '2FA', 'SSO', 'OAuth', 'OIDC', 'JWT', 'SAML', 'LDAP', 'AD',
    'MIT', 'Stanford', 'Harvard', 'Yale', 'Princeton', 'Berkeley',
    'Carnegie', 'Mellon', 'Caltech', 'Oxford', 'Cambridge',
    // Common non-entity terms that appear in answers
    'UIs', 'APIs', 'Apps', 'Applications', 'Frameworks', 'Libraries',
    'Tools', 'Techniques', 'Methods', 'Approaches', 'Solutions', 'Features',
    'Components', 'Modules', 'Packages', 'Services', 'Resources', 'Assets',
    'Platforms', 'Environments', 'Systems', 'Processes', 'Workflows',
    'Pipelines', 'Architectures', 'Patterns', 'Practices', 'Standards',
    // Adjectives/description words from project descriptions (not fabricated entities)
    // "Static Gen 1 Pokedex" comes from the Interactive Pokedex description text
    'Static', 'Gen', 'Interactive', 'Generation', 'Entry', 'Entries',
    // Generic computing/tool concepts — not specific invented projects
    'Calculator', 'Testing', 'Testing',
    // DevOps and infrastructure terms the model uses that exist in the domain
    'DevOps', 'Terraform', 'Bash', 'Kubernetes',
    // Learning platforms mentioned in answers
    'Udemy', 'Coursera', 'Pluralsight', 'LinkedIn',
  ]);

  for (const term of techTerms) {
    const norm = normalizeEntity(term);
    if (norm.length < 3) continue;
    if (commonWords.has(term)) continue;

    // Check if this entity exists anywhere in the graph
    let found = knownEntities.has(norm);
    if (!found) {
      // Check partial matches
      for (const key of knownEntities) {
        if (key.length >= 4 && (key.includes(norm) || norm.includes(key))) {
          found = true;
          break;
        }
      }
    }

    if (!found) {
      // Only flag if it looks like a tech term (not a common word)
      const looksLikeTech = /^[A-Z][a-z]+/.test(term) || /^[A-Z]{2,}$/.test(term);
      if (looksLikeTech) {
        const termLower = term.toLowerCase();
        // Check if the term appears in the user's question or in a negated sentence
        const inQuestion = qText.includes(termLower);
        const inNegatedSentence = sentences.some(s => s.toLowerCase().includes(termLower) && negWordRe.test(s));
        if (!inQuestion && !inNegatedSentence) {
          fabricated.push(term);
        }
      }
    }
  }

  return [...new Set(fabricated)];
}

module.exports = {
  validateRelationships,
  detectExpandedOverclaim,
  detectFabricatedEntities,
  EXPANDED_OVERCLAIM_RE,
  OVERCLAIM_RELATIONS
};
