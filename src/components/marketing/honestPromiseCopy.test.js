import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const RETIRED_PROMISES = [
  'human-monitored',
  'human-reviewed',
  'appointed professional',
  'hands off specialist',
  'prepares the handoff',
  'ihmisen valvoma',
  'ihminen tarkistaa',
  'expert review'
];

const COPY_FILES = [
  {
    name: 'DonnaLanding.jsx',
    url: new URL('./DonnaLanding.jsx', import.meta.url),
    anchor: 'You decide, Donna runs it'
  },
  {
    name: 'MarketingPage.jsx',
    url: new URL('./MarketingPage.jsx', import.meta.url),
    anchor: 'This is a source release of Donna.'
  },
  {
    name: 'HeroStories.jsx',
    url: new URL('./HeroStories.jsx', import.meta.url),
    anchor: 'One thing needs you.'
  }
];

function stripJsJsxComments(source) {
  let stripped = '';
  let quote = null;

  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      stripped += char;
      if (char === '\\') {
        stripped += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      stripped += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    const previous = index === 0 ? '\n' : source[index - 1];
    if (char === '/' && next === '/' && /\s/.test(previous)) {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }

    stripped += char;
    index += 1;
  }

  return stripped;
}

test('comment stripper preserves comment-shaped string content', () => {
  const source = [
    `const url = 'https://example.com/human-reviewed';`,
    `const block = "literal /* human-monitored */ content";`,
    '// human-reviewed',
    '{/* ihmisen valvoma */}'
  ].join('\n');

  const stripped = stripJsJsxComments(source);
  assert.match(stripped, /https:\/\/example\.com\/human-reviewed/);
  assert.match(stripped, /literal \/\* human-monitored \*\/ content/);
  assert.doesNotMatch(stripped, /ihmisen valvoma/i);
});

for (const copyFile of COPY_FILES) {
  test(`${copyFile.name} rendered copy keeps the honest promise`, async () => {
    const source = await readFile(copyFile.url, 'utf8');
    const renderedCopy = stripJsJsxComments(source);

    assert.ok(
      renderedCopy.includes(copyFile.anchor),
      `${copyFile.name} must retain its current honest-promise anchor`
    );
    for (const retiredPromise of RETIRED_PROMISES) {
      assert.equal(
        renderedCopy.toLocaleLowerCase('en-US').includes(retiredPromise),
        false,
        `${copyFile.name} rendered copy must not contain "${retiredPromise}"`
      );
    }
  });
}

