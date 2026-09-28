'use strict';

/**
 * Accent colours the interface can be set to.
 *
 * Each accent is used four ways, and each use has its own contrast problem:
 *   lit   text and highlights on the dark theme
 *   base  the fill of a primary button on the dark theme
 *   deep  both of those on the light theme, where a pale tint vanishes
 *   ink   the text written on top of the fill
 *
 * `ink` is not chosen by eye. The brighter accents — teal, emerald, amber —
 * are too light to carry white text (teal manages 2.6:1 against the 4.5:1 a
 * button label needs), so the label colour is whichever of white and near-black
 * reads better on that fill, measured.
 *
 * Chrome is the Vida Miami mark: silver line work on black. It is nearly
 * colourless by design, so its links are a step of grey away from body text
 * rather than a hue, and links inside sentences are underlined.
 */
const ACCENTS = {
  chrome: {
    // Pure neutral: no hue at all. Links are told apart by weight of grey and,
    // inside sentences, an underline — not by a tint of blue.
    name: 'Chrome', base: '#e4e6eb', lit: '#c4c6cc', deep: '#17181c',
    // Near-black barely changes when darkened, so on paper it lifts instead.
    hoverDeep: '#2e3037', linkDeep: '#4b4e56',
    from: '#f4f4f5', to: '#a6a7ab', fromDeep: '#3b3c40', toDeep: '#101012'
  },
  purple:  { name: 'Purple',  base: '#8e2dff', lit: '#b47cff', deep: '#6d17d4', from: '#a855f7', to: '#6d17d4' },
  blue:    { name: 'Blue',    base: '#2a64f5', lit: '#8fb0ff', deep: '#1f4fd8', from: '#5b8cff', to: '#1f4fd8' },
  teal:    { name: 'Teal',    base: '#00b3a4', lit: '#63dbd1', deep: '#00706a', from: '#2ed3c4', to: '#008f83' },
  emerald: { name: 'Emerald', base: '#12b76a', lit: '#6ee7b7', deep: '#0a7343', from: '#34d399', to: '#0b8f52' },
  amber:   { name: 'Amber',   base: '#e8910c', lit: '#fbc24d', deep: '#96450a', from: '#fbbf24', to: '#b45309' },
  rose:    { name: 'Rose',    base: '#f43f5e', lit: '#fda4af', deep: '#be123c', from: '#fb7185', to: '#be123c' },
  slate:   { name: 'Steel',   base: '#5b7cfa', lit: '#9db3ff', deep: '#3a4db8', from: '#8da2fb', to: '#4054c8' }
};

const DEFAULT = 'chrome';

const WHITE = '#ffffff';
const INK = '#0b0c0e';

/** [r, g, b] from "#rrggbb". */
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** "142, 45, 255" — lets the stylesheet build rgba() at any alpha it needs. */
const channels = (hex) => rgbOf(hex).join(', ');

/** WCAG relative luminance and contrast ratio. */
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mixes a colour toward white (amount > 0) or black (amount < 0). */
function shade(hex, amount) {
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return '#' + rgbOf(hex).map((v) => Math.round(v + (target - v) * t).toString(16).padStart(2, '0')).join('');
}

/**
 * A hover moves away from the label colour, so it can only make the label
 * easier to read. Moving toward it — lightening a fill that carries white
 * text — took teal's hovered label down to 4:1.
 */
const hoverFor = (fill, ink) => shade(fill, ink === WHITE ? -0.16 : 0.18);

/**
 * Whichever of white and near-black reads better on a fill. A gradient passes
 * both ends, and the letter has to read on the worse of the two.
 */
const inkFor = (...fills) => {
  const worst = (ink) => Math.min(...fills.map((f) => contrast(ink, f)));
  return worst(WHITE) >= worst(INK) ? WHITE : INK;
};

const isAccent = (key) => Object.prototype.hasOwnProperty.call(ACCENTS, String(key));

/**
 * Everything the stylesheet needs for one accent, for both themes. Accents
 * that do not spell out a value get the one that suits a saturated colour.
 */
function get(key) {
  const a = ACCENTS[isAccent(key) ? key : DEFAULT];
  const ink = inkFor(a.base);
  const inkDeep = inkFor(a.deep);
  const full = {
    ...a,
    hover: a.hover || hoverFor(a.base, ink),
    hoverDeep: a.hoverDeep || hoverFor(a.deep, inkDeep),
    linkDeep: a.linkDeep || a.deep,
    fromDeep: a.fromDeep || a.from,
    toDeep: a.toDeep || a.to
  };
  return {
    ...full,
    ink,
    inkDeep,
    avatarInk: inkFor(full.from, full.to),
    avatarInkDeep: inkFor(full.fromDeep, full.toDeep),
    soft: `rgba(${channels(full.base)}, 0.14)`,
    rgb: channels(full.base),
    deepRgb: channels(full.deep)
  };
}

const list = () => Object.keys(ACCENTS).map((key) => ({ key, ...get(key) }));

module.exports = { ACCENTS, DEFAULT, get, list, isAccent, contrast, inkFor, shade };
