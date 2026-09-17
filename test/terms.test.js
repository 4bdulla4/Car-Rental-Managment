'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_TERMS, parse, forCompany } = require('../src/lib/terms');

test('blank clauses fall back to the standard set', () => {
  assert.deepEqual(forCompany('', 'Acme Rentals').length, DEFAULT_TERMS.length);
  assert.deepEqual(forCompany('   \n\n ', 'Acme Rentals').length, DEFAULT_TERMS.length);
});

test('one clause per line, ignoring blanks and any numbering typed in', () => {
  assert.deepEqual(parse('First\n\nSecond\n  \nThird'), ['First', 'Second', 'Third']);
  assert.deepEqual(parse('1. First\n2) Second\n 3.  Third'), ['First', 'Second', 'Third']);
});

test('{company} is replaced with the company name', () => {
  const clauses = forCompany('Report accidents to {company} at once.', 'Al Nakheel');
  assert.deepEqual(clauses, ['Report accidents to Al Nakheel at once.']);
});

test('the standard clauses name the company too', () => {
  const clauses = forCompany('', 'Al Nakheel');
  assert.ok(clauses.some((c) => c.includes('Al Nakheel')), 'the defaults should carry the name');
  assert.ok(!clauses.some((c) => c.includes('{company}')), 'no placeholder should survive');
});

test('custom clauses replace the standard set entirely', () => {
  const clauses = forCompany('Only clause.', 'Acme');
  assert.deepEqual(clauses, ['Only clause.']);
});
