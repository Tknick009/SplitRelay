// Windows-1252 ("Single Byte" in FinishLynx) encoding. TrackScore decodes the LSS stream as latin1 and FinishLynx
// writes .lif files in windows-1252, so every byte we send or write goes through here.

/** The 0x80-0x9F block, where windows-1252 differs from latin1. Undefined bytes map to themselves. */
const HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const TO_BYTE = new Map(HIGH.map((cp, i) => [cp, 0x80 + i]));

/**
 * Unicode string -> windows-1252 bytes. Anything windows-1252 cannot hold becomes '?'.
 * @param {string} str
 * @returns {Buffer}
 */
export function encodeCp1252(str) {
  const out = Buffer.alloc(str.length * 2);
  let n = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out[n++] = cp;
    else if (TO_BYTE.has(cp)) out[n++] = TO_BYTE.get(cp);
    else out[n++] = 0x3f;
  }
  return out.subarray(0, n);
}

/**
 * windows-1252 bytes -> Unicode string. Never throws: the five undefined bytes become the same code point.
 * @param {Buffer | Uint8Array} buf
 * @returns {string}
 */
export function decodeCp1252(buf) {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b >= 0x80 && b <= 0x9f ? HIGH[b - 0x80] : b);
  return s;
}
