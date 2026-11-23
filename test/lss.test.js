import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript, renderUpdate, describeScript, escapeForDisplay } from '../src/lss.js';
import { decodeCp1252, encodeCp1252 } from '../src/cp1252.js';

const fixture = (name) => parseScript(decodeCp1252(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));

// The values FinishLynx would send for split 2 of 3 (DESIGN.md 4.7); names invented
const HEADER = { 1: 'UNOFFICIAL', 2: 'Girls Varsity 5K', 3: '', 4: '3', 5: '1', 6: '1', 0x0a: '' };
const ROW = { 1: '12', 2: '', 3: '1234', 4: 'Smith', 5: 'Queens HS', 6: '', 7: '', 8: '5:12.345', 9: '5:12.345',
  0x0a: '2', 0x0b: 'F', 0x0c: '', 0x17: 'Jane', 0x18: 'Smith' };

const XC_RESULT = '{"T":"T","D":{"EN":3,"R":1,"H":1,"S":"UNOFFICIAL","DS":"","DN":"Girls Varsity 5K","W":"","P":"12",' +
  '"L":"","BIB":"1234","N":"Smith","AF":"Queens HS","T":"","RT":"","L2G":"2","CS":"5:12.345","LS":"5:12.345",' +
  '"FN":"Jane","LN":"Smith","LICENCE":"F"}}\r\n';

const RUNNER = '"P":"12","L":"","BIB":"1234","N":"Smith","AF":"Queens HS","T":"","RT":"","L2G":"2","CS":"5:12.345",' +
  '"LS":"5:12.345","FN":"Jane","LN":"Smith"';

/** A one-section script from format lines, for the language tests. */
const script = (...lines) => parseScript(lines.join('\r\n'));
const body = (...lines) => script(';;Results', ...lines);
/** Text of a Results-only script for one row (no JSON safety: these scripts are not JSON). */
const render = (s, row = {}, more = {}) => renderUpdate(s, { header: HEADER, rows: [row], json: false, ...more });
const text = (...lines) => render(body(...lines)).text;

test('XCScore.lss results packet is exactly what TrackScore expects', () => {
  const r = renderUpdate(fixture('xcscore.lss'), { stage: 'results', header: HEADER, rows: [ROW] });
  assert.equal(r.text, XC_RESULT); // the "\," line emits nothing
  assert.equal(r.isJson, true);
  assert.deepEqual(r.jsonErrors, []);
  assert.deepEqual(r.warnings, []);
});

test('blank event number, round and heat are quoted so the JSON stays valid', () => {
  const xc = fixture('xcscore.lss');
  let r = renderUpdate(xc, { header: { ...HEADER, 4: '' }, rows: [ROW] });
  assert.equal(r.text, XC_RESULT.replace('"EN":3', '"EN":""'));
  assert.deepEqual(r.jsonErrors, []);
  r = renderUpdate(xc, { header: { ...HEADER, 4: '', 5: '', 6: '' }, rows: [ROW] });
  assert.equal(r.text, XC_RESULT.replace('"EN":3,"R":1,"H":1', '"EN":"","R":"","H":""'));
  assert.deepEqual(r.jsonErrors, []);
  r = renderUpdate(xc, { header: { ...HEADER, 5: undefined, 6: null }, rows: [ROW] }); // missing = ''
  assert.match(r.text, /"R":"","H":""/);
});

test('Karmarush-Track.lss results packet carries the MID line', () => {
  const r = renderUpdate(fixture('karmarush-track.lss'), { stage: 'results', header: HEADER, rows: [ROW] });
  assert.equal(r.text, `{"T":"T","D":{"MID":8132,"EN":3,"R":1,"H":1,"S":"UNOFFICIAL","DS":"","W":"",${RUNNER}}}\r\n`);
  assert.equal(r.isJson, true);
  assert.deepEqual(r.jsonErrors, []);
});

test("XCScore.lss started stage: the script's \\00, line really emits a comma, and we report it", () => {
  const r = renderUpdate(fixture('xcscore.lss'), { stage: 'started', header: HEADER, rows: [ROW] });
  assert.ok(r.text.startsWith('{"T":"T","D":{,"EN":3,"R":1,"H":1,'), r.text);
  assert.equal(r.isJson, true);
  assert.equal(r.jsonErrors.length, 1);
  assert.match(r.jsonErrors[0], /JSON object 1 is not valid JSON/);
  assert.match(r.jsonErrors[0], /near …/);
});

