'use strict';

const COLLECTION_TYPES = { projects: 'project', codePens: 'codepen', products: 'product', services: 'service' };

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKnowledgeEntities(knowledge) {
  const entities = [];
  for (const [sourceCollection, type] of Object.entries(COLLECTION_TYPES)) {
    const collection = knowledge?.[sourceCollection];
    if (!Array.isArray(collection)) continue;
    collection.forEach((raw, sourceIndex) => {
      if (!isRecord(raw)) return;
      const nameKey = type === 'codepen'
        ? (raw.title ? 'title' : 'name')
        : (raw.name ? 'name' : 'title');
      const name = typeof raw[nameKey] === 'string' ? raw[nameKey].trim() : '';
      if (!name) return;
      const sourcePath = `${sourceCollection}[${sourceIndex}]`;
      const descriptionKey = raw.description ? 'description' : 'summary';
      const attributesKey = isRecord(raw.attributes) ? 'attributes' : isRecord(raw.properties) ? 'properties' : null;
      const attributes = attributesKey ? { ...raw[attributesKey] } : {};
      entities.push({
        ...raw,
        name,
        type,
        aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(alias => typeof alias === 'string' && alias.trim()) : [],
        description: typeof raw[descriptionKey] === 'string' ? raw[descriptionKey] : '',
        attributes,
        sourcePath,
        sourceCollection,
        sourceIndex,
        raw,
        provenance: {
          name: `${sourcePath}.${nameKey}`,
          type: sourceCollection,
          aliases: `${sourcePath}.aliases`,
          description: raw[descriptionKey] ? `${sourcePath}.${descriptionKey}` : null,
          attributes: Object.fromEntries(Object.keys(attributes).map(key => [key, `${sourcePath}.${attributesKey}.${key}`]))
        }
      });
    });
  }
  return entities;
}

function normalizeKnowledgeSkills(knowledge) {
  const skills = [];
  const add = (item, group, sourcePath) => {
    const name = typeof item === 'string' ? item.trim()
      : isRecord(item) ? String(item.label || item.name || item.skill || item.title || '').trim() : '';
    const summary = isRecord(item) ? String(item.summary || item.description || item.detail || '').trim() : '';
    if (name || summary) skills.push({ name, summary, group, sourcePath });
  };
  if (Array.isArray(knowledge?.skills)) {
    knowledge.skills.forEach((item, index) => add(item, 'listed', `skills[${index}]`));
  } else if (isRecord(knowledge?.skills)) {
    for (const [group, values] of Object.entries(knowledge.skills)) {
      if (Array.isArray(values)) values.forEach((item, index) => add(item, group, `skills.${group}[${index}]`));
      else if (isRecord(values) || typeof values === 'string') add(values, group, `skills.${group}`);
    }
  }
  return skills;
}

module.exports = { normalizeKnowledgeEntities, normalizeKnowledgeSkills };
