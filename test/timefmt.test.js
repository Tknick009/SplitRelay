import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTod, formatTod, formatLynxTod, formatRaceTime, parseRaceTime, raceTicks, TICKS_PER_DAY } from '../src/timefmt.js';
import { encodeCp1252, decodeCp1252 } from '../src/cp1252.js';

test('parseTod reads RR12 and operator times of day', () => {
  assert.equal(parseTod('15:17:44.215'), ((15 * 60 + 17) * 60 + 44) * 10000 + 2150);
  assert.equal(parseTod('9:05:00'), (9 * 3600 + 5 * 60) * 10000);
  assert.equal(parseTod('12:58:49.2595'), ((12 * 60 + 58) * 60 + 49) * 10000 + 2595);
  assert.equal(parseTod('15:17:44,215'), parseTod('15:17:44.215'));
  assert.equal(parseTod('12:00:00.12345'), 12 * 3600 * 10000 + 1235);
  assert.equal(parseTod('55064.215'), 55064 * 10000 + 2150);
  assert.equal(parseTod('55064,215'), 55064 * 10000 + 2150);
  assert.equal(parseTod('141464.5'), (141464 - 86400) * 10000 + 5000); // a later day wraps to the time of day
  for (const bad of ['', '  ', 'abc', '12:60:00', '12:00:60', '1:2:3', null, undefined]) assert.equal(parseTod(bad), null, String(bad));
});

test('formatTod / formatLynxTod', () => {
  const t = parseTod('09:29:20.1938');
  assert.equal(formatTod(t), '09:29:20.193');
  assert.equal(formatTod(t, 0), '09:29:20');
  assert.equal(formatTod(t, 4), '09:29:20.1938');
  assert.equal(formatLynxTod(t), '9:29:20.1938');
  assert.equal(formatLynxTod(parseTod('12:58:49.2595')), '12:58:49.2595');
});

test('formatRaceTime matches FinishLynx shapes and rounds up', () => {
  assert.equal(formatRaceTime(parseRaceTime('5:12.345')), '5:12.345');
  assert.equal(formatRaceTime(452_310), '45.231');
  assert.equal(formatRaceTime(parseRaceTime('1:02:03.456')), '1:02:03.456');
  assert.equal(formatRaceTime(parseRaceTime('23:34.954'), 2), '23:34.96');
  assert.equal(formatRaceTime(parseRaceTime('23:34.950'), 2), '23:34.95');
  assert.equal(formatRaceTime(parseRaceTime('4:59.99'), 1), '5:00.0');
  assert.equal(formatRaceTime(parseRaceTime('59:59.9999'), 3), '1:00:00.000');
  assert.equal(formatRaceTime(10_001, 3), '1.001');
  assert.equal(formatRaceTime(0), '0.000');
  assert.equal(formatRaceTime(-31_000, 1), '-3.1');
  assert.equal(formatRaceTime(parseRaceTime('5:12.345'), 0), '5:13');
});

test('parseRaceTime', () => {
  assert.equal(parseRaceTime('4:55.339'), (4 * 60 + 55) * 10000 + 3390);
  assert.equal(parseRaceTime('10:08.670'), (10 * 60 + 8) * 10000 + 6700);
  assert.equal(parseRaceTime('1:02:03.4'), (3723) * 10000 + 4000);
  assert.equal(parseRaceTime('45.12'), 451_200);
  assert.equal(parseRaceTime('-3.1'), -31_000);
  for (const bad of ['', 'same time', 'DNF', '1:75.0', 'x:10']) assert.equal(parseRaceTime(bad), null, bad);
});

test('raceTicks handles the midnight wrap', () => {
  assert.equal(raceTicks(parseTod('10:05:00'), parseTod('10:00:00')), 300 * 10000);
  assert.equal(raceTicks(parseTod('09:59:00'), parseTod('10:00:00')), -60 * 10000);
  assert.equal(raceTicks(parseTod('00:02:00'), parseTod('23:58:00')), 240 * 10000);
  assert.equal(raceTicks(parseTod('23:59:00'), parseTod('00:01:00')), -120 * 10000);
  assert.ok(TICKS_PER_DAY === 864_000_000);
});

test('cp1252 round trip, smart quotes and unmappable characters', () => {
  const s = 'O’Neil – Zoë €5 Ša';
  const buf = encodeCp1252(s);
  assert.deepEqual([...encodeCp1252('’–€')], [0x92, 0x96, 0x80]);
  assert.equal(decodeCp1252(buf), s);
  assert.deepEqual([...encodeCp1252('日')], [0x3f]);
  assert.equal(decodeCp1252(Buffer.from([0x81, 0x41])), '\u0081A');
  assert.deepEqual([...encodeCp1252('{"P":"1"}\r\n')], [...Buffer.from('{"P":"1"}\r\n', 'latin1')]);
});
