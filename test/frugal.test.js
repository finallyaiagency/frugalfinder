import { test } from 'node:test';
import assert from 'node:assert';
import { buildUserPrompt } from '../api/_lib/frugal.js';

test('buildUserPrompt includes all wishlist fields', () => {
  const wl = {
    item: '10ft fishing kayak',
    use_case: 'flatwater lakes',
    budget: 'under $400',
    flexibility: 'used ok',
    cadence: 'daily',
    source_url: 'https://example.com/listing',
  };
  const p = buildUserPrompt(wl);
  assert.match(p, /10ft fishing kayak/);
  assert.match(p, /flatwater lakes/);
  assert.match(p, /under \$400/);
  assert.match(p, /used ok/);
  assert.match(p, /example\.com\/listing/);
  assert.match(p, /daily/);
});

test('buildUserPrompt omits source_url when absent', () => {
  const p = buildUserPrompt({ item: 'x', use_case: '', budget: '', flexibility: '' });
  assert.doesNotMatch(p, /SOURCE PAGE/);
});