test('TrackScore track script: LayoutDraw line, then the object with header values inside it', () => {
  const s = fixture('trackscore-track.lss');
  const r = renderUpdate(s, { stage: 'results', header: { ...HEADER, 4: '' }, rows: [ROW] });
  assert.equal(r.text, 'Command=LayoutDraw;Name=Results;\n' +
    `{"T":"T","D":{"EN":"","R":1,"H":1,"S":"UNOFFICIAL","DS":"","DN":"Girls Varsity 5K","W":"",${RUNNER}}}\r\n`);
  assert.equal(r.isJson, true);
  assert.deepEqual(r.jsonErrors, []);
  // the body repeats per row: one complete object each
  const two = renderUpdate(s, { header: HEADER, rows: [ROW, { ...ROW, 1: '13', 3: '77' }] });
  assert.equal(two.text.split('{"T":"T"').length - 1, 2);
  assert.match(two.text, /"P":"13","L":"","BIB":"77"/);
  assert.deepEqual(two.jsonErrors, []);
});

test('JSON mode strips quotes, backslashes, braces and control characters from values', () => {
  const xc = fixture('xcscore.lss');
  const row = { ...ROW, 4: 'Sm"i\\t{h}\x07', 5: 'Queens\r\n HS', 0x17: 'Ja\tne\x7f', 0x18: '{"x":1}' };
  const r = renderUpdate(xc, { header: { ...HEADER, 2: 'Girls "Varsity" 5K' }, rows: [row] });
  assert.match(r.text, /"N":"Smith","AF":"Queens HS",/);
  assert.match(r.text, /"FN":"Jane","LN":"x:1",/);
  assert.match(r.text, /"DN":"Girls Varsity 5K"/);
  assert.deepEqual(r.jsonErrors, []);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.D.N, 'Smith');
  // json: false sends values untouched (and does not check anything)
  const raw = renderUpdate(xc, { header: HEADER, rows: [row], json: false });
  assert.match(raw.text, /"N":"Sm"i\\t\{h\}\x07"/);
  assert.equal(raw.isJson, false);
  assert.deepEqual(raw.jsonErrors, []);
});

test('JSON safety quotes non-numbers in unquoted value positions only', () => {
  const s = script(';;ResultsHeader', '\\13\\00{"EN":', '\\13\\04%s', '\\13\\00,"A":[', '\\13\\05%s', '\\13\\00],"S":"',
    '\\13\\06%s', '\\13\\00"}');
  const out = (h) => renderUpdate(s, { header: h }).text;
  // the ':' of "EN": is on the line before: the previous character comes from what was already rendered
  assert.equal(out({ 4: '', 5: '', 6: '' }), '{"EN":"","A":[""],"S":""}');
  assert.equal(out({ 4: '7', 5: '-1.5', 6: '7' }), '{"EN":7,"A":[-1.5],"S":"7"}');
  assert.equal(out({ 4: '3A', 5: '03', 6: '3A' }), '{"EN":"3A","A":["03"],"S":"3A"}');
  assert.equal(renderUpdate(s, { header: { 4: '3' } }).isJson, true);
  // a width pads a number with spaces (still JSON), and a quoted non-number keeps its padding
  const w = script(';;ResultsHeader', '\\13\\04{"W":%3s}');
  assert.equal(renderUpdate(w, { header: { 4: '5' } }).text, '{"W":  5}');
  assert.equal(renderUpdate(w, { header: { 4: 'a' } }).text, '{"W":"  a"}');
});

test('json option: auto looks at the script, not the values; true forces; false disables', () => {
  const plain = body('\\14\\04N=%s;');
  let r = render(plain, { 4: '{"x' }, { json: 'auto' });
  assert.equal(r.text, 'N={"x;');
  assert.equal(r.isJson, false);
  r = render(plain, { 4: '{"x' }, { json: true });
  assert.equal(r.text, 'N=x;');
  assert.equal(r.isJson, true);
  assert.deepEqual(r.jsonErrors, []);
  // pretty-printed JSON (whitespace between { and ") is still JSON
  r = renderUpdate(body('\\00{ \\0d\\0a  "N":', '\\14\\04%s', '\\00}'), { rows: [{}] });
  assert.equal(r.isJson, true);
  assert.equal(r.text, '{ \r\n  "N":""}');
  const unclosed = renderUpdate(body('\\00{"a":1'), { rows: [{}] });
  assert.equal(unclosed.jsonErrors.length, 1);
  assert.match(unclosed.jsonErrors[0], /never closed/);
});

