import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  COLUMN_TYPES, COLUMN_EXPRESSIONS, DEFAULT_INPUT_FORMAT, LAPTIME_EXPRESSION, buildExpression, parseLine, normalizeGender,
  InputServer, splitGlued, splitFramed,
} from '../src/input.js';
import { parseTod } from '../src/timefmt.js';

const FORMAT = { delimiter: '|', tag: 'SR', columns: ['location', 'bib', 'time', 'contest', 'first', 'last', 'team', 'gender'] };
const TOD = parseTod('15:17:44.215');

describe('buildExpression', () => {
  test('default format gives the exact RR12 Export Data expression', () => {
    const expected = '"SR|" & [RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk") & "|" & '
      + '[Contest.Name] & "|" & [Firstname] & "|" & [Lastname] & "|" & [Club] & "|" & [Gender]';
    assert.equal(buildExpression(FORMAT), expected);
    assert.equal(buildExpression(DEFAULT_INPUT_FORMAT), expected);
    assert.equal(buildExpression(undefined), expected);
  });

  test('empty tag leaves out the leading literal', () => {
    assert.equal(buildExpression({ ...FORMAT, tag: '' }),
      '[RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk") & "|" & [Contest.Name] & "|" & '
      + '[Firstname] & "|" & [Lastname] & "|" & [Club] & "|" & [Gender]');
  });

  test('custom delimiter, ignore columns, unknown column names and unusable delimiters', () => {
    assert.equal(buildExpression({ delimiter: ';', tag: 'X1', columns: ['bib', 'ignore', 'time'] }),
      '"X1;" & [RD_IDBib] & ";" & "" & ";" & format([RD_Time];"hh:mm:ss.kkk")');
    assert.equal(buildExpression({ delimiter: '|', tag: '', columns: ['bib', 'nonsense'] }), '[RD_IDBib] & "|" & ""');
    // TAB would end the line before it is parsed; a quote would end RR's string literal.
    assert.equal(buildExpression({ delimiter: '\t', tag: '', columns: ['bib', 'time'] }),
      '[RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk")');
    assert.equal(buildExpression({ delimiter: '"', tag: 'S"R', columns: ['bib'] }), '"SR|" & [RD_IDBib]');
  });

  test('every column type has an expression', () => {
    for (const c of COLUMN_TYPES) assert.equal(typeof COLUMN_EXPRESSIONS[c], 'string', c);
    assert.equal(COLUMN_TYPES.length, 9);
  });
});

