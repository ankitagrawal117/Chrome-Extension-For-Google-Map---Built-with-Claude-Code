// Builds the final rows (phone normalisation + dedupe) and the .xlsx file.
// Needs the vendored SheetJS (lib/xlsx.full.min.js) and phone.js.
// Works in the popup (globals XLSX, PhoneUtil) and in Node (tests).

(function (root) {
  const XLSX_ = root.XLSX || (typeof require === 'function' ? require('./lib/xlsx.full.min.js') : null);
  const Phone = root.PhoneUtil || (typeof require === 'function' ? require('./phone.js') : null);

  const HEADERS = ['Name', 'Phone', 'Area', 'Rating', 'Reviews', 'Address', 'Maps URL'];
  const WIDTHS = [40, 14, 22, 8, 9, 60, 50];
  const VALID_SHEET = 'Valid Numbers Only';
  const MAIN_SHEET = 'Listings';

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function toRating(v) {
    const n = typeof v === 'number' ? v : parseFloat(String(v || '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : null;
  }
  function toInt(v) {
    const n = typeof v === 'number' ? v : parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  // Listings (as stored) → output rows, deduped by phone when present,
  // otherwise by Maps URL. First occurrence wins.
  function buildRows(listings, options) {
    const mobileOnly = !options || options.mobileOnly !== false;
    const seen = new Set();
    const rows = [];
    for (const l of listings || []) {
      const phone = Phone.pickPhone(l.phoneRaw != null ? l.phoneRaw : l.phone, { mobileOnly });
      const url = clean(l.url);
      const name = clean(l.name);
      const key = phone ? `p:${phone}` : url ? `u:${url}` : `n:${name.toLowerCase()}|${clean(l.address).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        name,
        phone,
        area: clean(l.area),
        rating: toRating(l.rating),
        reviews: toInt(l.reviews),
        address: clean(l.address),
        url,
      });
    }
    return rows;
  }

  function stats(listings, options) {
    const rows = buildRows(listings, options);
    return { rows: rows.length, valid: rows.filter((r) => r.phone).length };
  }

  const textCell = (v) => ({ t: 's', v, z: '@' });
  const strCell = (v) => ({ t: 's', v });

  function sheetFrom(headers, records, widths, phoneCol) {
    const ws = {};
    const enc = (r, c) => XLSX_.utils.encode_cell({ r, c });
    headers.forEach((h, c) => (ws[enc(0, c)] = strCell(h)));
    records.forEach((rec, i) => {
      rec.forEach((v, c) => {
        if (v === null || v === undefined || v === '') return; // blank cell
        if (c === phoneCol) ws[enc(i + 1, c)] = textCell(String(v));
        else if (typeof v === 'number') ws[enc(i + 1, c)] = { t: 'n', v };
        else ws[enc(i + 1, c)] = strCell(String(v));
      });
    });
    ws['!ref'] = XLSX_.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(records.length, 1), c: headers.length - 1 } });
    ws['!cols'] = widths.map((wch) => ({ wch }));
    ws['!autofilter'] = { ref: XLSX_.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: records.length, c: headers.length - 1 } }) };
    return ws;
  }

  // Returns a Uint8Array with the .xlsx file.
  function buildWorkbook(rows) {
    const main = sheetFrom(
      HEADERS,
      rows.map((r) => [r.name, r.phone, r.area, r.rating, r.reviews, r.address, r.url]),
      WIDTHS,
      1
    );
    const valid = sheetFrom(
      ['Name', 'Phone'],
      rows.filter((r) => Phone.isMobile(r.phone)).map((r) => [r.name, r.phone]),
      [WIDTHS[0], WIDTHS[1]],
      1
    );
    const wb = XLSX_.utils.book_new();
    XLSX_.utils.book_append_sheet(wb, main, MAIN_SHEET);
    XLSX_.utils.book_append_sheet(wb, valid, VALID_SHEET);
    const raw = XLSX_.write(wb, { type: 'array', bookType: 'xlsx', bookSST: true, compression: true });
    try {
      return addStyles(new Uint8Array(raw), [
        { path: 'xl/worksheets/sheet1.xml', textCol: 'B' },
        { path: 'xl/worksheets/sheet2.xml', textCol: 'B' },
      ]);
    } catch (e) {
      // Styling is cosmetic except the "@" column format; phone cells already
      // carry the text format individually, so the plain file is still safe.
      console.warn('[export] styling skipped:', e);
      return new Uint8Array(raw);
    }
  }

  // SheetJS Community Edition cannot write fonts or column styles, so patch
  // the generated XML: bold header row, "@" (text) format on the whole Phone
  // column, frozen header row. Uses SheetJS's bundled zip reader/writer.
  function addStyles(bytes, sheets) {
    const CFB = XLSX_.CFB;
    const zip = CFB.read(bytes, { type: 'array' });
    const dec = new TextDecoder();
    const encd = new TextEncoder();
    const entry = (p) => {
      const e = CFB.find(zip, `/${p}`);
      if (!e) throw new Error(`missing ${p}`);
      return e;
    };
    const readXml = (e) => dec.decode(e.content);
    const writeXml = (e, xml) => {
      e.content = encd.encode(xml);
      e.size = e.content.length;
    };

    // styles.xml: add a bold font and three cell formats.
    const stylesE = entry('xl/styles.xml');
    let styles = readXml(stylesE);
    const fonts = styles.match(/<fonts count="(\d+)">([\s\S]*?)<\/fonts>/);
    const xfs = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
    const baseFont = fonts && fonts[2].match(/<font>([\s\S]*?)<\/font>/);
    if (!fonts || !xfs || !baseFont) throw new Error('unexpected styles.xml');
    const boldFontId = Number(fonts[1]);
    styles = styles.replace(fonts[0], `<fonts count="${boldFontId + 1}">${fonts[2]}<font><b/>${baseFont[1]}</font></fonts>`);
    const n = Number(xfs[1]);
    const BOLD = n;
    const TEXT = n + 1;
    const BOLD_TEXT = n + 2;
    const xf = (numFmtId, fontId) =>
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="0" borderId="0" xfId="0"` +
      `${fontId ? ' applyFont="1"' : ''}${numFmtId ? ' applyNumberFormat="1"' : ''}/>`;
    styles = styles.replace(
      xfs[0],
      `<cellXfs count="${n + 3}">${xfs[2]}${xf(0, boldFontId)}${xf(49, 0)}${xf(49, boldFontId)}</cellXfs>`
    );
    writeXml(stylesE, styles);

    for (const { path, textCol } of sheets) {
      const e = entry(path);
      let xml = readXml(e);
      const colNum = XLSX_.utils.decode_col(textCol) + 1;
      // Cell styles: header row bold; text column "@".
      xml = xml.replace(/<c r="([A-Z]+)(\d+)"(?: s="\d+")?/g, (_, col, row) => {
        const header = row === '1';
        const isText = col === textCol;
        const s = header ? (isText ? BOLD_TEXT : BOLD) : isText ? TEXT : null;
        return s === null ? `<c r="${col}${row}"` : `<c r="${col}${row}" s="${s}"`;
      });
      // Column-level "@" so numbers typed/pasted later stay text too.
      const colRe = new RegExp(`<col min="${colNum}" max="${colNum}"`);
      if (!colRe.test(xml)) throw new Error('missing <col> for text column');
      xml = xml.replace(colRe, `<col min="${colNum}" max="${colNum}" style="${TEXT}"`);
      // Freeze the header row.
      xml = xml.replace(
        /<sheetView workbookViewId="0"\/>/,
        '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>'
      );
      writeXml(e, xml);
    }
    return new Uint8Array(CFB.write(zip, { type: 'array', fileType: 'zip', compression: true }));
  }

  function filename(category, city, date) {
    const safe = (s) =>
      String(s || '')
        .trim()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '') || 'listings';
    const d = date || new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${safe(category)}_${safe(city)}_${ymd}.xlsx`;
  }

  const api = { HEADERS, VALID_SHEET, MAIN_SHEET, buildRows, stats, buildWorkbook, filename };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Exporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