test('printf: width, precision, left-justify and %%', () => {
  const s = body('\\14\\04[%3.3s]', '\\14\\04[%-10.10s]', '\\14\\03[%5s]', '\\14\\01%s%%\\0d\\0a');
  assert.equal(render(s, { 4: 'Christopherson', 3: '12', 1: '7' }).text, '[Chr][Christophe][   12]7%\r\n');
  assert.equal(render(s, { 4: 'Al', 3: '1234567', 1: '' }).text, '[ Al][Al        ][1234567]%\r\n');
  // variable 0: the rest goes out as written, % and all
  assert.equal(text('\\14\\00100%s %% done'), '100%s %% done');
  // a lone % is a plain %; only the first %s gets the value
  const odd = body('\\14\\01%d %s %s|');
  assert.equal(render(odd, { 1: '4' }).text, '%d 4 |');
  assert.ok(odd.warnings.some((w) => /%s or %%/.test(w)));
  assert.ok(odd.warnings.some((w) => /second %s/.test(w)));
  // a huge width is capped instead of allocating megabytes
  const wide = body('\\14\\01%99999999s');
  assert.equal(render(wide, { 1: '1' }).text.length, 1024);
  assert.ok(wide.warnings.some((w) => /cut to 1024/.test(w)));
});

test('legacy one-byte codes take the section default group', () => {
  const s = script(';;ResultsHeader', '\\00"MID":8132,', '\\04EN=%s,', ';;Results', '\\01%s\\05');
  assert.equal(render(s, { 1: '3' }).text, '"MID":8132,EN=3,3\x05');
});

test('a line whose group is not valid for its section is skipped, with a warning', () => {
  const s = script(';;ResultsHeader', '\\14\\01%s', '\\13\\00H', ';;Results', '\\15\\00x', '\\16\\01%s', '\\14\\01R%s',
    '\\17\\00!', '"P":"%s"');
  assert.equal(render(s, { 1: '7' }).text, 'HR7!');
  assert.ok(s.warnings.some((w) => w.includes('Group \\14 is not used in ;;ResultsHeader') && w.includes('(line 2)')));
  assert.ok(s.warnings.some((w) => w.includes('Group \\15 is not used in ;;Results')));
  assert.ok(s.warnings.some((w) => w.includes('must start with a code') && w.includes('(line 9)')));
});

test(';;Result alias, repeated sections, [n] page suffix, case-insensitive names', () => {
  assert.equal(render(script(';;Result', '\\14\\01P%s'), { 1: '7' }).text, 'P7');
  const rep = script(';;Results', '\\14\\01A%s', ';;RESULTSHEADER', '\\13\\00H', ';;results', '\\14\\03B%s');
  assert.equal(render(rep, { 1: '7', 3: '12' }).text, 'HA7B12');
  assert.deepEqual(rep.warnings, []);
  const pages = script(';;ResultsHeader[0]', '\\13\\00H', ';;Results[1]', '\\14\\01A%s', ';;Results[2]', '\\14\\03B%s');
  assert.equal(render(pages, { 1: '7', 3: '12' }).text, 'HA7B12');
  assert.equal(pages.warnings.length, 1);
  assert.match(pages.warnings[0], /Page numbers are ignored/);
  assert.deepEqual(describeScript(pages).sections, [{ name: 'ResultsHeader', lines: 1 }, { name: 'Results', lines: 2 }]);
});

