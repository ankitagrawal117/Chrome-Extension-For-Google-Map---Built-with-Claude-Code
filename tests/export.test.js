// Run: node tests/export.test.js
// Builds a workbook from sample listings and checks rows, dedupe, sheets and
// that Phone cells are text with the "@" format.
const XLSX = require('../lib/xlsx.full.min.js');
const Exporter = require('../export.js');

const listings = [
  { name: ' Dr.  Mehta\n Skin Clinic ', phoneRaw: '+91 98765 43210', area: 'Kothrud', rating: 4.5, reviews: 120, address: 'A, Kothrud, Pune', url: 'https://www.google.com/maps/place/a' },
  { name: 'Landline Clinic', phoneRaw: '(020) 2567 1234', area: 'Baner', rating: '', reviews: '', address: 'B, Baner, Pune', url: 'https://www.google.com/maps/place/b' },
  { name: 'Same number, other place', phoneRaw: '098765-43210', url: 'https://www.google.com/maps/place/c' },
  { name: 'No phone', phoneRaw: '', url: 'https://www.google.com/maps/place/d' },
  { name: 'No phone again (same URL)', phoneRaw: '', url: 'https://www.google.com/maps/place/d' },
];

let failed = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

const rows = Exporter.buildRows(listings, { mobileOnly: true });
check('dedupe by phone, then URL → 3 rows', rows.length === 3);
check('name whitespace collapsed', rows[0].name === 'Dr. Mehta Skin Clinic');
check('landline blank when mobile-only', rows[1].phone === '');
check('landline kept when mobile-only off', Exporter.buildRows(listings, { mobileOnly: false })[1].phone === '2025671234');

for (const mode of ['sheetjs', 'builtin']) {
  const bytes = Exporter.buildWorkbook(rows, { builtin: mode === 'builtin' });
  const check2 = (label, cond) => check(`[${mode}] ${label}`, cond);
  const wb = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  check2('sheet names', JSON.stringify(wb.SheetNames) === JSON.stringify(['Listings', 'Valid Numbers Only']));
  const ws = wb.Sheets.Listings;
  const header = Exporter.HEADERS.map((_, c) => ws[XLSX.utils.encode_cell({ r: 0, c })].v);
  check2('header order', header.join('|') === 'Name|Phone|Area|Rating|Reviews|Address|Maps URL');
  check2('phone is a text cell', ws.B2.t === 's' && ws.B2.v === '9876543210');
  check2('phone cell format is @', ws.B2.z === '@');
  check2('rating numeric', ws.D2.t === 'n' && ws.D2.v === 4.5);
  check2('reviews integer', ws.E2.t === 'n' && ws.E2.v === 120);
  check2('blank phone cell is empty', !ws.B3);
  check2('unicode name kept', ws.A2.v === 'Dr. Mehta Skin Clinic');
  const valid = XLSX.utils.sheet_to_json(wb.Sheets['Valid Numbers Only'], { header: 1 });
  check2('valid sheet has only mobile rows', valid.length === 2 && valid[1][1] === '9876543210');
  if (process.env.XLSX_OUT) require('fs').writeFileSync(`${process.env.XLSX_OUT}/${mode}.xlsx`, bytes);
}
check('filename', /^Dermatologist_Pune_\d{4}-\d{2}-\d{2}\.xlsx$/.test(Exporter.filename('Dermatologist', 'Pune')));

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
