// Tiny assertion helpers shared by the v2.0 tests (plain Node, no framework).
let passed = 0;
const failures = [];
export function ok(cond, name) {
  if (cond) passed++;
  else { failures.push(name); console.log('FAIL', name); }
}
export function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failures.push(name); console.log('FAIL', name, '\n   expected', e, '\n   actual  ', a); }
}
export async function rejects(fn, pattern, name) {
  try { await fn(); } catch (err) {
    const msg = String((err && err.message) || err);
    if (!pattern || pattern.test(msg)) { passed++; return; }
    failures.push(name); console.log('FAIL', name, '\n   wrong error:', msg); return;
  }
  failures.push(name); console.log('FAIL', name, '\n   expected an error, got none');
}
export function done(label) {
  if (failures.length) { console.log(`${label}: ${failures.length} FAILED, ${passed} passed`); process.exit(1); }
  console.log(`${label}: all ${passed} checks passed`);
}