test('Started falls back to StartList, then Results; a present but empty section does not fall back', () => {
  const all = script(';;ResultsHeader', '\\13\\00rh', ';;Results', '\\13\\00r', ';;ResultsTrailer', '\\13\\00rt',
    ';;StartListHeader', '\\13\\00lh', ';;StartList', '\\13\\00l', ';;StartedHeader', '\\13\\00sh', ';;Started', '\\13\\00s');
  assert.equal(render(all, {}, { stage: 'started' }).text, 'shsrt');
  assert.equal(render(all, {}, { stage: 'results' }).text, 'rhrrt');
  assert.equal(render(all, {}, { stage: 'startlist' }).text, 'lhlrt');
  const noStarted = script(';;Results', '\\13\\00r', ';;StartList', '\\13\\00l', ';;StartListTrailer');
  assert.equal(render(noStarted, {}, { stage: 'started' }).text, 'l'); // empty StartListTrailer wins over nothing
  assert.equal(render(script(';;Results', '\\13\\00r'), {}, { stage: 'started' }).text, 'r');
  const none = render(script(';;ResultsHeader', '\\13\\00h'), {});
  assert.equal(none.text, 'h');
  assert.match(none.warnings.join(), /no ;;Results section/);
  const unknown = render(all, {}, { stage: 'warmup' });
  assert.equal(unknown.text, 'rhrrt');
  assert.match(unknown.warnings.join(), /Unknown stage/);
});

test('hex escapes must be lowercase; any other backslash emits nothing', () => {
  const s = body('\\14\\01%s\\0D\\0A|\\0d\\0a|\\e9\\80');
  assert.equal(render(s, { 1: '7' }).text, '7DA|\r\n|é€');
  assert.ok(s.warnings.some((w) => w.includes('\\0D is not a byte') && w.includes('\\0d')));
  assert.deepEqual([...encodeCp1252('é€')], [0xe9, 0x80]); // \80 really sends the byte 0x80
  const xc = fixture('xcscore.lss');
  assert.deepEqual(xc.warnings, ['\\, is not an escape FinishLynx knows; it emits nothing (lines 7, 55)']);
  assert.equal(text('\\00a\\,b\\;c\\'), 'abc');
  // \E9 would be the byte é in lowercase; as written it is an unknown command, and the warning says why
  const upper = body('\\00x\\E9');
  assert.equal(render(upper).text, 'x9');
  assert.ok(upper.warnings.some((w) => w.includes('\\E is not a command') && w.includes('\\e9')));
});

test('cursor edits: \\L \\R \\B \\D \\I', () => {
  assert.equal(text('\\00ABCDE\\L2X'), 'ABCXDE');
  assert.equal(text('\\00ABCDE\\L0X'), 'XABCDE');
  assert.equal(text('\\00ABCDE\\L0\\R2X'), 'ABXCDE');
  assert.equal(text('\\00ABC\\L0\\R0X'), 'ABCX');
  assert.equal(text('\\00ABC\\L9X\\R\\ffY'), 'XABCY');
  assert.equal(text('\\00ABCDE\\B2Z'), 'ABCZ');
  assert.equal(text('\\00ABCDE\\L3\\B0Z'), 'ZCDE'); // \B0: everything before the cursor
  assert.equal(text('\\00ABCDE\\L3\\B1Z'), 'AZCDE');
  assert.equal(text('\\00ABCDE\\L0\\D2'), 'CDE');
  assert.equal(text('\\00ABCDE\\L3\\D0'), 'AB'); // \D0: everything from the cursor on
  assert.equal(text('\\00ABCDE\\L3\\D1Z'), 'ABZDE');
  assert.equal(text('\\00AB\\I3C'), 'AB   C');
  assert.equal(text('\\00\\X\\2d\\Ic3|\\Ic2'), '---|  '); // X resets after \Ic: then plain spaces
  assert.equal(render(body('\\14\\01[]\\L1%s'), { 1: '7' }).text, '[7]'); // %s inserts at the cursor
  assert.equal(text('\\00ABC\\P0'), 'CBA');
});

