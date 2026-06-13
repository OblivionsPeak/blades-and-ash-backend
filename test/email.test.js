import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/lib/email.js';

test('escapes HTML-significant characters', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('"quoted"'), '&quot;quoted&quot;');
  assert.equal(esc("it's"), 'it&#39;s');
});

test('neutralizes an injection attempt in a guest name', () => {
  const out = esc('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<'));
  assert.ok(!out.includes('>'));
});

test('handles null/undefined as empty string', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});
