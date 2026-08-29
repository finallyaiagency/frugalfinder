import { test } from 'node:test';
import assert from 'node:assert';
import { buildUserPrompt } from '../api/_lib/frugal.js';
import { shoppingIntent, matchPreference } from '../api/_lib/wishlist.js';

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

test('prompt carries notes and match preference to the analyst', () => {
  const p = buildUserPrompt({ item: 'gazebo panel', notes: 'faux stone only', match_preference: 'exact' });
  assert.match(p, /faux stone only/);
  assert.match(p, /exact/);
});

test('ordinary Telegram conversation is not shopping intent', () => {
  assert.equal(shoppingIntent('Thanks, that is helpful!'), false);
  assert.equal(shoppingIntent('/help'), false);
  assert.equal(shoppingIntent('Please find a used kayak under $400'), true);
  assert.equal(shoppingIntent('', { hasPhoto: true }), true);
  assert.equal(matchPreference('EXACT'), 'exact');
  assert.equal(matchPreference('anything else'), 'similar');
});

test('buildUserPrompt omits source_url when absent', () => {
  const p = buildUserPrompt({ item: 'x', use_case: '', budget: '', flexibility: '' });
  assert.doesNotMatch(p, /SOURCE PAGE/);
});