test('registers: \\= \\+ and friends with \\U / \\X; \\O output methods; r0 = row index', () => {
  assert.equal(text('\\00\\X5\\=1\\X3\\+1\\U2\\X3\\O1'), '  8');
  const r1 = '\\00\\X1\\=1\\X8\\<1\\X2\\|1'; // r1 = 0x0102
  assert.equal(text(`${r1}\\U0\\X2\\O1`), '\x02\x01');
  assert.equal(text(`${r1}\\U1\\X2\\O1`), '\x01\x02');
  assert.equal(text(`${r1}\\O1`), '\x02'); // default: method 0, one byte
  assert.equal(text(`${r1}\\U2\\X5\\O1`), '  258');
  assert.equal(text(`${r1}\\U3\\X5\\O1`), '00258');
  assert.equal(text(`${r1}\\U4\\X5\\O1`), '258  ');
  assert.equal(text(`${r1}\\U5\\X5\\O1`), '25800');
  assert.equal(text(`${r1}\\U2\\O1`), '258'); // ASCII never truncates
  // U names a register: r3 = r2; no U or X: operand 1
  assert.equal(text('\\00\\X7\\=2\\U2\\=3\\+3\\U2\\X2\\O3'), ' 8');
  assert.equal(text('\\00\\X4\\=1\\Xi1\\=2\\U2\\O2'), '4'); // \Xi: X from a register
  assert.equal(text('\\00\\X5\\=1\\=2\\U2\\O2'), '1'); // X was used up by the first \=
  const ops = '\\00\\X\\64\\=1\\X3\\*1\\U2\\O1,\\X7\\/1\\U2\\O1,\\X5\\#1\\U2\\O1,\\X3\\-1\\U2\\O1,\\~1\\U2\\O1,' +
    '\\X\\ff\\=2\\X\\0f\\&2\\U2\\O2,\\X\\f0\\^2\\U2\\O2,\\X4\\>2\\U2\\O2';
  assert.equal(text(ops), '300,42,2,4294967295,0,15,255,15');
  // registers persist across lines within one update; r0 is the row index
  assert.equal(render(body('\\00\\X9\\=5', '\\00\\U2\\O5')).text, '9');
  const rows = renderUpdate(body('\\00\\U2\\O0,'), { rows: [{}, {}, {}], json: false });
  assert.equal(rows.text, '0,1,2,');
});

test('\\F checksums the line from the cursor into r[U]', () => {
  assert.equal(text('\\00\\X0\\=2ABC\\L0\\U2\\F2\\R0\\X\\7f\\&2\\U0\\O2'), 'ABCF'); // ADD 0xc6 & 0x7f = 'F'
  assert.equal(text('\\00ABC\\L0\\U1\\F1\\R0\\U0\\O1'), 'ABC@'); // XOR 0x40
  assert.equal(text('\\00123456789\\L0\\U1\\F3\\R0|\\U2\\O1'), '123456789|47933'); // CRC-16/ARC 0xbb3d
  assert.equal(text('\\00123456789\\L0\\U1\\F4\\R0|\\U2\\O1'), '123456789|3421780262'); // CRC-32 0xcbf43926
  assert.equal(text('\\00AB\\L1\\F2\\R0\\O0'), 'ABB'); // from the cursor only; default register r0
  // \S reads the number at the cursor
  assert.equal(render(body('\\14\\01%s\\L0\\S1\\R0=\\U3\\X3\\O1'), { 1: ' 42' }).text, ' 42=042');
});

test('unsupported or malformed commands warn and are ignored, never throw', () => {
  const s = body('\\00A\\QB', '\\00C\\LD', '\\00\\=\\0aE', '\\00\\F7F', '\\00\\P2G', '\\00\\FFH');
  assert.equal(render(s).text, 'ABCDEFGFH');
  for (const pattern of [/\\Q is not a command/, /\\L needs an argument/, /only registers 0-9/, /\\F7 is not a checksum/,
    /Only \\P0/, /\\ff: hex escapes must be lowercase/]) {
    assert.ok(s.warnings.some((w) => pattern.test(w)), `${pattern} in ${s.warnings.join(' | ')}`);
  }
  const zero = render(body('\\00\\X0\\/1X\\U\\ff\\+1\\U9\\O1'));
  assert.equal(zero.text, 'X');
  assert.ok(zero.warnings.some((w) => /by zero/.test(w)));
  assert.ok(zero.warnings.some((w) => /register 255 does not exist/.test(w)));
  assert.ok(zero.warnings.some((w) => /method 9 does not exist/.test(w)));
  assert.ok(body('\\L0abc').warnings.some((w) => /not a command; skipped/.test(w)));
});

