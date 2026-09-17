'use strict';

/**
 * Accent colours the interface can be set to. Each supplies the three CSS
 * variables the stylesheet reads, plus the two gradient stops for the logo.
 */
const ACCENTS = {
  purple:  { name: 'Purple',  base: '#8e2dff', lit: '#b47cff', soft: 'rgba(142, 45, 255, 0.14)', from: '#a855f7', to: '#6d17d4' },
  blue:    { name: 'Blue',    base: '#2f6bff', lit: '#8fb0ff', soft: 'rgba(47, 107, 255, 0.15)', from: '#5b8cff', to: '#1f4fd8' },
  teal:    { name: 'Teal',    base: '#00b3a4', lit: '#63dbd1', soft: 'rgba(0, 179, 164, 0.15)',  from: '#2ed3c4', to: '#008f83' },
  emerald: { name: 'Emerald', base: '#12b76a', lit: '#6ee7b7', soft: 'rgba(18, 183, 106, 0.15)', from: '#34d399', to: '#0b8f52' },
  amber:   { name: 'Amber',   base: '#e8910c', lit: '#fbc24d', soft: 'rgba(232, 145, 12, 0.15)', from: '#fbbf24', to: '#b45309' },
  rose:    { name: 'Rose',    base: '#f43f5e', lit: '#fda4af', soft: 'rgba(244, 63, 94, 0.15)',  from: '#fb7185', to: '#be123c' },
  slate:   { name: 'Steel',   base: '#5b7cfa', lit: '#9db3ff', soft: 'rgba(91, 124, 250, 0.15)', from: '#8da2fb', to: '#4054c8' }
};

const DEFAULT = 'purple';

const isAccent = (key) => Object.prototype.hasOwnProperty.call(ACCENTS, String(key));
const get = (key) => ACCENTS[isAccent(key) ? key : DEFAULT];
const list = () => Object.entries(ACCENTS).map(([key, value]) => ({ key, ...value }));

module.exports = { ACCENTS, DEFAULT, get, list, isAccent };
