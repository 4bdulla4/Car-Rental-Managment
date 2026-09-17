'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../src/lib/theme');

test('every accent supplies the variables the stylesheet needs', () => {
  for (const accent of theme.list()) {
    assert.match(accent.base, /^#[0-9a-f]{6}$/i, `${accent.key} base`);
    assert.match(accent.lit, /^#[0-9a-f]{6}$/i, `${accent.key} lit`);
    assert.match(accent.soft, /^rgba\(/, `${accent.key} soft`);
    assert.match(accent.from, /^#[0-9a-f]{6}$/i, `${accent.key} gradient start`);
    assert.match(accent.to, /^#[0-9a-f]{6}$/i, `${accent.key} gradient end`);
    assert.ok(accent.name, `${accent.key} needs a label`);
  }
});

test('an unknown or missing accent falls back to the default', () => {
  assert.equal(theme.get('neon').base, theme.ACCENTS[theme.DEFAULT].base);
  assert.equal(theme.get(undefined).base, theme.ACCENTS[theme.DEFAULT].base);
  assert.equal(theme.get(null).base, theme.ACCENTS[theme.DEFAULT].base);
});

test('only the listed keys are accepted', () => {
  assert.equal(theme.isAccent('teal'), true);
  assert.equal(theme.isAccent('neon'), false);
  // A prototype key must not be mistaken for a colour.
  assert.equal(theme.isAccent('constructor'), false);
  assert.equal(theme.isAccent('toString'), false);
});