test('file handling: comments, separators, BOM, CRLF/CR/LF, bytes, unknown sections, orphan lines', () => {
  const src = '\uFEFF; comment\r\nstray line\r\n  ; indented comment\r\n;;Results\r\n;;;;;;;;;;\r\n\\14\\01A%s\r' +
    '\\14\\03B%s\n\n   \n;;Resutls\n\\14\\01C%s\n';
  const s = parseScript(src);
  assert.equal(render(s, { 1: '7', 3: '12' }).text, 'A7B12');
  assert.ok(s.warnings.some((w) => w === 'Lines before the first ;;Section are ignored (line 2)'));
  assert.ok(s.warnings.some((w) => w.includes(';;Resutls is not a section') && w.includes('(line 10)')));
  // bytes in, and a UTF-8 BOM that arrived as windows-1252 text
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(';;Results\r\n\\14\\04%s\xe9\r\n', 'latin1')]);
  assert.equal(render(parseScript(bytes), { 4: 'x' }).text, 'xé');
  assert.equal(render(parseScript(decodeCp1252(bytes)), { 4: 'x' }).text, 'xé');
  // a script string can be passed straight to renderUpdate / describeScript
  assert.equal(renderUpdate(';;Results\n\\14\\01%s', { rows: [{ 1: 5 }] }).text, '5');
  assert.equal(describeScript(';;Results\n\\14\\01%s').sections[0].name, 'Results');
  // values may be a Map, numbers, or missing
  assert.equal(renderUpdate(body('\\14\\01%s', '\\13\\04|%s'), { header: new Map([[4, 9]]), rows: [new Map([[1, '3']])] }).text, '3|9');
  for (const bad of [null, undefined, 42, {}, { sections: null }]) {
    const r = renderUpdate(bad, { rows: [ROW] });
    assert.equal(r.text, '');
    assert.equal(r.isJson, false);
    assert.ok(r.warnings.length > 0);
  }
  // no options at all: every value blank, no rows. Revision 2 (9.5): the comma the header leaves before }} is
  // removed, so even this is valid JSON
  const empty = renderUpdate(fixture('xcscore.lss'), null);
  assert.equal(empty.text, '{"T":"T","D":{"EN":"","R":"","H":"","S":"","DS":"","DN":"","W":""}}\r\n');
  assert.deepEqual(empty.jsonErrors, []);
});

test('skipEmpty leaves out the LICENCE line for an unknown gender, and the JSON stays valid (review-edges F11)', () => {
  const xc = fixture('xcscore.lss');
  const r = renderUpdate(xc, { header: HEADER, rows: [{ ...ROW, 0x0b: '' }], skipEmpty: [0x0b] });
  assert.equal(r.text, XC_RESULT.replace(',"LICENCE":"F"', ''));
  assert.deepEqual(r.jsonErrors, []);
  assert.equal('LICENCE' in JSON.parse(r.text).D, false, 'TrackScore keeps the gender FinishLynx gave the runner');
  // a known gender is sent as always; without skipEmpty a blank one is sent blank
  assert.equal(renderUpdate(xc, { header: HEADER, rows: [ROW], skipEmpty: [0x0b] }).text, XC_RESULT);
  assert.match(renderUpdate(xc, { header: HEADER, rows: [{ ...ROW, 0x0b: '' }] }).text, /"LICENCE":""\}\}/);
  // only row lines (group \14) are skipped, and only for the codes given
  const s = script(';;ResultsHeader', '\\13\\0b<%s>', ';;Results', '\\14\\0b[%s]', '\\14\\03(%s)');
  assert.equal(renderUpdate(s, { header: {}, rows: [{}], skipEmpty: [0x0b], json: false }).text, '<>()');
});

test('JSON mode removes a comma left before } or ], outside strings only', () => {
  const s = body('\\00{"a":[1,2,],', '\\00"s":"x,}",', '\\00"o":{"b":1 ,  },', '\\00} tail,} {"c":3,}');
  const r = renderUpdate(s, { rows: [{}] });
  assert.equal(r.text, '{"a":[1,2],"s":"x,}","o":{"b":1   }} tail,} {"c":3}');
  assert.deepEqual(r.jsonErrors, []);
  assert.equal(renderUpdate(s, { rows: [{}], json: false }).text, '{"a":[1,2,],"s":"x,}","o":{"b":1 ,  },} tail,} {"c":3,}');
  // XCScore's broken ;;StartedHeader ("{," after the object start) is still reported: that comma is not before a }
  assert.equal(renderUpdate(fixture('xcscore.lss'), { stage: 'started', header: HEADER, rows: [ROW] }).jsonErrors.length, 1);
});

