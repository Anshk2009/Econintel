// Self-check: "Edit Profile" never pretends to change account data (chat.html).
// Run: node .scripts/test-edit-profile.mjs
//
// WHY THIS EXISTS — audit SEC-17. The modal let the reader "change" their email
// and username and said "Save changes" — but it only rewrote localStorage. No
// server call exists. A reader who "changed" their email reasonably believed
// reset links would go to the new address; they did not, and the next refresh
// silently put the old values back.
//
// There is no update-profile endpoint, so email and username are shown
// read-only. Display name is a purely local nicety, so it stays editable and
// says so.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../chat.html', import.meta.url), 'utf8');
const fn = html.match(/function handleEditProfile\(e\) \{[\s\S]*?\n\}/);
assert.ok(fn, 'handleEditProfile not found');
assert.ok(!/email\s*:/.test(fn[0]), 'handleEditProfile still writes an email it cannot actually change');
assert.ok(!/username\s*:/.test(fn[0]), 'handleEditProfile still writes a username it cannot actually change');

const form = html.match(/which === 'edit'[\s\S]*?<\/form>`;/);
assert.ok(form, 'edit-profile form not found');
for (const id of ['ep-email', 'ep-username']) {
  const input = form[0].match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  assert.ok(input, `${id} input missing`);
  assert.ok(/\breadonly\b/.test(input[0]), `${id} must be readonly — there is no endpoint that saves it`);
}
assert.ok(/this device/i.test(form[0]), 'the display-name field must say it only changes this device');

console.log('edit profile honesty: OK');