describe('parseLine', () => {
  const full = {
    location: '1K-A', bib: '254', tod: TOD, contest: 'Girls Varsity 5K', first: 'Zoë', last: "O'Neil-Brandt",
    team: 'Lakeside HS', gender: 'F',
  };

  test('default columns with the SR tag', () => {
    const r = parseLine("SR|1K-A|254|15:17:44.215|Girls Varsity 5K|Zoë|O'Neil-Brandt|Lakeside HS|f", FORMAT);
    assert.deepEqual(r, { ok: true, read: full, format: 'sr' });
  });

  test('default columns without the tag still parse when the field count fits', () => {
    assert.deepEqual(parseLine("1K-A|254|15:17:44.215|Girls Varsity 5K|Zoë|O'Neil-Brandt|Lakeside HS|f", FORMAT),
      { ok: true, read: full, format: 'sr' });
  });

  test('tag is case-insensitive and fields are trimmed; leading SOH/STX and trailing junk are stripped', () => {
    const r = parseLine("\x02 sr | 1K-A |254 | 15:17:44.215 |Girls Varsity 5K| Zoë |O'Neil-Brandt| Lakeside HS | F \x03", FORMAT);
    assert.deepEqual(r, { ok: true, read: full, format: 'sr' });
    assert.deepEqual(parseLine("\uFEFF\x01SR|1K-A|254|15:17:44.215|Girls Varsity 5K|Zoë|O'Neil-Brandt|Lakeside HS|F", FORMAT),
      { ok: true, read: full, format: 'sr' });
  });

  /** A line with every column of FORMAT, the rest empty, as RR12's expression always sends it. */
  const sr = (loc, bib, time, ...rest) => ['SR', loc, bib, time, ...rest, ...new Array(5 - rest.length).fill('')].join('|');

  test('comma decimals and raw seconds since midnight', () => {
    assert.equal(parseLine(sr('1K', '254', '15:17:44,215'), FORMAT).read.tod, TOD);
    assert.equal(parseLine(sr('1K', '254', '55064.215'), FORMAT).read.tod, TOD);
    assert.equal(parseLine(sr('1K', '254', '55064,215'), FORMAT).read.tod, TOD);
    // A later day of the event wraps to the time of day.
    assert.equal(parseLine(sr('1K', '254', '141464.215'), FORMAT).read.tod, TOD);
  });

  test("empty fields become ''", () => {
    assert.deepEqual(parseLine('SR|1K-A|254|15:17:44.215|||||', FORMAT), {
      ok: true, read: { location: '1K-A', bib: '254', tod: TOD, contest: '', first: '', last: '', team: '', gender: '' }, format: 'sr',
    });
    assert.deepEqual(parseLine('SR|1K-A|254|15:17:44.215||Ana|||', FORMAT).read.first, 'Ana');
  });

  test('a cut-off line is refused instead of read with an earlier time (review-edges F2)', () => {
    // The first TCP segment of "SR|1K-A|254|10:05:00.215|Girls 5K|..." on its own: 5:00.000 instead of 5:00.215.
    for (const line of ['SR|1K-A|254|10:05:00', 'SR|1K-A|254|15:17:44.215', 'SR|1K-A|254|15:17:44.215|Girls 5K|Ada|Quill|Lakeside']) {
      const r = parseLine(line, FORMAT);
      assert.equal(r.ok, false, line);
      assert.equal(r.kind, 'error', line);
      assert.match(r.message, /^Expected 8 fields separated by \|, got \d: check the Export Data expression/, line);
    }
    // Without a tag in the format the rule is the same: every column, every time.
    assert.match(parseLine('1K|254', { delimiter: '|', tag: '', columns: ['location', 'bib', 'time'] }).message,
      /Expected 3 fields separated by \|, got 2/);
  });

  test('a malformed line says what is wrong with it, not that RR12 has no participant (ux-walkthrough F16)', () => {
    const r = parseLine('SR|garbage line without fields', FORMAT);
    assert.equal(r.kind, 'error');
    assert.equal(r.message, 'Expected 8 fields separated by |, got 1: check the Export Data expression in RR12');
    // A line with every field but no bib does mean no participant.
    assert.match(parseLine(sr('1K', '', '15:17:44.215'), FORMAT).message, /No bib — RR12 has no participant/);
  });

  test("bib '' or '0' is an error", () => {
    for (const line of [sr('1K', '', '15:17:44.215'), sr('1K', '0', '15:17:44.215'), sr('1K', '000', '15:17:44.215'), sr('1K', ' ', '15:17:44.215')]) {
      const r = parseLine(line, FORMAT);
      assert.equal(r.ok, false, line);
      assert.equal(r.kind, 'error', line);
      assert.match(r.message, /bib/i, line);
    }
  });

  test('unparseable or missing time is an error', () => {
    const r = parseLine(sr('1K', '254', 'quarter past three'), FORMAT);
    assert.equal(r.kind, 'error');
    assert.match(r.message, /quarter past three/);
    assert.equal(parseLine(sr('1K', '254', '25:61:00'), FORMAT).kind, 'error');
    assert.match(parseLine(sr('1K', '254', ''), FORMAT).message, /no time/);
  });

  test('[RD_RecordJSON] object lines, bare or after the tag', () => {
    const r = parseLine('{"ID":17,"TimingPoint":"1K-A","Bib":254,"Time":55064.215,"Hits":3}', FORMAT);
    assert.deepEqual(r, { ok: true, read: { location: '1K-A', bib: '254', tod: TOD, contest: '', first: '', last: '', team: '', gender: '' }, format: 'json' });
    const t = parseLine('SR|{"timingpoint":"2K","bib":"88","time":"15:17:44.215","Contest":"Boys JV","Firstname":"Lev",'
      + '"Lastname":"Ardent","Club":"Hill | Dale","Gender":"m"}', FORMAT);
    assert.deepEqual(t.read, { location: '2K', bib: '88', tod: TOD, contest: 'Boys JV', first: 'Lev', last: 'Ardent', team: 'Hill | Dale', gender: 'M' });
    assert.equal(parseLine('{"TimingPoint":"1K","Bib":0,"Time":55064.2}', FORMAT).kind, 'error');
    assert.match(parseLine('{"TimingPoint":"1K",', FORMAT).message, /JSON/);
  });

  test('gender values', () => {
    const g = (v) => parseLine(`SR|1K|5|10:00:00.000|||||${v}`, FORMAT).read.gender;
    for (const v of ['m', 'M', 'male', 'Male', 'boys', 'Boy', 'men', "Men's", 'b']) assert.equal(g(v), 'M', v);
    for (const v of ['f', 'F', 'female', 'FEMALE', 'girls', 'Girl', 'women', "Women's", 'w', 'g']) assert.equal(g(v), 'F', v);
    for (const v of ['', 'x', 'X', 'unknown', '1']) assert.equal(g(v), '', v);
    assert.equal(normalizeGender(undefined), '');
  });

  test("the RR Connect Message '<tag>|HELLO|...' is kind 'hello'", () => {
    const r = parseLine('SR|HELLO|Race Result 12', FORMAT);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'hello');
    assert.match(r.message, /Race Result 12/);
    assert.equal(parseLine('SR|hello', FORMAT).kind, 'hello');
    assert.equal(parseLine('HELLO', { ...FORMAT, tag: '' }).kind, 'hello');
  });

  test('empty lines', () => {
    for (const line of ['', '   ', '\x01', '\x02\r', '||||', undefined]) {
      assert.deepEqual(parseLine(line, FORMAT), { ok: false, kind: 'empty', message: '' }, JSON.stringify(line));
    }
  });

  test('too many fields, and a line with a different tag, explain what to check', () => {
    assert.match(parseLine('XX|1K|254|15:17:44.215|C|F|L|T|M', FORMAT).message, /instead of the tag "SR"/);
    const extra = parseLine('SR|1K|254|15:17:44.215|C|F|L|T|M|extra', FORMAT).message;
    assert.match(extra, /9 fields but the column order has 8/);
    assert.match(extra, /Line end is CRLF/, 'the Line end setting is named too');
  });

  test('reads glued together (RR12 Line end "none") are found and named (review-edges F10)', () => {
    const a = 'SR|1K-A|401|10:00:00.100|Girls 5K|Ada|Ames|Lakeside|F';
    const b = 'SR|1K-A|402|10:00:00.200|Girls 5K|Bea|Birch|Hilltop|F';
    const c = 'SR|1K-B|403|10:00:00.300|Girls 5K|Cy|Cole||';
    assert.deepEqual(splitGlued(a + b, FORMAT), [a, b], 'the next tag stuck to the last value');
    assert.deepEqual(splitGlued(c + a + b, FORMAT), [c, a, b], 'an empty last value: the tag is a field of its own');
    assert.deepEqual(splitGlued('sr|1K|1|10:00:00|||||MSR|1K|2|10:00:01|||||', FORMAT),
      ['sr|1K|1|10:00:00|||||M', 'SR|1K|2|10:00:01|||||'], 'the tag in any case');
    // One record, or anything that is not records of the right shape, is not split.
    assert.equal(splitGlued(a, FORMAT), null);
    assert.equal(splitGlued(a + '|extra', FORMAT), null);
    assert.equal(splitGlued(a + 'XX|1K-A|402|10:00:00.200|Girls 5K|Bea|Birch|Hilltop|F', FORMAT), null);
    assert.equal(splitGlued(a + b, { ...FORMAT, tag: '' }), null, 'without a tag nothing marks a record');
    // A tag made of two fields, and another delimiter.
    const odd = { delimiter: '::', tag: 'A::B', columns: ['location', 'bib', 'time'] };
    assert.deepEqual(splitGlued('A::B::3K::12::10:00:00A::B::3K::13::10:00:01', odd), ['A::B::3K::12::10:00:00', 'A::B::3K::13::10:00:01']);
    // parseLine on a glued line (when the input could not split it) says so and names the setting.
    assert.match(parseLine(a + b, FORMAT).message, /holds 2 reads with no line end between them.*Line end to CRLF/);
  });

  test('custom formats', () => {
    const fmt = { delimiter: ';', tag: '', columns: ['bib', 'time', 'location', 'ignore', 'last'] };
    assert.deepEqual(parseLine('77;9:05:00.5;Mile;junk;Quill', fmt), {
      ok: true, read: { location: 'Mile', bib: '77', tod: parseTod('9:05:00.5'), contest: '', first: '', last: 'Quill', team: '', gender: '' }, format: 'sr',
    });
    // A multi-character delimiter and a tag that contains it.
    const odd = { delimiter: '::', tag: 'A::B', columns: ['location', 'bib', 'time'] };
    assert.equal(parseLine('A::B::3K::12::10:00:00', odd).read.location, '3K');
    assert.match(parseLine('12|10:00:00', { delimiter: '|', tag: '', columns: ['location', 'time'] }).message, /no Bib column/);
  });

  test('never throws on odd input', () => {
    for (const line of [null, 42, '\u0000\u0000', '{', '}{', 'SR|'.repeat(50), '\uD800', 'SR|{"Bib":[1]}']) {
      assert.doesNotThrow(() => parseLine(/** @type {any} */ (line), FORMAT));
    }
    assert.doesNotThrow(() => parseLine('SR|1K|1|10:00:00', /** @type {any} */ ({ columns: 'nope', tag: null, delimiter: 5 })));
  });
});