test('describeScript summarises sections, commands and the MID', () => {
  const xc = describeScript(fixture('xcscore.lss'));
  assert.deepEqual(xc.sections.map((s) => s.name), ['StartListHeader', 'StartList', 'StartListTrailer', 'StartedHeader',
    'Started', 'StartedTrailer', 'ResultsHeader', 'Results', 'ResultsTrailer']);
  assert.deepEqual(xc.sections.find((s) => s.name === 'ResultsHeader'), { name: 'ResultsHeader', lines: 11 });
  assert.equal(xc.usesCommands, false);
  assert.equal(xc.mid, null);
  assert.equal(describeScript(fixture('karmarush-track.lss')).mid, '8132');
  const ts = describeScript(fixture('trackscore-track.lss'));
  assert.deepEqual(ts.sections, [{ name: 'TimeRunning', lines: 2 }, { name: 'TimeArmed', lines: 2 },
    { name: 'ResultsHeader', lines: 1 }, { name: 'Results', lines: 21 }, { name: 'ResultsTrailer', lines: 0 }]);
  assert.equal(describeScript(body('\\00x\\L0y')).usesCommands, true);
  assert.deepEqual(describeScript(null), { sections: [], usesCommands: false, mid: null });
});

test('escapeForDisplay shows control bytes the way a script writes them', () => {
  assert.equal(escapeForDisplay('{"a":1}\r\n\x05\x7f\\é€中'), '{"a":1}\\0d\\0a\\05\\7f\\5cé€?');
  assert.equal(escapeForDisplay(Buffer.from([0x41, 0x0d, 0x0a, 0x80, 0x81, 0x00])), 'A\\0d\\0a€\\81\\00');
  assert.equal(escapeForDisplay(''), '');
  assert.equal(escapeForDisplay(undefined), '');
  assert.equal(escapeForDisplay(XC_RESULT), XC_RESULT.replace('\r\n', '\\0d\\0a'));
});

test('fuzz: random script text never throws', () => {
  let seed = 0x5eed1234;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const pieces = ['\\', '%', '%s', '%-5.2s', '%99999s', '\\0', '\\0a', '\\0D', '\\ff', '\\13', '\\14', '\\00', '\\U',
    '\\Ui', '\\Xi', '\\X', '\\Ic', '\\I', '\\L', '\\R', '\\B', '\\D', '\\O', '\\S', '\\F', '\\P', '\\=', '\\~', '\\/',
    '\\#', '\\<', '\\>', '{', '}', '"', ':', ',', '[', ']', ';;', ';', '\r', '\n', '9', '0', 'i', 'c', 'A', ' ', 'é',
    '\u4e2d', '\ud83d', '\x00', '\x7f'];
  const pieceOrByte = () => (rand() < 0.4 ? String.fromCharCode(Math.floor(rand() * 256)) : pick(pieces));
  const sections = [';;Results', ';;ResultsHeader', ';;ResultsTrailer', ';;Started', ';;StartList', ';;Result[3]', ';;Bogus'];
  for (let n = 0; n < 1500; n++) {
    const lines = [];
    for (let l = 0, count = 1 + Math.floor(rand() * 8); l < count; l++) {
      if (rand() < 0.3) lines.push(pick(sections));
      let line = rand() < 0.5 ? pick(['\\14\\01', '\\13\\04', '\\00', '\\01', '']) : '';
      for (let k = 0, len = Math.floor(rand() * 30); k < len; k++) line += pieceOrByte();
      lines.push(line);
    }
    const src = lines.join(rand() < 0.5 ? '\r\n' : '\n');
    const s = parseScript(src);
    assert.ok(Array.isArray(s.warnings));
    describeScript(s);
    for (const json of ['auto', true, false]) {
      const r = renderUpdate(s, { stage: pick(['results', 'started', 'startlist']), header: HEADER, rows: [ROW, {}], json });
      assert.equal(typeof r.text, 'string');
      assert.ok(r.text.length < 2_000_000, 'output stays bounded');
      assert.ok(Array.isArray(r.warnings) && Array.isArray(r.jsonErrors));
      assert.ok(!r.warnings.some((w) => /could not render/.test(w)), `internal error for ${JSON.stringify(src)}: ${r.warnings}`);
      escapeForDisplay(r.text);
      encodeCp1252(r.text);
    }
  }
});
