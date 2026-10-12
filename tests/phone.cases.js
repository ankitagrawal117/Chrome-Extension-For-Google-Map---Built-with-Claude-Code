// Shared test cases: [input, expected with mobileOnly ON, expected with mobileOnly OFF]
(function (root) {
  const CASES = [
    ['+91 98765 43210', '9876543210', '9876543210'],
    ['098765 43210', '9876543210', '9876543210'],
    ['098765-43210', '9876543210', '9876543210'],
    ['(020) 2567 1234', '', '2025671234'],
    ['98765 43210 / 98765 43211', '9876543210', '9876543210'],
    ['1800 123 4567', '', ''],
    ['9876543210', '9876543210', '9876543210'],
    // extra edge cases
    ['', '', ''],
    ['+91 20 2567 1234', '', '2025671234'],
    ['020 2567 1234 / 99999 88888', '9999988888', '2025671234'],
    ['98765 4321', '', ''],
    ['+1 (415) 555-0100', '', ''],
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = CASES;
  else root.PHONE_CASES = CASES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
