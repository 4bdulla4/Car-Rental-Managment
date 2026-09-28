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
    for (const k of ['ink', 'inkDeep', 'hover', 'hoverDeep', 'linkDeep', 'fromDeep', 'toDeep', 'avatarInk', 'avatarInkDeep']) {
      assert.match(accent[k], /^#[0-9a-f]{6}$/i, `${accent.key} ${k}`);
    }
    assert.ok(accent.name, `${accent.key} needs a label`);
  }
});

test('an unknown or missing accent falls back to the default', () => {
  assert.equal(theme.get('neon').base, theme.ACCENTS[theme.DEFAULT].base);
  assert.equal(theme.get(undefined).base, theme.ACCENTS[theme.DEFAULT].base);
  assert.equal(theme.get(null).base, theme.ACCENTS[theme.DEFAULT].base);
});

test('Chrome is the only accent, and a colour stored before the picker went is ignored', () => {
  assert.deepEqual(theme.list().map((a) => a.key), ['chrome']);
  assert.equal(theme.isAccent('chrome'), true);
  assert.equal(theme.isAccent('teal'), false);
  assert.equal(theme.get('teal').name, 'Chrome', 'a site still storing teal is shown in Chrome');
});

test('only the listed keys are accepted', () => {
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

// The surfaces text actually sits on, from public/css/app.css.
const DARK = { bg: '#060607', card: '#111113', card2: '#17171a' };

test('every accent is readable on the dark theme', () => {
  for (const accent of theme.list()) {
    for (const [where, ground] of Object.entries(DARK)) {
      const ratio = contrast(accent.lit, ground);
      assert.ok(ratio >= 4.5, `${accent.name} is only ${ratio.toFixed(2)}:1 on the dark ${where}`);
    }
  }
});

test('every accent is readable on the light theme', () => {
  for (const accent of theme.list()) {
    const ratio = contrast(accent.deep, '#ffffff');
    assert.ok(ratio >= 4.5, `${accent.name} is only ${ratio.toFixed(2)}:1 on white`);
  }
});

test('a primary button can be read, whatever the accent and theme', () => {
  // White on teal was 2.6:1; the label colour now comes with the accent.
  for (const accent of theme.list()) {
    const dark = contrast(accent.ink, accent.base);
    const light = contrast(accent.inkDeep, accent.deep);
    assert.ok(dark >= 4.5, `${accent.name} button label is ${dark.toFixed(2)}:1 on the dark theme`);
    assert.ok(light >= 4.5, `${accent.name} button label is ${light.toFixed(2)}:1 on the light theme`);
  }
});

test('the button still reads when hovered', () => {
  for (const accent of theme.list()) {
    const dark = contrast(accent.ink, accent.hover);
    const light = contrast(accent.inkDeep, accent.hoverDeep);
    assert.ok(dark >= 4.5, `${accent.name} hovered label is ${dark.toFixed(2)}:1 on the dark theme`);
    assert.ok(light >= 4.5, `${accent.name} hovered label is ${light.toFixed(2)}:1 on the light theme`);
  }
});

test('links are readable on white, and distinct from body text there', () => {
  for (const accent of theme.list()) {
    const ratio = contrast(accent.linkDeep, '#ffffff');
    assert.ok(ratio >= 4.5, `${accent.name} links are ${ratio.toFixed(2)}:1 on white`);
  }
  // Chrome's fill on paper is black, and so is the text: its links sit a step of grey away.
  const chrome = theme.get('chrome');
  assert.notEqual(chrome.linkDeep, chrome.deep, 'a link must not look exactly like body text');
  // And chrome carries no hue anywhere — every colour it uses is a pure grey.
  for (const k of ['base', 'lit', 'deep', 'linkDeep', 'hover', 'hoverDeep', 'from', 'to', 'fromDeep', 'toDeep']) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(chrome[k].slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, `chrome ${k} ${chrome[k]} has a tint`);
  }
});

test('the avatar letter reads across its whole gradient', () => {
  for (const accent of theme.list()) {
    const worst = Math.min(contrast(accent.avatarInk, accent.from), contrast(accent.avatarInk, accent.to));
    assert.ok(worst >= 3, `${accent.name} avatar letter drops to ${worst.toFixed(2)}:1`);
  }
});

test('secondary text is readable on the dark surfaces', () => {
  const muted = '#8f8f98';
  for (const [where, ground] of Object.entries(DARK)) {
    const ratio = contrast(muted, ground);
    assert.ok(ratio >= 4.5, `muted text is ${ratio.toFixed(2)}:1 on the dark ${where}`);
  }
});

test('the Vida Miami chrome is the default look', () => {
  assert.equal(theme.DEFAULT, 'chrome');
  assert.equal(theme.get(undefined).name, 'Chrome');
});
