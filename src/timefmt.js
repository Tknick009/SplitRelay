// Times are integers in ticks of 0.1 ms (10 000 per second) everywhere in Split Relay: RR12 gives milliseconds,
// FinishLynx start times carry four decimals, and integer ticks keep "round up to the precision" exact.

export const TICKS_PER_SEC = 10000;
export const TICKS_PER_DAY = 86400 * TICKS_PER_SEC;
const HALF_DAY = TICKS_PER_DAY / 2;

/** Decimal digits -> ticks (0.1 ms), rounding half up past the fourth digit. */
function fractionTicks(digits) {
  if (!digits) return 0;
  const four = Number((digits + '0000').slice(0, 4));
  return digits.length > 4 && digits[4] >= '5' ? four + 1 : four;
}

const mod = (v, m) => ((v % m) + m) % m;

/**
 * A time of day from RR12 or the operator -> ticks since midnight, or null.
 * Accepts "15:17:44.215", "9:05:00", "15:17:44,2150" (1-9 decimals) and decimal seconds since midnight as RR12's raw
 * [RD_Time] prints them ("55064.215", "55064,215"); values from later days (>= 86400 s) wrap to the time of day.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseTod(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
  if (m) return mod(Number(m[1]) * TICKS_PER_SEC + fractionTicks(m[2]), TICKS_PER_DAY);
  m = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (min > 59 || sec > 59) return null;
  return mod((h * 3600 + min * 60 + sec) * TICKS_PER_SEC + fractionTicks(m[4]), TICKS_PER_DAY);
}

const pad = (v, n = 2) => String(v).padStart(n, '0');

function splitTicks(t) {
  return { h: Math.floor(t / 36e6), m: Math.floor(t / 6e5) % 60, s: Math.floor(t / 1e4) % 60, f: t % 1e4 };
}

/**
 * Time of day for the control panel: "15:17:44.215" (always two-digit hours). Truncates, never rounds.
 * @param {number} ticks
 * @param {number} [decimals=3] 0-4
 */
export function formatTod(ticks, decimals = 3) {
  const { h, m, s, f } = splitTicks(mod(Math.trunc(ticks), TICKS_PER_DAY));
  const frac = decimals > 0 ? '.' + pad(f, 4).slice(0, decimals) : '';
  return `${pad(h)}:${pad(m)}:${pad(s)}${frac}`;
}

/**
 * Start time of day the way FinishLynx writes it in a .lif header: "9:29:20.1938" (no leading zero on the hour,
 * four decimals).
 * @param {number} ticks
 */
export function formatLynxTod(ticks) {
  const { h, m, s, f } = splitTicks(mod(Math.trunc(ticks), TICKS_PER_DAY));
  return `${h}:${pad(m)}:${pad(s)}.${pad(f, 4)}`;
}

/**
 * A race time the way FinishLynx prints one: "45.123", "5:12.345", "1:02:03.456". Reducing precision rounds UP,
 * as FinishLynx does (23:34.954 -> 23:34.96 at hundredths).
 * @param {number} ticks
 * @param {number} [decimals=3] 0-4
 */
export function formatRaceTime(ticks, decimals = 3) {
  const d = Math.max(0, Math.min(4, Math.trunc(decimals)));
  const unit = 10 ** (4 - d);
  const t = Math.trunc(ticks);
  const abs = Math.ceil(Math.abs(t) / unit) * unit;
  const { h, m, s, f } = splitTicks(abs);
  const frac = d > 0 ? '.' + pad(f, 4).slice(0, d) : '';
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}${frac}` : m > 0 ? `${m}:${pad(s)}${frac}` : `${s}${frac}`;
  return (t < 0 ? '-' : '') + body;
}

/**
 * A race time as FinishLynx writes it in a .lif ("5:12.345", "1:02:03.4", "45.12", "-3.1") -> ticks, or null.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseRaceTime(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  // "a:b:c" -> h:m:s, "a:c" -> m:s, "c" -> s
  const h = m[2] !== undefined ? Number(m[1]) : 0;
  const min = m[2] !== undefined ? Number(m[2]) : m[1] !== undefined ? Number(m[1]) : 0;
  const sec = Number(m[3]);
  if ((m[1] !== undefined && sec > 59) || (m[2] !== undefined && min > 59)) return null;
  const v = (h * 3600 + min * 60 + sec) * TICKS_PER_SEC + fractionTicks(m[4]);
  return neg ? -v : v;
}

/**
 * Race time of a read: time of day minus the gun, wrapped so a race that crosses midnight still works (a result
 * more than 12 h away is taken to be on the other side of midnight).
 * @param {number} tod ticks since midnight
 * @param {number} gun ticks since midnight
 */
export function raceTicks(tod, gun) {
  let d = tod - gun;
  if (d < -HALF_DAY) d += TICKS_PER_DAY;
  else if (d > HALF_DAY) d -= TICKS_PER_DAY;
  return d;
}
