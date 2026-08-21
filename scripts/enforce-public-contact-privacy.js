'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(__dirname, '..', 'data', 'recruiter-knowledge.json');
const PUBLIC_PHONE = '(608) 313-5373';
const PUBLIC_PHONE_DIGITS = '6083135373';
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g;

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

function scrubString(value, keyName = '') {
  const keyLooksLikePhone = /phone|telephone|mobile|cell/i.test(String(keyName || ''));
  let changed = false;
  const result = String(value).replace(PHONE_RE, match => {
    const digits = normalizePhoneDigits(match);
    if (digits === PUBLIC_PHONE_DIGITS) return PUBLIC_PHONE;
    changed = true;
    return keyLooksLikePhone ? PUBLIC_PHONE : '[phone withheld]';
  });
  return { value: result, changed };
}

function scrubValue(value, keyName = '', stats = { replacements: 0 }) {
  if (typeof value === 'string') {
    const scrubbed = scrubString(value, keyName);
    if (scrubbed.changed) stats.replacements += 1;
    return scrubbed.value;
  }

  if (Array.isArray(value)) {
    return value.map(item => scrubValue(item, keyName, stats));
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      value[key] = scrubValue(child, key, stats);
    }
  }

  return value;
}

function assertNoDisallowedPhones(value, pathParts = []) {
  if (typeof value === 'string') {
    const matches = value.match(PHONE_RE) || [];
    for (const match of matches) {
      if (normalizePhoneDigits(match) !== PUBLIC_PHONE_DIGITS) {
        throw new Error(`Disallowed public phone remains at ${pathParts.join('.') || '<root>'}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoDisallowedPhones(child, [...pathParts, index]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertNoDisallowedPhones(child, [...pathParts, key]);
    }
  }
}

function main() {
  const original = fs.readFileSync(TARGET, 'utf8');
  const knowledge = JSON.parse(original);
  const stats = { replacements: 0 };
  const scrubbed = scrubValue(knowledge, '', stats);
  assertNoDisallowedPhones(scrubbed);
  fs.writeFileSync(TARGET, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
  console.log(`contact privacy: PASS (${stats.replacements} disallowed phone field/text replacement${stats.replacements === 1 ? '' : 's'})`);
}

if (require.main === module) main();

module.exports = {
  PUBLIC_PHONE,
  normalizePhoneDigits,
  scrubString,
  scrubValue,
  assertNoDisallowedPhones
};
