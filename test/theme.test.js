'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../src/lib/theme');

test('every accent supplies the variables the stylesheet needs', () => {
  for (const accent of theme.list()) {
    assert.match(accent.base, /^#[0-9a-f]{6}$/i, `${accent.key} base`);
    assert.match(accent.lit, /^#[0-9a-f]{6}$/i, `${accent.key} lit`);
    assert.match(accent.deep, /^#[0-9a-f]{6}$/i, `${accent.key} deep`);
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

// Contrast, so a colour cannot be added that is unreadable on one of the themes.
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('every accent is readable on the dark theme', () => {
  for (const accent of theme.list()) {
    const ratio = contrast(accent.lit, '#08080c');
    assert.ok(ratio >= 4.5, `${accent.name} is only ${ratio.toFixed(2)}:1 on the dark background`);
  }
});

test('every accent is readable on the light theme', () => {
  for (const accent of theme.list()) {
    const ratio = contrast(accent.deep, '#ffffff');
    assert.ok(ratio >= 4.5, `${accent.name} is only ${ratio.toFixed(2)}:1 on white`);
  }
});
