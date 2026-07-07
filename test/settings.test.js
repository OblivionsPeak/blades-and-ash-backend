import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../src/lib/settings.js';

test('sanitize keeps valid fields and trims', () => {
  const out = sanitizeSettings({
    business_name: '  Blades & Ash Studio ',
    address_line: '123 Main St',
    city: 'Clarksville',
    state: 'TN',
    zip: '37040',
    phone: '(931) 555-0123',
    public_email: 'owner@bladeandash.com',
  });
  assert.equal(out.business_name, 'Blades & Ash Studio');
  assert.equal(out.city, 'Clarksville');
  assert.equal(out.phone, '(931) 555-0123');
});

test('sanitize drops unknown keys', () => {
  const out = sanitizeSettings({ business_name: 'X', evil: 'payload', role: 'admin' });
  assert.equal(out.evil, undefined);
  assert.equal(out.role, undefined);
});

test('urls: https enforced, bare domains upgraded, junk rejected', () => {
  const out = sanitizeSettings({
    instagram: 'instagram.com/bladesandash',
    facebook: 'javascript:alert(1)',
    tiktok: 'not a url at all //',
    maps_url: 'https://maps.app.goo.gl/abc',
  });
  assert.equal(out.instagram, 'https://instagram.com/bladesandash');
  assert.equal(out.facebook, '');
  assert.equal(out.tiktok, '');
  assert.equal(out.maps_url, 'https://maps.app.goo.gl/abc');
});

test('hours: valid days kept, invalid times dropped, closed respected', () => {
  const out = sanitizeSettings({
    hours: {
      mon: { open: '09:00', close: '17:00' },
      tue: { open: '25:00', close: '17:00' },   // invalid open
      wed: { closed: true },
      xyz: { open: '09:00', close: '17:00' },   // not a day
      thu: 'nonsense',
    },
  });
  assert.deepEqual(out.hours.mon, { open: '09:00', close: '17:00', closed: false });
  assert.equal(out.hours.tue, undefined);
  assert.deepEqual(out.hours.wed, { closed: true });
  assert.equal(out.hours.xyz, undefined);
  assert.equal(out.hours.thu, undefined);
});

test('long values are truncated, non-strings become empty', () => {
  const out = sanitizeSettings({ business_name: 'x'.repeat(500), phone: 12345, city: null });
  assert.equal(out.business_name.length, 80);
  assert.equal(out.phone, '');
  assert.equal(out.city, '');
});

test('empty/garbage input yields the empty shape', () => {
  for (const input of [undefined, null, 'string', 42, []]) {
    const out = sanitizeSettings(input);
    assert.equal(out.business_name, '');
    assert.deepEqual(out.hours, {});
  }
});
