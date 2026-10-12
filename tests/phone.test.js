// Run: node tests/phone.test.js
const { pickPhone } = require('../phone.js');
const CASES = require('./phone.cases.js');

let failed = 0;
for (const [input, mobile, any] of CASES) {
  for (const [mobileOnly, expected] of [[true, mobile], [false, any]]) {
    const got = pickPhone(input, { mobileOnly });
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  mobileOnly=${String(mobileOnly).padEnd(5)}  ${JSON.stringify(input).padEnd(32)} → ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
  }
}
console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
