// Builds the final rows (phone normalisation + dedupe) and the .xlsx file.
// Needs the vendored SheetJS (lib/xlsx.full.min.js) and phone.js.
// Works in the popup (globals XLSX, PhoneUtil) and in Node (tests).

(function (root) {
  const Phone = root.PhoneUtil || (typeof require === 'function' ? require('./phone.js') : null);

  // SheetJS is looked up when exporting (not at load time). If it is missing
  // (e.g. the lib/ folder was not copied) the built-in writer below is used.
  function sheetJs() {
    if (root.XLSX && root.XLSX.utils && root.XLSX.CFB) return root.XLSX;
    if (typeof require === 'function') {
      try {
        return require('./lib/xlsx.full.min.js');
      } catch {
        return null;
      }
    }
    return null;
  }

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

  function sheetFrom(XLSX_, { headers, records, widths, textCol: phoneCol }) {
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

  function sheetSpecs(rows) {
    return [
      {
        name: MAIN_SHEET,
        headers: HEADERS,
        records: rows.map((r) => [r.name, r.phone, r.area, r.rating, r.reviews, r.address, r.url]),
        widths: WIDTHS,
        textCol: 1,
      },
      {
        name: VALID_SHEET,
        headers: ['Name', 'Phone'],
        records: rows.filter((r) => Phone.isMobile(r.phone)).map((r) => [r.name, r.phone]),
        widths: [WIDTHS[0], WIDTHS[1]],
        textCol: 1,
      },
    ];
  }

  // Returns a Uint8Array with the .xlsx file. Uses SheetJS when available,
  // otherwise (or if SheetJS throws) the built-in writer.
  function buildWorkbook(rows, options) {
    const specs = sheetSpecs(rows);
    const XLSX_ = options && options.builtin ? null : sheetJs();
    if (XLSX_) {
      try {
        return buildWithSheetJs(XLSX_, specs);
      } catch (e) {
        console.warn('[export] SheetJS failed, using built-in writer:', e);
      }
    } else {
      console.warn('[export] SheetJS (lib/xlsx.full.min.js) not loaded, using built-in writer');
    }
    return buildBuiltin(specs);
  }

  function buildWithSheetJs(XLSX_, specs) {
    const wb = XLSX_.utils.book_new();
    for (const spec of specs) XLSX_.utils.book_append_sheet(wb, sheetFrom(XLSX_, spec), spec.name);
    const raw = XLSX_.write(wb, { type: 'array', bookType: 'xlsx', bookSST: true, compression: true });
    try {
      return addStyles(XLSX_, new Uint8Array(raw), specs.map((spec, i) => ({
        path: `xl/worksheets/sheet${i + 1}.xml`,
        textCol: XLSX_.utils.encode_col(spec.textCol),
      })));
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
  function addStyles(XLSX_, bytes, sheets) {
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

  // -------------------------------------------------------------------------
  // Built-in .xlsx writer (no dependencies): uncompressed zip + SpreadsheetML.
  // Same layout as the SheetJS path: bold frozen header, column widths,
  // autofilter, Phone column and cells formatted as text ("@").

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
  // cellXfs indexes in the styles below
  const XF = { normal: 0, bold: 1, text: 2, boldText: 3 };

  function xmlEscape(s) {
    return String(s)
      // characters not allowed in XML 1.0
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(c) {
    let s = '';
    for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
    return s;
  }

  function sheetXml(spec) {
    const { headers, records, widths, textCol } = spec;
    const lastCol = colName(headers.length - 1);
    const lastRow = records.length + 1;
    const cols = widths
      .map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w + 0.83}" customWidth="1"${c === textCol ? ` style="${XF.text}"` : ''}/>`)
      .join('');
    const str = (ref, v, s) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    const rowsXml = [];
    rowsXml.push(
      `<row r="1">${headers.map((h, c) => str(`${colName(c)}1`, h, c === textCol ? XF.boldText : XF.bold)).join('')}</row>`
    );
    records.forEach((rec, i) => {
      const r = i + 2;
      const cells = [];
      rec.forEach((v, c) => {
        if (v === null || v === undefined || v === '') return;
        const ref = `${colName(c)}${r}`;
        if (c === textCol) cells.push(str(ref, String(v), XF.text));
        else if (typeof v === 'number' && Number.isFinite(v)) cells.push(`<c r="${ref}"><v>${v}</v></c>`);
        else cells.push(str(ref, String(v), XF.normal));
      });
      rowsXml.push(`<row r="${r}">${cells.join('')}</row>`);
    });
    return (
      `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<dimension ref="A1:${lastCol}${lastRow}"/>` +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      `<cols>${cols}</cols>` +
      `<sheetData>${rowsXml.join('')}</sheetData>` +
      `<autoFilter ref="A1:${lastCol}${lastRow}"/>` +
      '</worksheet>'
    );
  }

  function buildBuiltin(specs) {
    const files = [];
    const add = (path, xml) => files.push({ path, data: new TextEncoder().encode(xml) });

    add(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        specs
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join('') +
        '</Types>'
    );
    add(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    );
    add(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
        specs.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets><definedNames>' +
        specs
          .map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEscape(s.name)}'!$A$1:$${colName(s.headers.length - 1)}$${s.records.length + 1}</definedName>`)
          .join('') +
        '</definedNames></workbook>'
    );
    add(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
        specs
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('') +
        `<Relationship Id="rId${specs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>'
    );
    add(
      'xl/styles.xml',
      `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
        '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'
    );
    specs.forEach((spec, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(spec)));
    return zipStore(files);
  }

  // Minimal ZIP writer (STORE method, UTF-8 names).
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipStore(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.path);
      const crc = crc32(f.data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // STORE
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, f.data.length, true);
      local.setUint32(22, f.data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      locals.push(new Uint8Array(local.buffer), name, f.data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, dosTime, true);
      central.setUint16(14, dosDate, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, f.data.length, true);
      central.setUint32(24, f.data.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      centrals.push(new Uint8Array(central.buffer), name);
      offset += 30 + name.length + f.data.length;
    }
    const centralSize = centrals.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let pos = 0;
    for (const a of parts) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
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
