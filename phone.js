// Phone normalisation for Indian numbers → exactly 10 digits or ''.
// Used by the popup/export and by tests/phone.test.js (Node) and
// tests/test.html (browser).

(function (root) {
  // Separators between several numbers in one field: "98765 43210 / 98765 43211".
  // A dash is NOT a separator ("098765-43210" is one number).
  const SPLIT = /\s*(?:[\/,;|\n]|\bor\b)\s*/i;

  // Strip non-digits; drop a leading "91" from 12 digits or "0" from 11 digits;
  // keep the result only if it is exactly 10 digits.
  function normalizePhone(raw) {
    let d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d.length === 10 ? d : '';
  }

  function isMobile(tenDigits) {
    return /^[6-9]\d{9}$/.test(tenDigits || '');
  }

  // First valid number in a field that may hold several. With mobileOnly,
  // landlines are skipped (so a later mobile number in the same field wins).
  function pickPhone(raw, options) {
    const mobileOnly = !options || options.mobileOnly !== false;
    if (!raw) return '';
    for (const part of String(raw).split(SPLIT)) {
      const n = normalizePhone(part);
      if (!n) continue;
      if (mobileOnly && !isMobile(n)) continue;
      return n;
    }
    return '';
  }

  const api = { normalizePhone, isMobile, pickPhone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhoneUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