describe('FinishLynx LapTime lines (DESIGN 9.15 L1)', () => {
  /** A LapTime read as parseLine gives it: a bib and a time, no timing point, no contest, no names. */
  const lap = (bib, tod, event = '') => ({ location: '', bib, tod, contest: '', first: '', last: '', team: '', gender: '', event });

  test('the expression RR12 uses, and the line it gives: <SOH>S,time,bib, detected without any setting', () => {
    assert.equal(LAPTIME_EXPRESSION, 'chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]');
    assert.deepEqual(parseLine('\x01S,15:17:44.215,254', FORMAT), { ok: true, format: 'laptime', read: lap('254', TOD) });
    // STX instead of SOH, no start byte at all, spaces, a BOM, and the line end left on
    for (const line of ['\x02S,15:17:44.215,254', 'S,15:17:44.215,254', ' \x01 S , 15:17:44.215 , 254 ', '\uFEFF\x01S,15:17:44.215,254',
      '\x01S,15:17:44.215,254\r\n', '\x01S,15:17:44.215,254\n', '\x01s,15:17:44.215,254']) {
      assert.deepEqual(parseLine(line, FORMAT), { ok: true, format: 'laptime', read: lap('254', TOD) }, JSON.stringify(line));
    }
    // whatever the SR settings are: the format is told from the line itself
    for (const fmt of [{ delimiter: ';', tag: 'X', columns: ['bib', 'time', 'location'] }, { delimiter: '|', tag: '', columns: ['bib', 'time'] }]) {
      assert.deepEqual(parseLine('\x01S,15:17:44.215,254', fmt).read, lap('254', TOD));
    }
    // the decimal seconds of a raw [RD_Time] work too, and a trailing comma
    assert.equal(parseLine('\x01S,55064.215,254', FORMAT).read.tod, TOD);
    assert.deepEqual(parseLine('\x01S,15:17:44.215,254,', FORMAT).read, lap('254', TOD));
  });

  test("FinishLynx's event, round and heat are kept as read.event, leading zeros dropped", () => {
    assert.equal(parseLine('\x01S,15:17:44.215,254,3,1,1', FORMAT).read.event, '3-1-1');
    assert.equal(parseLine('\x01S,15:17:44.215,254,003,01,02', FORMAT).read.event, '3-1-2');
    assert.equal(parseLine('\x01S,15:17:44.215,254,7', FORMAT).read.event, '7-1-1', 'round and heat default to 1');
    assert.equal(parseLine('\x01S,15:17:44.215,254,,1,1', FORMAT).read.event, '', 'no event number: no event');
  });

  test('Z and T are FinishLynx commands: logged and ignored, never a read', () => {
    for (const line of ['\x01Z', '\x01T,10:00:00.000', 'Z', 'T,10:00:00', '\x02z,']) {
      const r = parseLine(line, FORMAT);
      assert.equal(r.ok, false, line);
      assert.equal(r.kind, 'ignored', JSON.stringify(line));
      assert.equal(r.format, 'laptime');
      assert.match(r.message, /FinishLynx LapTime command "[ZT]" \(not a passing\): ignored/);
    }
  });

  test('a malformed LapTime line is a bad line that says what is wrong in plain words', () => {
    const msg = (line) => {
      const r = parseLine(line, FORMAT);
      assert.equal(r.ok, false, line);
      assert.equal(r.kind, 'error', JSON.stringify(line));
      assert.equal(r.format, 'laptime', JSON.stringify(line));
      return r.message;
    };
    assert.match(msg('\x01S,15:17:44.215'), /cut short: expected S,time,bib, for example S,15:17:44\.215,254/);
    assert.match(msg('\x01S'), /cut short/);
    assert.match(msg('\x01S,15:17:44.215,'), /No bib in this FinishLynx LapTime line/);
    assert.match(msg('\x01S,15:17:44.215,0'), /Bib 0/);
    assert.match(msg('\x01S,15:17:44.215,000'), /Bib 0/);
    assert.match(msg('\x01S,quarter past,254'), /Can't read the time "quarter past" in this FinishLynx LapTime line/);
    assert.match(msg('\x01S,25:61:00,254'), /Can't read the time "25:61:00"/);
    assert.match(msg('\x01S,1,2,3,4,5,6,7'), /has 8 fields: expected S,time,bib/);
    assert.match(msg('\x01X,15:17:44.215,254'), /starts with "X"\. Split Relay uses the S lines/);
    // two records and no line end between them (when the input could not split them)
    assert.match(msg('\x01S,15:17:44.215,254\x01S,15:17:45.000,255'), /holds 2 FinishLynx LapTime reads with no line end between them.*Line end to CRLF/);
  });

  test('SR lines, JSON lines and a comma-separated SR line whose timing point is "S" still parse as before', () => {
    assert.equal(parseLine("SR|1K-A|254|15:17:44.215|Girls Varsity 5K|Zoë|O'Neil-Brandt|Lakeside HS|f", FORMAT).format, 'sr');
    assert.equal(parseLine('{"TimingPoint":"1K-A","Bib":254,"Time":55064.215}', FORMAT).format, 'json');
    // With a comma delimiter and no SOH it may be a real line whose timing point is called "S": its shape decides.
    const comma = { delimiter: ',', tag: '', columns: ['location', 'time', 'bib'] };
    assert.deepEqual(parseLine('S,15:17:44.215,254', comma).read.location, 'S');
    assert.deepEqual(parseLine('\x01S,15:17:44.215,254', comma).read, lap('254', TOD), 'SOH: it is FinishLynx');
    const tagS = { delimiter: ',', tag: 'S', columns: ['location', 'bib', 'time'] };
    assert.deepEqual(parseLine('S,1K-A,254,15:17:44.215', tagS).read.location, '1K-A', 'the SR tag "S" with commas');
    // an SR line is never mistaken for one: it does not start with one letter and a comma, or it has the SR separator
    assert.equal(parseLine('SR|S,1|254|15:17:44.215|||||', FORMAT).format, 'sr');
    assert.equal(parseLine('S,1|254|15:17:44.215|||||', { ...FORMAT, tag: '' }).read.location, 'S,1', 'a tagless SR line');
  });

  test('splitFramed cuts records glued by "Line end: none" at each SOH/STX', () => {
    assert.deepEqual(splitFramed('\x01S,15:17:44.215,254\x01S,15:17:45.000,255'), ['\x01S,15:17:44.215,254', '\x01S,15:17:45.000,255']);
    assert.deepEqual(splitFramed('\x01S,1,2\x02S,3,4\x01Z'), ['\x01S,1,2', '\x02S,3,4', '\x01Z']);
    assert.deepEqual(splitFramed('\uFEFF\x01S,1,2'), ['\uFEFF\x01S,1,2'], 'one record: as it is');
    assert.deepEqual(splitFramed('SR|1K|1|10:00:00|||||'), ['SR|1K|1|10:00:00|||||']);
    assert.deepEqual(splitFramed('\x01S,1,2\x01'), ['\x01S,1,2'], 'a lone SOH at the end carries nothing');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// InputServer over real loopback sockets

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

/** Server plus a record of everything it emitted. */
async function startServer(opts = {}) {
  const server = new InputServer({ port: 0, host: '127.0.0.1', ...opts });
  const lines = [];
  server.on('line', (text, meta) => lines.push({ text, ...meta }));
  const status = await server.start();
  assert.equal(status.listening, true);
  assert.ok(status.port > 0);
  return { server, lines, port: status.port };
}

async function connect(port) {
  const sock = net.connect({ port, host: '127.0.0.1' });
  sock.setNoDelay(true);
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  return sock;
}

/** Write chunks with a gap between them so they arrive as separate TCP reads. */
async function writeChunks(sock, chunks, gapMs = 25) {
  for (const c of chunks) {
    sock.write(c);
    await pause(gapMs);
  }
}

describe('InputServer', () => {
  test('a line split in the middle and a CRLF split between chunks', async () => {
    const { server, lines, port } = await startServer();
    try {
      const sock = await connect(port);
      await writeChunks(sock, ['SR|1K|1|10:00:', '00.000|Boys\r', '\nSR|1K|2|10:00:01.000\r', '\n']);
      await waitFor(() => lines.length >= 2, 'two lines');
      await pause(50);
      assert.deepEqual(lines.map((l) => l.text), ['SR|1K|1|10:00:00.000|Boys', 'SR|1K|2|10:00:01.000']);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('CR, LF, CRLF and TAB terminators', async () => {
    const { server, lines, port } = await startServer();
    try {
      const sock = await connect(port);
      sock.write('a1\rb2\nc3\r\nd4\te5\r\n\r\n\n\t');
      await waitFor(() => lines.length >= 5, 'five lines');
      await pause(50);
      assert.deepEqual(lines.map((l) => l.text), ['a1', 'b2', 'c3', 'd4', 'e5']);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('a trailing partial line is flushed after the quiet time, and not before', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 150 });
    try {
      const sock = await connect(port);
      const sentAt = Date.now();
      sock.write('SR|1K|7|10:00:00.000');
      await pause(60);
      assert.equal(lines.length, 0);
      await waitFor(() => lines.length === 1, 'flushed line');
      assert.ok(Date.now() - sentAt >= 140, 'flushed too early');
      assert.equal(lines[0].text, 'SR|1K|7|10:00:00.000');
      // receivedAt is when the data came in, not when the timer fired.
      assert.ok(lines[0].receivedAt - sentAt < 100);
      // The late terminator does not produce a second (empty) line.
      sock.write('\r\nSR|1K|8|10:00:01.000\r\n');
      await waitFor(() => lines.length === 2, 'second line');
      await pause(200);
      assert.deepEqual(lines.map((l) => l.text), ['SR|1K|7|10:00:00.000', 'SR|1K|8|10:00:01.000']);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('two simultaneous connections are kept apart', async () => {
    const statuses = [];
    const { server, lines, port } = await startServer();
    server.on('status', (s) => statuses.push(s));
    try {
      const a = await connect(port);
      const b = await connect(port);
      await waitFor(() => server.status().connections.length === 2, 'two connections');
      await writeChunks(a, ['SR|1K|1|10:00:00.0']);
      await writeChunks(b, ['SR|2K|2|10:05:00.0\r\n']);
      await writeChunks(a, ['00|from A\r\n']);
      await waitFor(() => lines.length === 2, 'two lines');
      const byText = Object.fromEntries(lines.map((l) => [l.text, l]));
      assert.ok(byText['SR|1K|1|10:00:00.000|from A'], 'A line intact');
      assert.ok(byText['SR|2K|2|10:05:00.0'], 'B line intact');
      assert.notEqual(byText['SR|1K|1|10:00:00.000|from A'].connId, byText['SR|2K|2|10:05:00.0'].connId);
      assert.match(lines[0].remote, /^127\.0\.0\.1:\d+$/);

      const st = server.status();
      assert.equal(st.totalLines, 2);
      assert.equal(st.connections.length, 2);
      assert.deepEqual(st.connections.map((c) => c.lines).sort(), [1, 1]);
      assert.ok(st.connections.every((c) => c.connectedAt > 0 && c.lastLineAt > 0));
      assert.equal(st.lastLineAt, Math.max(...lines.map((l) => l.receivedAt)));

      a.end();
      await waitFor(() => server.status().connections.length === 1, 'A gone');
      assert.ok(statuses.some((s) => s.connections.length === 2));
      b.destroy();
      await waitFor(() => server.status().connections.length === 0, 'B gone');
      assert.equal(server.status().totalLines, 2);
    } finally {
      await server.stop();
    }
  });

  test("the 'hello' connect message arrives as a line parseLine calls hello", async () => {
    const { server, lines, port } = await startServer();
    try {
      const sock = await connect(port);
      sock.write('SR|HELLO|RR12 Timing PC\r\nSR|1K|9|10:00:00.000|||||\r\n');
      await waitFor(() => lines.length === 2, 'two lines');
      assert.equal(parseLine(lines[0].text, FORMAT).kind, 'hello');
      assert.equal(parseLine(lines[1].text, FORMAT).ok, true);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('UTF-8 accented names split across chunks', async () => {
    const { server, lines, port } = await startServer();
    try {
      const sock = await connect(port);
      const text = 'SR|1K|12|10:00:00.000|Girls 5K|Zoë|Ñúñez-Ørsted|École Sainte‑Agnès|F\r\n';
      const bytes = Buffer.from(text, 'utf8');
      const zoe = bytes.indexOf(Buffer.from('ë', 'utf8'));
      const hyphen = bytes.indexOf(Buffer.from('‑', 'utf8')); // 3-byte character
      await writeChunks(sock, [bytes.subarray(0, zoe + 1), bytes.subarray(zoe + 1, hyphen + 2), bytes.subarray(hyphen + 2)]);
      await waitFor(() => lines.length === 1, 'line');
      assert.equal(lines[0].text, text.trimEnd());
      assert.equal(parseLine(lines[0].text, FORMAT).read.last, 'Ñúñez-Ørsted');
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('a line over 4096 characters is dropped, with or without a terminator in the same chunk', async () => {
    const dropped = [];
    const { server, lines, port } = await startServer();
    server.on('dropped', (d) => dropped.push(d));
    try {
      const sock = await connect(port);
      const exact = 'y'.repeat(4096);
      sock.write(`${'x'.repeat(5000)}\r\n${exact}\r\nSR|1K|1|10:00:00.000\r\n`);
      await waitFor(() => lines.length === 2, 'kept lines');
      assert.deepEqual(lines.map((l) => l.text.length), [4096, 20]);
      // An over-long line spread over chunks: its tail must not turn up as a line of its own.
      await writeChunks(sock, ['z'.repeat(3000), 'z'.repeat(3000), 'tail-of-long-line\r\nSR|1K|2|10:00:01.000\r\n']);
      await waitFor(() => lines.length === 3, 'line after the long one');
      assert.equal(lines[2].text, 'SR|1K|2|10:00:01.000');
      assert.equal(dropped.length, 2);
      assert.equal(server.status().totalDropped, 2);
      assert.equal(server.status().connections[0].dropped, 2);
      // An over-long unterminated line that then goes quiet is dropped too, not flushed.
      sock.write('q'.repeat(5000));
      await pause(400);
      sock.write('q'.repeat(10));
      await pause(400);
      assert.equal(lines.length, 3);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('never writes to the socket', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 50 });
    const dropped = [];
    server.on('dropped', (d) => dropped.push(d));
    const origWrite = net.Socket.prototype.write;
    let serverWrites = 0;
    net.Socket.prototype.write = function patched(...args) {
      if (this.localPort === port) serverWrites++;
      return origWrite.apply(this, args);
    };
    try {
      const sock = await connect(port);
      let received = 0;
      sock.on('data', (d) => { received += d.length; });
      sock.write('SR|HELLO|x\r\nSR|1K|1|10:00:00.000\r\npartial');
      await waitFor(() => lines.length === 2, 'lines');
      await pause(100);
      sock.end();
      await waitFor(() => server.status().connections.length === 0, 'closed');
      // This connection ends its lines, so "partial" cut off by the close is not a read.
      assert.equal(lines.length, 2);
      assert.equal(dropped.length, 1);
      assert.equal(received, 0);
      assert.equal(serverWrites, 0);
    } finally {
      net.Socket.prototype.write = origWrite;
      await server.stop();
    }
  });

  test('restart on a new port; the old port stops answering', async () => {
    const { server, lines, port } = await startServer();
    try {
      const free = await new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const p = probe.address().port;
          probe.close(() => resolve(p));
        });
      });
      const st = await server.restart(free);
      assert.equal(st.listening, true);
      assert.equal(st.port, free);
      assert.notEqual(st.port, port);
      await assert.rejects(connect(port));
      const sock = await connect(free);
      sock.write('SR|1K|3|10:00:00.000\r\n');
      await waitFor(() => lines.length === 1, 'line on the new port');
      sock.destroy();
      // restart() without a port keeps the current one; restart(0) asks for any free port.
      assert.equal((await server.restart()).port, free);
      const again = await server.restart(0);
      assert.equal(again.listening, true);
      assert.ok(again.port > 0);
    } finally {
      await server.stop();
    }
  });

  test('a busy port is a status error (no throw), retried until the port is free', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;
    const server = new InputServer({ port, host: '127.0.0.1', retryMs: 50 });
    try {
      const st = await server.start();
      assert.equal(st.listening, false);
      assert.equal(st.port, port);
      assert.match(st.error, new RegExp(`Port ${port} is already in use`));
      await new Promise((r) => blocker.close(r));
      await waitFor(() => server.status().listening, 'retry succeeded');
      assert.equal(server.status().error, null);
      assert.equal(server.status().port, port);
    } finally {
      await server.stop();
      if (blocker.listening) blocker.close();
    }
    const bad = new InputServer({ port: 99999, retryMs: 50 });
    const st = await bad.start();
    assert.equal(st.listening, false);
    assert.match(st.error, /not a valid port/);
    await bad.stop();
  });

  test('stop() closes live connections promptly and delivers their partial lines', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 10_000 });
    const sock = await connect(port);
    const closed = new Promise((r) => sock.once('close', r));
    sock.on('error', () => {});
    sock.write('SR|1K|4|10:00:00.000');
    await waitFor(() => server.status().connections.length === 1, 'connection');
    await pause(50);
    const st = await server.stop();
    await closed;
    assert.equal(st.listening, false);
    assert.equal(st.connections.length, 0);
    assert.deepEqual(lines.map((l) => l.text), ['SR|1K|4|10:00:00.000']);
  });

  test('on a connection that ends its lines, a late second half is waited for, never flushed early (review-edges F2)', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 100 });
    try {
      const sock = await connect(port);
      sock.write('SR|1K-A|253|10:04:59.000|Girls 5K|Al|Ash|Lakeside HS|F\r\n');
      await waitFor(() => lines.length === 1, 'first line');
      // The segment boundary falls inside the time; the rest comes after more than the quiet time (a retransmit).
      sock.write('SR|1K-A|254|10:05:00');
      await pause(400);
      assert.equal(lines.length, 1, 'the first half is not delivered as a read of its own');
      sock.write('.215|Girls 5K|Ada|Quill|Lakeside HS|F\r\n');
      await waitFor(() => lines.length === 2, 'the whole line');
      assert.equal(lines[1].text, 'SR|1K-A|254|10:05:00.215|Girls 5K|Ada|Quill|Lakeside HS|F');
      assert.equal(parseLine(lines[1].text, FORMAT).read.tod, parseTod('10:05:00.215'));
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('with no line ends at all, reads still flush on quiet, and reads that came together are split (review-edges F10)', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 150 });
    try {
      const sock = await connect(port);
      const a = 'SR|1K-A|401|10:00:00.100|Girls 5K|Ada|Ames|Lakeside|F';
      const b = 'SR|1K-A|402|10:00:00.200|Girls 5K|Bea|Birch|Hilltop|F';
      const c = 'SR|1K-A|403|10:00:00.300|Girls 5K|Cy|Cole|Hilltop|';
      await writeChunks(sock, [a, b], 50); // 50 ms apart: glued
      await waitFor(() => lines.length === 2, 'both reads');
      assert.deepEqual(lines.map((l) => l.text), [a, b]);
      assert.ok(lines.every((l) => parseLine(l.text, FORMAT).ok));
      sock.write(c);
      await waitFor(() => lines.length === 3, 'a single read after quiet');
      assert.equal(lines[2].text, c);
      // And what is left at the close of such a connection is a whole read.
      sock.end(a);
      await waitFor(() => lines.length === 4, 'the read before the close');
      assert.equal(lines[3].text, a);
    } finally {
      await server.stop();
    }
  });

  test('setFormat: glued reads of a custom format are split with that format', async () => {
    const custom = { delimiter: ';', tag: 'RR', columns: ['bib', 'time', 'location'] };
    const { server, lines, port } = await startServer({ quietFlushMs: 100, format: custom });
    try {
      const sock = await connect(port);
      sock.write('RR;5;10:00:00;1KRR;6;10:00:01;1K');
      await waitFor(() => lines.length === 2, 'two reads');
      assert.deepEqual(lines.map((l) => l.text), ['RR;5;10:00:00;1K', 'RR;6;10:00:01;1K']);
      server.setFormat(DEFAULT_INPUT_FORMAT);
      sock.write('RR;7;10:00:02;1KRR;8;10:00:03;1K');
      await waitFor(() => lines.length === 3, 'passed on whole when it does not fit the format');
      assert.equal(lines[2].text, 'RR;7;10:00:02;1KRR;8;10:00:03;1K');
      sock.destroy();
    } finally {
      await server.stop();
    }
  });

  test('a line cut off by the close of a CRLF connection is dropped and reported, not read', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 50 });
    const dropped = [];
    server.on('dropped', (d) => dropped.push(d));
    try {
      const sock = await connect(port);
      sock.write('SR|1K-A|1|10:00:00.000|||||\r\nSR|1K-A|2|10:00:0');
      await waitFor(() => lines.length === 1, 'the complete line');
      sock.end();
      await waitFor(() => dropped.length === 1, 'the dropped tail');
      assert.deepEqual(lines.map((l) => l.text), ['SR|1K-A|1|10:00:00.000|||||']);
      assert.equal(dropped[0].reason, 'unterminated');
      assert.equal(dropped[0].length, 'SR|1K-A|2|10:00:0'.length);
      assert.equal(dropped[0].text, 'SR|1K-A|2|10:00:0');
      assert.match(dropped[0].message, /closed in the middle of a line/);
      assert.equal(server.status().totalDropped, 1);
    } finally {
      await server.stop();
    }
  });

  test('a burst of megabytes is read in slices, so timers and other sockets get their turn; every line, in order', async () => {
    // An RR12 Replay of a whole meet arrives at once; each read costs the relay a little. Without slices Node reads the
    // whole burst before anything else runs: the hold timers, the outputs and the panel would all wait.
    const server = new InputServer({ port: 0, host: '127.0.0.1', sliceMs: 10 });
    const seen = [];
    server.on('line', (text) => {
      seen.push(text);
      const until = performance.now() + 0.02; // some work per line, like parsing and the engine
      while (performance.now() < until) { /* busy */ }
    });
    const { port } = await server.start();
    let ticks = 0;
    let ticksBeforeEnd = -1;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const sock = await connect(port);
      const n = 40_000;
      const text = Array.from({ length: n }, (_, i) => `SR|1K-A|${i + 1}|10:00:00.000|Boys|A|B|C|M`).join('\r\n') + '\r\n';
      sock.write(text);
      await waitFor(() => {
        if (seen.length === n && ticksBeforeEnd < 0) ticksBeforeEnd = ticks;
        return seen.length === n;
      }, 'every line', 20_000);
      assert.ok(seen.every((l, i) => l === `SR|1K-A|${i + 1}|10:00:00.000|Boys|A|B|C|M`), 'all of them, in order');
      assert.ok(ticksBeforeEnd >= 5, `a 1 ms timer ran ${ticksBeforeEnd} times while the burst was read`);
      sock.destroy();
    } finally {
      clearInterval(timer);
      await server.stop();
    }
  });

  test('LapTime lines (DESIGN 9.15 L1): split mid-record or mid-CRLF across chunks, and glued with no line end, each read arrives whole', async () => {
    const { server, lines, port } = await startServer({ quietFlushMs: 150 });
    try {
      // CRLF, cut anywhere: after the SOH, inside the time, between CR and LF
      const sock = await connect(port);
      await writeChunks(sock, ['\x01', 'S,15:17:4', '4.215,254\r', '\n\x01S,15:17:45.002,2', '55\r\n']);
      await waitFor(() => lines.length >= 2, 'two LapTime lines');
      await pause(200); // nothing more arrives: the CRLF split left no empty line, nothing was flushed early
      assert.deepEqual(lines.map((l) => l.text), ['\x01S,15:17:44.215,254', '\x01S,15:17:45.002,255']);
      assert.deepEqual(lines.map((l) => parseLine(l.text, FORMAT).read.bib), ['254', '255']);
      // RR12 "Line end: none": records glued; the SOH of the next one shows where each ends, so they need no quiet gap
      const glued = await connect(port);
      glued.write('\x01S,15:18:00.100,301\x01S,15:18:00.200,302\x01S,15:18:00.3');
      await waitFor(() => lines.length >= 4, 'the two complete records at once');
      assert.deepEqual(lines.slice(2).map((l) => l.text), ['\x01S,15:18:00.100,301', '\x01S,15:18:00.200,302']);
      glued.write('00,303');
      await waitFor(() => lines.length >= 5, 'the last one after the quiet time');
      assert.equal(lines[4].text, '\x01S,15:18:00.300,303', 'the record cut between two chunks is whole');
      // a CRLF connection whose records also carry SOH: a later SOH cuts at once, the rest waits for its CRLF
      await writeChunks(sock, ['\x01S,15:19:00.000,401\r\n\x01S,15:19:01.0', '00,402\r\n']);
      await waitFor(() => lines.length >= 7, 'two more');
      assert.deepEqual(lines.slice(5).map((l) => l.text), ['\x01S,15:19:00.000,401', '\x01S,15:19:01.000,402']);
      assert.ok(lines.every((l) => parseLine(l.text, FORMAT).ok), 'every one is a read');
      sock.destroy();
      glued.destroy();
    } finally {
      await server.stop();
    }
  });

  test('connection ids can come from one counter shared by several listeners (one per RR12 input port)', async () => {
    let n = 0;
    const ids = () => ++n;
    const a = await startServer({ connIds: ids });
    const b = await startServer({ connIds: ids });
    try {
      const s1 = await connect(a.port);
      const s2 = await connect(b.port);
      const s3 = await connect(a.port);
      await waitFor(() => a.server.status().connections.length === 2 && b.server.status().connections.length === 1, 'three connections');
      const all = [...a.server.status().connections, ...b.server.status().connections].map((c) => c.id).sort();
      assert.deepEqual(all, [1, 2, 3], 'no two connections share an id');
      s2.write('\x01S,15:17:44.215,254\r\n');
      await waitFor(() => b.lines.length === 1, 'a line on the second port');
      assert.equal(b.lines[0].connId, b.server.status().connections[0].id);
      for (const s of [s1, s2, s3]) s.destroy();
    } finally {
      await a.server.stop();
      await b.server.stop();
    }
  });

  test('a throwing line listener does not break the connection', async () => {
    const server = new InputServer({ port: 0, host: '127.0.0.1' });
    const seen = [];
    const errors = [];
    server.on('line', (text) => { seen.push(text); throw new Error('listener bug'); });
    server.on('error', (err) => errors.push(err));
    const { port } = await server.start();
    try {
      const sock = await connect(port);
      sock.write('one\r\ntwo\r\n');
      await waitFor(() => seen.length === 2, 'both lines despite the throw');
      assert.equal(errors.length, 2);
      sock.destroy();
    } finally {
      await server.stop();
    }
  });
});
