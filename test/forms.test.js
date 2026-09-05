import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConsultation, sanitizeWaiver, WAIVER_VERSION } from '../src/lib/forms.js';

// A 1x1 transparent PNG — the smallest thing that passes the signature check.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('waiver: happy path stores the version and printed name', () => {
  const out = sanitizeWaiver({
    client_name: '  Jane   Doe ',
    client_email: 'Jane@Example.com',
    client_phone: '931-555-0100',
    agreed: true,
    signature: PNG,
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.client_name, 'Jane Doe');
  assert.equal(out.value.client_email, 'jane@example.com');
  assert.equal(out.value.agreement_version, WAIVER_VERSION);
  assert.equal(out.value.data.printed_name, 'Jane Doe');
  assert.equal(out.value.data.is_guardian, false);
  assert.equal(out.value.signature_data_url, PNG);
});

test('waiver: refuses without agreement, signature, or email', () => {
  const base = { client_name: 'Jane', client_email: 'j@x.com', agreed: true, signature: PNG };
  assert.equal(sanitizeWaiver({ ...base, agreed: 'true' }).ok, false);
  assert.equal(sanitizeWaiver({ ...base, signature: 'data:image/jpeg;base64,AAAA' }).ok, false);
  assert.equal(sanitizeWaiver({ ...base, signature: '<script>' }).ok, false);
  assert.equal(sanitizeWaiver({ ...base, client_email: '' }).ok, false);
  assert.equal(sanitizeWaiver({ ...base, client_email: 'not-an-email' }).ok, false);
});

test('waiver: oversized signature is rejected', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
  assert.equal(sanitizeWaiver({ client_name: 'J', client_email: 'j@x.com', agreed: true, signature: huge }).ok, false);
});

test('waiver: guardian signing needs a guardian name', () => {
  const base = { client_name: 'Kid Doe', client_email: 'p@x.com', agreed: true, signature: PNG, is_guardian: true };
  assert.equal(sanitizeWaiver(base).ok, false);
  const ok = sanitizeWaiver({ ...base, guardian_name: 'Parent Doe' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.data.guardian_name, 'Parent Doe');
});

test('waiver: signed-in profile fills the name, typed name wins', () => {
  const profile = { full_name: 'Account Name', phone: '111' };
  const a = sanitizeWaiver({ client_email: 'a@x.com', agreed: true, signature: PNG }, profile);
  assert.equal(a.value.client_name, 'Account Name');
  assert.equal(a.value.client_phone, '111');
  const b = sanitizeWaiver({ client_name: 'Typed', client_email: 'a@x.com', agreed: true, signature: PNG }, profile);
  assert.equal(b.value.client_name, 'Typed');
});

test('consultation: keeps known options, drops unknown ones', () => {
  const out = sanitizeConsultation({
    client_name: 'Jane',
    answers: {
      services: ['Color', 'Bogus', 'Haircut'],
      length: 'Mid back',
      hairtype: 'Purple',
      feel: ['Dry', 'evil'],
      density: 'Thick',
      goals: '  grow it out  ',
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.data.services, ['Haircut', 'Color']);
  assert.equal(out.value.data.length, 'Mid back');
  assert.equal(out.value.data.hairtype, '');
  assert.deepEqual(out.value.data.feel, ['Dry']);
  assert.equal(out.value.data.goals, 'grow it out');
});

test('consultation: conditional answers are cleared unless the gate is yes', () => {
  const out = sanitizeConsultation({
    client_name: 'Jane',
    answers: {
      services: ['Perm'],
      color_before: 'no',
      last_color_date: 'last week',
      meds: 'yes',
      meds_list: 'thyroid',
      allergies: '',
      allergies_list: 'peanuts',
      ext_before: 'yes',
      ext_type: 'tape-in',
      ext_feedback: 'loved them',
    },
  });
  assert.equal(out.value.data.last_color_date, '');
  assert.equal(out.value.data.meds_list, 'thyroid');
  assert.equal(out.value.data.allergies_list, '');
  assert.equal(out.value.data.ext_type, 'tape-in');
  assert.equal(out.value.data.ext_feedback, 'loved them');
});

test('consultation: "None" is exclusive among conditions', () => {
  const out = sanitizeConsultation({
    client_name: 'Jane',
    answers: { services: ['Haircut'], conditions: ['None', 'Pregnant'] },
  });
  assert.deepEqual(out.value.data.conditions, ['Pregnant']);
});

test('consultation: needs a name and at least one service', () => {
  assert.equal(sanitizeConsultation({ answers: { services: ['Haircut'] } }).ok, false);
  assert.equal(sanitizeConsultation({ client_name: 'Jane', answers: { services: [] } }).ok, false);
});

test('consultation: long free text is capped, not rejected', () => {
  const out = sanitizeConsultation({
    client_name: 'Jane',
    answers: { services: ['Haircut'], goals: 'x'.repeat(5000) },
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.data.goals.length, 2000);
});
