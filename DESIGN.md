# Split Relay — design and module contracts

Split Relay is a standalone program, not part of TrackScore or XC-Analytics. It sits between Race Result 12 and the
programs that used to get splits from FinishLynx.

```
RR12 exporter (TCP client, one stream) ──► Split Relay ──► LSS packets, one per output (IP:port + .lss script)
                                                  │            e.g. TrackScore XC :5555 (XCScore.lss),
                                                  │                 live results (Karmarush-Track.lss)
                                                  └────────► merged .lif files (FinishLynx .lif + relay splits)
                                                             for TrackScore file watch, XC-Analytics, web results
FinishLynx gets FINISH passings only, so the photo shows finish lines only.
```

Runtime: Node 18.17+ (the machine has 22.20), **plain JavaScript ES modules, zero dependencies**, no build step.
Tests: `node --test` (finds test/*.test.js) (`node:test` + `node:assert/strict`). Windows is the target OS; paths may be UNC
(`\\192.168.0.5\Lynx\Meet`). All writes are temp-file + rename. Never write into a folder we read from.

## 1. Facts the implementation must honor (from research, 2026-10-17)

Race Result 12 (12.5.50) exporter:
- RR is the **TCP client**: it dials the relay's IP:port. The relay must already be listening when the operator presses
  play on the exporter (otherwise RR refuses to start it). Accept several simultaneous connections. RR retries every
  2–4 s while the relay is down, queues, then flushes in order. "Replay" re-sends the entire history → the relay must
  be idempotent (an identical read again is a no-op).
- Never write to RR's socket.
- Lines end CRLF by default (CR, LF, TAB or none possible). Encoding UTF-8 (default) or ASCII.
- Reads arrive 1.4–3 s after the passing, and about 15 % of adjacent reads arrive out of time order.
- `format([RD_Time];"hh:mm:ss.kkk")` prints `15:17:44.215`. Raw `[RD_Time]` is decimal seconds since midnight of
  the event date (can exceed 86400 on later days → take modulo 86400).
- Expression syntax: fields in `[]`, strings joined with `&`, function arguments separated by `;`.
- "Min. Seconds Between" must be 0 (it is a global throttle, not a per-bib filter).
- Primary and backup lines are **separate timing points** in the user's RR12 setup. The user maps the splits in RR12
  and sends ONE stream through ONE exporter.

TrackScore XC port 5555 (`server/lynx-listener.ts`, `server/xc/xc-ingestion.ts` in TrackScore-LocalCopy):
- TCP server, accepts many clients at once (FinishLynx + the relay together is fine), never writes back.
- Frames JSON objects by brace depth; decodes **latin1** → send CP1252 bytes.
- `{"T":..,"D":{..}}` per runner. JSON must be valid: `"D":{,` and `"EN":,` are silently DROPPED.
- `P` must be an integer ≥ 1 or the packet is dropped. `D.T` (finish time) must be `""` on a split — any value
  makes the runner a finisher. `L2G` (laps to go) = N − k + 1 for split k of N (1-based); never 0, never blank.
  TrackScore puts the split in column `totalSplits − L2G`, so N must equal the race's split count in TrackScore.
- `CS` = race time at the split (time of day − gun time), `.` decimal, thousandths: `M:SS.fff` / `H:MM:SS.fff`.
- `EN` = event number. A *different* event number that exists in TrackScore's meet program SWITCHES TrackScore's live
  race and wipes it; `""` never switches and passes every filter; the live race's own number is harmless.
- A blank-but-present `LICENCE` clears that runner's gender. Names/team: TrackScore keeps the latest non-empty value,
  so they must match FinishLynx's strings exactly (from Lynx.ppl) or be blank.
- `runner.place = P` on every packet → a split sent for a runner who already finished overwrites their place. Keep
  corrections/re-sends inside a short window and never for runners known to have finished.
- While TrackScore watches a results FILE for a race, it ignores port 5555 entirely. That is why we also write merged
  `.lif` files (section 7).
- Text values must not contain `"`, `\`, `{`, `}` or control characters (strip them).

FinishLynx `.lss` scripts — see section 5 for the language. The two scripts in use:
- `C:\Lynx\XCScore.lss` (TrackScore): `;;ResultsHeader` emits `{"T":"T","D":{` then a line `\,`, then header fields
  `"EN":%s,` (unquoted!) `"R":%s,` `"H":%s,` `"S":"%s",` `"DS":"%s",` `"DN":"%s",` `"W":"%s",`; `;;Results` emits
  `"P":"%s",` … `"LICENCE":"%s"`; `;;ResultsTrailer` emits `}}\0d\0a`. Its `;;StartedHeader` uses `\00,` which really
  emits a comma → invalid JSON. So the relay uses the **Results** sections by default.
- `C:\Lynx\Karmarush-Track.lss` (live results): same shape, `\00"MID":8132,` after `"D":{`, no DN, no LICENCE.
  The MID (Karmarush meet id) is per meet → outputs have a MID override.
- Real FinishLynx `.lif` rows (verified on 10 real files): 19 fields —
  `0 place,1 bib,2 lane,3 last,4 first,5 team,6 time,7 licence(M/F),8 delta,9 (blank),10 "splits",11 start TOD,
  12-14 user (blank),15 gap,16 gap,17 (blank),18 average lap`. Field 10: `"4:55.339 (4:55.339),10:08.670 (5:13.331),
  15:03.968 (4:55.298)"` = cumulative (leg), finish last. Unfinished rows: place `""` or `DNF`, time `""`.
  Header: `1,1,1,Boys Gold,,,,,,,12:58:49.2595` (EN, round, heat, name, 6 blanks, start time of day, 4 decimals).

## 2. Units

All times are integers in **ticks of 0.1 ms** (1 s = 10 000 ticks). Times of day are ticks since midnight
(0 ≤ tod < 864 000 000). Race time = tod − gun; if that is below −12 h add 24 h, above +12 h subtract 24 h
(midnight wrap).

## 3. Data shapes (persisted in `data/config.json`)

```js
Config = {
  version: 1,
  input:  { port: 5565, delimiter: '|', tag: 'SR', columns: ['location','bib','time','contest','first','last','team','gender'] },
  filter: { tagWindowSec: 10, holdSec: 2, startIgnoreSec: 60 }, // tag window (chip time); hold (wall clock); start area (9.3)
  names:  { pplPath: '' },                          // optional FinishLynx people file (bib,last,first,team,M/F,...)
  lif:    { enabled: false, inputDir: '', outputDir: '', fillPlaces: false },
  panel:  { port: 5590, allowLan: false },
  meet:   { name: '', trackScoreWebPort: 5000 },     // 9.22: the meet file's name; TrackScore's web page (Set up from TrackScore)
  entries: { otherRace: 'send' },                   // 9.25: only when "send and flag"; absent = keep athletes of another race off the boards
  races:  Race[],
  outputs: Output[],
}
Race = {
  id: 'r_<random>', name: 'Girls Varsity 5K',
  eventNumber: '3', round: '1', heat: '1', distance: '',   // as FinishLynx has them; used in packets + .lif matching
  contests: ['Girls Varsity 5K'],                          // stream "contest" values that belong to this race; [] = any
  gun: '10:00:00.000' | '',                                // time of day as typed (empty = not set yet)
  splits: [{ id: 's_<random>', name: '1K', sources: ['1K-A', '1K-B'] }],  // course order; sources = stream location names
                                                           // 9.26: + collectOnly: true on a split that is counted, not sent
  finishSources: [],                                       // optional: stream names of the finish; recorded, NEVER sent
  active: true,                                            // false = reads for this race are ignored (logged 'paused')
}
Output = {
  id: 'o_<random>', name: 'TrackScore', enabled: true,
  mode: 'tcp-client' | 'tcp-server' | 'udp', host: '127.0.0.1', port: 5555,
  script: 'C:\\Lynx\\XCScore.lss',
  stage: 'results' | 'started',          // which script sections to render (default 'results')
  races: [],                              // race ids this output sends; [] = all races
  eventNumber: 'race' | 'blank',          // \13\04 value: the race's event number, or blank
  precision: 3,                           // decimals for CS/LS: 1, 2 or 3 (rounded UP like FinishLynx)
  mid: '',                                // if set, replaces "MID":<digits> in rendered packets
}
```
Matching of contests, sources, locations: case-insensitive, trimmed, inner whitespace collapsed.

## 4. Module contracts

Every module is an ES module under `src/`, with tests under `test/<module>.test.js`. Use JSDoc for types. Keep
modules free of global state so tests can create several instances.

### 4.1 `src/cp1252.js`
```js
export function encodeCp1252(str)   // -> Buffer. Unicode -> windows-1252; unmappable -> '?'
export function decodeCp1252(buf)   // -> string. Undefined bytes 0x81 0x8D 0x8F 0x90 0x9D -> same code point
```

### 4.2 `src/timefmt.js`
```js
export const TICKS_PER_SEC = 10000
export function parseTod(text)                 // -> ticks | null. "15:17:44.215", "9:05:00", "15:17:44,2150",
                                               //    1-4 decimals, or decimal seconds "55064.215"/"55064,215" (mod 86400)
export function formatTod(ticks, decimals = 3) // -> "15:17:44.215" (2-digit hour) — for the UI
export function formatLynxTod(ticks)           // -> "9:29:20.1938" (no leading zero on hour, 4 decimals) — .lif header
export function formatRaceTime(ticks, decimals = 3) // -> "45.123" | "5:12.345" | "1:02:03.456"; decimals 0-4;
                                               //    ROUNDS UP (ceil) to the precision; negative -> "-" + abs
export function parseRaceTime(text)            // -> ticks | null. "5:12.345", "1:02:03.4", "45.12" (.lif times)
export function raceTicks(tod, gun)            // tod - gun with the midnight wrap rule of section 2
```

### 4.3 `src/input.js` — RR12 stream in
```js
export const COLUMN_TYPES = ['location','bib','time','contest','first','last','team','gender','ignore']
export const COLUMN_EXPRESSIONS = { location: '[RD_TimingPoint]', bib: '[RD_IDBib]',
  time: 'format([RD_Time];"hh:mm:ss.kkk")', contest: '[Contest.Name]', first: '[Firstname]',
  last: '[Lastname]', team: '[Club]', gender: '[Gender]', ignore: '""' }
export function buildExpression(format)   // -> RR12 "Export Data" expression, e.g.
                                           //  "SR|" & [RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format(...) ...
export function parseLine(line, format)   // -> { ok:true, read } | { ok:false, kind:'empty'|'hello'|'error', message }
   // read = { location, bib, tod /*ticks*/, contest, first, last, team, gender }
   // Strips a leading \x01/\x02, the tag field when it equals format.tag (lines without the tag are still parsed if
   // the field count fits), trims every field. `<tag>|HELLO|...` (RR "Connect Message") -> kind 'hello'.
   // Also accepts an [RD_RecordJSON] object line ({TimingPoint, Bib, Time,...}).
   // A FinishLynx LapTime line "\x01S,15:17:44.215,254" -> error "LapTime format has no timing point name".
   // bib '' or '0' -> error. Unparseable time -> error.
export class InputServer extends EventEmitter {
  constructor({ port, host = '0.0.0.0', quietFlushMs = 300 })
  async start(); async stop(); async restart(port)
  status()  // { listening, port, error, connections: [{ id, remote, connectedAt, lines, lastLineAt }], totalLines, lastLineAt }
  // emits 'line' (text, { connId, remote, receivedAt }) and 'status' (status())
  // Per-connection StringDecoder('utf8'); split on \r\n|\r|\n|\t; flush a trailing partial line after quietFlushMs
  // of silence; drop lines > 4096 chars. Never writes to sockets.
}
```

### 4.4 `src/ppl.js` — FinishLynx people file (names exactly as FinishLynx has them)
```js
export function parsePpl(text)  // -> Map<bib, { first, last, team, gender }>
   // CSV, quote-aware, CRLF, no header (skip a first line whose field 0 is "ID"/"Bib"/"Number").
   // fields: 0 bib, 1 last, 2 first, 3 affiliation, 4 gender (M/F). Gender normalized to 'M'|'F'|''.
export class NamesFile extends EventEmitter {
  constructor({ path, pollMs = 5000 })
  start(); stop(); setPath(path)
  lookup(bib)   // -> entry | undefined
  status()      // { path, loaded, count, error, loadedAt }
  // decodes with decodeCp1252; reloads when mtime/size changes; emits 'change'
}
```

### 4.5 `src/engine.js` — races, tag filter, places
```js
export class Engine extends EventEmitter {
  constructor({ getConfig, names /* { lookup(bib) } */, store /* { load(raceId), save(raceId, data), remove(raceId) } */,
                clock = { now: () => Date.now(), setTimeout, clearTimeout } })
  handleRead(read, meta /* { receivedAt, raw, connId } */) // -> FeedEntry
  configChanged({ deleted }) // re-read config (races added/removed/edited); keeps crossings of surviving races;
                            // only the races named in deleted retire their reads (9.2 R2, R6)
  setGun(raceId, gunText)   // validates (parseTod; '' clears) and emits 'config-patch' { raceId, patch: { gun } };
                            // the owner of the config applies the patch SYNCHRONOUSLY inside that listener, then
                            // setGun re-reads the config, recomputes and processes pending reads. Throws on bad text.
  resendRace(raceId)        // re-emits 'send' for every sent crossing (reason 'resend'), split order then time; -> count
  clearRace(raceId)         // forgets crossings, pending reads, finishes
  raceView(raceId)          // -> RaceView (see section 6)
  crossings(raceId)         // -> CrossingView[] sorted by split then time
  raceData(raceId)          // -> { splitCount, gun (ticks|null), runners: Map<bib, { first,last,team,gender, splits: (ticks|null)[] }> }
  seen()                    // -> { locations: [{ name, count, lastAt }], contests: [{ name, count, lastAt }] }
  feed(limit = 200)         // -> FeedEntry[] newest first (ring buffer of 1000)
  // events: 'send' (SplitPacket), 'feed' (FeedEntry), 'race' (raceId), 'config-patch' ({ raceId, patch })
}
```
Processing a read:
1. Race = first ACTIVE race whose `contests` contains the read's contest; if none, the first active race with
   `contests: []`. None → status `no-race`. A matching race that is inactive → `paused`.
2. Location matches a split's `sources` → that split. Matches `finishSources` → record bib as finished, status
   `finish` (never sent). Otherwise → `unmapped` (counted in `seen()` and in the race view's unmapped list).
3. Gun not set → keep the read in the race's pending list, status `waiting-gun`; when the gun is set, pending reads
   are processed in time-of-day order.
4. Race time < 0 → `before-gun`.
5. Crossing key = (race, bib, split id). No crossing yet → create it (earliest tod = this read), schedule the send
   `holdSec` (wall clock) after this first arrival, status `held` then `sent` when it goes out.
   Crossing exists and |tod − crossing.tod| ≤ tagWindowSec → `backup` (same crossing; an identical tod → `duplicate`).
   If this read is EARLIER: the crossing takes its tod; if already sent → status `corrected` and a re-send
   (reason 'correction') — only if the first send was < 60 s ago and the bib has not finished.
   Beyond the window → `repeat` (ignored; the first crossing stands).
6. Sending: place = 1 + number of crossings of that race+split with an earlier tod (ties: earlier arrival first).
   After sending, any OTHER sent crossing of that split whose place is now different and that was sent < 60 s ago and
   whose bib has not finished is re-sent with its new place (reason 'place-update').
7. LS = this split's race time − the race time of the nearest earlier split that this bib has; else LS = CS.
8. Names: `names.lookup(bib)` first (FinishLynx strings), else the first non-empty values seen on the stream.
   Gender: 'M'/'F' from the names file, else the stream (`m`, `f`, `male`, `female`, `boys`, `girls`, … → M/F), else ''.
9. Persist each race's crossings, pending reads and finished bibs through `store.save` (debounced ~500 ms). On
   construction, `store.load` every configured race; crossings that were held but never sent are sent at once.
10. Changing a race's gun recomputes every race time (crossings keep their tod). Emit 'race' so the UI can offer a resend.

```js
SplitPacket = { raceId, race /* Race */, splitId, splitIndex /*0-based*/, splitCount /*N*/, splitName,
                bib, first, last, team, gender, csTicks, lsTicks, place, lapsToGo /* N - splitIndex */,
                gunTicks, reason: 'new'|'correction'|'place-update'|'resend' }
FeedEntry   = { id, at /*wall ms*/, raceId, raceName, splitName, location, bib, name, team, tod, raceTicks, place,
                status, detail }
// status: 'held','sent','backup','duplicate','repeat','corrected','before-gun','waiting-gun','unmapped','no-race',
//         'paused','finish','bad-line'
```

### 4.6 `src/lss.js` — FinishLynx scoreboard script language
```js
export function parseScript(text)    // -> Script { sections: { [lowerName]: Line[] }, warnings: string[] }
export function renderUpdate(script, { stage = 'results', header = {}, rows = [], json = 'auto' })
   // -> { text, warnings: string[], isJson: boolean, jsonErrors: string[] }
   // header: { [code]: string } for group \13 (codes 0x01-0x0f); rows: [{ [code]: string }] for group \14 (0x01-0x18)
export function describeScript(script)  // -> { sections: [{ name, lines }], usesCommands, mid: string|null }
export function escapeForDisplay(text)  // -> printable string; control bytes as \0d \0a etc.
```
See section 5 for semantics.

### 4.7 `src/outputs.js` — sending LSS packets
```js
export function packetVariables(packet, output)  // -> { header, rows: [row] } (LSS variable values, all strings)
export class OutputManager extends EventEmitter {
  constructor({ getConfig, log /* (line) => void */ })
  sync()                 // create/update/close connections to match config.outputs; (re)load scripts (watch mtime)
  send(packet)           // every enabled output whose races include packet.raceId ([] = all)
  preview(outputId, packet | null)  // -> { text, display, isJson, jsonErrors, warnings } (sample packet if null)
  reconnect(outputId)
  status()               // -> OutputStatus[] (section 6)
  async stop()
  // emits 'status'
}
```
Variable mapping (FinishLynx values for a split crossing):
- header `\13`: 01 `UNOFFICIAL`, 02 race name, 03 `''`, 04 event number (or `''` when output.eventNumber is 'blank'),
  05 round, 06 heat, 07 `AUTO`, 08 number of runners in the race with ≥1 crossing, 09 `RUNNING`, 0a distance,
  0b `''`, 0c `''`, 0d/0e/0f gun time of day with 4/3/2 decimals (`formatLynxTod` style).
- row `\14`: 01 place, 02 `''` (lane), 03 bib, 04 last name (FinishLynx's Name variable sends the last name),
  05 team, 06 `''` (time is blank on a split), 07 `''`, 08 CS, 09 LS, 0a laps to go, 0b gender (M/F or ''),
  0c-16 `''`, 17 first name, 18 last name.
- CS/LS via `formatRaceTime(ticks, output.precision)`.
Connections:
- `tcp-client`: connect to host:port; on close/error reconnect after 1 s, 2 s, 3 s … max 5 s; while not connected
  queue rendered packets (max 5000, oldest dropped with a log line) and flush in order on connect. Set keepAlive.
- `tcp-server`: listen on port (host = bind address, default 0.0.0.0); write each packet to every connected client.
- `udp`: one datagram per packet to host:port.
- After rendering, if output.mid is set, replace `"MID"\s*:\s*\d+` with `"MID":<mid>`. Encode with encodeCp1252.
- Each packet sent is logged via `log` as `[out <name>] <escapeForDisplay(text)>`.
- A script that fails to load disables that output with a clear `scriptError`; a JSON script whose render has
  `jsonErrors` still sends but reports the error in status (`lastError`).

### 4.8 `src/lif.js` — merged .lif files (section 7)
```js
export function parseLif(text)   // -> { header: { line, fields } | null, rows: [{ line, fields, bib, place, time }] }
export function lifFileName(eventNumber, round, heat)  // -> '003-1-01.lif'
export function mergeLif({ lynxText, race, gunTicks, splitCount, runners, fillPlaces = false })  // -> string (CRLF)
export class LifSync extends EventEmitter {
  constructor({ getConfig, getRaceData /* (raceId) -> raceData */, log, clock, pollMs = 1000 })
  start(); stop(); markDirty(raceId)
  lynxStart(raceId)   // -> ticks | null: start time of day from the matching FinishLynx .lif header
  status()            // -> LifStatus (section 6)
  // emits 'status'
}
```

### 4.9 `src/store.js`, `src/config.js`, `src/server.js`, `src/main.js` (integration)
- `store.js`: per-race JSON in `data/races/<raceId>.json`, atomic writes.
- `config.js`: load/save `data/config.json`, defaults, normalisation (missing fields filled, ids generated), atomic.
- `server.js`: HTTP API + static UI (section 6). State-changing requests only from loopback addresses.
- `main.js`: wires InputServer → parseLine → Engine → OutputManager + LifSync; logs to `data/logs/YYYY-MM-DD.log`
  (every received line with time and connection, every packet sent, every error). Flags: `--data <dir>`,
  `--port <panel port>`, `--no-open`. Opens the browser on start unless `--no-open`.
- `start.bat`: finds node (PATH, then `%ProgramFiles%\nodejs`), runs `node src\main.js`, pauses on error.

## 5. LSS language (what `src/lss.js` implements)

File: lines split on CR/LF. Empty lines and lines starting with `;` (but not `;;`) are ignored. `;;Name` or
`;;Name[n]` starts a section (name case-insensitive; `[n]` page suffix accepted and ignored → treat as page 0 only).
Sections may repeat; repeated sections concatenate in file order. `;;Result` is an alias of `;;Results`.

Escapes in format lines: `\hh` with two LOWERCASE hex digits is a byte. Commands are `\` + an uppercase letter or a
symbol (see below). A backslash followed by anything else (e.g. `\,` in XCScore.lss) emits nothing (warning once).

Each format line, after escape decoding, starts with a code:
- 2-byte form: first byte ≥ 0x10 is the group, next byte is the variable (0x00 = none).
- legacy 1-byte form: first byte < 0x10 is the variable; the group is the section's default (body sections → 0x14,
  header/trailer sections → 0x13, Message → 0x16, Time* → 0x11, Wind → 0x12, Initialization → 0x10).
- Valid groups per section: Initialization 10,13,17 · Time* 11,13,17 · Wind 12,13,17 ·
  StartListHeader/Trailer, StartedHeader/Trailer, ResultsHeader/Trailer 13,17 · StartList, Started, Results 13,14,17 ·
  MessageHeader/Trailer 13,15,17 · Message 13,15,16,17. A line whose group is not valid for its section is skipped.
- Variable 0x00 → the rest of the line is emitted as-is (a `%` is literal).
- Variable ≠ 0 → the rest is a printf format with exactly one `%[-][width][.prec]s` (and `%%` → `%`). Width pads with
  spaces (left, or right with `-`), `.prec` truncates. The value comes from the header map (group 0x13) or the
  current row (group 0x14). A missing value is `''`. The line is emitted even when the value is empty.
- Nothing is added between lines: only explicit `\0d\0a` produce line breaks.

Rendering one update (stage 'results'): `ResultsHeader` lines once, `Results` lines once per row (register 0 = row
index), `ResultsTrailer` once. Fall-backs when a section is missing: Started* → StartList* → Results*;
StartList* → Results*. Stage 'started' renders the Started family with those fall-backs.

JSON safety (`json: 'auto'` → applied when the plain render contains a JSON object start, i.e. `{` followed by
optional spaces and `"`; scripts may mix JSON with other text such as `Command=LayoutDraw;...` lines; `json: true`
forces it, `json: false` disables it):
- A variable whose `%s` sits in an UNQUOTED JSON value position (previous non-space char `:` or `[` or `,` and next
  non-space char `,` `}` `]` or end of line) and whose value is not a JSON number is emitted quoted: `"EN":""`,
  `"EN":"3A"`.
- Text values have `"`, `\`, `{`, `}` and control characters removed.
- The rendered text is split into top-level objects (brace depth outside strings; text between objects is ignored)
  and each is `JSON.parse`d; failures are listed in `jsonErrors` (not thrown).

Commands (best effort; neither target script uses them): registers r0–r9 persist across lines within one update.
`\U\hh` / `\Ui\hh` set U (value / register), `\X\hh` / `\Xi\hh` set X; U and X reset after the next command.
Operand = r[U] if U set, else X if X set, else 1. `\=n \*n \/n \#n \+n \-n \<n \>n \&n \|n \^n` apply
r[n] = r[n] op operand (`=` assigns operand); `\~n` inverts. The argument n is `\hh` or one digit. The line is an edit
buffer with a cursor: text and the `%s` expansion insert at the cursor. `\Bn` delete n chars before the cursor (0 → to
start of line), `\Dn` delete n at the cursor (0 → to end), `\In` insert n spaces, `\Icn` insert n copies of X, `\Ln`/`\Rn`
move the cursor (0 → start/end), `\On` output r[n] as X bytes (default 1) by method U (0 LE binary, 1 BE binary,
2 ASCII right-justified spaces, 3 right zero-padded, 4 left spaces, 5 left zeros), `\Sn` scan, `\Fn` checksums
(1 XOR, 2 ADD, 3 CRC-16, 4 CRC-32; seeds per the doc), `\P0` reverse. Anything unsupported → warning, ignored.

## 6. HTTP API (control panel) — `src/server.js`

Base `http://localhost:5590`. JSON in and out. Errors: `{ error: "plain-English message" }` with 4xx/5xx.
Mutations (POST/PUT/DELETE) are refused with 403 unless the request comes from a loopback address.

```
GET  /api/state           -> State (everything the UI needs to paint)
POST /api/update/check    -> State (9.28: asks GitHub for the newest release now)
POST /api/update/install  -> State + updateDone (9.28: installs it; Split Relay then starts again)
POST /api/update/dismiss  -> State (9.28: hides the note of an update that was taken back)
GET  /api/events          -> text/event-stream; events: 'state' (full State, at most every 500 ms when anything
                             changed) and 'feed' (FeedEntry, immediately)
PUT  /api/settings        body: { input?, filter?, names?, lif?, panel? } (partial) -> State
POST /api/races           body: Partial<Race> -> State          (new race with defaults)
POST /api/races/preview   body: { id?, race?, delete? } -> RoutePlan & { raceId }  (what a save/delete would do, 9.2)
PUT  /api/races/:id       body: Partial<Race> -> State
DELETE /api/races/:id     -> State
POST /api/races/:id/gun   body: { gun: '10:00:00.000' } -> State   (only a typed time: no "now", no "fromLynx", §9.21)
POST /api/races/:id/resend   -> { sent: n }
POST /api/races/:id/clear    -> State
GET  /api/races/:id/crossings -> CrossingView[]
POST /api/outputs         body: Partial<Output> -> State
PUT  /api/outputs/:id     body: Partial<Output> -> State
DELETE /api/outputs/:id   -> State
POST /api/outputs/:id/preview  -> { text, display, isJson, jsonErrors, warnings }
POST /api/outputs/:id/reconnect -> State
GET  /api/files?dir=<path>&ext=.lss  -> { dir, parent, entries: [{ name, path, type: 'dir'|'file' }] }
                             (no dir → drive roots on Windows / home on others); for picking scripts, .ppl, folders;
                             &times=1 adds mtimeMs to the first 100 files (9.20 N2: "modified today 09:12")
GET  /api/expression      -> { expression }  (RR12 Export Data expression for the current input format)
GET  /api/find?q=         -> { q, matches }  (runners of every race by bib or name, §9.23 F7; LAN viewers may use it)
GET  /api/races/:id/grid[?since=rev] -> Grid, or { rev, unchanged: true }  (runners by splits, §9.23 F7)
POST /api/races/:id/runners/:bib/move  body: { tod, to, only?, from? } -> { change, runner, review }  (§9.23 F2)
POST /api/races/:id/runners/:bib/send  -> { sent, outputs, skipped, runner, review }  ("Send again", §9.23 F4)
POST /api/races/:id/runners/:bib/stop  body: { from? } -> { change, runner, review }  ("Stop sending this runner", §9.24)
POST /api/races/:id/runners/:bib/resume -> { change, runner, review }  ("Send this runner again", §9.24)
POST /api/races/:id/runners/:bib/place body: { say: 'away' | 'here' } -> { change, runner, review }  ("Not in this
                             race"; "Count them here" / "It's right", §9.25)
POST /api/startlists      body: { files: [{ name, text }] } -> State & { startListLoad: { results, notes, resent, held } }
                             (§9.25: the meet's entry files, one per event; only the bibs are kept, in data\startlists.json)
DELETE /api/startlists/:event -> State & { startListRemove: { text, resent, held } }  ('all': every list, §9.25)
GET /api/swaps            -> { swaps: [{ a, b, at, atText, text, races: [{ raceId, raceName, text }] }] }  (§9.27: swapped bibs)
POST /api/swaps/preview   body: { bib, other } | { bib, remove: true } -> { a, b, remove, title, lead, confirm, races, notes }
                             (what entering or removing the swap would do, in words; changes nothing)
POST /api/swaps           body: { bib, other } -> State & { swapChange: { swap, pair, removed, text, races } }  ("Swapped
                             bibs": bib ran with the chip of other, and the other way round, in every race)
DELETE /api/swaps/:bib    -> State & { swapChange }  ("Remove swap": the swap this bib is in, either bib of the pair)
POST /api/races/:id/undo  body: { fix, confirm? } -> { change, undone, runner?, review }; 409 { code: 'UNDO_LEAVES',
                             leaves, error } asks first (§9.23 F3)
(the Review routes of §9.17 and §9.23: GET review, GET runners/:bib, POST assign, POST/DELETE manual, POST
send-finished; POST /manual takes `tod` and `ifEmpty` too, §9.23 F5)
GET  /api/meet/files      -> { dir, files: [{ fileName, name, savedAt, savedOn, races, outputs, mtimeMs, beforeLoad?,
                             error? }] }  (local only: the meet files in data\meets, the setup before the last load first)
POST /api/meet/save       -> { name, fileName, path, text, replaced }  (9.22 M2: data\meets\<meet name>.json)
POST /api/meet/preview    body: { meet, fileName? } | { saved } | { trackscore: true }, removeOthers? -> MeetPreview
                             (9.22 M3: what a load would do; changes nothing; undo: true for the copy kept before a load,
                             with leftover: what the load after it added and stays, O33)
POST /api/meet/apply      body: { meet, mode, base, removeOthers?, undo?, keep?, fileName? } -> State & { applied }
                             (409: the setup changed; keep: a file from the chooser or a drop is kept in data\meets.
                             applied: added, racesChanged, outputsAdded, outputsChanged, settings, removed, outputsOff,
                             keptAs, beforeLoad, undo: { at } for the copy kept before a load)
POST /api/meet/new        body: { confirm: true } -> State & { newMeet }  (9.22 M9: Start a new meet)
```
```js
State = {
  version, now /* wall ms */, config,
  addresses: ['192.168.0.21', ...],            // this PC's IPv4 addresses, for "point RR12 at …"
  input:  { listening, port, error, connections: [...], totalLines, lastLineAt },
  outputs: OutputStatus[],
  names:  { path, loaded, count, error, loadedAt },
  lif:    LifStatus,
  races:  RaceView[],
  seen:   { locations: [{ name, count, lastAt }], contests: [{ name, count, lastAt }] },
  feed:   FeedEntry[]  /* newest first, up to 200 */,
}
OutputStatus = { id, name, enabled, mode, target /* 'host:port' */, state: 'connected'|'connecting'|'disconnected'|
  'listening'|'disabled'|'error', clients, sent, queued, lastSentAt, lastError, scriptOk, scriptError,
  scriptInfo /* { sections, mid } */ }
RaceView = { id, name, gunTicks, gunText, elapsedTicks|null, splits: [{ id, name, sources, crossings, lastAt }],
  runners /* bibs with ≥1 crossing */, finished, pending /* reads waiting for gun */, unmapped: [{ name, count }],
  lastReadAt, lynxStart: ticks|null }
CrossingView = { bib, name, team, splitId, splitName, tod, raceTicks, place, sentAt, reads, reason }
LifStatus = { enabled, inputDir, outputDir, state: 'off'|'ok'|'error'|'waiting', error, lastScanAt,
  files: [{ name, eventNumber, round, heat, raceId, raceName, rows, splitsAdded, writtenAt, copiedOnly }] }
```

## 7. Merged .lif files — `src/lif.js`

Purpose: FinishLynx now only sees finishes, so its `.lif` files carry no splits. The relay rebuilds the file FinishLynx
would have written and writes it to its own output folder; TrackScore (Lynx folder/file watch), XC-Analytics (watch
path) and the web-results folder read from there instead.

- Poll `inputDir` (non-recursive) every second for `*.lif`. A changed file (mtime/size) is read, re-read 200 ms later,
  and used only if both reads match (FinishLynx may be mid-write). Network shares can be slow or missing: all fs calls
  async, errors shown in status, back off to 10 s while the folder is unreachable.
- A Lynx file whose header (EN, round, heat — compared with leading zeros stripped) matches a relay race → merged.
  Any other `.lif` → copied byte-for-byte. Output name = input name.
- A relay race with crossings but no Lynx file yet → a file is synthesised as `lifFileName(EN, round, heat)` with
  header `EN,round,heat,name,,,,,,,<formatLynxTod(gun)>`.
- Re-merge when the Lynx file changes or when `markDirty(raceId)` is called (debounced 1 s).
- Merge rules (`mergeLif`):
  - Lynx header line kept verbatim. Every Lynx row the relay has no crossings for is kept byte-for-byte.
  - A Lynx row whose bib has relay crossings: field 10 is rebuilt as N slots (one per split, empty where the mat missed
    the runner) plus the finish entry when field 6 has a time; trailing empty slots dropped; each entry
    `cum (leg)` with leg = cum − previous non-empty cum (first: leg = cum); times `formatRaceTime(t, 3)`; the finish
    entry uses field 6's text as written. Field 10 is wrapped in double quotes. Field 18 (average lap) is recomputed
    as the last cumulative / number of non-empty entries with `formatRaceTime(t, 2)` when field 10 changed. All other
    fields untouched. The row keeps 19 fields (pad with empty fields if shorter).
  - Bibs with crossings but no Lynx row get a row
    `,bib,,last,first,team,,gender,,,"splits",<start TOD 3 decimals>,,,,,,,avg` (19 fields), after all Lynx rows,
    ordered by furthest split reached (desc) then time at that split (asc). With `fillPlaces` and no finisher in the
    file yet, these rows get places 1..n in that order (FinishLynx "Fill in place" behaviour); default off.
  - Text fields: a value containing a comma is wrapped in quotes; a `"` becomes `'`.
  - Output: CRLF line endings including the last line, encoded CP1252, written temp + rename (retry rename up to
    10× / 100 ms on EBUSY/EPERM — a reader may hold the file).
- Never write inside `inputDir`; refuse (status error) when `outputDir` equals `inputDir` or is inside it.
- `lynxStart(raceId)`: the last header field of the matching Lynx file, parsed with `parseTod`.

## 8. Control panel UX (`public/index.html`, `public/app.js`, `public/style.css`)

Audience: a timer on race day, under time pressure, on a laptop next to FinishLynx. Must be obvious without a manual.
(Revision 12, the control-room redesign: this section describes the pages as they are now. The revision notes in 9.x
keep the names of their day: "the Live tab" is the Dashboard, "the race card" a race tile.)
- Vanilla JS, no framework, no build, no external requests (works offline; system fonts: Bahnschrift for headings,
  numbers and tiles, the system UI font for text). One page; the hash is the route: `#live` (Dashboard),
  `#review/<race>`, `#races/<id>`, `#outputs/<id>`, `#inputs`, `#settings/<section>`, `#help/<topic>`. Keys (not
  while typing): / finds, R opens Review, 1-7 the pages, Esc closes the drawer or a dialog.
- Look: a dark control-room theme from tokens on `:root` (`--bg`, `--chrome`, `--panel`/`-2`/`-3`, `--border*`,
  `--text`/`-2`, `--muted`; spacing `--s1`..`--s6` on an 8 px grid). One accent, gold (`--gold`), for primary buttons,
  the current page and the focus ring, never on an amber surface. Green, amber, red, blue and grey mean status only
  (`.tone-*` sets `--t`, `--t-fg`, `--t-bg`, `--t-border`), and every coloured state also carries a word. No running
  race clock: a gun is shown as a time of day.
- **Status strip** (the sticky top bar): the brand, then the lights in three groups, IN (one per RR12 port), OUT (one
  per output) and FILES (merged .lif files; a names file that did not load, or none while the splits go without
  names, 9.20): green working, amber waiting, red a
  problem, grey off or a spare port. A light that is not green says why in a word ("not connected", "off"); hover or
  focus shows its details in a popover (the same text is its aria-label, in sentences); a click opens its page. An
  output or port that stays down while its race runs turns red. "Live" / "Offline" at the right; while the connection
  is lost every light is grey, "last known". The strip always fits its bar (`stripPlans`, measured off screen every
  second and on resize): short names (the port number, a long output name cut short), then dot and name only, then
  the kind with the most lights becomes one light with a dot per light and a count ("IN ●●● 3 ports", its popover
  lists every light with its word, its colour is the worst one's), then the other kind, then without the group
  labels; only when even that does not fit does it wrap. A light is never cut off.
- **Nav rail** on the left (icons only below 1280 px, a row of tabs below 720 px): Dashboard, Review, Races, Outputs,
  Inputs, Settings, Help, each with a badge for what waits there (problems, runners to review, a red output or port).
  The browser tab's title and icon show the problem count and an alert.
- **First-run checklist** (Dashboard, until the meet is set up; `setupSteps`, ticked from what Split Relay reports):
  connect the RR12 exporter, add TrackScore and the live results, choose FinishLynx's names file, set the merged .lif
  folders, add the first race. It folds to one line once done.
- **Dashboard**: a tile per Active race (name, event, port, splits and runners; the gun time with an in-place pencil;
  a chip per output that sends the race, "Not on TrackScore" when TrackScore shows another one, "No names" while the
  splits go without names (a click opens the names file picker, 9.20); the last read; a tile
  per split point with its count, a bar and Pause/Play; the Review button with its count), and **Needs attention**
  beside the tiles from 1280 px (above them below): one line per problem, red first, then the decisions (which race
  TrackScore shows: Switch to… / Keep) and the notes, each with its fix and a fold for the whole story. Below: the
  races that are not Active (Switch to…), and the live feed (race filter, problems only, filtered reads, search,
  Freeze list, Show more; a row opens its detail).
- **Review** (DESIGN 9.17; `#review/<race>`): one race at a time (race chips with their counts), the paused splits with
  Play, four counters (to check, missing splits, finished but not sent live, made-up and typed), then the queues:
  Passes to check (Move / Keep), Missing splits (the estimate in an editable box, Send, Send all), Finished: not sent
  live (Send with finish place) and Made-up and typed times (Remove). A row: the bib (it opens Find runner), the
  runner's name (never cut: the team and the chips give way), the split and time, the buttons; a line under it only
  when something about it is not as usual. **Find runner** sits beside the queues from 1280 px, above them (one line
  until used) below. Rows that arrive while the list is open are added at the end, marked "New".
- **Races**: the list of races and the editor: the race form (name, event, round, heat, RR12 port, number of splits,
  splits with laps to go and Pause, earliest times under Advanced; a new race may get its gun time in the form, or on
  its gun card once saved), the gun card (a typed time; the FinishLynx start only fills the box, §9.21), the race data with Resend,
  Clear, Duplicate and Delete, and the crossings table.
- **Outputs**: a card per output (state, target, counts, last error, Turn on / off, Reconnect, Preview packet) and its
  editor in a drawer over the page (name, IP, port, mode, script with Browse…, races, event number, decimals, MID
  override).
- **Inputs**: the RR12 ports (edited in place, the connections on each, RR12's clock offset) and the RR12 exporter
  setup to copy (the address and port, the LapTime Export Data expression with Copy, TCP/IP, CRLF, Min. Seconds
  Between 0).
  **Settings**: tag filter, names file (a card, no form: the file, its athletes and when they loaded, Choose… and
  Clear, the .ppl files of FinishLynx's folder, 9.20), merged .lif files, control panel (port, LAN viewing). **Help**: contents on the
  left; the race-day checklist, Review, the status words, the status lights, good to know, if something goes wrong.
- Forms save on an explicit Save with a visible "Saved". Destructive actions confirm, one confirm at a time: the
  trigger is unavailable while its dialog or request runs (a second click does nothing), the item is checked before
  the dialog opens and again before the action, and a dialog whose item goes meanwhile (another window) closes as a
  Cancel and says so. Toasts at the bottom centre.
- Keyboard and screen-reader friendly (labels, focus rings, focus kept clear of the sticky bar), readable at 1366×768
  and usable from 1920 px down to a 390 px phone. Times shown as `5:12.3`-style race times and `10:00:00.000` times of
  day.

## 9. Revision 2 (2026-10-18) — retroactive engine, per-output delivery, verification fixes

This section OVERRIDES §4.5 and parts of §4.7/§6 where they differ. Why: independent verification (TrackScore's real
ingestion code, 10 real FinishLynx .lif files, a 600-runner race-day simulation, code reviews, a UI walkthrough) found
that normal traffic is handled correctly, but fixing a setting mid-race (mapping a timing point late, correcting a gun,
narrowing a race's contests) was not applied to reads already received; finished runners could be sent split packets
(TrackScore then overwrites their finish place); and packets queued for an output that was down were lost on restart.

Revision 7 (9.15) adds LapTime mode: RR12 sends FinishLynx LapTime lines (a bib and a time of day) to one port per
race; passes are counted into the race's splits. Where 9.2 says "contest", read "routing key" (a contest, a race's
port or its event: 9.15 L3); "takes every contest" means no contest list and no port. Revision 8 (9.16) makes the
resend texts honest about the TrackScore cells a Resend can't empty, the feed follow delivery, and fixes the gun box
under the sticky top bar, the two-port "not connected" warning, the .lif "waiting" words and the clock offset.
Revision 9 (9.17) adds the review tools: a split can be paused and played; a column check holds counted passes that
clearly belong to another split until the operator moves or keeps them; missing splits are listed with an estimate
the operator can send as a made-up time; finishers' splits go out with their FinishLynx finish place. Revision 10
(9.18) makes a late real read replace only the made-up time of its own split, holds most missed-first-mat passes
before they go out, lists a finisher's split that went out with an old time for "Send with finish place", and has
Play (and the Review's sends) read FinishLynx's folder first.

### 9.1 Read journal (durable, sync)
- Every read that parses is appended to `data/reads.jsonl` SYNCHRONOUSLY (fs.appendFileSync) before anything is done
  with it: `{"t":"read","seq":N,"at":<wall ms>,"conn":..,"location":..,"bib":..,"tod":..,"contest":..,"first":..,
  "last":..,"team":..,"gender":..,"raceId":<assigned race or null>}` (revision 6: a read with no race also has
  `"aside":0|1`, whether it came while its contest was set aside, 9.2). seq increases forever (continues after restart).
- An exact repeat (same matchKey(location), bib and tod) is NOT appended; its feed status is 'duplicate'. Except when
  the earlier read was cleared (Clear race data): it is journaled and counts again as a new read (2026-10-21, race day:
  "clear, then Replay in RR12" is how an operator rebuilds a race, e.g. after loading the names file). A deleted
  race's reads still stay out of use.
- The reads of one TCP chunk (at most 500 at a time) are journaled with ONE synchronous write (`appendJournalMany`)
  before any of them is used (revision 3): a 40,000-line Replay is ~80 writes, not 40,000.
- Route changes are appended as `{"t":"route","seq":N,"raceId":..}`; clears as `{"t":"clear","raceId":..,"seq":N}`
  (revision 5: the reads that race holds at that point, with seq <= N, are cleared one by one); deletes as
  `{"t":"delete","raceId":..,"raceName":..,"seq":N,"at":..}` (the reads that race holds are out of use; written for
  every race the operator deletes, so a set-aside reason can name it by its last name after a restart; revision 6:
  ONLY for an explicit delete, never for a race that is just gone from the settings, 9.2 R6); set-aside contests as
  `{"t":"aside","contest":..,"kind":"deleted"|"unlisted","raceId":..,"raceName":..,"reason":..,"at":..}` and
  `{"t":"unaside","contest":..,"at":..}` (9.2).
- On start the journal is replayed record by record, in order, to rebuild everything (no per-crossing state needs to be
  trusted from disk): each read's race, home and whether it is still used, every set-aside. Revision 6: the start's own
  settle journals 'route' records only. Nothing at start is ever journaled as a delete, an aside or an unaside: those
  are worked out again at every start from the journal and the settings found then (9.2).
- A torn last line (power loss) is skipped with a log line. Store API: `appendJournal(rec)` (sync), `loadJournal()`.
- A clean stop appends `{"t":"stop","at":..}` last, after the outputs are closed (`Engine.markCleanStop()`, called by
  main only when closing the outputs did not fail). A journal that does not end with it means a kill, a crash or a
  power cut; see 9.4 for what is delivered again.

### 9.2 Routing a read to a race (revision 5: plain rules; revision 6: R1 for new reads too, R6 missing races)
Why revision 5: revision 4 routed every read again on every change, including the reads of races that were not
Active, and let reads of deleted races live on. A re-check found the results hard to predict: setting an active race to
"every contest" moved its reads into a finished catch-all race (P1); deleting a race whose reads had come from a
finished catch-all put the contest's stragglers live into another catch-all (P2); a finished catch-all lost its reads,
and its .lif its splits, when a new race listed one of its contests (P3); reads that moved into a race cleared before
they came vanished without a word (P4); deleting yesterday's paused copy of a race sent its reads live into today's
race (P5); a set-aside reason named a race that no longer existed (P6). Revision 5 replaced the routing with rules an
operator can predict, and one pure planner (`planRoutes`) applies them, both to a change that is saved and to the
panel's "what will happen" dialogs.

Why revision 6: the re-check of revision 5 (rc8) found one contest's reads in up to three places at once (Q1, Q2): new
reads of a contest that only an inactive race listed arrived INTO that race, while its older reads stayed in an active
catch-all race or in no race. And a config.json put back from its backup at a start (Q3) made every race added since
"deleted": their reads were retired for good, journaled, and their contests set aside, although nobody had deleted
anything. Revision 6: an inactive race takes no read at all (R1), so such a contest waits in no race, in one place; and
only the operator's Delete retires reads (R2), a race gone any other way is missing (R6), and nothing a start works out
is journaled as a delete or a set-aside.

State. Each read has `raceId` (the race it is in now, or null; a missing race's id for a read that waits for it, R6),
`home` (the first race it was ever in; or "aside" for a read that came, or waited with no race, while its contest was
set aside: it counts as having had a race, so rule R4e does not hand it to the race that takes every contest) and `gone`
(0 in use, 1 cleared, 2 its race deleted). `setAside` maps a contest (matchKey) to `{ contest, byId, byName, deleted,
since, transient?, suppressed? }` (the last two: see the start, below). `held` maps a contest to the missing race it waits for (R6; in memory, worked out at every settings change
and at start). A read without a contest can't be listed or set aside: it always goes with the active race that takes
every contest (there is at most one), or has no race (or waits for a missing race that holds reads without a contest).

The rules.
- R1 Frozen inactive races. A race that is not Active keeps exactly the reads it has: re-routing never moves a read out
  of an inactive race and never moves a read into one, and no new read arrives into one (revision 6). A contest that
  only inactive races list (no active race does) is waiting: its reads that are not already frozen inside an inactive
  race wait in no race, status 'paused', detail "Its race 'X' is not Active. These reads are used when you tick
  Active." That holds for new reads, and for old reads in no race, set aside, or in an active race that takes every
  contest: they move out to no race (an explicit listing always beats "every contest"). When X is ticked Active, R4a
  moves all of them into X, so a race paused by mistake can be switched back on. Deactivating a race freezes it. A
  finished race that is switched off therefore keeps its reads and its merged .lif keeps its splits, whatever happens
  to other races, and the active catch-all race never holds reads of a contest that any race lists.
- R2 Delete = out of use. Only an explicit delete (DELETE /api/races/:id; `Engine.configChanged({ deleted: [id] })`)
  takes all the race's reads out of use for good (status 'race-deleted', detail "Its race 'X' was deleted, so this
  read is not used."), journaled as 'delete'. They are never routed again; the race file goes to data\races\deleted for
  recovery, and an exact replay of such a read is a duplicate. A contest (not blank) of those reads is set aside (R5),
  so that the reads of it still to come are not used either, when: new reads of it went to the deleted race (it was the
  active race that lists the contest, or the active race that takes every contest) or waited for it (it listed the
  contest and was not Active, or it was missing and held the contest); no race lists the contest now; no active race
  holds live reads of it; and no missing race holds it (R6). (When an active race holds reads of it, new reads go
  there, with them: deleting a finished race never takes reads away from a running one.) A missing race can be deleted
  too: that is how the operator lets its reads go.
- R3 Clear = out of use, per read. "Clear race data" marks the reads the race holds at that moment as cleared (status
  'cleared'). A cleared read stays out of use wherever it would move (it is never routed again), and an exact replay of
  it is a duplicate. Reads that join the race later, new or moved in, are not affected.
- R4 Active re-routing. On every settings change, and at start, the reads that are in an ACTIVE race or in no race (not
  deleted, not cleared, not waiting in a missing race) are routed again among the ACTIVE races only:
  a. an active race lists the read's contest explicitly (the config allows only one): that race;
     (else, races that are not Active list it: no race, 'paused', R1)
  b. else, the contest is set aside: no race ('set-aside');
     (else, the contest is held by a missing race: no race, 'race-missing', R6)
  c. else, the read is in an active race that takes every contest: it stays there;
  d. else, the read's home is an active race that takes every contest: back there (a contest added to a race by mistake
     and taken out again);
  e. else, the read never had a race: the active race that takes every contest, if any;
  f. else (a race took it out of its contest list, and it has nowhere to go): the contest is set aside, no race.
  Every contest that rule f lets go of is set aside before anything moves, so a contest's reads in active races and in
  no race all end up together: reads that also sit in a race that takes every contest come out with them.
  New reads: a., else no race when races that are not Active list the contest ('paused'), b., the hold (R6), then the
  active race that takes every contest, else no race.
- R5 Set aside. A contest is set aside by R2 or R4f, and stops being set aside as soon as any race lists it explicitly
  (journaled 'unaside'; its reads then follow R4: listed on an active race they are used there, listed only on races
  that are not Active they wait for them; at start in memory only, see below). Set-aside reads count for no race. The
  reason is worked out when it is shown, never stale: "its race 'X' was deleted" (R2), "'X' no longer lists it" (R4f, X still there, by its current
  name), "'X' was deleted" (X stopped listing it and was deleted later), "'X' isn't in the settings any more" (X stopped
  listing it and is missing now), "no race lists it any more" (rare: the race that let go of it is not known).
- R6 Missing races (revision 6). A race that the reads know but the settings lack, and that was not deleted (config.json
  fell back to config.json.bak, was reset, or was edited by hand), is missing, not deleted: its reads keep their raceId
  and wait for it in no race, status 'race-missing' (detail "Its race 'X' isn't in the settings (config.json was
  restored or edited). They come back if the race does."; the name from its race file, which keeps the race's
  settings, and without it when unknown); they are not routed elsewhere. Its race file stays in data\races. The race
  holds its contests (those of its reads, and of routable reads whose home it is), in memory, never journaled: a held
  contest that no race lists and that is not set aside waits too, its routable reads and its new reads alike, status
  'race-missing', instead of going into a catch-all; unless the active race that takes every contest already holds
  live reads of it and none of its reads would be let go (R4f): then they all go there together (rules c-e). A held
  contest is never set aside (by R2 or R4f): it waits for its race instead. If a race with that id comes back, its
  reads are in it again at once, and the ones that waited are routed by R4. The Live tab shows each missing race in red
  with its read count and how to put it back (restore config.json from data\config.json.bak, or the race from its
  file in data\races), and a Delete button (R2).

Invariant (checked by test (h) and the fuzzers after every step, revision 6): every non-deleted, non-cleared read of a
contest that is not frozen inside an inactive race (or waiting inside a missing race) is in one place: one active race,
or no race with one status. And that place is where a new read of the contest goes. Consequences: a race that is not
Active keeps exactly its reads and never gets a new one; nothing is lost silently: every read outside a race has a
visible status ('no-race', 'paused', 'set-aside', 'race-missing', 'race-deleted', 'cleared'), and every read in a race
that is not Active says 'paused' (or what it was before).

`Engine.#settle(prev, deletedIds)` applies the plan: 'delete' records (and the reads go out of use), 'unaside', 'aside'
(and the reads of the contest that never had a race get the home "aside"), then 'route' records, in one journal write.
At start (`prev` null) nothing is deleted and only the 'route' records are journaled, so a config.json put back from
its backup changes nothing for good:
- A contest that a start sets aside (R4f, because of the settings found then) is transient: in memory only, never
  journaled, and worked out again at every later change from the settings as they are then. It lasts while its cause
  lasts (a contest that rule f lets go of again stays transient), ends without a word when the cause ends, and a start
  with the same settings works out the same. Only a reason of the running change itself (an operator's delete, R2, or
  a contest that a change while running lets go of) journals a set-aside. Its reads keep their homes (no "aside" home
  is given for it, since no record could replay that).
- A journaled set-aside whose contest a start finds listed is suppressed: not in effect while a race lists the
  contest, without an 'unaside' record; in effect again (with its journaled reason) if the listing goes. A change made
  while running that lists a contest whose set-aside is in effect journals 'unaside' as before.
- Every read record with no race says whether the read came while its contest was set aside (`"aside":1`, else 0): its
  home ("aside") can then be replayed exactly although transient and suppressed set-asides are not in the journal (a
  journal from before revision 6 has no such field: the set-asides replayed so far decide, as before).
The replay applies the records in the same order with the same effects, so the start's settle with unchanged settings
then changes nothing. The planner works on groups of reads with the same race, home and contest (the rules give a group
one answer), so a change costs one pass over the reads.

The panel (9.7). `State.setAside = [{ contest, reason, raceName, raceId, since, count }]`: count = its set-aside reads
(a deleted race's own reads are not among them: they are out of use for good); raceId = the race the panel's button
opens (the one that stopped listing the contest, while it exists), null when a new race is the way to use the contest
again. `State.missingRaces = [{ raceId, raceName, count, contests, file }]` (R6; file = `races\<file name>`).
`State.noRace = [{ contest, blank, status, count, raceId, raceName }]`: the live reads in no race now, per contest and
why ('paused' with the race they wait for, 'set-aside', 'race-missing' with the missing race, 'no-race'), including a
missing race's own reads: the panel's counts are what waits now, not what was ever read. `POST /api/races/preview`
(body `{ id?, race?, delete? }`) returns `Engine.planChange(next, { deleted })`: the RoutePlan of the change, worked out
by `planRoutes` on the settings as they would be, without changing anything: `moves` (contest, count, from, to, where a
place is a race, or no race with a status: 'set-aside', 'no-race', or 'paused' / 'race-missing' with `raceName` and
`waitsFor`, the race they wait for), `deleted` (per race, per contest), `setAside`, `usedAgain`, `kept` (reads that stay
in a race that is not Active while new reads of their contest go elsewhere) and `newReads` (contests whose new reads
go somewhere else). The panel turns it into the dialogs, before a race is saved (new or changed, when anything that
runs changes) and before a race is deleted (always): "3 reads of 'JV' move from Open 5K to this race.", "Open 5K is not
Active, so it keeps its 2 reads of 'JV'.", "Its 4 reads are no longer used. New reads of 'JV' won't be used either
until you list the contest on an Active race.", "2 reads of 'JV' leave Open 5K and wait for this race, which is not
Active: they are used when you tick Active." Live-tab warnings: per set-aside contest ("Reads of 'Girls Varsity' are
not used: its race 'Girls 5K' was deleted. List the contest on an Active race to use them."), per missing race (red), per
inactive race that recent reads wait for, and for contests no race takes ("doesn't belong to any race", counting the
reads in no race now, never the ones an inactive race keeps). Feed status words: "Set aside (not used)", "Race deleted
(not used)", "Cleared (not used)", "Race paused", "Race missing (not used)".

### 9.3 Derivation (pure, from the journal + current config), per race
Inputs: the race's assigned reads that are still used (not cleared, 9.2 R3), its splits/finishSources/gun, tagWindowSec, and
`finishers(raceId)` (Map bib -> finish race ticks from the matching FinishLynx .lif, see 9.6).
1. location -> split by the CURRENT mapping; finish source -> finish read; else unmapped (counted per location).
   Mapping a timing point later therefore turns its earlier reads into crossings.
2. gun null -> the read counts as waiting-gun. race ticks < 0 -> before-gun (excluded). Moving the gun later removes
   crossings that are now before it; moving it earlier brings them back.
   Revision 3, the start area: race ticks >= 0 and < `filter.startIgnoreSec` (default 60, 0 = off, 0-1800) ->
   'start-area' (excluded), for split AND finish sources. Courses that start over the finish mats read every runner
   there seconds after the gun; such a read must not finish the runner (wiping their splits) nor open a later split's
   crossing (dropping the real earlier splits as out of order). The setting is part of the derivation signature, so
   changing it re-derives every race. Feed detail: "Too soon after the gun — ignored (start area). Change 'Ignore
   reads in the first N s' in Settings if this is a real split."
3. Group by (bib, split id); sort by (tod, seq); the first read opens a crossing; reads with tod - openTod <= tagWindow
   join it ('backup'); later ones are 'repeat' (ignored). Crossing time = its earliest read.
4. Finish time of a bib = min(earliest finish read after the gun, Lynx finish). A crossing at or after the finish time
   is dropped ('after-finish'). Then, per bib, walk splits from LAST to FIRST keeping a running minimum: a crossing
   whose time is not below the running minimum of the later splits is dropped ('out-of-order', e.g. walking over the
   1K mat after finishing).
5. Place at a split = rank of the kept crossings by (tod, first seq). LS = CS - CS of the nearest earlier kept split.
6. raceData() (for .lif) = the kept crossings; it returns null while the gun is not set (LifSync then leaves that
   race's merged file alone instead of writing it without splits).
Derivation may be incremental for speed, but must equal a full rebuild. Revision 3: it is incremental per (bib, split):
a new read is classified (step 1-2); a read that cannot count changes nothing else; a split read is inserted into that
split's sorted reads (the crossing is rebuilt only when it is the new earliest), a finish read into the finish reads;
then step 4 is applied to the runner (a few splits) and only splits whose kept crossing changed are re-ranked. A
read's outcome lives on the read record (`o`, written by the runner state `od`), the race keeps the counts of the
outcomes the race view shows. A randomized test checks that the read-by-read result equals a rebuild.

### 9.4 Delivery: per-output ledger and convergence
- Each output has its own ledger per race: key `bib|splitId` -> `{ tod, place, gun, firstAt, at }` = what that output
  was last given and acknowledged. Persisted in `data/races/<raceId>.json` (with clearedSeq, and since revision 6 the
  race's settings as `race`, saved whenever they change: a race missing from config.json can be put back from there,
  and the panel names a missing race by it, 9.2 R6). The file of a missing race is kept; only a deleted race's file
  goes to `data/races/deleted`.
- In-flight packets (handed over, not yet acknowledged) are tracked so the same content is never queued twice.
- `#converge()` runs after every read, config change, gun change, finishers change, and output status change
  (script loaded/fixed, connected, races filter changed); a timer wakes it when the next hold expires.
  For each ACTIVE race, each ENABLED output that takes the race (`races` [] = all), each kept crossing:
  - not in that output's ledger -> 'new' when its hold is over (now - first arrival >= holdSec, or the clock went
    backwards) and the bib has NOT finished. A finished bib's crossing is not sent live (feed 'finished-not-sent';
    it is in the merged .lif).
  - in the ledger with a different tod/gun -> 'correction'; with a different place -> 'place-update'. Sent only when the
    output first got this crossing < 60 s ago and the bib has not finished. Otherwise it is STALE.
  - in the ledger but no longer kept (gun moved, mapping changed, out-of-order) -> STALE (it can't be unsent).
  Ready packets go out in course order then time order.
- Resend (operator): `resendRace(raceId, { includeFinished = false, force = false })` sends every kept crossing to
  every output that takes the race (finished bibs skipped unless includeFinished), updates the ledgers, clears stale.
  Refused for an inactive race unless force (a race TrackScore isn't showing makes it switch and wipe its live race).
  Returns `{ sent, skippedFinished, outputs }`.
- Clear race: the reads the race holds now are marked cleared (9.2 R3; the race file keeps the journal position as
  clearedSeq); its ledgers emptied. A settings change never brings the cleared reads back in another race; RR12 sending
  them again (Replay) does, as new reads (9.1, changed 2026-10-21). Reads that come to the race later count as usual.
- A packet the output could not take (disabled, script broken, queue full, stopped before delivery) is simply not in
  the ledger, so it is delivered by a later convergence (after a restart, a script fix, a reconnect).
- An acknowledgement means this PC's network stack took the bytes. A killed process loses what the stack still held
  (measured: 228 of 600 packets to a slow target on loopback); a clean close still delivers it. So on a start whose
  journal does not end with a clean stop (9.1), ledger entries acknowledged within 60 s of the newest acknowledgement
  are dropped 15 s after start() and delivered again by convergence. The 15 s let RR12's queued reads (finish reads of
  runners who finished during the outage) and FinishLynx's finishers arrive first, because a finished runner still
  gets nothing. An entry replaced by a newer acknowledgement meanwhile is kept; a stop before the 15 s drops them
  unsent, so the next start sends them. A repeated split changes nothing in TrackScore. `behind`/`lagSec` (9.5) cannot
  see bytes the stack has taken: plain Node has no way to ask.

### 9.5 OutputManager changes
- `deliver(outputId, packet, ack)` replaces `send(packet)`: returns false at once if the output can't take it now
  (disabled, script missing/broken); otherwise queues/sends and later calls `ack(true)` when the bytes were accepted
  by the socket (tcp-client write callback OK; udp send OK; tcp-server written to >= 1 client; with no client
  connected, ack(false)), or `ack(false)` when dropped (queue overflow, stop, disable, connection type change).
- Status adds `behind` (packets accepted but not yet written: queue + socket writableLength in packets) and `lagSec`
  (age of the oldest unacknowledged packet); the pill turns amber when lagSec > 5.
- tcp-client backpressure: at most 8 KB is written to the socket and not yet called back; the rest waits in the link's
  queue (in order, counted in `queued` and `behind`) and is checked with `isCurrent()` just before it is written, so a
  slow output does not get a backlog it can no longer hold back (a runner who finished while it waited).
- For an unknown gender the LICENCE line is left out (lss `skipEmpty: [0x0b]`), so TrackScore keeps FinishLynx's
  gender. lss JSON safety also removes a comma left before `}` or `]` outside strings.
- Names that came from the RR12 stream have typographic punctuation folded to ASCII (’‘ to ', “” to ", –— to -,
  … to ..., NBSP to space) before use; names from the people file are sent exactly as written.
- 'status' emits on connect/script changes so main can call engine.converge().
- Revision 3, tcp-client redelivery: an acknowledgement only means this PC's stack took the bytes. A TrackScore that
  stopped reading and was then reset (or a network drop) loses what sat in the buffers. Each tcp-client link keeps the
  packets its socket took in the last 60 s (`redeliverMs`); when a connection that was up drops, or the operator
  presses Reconnect, those go out again first on the next connect, merged with the queue in their original order. Each
  is checked with `isCurrent()` before it is written (a finished runner or a replaced packet is skipped), and none is
  acknowledged to the engine again. A repeated split changes nothing in TrackScore (same place, same time).

### 9.6 Finishers from FinishLynx
LifSync exposes `lynxFinishers(raceId)` -> Map bib -> finish race ticks (rows of the matching FinishLynx .lif with a
numeric place and a field-6 time) and emits 'finishers' (raceId) when that set changes. With merged .lif enabled the
relay therefore knows who has finished even without a finish timing point.

### 9.7 Views / State additions
RaceView adds: `waitingGun` (= pending), `beforeGun`, `startArea` (revision 3), `afterFinish`, `outOfOrder`, `repeats`, `finishedNotSent`,
`finished` (finish reads plus Lynx finishers), `contestsSeen: [{ name, count, blank }]` (contests of the reads
assigned to the race; revision 4's `backTo` is replaced by POST /api/races/preview, 9.2), `stale: { count, byOutput: [{ outputId, name, count }] }`,
`resendSuggested` (= stale.count > 0, server-driven),
`lynxName` (event name in the matching FinishLynx .lif header, or null). State.input adds `clockLagSec` (revision 8,
9.16 F6: the 10th percentile of arrival local time-of-day - read tod over the last 200 reads that did not come in a
burst; normally about 1.5 s). OutputStatus adds `behind`,
`lagSec`. SSE 'state' events no longer carry `feed` (GET /api/state still does); the panel keeps the feed from 'feed'
events. FeedEntry is updated IN PLACE (same id, re-emitted) whenever its read's outcome changes (waiting-gun to sent,
sent to corrected, ...), including raceTicks and place. New statuses: 'after-finish', 'out-of-order',
'finished-not-sent', in revision 3 'start-area' (muted, a "filtered" read hidden unless "Show filtered reads"), in
revision 4 'set-aside' (a warning, "Set aside (not used)"), and in revision 5 'race-deleted' ("Race deleted (not used)")
and 'cleared' ("Cleared (not used)"), both muted but shown, so no read goes missing without a word. A cleared read's
row keeps its race (raceId); a read whose race was deleted has none. State adds `setAside` (revision 4, 9.2).
Revision 6: 'race-missing' ("Race missing (not used)", red: shown, never filtered) for a read that waits for a missing
race (R6); 'paused' also for a read in no race that waits for a race that is not Active (C1: raceId null, raceName the
race it waits for). State adds `missingRaces` and `noRace` (9.2).

### 9.8 API and config changes
- `POST /api/races/:id/resend` body `{ includeFinished?, force? }` -> `{ sent, skippedFinished, outputs }`; 409 with a
  plain-English message for an inactive race without force.
- Revision 5: `POST /api/races/preview` body `{ id?, race?: Partial<Race>, delete?: true }` (no id = a new race) ->
  `RoutePlan & { raceId }` (9.2): what saving or deleting the race would do to the reads so far. The race is checked as
  the save would check it (400 with the same message); an unknown id is a 404. Nothing changes.
- Revision 6: `DELETE /api/races/:id` is the only thing that takes reads out of use; main.js passes the id on as
  `Engine.configChanged({ deleted: [id] })` (and `planChange(next, { deleted: [id] })` for the preview). A race left out of
  the settings without being named there is missing (9.2 R6). The id of a missing race is accepted by both (the
  settings do not change; its reads are retired and its race file goes to races\deleted); any other unknown id is a 404.
- Config validation: two races with the same non-empty event number + round + heat are refused ("both use Event 3-1-1:
  TrackScore and the .lif files can't tell them apart"). Paths must be drive-absolute (`C:\...`) or UNC
  (`\\server\share`); root-relative paths (`\foo`) are refused ("a network path starts with two backslashes").
  LifSync creates only the last folder level of the output folder (the parent must exist) and refuses an output
  folder that is the same folder as the input (or inside it) by identity (dev+ino), not just by path text.
- Host check: localhost, *.localhost, IP literals, the bare computer name, or computer name + the PC's own DNS suffix.
- `--port` stays a one-run override even when the Control panel card is saved.

### 9.9 Input changes
- Quiet-flush of an unterminated line only on a connection that has never delivered a terminated line (true "Line end:
  none"); on close, an unterminated tail on a CRLF connection is dropped with a log line.
- A tagged line must have exactly `columns.length` fields after the tag; a short line is a truncation ('bad-line':
  "Expected 8 fields separated by |, got 2: check the Export Data expression"). A too-long line that contains the tag
  again at a field boundary is split into records (glued lines); otherwise the error mentions RR12's Line end setting.

### 9.10 .lif fixes
- Splits are rounded to the printed precision (thousandths, round up) before legs and the average lap are computed, so
  legs equal the differences of the printed cumulatives, as FinishLynx writes them.
- mergeLif drops a split slot that is not below the row's FinishLynx finish time or not above the previous non-empty
  slot.
- writtenAt is set from the file's mtime when the file on disk is already up to date (after a restart).
- Status reports, per matched race, the FinishLynx header name (for the "type the name exactly as FinishLynx" warning).

### 9.11 Revision 3 (2026-10-18) — start area, cleared and freed reads, redelivery, performance
The behaviour changes are written into 9.1-9.7 above (start area 9.3, cleared reads 9.1/9.4, freed reads 9.2 (replaced
by revision 4, 9.12), tcp-client redelivery 9.5). Settings: `filter.startIgnoreSec` (Tag filter card, "Ignore reads in
the first … s after the gun").

Performance (an RR12 Replay of a whole meet, 40,000 lines in one burst, while a race runs; measured with
perf_hooks.monitorEventLoopDelay and --cpu-prof):
- main.js hands the reads of one TCP chunk to `Engine.handleReads(items)` together (a microtask after the chunk's
  'line' events, at most 500 at a time so a batch's objects die young); `handleRead` is `handleReads([one])`. Exact
  duplicates cost a lookup and a feed entry: no journal, no derivation, no delivery. Delivery, feed refreshes and
  'race' events run once per batch.
- The journal is written from one reusable buffer, and SSE batches in ~32 KB pieces: a burst makes no strings big
  enough for the heap's large-object space, which only a full collection frees.
- The engine keeps feed entries plain objects (the read behind an entry is in a WeakMap), and per-race feed texts
  ("… is not active …") are made once per race.
- InputServer pauses a connection once an event-loop turn has spent 40 ms on reads (`sliceMs`) and resumes it on the
  next turn, so hold timers, outputs and the panel keep running during a burst; the rest waits in the socket, in order.
- The daily log is written once per event-loop turn (or every 64 KB), not once per line.
- SSE 'feed' events are batched (end of the turn, at most every 200 ms while reads keep coming); an entry updated twice
  goes once; of a flood only the newest 600 go (what the panel keeps).
- RaceView never walks the reads (outcome counts are kept per race); the stale count compares fields before building
  signatures; the engine's feed is a ring; read records are single literals with interned strings (a long string is
  copied so it never pins the 64 KB chunk it was cut from); input format normalisation is cached per format object.

### 9.12 Revision 4 (2026-10-18) — set-aside contests
Routing (9.2) is one rule for a contest's old and new reads. A contest whose race was deleted, or that its race stopped
listing, after reads of it came in is set aside: none of its reads is used, the new ones included, until a race lists
it; a race that takes every contest does not take them. Reads that a race took from a catch-all race and lets go of
again go back there. Engine API: `setAside()` (for State.setAside); journal records 'aside' and 'unaside'; feed status
'set-aside'. Panel: a Live-tab warning per set-aside contest. (Revision 5 replaced the routing rules, the delete and
contest dialogs and RaceView `contestsSeen[].backTo`: 9.2, 9.13.)

### 9.13 Revision 5 (2026-10-18) — a simpler, predictable routing model (superseded in part by 9.14)
The rules are in 9.2 (R1-R5): a race that is not Active keeps exactly its reads; deleting a race or clearing its data
takes its reads out of use for good, read by read; only the reads in active races and in no race are routed again,
among the active races; a contest is set aside by a delete or by being taken off a list with nowhere to go, until a
race lists it. Engine API: `planChange(nextConfig)` -> RoutePlan (the panel's dialogs, through POST
/api/races/preview); reads carry `gone`; journal record 'delete', per-read 'clear' semantics, 'aside' records carry
`kind`. Statuses 'race-deleted' and 'cleared'. A journal from revision 4 is read as it was written: its clears now
clear the reads the race held at that point (reads that moved in later count, which fixes P4), its deleted races' reads
that already had no race stay set aside (they were not marked deleted then). Tests: engine (a)-(h), where (h) checks
every read, the set-aside list, the plan of every change (moves, deleted, set-asides, new reads, kept) and the
consequences against the rules written out plainly, with restarts mid-run, a rebuild and a restart at the end;
mutation-tested (each rule broken in turn makes it fail); regression tests P1-P6; panel texts built from real plans;
one run through the app.

### 9.14 Revision 6 (2026-10-18) — one place per contest, and missing races are not deleted
The rules are in 9.2. C1: a race that is not Active takes no read, old or new; a contest that only such races list
waits for them in no race ('paused'), out of the race that takes every contest too, until one is ticked Active. C2:
only DELETE /api/races/:id retires reads ('delete' record); a race the reads know but the settings lack is missing
(R6): its reads wait for it ('race-missing'), its contests are held (in memory) so their stragglers wait too instead of
going into a catch-all, its race file is kept (it now carries the race's settings), and everything returns when a race
with that id is back. Nothing at start is journaled as a delete, an aside or an unaside: a set-aside a start works out
is transient (worked out again at every change, never journaled), a journaled one it finds listed is suppressed, and a
read in no race journals `aside` so its home replays exactly. The panel: a red Live-tab warning per missing race (read
count, how to restore it, a Delete button), a warning per inactive race that recent reads wait for, current counts
(State.noRace) in the contest picker and the "doesn't belong to any race" warning, and the Races list, status words,
Help and README say that it takes an ACTIVE race listing a contest to use its reads. Engine API:
`configChanged({ deleted })`, `planChange(next, { deleted })`, `missingRaces()`, `noRace()`; RoutePlan places 'paused' /
'race-missing' with `raceName` and `waitsFor`. Tests: (h)'s model is revision 6's rules and checks the invariant of 9.2
always (no more skip for contests that waited inside an inactive race), with races lost, put back and deleted while
missing at run time, and starts with a race missing and other settings changed; regression tests Q1-Q3 (rc8), R6 and
C2; panel texts from real engine states; two runs through the app (config.json falling back to its backup, and a race
taken out by hand, then deleted). Mutation-tested: each of 33 breaks of the new rules (and of main.js's delete) makes
the tests fail; the randomized fuzzers find most of them on their own.

### 9.15 Revision 7 (2026-10-18) — LapTime mode
Why: the operator sends ONE format from Race Result 12, the FinishLynx LapTime line that RR12's own FinishLynx
exporter already uses: `chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]`, i.e. the bytes
`\x01S,15:17:44.215,254\r\n`: a bib and a time of day, nothing else (no timing point name, no contest, no names). The
relay's exporter sends the SPLIT timing points only (the A and B mats); the finish goes to FinishLynx only. When races
overlap, a second exporter (filtered in RR12 to that race) sends to another port. TrackScore and Karmarush put a split
in the column "number of splits - laps to go", so the operator sets the number of splits, and laps to go 0 (= finished)
must never go out. The SR|... line (timing point names, contests, names) stays, as an advanced option.

L1 Input (`src/input.js`). `parseLine` tells the shape from each line, with no setting:
- FinishLynx LapTime: `<sot>S,<time>,<id>[,event,round,heat]<eot>`, sot \x01 or \x02 or none, eot CR/LF/CRLF (the input
  server splits on them; trailing control bytes are stripped). A read: `{ location: '', bib: id, tod, contest: '', first:
  '', last: '', team: '', gender: '', event }`, `event` = `eventKey(event, round, heat)` ('3-1-1', leading zeros dropped,
  round and heat default 1) or ''. Field 2 may also be decimal seconds (raw [RD_Time]); a trailing comma is ignored.
- Opcodes Z and T are FinishLynx commands: `{ ok: false, kind: 'ignored', format: 'laptime', message }`, logged to the
  daily log, nothing else. Any other letter, a missing time or bib, bib 0, an unreadable time, more than 6 fields or a
  control byte inside: `kind: 'error'` with a plain message ('bad-line' in the feed), e.g. "Can't read the time "x" in
  this FinishLynx LapTime line — expected a time of day like 15:17:44.215. In RR12 use format([RD_Time];"hh:mm:ss.kkk")".
- Without a start byte, "S,..." is LapTime unless the SR settings make it an SR line: the SR tag is that letter with a
  comma delimiter, the line holds the SR separator (when that is not a digit, space, ':', '.' or ','), or (comma
  delimiter) the field count is the SR column count, or field 2 is not a time.
- Every result says `format: 'laptime'|'sr'|'json'` (not for 'empty'). The SR|... and [RD_RecordJSON] lines work as before.
- Glued records: a later SOH/STX starts a new record. `splitFramed(line)` cuts them; `InputServer` also cuts what waits
  for its line end before the last SOH/STX at once (RR12 "Line end: none" may never leave the 300 ms quiet gap during a
  start), and the record after it waits for its line end (or the quiet flush on a connection without line ends).
- `LAPTIME_EXPRESSION` is exported for the panel. `LAPTIME_MESSAGE` (the old "has no timing point name" error) is gone.

L2 Input ports. `config.input.ports: number[]` (default `[5565]`; a settings file with the old `input.port` becomes
`[port]`; `port` is no longer stored, and State.config.input.port is only a read-only copy of the first port for a
panel from before revision 7; at most 10). Validation (PUT /api/settings): at least one, each a whole number
1024-65535, distinct, not the panel port, not the port of an enabled tcp-server output; a port that feeds an Active race
can't be removed ("Port 5566 feeds the active race 'Boys 5K'. Give that race another port, or untick its Active, before
you remove the port."). A legacy `{ input: { port } }` patch replaces the first port. main.js runs one `InputServer` per
port (`#syncInputs`: added ports start, removed ones stop, the others keep their connections), with one connection-id
counter for all of them. Each read remembers the configured port it came in on (`meta.port` -> `rec.port`, journaled).
Test override: `startApp({ inputPort })` makes the first port listen there and the others on a free port;
`app.inputPortOf(configuredPort)` tells where each really listens.

L3 Race <- port. `race.inputPort: number|null`: the input port whose reads it takes; null = none (by contest only, how
every race from before revision 7 is read); POST /api/races gives a new race the first input port unless the body says
otherwise (an unusable value is refused: "Choose the RR12 input port this race takes its reads from (one of the ports in
Settings), or none."). The routing key of a read (engine `rec.contestKey`) is its contest when the line carried one,
else `event` when it carried FinishLynx's event fields, else its port, else '' (a read with neither, e.g. from an older
journal or a test). Port and event keys are `'\x01port 5565'` / `'\x01event 3-1-1'` (`portKey`, `eventRouteKey`,
`routeKeyInfo(key) -> { via, port, event, label }`); cleanRead strips control characters from contests, so they never
collide. A race lists its explicit contests plus, implicitly, `port:<inputPort>` and `event:<its EN-R-H>`, and R1-R6
(9.2) apply unchanged to these keys. "Takes every contest" (the race R4c-e and new reads fall back to) is now: no
explicit contest AND no port. Consequences: two LapTime races on two ports are no clash; a race with a port takes that
port's keyless reads and its listed contests, not every contest.
- Only one ACTIVE race per port: config validation refuses it with "Port 5565 already feeds the active race 'Girls 5K'.
  Untick Active on one of them, or give this race its own port." (`raceClashes(a, b)` -> 'every' | 'port' | 'contest' |
  'event'; the same event is refused for any two races as before, and an older settings file that has two races on one
  event can rename or pause them, but not make the second one Active: "... both use Event 3-1-1: only one of them can
  be Active ..."). A race made Active, or given a port, must have a
  port that is one of the input ports ("Port 5599 is not one of the RR12 input ports (5565, 5566). ..."); a race that
  is not Active may keep a removed port.
- `POST /api/races/:id/activate` -> State plus `unticked: [{ raceId, raceName, why }]` (why: "both take port 5565",
  "both list contest 'Girls'", "both take every contest", "both use Event 3-1-1"): ticks Active and unticks the Active
  races that clash, so the panel can offer a one-click "Switch to Boys 5K". The unticked race keeps its reads (R1).
  `POST /api/races/preview { id, activate: true }` -> the RoutePlan of that switch plus `unticked`.
- A port is reused by races one after the other: switch races with Activate (the old race is frozen with its reads,
  R1). Deleting a LapTime race, or giving it another port, lets its port key go like a contest (R2, R4f): the reads that
  come on that port afterwards are set aside, and they go to the next race that takes the port (R5). Runners of the old
  race still on the course when the switch is made count in the new race: overlapping races need a second exporter and
  port (filter the first exporter to its race too).
- Every panel list with a contest in it names a port's or event's reads "Port 5565" / "Event 3-1-1" in `contest` and adds
  `via: 'port', port` or `via: 'event', event` (no `via` = a contest, or blank): State.noRace, State.setAside (which also
  gets `text`, the warning in words: "Reads from port 5565 are not used: its race 'Girls 5K' was deleted. Choose port
  5565 on an Active race to use them."), State.missingRaces[].contests, RaceView.contestsSeen, RoutePlan moves, kept,
  newReads, deleted[].contests and setAside. A race's own port and event are in a plan's newReads only once reads came
  by them. seen().contests lists real contests only. Feed detail for a port nobody takes: "No active race takes the
  reads from port 5567. Choose port 5567 on the race (Races tab), and tick Active."

L4 Pass counting (engine, 9.3 step 1b). A read with no location (`locKey === ''`) is a pass. Per (race, bib) the counted
passes (after the gun, after the start area, not deleted or cleared) are sorted by (race time, seq) and clustered with
`tagWindowSec`: a pass within the window of the cluster's first pass joins it (the A and B mats; the cluster's time is
its earliest pass). Clusters fill splits 1..N in time order. `split.earliest` (race time text, "8:00"; '' = none):
before a cluster takes the next split j, it skips ahead to the highest split k >= j whose earliest is set and <= the
cluster's time (a missed earlier split does not shift later ones); a cluster earlier than split j's own earliest is
'too-early' (ignored; j stays). Clusters after split N are 'extra' ("More passes than this race has splits — ignored
(Girls 5K has 3 splits; a split after the last one would mean "finished" to TrackScore)."), never sent. The reads of an
assigned cluster join split k's group like reads mapped by timing point, so the opener/backup/repeat outcomes, the
finish (finish reads, FinishLynx finishers: 'after-finish') and course order ('out-of-order') apply unchanged. Reads
WITH a location keep source mapping; a runner may have both. Incremental derivation: a new pass re-derives its runner
(#rederiveBib: a pass that arrives late can move every later pass to another split); located reads stay incremental;
the result equals a rebuild (randomized test). New feed statuses 'too-early' ("Earlier than the earliest time of Split 1
(2:00), so it can't be the Split 1 pass — ignored. Change the earliest time on the race (Advanced) if it is wrong.") and
'extra'. RaceView adds `tooEarly`, `extra` (outcome counts), `passes` (reads with no timing point name), and passes are
never in `unmapped`. Config validation of `earliest`: a race time >= 0 ("The earliest time of 1K, "8:0x", is not a race
time. Type it like 8:00 (minutes:seconds), or leave it empty."), going up in course order among the splits that have one
("The earliest time of 2K (8:00) is before the earliest time of 1K (9:00). Earliest times must go up in course order.").
The derivation signature includes the earliest times (changing one re-derives the race; it counts for old reads too).

L5 Number of splits. `race.splits` keeps its shape `{ id, name, sources, earliest }` (`earliest` '' by default); the
panel's "Number of splits [N]" (1-20) adds or removes rows named "Split 1".."Split N". L2G = N - splitIndex (N for split 1
... 1 for split N). RaceView adds `splitCount`, `inputPort` and `splits[].earliest`.

L6 L2G safety. `OutputManager.deliver` (and `send`) refuse a packet whose `lapsToGo` is not a whole number, < 1, or >
the packet's `splitCount` or its race's split count, or whose finish time (row \14\06) is not empty (`packetProblem`):
it returns false (never on the wire, never acknowledged, so never in the ledger), logs "ERROR refused a packet that must
never be sent: ...", counts it in `OutputStatus.refused`, and puts the reason first in `warnings`
(`OutputStatus.refusedReason`). The engine never builds such a packet; this is the last check before the wire. The
ledger (9.4) compares the split count too: an entry is `{ tod, place, gun, l2g, count, ... }`, its saved row gains index
8 (count; a race file from before revision 7 counts as sent with the race's current split count, and its waived
signatures get the count appended). Changing the number of splits or their order after packets went out re-sends them
as corrections while fresh (60 s) and marks older ones stale; RaceView.stale adds `reason: 'split-count'|'order'|'changed'
|null`, `splitCountFrom` (the split count most stale entries were sent with) and `hint`: "TrackScore and Karmarush put
splits in columns by laps to go; this race now has 3 splits instead of 2, so the splits already sent are in the wrong
columns. Resend this race's splits." (for a reorder: "...this race's splits were put in another order after they were
sent, so they are in the wrong columns. Resend this race's splits.").

L7/L8 (data for the panel). State adds `inputs: [{ port, boundPort, listening, error, connections: [{ id, remote,
connectedAt, lines, lastLineAt, dropped, port }], totalLines, lastLineAt, totalDropped, format: 'laptime'|'sr'|'json'|
null }]` (the configured ports in order; `format` = the shape of its last good or ignored line), `expressions: {
laptime, sr }`, and `namesNeeded` (no people file is chosen while LapTime lines came in: they carry no names). State.input
stays the aggregate: `{ listening (every port), port (the first one's real port), ports, listeningCount, error (the
first), connections (all), totalLines, lastLineAt, totalDropped, clockLagSec }`.

Routing-v6 leftovers (rc10):
- V1 At start, main.js runs `settleConflicts(config)` on the loaded settings: two ACTIVE races on the same port, a
  contest both list, the same event, or two that take every contest are never split silently: the first (settings'
  order) stays Active, the later ones are unticked and the settings saved. State.startConflicts = `[{ raceId,
  raceName, keptId, keptName, why, text }]` (red Live warning: "'Boys 5K' was switched off when Split Relay started: it
  and 'Girls 5K' both take port 5565, and only one Active race can take those reads. Its reads are kept. If 'Boys 5K'
  is the race that is running, switch to it (Races tab)."), shown while the race is not Active, until the operator
  saves, switches to or deletes one of the two. A missing race put back while running goes through the same check (V2).
- V2 Missing races: `ConfigFile.load()` returns `source: 'file'|'backup'|'new'|'empty'` and `brokenFile`; a start that
  fell back to config.json.bak (damaged or missing config.json) or found nothing usable never rewrites config.json.bak
  (it may be the only copy of the races the operator wants back); a config.json that is gone while its backup is there
  comes back from the backup. State.configRecovery = `{ source, fellBack, brokenFile, brokenFiles }` (the
  config.broken-*.json files, newest first). State.missingRaces[] adds `hasSettings` (its race file data\races\<id>.json
  keeps its settings). A race that goes missing has its due save written first, with its last settings (`lastRace`).
  `POST /api/races/:id/restore` ("Put it back") -> State plus `restored: { raceId, raceName, active, renamedFrom, why }`:
  the race comes back with its race file's settings (its id and split ids, so what the outputs have stays matched),
  checked as a start checks it: it comes back not Active (`why`) when it would want the reads of an Active race, when its
  port is not an input port any more ("its port 5567 is not an RR12 input port any more"), or when another race has its
  event; a name another race has meanwhile gets " (put back)". 404 for a race that is neither missing nor has a race file,
  409 for one already in the settings or whose file has no settings.
- V3 State.noRace has one entry per contest, status AND race: two missing races with reads of one contest each have
  their own count.
- V5 A race the operator deleted earlier that is back in the settings (config.json put back from its backup, or edited):
  State.deletedBack = `[{ raceId, raceName, deletedName, deletedAt, count, text }]` (count: its reads the delete took out
  of use, which stay out of use; red warning "'Boys 5K' was deleted at 10:32:05, but it is back in the settings
  (config.json was put back from its backup, or edited). The reads it had when it was deleted stay out of use; new reads
  count in it. Delete it again if it should be gone, or save it on the Races tab to keep it."). Saving the race (PUT) or
  switching to it keeps it: `Engine.keepRace(id)` journals `{"t":"undelete","raceId":..,"at":..}`.

Integration (the core and the panel put together, revision 7):
- FeedEntry adds `port` (the configured RR12 input port the line came in on, null without one), so with two exporters
  the feed says which one sent a read. State.missingRaces[] adds `inputPort` (the port in its race file's settings,
  null when none), so "Put it back" can say beforehand that it comes back not Active.
- `earliest` is minutes:seconds (`8:00`, `8:00.5`, `1:02:03`): a bare number is refused ("8" could be seconds or
  minutes), and each earliest time must be later than the one before it (the same time twice is refused too: a pass
  at that time would skip to the later split, so the earlier one could never be reached). The panel checks the same
  rules with the server's words.
- Number of splits: a change that sets a race's splits (POST, PUT, the panel) may set at most 20 (`MAX_SPLITS_SET`,
  the panel's 1-20); a settings file keeps up to 50, and an edit that leaves the splits alone is not refused. The
  panel allows at most 10 RR12 input ports, as the server does.
- The panel shows `State.expressions.laptime` (its own copy only for an older server). A set-aside port's or event's
  reads get an "Add a race for it" that makes a race on that port, or with that event, never a contest named
  "Port 5565"; the dialogs say how such reads are used again ("until you choose port 5565 on an Active race"). A new
  race's Active follows its port until the operator ticks or unticks it: on a port that already feeds an Active race
  it starts not Active, on a free port (an overlapping race's second exporter) Active.

Journal (9.1) additions: a read record has `port` (when it came in on a port) and `event` (a LapTime line's FinishLynx
event); 'aside' and 'unaside' records have `key` (the routing key; a port's or event's is not the contest's matchKey;
without it the replay uses matchKey(contest) as before); 'undelete' (V5). A journal from before revision 7 replays as it
was written: its reads have no port, so they route by contest exactly as before.

Engine API additions: `passesSeen()`, `deletedBack()`, `keepRace(id)`; exports `eventKey`, `portKey`,
`eventRouteKey`, `routeKeyInfo`; `asideText({ contest, reason, key })`. Config API additions: `inputPorts(config)`,
`takesEveryContest(race)`, `raceClashes(a, b)`, `settleConflicts(config)`, `activateRace(config, id)`, `restoreRace(config,
saved, id)`, `MAX_INPUT_PORTS`. Outputs: `packetProblem(packet, vars)`. Input: `LAPTIME_EXPRESSION`, `splitFramed(line)`,
InputServer option `connIds`.

Tests: input (LapTime parsing with \x01/\x02/none, Z/T, event fields, malformed lines; SOH-glued and partial lines
across chunks on a real socket; shared connection ids), config (ports, race ports, earliest, V1 settle, activate,
restore, the .bak never rewritten by a fallback start), engine (routing by contest/event/port and its replay; pass
counting with A/B within the window, late passes, missed mats with earliest skip-ahead, too-early, extra, after-finish;
never L2G 0 or > N, also a randomized run over random passes, earliest times and split counts that renders every packet
through XCScore.lss and checks "T":"" and 1 <= L2G <= N; the ledger stale on a split-count change and on a split added
in front (same laps to go, other column); incremental derivation equals a rebuild with passes, earliest times and timing
points mixed, and a restart; a randomized run of LapTime reads by port, event and contest under random valid race
edits (add, port change, Active, Switch, delete, lost and put back) checking one place per key and that a restart agrees;
V3; V5; a port's set-aside), outputs (L6 refusals), server (two ports, routing, detected
format, namesNeeded, activate and its preview), and one run through the app over four starts (two ports, laps to go on
the wire; a fallback start: the missing race put back, a deleted race back and kept, the .bak untouched; a hand-edited
config.json with two Active races on one port). Spot mutation check: 18 breaks (earliest skip, extra, "takes every
contest", the implicit port listing, the split count in the ledger (twice), V3's key, pass re-derivation, the journaled
port, the journaled set-aside key, the L6 guard, the .bak rule, V1's untick, SOH framing, main's port on reads, an event
twin made Active, a restored event twin) each make the tests fail; a longer run of the randomized routing check (500
seeds x 80 steps) found nothing after the event-twin rule was added (it had found the twin).

### 9.16 Revision 8 (2026-10-18) — what a Resend can't fix, a feed that follows delivery, five small fixes
Why: the round-8 verification ran two LapTime races through two real TrackScore programs (TS-A, TS-B) and the live
results. 28 of 29 checks passed. The one that did not: the boys race was set to 3 splits by mistake (TrackScore had 2),
fixed to 2 a minute later and resent, and TS-B still showed a split 1 time for bibs 507 and 519, who had missed the
first mat. TrackScore files a split in cell "totalSplits - L2G" and a packet can fill a cell but never empty one, so
no packet can take those times back; the texts said Resend fixes "the splits already sent". Five smaller findings came
with it (F2-F6).

F1 What a Resend can't correct (engine, panel, README).
- Every text that offers a resend says what it does and what it can't (`RESEND_LIMIT`, the same words in src/engine.js
  and public/app.js, checked by a test): "Resend corrects every split Split Relay has. A runner who has no split in a
  column under the new setting may still show an old time there in TrackScore and the live results until the race is
  cleared there." Used by RaceView.stale.hint (now also for reason 'changed': "The gun time, the splits or the places
  changed after the splits went out. Resend this race's splits. ..."), the race card's resend prompt, the "Give Boys
  5K 2 splits?" dialog (`columnsChangeText`), the Resend dialog, the race page's Resend help line, the Help tab and the
  README.
- RaceView adds `leftover: { count, runners, byOutput: [{ outputId, name, count }], text }`: the cells of the outputs
  that take the race (enabled, races filter) that got a time earlier and that no current split of the runner fills.
  A cell is (bib, column); a packet went to column "split count - laps to go", with the split count TrackScore has now
  (it is told to match the race's: the round-8 case) or, when it matched the race as the packet went out, the one it
  had then. Both are counted (the relay can't know which held), but only columns that exist now (0 <= column < N): a
  column past the race's last split is not shown as a split. A cell is filled when the runner has a kept crossing at
  that split index now. `count` = distinct cells over the outputs, `runners` sorted (numeric), `text` = "2 cells sent
  earlier can't be removed from TrackScore by Split Relay (runners: 507, 519). These runners have no split in those
  columns under the current settings, so TrackScore and the live results may still show an old time there until the
  race is cleared there." (12 runners, then "and N more"). None while the race has no gun time (nothing counts then).
  It covers both causes: a crossing that was delivered and no longer counts (the gun, the start area, an earliest
  time, a finish), and a column a packet went to that the runner has no split in under a new number of splits.
- What an output was given in cells no ledger entry stands for any more is kept as `orphans` per race and output
  (bib -> 'l2g|count'): an entry replaced by a packet for another column (#ack), or dropped because its crossing no
  longer counts (resendRace) or because it may never have left the PC (#releaseSuspects). Saved in the race file as
  `orphans: { [outputId]: [[bib, l2g, count], ...] }` (only when there are any), so a restart says the same; cleared
  with the race (Clear race data) and with a deleted output. Ledger entries carry their `bib`.
- The panel shows `leftover.text` in the resend prompt, in the Resend dialog, on the race page (Race data) and, once
  nothing is left to resend, on the race card with "Got it" (hidden until the count or the runners change). Nothing is
  ever done in TrackScore by the relay: the operator clears the race there if those cells matter.

F2 Scroll and focus targets under the sticky top bar (panel). The top bar is sticky at 720 x 560 and up and its height
varies (pills wrap, banners). app.js measures it (`syncStickyHeight`: ResizeObserver on the bar, window resize, and
before every programmatic scroll) into `--sticky-h` on <html> (0 when the bar is not sticky), and style.css sets
`html { scroll-padding-top: calc(var(--sticky-h) + 12px) }`, which every scrollIntoView, focus scroll, anchor and Tab
honours. The fixed `scroll-margin-top: 120px` of the Settings and Help cards is gone, and the sticky race list's `top`
uses the bar's height. "Set gun time" (#races/<id>/gun) reveals the whole gun card when it fits below the bar (the
label, the box and its "Set gun time" button), else the box itself, then focuses the box. Checked in the browser at
1024 x 768, 1366 x 768, 1440 x 900 and 375 x 812.

F3 The feed and the counts follow delivery (engine). A crossing is delivered when an output acknowledged it (a
ledger) or holds it to send (in flight). Its read's feed row says "Sent" (or Corrected, Backup) only then; a crossing
whose hold is over and that no output took is 'ready' ("Ready: not sent", warning tone): "Ready — no output took it:
<why>. It goes out by itself as soon as an output can take it." Why: "there are no outputs yet (add TrackScore on the
Outputs tab)", "every output is switched off (Outputs tab)", "no output that is switched on sends Girls 5K (Outputs
tab)", or per output from its last OutputStatus ("TrackScore's script can't be loaded (...)", "no program is
connected to X", its `refusal`, its `lastError`). OutputStatus adds `refusal` (why deliver() last turned a packet
away). RaceView.finishedNotSent counts the kept crossings of finished runners that are not delivered, and
CrossingView.sentAt / reason are null for one that is not. A packet an output took and later dropped (ack false)
turns the row back to 'ready' at once (a microtask: the drop comes outside a batch). The same before and after a
restart: the ledgers say what was delivered. main.js hands the engine the outputs' status once before start().

F4 With two or more RR12 ports, "RR12 isn't connected" names every port that has no connection, with the Active races
it feeds: "RR12 isn't connected on ports 5565 and 5566. In RR12, press play on the Split Relay exporters that send to
192.168.0.21:5565 (Girls 5K) and 192.168.0.21:5566 (Boys 5K)." Shown when no port has a connection, or when a port
with none feeds an Active race (a second port waiting for the next overlapping race is not a problem; the pill says it
waits). One port: the words as before (`rrNotConnected`).

F5 LifStatus adds `message`. 'waiting' (the FinishLynx folder is readable, nothing in it to use yet, no race to write
a file of its own) says "No FinishLynx .lif files in C:\Lynx\Meet yet. They appear when FinishLynx saves a race; a race
with splits and a gun time gets a merged file of its own before that." or "Waiting for FinishLynx to finish writing
003-1-01.lif in C:\Lynx\Meet." The pill says ".lif files · no FinishLynx files yet". A folder that is not there stays an
'error' with the wrong-path words ("FinishLynx folder not found: ... Check the path ...").

F6 The clock offset (Engine.clockLagSec) is the 10th percentile (linear) of (arrival local time of day - read time of
day) over the last 200 reads that did not arrive in a burst. A read can be late (a queue) but never early, so the low
end is the clocks' offset plus RR12's own 1.5 s. A burst: within any 1 s of arrivals, live reads' lags differ by a
second or two; when the lags of the reads of the last second differ by more than 5 s, RR12 is flushing its queue
(it was cut off, or Split Relay was down) and every read of that second is left out (a sliding window with monotonic
min/max queues, each read marked at most once: a 40,000-read flush costs nothing extra). Reads of the last second
count as soon as they arrive unless a burst marks them. A cold start into a flush of 344 old reads gives no offset at
all until live reads come; a PC clock 30 s off gives 31.5 s and the warning.

Tests: engine (the round-8 case: 3 splits fixed to 2, Resend, a TrackScore cell model of both kinds of TrackScore,
leftover before and after the resend and after a restart, cleared with the race; the start area raised; 'ready' with
each reason, finished-not-sent and crossings before and after a restart, a fixed script, a dropped packet; the
offset with a cold-start flush, a sliced flush, a wrong read, a clock 30 s ahead and behind), lif (the waiting words,
the writing words, a missing folder), panel (RESEND_LIMIT is the server's, the texts from a real engine state, the
dialogs, leftoverText, the 'ready' word, two-port warnings, the .lif pill, the scroll padding), server (a crossing no
output took is 'ready', sentAt null), e2e (a burst of old reads gives no offset, a live read gives about 2 s).

### 9.17 Revision 9 (2026-10-19) — Review tools: pause a split, check columns, made-up times
Why: the operator asked: "the program takes the splits on one stream from RR12, then it gets placed into its correct
split point column. I need to be able to pause and play a split. I need the ability to make up a fake split for
someone that missed at one of the points easily." With LapTime lines (9.15) a pass carries no timing point name, so a
runner whose chip a mat missed has every later pass counted one column early, and nothing on the wire says so. Chosen:
the relay FLAGS what looks wrong and the operator APPROVES before anything is sent; an approved made-up split goes to
the live outputs AND the merged .lif files. Pure functions in `src/review.js` (`columnCheck`, `estimateGaps`,
`moveText`, `fieldFractions`, `leaderTimes`, `CHECK_RULES`) do the field work; the engine feeds them its derived state.

P1 Pause and play a split.
- `split.sending` (boolean, default true; config.js normalises it, and a race edit that sends the splits back without
  it keeps what each split had, so editing names or earliest times never plays a paused split). `setSplitSending(config,
  raceId, splitId, on)` changes only that flag; `POST /api/races/:id/splits/:splitId/sending { on: boolean }` -> State
  (400 "Send { "on": true } to play the split, or { "on": false } to pause it.", 404 for an unknown race or split).
- A paused split's crossings are derived, ranked and shown as always (places at that split count them), but held back
  from every live output (convergence, Resend, "Send with finish place", a made-up time's send) AND from the merged
  .lif (`raceData` leaves them out). A packet that waited in an output's queue (or its 60 s redelivery buffer) is
  checked with `isCurrent()`, which is false while its split is paused. Feed status 'split-paused', detail "1K is
  paused: kept, not sent. Press play on 1K to send it." A crossing an output got before the pause stays 'sent'; a
  change to it is not re-sent while paused ("Not re-sent: 1K is paused"). The leg (LS) of a later split is measured
  from the nearest earlier split the outputs get, so a paused split is skipped there too.
- Play: the race is looked at in full again (dirtyAll, from the compiled `race.sendSig`): what the pause held goes out
  by the usual rules (a crossing never sent is 'new' whatever its age; one of a runner who finished meanwhile is not
  sent, see P4), and the .lif gets them. RaceView.splits[] adds `sending` and `held` (its crossings no output has, while
  paused: the tile's "Paused · 14 held"). Stale counts (9.4) leave paused and held crossings out: what they get is
  worked out when they are let go.

P2 The column check (passes counted without a timing point name). Counting (9.15 L4, with earliest times) stays the
assignment. `columnCheck({ n, runners, earliest })` flags a runner whose passes clearly belong to other columns:
- Who: a runner made of counted passes (no timing-point crossing: `located` runners are evidence only), with a column
  still empty. Never a runner with a kept crossing (real or made-up) in every column.
- Finishers (finish known: the earliest finish read or the FinishLynx finish), when at least `minComplete` (3)
  finishers have a real crossing at every split: XC-Analytics' method. Field fractions f_k = median over those of
  t_k / finish; the runner's passes (order kept) go on the columns that minimise sum |t - f_k x finish| (a dynamic
  programme; exact ties leave a gap as late as possible). Suspect when counting costs more than `legMargin` (0.25) x
  the field's shortest leg (gun to the first split, between splits, last split to the finish, as a share of the
  finish) x this finish more than the best placing: pacing never moves a pass, a wrong column is off by a whole leg.
  Ties, and anything within the margin, keep counting.
- On the course (or before there are field fractions): leader reference L_k = median race time of the first
  `leaders` (5) runners counted at split k (real crossings); ratio = t / L_k. The field's highest plausible ratio at k
  (U_k) is the end of the unbroken run of ratios from the leaders back, each within `tailGap` (1.15) of the one before,
  starting at the leaders' reference itself (a lone runner far ahead of the leaders' median must not end the run), over
  the runners whose counted passes are all plausible. That is worked out until nothing changes: start with everybody,
  drop the runners with an implausible counted pass, again (removing a runner can only shorten a run, so it ends). A
  placing is implausible when a ratio is below `floor` (0.97) or above U_k x 1.15; a split nobody has reached yet can't
  be given a pass. Of the plausible placings (order kept) the best has the smallest spread of log ratios (max - min;
  min-max programmes over every candidate lowest value), and of those within `spreadSlack` (0.02) of the smallest, the
  one that moves the passes least (one missed mat is likelier than two; a fading runner near the front looks a hair
  more even one column too far on). A placing may say the runner missed at most one more mat than counting does: a
  runner at twice the leaders' time at 1K and 2K looks exactly like one at the leaders' pace who missed 1K and 3K.
  Suspect when counting is implausible and the best is at least as even (within spreadSlack), or when counting's
  spread exceeds the best's by `spreadMargin` (0.1). A runner with one pass has no evenness to compare: it is doubted
  only beyond U_k x tailGap x `singleGap` (1.5), because the back of a small field is thin. A runner the operator has
  placed a pass of is not compared with the field any more (the operator said where this runner is), only for
  evenness with that pass.
- Measured on synthetic races (five course layouts: 1K, mile, 1 mile / 5K / 6.3K, 2K / 4K and 1.5K / 2.5K / 4K splits,
  plus 1K splits of a 10K; log-normal finish times with a wider slow side and 4 % walkers; pacing styles from a fast
  start that fades to a negative split; terrain per leg; 2 % of mats missed), live every 15 s and at the end: no runner
  with every mat read is flagged at the end (0 of 22,862); while the race runs 3 of them (0.01 %) are flagged for a
  while, single passes far behind everybody; of 1,224 finishers who missed 1K or a middle split, 1,218 are found and
  every suggestion is the true placing; a missed last split is never flagged (counting is right); 80 % are found on the
  course before they finish, with no wrong suggestion. (Revision 10 changes the lone-pass rule and these figures:
  9.18 R2.) Real .lif files: `node src\check-lif.js <file.lif> ...`
  (`measureLif`, `lifFinishers`) takes, per finisher row, the field-10 entries but the finish as the counted passes (as
  FinishLynx lists only the mats that read the runner, they are exactly what counting gives) and field 6 as the finish,
  n = the most common number of splits, and prints per file (bibs and counts only, never names): complete runners
  flagged (always 0 by the rule) and the incomplete ones flagged with the splits suggested; every complete finisher
  with each split taken out in turn: placed right, wrong, and a taken-out last split flagged (should be 0); and the
  race replayed every 30 s: complete runners flagged for a while on the course.
- Engine: the check runs over the race's derived crossings whenever they changed (once per batch of reads, before
  delivery; each runner's input is made once per derivation). A suspect's passes that would move are HELD: not sent,
  not in the .lif, not counted for the places of the others at that split (`#place`: a pass that is probably another
  split's must not push the runners behind it down a place), and their feed row is 'check-column' ("Looks like 3K, not
  2K (missed 2K?) — check it in Review."; a pass that only moves because the one before it does: "(it moves with the
  pass before it)"). Whatever starts or stops being held is delivered again (it, and the places behind it).
- The operator decides: "Move to 3K" or "Keep in 2K". Journal `{ t: 'assign', raceId, bib, tod, splitId|null, at }`
  (tod = the time of day of the pass, its earliest read; splitId null = Keep). A Move pins the pass to that split (it
  overrides counting and the earliest times); the passes around it count on from it. A Keep says counting is right.
  Both are fixed points the check never moves, are replayed at every start, and show in the runner view ("3K: moved
  there in Review."). `POST /api/races/:id/assign { bib, tod, splitId }` (one pass; splitId null = Keep) or `{ bib,
  all: 'move'|'keep' }` (every pass the check would move) -> `{ assigned, review }`. Refused in words: an unknown bib or
  pass (404), a runner with nothing to check any more (409), a Move that breaks course order ("The pass at 13:12.0
  can't be 1K: 2 earlier passes need the splits before it.", 409). A Move of a pass that went out already leaves its
  old cell in TrackScore: the leftover note (9.16 F1) counts it.

P3 Missing splits and made-up times (operator-approved).
- A runner is MISSING split k when it has a kept crossing at a later split, or a finish, and none at k, and is not a
  suspect (its column check comes first). A FinishLynx finisher that no mat read at all misses every split.
- `estimateGaps({ n, names, kept, finish, others })`: each run of missing splits sits between two references, the
  nearest earlier kept crossing (or the gun, 0) and the nearest later one (or the finish). estimate = prev + frac x
  (next - prev); frac = median of (t_k - t_prev) / (t_next - t_prev) over the up to `nearest` (30) runners nearest in
  (next - prev) duration that have real crossings at prev, at every split of the run, and at next (or a finish);
  failing that, per split, over the runners with prev, that split and next; failing that, evenly spaced. Made-up times
  are never references (an estimate is made from what the mats saw), nor are suspects. To the millisecond, strictly
  inside the stretch and in course order. Basis: "From 1K 3:18.0 and 3K 9:54.0, placed like the 11 runners nearest in
  pace (2K at 50.0% of that stretch)."; "From the gun and 2K ..."; "... and the finish 15:00.0, ..."; "..., evenly
  spaced: no other runner has a time there yet (...)". Without a later reference: no estimate, "Waiting for a later
  split or the finish." (the runner view's empty columns ahead of a runner on the course).
- Approve: `POST /api/races/:id/manual { bib, splitId, time?, basis? }` (time: a race time, default the estimate),
  `{ items: [{ bib, splitId, time?, basis? }] }` (the rows the operator approved with "Send all") or `{ all: true }`
  (every missing split listed) -> `{ added: ManualView[], skipped: [{ bib, splitId, why }], review }`. A batch never
  fails for one row: each row is checked (P5) after the rows before it went in, and one that can't go is in `skipped`
  with the refusal's words. A row without a time gets the estimate the Review list showed, worked out once for the
  batch. A single row's estimate is the runner's whole stretch estimated together, as the list and the runner view
  show it (estimating one column of a run of missing splits alone uses other reference runners and gives a slightly
  different time than the operator saw). Journal `{ t: 'manual', raceId, bib, splitId, raceTicks, tod, estimated, basis, at,
  seq }` (tod: the time of day it stands for, so a gun corrected later moves it with the real reads; seq: the journal
  position then). It is a kept crossing (`manual`), source 'made-up' (the estimate) or 'typed' (another time), ranked
  with the real ones (after a real crossing with the same time, in journal order), sent at once (no hold: the operator
  approved it; and also to an output whose copy is older than the minute of 9.4, since the operator asked), and in the
  .lif. It is a fixed point of the count: the passes after it count on from the split after it. A new one for the same
  split replaces it. Feed row status 'made-up' / 'typed' ("Made-up time, approved in Review: Sent as place 6. It is in
  the merged .lif. From 1K ..."), not tied to a read.
- `DELETE /api/races/:id/manual { bib, splitId }` -> `{ removed, wasSent, note, review }`; journal `{ t: 'unmanual',
  raceId, bib, splitId, at }`. A packet can only fill a cell: one already sent stays in TrackScore and the live results
  (`note`: "The made-up 2K time (6:50.0) was already sent. Split Relay can't remove it from TrackScore ... It is gone
  from the merged .lif."; "The typed 2K time ..." for a typed one; the panel's toast says it from `wasSent`); the
  leftover note (9.16 F1) counts it.
- A REAL read of that split replaces the made-up time: a timing-point read of it, a pass that came in after the time
  was made up (journal position) and lies between the passes that were there then (and before the finish), or a newer
  pass that counting puts on its split. Passes that were there when the operator made the time up were looked at then
  and never replace it. The record stays (state 'replaced'); the real crossing follows the correction rules (re-sent
  within the minute of the first send, else stale: Resend), and its feed row says "Real read replaced the made-up time
  (3 s later): re-sent as place 6 with the real time." or "... Not re-sent: first sent 75 s ago. Resend the race's
  splits to send the real time." A made-up time that the finish or course order rules out later is not used
  ('after-finish', 'out-of-order'), nor one before the gun after a gun change.
- `GET /api/races/:id/review` -> Review: `{ raceId, raceName, active, gunSet, missing: MissingSplit[], checks:
  ColumnCheck[], finishedNotSent: FinishedNotSent[], manual: ManualView[], counts: { missing, estimable, checks,
  checkRunners, manual, finishedNotSent } }` (typedefs in engine.js). missing[] = { bib, name, team, splitId, splitName,
  index, estimate (ticks|null), estimateText ("6:36.000", what Send uses), basis, prev, next ({ kind: 'gun'|'split'|
  'finish', splitId, splitName, raceTicks }), finished, finishPlace, sendable, why }; checks[] = { bib, name, team,
  passTod, passTodText, raceTicks, timeText, from, fromName, to, toName, reason, method, delivered, finished }
  (delivered: it went out as `from` before it was held; finished: the runner has finished, so a Move or Keep puts the
  pass in the .lif only and it then waits in finishedNotSent); manual[] = { bib,
  name, team, splitId, splitName, index, raceTicks, timeText, estimated, source, basis, at, state, sent, place,
  withFinishPlace }. RaceView adds `review: { missing, estimable, checks, checkRunners, manual }` for the race card's
  badge. Worked out when the race's crossings changed (cached by a version); what follows delivery every time.
- `GET /api/races/:id/runners/:bib` -> RunnerView ("Find runner"): `{ raceId, raceName, bib, name, team, found,
  finished, finishTicks, finishText, finishPlace, suspect, columns: [{ splitId, splitName, index, lapsToGo, sending,
  time, timeText, place, source: 'read'|'made-up'|'typed'|null, held: 'paused'|'check'|null, delivered, check, estimate,
  estimateText, basis, missing, canAdd, why }], passes: [{ tod, todText, raceTicks, timeText, reads, splitId,
  splitName, how: 'counted'|'earliest'|'moved'|'kept'|'replaces'|'extra'|'too-early'|'after-finish'|'out-of-order',
  howText, pinned: 'move'|'keep'|null, suggestion }], manual }`. canAdd / why say whether Send can work for a column.

P4 Finished runners.
- A normal split packet replaces a finisher's place in TrackScore, so convergence never sends one (9.4). LifSync adds
  `lynxPlaces(raceId)` (bib -> FinishLynx place; a change of places alone emits 'finishers' too) and the engine takes it
  as `finishPlaces`. A made-up split of a runner whose finish place is known goes out with P = that place, so TrackScore
  keeps it, also when FinishLynx changes the place (within the minute); the dialog says so (ManualView
  `withFinishPlace`, `place`). A finisher whose place is unknown (no merged .lif; a finish timing point only) can't be
  sent: refused (409) with "Bib 103 has finished, but Split Relay doesn't know the finish place (it comes from
  FinishLynx's .lif file: Settings, Merged .lif files). ...", and the Review list says it (`sendable: false`, `why`).
- `finishedNotSent`: real crossings of finished runners that no output took (not paused, not held). "Send with finish
  place": `POST /api/races/:id/send-finished { bib, splitId }` (one), `{ bib }` (a runner's) or `{ all: true }`, with
  `force` for a race that is not Active (409 RACE_INACTIVE otherwise) -> `{ sent, skipped, outputs, review }`; 404 when
  there is nothing to send. RaceView.finishedNotSent counts the same crossings.

P5 Safety. Every packet still passes `packetProblem` (1 <= L2G <= N, empty T): made-up crossings are ordinary kept
crossings of a split. Paused splits and held passes never leave (convergence, Resend, the queue's `isCurrent`, the
redelivery buffer). A made-up time must be after the runner's previous kept split (or, with none, after the start
area) and before its next kept split or finish (or, with neither, not later than the race clock); the split must have
no real crossing; the runner's column check must be settled; a finisher's place must be known. Each refusal is a plain
sentence (409; 400 for an unreadable time; 404 for an unknown bib, split or race). Everything is in the journal and
replayed in order (a Clear race data or a Delete forgets the race's Moves, Keeps and made-up times with its reads); the
read-by-read derivation equals a rebuild and a restart (a randomized test with pauses, Moves, Keeps, made-up, typed and
removed times, and FinishLynx finishers).

P6 Panel data (the panel itself is public/*): State.races[] carry `splits[].sending/held` and `review`; the endpoints
above answer with the Review list (`review`) so the panel repaints it at once; CrossingView adds `source` and `held`;
FeedEntry statuses 'split-paused' ("Split paused"), 'check-column' ("Check column"), 'made-up' ("Made-up time"),
'typed' ("Typed time"). Where the tools are in the panel (since the revision 12 redesign, section 8): Pause / Play on
each split tile of a race tile on the Dashboard and on each split row in the race editor, a paused split also a line
in Needs attention with its Play; the Review button on the race tile and the Review page in the nav rail, both with
the count of what waits (`reviewBadgeText`: "3 missing splits · 1 to check"). The Review page is a page of its own,
not a side panel: race chips, the paused splits with Play, four counters, the four queues (Passes to check, Missing
splits with Send all, Finished: not sent live, Made-up and typed times), and Find runner beside the queues from
1280 px (above them below). Every dialog says where a time goes: the outputs that take the race, by name, and the
merged .lif file.

Cost: the check runs once per batch of reads; 600 runners on four splits read one by one cost about 0.6 ms a read
(the derivation alone 0.04 ms); a Replay is batched (500 a batch).

Tests: test/review.test.js (the check on synthetic races: complete runners never flagged, no runner with every mat read
flagged at the end and few for a while, a dropped 1K / middle split placed right for finishers and on the course, a
dropped last split never flagged; hand-built cases: walkers, a lone first pass, pinned and made-up passes, timing
points, earliest times, a split nobody reached; estimates: nearest in pace, gun, finish, runs of two, the per-split and
even fallbacks, rounding; pause and play with a finisher and a queued packet; the check in the engine with held places,
Move, Keep, refusals and replay; made-up, typed, removed and replaced made-up times, within the minute and after; "Send
all" with a finisher no mat read; the validation words; finish places; randomized incremental = rebuild = restart with
every packet safe), config (the pause flag), lif (places), server (the endpoints and their errors), e2e (through the
app: a paused split played, a finisher's made-up split with its finish place in TrackScore and in the merged .lif, a
restart). Two older tests now expect the check: a first pass at 6:30 (the next split's time) is held, not sent as split
1; and the race card view has the new fields.

Integration (the core and the panel put together, revision 9):
- Paths: the panel calls POST /assign and POST /send-finished (it had guessed /finished-send first, and Split Relay
  answers an unknown path with a JSON 404, "Split Relay has no /api/...", which the panel's fallback never passed, so
  "Send with finish place" always failed). `notSupported` now also takes that answer as "an older Split Relay".
- The runner view gives a column's race time as `time` and its hold as `held` ('paused'|'check'); the panel read
  `raceTicks` and 'split-paused'/'check-column', so every column looked empty. It reads both now, and `canAdd`/`why`
  (a column it can't send says why, its Send off), `howText`, `suggestion` and `suspect`. The Review list's
  `sendable`/`why` turn a row's Send off with Split Relay's words (`rowBlocked`); manual[] `state`/`sent`/`place`/
  `withFinishPlace` say "Sent with the finish place (13).", "Not sent yet: ... 1K is paused ..." or "Replaced by a
  real read of the mat."; checks[] `delivered` says "It went out as 1K before it was held ... After a Move, send the
  made-up 1K time that Review then lists: it replaces that cell."; `finished` makes a Move's words say ".lif only,
  then Finished: not sent live" instead of "goes to TrackScore".
- Every Review answer's `review` is drawn at once (the row just sent is gone, and the next split of the same runner
  shows the estimate Send will use); "Send all" is one `{ items }` request; the toasts use the answer (`added[].sent`,
  `place`, `wasSent`, `skipped[].why`). A race that is not Active: `destinations().inactive` makes every "where it
  goes" say ".lif file only (Boys 5K is not Active, so nothing goes to TrackScore until it is)", and "Send with finish
  place" asks "Send anyway" and sends `force`. The Resend dialog says finishers' made-up times go with the finish place.
- Run through the real app (panel 5791, RR12 input 5792, a Lynx.ppl with invented names, a FinishLynx folder with the
  race's .lif written after the 3K passes, a TrackScore stand-in on XCScore.lss; 30 runners, 3 splits, bibs missing
  1K, 2K (two), 3K, 1K and still on the course, and one no mat read): 2K paused for a minute with 25 held and nothing
  sent, then played (all 25 at once); four column checks moved in the panel (one Move settled both of a runner's
  passes); one estimate sent alone, one typed (and refused first with "1K must be earlier than 2K (7:04.000)."), six
  with Send all, 23 finishers' splits with their finish place (after a forced kill and restart, 9.4), one made-up time
  removed and sent again from the runner view, a Resend. 150 packets: valid JSON, T "", 1 <= L2G <= 3 matching the
  column, P >= 1, names from the people file; every real read in its own column; every made-up or typed split of a
  finisher with P = the FinishLynx place, and each finisher's last packet with it; the merged .lif with all 30 rows of
  19 fields, the made-up times as sent and FinishLynx's places. No console messages. Seen there: a runner who missed
  1K had its lone 2K pass (2.06x the leaders' 1K) sent as 1K, since one pass is doubted only beyond U_k x tailGap x
  singleGap (about 2.4x here); it was held at the next pass, and the made-up 1K replaced the cell (the leftover note
  showed it until then).

### 9.18 Revision 10 (2026-10-19) — late reads of made-up splits, a moved finisher's split, a missed first mat, Play
Why: the round-9 verification (the review tools through the real Split Relay into TrackScore-LocalCopy's real XC
ingestion; the 10 real FinishLynx races replayed through the engine with 5 % of the runners missing a mat; a randomized
engine fuzz of 1,000 seeds) found five things. R1: with two made-up times in a row, a late real read of the later
split replaced the EARLIER made-up time (the replacement window was bounded only by the real passes, not by the
runner's other made-up times) and was then thrown away as 'extra'. R2: a runner who missed the first mat had their
second pass sent live as split 1 (283 of 352 such runners in the simulation), since a lone pass was doubted only
beyond U_k x tailGap x singleGap 1.5. R3: after a Move, a finisher's corrected crossing was never re-sent, because
"delivered" looked at the crossing's key only (bib 3403: TrackScore kept 29:12.1 as its 2 Mile, the truth 18:47.3).
R4: Play could send held splits, with a split place, to runners FinishLynx had finished seconds before (the relay
reads the folder once a second): 14 finish places overwritten in TrackScore. R5: the Send dialog did not say that a
finish place sent with a split is also TrackScore's place for that split.

R1 A late real read replaces only the made-up time of its own split (replaces the "between the passes that were there
then" rule of P3). `lateReplacements(clusters, made-up times, timing-point groups, splits, finish)` (engine.js, pure):
- A late pass is a cluster that came in after at least one of the runner's active made-up times (every read newer
  than its journal position), that the operator did not move or keep, before the finish.
- Everything else is placed first, with every active made-up time a fixed point: `countClusters(events, splits)` is
  the counting loop of 9.15 L4 / 9.17 as decisions, without side effects (#assignPasses applies the same function).
- The late pass lies between its nearest neighbours in time: the gun (column -1), the passes counted that way, the
  operator's Moves, timing-point reads, the made-up times, and the finish (column n). Its candidates: the made-up
  time just before it and the one just after it (each only if the pass came in after that time was approved), and
  every empty column between the two neighbours, expected at the even spacing between them (with no later neighbour,
  the runner's average leg so far after the one before). It is the candidate whose time it is nearest (a tie: the
  lower column). A made-up time is replaced (state 'replaced', the pass pinned there, 'replaces'); an empty column
  means an ordinary pass, counted (and column-checked) as any other.
- Late passes are decided in time order, each decided pass a neighbour of the next. So a late read replaces at most
  one made-up time, the one next to it, never one across another made-up time or real pass; the old rule "a newer
  pass that counting puts on a made-up time's split replaces it" is the case with no empty column in between.
- Pure, from the journal: read by read = rebuild = restart. A finisher's replaced made-up time had gone out; the real
  time then waits under "Finished: not sent live" as sent with an old time (R3).

R2 A missed first mat, held before it goes out. The column check (review.js) changes in two places:
- `loneAmbiguity`: a LONE pass (a runner's only pass so far, counted, not pinned or made up) at column c whose time
  also fits the next column's leaders (t >= floor x L_{c+1}) is either a slow runner at c or the c+1 pass of a runner
  a mat missed. It is no evidence of where column c's field ends: the tails U_c are worked out without it. (Before,
  the runners who missed the first mat, all counted at column 0, chained each other into "the back of the 1K field":
  in race 004 their passes at 2.2, 2.4, 2.5, ... x the 1K leaders were each within 15 % of the one before.)
- `singleGap` is 1 (was 1.5): a lone pass is doubted once it is beyond the plausible end of its column's field (U_c x
  tailGap) and plausible at the next column (the next split's leaders, and that field's tail x tailGap). The
  suggestion is the next column, as before; Suspect gains `lone: true`, Review's checks[] `lone`, and the feed row and
  Review add LONE_TEXT: "It is this runner's only pass so far: Split Relay holds it until their next pass or their
  finish shows which split it is. You can decide now, but you don't have to." (engine.js and app.js; a test checks
  they agree). A slow runner's next pass lets the hold go by itself (two passes are judged on evenness).
- Undecidable, and so sent as counted: a lone pass plausible in both columns, i.e. a runner near the front who missed
  the first mat and crosses the second while the first split's slowest runners are still coming (typical in races
  with 2 splits, where the leaders reach the second mat soon after the last runners pass the first). The end state is
  corrected after the finish in Review (the finish method places it; Move, then the made-up split replaces the cell).
  README ("What Split Relay can't tell") and Help ("A missed first mat Split Relay can't tell") say so.
- Measured with the verifier's harness (acc/sim.mjs on the 10 real races: A/B mats, 8 % single mat, arrival delays
  up to 40 s, FinishLynx finishes 20 s late; acc/r2.mjs summarises it), runs with every runner read at every mat and
  runs with 5 % missing a mat, 8 seeds each: runners read at every mat flagged on the course 0, at the end 0, a
  crossing of theirs first sent later than its 2 s hold 0, never sent 0 (31,792 runner-runs in each mode). Runners who
  missed the first mat held before anything went out: 685 of 704 (before: 134 of 704), flagged on the course 688 of
  704 (before 257 of 704). The 19 left are the undecidable front runners (1.01-
  1.04 x the leaders at the second mat, within 15 % of the first split's tail) and one runner far behind everybody
  at both columns (no column fits). Middle and last mats unchanged (one middle case, seed 8: a leader who missed 2K
  and whose 3K pass came before anybody else reached 3K goes out as 2K, with and without this change). acc/wrong.mjs
  (4 seeds): wrong TrackScore cells at the end 0 (before 2, bib 3403), wrong split 1 cells shown live 9 (before 283).
- The price, on the synthetic races of test/review.test.js (4 % walkers at +25-65 %, fields of 30-230): runners read
  at every mat that are held for a while rise from 0 to 72 of 6,015 (1.2 %): walkers slower at the first mat than the
  leaders at the second, and beyond the field there. All are lone first passes, released by their next pass, none at
  the end; the 10 real races have no such runner (in every one the slowest runner at the first mat is ahead of the
  leaders at the second). Missed-first-mat runners held at once on those synthetic races: 91 % (before 15 %), never a
  wrong suggestion. Fields of 280-600 with the same walkers: 1.07 % held for a while, 93 % (before 6 %) held at once.
  Alternatives measured and not taken (real races held before going out / synthetic held at once / synthetic walkers
  held for a while): singleGap 1.15: 82 % / 57 % / 0.33 %; 1.25: 65 % / 39 % / 0.15 %; 1.5 with the exclusion: 20 % /
  17 % / 0 %. A field-size switch and a partial chaining of lone passes did not separate walkers from missed mats: one
  pass can't, both are a sparse population beyond the field, only how common each is differs.
- Future option, not built (a race takes one RR12 port): each split mat on its own RR12 exporter and port, so a read
  says its split (no counting, no doubt from the first pass). It would need a per-split port on the race (validated
  like a race's port: an input port, one Active race per port), the race listing those port keys (routing is by key
  already), #classify mapping such a read to its split like a timing point, the column check treating it as located,
  the RR12-not-connected warnings per port, and the race editor. README says so.

R3 What an output has, by content. `#sentAs(race, state, c)` -> `{ now, old }`: now = some output has the crossing as
it is now (a ledger entry or the latest in-flight packet with the same tod, gun, laps to go and split count; the place
is not compared: a finisher's place is FinishLynx's, a runner on the course gets place updates by 9.4); old = what an
output has for it otherwise (sent before a Move, an earlier backup read, a gun change). Used where an old copy must not
count as sent; the feed's "Sent" / "Ready" and Review's checks[].delivered ("it went out as 1K") stay by key.
- Finished: not sent live (RaceView.finishedNotSent, Review.finishedNotSent) = real crossings of finished runners, not
  paused or held, that no output has as they are now. Items add `sentOld: { raceTicks, timeText } | null` and `note`
  (`sentOldText(split, old, now)`, the same words in app.js): "Sent with an old time (29:12.1): TrackScore and the live
  results show that as 2 Mile. Send the corrected time (18:47.3) with the finish place."
- The place rule (`#sentAfterFinish`): a finisher's crossing that an output has as it is now, but was given AFTER the
  runner's finish with a place other than the FinishLynx place, is listed too: TrackScore took that split place as the
  runner's place. "After" is by the race's own clock, not the PC's: when the copy went out (its ledger `at`, or now for
  one on its way), reads of the race timed at or after the finish had already come in (`state.clock`: the race's
  reads by arrival with the latest time of day so far, rebuilt with the race's reads; `#raceClockAt` is a binary
  search). Reads come in after they happen, so this never says "after" too soon; a PC clock set apart from RR12's, or
  a race replayed or compressed in a test, changes nothing. Late in a race the split reads thin out while the
  finishes crowd in, so a second test applies to a copy that went out LATE (more than the hold + 5 s after its read
  came in: a pause, an output that caught up): it went out less than 5 s before the relay found the runner's finish in
  FinishLynx's file (`lynxSeenAt`, in memory: after a restart, when the restarted relay read the file, so a split that
  went out late just before a restart still counts). FinishLynx tells TrackScore a moment before it saves its file, so
  such a copy may have landed after the finish packet; a split sent as the runner crossed the mat never counts. A
  wrongly listed split costs little: sent with the finish place, TrackScore keeps the finish place. Items add
  `sentAfter: { place }` and the note `sentAfterText(place, finishPlace)`: "Sent after the runner finished, with place 58: TrackScore and the live results
  may show that as the runner's place. Send it with the finish place (50)." That is what a pause released by Play a
  moment after FinishLynx's finish reached TrackScore, but before it reached FinishLynx's file, leaves (R4), as does a
  Resend that included finishers or an output that caught up late. The feed row adds the same words. Send with finish
  place sends it as a 'place-update' with P = the finish place.
- "Send with finish place" sends them with P = the finish place, reason 'correction' to an output that has an older
  copy; the feed row then says "Moved in Review: re-sent as place 315 with the corrected time." (a Move or Keep), else
  the backup-read words.
- The race card's stale count leaves such a crossing out: a Resend leaves finishers out, so it can't fix it; Review
  can. (A finisher's place-only change was already not stale.) The Resend dialog adds, when there are any: "2 splits of
  runners who have finished are not in TrackScore as they are now (not sent, or sent with an old time): send them from
  Review ("Finished: not sent live"), with the finish place, so TrackScore keeps it." The leftover note is unchanged
  (the cell is filled by a current crossing).
- The feed row of such a crossing: 'finished-not-sent', "Finished: Sent with an old time (...) ... Review lists it
  under Finished: not sent live. It is in the merged .lif."
- RunnerView columns add `delivered` (by content now), `sentOld`, `finishedNotSent` and `note`; the panel's runner view
  shows "Finished: not sent live", the old-time line and "Send with finish place…" on that column.
- ManualView.sent and DELETE /manual's wasSent: the made-up time itself went out (by content, or the same time of day
  before a gun change), not an older real time of the split in that cell.

R4 Play reads FinishLynx's folder first. `LifSync.freshScan({ timeoutMs = 3000 })` -> `{ scanned, settled, ms }`: a
scan now (or after the one under way); when that first read finds nothing new and no file being written, it is done
at once. Otherwise it reads again every settleMs while a file is being written (a change that could not be used yet:
`_changing`) and until nothing new has come for `quietMs` (2 x settleMs: FinishLynx in the middle of a run of saves).
At most timeoutMs (a slow share included); it never rejects, and 'finishers' has been emitted by the time it resolves.
(A longer quiet wait was measured and dropped: in a busy finish it only moves the moment Play sends, and the runners
who finish just before that moment are again not in FinishLynx's file yet.) main.js `setSplitSending(on: true)` marks
the split playing (RaceView.splits[].playing, so every panel shows "Playing…"; app.js S.playing for the panel that pressed it),
awaits the fresh read, then plays the split in the settings as they are then; held crossings of runners who have
finished meanwhile go to Review as always. POST /manual and /send-finished read the folder first too (one read serves
the next request for a second: the panel sends "Send all with finish place" one split at a time). A finish FinishLynx
has sent to TrackScore but not yet written to its file can't be known at Play; once the file has it, the place rule
(R3) lists that split for Send with finish place, so the end state is right. Measured with the verifier's harness
(ts/run.mjs: the real 010 field through Split Relay into TrackScore-LocalCopy's real XC ingestion; 2 Mile paused
from race 11:30 to 21:40; FinishLynx's file 2 race seconds behind its finish packets, rewritten every 2; 4x speed):
finish places overwritten in TrackScore at the end 14 before, 0 now (2 runners who finished 2 s before Play were sent
with the split place, then listed by the place rule and corrected by Send with finish place; with FinishLynx
writing on while Play reads its folder, 4, likewise corrected); with the harness defaults (10x, the file 20 race
seconds behind, every 30) 0. Every check of the harness passes (12 of 12) in all three.

R5 The single-row dialog, "Send all" and "Send with finish place" add: "TrackScore also shows place 12 as the runner's
place at 3K: a split packet carries only one place." (`finishPlaceSplitNote`); README and Help say it once.

Tests: review.test.js (R1: two made-up times in a row with four late times; an empty column against a made-up time; a
randomized run of 60 seeds, 2-4 splits, any set of missed mats made up and their real reads coming late in random
order; R3: the 3403 case through the engine (finishedNotSent with the old time, stale count, runner view, feed row,
Send with finish place, restarts); the place rule (a split played 20 s after the runner's finish, the race's reads
past it: listed; one played 2 s before the relay found its runner's finish in the file, no read past it yet: listed;
one played before its runner's finish: not listed; Send with finish place sends a place-update; a late split just
before a restart: listed after it); a made-up time's `sent`; R2: the missed-first-mat hold on synthetic races, the
hand cases (a lone pass beyond the 1K field; a 1K field to 1.85 x leaving 2.0 x undecidable; missed-mat passes not
chaining), the synthetic bound now 1.5 % for a while and lone passes only), lif.test.js (freshScan: a new finisher
before the next poll, a file being written, a finisher saved while it reads, the time limit, no folder),
e2e.test.js (Play through the app with FinishLynx's file being written: "Playing…" in State, nothing of the split
until the file is complete, the two runners who finished get no packet and are in Review), app.test.js (the panel's
words equal the server's, the dialogs, normReview / normRunner). engine.test.js: a finished runner's earlier backup
read is 'finished-not-sent' with the old time, and a gun change leaves a finisher's split to Review instead of the
stale count. Each new test fails on the revision 9 sources, and each of 15 breaks of the new rules (the lone-pass
exclusion, singleGap, the late-read decisions and their empty-column option, delivery by content, the stale count,
freshScan and its wait, Play's read, the old-time row, the place rule and each of its two tests, the late-send
condition, a restart's seen time) makes a test fail. The verifier's fuzz (fuzz.mjs, seeds 1-2000) finds no problem (10,568 late
reads of made-up splits checked); its repro-late.mjs and acc/dbg3403.mjs show the right column and the corrected
2 Mile.

### 9.19 Revision 11 (2026-10-19): finish places put back on their own, Pause cancels a pending Play

- A real split that went out with the split place after the runner had finished (the place rule of 9.18 R3/R4: held
  by a pause and played a moment before FinishLynx saved the finish, or an output that caught up late) is now sent again
  with the FinishLynx finish place by the engine itself (`#repairFinishPlaces`, checked at most once a second during
  convergence), to each output whose copy has the split place. It only restores what FinishLynx said, so no operator is
  needed; made-up and corrected times still wait for the operator in Review. Splits sent with an old time stay in Review.
- A Pause that arrives while a Play is still reading FinishLynx's folder (9.18 R4) cancels that Play (a per-split
  counter in main.js). The panel disables the button while it says "Playing…", so this covers a second panel or the API.

### 9.20 Revision 13 (2026-10-21): the meet's names file, impossible to miss

A race ran with no names file: RR12's LapTime lines carry a bib and a time only, so TrackScore got splits with blank
names and schools. The feature was there (Settings, an amber line), but not found. The names still come only from
FinishLynx's people file (`config.names.pplPath`, `NamesFile`, 4.4); the panel now makes it hard to miss and easy to fix.
All of it is the panel's except one server addition (N2).

- **N1 Missing names, said where the operator looks.** `namesGap(State)`: 'none' (no file, and `State.namesNeeded`)
  or 'unread' (a file chosen, no names from it, LapTime lines). Needs attention: "No names file: choose the meet's names
  file (.ppl)" in amber; red once an Active race has sent splits (`racesSent`: crossings less the ones a paused split
  holds, to an output that is on and takes the race): "TrackScore and Karmarush get no names: choose the meet's names
  file (.ppl)". Its button, "Choose names file…", opens the file picker at once (`choose-ppl`); the pick is saved at
  once (PUT /api/settings) and a toast says "✓ 412 athletes loaded from Lynx.ppl" (or, when the file loads after the
  answer, once it has). The amber line is the setup checklist's step while the checklist shows (`step: 'names'`); a red
  one always shows. Each race tile has a "No names" chip (red once that race's splits went out; a click opens the
  picker), the status strip a "Names · none" light, and the Settings badge counts it when red.
- **N2 The right file offered.** `pplFolders`: FinishLynx's results folder (`config.lif.inputDir`) and the folder
  above it. The panel lists their `*.ppl` with `GET /api/files?ext=.ppl&times=1` (the server stats the first 100
  listed files, 1.5 s each at most; without `times` nothing changes), newest first, at most 4 (`pplSuggestions`), as
  "Use C:\Lynx\Lynx.ppl (modified today 09:12)" (`modifiedText`: today, yesterday, or a date: an old one is last
  meet's file) on top of the picker and on the Settings card. Nothing is loaded until the operator clicks. The picker
  shows each .ppl with its modified time too. From another computer (LAN viewing) /api/files is refused, and nothing is
  offered.
- **N3 Filling in the names already sent.** Names are looked up when a packet is built, and they are not part of a
  packet's content signature, so a names file that arrives late changes nothing on the boards by itself. `namesArrived
  (prev, next)`: between two States this page saw, a file where there was none, another file, or the same file that
  could not be read before (a re-read of the same file, FinishLynx saving it again, is not). Then, if Active races had
  sent splits, the page keeps an offer in localStorage (`namesOffer`: key = path + loadedAt, the races 'open'; the keys
  seen in `namesOfferSeen`), so one file is offered once, across reloads and tabs (the 'storage' event repaints the
  others). Needs attention has one amber line per race, "Fill in the names on TrackScore and Karmarush", with "Send
  names now" (POST /api/races/:id/resend with `includeFinished: false`: the finished runners are left out, FinishLynx
  sent their names) and "Not now"; the Settings card has the same buttons. One click, except when a TrackScore-like
  output that takes the race also takes another Active race that has sent splits (`namesSendRisk`): it may show that
  race, and would switch, so the panel asks first. An offer ends with its file (another file, or none loaded), its race
  (not Active, deleted) or its outputs.
- **N4 Settings → Names file** is a card, not a form: the status ("✓ 412 athletes loaded", "Can't read it: …",
  "Loading the names…", or the missing-names line), File, Athletes, Loaded at, "Choose…" (gold while names are missing)
  and "Clear" (asked first: new splits then go without names), the files of N2, and the offers of N3.
- **N5 Words.** The setup checklist's step: "Choose the meet's names file (.ppl)". Help's race-day checklist starts with
  "First, load the meet's names file (.ppl)", and "If something goes wrong" has "TrackScore shows splits with no names
  or schools". README: the setup step and the race-day checklist say the same.

Tests: app.test.js (the amber and red lines and their key, what counts as sent, the unreadable file, `modifiedText`,
`pplFolders`, `pplSuggestions`, `namesArrived`, the offer and its lines, `namesSendRisk`, the checklists),
server.test.js (`times=1`). Checked by hand on the seeded demo with no names file (blank FN/LN/AF in the capture, the
red line, the chips, the picker's offer, new packets with names, "Send names now" re-sending every split with names)
and against TrackScore-LocalCopy's real XC ingestion (blank names in its snapshot, then every runner named after "Send
names now", the finisher left as FinishLynx sent it).

### 9.21 The gun is only a typed time (race day 2026-10-21)

On race day the operator typed the gun (16:28:00.455), and a "Set to now" press a few seconds later replaced it with
this PC's clock (10:23:17.9, then 10:25:27.311). "Set to now" is gone: from the gun card, the race tile and the server.

- The gun card and the tile take a typed time of day, set with Set or Enter. Nothing else sets the gun.
- The FinishLynx start (read from FinishLynx's .lif header) only fills the box. The operator checks it and presses Set.
  The "Gun differs from the FinishLynx start" warning's button ("Check the gun time") opens the race's gun box with the
  FinishLynx start in it, and sets nothing.
- POST /api/races/:id/gun takes only { gun } (a string, or null / '' to clear). { now } and { fromLynx } get a 400
  ("Type the gun time: ...") and change nothing.
- The offset between RR12's clock and this PC's is information on the Inputs page (and the input light's tooltip), no
  longer a warning: it only mattered for "Set to now".

### 9.22 Revision 14 (2026-10-21): meet setup — save, load, set up from TrackScore, start a new meet

Race day 2026-10-21: the races were typed in twice (Split Relay had 4400m/5300m where TrackScore's Race Setup had
4500M/5400M), and a second copy of Split Relay started by mistake, with its own empty data folder, looked like "starting
from scratch". Races always persisted in data\config.json; what was missing was a way to carry a meet's setup from one
start, PC or copy to another, and to take the races from TrackScore instead of typing them. The panel now has **Save meet
setup**, **Load meet file…** (file chooser, a .json dropped anywhere on the page, or one click on a meet saved earlier),
**Set up from TrackScore**, and **Start a new meet…**. A load always shows a preview first and changes nothing until
Apply. src/meet.js (pure: the file, the merge, TrackScore's mapping), src/trackscore.js (the GETs), main.js (files,
paths, the one apply), engine.js (newMeet), the panel.

The five rules a load keeps (every other rule below follows from them):

- **R1 A load never removes and never empties.** It never deletes a race, an output or an RR12 port, and never clears
  reads. Races not in the source stay. Removing races not in the source is offered as an opt-in tick box; it covers only
  races with no reads, no crossings, no gun and no reads waiting for them.
- **R2 Ids, reads, guns, Pause and Active belong to this Split Relay, never to a file.** An existing race keeps its id,
  its reads, its gun, its Active flag and the Pause of every split it keeps. A new race starts with no gun and every
  split playing. A file's ids, guns and Pause states are ignored.
- **R3 A race in use changes only in ways that send nothing and move no reads.** "In use": it has reads, crossings, a gun,
  or reads waiting for it. The only thing a load may change on it is its split NAMES, when the split count is the same.
  Its name and distance stay too (every packet carries them; the made-up merged .lif header carries the name, and
  TrackScore takes a new name as a new race; the name may be FinishLynx's own, just fixed with "Use …"). Everything else
  is listed under "Needs your attention" with an "Open race" link: the race page asks first and offers Resend.
- **R4 While any race is in use, the settings that change how reads are worked out stay as they are**: the tag filter and
  the merged .lif settings. The SR line format stays while there is any read at all or an RR12 connection (changed
  mid-stream, the lines coming in would be bad lines). The names file is filled in only where none is chosen. RR12 ports
  are only added. From a race's gun on (Active with a gun, before its first split too) existing outputs stay exactly as
  they are, and a new output that would take a running race comes in switched off.
- **R5 One preview, then one change.** Everything is built on a clone through config.js's own functions (updateSettings,
  addRace, updateRace, addOutput, updateOutput, deleteRace), so the checks and messages are the panel's own. It goes
  live with ONE main.#apply: one config write, one engine re-plan. Apply plans again from the setup as it is then, and
  refuses with 409 when the setup changed since the preview.

So **a load sends nothing to any output by itself**: new races have no gun, and only Active races with a gun deliver;
races in use keep their content signature (names and split names are not in it); settings that re-derive races only
change when no race is in use; outputs are untouched from a gun on, and a new output that would take a running race comes
in off; races removed by the opt-in have no reads, so nothing is set aside for them.

- **M1 The meet file** (`{"splitRelayMeet": 1, …}`, UTF-8 JSON, two spaces, CRLF, a list of only names or numbers on
  one line up to 120 characters; a BOM is accepted, never written). Header: name, savedAt, savedBy, savedOn, about.
  races (name, eventNumber, round, heat, distance, inputPort, active, splits, and contests and finishSources when not
  empty): a split is its name (no timing points, no earliest time) or { name, sources, earliest }. outputs (name,
  enabled, mode, host, port, script, stage, races BY NAME ([] = all; "(deleted race)" for an output whose race was
  deleted), eventNumber, precision, mid). input (ports, every race's port among them; delimiter, tag, columns), filter,
  names, lif. Not saved: gun times (9.21), Pause (a paused split from a file would silently hold the next meet's
  splits), ids (they key the stored data: crossing keys bib|splitId, output ledgers, race files; a file id equal to a
  deleted or missing race's id would bring its old reads back), reads and deliveries, the control panel and TrackScore's
  web port (this PC's). parseMeet: plain-English refusals (not a meet file, a newer format, races or outputs not a
  list, nothing to load, more than 100 races or 20 outputs: every change clones the whole config); a race or output that
  can't be read is left out with a note; unknown keys are said once per key; one note when the file had gun times; a
  Split Relay config.json is taken too (the way out of the "second copy": load that copy's data\config.json). Fields a
  hand-written file leaves out stay as they are on a race or output it matches; a new race with no inputPort takes the
  first RR12 port (only null means "by contest only": a catch-all would take every port's reads); a new output with no
  "enabled" comes in off; an output with no port is left out (the default is 5555 on this PC, the live TrackScore).
  Idempotent: apply re-parses what the preview sent.
- **M2 Save** writes data\meets\<meet name>.json atomically (meetFileName: Windows' forbidden characters become "-",
  reserved device names get "Meet " before them) and the browser downloads the same text. The meet name is
  config.meet.name, else "Meet YYYY-MM-DD". Saved again, the file is replaced and the copy it replaces goes to
  data\meets\old. GET /api/meet/files lists the folder (newest 50; summaries cached by size and time), with the setup
  before the last load on top.
- **M3 Preview and apply.** POST /api/meet/preview returns MeetPreview: mode, the meet as planned, base, title, source,
  added, changed, kept ("Left as they are"), attention (Problem / Check / Note), removable, removed, readsPlan
  (engine.planChange of the whole next config, worded with planLines), newMeet (M9), nothing. It changes, writes and sends
  nothing. POST /api/meet/apply re-parses the meet, checks the paths FIRST, then in one synchronous block (no await until
  the config is live) works out the context, compares the base (sha1 of the settings, the races in use, whether anything
  holds the SR format, which outputs have been sent splits), plans and applies: a gun typed or a first read that arrives
  during the path checks makes it a 409, never a plan made around it. Just before it, the setup as it is is kept as
  data\meets\before-load\<stamp>.json (a meet file) with an exact copy of config.json beside it (written synchronously;
  the load is refused if they can't be written). Loading that file back puts the matched races back as they were; it
  cannot undo what a load adds: outputs and RR12 ports stay (R1), and the races it added go only with the opt-in tick
  box, and only while they have no reads. One meet change at a time (409 "already under way").
- **M4 Matching: name and event must agree on one race.** For each source race: N = races whose loose name matches
  (lower case, letters and digits only, accents dropped: "Women's Race" = "Womens Race"), E = races on its event key
  (event-round-heat from a file; the event number alone from TrackScore, which has no round or heat). Exactly one race in
  N ∪ E: matched. None: new. Otherwise (N and E name two races, a name that fits two races, two source races on one race,
  or TrackScore matching only by name while both event numbers are set and differ) it is a conflict: left out, said in
  red, and those races are never offered for removal. Why both: the user's data has "Womens Race" in Split Relay and
  "Women's Race" in TrackScore on the same event; event numbers repeat every meet and no two races may share an event
  key, so a name-only rule would duplicate races and an event-only rule would rename silently. A TrackScore match that
  is not by both is said (a Check line naming both races); a file's rename shows as name "X" (was "Y") and is held on a
  race in use.
- **M5 What a load may change.** A matched race keeps its id. Not in use: its name (from a file), distance, split names,
  and the structural fields (event, port from a file, the number of splits, timing points, earliest times, contests,
  finish timing points). Splits are sent complete ({ id, name, sources, earliest }: the race editor's list replaces the
  old one). With the same number of splits, ids (and Pause) go by position: a rename. With another number, an old
  split's id, Pause, timing points and earliest time go to the new split with the same name (never by position: a point
  inserted in TrackScore would get the next point's mats and earliest time); from TrackScore the others get none
  ("timing points and earliest times cleared on 1.5K"). In use: only split names; the rest is one Check line ("Womens
  Race has reads, so these stay as they are: number of splits (7 here, 8 in TrackScore). …"). New races: one Active per
  port (a raceClashes check against the Active races), the file's Active flag as the wish, TrackScore's live race first,
  then the upcoming ones in program order; never Active without an event number; on the port most races here read from.
  Outputs (a file only): matched by name, else by the same mode, host and port; the id (and its ledger) is kept. From a
  gun on they stay exactly as they are (R4); an output that has been sent splits keeps its address (its deliveries are
  kept by output id: a new address would never get them). Changes that change what TrackScore or the live results show
  (on/off, address, the event number race/blank, the races list, the MID) are Check lines with their effect; a MID that
  comes from a file is always one ("Karmarush meet number 8132 comes from the file (saved Tue 14 Oct): make sure it is
  this meet's.").
- **M6 Removals** are opt-in ("Also remove 2 races that are not in the file and have no reads: …"): deleteRace, passed
  as `deleted` to #apply, so they are proper deletes (race file to races\deleted); with no reads nothing is set aside.
- **M7 Paths from another PC** (the names file, the FinishLynx folder, output scripts) are checked on this PC: 'yes',
  'no' or 'unknown' (no answer in 1.5 s). One check at a time per drive or share, and once one gets no answer the rest of
  that share is 'unknown' without a check, so a dead \\server\share never ties up the thread pool LifSync's folder reads
  and the settings writes need; answers are reused for a minute (the apply after its preview). A path that is not here is
  set only where nothing is set now (a new output always gets its script), and said either way. A folder or names file
  that IS here and comes from a file is a Check line: last year's FinishLynx folder still on this laptop would stop
  today's splits for returning bibs. A file saved on another PC says so.
- **M8 Set up from TrackScore.** The server (CORS) GETs, with a deadline and a 4 MB cap: /api/xc/race for the meet of
  TrackScore's live race (only meetId and config are kept: the snapshot has every runner); without one,
  lynxEvent.lastScopeMeetId from /api/xc/schedule, never that call's races (without a meetId TrackScore answers with an
  old, meet-less list); then /api/xc/schedule?meetId=…, and /api/meets/<id> for the meet's name (any failure ignored).
  The host is the TrackScore output's (else this PC), the port Settings → Meet setup → TrackScore web port (default
  5000). Refused without a socket: TrackScore's timing ports (4554-4569, 5555, 5556), any output's port, this Split
  Relay's RR12 ports and panel port (an HTTP request there would be read as timing data); Settings refuses them with the
  same words. One race per TrackScore race, in program order: name, event number ("003" is "3"), round and heat 1,
  distance = finishDistance, one split per split point (hidden ones too: TrackScore's column counts them), named by its
  label. Left out, with a note: no split points, more than 20, RTRT races, a second race on one event number. Notes: no
  event number (never Active), duplicate labels ("1K (2)"), hidden points, a results file or folder TrackScore reads (it
  ignores port 5555 then), Follow FinishLynx off, the boards running the live race with another split count or event than
  its Race Setup, TrackScore showing no race of this meet. Matched races keep their name (FinishLynx's); new races take
  TrackScore's and say so. Never a gun, from anything. The same preview and apply as a file; apply does not ask
  TrackScore again (a 409 asks for a new preview, which does).
- **M9 Start a new meet.** Event numbers repeat every meet, so next meet's races match last meet's and would keep their
  reads, ledgers, gun and Pause (R2). Reads have a time of day and no date: once today's gun is typed, yesterday's reads
  at a later time of day become splits and go to TrackScore. An RR12 Replay identical to an old read is ignored as already
  received, reads in no race move into a new race on their port, and "Clear race data" misses those and needs one click
  per race. So: POST /api/meet/new { confirm: true } copies data\config.json(.bak), reads.jsonl and races\ to
  data\archive\<stamp>\ (and the merged .lif files, best effort, to merged\; an about.txt says what it is), then
  engine.newMeet(): a {t:'new-meet', seq} record (and a 'clear' per race, for an older Split Relay) marks every live read
  up to seq CLEARED, wherever it is, and forgets the set-asides, Moves, Keeps, made-up times and deleted ids; #replay does
  the same; #meetSeq is the floor for a race file's clearedSeq (a file saved before the new meet brings no ledgers back,
  and one saved after it journals no extra clear at the next start). The race files are flushed at once. Then every gun,
  every Pause and the meet name are cleared (the next Save must not replace last meet's file). Races, outputs, ports,
  names file and folders stay. Nothing is deleted, nothing is sent. Refused (409) while a race is Active with a gun and a
  read in the last 15 minutes. Rejected: rotating reads.jsonl (a restart, or rebuilding the Engine, RaceStore and
  LifSync while running); the trade-off is that the journal still replays every past meet at start. The preview counts
  live reads that ARRIVED before today, per race and in no race; when there are any, its banner says so and offers
  "Start a new meet…" first, and Apply becomes "Apply anyway (keep the old reads)".
- **M10 The panel.** The setup checklist starts with "Load the meet setup, or add the races" (the newest saved meet in
  one click, Load meet file…, Set up from TrackScore, New race). The empty Races page offers the same first ("Add a race
  by hand" after), the saved meets, the drop tip, and which data folder this copy uses ("It started with a new, empty
  data folder: … you may have started another copy of Split Relay"; State.dataDir). The Races list says "Meet: …" and has
  Load, Set up from TrackScore and Save (while a race runs only Save and "Meet setup…"). Settings → Meet setup: the
  status, the three buttons, the saved meets (one-click Load…), the meet name and TrackScore web port, and "Start a new
  meet…" (asked first; red when a read came in the last 10 minutes). A .json dropped anywhere shows a full-page target;
  the browser never opens a dropped file itself; nothing happens while a dialog is open or from another computer. The
  preview is #dlg-preview: sections of short lines (no tables) that wrap at 390 px, focus on Cancel; an unsaved form
  the load changes is said first. The toasts carry no "✓" of their own: the toast's icon is the check mark.

Not in this change (possible follow-ups): a Needs-attention line for reads from an earlier day outside the preview; a
journal rotation at start; keeping TrackScore's race id on a race to match again after an event number is fixed;
watching TrackScore for later Race Setup edits (Set up from TrackScore again shows the difference); a one-click Undo of
a load; ignoring FinishLynx .lif files from before today.

Tests: meet.test.js (the file and its printing, meetFileName, parseMeet's refusals, notes and idempotence, planMeet into
an empty setup and over itself, matching and conflicts, a race in use with reads, a gun or waiting reads, not-in-use
changes with the R4 insertion, the settings gates and the path rule, outputs (address held, R2 from the gun, Off on a
running race, unknown race names, the MID), the opt-in removals, the race-day worked example, TrackScore's mapping and
notes), trackscore.test.js (a stand-in TrackScore on a free port: the order of the GETs, the meet-less fallback, every
error in words, the port guard opening no socket), engine.test.js (newMeet: every read out of use, nothing sent, the
restart, the race file not saved again), config.test.js (the meet section, the web-port guard), server.test.js (Save and
the list, a preview that changes nothing, saved names looked up only in data\meets, a running race renamed by Set up
from TrackScore with no packet sent and the same header after, the R1 409, Start a new meet refused then done, reads
from an earlier day), e2e.test.js (a meet saved on one copy loaded on another, still there after a restart),
app.test.js (the checklist order, the preview's words, the toasts, the new-meet dialog, a hand-edit's JSON error line).

#### 9.22 checked (2026-10-21): what the first build got wrong, and the rules it now keeps (O1-O32)

Three checkers ran the build end to end, against the data rules and at 390 px. What changed:

- **Running** (O7, O8, O19, O28) is one rule everywhere (meet.js raceRunning, the panel's isRunning, main.js
  #refuseWhileRunning, the Races list): Active with a gun, and its clock (this PC's time of day minus the gun, wrapped
  at midnight) under 30 minutes, or a read in the last 20 minutes. So a gun typed a moment ago, before the first read,
  is running (Start a new meet refuses it), and a gun left from an earlier day is not (its clock is negative or hours
  old): the Races list offers Load again, and Start a new meet is not blocked by it. The panel says a running race at
  once (newMeetBlocker, the same words as the server's 409) instead of asking first and being refused; Settings shows
  the line under the button. In planMeet, R2's "running" (outputs stay; a new output on it comes in off) is Active with
  a gun AND splits behind it (reads, crossings, reads waiting) or its clock running: an earlier day's gun with no reads
  holds no output back. A race with that gun is still in use (R3: its gun is typed state), but it holds no settings back
  (R4: there is nothing to work out again), and its Check line says to clear the gun if it is an earlier day's.
- **Split names are the source's, exactly** (O4, O26): "800m" here and "800M" in TrackScore become "800M" ("split names
  written as in TrackScore: …"), never half one way. A name that another split has here (O9: the source has them in
  another order) is held on a race in use, with a Check (its reads would show under the wrong names), and a Check on one
  not in use. A source race with no splits (O12) keeps the splits here (Check); a new one comes in not Active (it would
  take its port's reads and send nothing). Every list of split names in the preview is complete (O25), old and new ("8
  splits: 0.8K, 1500m, … (was 7: 800m, …)"); a held number of splits says both lists.
- **Matches that are not by name AND event are Checks from a file too** (O10, O30): "\"Varsity Boys\" in the file is
  loaded onto \"JV Race\" here: the same event, another name. Its name becomes …: it must be exactly FinishLynx's event
  name." An output matched by its address, not its name, says so with its new name and script. A script, sections or
  decimals change on an output is a Check (O15): what it shows changes with the next split.
- **Reads waiting for a race** (O16): a new race (or a race's new port) on a port where reads wait for a race that is
  not Active comes in not Active, said: Active, it would take them. (Reads in no race still go to a new race on their
  port: RR12 sending before the races were set up is the usual case.)
- **Hand-edited files** (O13): "active"/"enabled" as "true"/"false"/"yes"/"no"/1/0 are taken; anything else is said (a
  race comes in not Active; an output's "enabled" is ignored, so a new one comes in off and one here stays). A filter
  value that is not a number, a lif flag that is not true or false: said and ignored. "splitRelayMeet": "1" is 1; 0, 1.5
  or null say what the line must be. A race the file has but can't read ("split 1 has no name, so the race is left out")
  is named in the parsed meet's leftOut, carried to the apply: a race here of that name is "stays as it is: its race in
  the file can't be read", and is never offered for removal. What is said of a new output waits until it is added (no
  "comes in switched off" for an output then left out).
- **Ports** (O17, O18, O31): config.js inputPortProblem refuses, for a port being added (Settings and a load alike),
  TrackScore's timing ports (5555, 5556, 4554-4569) and a port an output sends to on this PC; a setup that already has
  one still starts and saves. The preview tries each new RR12 port (a listen, closed at once, never a connection) and
  says a port another program has ("another copy of Split Relay?"). It says when the merged folder a load starts writing
  to had a .lif written by someone else in the last minutes, and when a port is left with no race.
- **The meet file is one click next time** (O5): a file loaded with the chooser or a drop is kept in data\meets under
  its meet name (meetFileOf: a meet file again; the copy it replaces goes to data\meets\old). Save meet setup (O22) is
  the one save of Settings → Meet setup, under the Meet name field: it saves the name (and the web port) when they
  changed, then the file; "Save meet settings" is gone. A setup with no races asks first (O23); a saved meet with no
  races is never the one-click offer. The empty Races page (O24) is alone on the page: the list card waits for the first
  race, so its actions show once and the gold one is first at 390 px.
- **The copy kept before a load** (O2) is "Back to the setup before the load at 12:52": it offers to remove the races
  that load added (opt-in, no reads only), lists them, and says which outputs and RR12 ports stay (R1: a load never
  removes them).
- **Set up from TrackScore** (O3, O14, O27): a new race takes FinishLynx's name for its event when FinishLynx wrote that
  event's .lif today (LifSync.lynxEventNames; an older file may be last meet's), else TrackScore's, said either way.
  When TrackScore's boards show a race that is not in the list it sent for its meet, that is a Problem (another meet's
  list); when it shows none, a Check; either way Apply is not the gold button. "No TrackScore output yet" says what to
  do. The toast counts races, outputs and settings apart; the meet name is a setting, not a change of a race.
- **Smaller** (O6, O20, O21, O29, O32): the toast nudges only outputs that came in off against the file's wish (an
  output saved off is not); the new meet copies config.json and reads.jsonl in the same synchronous step as
  engine.newMeet() (the journal is written synchronously), so the archive holds exactly the reads put out of use; its
  dialog says the merged .lif files stay until FinishLynx writes this meet's; a race with no change and reads is one
  line ("no change, and it keeps its 10 reads"); the banner says reads carry a time of day but no date; Help's race-day
  checklist starts with "New meet?" as the README's does, and Help explains Save, Load and Start a new meet.

O1 (a checker's own test copy listened on 5565 for 30 s, from a config.json a shell had broken) is not a defect: a
damaged config.json is set aside and Split Relay starts with the default settings, as it always has.

#### 9.22 re-checked (2026-10-21): five leftovers (O33-O37)

- **The copy kept before a load** (O33): while what that load added is still here (planMeet's `leftover`: its races,
  outputs and RR12 ports), the dialog never says "Nothing to change … matches" with Close alone: "The setup is not as
  it was before the load at 14:02: what the load added is still here (…). Tick the box above to remove the races with
  no reads, then Apply." (Apply waits, disabled, for the box; with nothing removable it says the copy does not remove
  them.) Its outputs are "not in that copy", as its races are. The toast is "Setup put back to before the load at
  14:02: 2 races removed." (applied.undo), not "<meet name> loaded".
- **An output into this Split Relay's own RR12 ports** (O34): every output a file adds or changes (TCP client or UDP,
  to 127.x, localhost, ::1, no host, or this PC's name or network addresses) is checked against every RR12 port after
  the load, including the ones the same file adds (ports are planned first): a new one is not added, a changed one
  stays at its address, one here already pointed there is not switched on, each a Problem ("Port 5925 is an RR12
  input port of this Split Relay (the file adds it): the output "Loop" would send Split Relay's own splits to it on
  this PC, and they would come back in as RR12 reads. It is not added. Choose another port in the file."). A port a
  file adds where an output here sends to this PC by its name or address is refused as 127.0.0.1 is (O18).
- **Save meet setup** (O35) says what Settings → Meet setup could not save, in the form's own words ("The meet settings
  were not saved: Port 5555 is where TrackScore takes the splits, not its web page. …"), never "the meet name" for a
  wrong web port.
- **Set up from TrackScore** (O36): when TrackScore's boards show a race that is not in the list it sent, the source
  line says so too ("showing "Women's Race", not in this list"; source.shownElsewhere), never "not showing a race now"
  above the Problem that names it.
- **Running** (O37) is one definition, public/running.js (runningNow, clockRunning), imported by the panel (isRunning,
  newMeetBlocker, the Races list) and by src/meet.js (raceRunning, so main.js #refuseWhileRunning and the plan): a read
  in the last 20 minutes counts whatever the clock says, so reads still arriving under a gun later in the day (an
  earlier day's) are a running race on both sides, and the Races list no longer offers Load meet file or Set up from
  TrackScore under it. The server imports from public\ (the panel can load only what is there).

### 9.23 Fix a runner: move times between splits, fill in missing splits (race day 2026-10-21)

The operator's words: "i also need the easiest way possible to either move athletes between splits or to fill in
missing splits".

Why. The RR12 stream of the Womens Race carried the finish line and cool-down passes (167 of the 170 runners who reached
5300m have a pass after it). A runner who missed a mat therefore had every split column full: the finish counted as the
last split. The column check (9.17 P2) never looks at a runner whose columns are all full, and Missing never lists them,
so Review showed nothing while four runners went out wrong: 403 and 512 (the finish sent as 5300m), 586 (3100m and
4400m missed: every later pass one or two columns early) and 521 (one lone read at 19:39.5, kept by the operator as
3100m from the check queue: it is 5300m). The tools to fix them existed only in pieces (a Move on a held pass, a
made-up time per row, no undo, no "not a split", no "this is the finish").

**F1. One place to fix a runner.** The runner editor, at the top of Review, reached in one step: the top bar's
"Bib or name" box (B on every page, "/" off the Dashboard), any bib button (the live feed, every Review list, the race
grid), or the route #review/<race>/<bib>. Each split is a cell (time, place, where it came from: Moved, Kept, Made-up,
Typed; a plain read says nothing), then the Finish cell. An empty cell is missing (the suggestion in grey: Enter sends
it), blocked (Check first, Place unknown, Not possible: the info line says why) or "Not yet" (no later split, no finish:
on the course or dropped out). An info line explains the focused cell; problem lines (check, look wrong, not live, a
board out of date) carry their one-click fix; Other passes lists the passes in no column; Last change has Undo. The cells
are one tab stop (arrows, Home, End), Enter sends the suggestion or opens the choices, digits type a time, Shift+arrows
move a time one split with the later ones, F and Delete open the menu on This is the finish / Not a split (a single key
never changes the boards by itself), Ctrl+Z / Ctrl+Y undo and redo, Esc closes the menu, the box, then the editor and
gives focus back to the opener. The editor and the grid call preventDefault for every key they use, so the page's keys
(1 to 7) never act on a digit typed there. Drag (mouse or pen, 6 px; Alt: only this time) onto a split, the Finish cell
or Other passes; touch never drags (a tap opens the choices; at 719 px and below the menu is a bottom sheet of 44 px
items). The editor holds still (no repaint) while the pointer or the keyboard is in it, a menu or box is open, or a drag
runs, for up to 6 s; the operator's own change always shows at once.

**F2. The decisions on a pass (pins).** A pin is { split, as, seen }, kept in the journal as 'assign' (one record type,
so an older Split Relay degrades harmlessly):
- move: the pass is that split (9.17's Move; `as` absent, a split id);
- keep: counted where counting puts it, the column check never asks again (9.17's Keep; `as` absent, null). `seen`
  (written by the editor's "It's right") silences the look-wrong check too; the check queue's Keep does not, so a strong
  flag still asks once (that is how 521 shows);
- hold: the pass stays in exactly this split; written only by "Move only this time" for the runner's other placed
  passes; a fixed point like a Move ("Kept there in Review", never "Moved"). An older version reads it as a Move to
  the same split;
- none ("Not a split"): the cluster takes no column; its reads get the outcome 'ignored' (feed "Not a split", not in
  COUNTED); taken out BEFORE lateReplacements and countClusters, so the later passes count on without it;
- finish ("This is the finish"): the earliest finish-pinned cluster's reads become finish reads (d.finishes, marked)
  BEFORE lateReplacements, exactly like a finish mat's; everything that uses the finish follows unchanged (after-finish,
  #finished, the estimates' later reference, the column check's finish method, P4). Its feed row says "The finish: you
  marked this pass as the finish in Review…". An older version reads none and finish as a Keep.
- The new record `{ t: 'unassign', raceId, bib, tod }` forgets the pin at that tod (an older version skips it).

One entry point, Engine.movePass(race, bib, { tod, to, only, from }), to a split, 'none', 'finish', 'count' (forget every
pin of the cluster) or 'keep' (keep + seen). In order: the gun (409); the pass (404 "… has no pass at that time any more.
It shows again now."); `from`, the column the operator saw it in (409 "16:10.8 is 4200m now, not 3100m: it was changed in
another window. Look again."); the rules, in words, before anything changes (same column; a timing point's split;
after the finish; the fixed points' course order (#moveProblem, with 'hold'); only: the target holds no real pass and
every other placed pass keeps time order; finish: a later made-up time, a later pinned pass, a finish mat read,
FinishLynx's finish more than 10 s away; at most one marked finish, an older one is unassigned in the same change). Every
read of the cluster with a pin is unassigned first, so an older pin on another of its reads can never win later; the new
pin goes on the cluster's first read. A Move onto an active made-up time writes `unmanual` for it in the same change:
otherwise countClusters would silently put the pass in the next column. Then the change is applied in memory and the
runner worked out again, and the post-condition checked (the pass is in column k and kept there; only: every other
placed pass kept its column; finish: d.finishRt is the pass; none: the cluster is 'ignored'). On failure the pins,
made-up times and the runner's state.rel and state.approved are restored, the runner worked out again, and the answer
is 409 "Split Relay couldn't put 16:10.8 in 4200m (out of course order | after the finish | no split left). Nothing was
changed.": nothing has been journaled or sent then. The check queue's POST /assign keeps its bodies and words and runs
through the same path (a 'check' change).

**F3. Changes, Undo and Redo.** Every action is one change (fix group): move, only, none, finish, count, keep, check,
fill, fill-many, change-time, remove, undo. Its records go in ONE journal write, each with `fix` (a number one above the
highest seen, rebuilt at replay), the first with `fixKind` and `fixText`. The same code builds the groups live and at
replay: the first time a change touches a runner, the runner's pins and made-up times are noted; at its end the inverse
is worked out by comparing the two (a pin added: unassign; changed or removed: assign the old one; a made-up time added:
unmanual; changed or removed: the OLD record again, with its own raceTicks, tod, estimated, basis, at and journal
position `seq`, plus restored: true, so a late read is judged exactly as before), and sigAfter = the runner's decisions as
a string (pins by tod, made-up times without their order numbers; reads don't change it). Undo is allowed for a runner
while its decisions are still sigAfter (its newest change); a change of several runners (Fill in N) undoes the runners
that still match and names the others ("Bib 512 was changed since: not undone."), and is refused (409, the newest
change's words and time) only when none matches. Undo writes `{ t: 'undo', raceId, fix, by, bibs, text, at }` first, then
the inverse records (fix = by). Its text says what the Undo did (F12), not the change it took back. Redo is the Undo of
the Undo, by the same rules ("Done again: " and the change's own words). Undo after a restart works (the groups
come back from the journal). Clear race data and Delete forget the race's groups ("There is no change 17 in Womens Race
(the race was cleared since). Change it by hand."). A cell the Undo would empty that an output has now (ledger or in
flight) stays filled on the boards: without `confirm` the answer is 409 { code: 'UNDO_LEAVES', leaves, error: "TrackScore
keeps 11:53.6 at 3100m (bib 586): a packet can fill a cell but never empty one. Undo anyway?" } and the panel asks.

**F4. What the operator approved goes out (#sendFixed).** After every move, assign, undo and fill (in place of the
earlier #sendApproved) and "Send bib 586 again": the runner's crossings whose time of day or column changed (an emptied
column has nothing to send), in course order, to every output whose copy differs, whatever RESEND_WINDOW_MS says (the
operator asked), as 'correction' or 'new'. Not for a race that is not Active (the .lif follows by itself), a paused split
or a column in doubt (they wait), a crossing still in its hold (convergence sends it), or a finished runner: TrackScore
sets runner.place from every packet (TrackScore-LocalCopy server/xc/xc-ingestion.ts 654-655), so a finisher gets no
split packet except a made-up one with P = the finish place; a finisher's moved real crossing waits in "Finished: not
sent live" for Send with finish place, as before, unless the operator sent the change with the finish place (F11, F12).
For the same reason the runner's furthest released crossing goes out
LAST as a place update to every output that got a packet of the runner in this action (convergence's packets of the
action count): a fill of 3100m would otherwise leave the runner shown at its 3100m place. Not for a finisher. The
approval survives retries: state.approved maps the crossing key to the content the operator approved, and convergence
skips the minute's check for exactly that content, so a fix made while an output was down reaches it when it is back;
a new content (another runner's read moved this place) ends it, and it is not saved (after a restart "Send again"
covers it). Other runners whose places changed follow the usual rules (a place update within the minute, else the stale
count and Resend); the change says how many (staleOthers), not counting this runner's own emptied cells, which it lists
apart (leftover). The toast of a fill says it ("12 other places on TrackScore are now out of date: Resend from the race
tile."); the toast of a change to a pass (Move, Only, Not a split, the finish, count, It's right, the check queue's) does
not (F12): the race tile offers Resend when it matters.

**F5. Fill.** POST /manual takes `tod` (a time of day, strictly hh:mm:ss[.d]: rt = raceTicks(tod, gun); before the gun is a
409; basis "Typed in Review as the time of day 16:36:43.6.") and `ifEmpty` (409 "Bib 403 has a made-up 5300m time already
(20:57.5): another window sent it. It shows now."; a batch row goes to skipped). A `time` of 3 h or more is refused
('"16:36:43.6" is 16 h 36 min of race time. If it is a time of day, send it as one.'; MAX_RACE_TICKS_TYPED, the same in
app.js). With no later reference, a time may be at most 10 min after the race's newest read ("… is later than anything
Split Relay has seen in Womens Race (latest read 31:05.2)"): on race day this PC's clock was hours behind RR12's, so the
old bound (this PC's clock) was skipped and a probe stored 16:36:43.6 as 16 h of race time. The feed says ".lif" only for
a made-up time that is used. Nothing is ever made up past a runner's last real read unless the runner has a finish
(FinishLynx, a finish mat, a marked finish): those cells are "Not yet", never in Missing or Fill in N ("Left out: no read
after their last split and no finish, so they may have dropped out: 432, 452, …"); a typed time there asks first ("Bib
452 may have dropped out"). The panel reads a typed text with parseTimeEntry: three parts with an hour of 3 or more is a
time of day, anything else a race time, a bare number is refused; the line under the box says which.

**F6. Splits that look wrong (src/review.js legFlags, advice only).** Kept apart from CHECK_RULES (which holds passes);
it never holds or sends. FIT_RULES = { nearest: 30, minRefs: 5, longAbove: 1.6, shortBelow: 0.6, strayBelow: 0.25,
fitWithin: 1.5, betterBy: 2 }. Looked at: real crossings counted by Split Relay (counted, earliest) or kept from the check
queue (not seen); not Moves, holds, replacements, made-up and typed times, timing points (located runners) or the column
check's suspects (a held cell shows the check's words). For each such crossing at column b: a = the nearest earlier kept
column (none: the first split is the column check's, 9.18 R2); refs = up to 30 other runners nearest in time at a (two
pointers over the column's sorted real times) with a real time at b after it, at least 5; ratio = leg / median of theirs:
long above 1.6, short below 0.6. One flag per runner, the first (later legs are measured from a wrong anchor); a crossing
the operator said is right only notes a silenced flag and the scan goes on. A long leg is fitted to every later column
and to the finish (only for the last split or the runner's last pass; the refs' finish is FinishLynx's, a finish read or
a marked one, else, when the stream carries finish passes (at least 3 runners, and half of those with a real last split,
pass again within 2x the field's median last gap), their first pass after their last split); the best |ln fit| is
suggested when within ln 1.5 and at most half of |ln ratio|. A short leg below 0.25 suggests Not a split. Words:
"16:10.8 looks like 4200m, not 3100m (missed 3100m?): 6:45 after 2400m, where runners of the same pace took 2:44.";
"24:17.3 looks like the finish, not 5300m: 7:16 after 4400m, where runners of the same pace took 3:29 to 5300m."; "You
kept 19:39.5 in 3100m, but it looks like 5300m (missed 3100m, 4200m and 4400m?): …"; "8:31.0 comes soon after 2400m
(0:28; …). A stray pass?". It runs inside the Review list's cache (by state.version), never on the read path.
Measured: on the real race exactly 403 → the finish, 512 → the finish, 521 → 5300m, 586 → 4200m, nobody else (the
highest clean ratio 1.40, the lowest 0.88; at long 1.4, 1.6 and 1.8 the same four); after 586's first Move, 22:28.8 →
5300m (the finish is no candidate: later passes exist). Synthetic races (review.test.js makeRace with walkers, six
courses including a 7-split 6K, the stream carrying the finish and a cool-down pass, one runner in ten missing one mat
after the first, 60 seeds): long 1.4: complete runners flagged 1.04 %, missed mats flagged 95.1 %, right suggestion
95.8 %; long 1.6: 0.36 %, 90.4 %, 95.8 %; long 1.8: 0.12 %, 82.4 %, 93.3 %. 1.6 is kept. A missed mat between two splits
close together (4200m to 4400m here) is the one the check can't see: the next pass's leg is only a little long. Timing:
600 runners x 8 splits, the Review list with the column check, estimates and the look-wrong check about 100 ms, grid()
about 100 ms first and 50 ms cached (logged by the test, bound 1 s).

**F7. Views and API.** RunnerView gains, per column: how (counted, earliest, moved, hold, keep, replaces, made-up, typed,
mat), kind (read, moved, hold, keep, replaces, made-up, typed; missing, blocked, not-yet), passTod (the handle for a Move),
flag, stale ({ text: "TrackScore: 16:10.8" }: an output has another time or column, the runner not finished) and leftover
(an empty column whose cell an output still has, from the ledgers and orphans); per pass: col, inColumn, where, pinned
(move, keep, hold, none, finish), targets (every split: ok, why = the refusal of F2, effect = a preview made by running
the count on the runner's clusters with the new pin: "22:28.8 → 4400m, 26:22.1 → 5300m, 29:45.0 → extra pass", or
"replaces the made-up 4200m time"; fit and best: "fits the pace"), only, finishOk { ok, why, effect: "26:22.1 and 29:45.0
become after the finish" }; and finishBy (lynx, mat, marked), finishMarkedTod, fillable, alsoIn, changes (the last 5:
fix, at, atText, kind, text, undone, undoable (only the newest, while it matches), why) and problems (check, flag,
missing, not-live, stale, leftover, finish-differs, unused-manual) in words. Review gains flags[] (the unsilenced ones)
and counts flagged, pinned, madeUp (RaceView.review too). Every action answers `change`: { fix, kind, text, bibs, cells
(before / after per cell), leftover, sentTo, lifOnly, notLive, staleOthers, undoable, leaves, notes }. grid(race) gives
the race as rows of compact cells (null and false fields left out) with tiers: 0 a held cell, 1 a flag, 2 missing and
fillable, 3 the boards out of date (stale, leftover, not live with the finish place known), 4 missing but blocked, 5 a
made-up time not used, 6 a silenced flag or changed by the operator, 7 stopped (no finish, no read after split L for longer
than max(3x the field's median leg L→L+1, 120 s), by the race's newest read: "No read after 2400m (9:16.5)"), 8 clean;
the rows are cached with the Review list, the delivery fields looked up on each call; rev is an FNV hash of the cache
key and state.deliveryRev (bumped by #send, #ack, #dropFlight), and ?since=rev answers { rev, unchanged: true }.
find(q) matches bibs by bibKey and names or teams (from 2 characters, any case or accent) in every race: bib matches
first (the Active race, then the newest read), then names A-Z, 20 at most. Routes: GET /api/find, GET /grid (read-only:
LAN viewers may use them), POST /runners/:bib/move, /runners/:bib/send, /undo (local only, same origin); main.js reads
FinishLynx's folder first before move, undo, send and manual, so a runner who just finished is never sent a split place.

**F8. Review.** Two views, remembered per viewer: To do (the queues, with the new "Splits that look wrong": the
suggestion as the row's button and "It's right"; Missing splits with a chip per split and "Fill in N missing…", a list to
check with a tick per row and the runners left out in words, sent as one { items } request, one change) and All runners
(the grid: problems first, filters To fix, Changed by you, No read lately, a bib or name box, the order; a split's
header "3 missing · Fill…"; a missing cell fills in place, any other cell opens the editor with its choices; role grid
with arrows, Home/End, PgUp/PgDn, N / Shift+N to the next problem; per-row paint, content-visibility, the first 100 rows
then "Show all"; while the pointer or the keyboard is in it rows update in place but keep their order, "Order changed:
re-sort"). Above both: the paused-split bar, a race not Active or without a gun, and, when nobody is known to have
finished but the stream carries finish passes, "Split Relay doesn't know who has finished …". The live feed's bib opens
the runner (its own button: the row still opens its detail), and its detail has "Open runner". The race tile's Review
badge says "· 4 look wrong", and the nav badge counts them.

**F9. 390 px.** At 479 px and below the logo loses its name, the runner box shares the top row, the connection light is
a dot (its word for screen readers), the editor shows 3 cells per row with the time box full width; the grid becomes a
card per runner (a square per split and the finish, each with its words for a screen reader) whenever the table does not
fit (gridFits: width >= 300 + 78 per split); the Fill dialog's list scrolls down only. No sideways scroll anywhere
(checked by hand at 390x844 and 1280x800).

**F10. Clear race data keeps the pins (a rule change).** A Clear writes `keepPins: true`: it forgets the race's made-up and
typed times and its changes, and KEEPS its pins. The operator cleared and replayed this race twice on race day; Clear also
wipes the ledgers, so the Replay sends every crossing again as new, and each Move, Not a split or finish mark would have
been lost, the original wrong cells (403's and 512's finish as 5300m) going out again. Pins are keyed by the reads' times
of day, so they apply only to the very reads the Replay brings back (a false start's new reads have other times). Made-up
times are not reads: after a false start they would be wrong, so they go. A clear without keepPins (every journal before
this version, the race-day journal with its clears at 2886 and 5772 among them) forgets everything as before, so an
existing journal derives exactly as before. The Clear dialog says it: "Your Review changes to 4 runners' passes (Move,
Not a split, finish) stay: they apply again when RR12 replays the same reads. The 2 made-up and typed times are
forgotten: fill them in again in Review after the Replay."

**F11. After the checks (same day, second round).** Checkers drove the first build on copies of the race-day data;
what they found, and what changed:
- The boards' place after an Undo or a Redo (466, 432, 521): TrackScore takes the runner's place from the newest
  packet, and an Undo that puts back a cell the board still has sends nothing, so TrackScore kept the place of the split
  the Undo emptied. #sendFixed now ends with the runner's furthest split also when nothing else went, whenever the
  change filled, moved or emptied a cell of the runner and an output's newest packet of the runner (#newestCopy: the
  highest packet number of this run, else the newest landed) is not that split as it is now; "Send bib 586 again" always
  does this check.
- A fix on a paused split (or a column in doubt, or a crossing still in its hold) is approved for its time and column
  (state.approved { sig: null, cell }): on Play it goes out whatever the minute says, with the place it has then.
  Before, the approval was written only for what went out, so on Play the minute rule held it back and the board kept
  the old time.
- A real read that replaces a made-up time seconds after the fill was not sent: the minute ran from the first copy of
  the cell, which went out before a Move emptied it. A ledger entry now keeps `fixedAt`, when the operator last put a
  time in the cell (a packet of #sendFixed, or an approved one, landed; saved as the row's 10th field, which an older
  version ignores), and the minute runs from the later of the two (#windowFrom). The feed's "first sent N s ago" counts
  from the same moment. A late read into a cell a Move emptied and nobody filled is still stale until "Send again" (as
  F4 said). After an earlier split goes out because of the operator (approved, or in such a minute), the runner's
  furthest split goes again last, from convergence too. A split the relay sends by itself after a later one of the
  same runner (reads that came out of order, Play of a pause with no fix in it) is as before: changing that core rule
  would add packets to every race; it is noted here.
- The lap split (LS) of the next split after one a change filled or emptied is sent again to the outputs that have it
  (Karmarush shows it; TrackScore does not read it). The content signature leaves LS out, so the crossings whose leg
  changed are worked out before and after the change (#lapSig).
- Two splits close together (507 with its 4200m read taken out: 15:32.0 is really 4400m, 18:41.2 5300m, the finish pass
  5300m): only the 4200m-4400m leg looks long, and the flag said "18:41.2 looks like 5300m", a wrong one-click fix.
  legFlagOf now also tries the pass before a long leg (shiftedBefore): when that pass, counted or kept from the check
  queue, fits a later split up to b at the runner's pace better than where it is, and with it there the long leg's pass
  fits a split after it, and both together fit better (in log terms) than the long leg's pass alone in a later split, the
  flag is on that earlier pass: "15:32.0 looks like 4400m, not 4200m (missed 4200m?): then 18:41.2 fits 5300m. As
  counted, 18:41.2 comes 3:09 after 4200m, where runners of the same pace took 0:56 to 4400m." Measured on 60 seeds of
  the test's generator: complete runners flagged 0.5 % before and after, missed mats flagged 90.8 % before and after,
  right suggestion 96.0 % before, 99.0 % after; the real race gives the same four flags. The menu marks a split "fits the
  pace" only for a pass that does not fit where it is (a leader fits every split a little short of the runners nearest
  in time) and lists the splits a pass can go to first, the best one at the top, the ones it can't after them.
- Fill all made times up from a pass that looks wrong (521: 4200m to 5300m from 19:39.5 kept in 3100m), which then
  stood in the way of the fix. An estimate measured from a flagged pass (the runner's unsilenced flag at a split before
  the missing one, or at the next split after it) is not sent: "Check bib 521's 3100m first: 19:39.5 looks like 5300m.
  Move it, or choose It's right; then this split can be filled." (Review, the editor's cell "Check first", the grid,
  POST /manual without a time, Fill in N's "Left out"); a typed time is the operator's own. And a Move takes out the
  made-up and typed times it would come out of course order with, in the same change (its preview says "takes out the
  made-up 4200m time"; Undo puts them back), as it already replaced the one in its own split.
- Accepting the suggestion in a cell's time box sent it as a typed time (estimated false, the basis lost): the text as it
  was put in the box now goes as Split Relay's estimate.
- A pass moved with an earlier time showed as a plain read: counting puts it in another split because of the operator's
  decisions on the runner's other passes, so its how is 'shifted' (counted as before; the column check and the look-wrong
  check take it as counted) and its cell says "Moved" ("moved there with an earlier time in Review"). Where it would be
  is where the runner's passes alone put it, without the pins and the made-up times (F12).
- A finished runner's Move went to the .lif only (then Send with finish place and its dialog): now the panel asks once
  ("Bib 507 has finished: send with the finish place?") and sends the move with `withFinishPlace`: the splits it changes
  go live with P = the finish place, as Send with finish place sends them. Without a known finish place (merged .lif
  files off, as on race day) nothing of a finisher's can go live: the toast says so. That is P4, unchanged.
- A Move far from the runner's pace (586's first pass, 2:47.1, as 5300m: P1 live) is asked first: each target carries
  `pace` ('early' / 'late': the leg far shorter or longer than the runners' of the same pace, FIT_RULES shortBelow /
  longAbove; for a first pass, far outside the field's own times at that split); the dialog says it and "Move anyway".
- The panel: focus stays on the cell through a keyboard Move (the menu gives focus back to its cell; a redraw that drops
  focus from the editor puts it on the editor's cell, not the page heading); the info line under the cells is worked out
  from the focused cell of the runner as it is now (it spoke of another runner or a changed time), and for a cell with a
  problem line it says "looks wrong: why, and the fix, below" instead of the same sentence twice; another runner opened is
  drawn at once (the editor's hold-still never keeps the one before); B and the bib of the runner already open goes back
  to its cells; Back (or the race's own link) closes the editor; the menu's focused choice scrolls into view; two emptied
  cells are one sentence in the toast, and an Undo's toast says a finisher's words once.

**F12. After the re-check (same day, third round).** Checked on a copy of the race-day data with its own ports and a
capture listener; what was still wrong, and what changed:
- A finisher's change sent with the finish place went live only for cells released before: #sendFixed left a crossing
  with no release to convergence, which never lets a finisher's real crossing go (521: 19:39.5 to 5300m went nowhere and
  waited in "Not sent live"). Now every cell such a change gives a new time or column goes from #sendFixed with P = the
  finish place, released there as Send with finish place releases it. The change is kept with `byFinish` (journaled as
  `byFinish: true` on its first record, the 'undo' record for an Undo; an older Split Relay ignores it), and its Undo and
  Redo go the same way, after a restart too (507's Move sent 4400m and 5300m with P 22, its Undo and Redo nothing). A
  change of a finisher not sent with the finish place, and its Undo, still go to the .lif only.
- After a Move then a fill, the shifted passes were plain reads again: the count they were compared with held the made-up
  time, which stands where the Move emptied the split, so it put them where the Move did (586: 22:28.8 and 26:22.1). The
  comparison is now the runner's passes alone, without the pins and the made-up times: they stay "Moved" while that puts
  them in another column. A real read of the emptied split (586's 11:49.6) makes the passes alone put them where they are,
  and they are plain reads again.
- The words. An Undo says what it did, made from the decisions it put back: where the passes whose pins it changed are
  now ("Undone: 24:17.3 is the 5300m split again"; one that stays: "Split Relay counts 16:10.8 again (3100m)", "16:10.8
  is kept in 3100m again"; the passes "Move only this time" held say nothing), the other passes it moved ("22:28.8 →
  4200m"), the made-up and typed times it took back ("the made-up 4400m time (17:30.5) taken back", "3 made-up times
  taken back") or put back ("4400m is 17:30.5 again", "the made-up 4200m time (15:18.7) is back"; not one a real read
  replaces at once). Before it said the change it took back ("Undone: 24:17.3 is the finish now"), which read as the
  opposite. A finisher's Undo toast adds "The boards keep what Send with finish place sent: send with the finish place
  again to put the old times back." only when the change's `finishKept` lists a cell it filled whose board copy carries
  the finish place and another time (403's finish mark undone with the .lif off said it, though nothing had gone with a
  finish place); UNDO_LEAVES marks a cell whose board copy carries the finish place (`withFinishPlace`), and the dialog
  says it only then. A Move's toast no longer counts the other places it put out of date (F4).
- The lap split. A real read that replaces a made-up time (or any packet that gives an output a new time for a split)
  changes the leg (LS) of the runner's next split; convergence now sends that next split again, last in its pass, to an
  output that has it as it is now (same time, column and place: only the leg differs), unless it went in the same pass
  (586: 4200m with LS 4:21.193 after the real 11:49.6; 224: 4:06.000 after the real 11:58.0). A finisher's are not sent
  (the next split of a finisher goes with the finish place only, by the operator).
- The runner's furthest split after a real read that replaced a made-up time inside the cell's first minute: convergence
  took "the operator's" to mean "sent after the cell's first minute" (224's 3100m: only the 3100m packet went, and
  TrackScore showed the 3100m place). It now means: approved, or sent within a minute of a time the operator put in that
  cell of that output (#fixedSince, the latest `fixedAt` of its copy or its packets on the way). And what convergence
  hands over during a change (#runFix: the crossings the change gave a new time or column) is the operator's time too
  (`fixedAt`): before, a fill sent inside the cell's first minute went out by convergence without it, so a real read a
  minute later was not even sent. While a change goes out, convergence leaves the furthest split to #sendFixed (no
  second copy).
- Esc on a confirm dialog (the Move against the pace, a finisher's Move, Undo anyway ...) left the focus on the page:
  the dialog's close event came most of a second after the Esc, or never while the page was not drawn, and the focus
  went back to the cell only then. The dialog's cancel event is now its Cancel button: it closes the dialog and puts the
  focus back on what opened it at once.
- Start a new meet forgets every race's fixes (pins, made-up times, changes): checked, and now tested live, after a
  stop and a start, and after a kill.

What an older Split Relay does with the new records: 'assign' with `as`: hold is a Move to the same split; none, finish
and keep (seen) are Keeps; 'unassign' and 'undo' are skipped; `fix`, `fixKind`, `fixText`, `restored`, `keepPins` and
`byFinish` are ignored (a keepPins clear forgets the pins there).

Unchanged: the column check's rules, estimateGaps, the late-read rules (lateReplacements), the convergence minute for
what the relay changes by itself, Send with finish place, the gun (9.21), config.js. (F13 changes the column check, the
minute for what reads change, and the furthest split last for what the relay sends by itself.)

Not done: a finish-proximity tolerance (a pass a hair before FinishLynx's finish counts as a split; the flag and "This is
the finish" within 10 s cover it, no measurements to set one); typing a finish place (so a finisher's fill waits for
FinishLynx's file when merged .lif files are off); holding passes on a look-wrong flag; moving a made-up time by drag
(Change time… does it); a bulk "forget all fixes"; the furthest split last for what the relay sends by itself (F11; done
in F13).

Tests: review.test.js (the real race as a times-only fixture with bibs renumbered: exactly the four flags and their
words, then 586's Move, fill, Move as suggested and fill with the packets' laps to go and the furthest split last, 403's
finish mark, 521's Move, a restart and an Undo with UNDO_LEAVES then Redo; Not a split with corrections past the minute
and read by read = rebuild = restart; This is the finish and its refusals, the finish place; Move only and its refusals;
a Move onto a made-up time and its Undo with the original journal position; count after a Move; the post-condition
rollback; Undo's rules, partial Fill in N, after a Clear; #sendFixed for an output that was down, a finisher, a race not
Active; fill by time of day, the 3 h cap, the race-clock bound with this PC's clock 6 h behind and ahead, ifEmpty; Clear
keeping the pins against an old journal's clear; legFlags by hand and on synthetic races; the views; 600 x 8 timing; a
randomized test of every action with Undo, Redo and a Clear + Replay, read by read = rebuild = restart, every packet
sendable; F12: a finisher's change with the finish place, a cell never sent before, Undo and Redo, after a restart;
finishKept and withFinishPlace; "Moved" after a fill; the next split's leg and the furthest split after a real read inside
the cell's first minute), engine.test.js (F12: a new meet forgets the fixes, live, after a restart and a kill, and a
Replay of the old reads is counted as read), server.test.js (find, grid, move, send, undo, manual with tod and ifEmpty,
their words, LAN viewers), app.test.js (the words equal to the server's, parseTimeEntry, cellModel, the menu, fixToast
(F12: no other places in a Move's toast, undoFinishNote), Esc on a confirm dialog, fillAllPlan, findPick,
gridFits and gridView, the editor's keys, the badge, the Clear dialog, a real Split Relay's runner view), e2e.test.js (a
Move after the minute reaching a TrackScore stand-in in its new column, Undo after a kill, Redo, a fill replacing the
emptied cell then the furthest split, the merged .lif, a finisher's Move waiting for Send with finish place). Checked by
hand on a copy of the race-day data with its own ports and a capture listener (586, 403, 512, 521 fixed; Fill all for one
split; Undo, a forced restart, Redo; 390x844 and 1280x800).

#### 9.23 F13 (2026-10-27): a missed split, added in one change; what reads change later

The operator's words: "what i do want tested is what happens if we have to add someone's split because they are
missing at a certain point. It needs to resend all points effected automatically with the correct Laps to go", and
earlier "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets. A checker drove
this build's predecessor on a copy of the race-day data (the real Womens Race, 179 runners, the RR12 stream carrying the
finish line and cool-down passes) through two captures and TrackScore-Master's own ingestion: adding a missed split was
two changes (Move, then fill) with wrong lines on the boards in between; a missed last split could not be fixed at all
with merged .lif files off ("This is the finish" made the runner a finisher whose place nobody knew); the finish pass
let held runners go out a column early; a late read after the cells' minute changed nothing on the boards. What
changed:

- **"Missed 2400m: add it", one change** (Engine.addMissed; POST /api/races/:id/runners/:bib/missed { splitId, passTod?,
  count?, time? | tod?, basis?, withFinishPlace? } -> { change, added, runner, review }; main.js reads FinishLynx's
  folder first). The pass in that split moves on `count` columns (default 1) with the later ones: a Move by the rules of
  a Move (#moveRules: its refusals, the made-up times that give way), or, past the last split, its decisions are
  forgotten and it is an extra pass (never laps to go 0; a later pass the operator placed refuses it). The missed
  split(s) get the suggested time, or the time typed (`time` a race time, `tod` a time of day; one split only): the
  stretch from the split before (or the gun) to the pass that moved on, or past the last split to the runner's finish
  (else that pass: the stream's finish pass), estimated by estimateGaps exactly as the runner editor showed it
  (#missedPlan, the same function for the view and the action). One journal write ('assign', 'unassign', 'unmanual' and
  'manual' records, fixKind 'missed'), one Undo; #runFix sends every changed cell to every output (#sendFixed), each in
  its column with its leg, the runner's furthest split last. A missed last split whose pass was marked as the finish
  (the cell empty) works too: that pass is the one that moves on, an extra pass again, so the runner is not finished for
  Split Relay and the split goes with its own place: with merged .lif files off this is the only way to put the right
  5300m on the boards (nobody's finish place is known), and the "This is the finish" choice says so when no finish place
  is known ("the boards keep 22:19.4 in 5300m", or "5300m stays empty on the boards" when the check held that pass:
  463 on the replay). Otherwise the rules of a fill: a finisher's goes with the finish place
  (the moved real splits too with `withFinishPlace`: the panel asks first) and is refused while that place is unknown; a
  paused split's waits for Play (approved); a race not Active gets the .lif only. Refused in words before anything
  changes: another window's change (`passTod`), a made-up or timing-point cell ("change that time instead"), an empty
  cell ("Send its time instead"), a typed time out of the stretch, a run of missed splits with one typed time, a
  suggestion measured from an earlier pass that looks wrong, or a pass that looks like it goes further than `count`
  splits ("… missed 3100m, 4200m and 4400m? Add them together, or type the time."). Its words: "Missed 2400m added
  (8:36.7, made up); 11:05.9 → 3100m, …; 22:41.8 is an extra pass now". Post-condition as for a Move (#missedCheck).
- **Where the mat was missed** (#missedHint): the column check's first move past an empty split (its `from`, `to - from`
  splits), else the look-wrong flag's suggestion (a later split, or the finish: n - its column). RunnerView columns[]
  `missed` { count, names, here, by, reason, ok, why, typed, splits (each estimate and basis), effect ("16:10.8 →
  4200m, … 29:45.0 → extra pass", previewPlaces), passTod } for every cell with a pass (not a made-up time or a
  timing point; count 1 where nothing points) and the marked-finish last split; RunnerView `missedHint`; Review
  checks[] (the first row of the runner) and flags[] `missed` { splitId, splitName, count, names }; find's matches
  `missed` ("7 of 7 splits · missed 3100m?"). The
  panel: the cell says **Missed here?**; its menu's first choice is "Missed 2400m: add it" (then "type its time…", the
  check's or flag's own Move after them), in every other pass cell's menu under "A mat missed it"; the editor's problem
  lines, the check queue's rows and Splits that look wrong have it as their one click; the empty blocked last split
  after a marked finish opens these choices instead of a time box.
- **The finish as a column of the column check** (review.js columnCheck, finishColumn). Race day's root cause: a runner
  who missed a mat had the finish pass in the last split, every column full, and 9.17 P2 never looks at such a runner,
  so the hold that kept their passes off the boards on the course was let go by the finish pass (seven runners of the
  replay released at once a column early; the cool-down pass did the same for 451). When the stream carries finish
  passes (finishPassesIn, below), column n is the finish: its leaders' reference and its tail are the field's finish
  passes (each runner's first pass after its real last split within twice the median last leg, or FinishLynx's finish),
  its field fraction 1. A runner whose last column holds a counted pass is a candidate, and that last pass alone may be
  placed at the finish (at most one more missed mat than counting, as always). So a held runner stays held when the
  finish pass comes ("Looks like the finish, not 5300m (it moves with the pass before it)"), the second missed mat after
  a fix is held instead of going out (problem 3: 447's 19:46.3 in 4400m), and a missed last split is held ("Looks like
  the finish, not 5300m (missed 5300m?)"). Measured on the synthetic races of review.test.js (30 seeds, one runner in
  ten missing one mat, one in four a cool-down pass): runners with every mat read held at the end 0 of 4,271, held for a
  while on the course only as before (lone first passes, 53, never by the finish column); a missed first or middle mat
  held at the end 295 of 297, all with the right placing; a missed last split 156 of 164, all to the finish. On the real
  race: 403, 512 (the finish in 5300m) and 586 held before anything goes out, 521 flagged (the operator kept its lone
  pass on race day). The engine: the held entry of a move to n has `to: null` ("the finish"); Keep all keeps it; Move
  all leaves it (it moves on when the passes before it move); a suspect's other splits stay fillable when their stretch
  does not touch a held pass (#stretchHeld: 586's 3100m after its first Move, its 4400m still in doubt).
- **Whether the stream carries finish passes, while it comes in** (finishPassesIn, the column check's and the look-wrong
  check's test alike): at least 3 runners passed again soon after their real last split, and no fewer than those who
  did not although they got there long enough ago to have done it (twice the median of those last legs before the
  race's latest pass). The test before (half of all the runners with a real last split) said no while the field came
  in, most of it between the last split and the finish: a held runner among the first half of the finishers went out a
  column early at its finish pass, and was held again later (the replay of this build's first version: 8 of the 12 who
  missed one mat, 405, 593, 570, 428, 443, 236, 429 and 498, their wrong lines on both boards before the fix; with
  this test none of them, and of all 16 only 428's and 231's 4400m pass went out as 4200m, on the course: two splits
  200 m apart, the course method as before). On the synthetic races: held when the finish pass filled the last split
  and let go after it, 1 of 239 (113 before) for a missed first or middle mat; a missed last split whose finish pass
  went out as the last split, 9 of 164 (90 before: among the first three finishers, before 3 have finished, and at the
  very back).
- **Two missed mats in a row and a cool-down pass** (451): every column full, so the column check has one more column
  only (the finish) and places each pass one split on ("Looks like 2400m, not 1500m (missed 1500m?)"); the one click
  added 1500m alone and sent 10:58.9 (its 3100m) as 2400m, and nothing said more after it. The look-wrong check also
  judges a held runner as counted (Legs `heldFlags`, never listed as a flag): when the check placed a pass at the finish
  and the leg check puts the first moved pass further on, #missedHint takes its count and words, and Passes to check
  and the runner editor say where each later pass goes with it (#heldWords; past the finish "An extra pass, not 5300m
  (it moves with the pass before it)"): "Looks like 3100m, not 1500m (missed 1500m and 2400m?): 8:21 after 800m, where
  runners of the same pace took 2:17", one click, both made up, 22:28.7 and 28:02.4 extra passes.
- **The Undo of a held runner's fix** (UNDO_LEAVES leaves `held`): its passes go back to the column check, held, and
  nothing is sent for them, so the boards keep what the fix sent until the operator chooses. The Undo asks first ("…
  (bib 570): Split Relay holds bib 570's passes again (Passes to check) and sends nothing for them until you choose.
  Undo anyway?"; the panel's dialog, undoLeavesDialog, says the same); before, it said nothing. The runner's furthest
  split out of doubt goes last again (its place before the fix).
- **A read that gives a cell another time goes out by itself, whatever the minute** (convergence, retimedByRead: another
  time of day with the same gun, column and split count, outside a rebuild). A late read of a missed split that moves
  the runner's later passes on (482: its 3100m read 66 s after the stream), a real read that replaces a made-up time a
  minute after the fill (498), an earlier backup read: before, these waited for Resend (stale). A place alone (another
  runner's read) keeps the minute (an old split's place would become the runner's place on TrackScore), and so does
  what a setting changed (the gun, the number of splits, an earliest time: a rebuild, Resend). The feed: "Counted again
  after a late read: re-sent as place 96 with this time (16:06.0 was there before)."
- **The runner's furthest split last, for what the relay sends by itself too** (F11's "not done"): after any packet of
  a runner for a split that is not its furthest released one (a place update within the minute, reads that came out of
  order, Play, a late read), that furthest split goes again, last, to that output. In the replay 81 of 177 runners ended
  with an earlier split's place on TrackScore. A runner whose newest packet is its furthest split gets nothing more.
- **The next split's leg after a first copy too**: an output given a split it never had (Play of a pause, an output back
  up, a late read) gets the runner's next split again when it has it (its LS was measured across the gap), as for a
  new time (F12).
- **A finisher's next split after a fill** gets its new leg with the finish place (#sendFixed `refresh`, P = the finish
  place, only where the output has the split with its time and column): 428's 4400m kept LS 5:12.631 after the
  made-up 4200m; its Undo too.
- **Estimates use the stream's finish passes**: #refRunners gives a reference runner with no known finish its first
  pass after its last split (the look-wrong check's field), for the Review list, a single fill and "Missed …: add it"
  alike: 463's 5300m from 4400m and the finish was "evenly spaced: no other runner has a time there yet" (18 s early)
  with 169 runners' 5300m times there; the words of that fallback say what is missing ("no other runner has times at
  both of them and at 5300m yet").
- **Words**: a pass moved with the one before it is "moved there in Review, with the time before it" (it read as if
  the time changed); the finish of a runner Split Relay knows no finish for is "Not known" / "Finish not known", not
  "Not finished"; a pass after the last split in Other passes is "After the last split"; a blocked cell waiting for a
  finish place opens no time box and no dialog that says "place ?" (fillCell refuses in words before it); the
  suggestion put in a blocked cell's box goes as the estimate; the toasts of a fill (the editor's, Fill in N, a Review
  row) and of "Missed …: add it" say how many other places on TrackScore are now out of date (F4 said so; only the
  change's toast did); the feed says "It is in the merged .lif." only while merged .lif files are on.

What an older Split Relay does with these records: fixKind 'missed' is kept as the change's kind; its 'assign',
'unassign' and 'manual' records are the ones it knows.

Unchanged: lateReplacements, Send with finish place, the gun (9.21), config.js; the minute for another runner's place.

Not done: other runners' places at old splits after a fix are not sent by themselves (each would need its furthest
split after it, and with merged .lif files off a finished runner's would replace its finish place): the toast says how
many and the race tile offers Resend; typing a finish place; a missed mat between two splits close together is placed
on the wrong one of the two by the column check in 3 of 297 synthetic cases (as on the course before); the first three
finishers have no finish column yet (3 finish passes are its evidence); a runner the course method lets go on the
course (58 of the 297 synthetic missed first or middle mats, before their finish pass) goes out a column early as
before 9.23 F13, and is held again by the finish column when it comes.

Tests: review.test.js (finishPassesIn; the finish column on synthetic races: the figures above, live and at the end;
451's two in a row with a cool-down pass (one click, both made up; its Undo asks, held); the real race: 403, 512, 586
held, 521 flagged, each with its one fix, and kept as counted the race-day flags; 106 (two splits close together) held
at the pass counted in 4200m and fixed in one change; "Missed …: add it" on the real race: 586 twice (the second missed
mat held after the first fix), 403 (merged .lif off), 512 after This is the finish, 521 (three in a row), every line on
two outputs alike with its laps to go and leg, the furthest last, the journal, a restart, Undo with UNDO_LEAVES, Redo;
its refusals, a typed time, a finisher with and without the finish place, a paused split, a race not Active; a late read
after the minute; the furthest split after a place update; a finisher's leg after a fill and its Undo; the .lif words),
engine.test.js (a backup read after the minute, a place alone stale; reads out of order and the furthest split),
server.test.js (the route, its words, LAN viewers), app.test.js (the menu, "Missed here?", the toasts, the words, the
Undo dialog of a held runner's fix), e2e.test.js (through the app with a TrackScore and a Karmarush stand-in: held past
the finish pass, one click, the same lines on both; a late read after the minute on both).

#### 9.23 F14 (2026-10-28): how many mats in a row; the real cause; recovery; the counts

The operator's words, as for F13: "what i do want tested is what happens if we have to add someone's split because they
are missing at a certain point. It needs to resend all points effected automatically with the correct Laps to go";
Karmarush must get exactly what TrackScore gets; the easiest way possible. An independent re-check of F13 (the real
Womens Race with chosen reads taken out, two captures, TrackScore-Master's own ingestion; runs run2, FLIP, runF, runL,
runM and runD) found: with two mats missed in a row and no cool-down pass the one click added one split and sent the
runner's later splits a column early and its finish pass as 5300m (runD: 459's 4200m as 3100m, its finish as 5300m
P157; 507, 524, 438 alike; runM's 459 on the course too, and its Undo offered the same); the way back was hard (524's
real 4400m typed was refused: "not after 4200m (16:47.7)", a made-up time; 459's and 507's real 4400m taken as Not a
split, the next suggestion after the wrong fix: "16:12.8 comes soon after 3100m … A stray pass?"); out-of-date counts
that contradicted each other (a toast "116 other places on TrackScore" for 58 on each of two outputs; the race tile 2,200,
its Resend dialog 1,230, its toast 1,223); "Sent as place 109" for a made-up time whose line said P 106; the note of a
held pass that went out ("After a Move, send the made-up 3100m time") beside the one click; four more yellow buttons
under the one click (457); a finisher's newest line an earlier split after a fill (runF 593) and after a restart (428).
What changed:

- **How many in a row, from all of the runner's later passes** (review.js missedCounts, COUNT_RULES; engine
  #missedCountOf). The column check places a pass at most one split further than counting, and a look-wrong flag
  measures one leg: two missed mats in a row looked like one (F13 took the flag's count only when the check placed a
  pass at the finish, i.e. with a cool-down pass). Now, for each count from 1 to n - k, the pass in column k and every
  later pass (in a split or past the last one) move on that many columns; past the last split the first is the finish
  when the stream carries finish passes (or within 10 s of the runner's known finish: then the finish is measured last),
  the rest extra passes. Each is measured as the look-wrong check measures a leg (legFits: the median of the same
  stretch of the 30 runners nearest in time at the crossing before it): the first against those runners, each later
  one as a change from the runner's own pace on the leg before it (a runner who fades over the last legs fades whatever
  the count). Costs in log terms: a pass worse than FIT_RULES.fitWithin costs that much however far off (a second
  missed mat further on misfits every count alike), an extra pass 0.2, each mat after the first 0.1 (one missed mat is
  likelier than two). A count is out where it puts a pass where nobody has been yet (the column check's rule; a runner
  among the first five there can't be measured yet: open), before the leaders, well after the back of the field (the
  first split missed: no crossing to measure from), or between the last split and a known finish; and where the pass
  that moved on first does not fit (within fitWithin). One count is **sure** when it costs at least 0.15 less than any
  other and none is open: the one click. Two within 0.15: both offered (`alt`), neither as the one click, "Split Relay
  can't tell which". Three, or a count that can't be measured yet: not sure, the best one offered. Measured (the tests):
  on the real race, every complete runner with one, two or three mats in a row taken out at every split, 3,006 cases at
  the end: the right count sure for 2,960, two offered for 45 (the truth among them), never a wrong one; right after the
  passes that moved on (5,598 cases) a wrong one sure twice, both the race leader with its first three mats missed. On
  synthetic races (one, two, three in a row anywhere, the finish pass in the stream or not, one in four a cool-down
  pass) a wrong count for 7 of 2,020 and 8 of 1,265 at the end (walkers and the first split missed: no crossing to
  measure the first pass from), one missed mat sure and right for 1,185 of 1,238.
- **The hint takes that count** (#missedHint: `sure`, `alt`, `recount`), held runner or counted one: Passes to check
  (the first row's words and one click; #heldWords says where the later held passes go with it), Splits that look wrong
  (the row's words), the runner editor (the cell's "Missed here?", its menu, the problem line, the effect preview) and
  find ("missed 2400m and 3100m (or 2400m, 3100m and 4200m)?"). When the count agrees with the column check's or the
  flag's, their words stay; else "15:18.4 looks like 4200m, not 2400m (missed 2400m and 3100m?): 10:21 after 1500m, where
  runners of the same pace took 10:14." (missedCountText), "15:18.4 looks like 4200m or 4400m, not 2400m: Split Relay
  can't tell which (missed 2400m and 3100m, or 2400m, 3100m and 4200m?)." The Review rows carry each choice with what it
  does (#missedOut with the cell's #missedView: `effect`, `ok`, `alt`). "Missed …: add it" refuses a count other than a
  sure one, for suggested times (#missedFlagBlock: "15:18.4 looks like 4200m: bib 459 missed 2400m and 3100m? Add them
  together, or type the time."); while Split Relay can't tell, either goes; a typed time is the operator's own. The
  look-wrong check's held-runner flags of F13 (heldFlags) are gone: the count fit does that, for every runner.
- **The real cause of a leg that looks wrong** (the Review list's `causes`, #madeUpHint, #countHint), for a runner
  neither check points at a missed split for: (1) a run of made-up times its later passes do not fit (left out, the next
  real pass counted at their first split, a count fits clearly that is not the run's), the fix "Missed …: add it" on the
  made-up cell, which makes them up again (#missedPlan `again`: the made-up times from k up to the pass that moves on,
  in the same change; "Missed 2400m and 3100m added (8:31.0 and 11:00.0, made up); 2400m made up again (11:00.0
  before); 15:18.4 → 4200m, …"); (2) a run of missed mats from the first split to the flagged one that a count fits
  clearly, and by a misfit's worth better than the passes where they are (the first two missed: every pass two columns
  early, the column check places none of them, the look-wrong check sees a short leg only: "8:13.9 looks like 2400m, not
  800m (missed 800m and 1500m?)"). Listed in Splits that look wrong on the cause's split (kind 'made-up' or 'missed'),
  instead of the leg it explains, never with Not a split as the one click for the real pass after it; that leg's flag
  is not shown in the runner editor or the grid; It's right on the pass after it silences it (a made-up row has none:
  Change time or Remove in its cell). Measured on synthetic races: of 11,714 runners whose mats all read (21 with a leg
  that looks wrong and points nowhere) none is given a cause; of the runners a cause was found for, 265 of 268 right.
- **A typed time pushes made-up times out of its way** (#manualItem `giveWay`, addManual; addMissed's typed time):
  made-up times out of course order with it are taken out and made up again in their new stretch (or stay out when
  there is no estimate), in the same change, in words ("4400m 15:02.9 typed; the made-up 4200m time (16:47.7) made up
  again (14:12.3)"), every changed cell re-sent with its laps to go and leg, the furthest last; one Undo. Before, 524's
  real 4400m was refused against a made-up 4200m made up from the pass that was really 5300m. A real read keeps the
  rules of lateReplacements. A pass set aside as Not a split by mistake comes back with Undo or, in Other passes, "Let
  Split Relay count it", its split re-sent with the later ones (tested).
- **Counts that agree** (#staleCount `keys`, #staleExcept, #staleOthers; RaceView.stale.count, RaceView.resend): a
  runner's split out of date on the boards counts once, whatever the number of outputs (byOutput still per output); a
  change's `staleOthers` counts the same way and `staleOutputs` names where ("58 other places on TrackScore and
  Karmarush"); the race tile says where ("58 splits sent are out of date on TrackScore and Karmarush", staleWhere). The
  Resend dialog's number is what resendRace sends (RaceView.resend: every crossing not held; a finisher's real split
  only with the box; its made-up one always) and says how many of them are out of date; the toast says what went.
- **The place a made-up time went out with** (ManualView `sentPlace`, an output's copy of that time): "Sent as place
  106 (109th there now)." instead of the place there now.
- **Words beside the one click**: a held pass that went out says what the row's fix does ("Missed 3100m: add it puts the
  right time there, in the same change"; a pass that moves with the one before it: "The fix of the pass before it puts
  the right time there"); the runner editor's problem lines of the held passes after the first have no buttons of their
  own (the first line's fix settles them; their choices are in their cells' menus): one clear action per problem. A
  look-wrong line with a count on it says the hint's words in the editor too, as its Review row does (#problemsOf; the
  browser check's 410 said "looks like the finish" beside "Split Relay can't tell which").
- **A finisher's furthest split last too** (#sendFurthestFinished, from #sendFixed and convergence): every packet of a
  finisher carries the finish place, so TrackScore's place was right, but its newest line could be an earlier split
  (after a fill: the next split's new leg; after a restart: a made-up split that went again). With the finish place
  known, an output that got an earlier split of the runner gets the furthest one again, with the finish place, only where
  it has it with this time and column already (one with another time still waits for Send with finish place). After a
  kill the packets of the outputs' last minute go again (#releaseSuspects), a finisher's made-up split among them but
  not its real ones: the furthest split the output acknowledged before the kill, with this time and column, follows it
  (#redelivered). The harness's runF showed it: 428's made-up 4200m and 593's typed 1500m were the newest lines after the
  kill.
- **The panel**: missedOf (`sure`, `alt`), missedChoices, missedUnsureText, staleWhere; the menu groups the choices
  under "Split Relay can't tell which", none primary; the Review rows and the editor's problem lines show each choice as
  a plain button and a line with what each does; "type its time…" is the one-split choice's.

Unchanged: the column check (which passes are held), the look-wrong check's flags, estimateGaps, lateReplacements, the
minute rules, Send with finish place, config.js.

Not done: the race leader with its first three mats missed, on the course, is given the wrong count (nobody has been
where its pass belongs, as for the column check); a made-up time that a later Move left stale (made up from a pass the
operator then moved by hand) is not pointed at when the count is right (a typed time moves it out of the way);
"Missed …" in the menu of a cell nothing points at stays one split; the first pass of a runner whose first mat was
missed is not measured, only placed between the leaders and the back of the field.

Tests: review.test.js (missedCounts on the real race and on synthetic races, with the figures above; the re-check's
459, 507, 472, 524 and 438 held, sure, one click, every line on both outputs with its time, laps to go and leg, the
furthest last; no finish read, three in a row, the last three, the first two; on the course: 459 offered both after one
pass, sure after the next, its later passes by themselves; after a wrong count: the made-up cause, never Not a split,
its one click, Undo; a typed time moving a made-up one out of the way; Not a split put back by its menu and by Undo; the
other places counted once with their outputs, the race tile, Resend), engine.test.js (stale counted once, RaceView.
resend), app.test.js (the choices, the words, the menu, the made-up cell, find, the counts' words, the Resend dialog,
the place a made-up time went out with, the held pass's note), e2e.test.js (two in a row through the app, both outputs
alike); review.test.js also: a finisher's furthest split last after an output that was down and after a kill, and the
last three missed (Split Relay can't tell two from three) with the same words in Review and in the runner editor.

The harness again (the re-check's matrix on a copy of its scripts, my ports 6041-6049, TrackScore-Master's own
ingestion of both captures): run2, FLIP and runL send exactly the lines they sent before for every scenario (A1 to A7x,
D1, D2, L1, L1b, L2, W1, W2, L2b, L2c), the other places counted once (A1's toast 866, was 1,732). runD (the re-check's
two in a row, one click each, sure): 459 "Missed 2400m and 3100m added (8:31.0 and 11:00.0, made up); 15:18.4 → 4200m,
16:12.8 → 4400m, 19:39.2 → 5300m; 22:41.8 is an extra pass now", the lines 2400m L2G 5 CS 8:30.987 LS 3:33.793, 3100m
L2G 4 10:59.966 LS 2:28.979, 4200m L2G 3 15:18.377 LS 4:18.411, 4400m L2G 2 16:12.759 LS 54.382, 5300m L2G 1 19:39.154
LS 3:26.395 P 65 (before: 15:18.4 as 3100m, the finish pass as 5300m P 157); 507 1500m L2G 6 4:44.480 to 5300m L2G 1
18:41.153 P 12; 524 4200m L2G 3 14:14.517 LS 3:58.823, 4400m L2G 2 15:05.828 LS 51.311, 5300m L2G 1 18:09.814 LS
3:03.986 P 2; 438 4400m L2G 2 15:15.641 LS 51.688, 5300m L2G 1 18:23.662 LS 3:08.021 P 5; 472 (a cool-down pass) as
before. runDX: 472 with its first two missed (every line two columns early before, "800m L2G 7 CS 8:13.852"), the cause
row's one click, 800m L2G 7 2:36.739 to 5300m L2G 1 18:38.658; 459 with no finish read as in runD; 507 three in a row,
2400m L2G 5 8:04.887, 3100m L2G 4 10:28.555, 4200m L2G 3 14:38.701, 4400m L2G 2 15:31.959, 5300m L2G 1 18:41.153 P 15.
runM: 459 on the course, one click after its 4400m pass, 2400m L2G 5 8:31.041 to 4400m L2G 2 16:12.759, its 5300m by
itself later. runF: 593's typed 1500m, then its 2400m with the new leg and its 5300m last; after the kill 428's made-up
4200m and 593's typed 1500m went again and then each one's 5300m (L2G 1, the finish place). Every run: Karmarush got
exactly what TrackScore got; every scenario right after the kill and the restart; the only problem lines left are the
places of runners nobody fixed that other runners' fixes changed (the controls; Resend), as before. In the browser (the
panel on my copy): one primary button per problem in Review and in the runner editor (459's later held lines none; 410
two plain buttons and the line saying what each does; 472's cause row; 507's made-up row without It's right), 507's one
click from the editor ("…; 1500m made up again (5:36.3 before); 10:25.4 → 3100m, …"), six lines L2G 6 to 1 on both
outputs, the toast's 1,102 other places the race tile's 1,102, the Resend dialog "1,216 splits … 1,102 of them are out
of date on TrackScore and Karmarush now".

#### 9.23 F15 (2026-10-29): where the run of missed mats starts; two apart; a Move a typed time questions; the words

The operator's words, as for F13 and F14: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go"; Karmarush must get exactly what TrackScore gets; the easiest way possible, very user friendly; a one-click
suggestion that sends wrong lines to the boards is a major problem. An independent re-check of F14 (the whole real race
through the engine, and end to end with two captures and TrackScore-Master's own ingestion: runs runX, runX3 and runR
besides the matrix) found the one click sure and wrong where the run of missed mats does not start at the pass the
column check or the flag points at: 561 and 565 (4200m and 4400m missed, a cool-down pass): its 5300m pass counted in
4200m is among the slowest runners' 4200m times, so it went out as 4200m and the check held only the finish pass in
4400m: "Missed 4400m: add it" sent 4400m L2G 2 20:17.715 (made up after the real 5300m) and 5300m L2G 1 22:29.214 (the
finish pass), 4200m kept 19:41.554, and the next fix was refused (409, "a later pass (22:29.3) is 5300m, set in
Review"); 412 and 418 (the first three missed): the flag at 1500m, "Missed 1500m: add it" sent the real 4200m as 2400m
and so on, 800m kept the real 3100m; 567 and 451 (the last three, a cool-down pass): "Missed 4400m: add it" sent the
cool-down pass as 5300m, 4200m kept the finish pass; 491 (a walker, 4400m and 5300m missed): the flag's pass before it
(shiftedBefore) made "Missed 4200m: add it" the one click, its real 4200m sent as 4400m; 547 and 568 (4200m alone, the
4400m pass counted there, 200 m before): "Missed 4400m: add it" (not new: 5008454 sent the same). The whole field: two
in a row 995 of 1,002 right with the finish passes in the stream, 6 wrong (5 sure); three in a row 763 of 835, 31 wrong
(30 sure). Also: after the operator's own wrong Move (544's real 5300m to 4400m) and the made-up 4200m typed over with
the real one, nothing pointed at the 3:49 leg for 200 m (R2b); the find row said "· 3 to look at" for the held passes
the one click settles, the editor "4 look wrong"; a flag's words gave the runners' leg to the split the pass is in ("…
looks like 5300m, not 4200m (missed 4200m and 4400m?): 9:06 after 3100m, where runners of the same pace took 4:18", the
leg to 4200m). Measuring this fix found two mats missed apart wrong as well (1500m and 3100m: F14's one click "Missed
1500m and 2400m", 165 of 167 runners). What changed:

- **Where the run starts, from all of the runner's passes** (review.js missedStarts, countFrame, countPath; engine
  #missedStartsOf, #missedStartOf). missedCounts takes the start it is given (F14's measure, with the right start given,
  was never wrong); the column check and a flag point at the pass they doubt. The passes Split Relay counted after the
  last cell the operator set (a Move or Keep, a made-up or typed time, a timing point) or left empty are placed every
  way the mats can have missed them: each pass as the first that moved on, every count (the passes before it where they
  are); with a second run after it (two mats missed apart: from a later pass on, every pass count + count2 columns on);
  and all of them where they are. Each placing is measured with missedCounts' rules (countPath: the same legs, misfit,
  extra and perMat costs) over the same passes, from the runner's crossing before them, so their costs compare; a
  placing whose run starts with a pass that does not fit (FIT_RULES.fitWithin), or with an extra pass (not measured: it
  says nothing for its count), is out. When the cheapest is COUNT_RULES.margin cheaper than any placing whose first run
  starts at another split and than the passes where they are, the hint is its first run: its split (`pointed`: the split
  the check or the flag pointed at, when it is another one) and count, sure unless another count of that split fits
  about as well (then `alt`, as F14). One run from base's split: F14's count stays. Two runs apart are fixed one at a
  time, the first first: after it the column check holds the passes of the second when it sees them a split early, and
  the second is then the one click (447, 2400m and 4400m, as in F14); a pass it does not hold goes out a split early in
  between (the 4400m pass of a missed 4200m, 200 m before; the finish read as a missed 5300m), and the second one click
  puts it right. When another start, or the passes as they are, fit about as well, the hint is base's, not sure,
  `unsure: 'where'` ("Split Relay can't tell yet where the mat missed the runner: its next pass may tell, or choose …"):
  on the course this is the runner after one pass past the missed mats (418 at its 4200m pass; its 4400m pass settles
  it). (The passes where they are do not count against a placing whose first pass has nothing to be measured from, the
  first split missed: on courses with even splits they fit about as well, and the column check's field fractions
  decide.) With a pass the column check holds, a placing with a leg the look-wrong check would flag (longer than
  FIT_RULES.longAbove or shorter than shortBelow times the runners' of the same pace) is no reason to doubt one whose
  every leg fits: one leg's cost stops at COUNT_RULES.misfit, so the real race's own 512, its finish read held in 5300m,
  had that read as 5300m (a leg 2.56 times the runners') about as cheap as the finish, and 586's 16:10.8 left in 3100m
  (2.47 times) about as cheap as Missed 3100m: both were the one click in F14, and are again. Not with a flag, which is
  advice only: a runner whose mats all read but who walked has such a leg where it is (synthetic races: 14 such runners
  given a one click, 1 without). A flag the hint moved on from is not a reason to refuse it (#missedFlagBlock): the fit
  measured that pass too.
- **A finish read that is the runner's known finish** (#missedHint, #missedStartOf). With FinishLynx's finish known
  (merged .lif files on), a finish read held in the split the check points at is within 10 s of that finish: it is the
  finish, every split from there on was missed. F14's count fit had no pass to place there and took the fewest ("missed
  4200m, or 4200m and 4400m?" for a finisher who missed the last three, neither right); now the count is all of them
  ("21:44.4 looks like the finish, not 4200m (missed 4200m, 4400m and 5300m?)"). The fit of all of the runner's passes
  takes such a pass as the finish, so the passes where they are are that placing, and another start is the hint only
  when it fits clearly better (568 with 1500m missed, its finish read in 5300m: "Missed 5300m: add it" was sure in F14).
- **A time the operator set further on is a fixed point** (#countPasses; missedCounts `upTo`). The count fit of the
  check's or the flag's split (#missedCountOf) and of a made-up time that does not fit (#madeUpHint) took every later
  pass of the runner, also past a made-up or typed time further on: with two mats missed apart, each added, F14 then
  called the first made-up time wrong ("1500m's made-up 5:43.5 doesn't fit: 9:57.6 looks like 3100m …", 3100m made up
  already) and its one click undid both. Now the passes up to the next time the operator set count, a count that puts
  one of them there or past it is out, and the runner's finish counts only with nothing set after the split.
- **Where it is shown.** The hint's cell says "Missed here?" and its words ("19:41.6 looks like 5300m, not 4200m (missed
  4200m and 4400m?): 8:28 after 3100m, where runners of the same pace took 8:44."); in the runner editor it is the one
  line with the fix (#problemsOf: a cell with the hint and no check or flag line of its own gets a 'missed' line), the
  flag of the pass it moved on from is not shown, the held passes after it have no buttons. Passes to check: the
  runner's first held row carries it when it starts before that pass ("…; 22:29.3 moves on with it (the finish)"), the
  later rows say where they go with it (#heldWords). Splits that look wrong: the row is the hint's split and pass (kind
  'missed'), in its words. The rows send the hint's own split and pass (Review's `missed.splitId` and `missed.passTod`;
  the panel's missedRowTarget), not the row's. The race grid says the same (#gridBase: the hint's cell, the held cells
  in #heldWords' words). find: a missed mat is one thing to look at, whatever the held passes its one click settles
  ("554 … · missed 2400m and 3100m?", was "· 3 to look at"); the editor's line under the name counts it once ("1 looks
  wrong", was "4 look wrong": runnerStatusText). "Can't tell yet where" in the row, the cell's menu (its group) and the
  cell's line. The runner editor opens on the hint's cell (editorFocus: the first cell that says "Missed here?" or is
  held), and the menu of a pass held after it starts with that cell's one click, acting there (menuFor, `act.at`): 561's
  editor opened on its held 22:29.3 in 4400m, whose own first choice, Move to 5300m, would have sent the finish pass as
  5300m with two Enters.
- **A Move a typed time questions** (#legsOf, legFlagOf `moved`, pinOf/pinFields, #moveRules). The look-wrong check now
  also looks at a pass the operator moved, when the crossing before it is not a made-up time (a made-up time is made up
  from the stretch to it; one that does not fit is F14's cause): after 544's wrong Move and its real 4200m typed, "You
  moved 18:07.1 to 4400m, but it looks like 5300m (missed 4400m?): 3:49 after 4200m, where runners of the same pace took
  4:02." with "Missed 4400m: add it" (the pass moves on to 5300m by the rules of a Move, 4400m made up between the typed
  4200m and it, the finish pass an extra pass). It's right on it keeps the Move, said to be right: the 'assign' record
  of a Move gets `seen` (an older Split Relay reads the Move it is), and the flag is silenced.
- **A flag's words give the runners' leg to the split it looks like** (legFlagText, `suggest.leg`), as Passes to check
  says it: "16:10.8 looks like 4200m, not 3100m (missed 3100m?): 6:45 after 2400m, where runners of the same pace took
  7:32." (F6 gave 2:44, their leg to 3100m). The finish form says "… took 3:10 to 5300m", as before.

Measured through the engine (the eval scripts of the fix; the one click of every sure hint sent and its lines checked:
the newest line per laps to go the cell's time and leg, the furthest last). The real race as it was: the same four
runners as F14, each the one click (403, 512 and 586 held, 521 kept on race day; 521 held too when it is not kept).
Every complete runner, mats taken out at every split, at the end, with the finish passes in the stream, a dozen runners
per engine: one missed 1,167 of 1,169 sure and right, 2 not sure, never wrong (F14: 2 sure at the wrong split, 547 and
568); two in a row 1,000 of 1,002, 2 offered with the right count among them, never wrong (F14: 995, 6 wrong); three in
a row 788 of 835, 41 offered with the right one, 6 not sure or none, never wrong (F14: 763, 31 wrong). One runner per
engine: one missed and two in a row the same, three in a row 790, 39 offered with the right one, 6 not sure or none;
without the finish passes 1,002, 834 and 662; never wrong. Without the finish passes (the last splits aside: nothing
moves on, typed or filled) one missed 1,000 (F14: 1,000, 2 wrong), two in a row 834 (as F14), three in a row 662, never
wrong (F14: 638, 25 wrong, the first three). Two mats missed apart, round after round as the panel offers them: the
first one click sure and right for 797 of 835 with one split between them, 37 not sure, 1 wrong (568, a walker), and for
661 of 668 with two between, 1 not sure, 6 flagged with no one click (800m and 3100m, the slowest runners: "9:57.6 comes
late for 1500m … A missed mat?"), never wrong (F14: 240 and 47 wrong first one clicks); in between the two one clicks a
line went out a split early for 21 of the 1,503 (put right by the second). Finishers (FinishLynx has every complete
runner's finish, its finish read + 0.4 s, and place): one missed 1,168 of 1,169 sure and right, 1 not sure (F14: 6
wrong, 568 sure at 5300m five times); two in a row 1,002 of 1,002 (F14: 835, 167 two offered); three in a row 834 of
835, 1 not sure (F14: 668, 167 two offered without the right count); every one click's lines with the finish place. On
the course (30 s after the runner's first and second pass past the missed mats, with the finish passes in the stream and
without): a wrong one click 27 times before (3 one missed, 2 two in a row, 22 three), now never. Synthetic races (8
seeds, 6 courses, one runner in seven missing one to three in a row, one in four a cool-down pass): with the finish pass
in the stream a wrong one click or pair 17 → 4 of 1,366 (walkers, the first two of even splits; F14 had them too), sure
and right 1,189 → 1,196, runners whose mats all read given a one click 17 → 1 of 7,971; without it 3 → 2 of 868, 544 →
545, 3 → 2 of 7,931.

Unchanged: missedCounts' measure (how many from a given start), the column check (what is held), estimateGaps,
lateReplacements, the minute rules, Send with finish place, config.js.

Not done: two mats missed apart take two one clicks, and a pass the column check does not hold in between goes out a
split early until the second (21 of 1,503 runners measured; one change for both would need a second run in "Missed …:
add it"); with 4200m and 5300m missed apart, Split Relay often can't tell where (36 of 167): the one choice it offers
then is the check's split, not the one click, and is not the right one; a walker far from the runners of its pace can
still be given a wrong one click (4 of 1,366 synthetic missed runners, 1 of 7,971 whose mats all read, 1 of 835
two-apart runners); the first two mats missed on a course with even splits are often offered as two choices, or not
sure; a run whose start fits about as well at two splits on the course waits for the runner's next pass ("can't tell
yet where"); a Move measured from a made-up time is not looked at (the made-up time is the cause).

Tests: review.test.js (the re-check's shapes: 561, 565, 547, 568, 412, 418, 451, 491, each sure at its own split, the
Review row and the editor alike, the one click's lines on both outputs and the boards' every column right; 567, the last
three with a cool-down pass, two offered at 4200m; 418 on the course, can't tell yet where, then sure; two mats missed
apart, 447 and three more, one click each, nothing more after them; the real race through the engine, every 12th
runner, two and three in a row at every split with and without the finish passes, never a wrong one click; synthetic
races through the engine, two and three in a row at the first, middle and last splits, with the finish pass or not, one
runner in four a cool-down pass; finishers with FinishLynx's finishes: the last three, 568's 1500m, 236's 5300m, every
line with the finish place; 544's wrong Move with its real 4200m typed: flagged, one click, It's right keeps the Move
across a restart, Undo; the flag words; the real race's own four runners each the one click, held, kept on race day or
not), app.test.js (missedRowTarget, "can't tell yet where" in the row, the menu and the cell, the counts; the editor
starts on the cell that says Missed here?, and a pass held after it offers that cell's one click first, acting there),
e2e.test.js (561 through the app: the first held row's one click, both outputs alike).

The harness again (the re-check's matrix on my copy of its scripts, my ports 6061-6069, TrackScore-Master's own
ingestion of both captures; every run on the final code): run2, FLIP, runF, runL and runV send exactly the lines they
sent at F14 for every scenario, and runM, runD, runVT, runVF and runMV give the re-check's own evidence of F14 line for
line. runX: 561 "19:41.6 looks like 5300m, not 4200m (missed 4200m and 4400m?): 8:28 after 3100m, where runners of the
same pace took 8:44; 22:29.3 moves on with it (the finish)", its one click 4200m L2G 3 CS 15:29.141 LS 4:15.987 P 79,
4400m L2G 2 16:23.493 LS 54.352 P 75, 5300m L2G 1 19:41.554 LS 3:18.061 P 68 (the mats would have read 15:31.1 and
16:24.9; before: 4200m kept 19:41.554); 565 4200m L2G 3 15:19.512, 4400m L2G 2 16:13.933, 5300m L2G 1 19:33.192; 491
4400m L2G 2 21:35.023, 5300m L2G 1 26:15.484, its 4200m as read; 547 4200m L2G 3 14:17.439 LS 3:53.366, 4400m L2G 2
15:07.293 LS 49.854, 5300m L2G 1 18:13.099 LS 3:05.806; 568 two offered, the right one sent. runX3: 412 800m L2G 7
2:55.681, 1500m L2G 6 5:32.982, 2400m L2G 5 9:35.668, 3100m L2G 4 12:28.440, 4200m L2G 3 17:42.953, 4400m L2G 2
18:46.753, 5300m L2G 1 22:50.694 P 159; 418 the same way; 451 4200m L2G 3 15:18.701, 4400m L2G 2 16:14.143, 5300m L2G 1
19:35.866; 567 two offered (its finish read can be 5300m), the right one sent. runR: 544 after the wrong Move and its
real 4200m typed, "You moved 18:07.1 to 4400m, but it looks like 5300m (missed 4400m?): 3:49 after 4200m, where runners
of the same pace took 4:04.", its one click 4400m L2G 2 15:07.793 LS 49.460 P 3, 5300m L2G 1 18:07.094 LS 2:59.301 P 1.
The flag words of runV and runMV give the runners' leg to the split it looks like (V10 "9:06 after 3100m, where runners
of the same pace took 8:32", was 4:18). Every run: Karmarush got exactly what TrackScore got; every scenario right after
the kill and the restart; the only problem lines left are the places of runners nobody fixed that other runners' fixes
changed (the controls, L1; Resend), as before. In the browser (the panel on my copy, the real race streamed with 561,
412, 554, 457, 547 and 544 as above): 561's editor opens on 4200m ("Missed here?", "1 looks wrong", one primary "Missed
4200m and 4400m: add them"), its held 4400m's choices start with that one click, and the click sent 4200m L2G 3
15:29.141, 4400m L2G 2 16:23.493, 5300m L2G 1 19:41.554 P 68 to both outputs; 412 opens on 800m, "Missed 800m, 1500m and
2400m: add them", L2G 7 2:56.093 to L2G 1 22:50.694 on both; 544 the "You moved" line and its one click, 4400m L2G 2
15:07.672, 5300m L2G 1 18:07.094 on both; find "554 … · missed 2400m and 3100m?" and "457 … · missed 1500m?", no "to
look at"; 512, 521 and 586 the one click, no "can't tell" line.

#### 9.23 F16 (2026-10-29): two mats missed apart in one change; the one click from the fit of every set; the words

The operator's words, as for F13 to F15: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go", and "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets; the easiest way
possible, very user friendly and professional. A one-click suggestion that sends wrong lines is a major problem, and so
is one that leaves a line a split early until a second click. An independent re-check of F15 (the harness's runAP: the
real race with two mats missed apart, end to end, with two captures and TrackScore-Master's own ingestion) found: 568 (a
walker, 4200m and 5300m missed, 4400m read) given a sure, wrong one click, "Missed 4400m and 5300m: add them", which
sent 4400m L2G 2 19:14.869 and 5300m L2G 1 24:12.411 and left its real 4400m pass, 17:56.153, in 4200m; two mats
missed apart taking two one clicks, a line a split early in between (544: the first sent its finish read as 5300m L2G 1
20:43.414; 547: its 4400m pass as 4200m L2G 3 15:07.293); 408 (4200m and 5300m) "can't tell yet where" with one choice
offered, "Missed 4400m: add it", wrong (its finish read as 5300m L2G 1 22:51.815); the slowest runners who missed 800m
and 3100m only flagged ("9:57.6 comes late for 1500m … A missed mat?"), no one click; on synthetic races a runner whose
mats all read given a one click (1 of 7,971); and a look-wrong flag's finish form that gave the runners' leg to the
split the pass is in ("22:27.4 looks like the finish, not 4200m: 11:27 after 3100m, where runners of the same pace took
4:17 to 4200m"), not the splits missed and their leg to the finish as Passes to check says it. What changed:

- **A set of missed splits, in one change** (engine addMissed `also`, #missedPlan `runs`, #missedCheck; POST
  /api/races/:race/runners/:bib/missed `also: [{ splitId, count }]`; the panel's missedTarget and missedRowTarget send
  the choice's further runs). "Missed 4200m and 5300m: add them (4400m was read)": every run's pass moves on by the
  rules of a Move (past the last split, an extra pass), every run's splits get their suggested times, each made up
  between the crossings around it once all have moved, and every affected split is sent once, with its laps to go and
  leg, the runner's furthest split last, to every output alike; one fix group, one Undo (asked first as before,
  UNDO_LEAVES). A typed time goes with one split only (`also` with `time` is refused); a wrong `also` is refused in
  words (a split that was read: "4400m is not after 4400m, which was read: a run in a row is one "count"."). The first
  run alone when the sure set is both is refused for suggested times, as another count is (#missedFlagBlock): "15:08.2
  looks like 4400m: bib 544 missed 4200m and 5300m (4400m was read)? Add them together, or type the time." The
  post-condition checks every run.
- **The one click is the set that fits clearly best** (#missedStartOf; review.js missedStarts, startMargin, startRuns).
  Every placing of the runner's passes (F15) is a set of missed splits: one run from a split, two or three in a row, or
  two runs apart. The cheapest set is the one click when every other set costs at least startMargin more (another start,
  another count, one run or two, and `loose`: two runs whose second run's first pass fits loosely, worse than
  FIT_RULES.fitWithin, a runner who faded on the last leg; never the one click but a rival) and the passes where they
  are do too. startMargin is COUNT_RULES.margin plus COUNT_RULES.doubt (0.1) of what the best placing's own legs cost
  (`legs`): a walker whose legs fit loosely however they are placed (568: its finish read 1.52 times the runners' leg
  from 4400m) is not judged as closely as a runner whose legs fit. Another set that fits about as well is `alt`: both
  are offered with what each does, neither the one click ("Looks like the finish, not 4400m: Split Relay can't tell
  which (missed 4200m and 5300m, or 4400m and 5300m?)", missedSetsText). A placing that can't be measured yet (`open`:
  the runner at the front) makes nothing sure. Two runs apart must beat the passes where they are clearly also when the
  first split was missed (F15 let the passes as they are not count against a placing whose first pass has nothing before
  it: a walker whose mats all read fitted "missed 1K and 3K" a little worse than as it was, and that was the one click),
  and a second run's mats always cost COUNT_RULES.perMat (F15 charged none after a first split missed: a second run was
  a free guess).
- **A runner who should have finished by now** (legField `now` and `finishWait`; countPath). With finish passes in the
  stream, a placing that puts none of the runner's passes at the finish costs one more missed mat (the finish mat) once
  the runner's finish pass would be in: its last pass COUNT_RULES.finishAfter (2) times the field's median leg from the
  last split to the finish pass before the race's latest pass, the bound of finishPassesIn. 408: "Missed 4400m: add it"
  left its finish read as 5300m and nothing at the finish, and fitted about as well as the two mats apart; now
  "Missed 4200m and 5300m: add them (4400m was read)" is the one click once the finish would be in, and before that
  Split Relay can't tell yet.
- **The first split missed** (countPath). A first pass with nothing before it, past the slowest runner there, costs
  what it is past in log terms, log(t / B) (at most misfit): the field's slowest are no reference for its pace (1K and
  3K missed on a course of even splits: "Missed 2K: add it" left the 2K pass, past everyone in 1K, there, and fitted a
  little better than the two apart). A first pass a little before the leaders (by no more than COUNT_RULES.winner, 0.9
  of their time) is no bound when the placing finishes the runner among the first CHECK_RULES.leaders finishes: it can't
  be measured (`open`), not out (the winner of an 8K who missed the first two mats was given the one click of one).
- **800m and 3100m, the slowest runners** (#countHint). A flag that points at no split ("9:57.6 comes late for 1500m …
  A missed mat?") gets the placing of all of the runner's passes (#missedStartsOf) first when it is two runs apart,
  clearly the best set (startMargin, nothing that can't be measured yet) and better than the passes as they are by a
  misfit's worth: "Missed 800m and 3100m: add them (1500m and 2400m were read)" (F14's count from a split, as before,
  for a run in a row).
- **A cool-down pass after the stream's finish pass replaces nothing** (lateReplacements): a pass the count puts past
  the last split is where the finish is, and the passes after it replace no made-up time ("Missed 5300m: add it" on the
  course, then a cool-down pass: it replaced the made-up 5300m).
- **The words.** The choice says every split and the splits read between them: "Missed 4200m and 5300m: add them (4400m
  was read)" (missedName, the panel's missedLabel), what it does ("15:08.2 → 4400m, 20:43.5 → extra pass"), and the row
  where each run's pass goes (missedRunsText): "15:08.2 looks like 4400m, not 4200m, and 20:43.5 like the finish, not
  4400m (missed 4200m and 5300m?): 4:44 after 3100m, where runners of the same pace took 4:58; 20:43.5 moves on with it
  (the finish)". Not sure: "Split Relay can't tell which mats missed the runner: Missed 4200m and 5300m: add them (4400m
  was read) (17:56.2 → 4400m, 28:22.6 → extra pass, 29:10.4 → extra pass) or Missed 4400m and 5300m: add them (28:22.6 →
  extra pass, 29:10.4 → extra pass)." (missedUnsureText), both in the cell's menu under "Split Relay can't tell yet
  where", neither primary, each acting on its own set (`act.key`, missedKey), sent with its own split and pass. "Missed
  <split>: type its time…" only for one split of the cell's own. The find row names every split of the set. The
  look-wrong flag's finish form says the splits missed and the runners' leg to the finish, as Passes to check does
  (legFlagOf, legFlagText): "22:27.4 looks like the finish, not 4200m (missed 4200m, 4400m and 5300m?): 11:27 after
  3100m, where runners of the same pace took 11:22." The Help, the README (race day, Fix a runner) say it.
- **Speed.** #missedStartsOf and #missedHint are worked out once per Review list (a memo on its `legs`, made again when
  the race's crossings change): a runner's rows, cells and causes ask several times. Review with 84 runners who missed
  2400m, the same machine, both measured twice: 12 to 13 ms while the crossings have not changed (F15: 90 to 100 ms);
  110 to 130 ms after a change, as F15; the first in a fresh process (nothing compiled yet) 180 to 220 ms, as F15 (165
  to 230 ms).

Measured through the engine (the eval scripts of the fix, every complete runner of the real race, 167 per shape; the one
click of every sure hint sent with its runs and its lines checked: every line its column's time and leg, a made-up time
only in a missed split, the furthest last). Two mats missed apart, after the race, with the finish passes in the stream:
one split read between them 820 of 835 sure and right in one change, 15 not sure with the right set offered, never
wrong, no line a split early (F15: 798 right one click at a time, 36 not sure without the right one, 1 sure and wrong,
568; 8 with a line a split early in between); two read between them 665 of 668, 3 offered (F15: 663 at a time, 5 none, 7
with a line a split early). Without the finish passes (the last split missed aside: nothing after it moves on) 663 and
500 sure, 5 and 1 offered, never wrong. On the course (an operator who looks 30 s after each pass and clicks every sure
one click, then after the race what is left; right is the first mat alone until a pass after the second is in, then
both): one split between them 1,380 one clicks on the course and 36 after, never wrong, every runner right at the end,
835 of 835; two between 1,312, never wrong, 668 of 668; without the finish passes 1,236 and 1,131 one clicks, never
wrong, every runner right at the end but those whose last split was missed (nothing after it moves on: Review's made-up
time); a one click never sent a line a split early. Runs in a row (F15's measure, one runner per engine; F15's numbers
measured again the same way on its code): one missed 1,162 of 1,169 sure and right (F15: 1,167), two 997 of 1,002
(1,000), three 819 of 835 (790); without the finish passes 999 (1,002), 824 (834), 639 (662); never wrong; the rest
offered with the right one among two, but 568 with 4400m missed (below). Finishers (FinishLynx's finishes): 1,168, 1,001
and 833 (F15: 1,168, 1,002, 834), never wrong. On the course, one run (30 s after the first and second pass past the
missed mat): as F15, but 568 with 4400m missed, after its finish read: two offered, neither right (F15: "can't tell yet
where"). Synthetic races (8 seeds, 6 courses, one runner in seven missing one to three in a row, or two apart, one in
four a cool-down pass; judged as sets, F15 measured the same way): runners whose mats all read given a one click 0 of
7,971 with the finish pass in the stream and 0 of 7,931 without (F15: 1 and 2); runs in a row sure and right 1,242 of
1,366, 2 wrong, a sure one or two offered without the right one (F15: 1,196, 17), without the finish pass 543 of 868, 2
wrong (F15: 545, 90: the first two missed of an 8K sure as one); two apart 359 of 430 in one change, 24 offered with the
right set, 4 wrong (the first split missed on a course of even splits), without the finish pass 118 of 171, 7 wrong
(F15: none in one change).

Unchanged: the column check (what is held), estimateGaps, the minute rules, Send with finish place, config.js; other
runners' places are not re-sent by a fix (Resend, as before). missedCounts measures with countPath, so the finish rule
and the first split's costs above apply to its counts too.

Not done: 568 (a walker) with only 4400m missed is offered two sets, neither right, after the race and on the course
after its finish read (F15: the one click after the race): its true placing has a last leg 1.84 times the runners' of
its pace, which a placing whose every leg fits sets aside as a rival (F15's rule for a held pass); the right one,
"Missed 4400m: add it", is that cell's own choice. Without the runner's finish pass in the stream fewer runners get the
one click (three in a row 639 of 835 sure, 662 in F15; the others two offered with the right one); the real race's own
586 (16:10.8 held in 3100m) is now two offered ("Missed 3100m and 4400m, or 3100m, 4400m and 5300m") where F15 sent
"Missed 3100m" first; on the course the stream's own pass after the second missed mat still goes out a split early
before Split Relay can tell (2400m and 4200m missed: the 4400m pass, 200 m after 4200m, as 4200m), put right by the next
one click; walkers far from the runners of their pace and the first split missed on a course of even splits can still be
given a wrong one click on synthetic races (2 of 1,366 in a row and 4 of 430 two apart; without the finish pass 2 of 868
and 7 of 171); a typed time is one split only.

Tests: review.test.js (two mats missed apart in one change: 544, 547, 542 and four more shapes, the lines on both
outputs, legs, the furthest last, one Undo; 568 the walker, both offered, the right one among them; 408 sure once its
finish would be in; 800m and 3100m for the slowest runners; `also` refused in words (a split read, out of order, too
many, with a typed time), the first run alone refused when the sure set is both; a made-up last split then a cool-down
pass; the real race every 12th runner, two apart at every pair with one or two read between, with and without the finish
passes, never wrong; on the course, an operator clicking every sure one click, never wrong, never a line a split early
from a one click, every runner right at the end; synthetic races, two apart and two in a row then one, never a one click
for a runner whose mats all read; the finish form of a flag; the real race's four runners as before, 586 now two
offered), app.test.js (the labels, the menu acting on its set, the request with `also`, the row target, the words when
it can't tell which, the cell's line, the finisher's question, the find row), e2e.test.js (544 through the app: the held
row's one click, 4200m, 4400m and 5300m on both outputs alike, one Undo). node --test: 662 pass, 0 fail.

The harness again (the re-check's matrix on my copy of its scripts, my ports 6081-6089, TrackScore-Master's own
ingestion of both captures; every run on the final code; its variant a now takes a choice as a set and sends it as the
panel does, its further run as `also`): run2, runN, runNT, runNF, runD, runF, runL, runX, runX3, runR, runV, runVT,
runVF and runMV send exactly the lines bfcca7f sent for every scenario, with the same verdicts; runNM as bfcca7f's
second run of it (NM2's made-up 4200m and NM4 depend on when the fix comes); run3 the same but D2 (447, 2400m and 4400m
missed), now one change: "Looks like 3100m, not 2400m, and 19:46.3 like 5300m, not 4200m (missed 2400m and 4400m?): 6:03
after 1500m, where runners of the same pace took 6:05", 2400m L2G 5 8:37.153, 3100m L2G 4 11:05.935, 4200m L2G 3
15:25.554, 4400m L2G 2 16:21.543, 5300m L2G 1 19:46.296 (bfcca7f: two one clicks), its Undo asked first (409) and done,
then Redo. runAP: 568 both offered, "Looks like the finish, not 4400m: Split Relay can't tell which (missed 4200m and
5300m, or 4400m and 5300m?)", the right one sent 4200m L2G 3 16:54.762 LS 4:52.008, 4400m L2G 2 17:56.153 LS 1:01.391,
5300m L2G 1 23:36.078 LS 5:39.925 (bfcca7f: the sure "Missed 4400m and 5300m", 4400m L2G 2 19:14.869, 5300m L2G 1
24:12.411, its real 4400m left in 4200m); 408 the one click, "16:41.3 looks like 4400m, not 4200m, and 22:51.9 like the
finish, not 4400m (missed 4200m and 5300m?): 5:12 after 3100m, where runners of the same pace took 5:28; 22:51.9 moves
on with it (the finish)", 4200m L2G 3 15:46.855 LS 4:17.700, 4400m L2G 2 16:41.292 LS 54.437, 5300m L2G 1 20:01.095 LS
3:19.803 (bfcca7f: "can't tell yet where" and "Missed 4400m" offered, which sent 5300m L2G 1 22:51.815); 544 in one
change, 4200m L2G 3 14:18.124 LS 3:54.089, 4400m L2G 2 15:08.133 LS 50.009, 5300m L2G 1 18:09.935 LS 3:01.802 (bfcca7f's
first one click sent its finish read as 5300m L2G 1 20:43.414 until the second); 547 2400m L2G 5 8:08.679, 3100m L2G 4
10:24.073, 4200m L2G 3 14:17.439, 4400m L2G 2 15:07.293, 5300m L2G 1 18:13.099 (bfcca7f's first sent its 4400m pass as
4200m L2G 3 15:07.293); 542 1500m L2G 6 4:56.407 to 5300m L2G 1 19:27.034. The flag words of runV and runN: V5 (579)
"22:44.0 looks like the finish, not 4200m (missed 4200m, 4400m and 5300m?): 11:30 after 3100m, where runners of the same
pace took 11:40." and N8 (499) "… 11:27 after 3100m, where runners of the same pace took 11:22." (bfcca7f: "… took 4:23
to 4200m", "4:17 to 4200m"). runM and runNM2: the same lines as bfcca7f's for every scenario, but the strict check
failed the mid-race window once each (M1, NM1): another runner's stream line reached Karmarush at the very millisecond
of the mark that opens the window and TrackScore one before it (the runner's own lines the same on both); run again
(runMb, runNM2b), every scenario right with bfcca7f's lines exactly. Every run: Karmarush got exactly what TrackScore
got, every line in the same order; every scenario right after the kill and the restart; the only problem lines left are
the places of runners nobody fixed that other runners' fixes changed (the controls; run2's L1 and runNT's N3 and N4, as
at bfcca7f).

In the browser (the panel on my copy, port 6081, the real race streamed with the runAP shapes taken out: 568, 408, 544,
547 and 542): Passes to check has 408, 544, 547 and 542 each with one primary button, "Missed 4200m and 5300m: add them
(4400m was read)" and so on, its row's words as above and what it does under the pointer ("14:18.2 and 18:10.0 suggested
· 15:08.2 → 4400m, 20:43.5 → extra pass"); 568 has both sets as buttons, neither primary, and the line "Split Relay
can't tell which mats missed the runner: Missed 4200m and 5300m: add them (4400m was read) (17:56.2 → 4400m, 28:22.6 →
extra pass, 29:10.4 → extra pass) or Missed 4400m and 5300m: add them (28:22.6 → extra pass, 29:10.4 → extra pass).";
586, the real race's own, both its sets the same way. The runner editor: 544 and 408 open on 4200m ("Missed here?", "1
looks wrong"), the cell's line "4200m 15:08.2 is probably a later split's: mats may have missed bib 544 at 4200m and
5300m (below). …", its menu's first item the one click with what it does, primary, no "type its time…"; 568 opens on
4400m, "may be a later split's, but Split Relay can't tell which mats missed bib 568", its menu both sets under "Split
Relay can't tell yet where", neither primary. The clicks sent, to both outputs alike and nothing else: 544 4200m L2G 3
14:18.124 LS 3:54.089, 4400m L2G 2 15:08.133 LS 50.009, 5300m L2G 1 18:09.935 LS 3:01.802; 408 4200m L2G 3 15:46.855,
4400m L2G 2 16:41.292, 5300m L2G 1 20:01.095; 568 (its set "4200m and 5300m" chosen) 4200m L2G 3 16:54.762, 4400m L2G 2
17:56.153, 5300m L2G 1 23:36.078; the toast "Bib 544: Missed 4200m and 5300m added (14:18.2 and 18:10.0, made up);
15:08.2 → 4400m; 20:43.5 is an extra pass now. Sent to TrackScore and Karmarush. … Undo".

#### 9.23 F17 (2026-10-30): the others' back of the field; a runner far behind; a finisher's last splits; the words

The operator's words, as for F13 to F16: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go", and "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets; the easiest way
possible, very user friendly and professional. A one-click suggestion that sends wrong lines is a major problem, and so
is one that leaves a line a split early until a second click. An independent re-check of F16 (the harness's runNB,
runMA, runNAF and runAP end to end, two captures and TrackScore-Master's own ingestion; the whole real race and
synthetic courses through the engine) found: 491 (a walker; 800m, 2400m and 3100m missed) given a sure, wrong one click,
"Missed 1500m, 2400m and 3100m: add them", which left its real 1500m pass, 6:03.834, in 800m (L2G 7) on both boards and
made up 1500m after it (F15: not sure); 568 with only 4400m missed offered two sets, neither right (F15: the right one
only); 221 (800m, 1500m and 4200m missed, or 4400m) flagged nowhere, its lines two and three splits early; finishers
whose second missed mat was 5300m (441, 543, 401; 451 with 800m, 4400m and 5300m) taking two one clicks; on the course,
after the first mat's one click, the stream's pass after a second missed mat at 4200m out a split early; on synthetic
courses sure and wrong one clicks, pairs without the right one and "not sure" with only a wrong choice; and words: the
menu's heading "Split Relay can't tell yet where" over two sets the row called "can't tell which", the Undo dialog's
"the split" after a fix of two, all five splits read between 800m and 5300m in the label, "→ extra pass" for a pass the
row calls the finish. What changed:

- **The back of the field is the others'** (review.js fieldBack, countFrame `back`, countPath). A pass at the first
  split has no crossing before it to measure a leg from, so the count fit compares it with the field there: before the
  leaders is out, past the back of the field costs what it is past (F16). That back was the last crossing there of
  anyone, the runner itself and runners a mat missed included: 491's 1500m pass, counted in 800m, was the last there, so
  a set that left it there ("Missed 1500m, 2400m and 3100m") paid nothing for it and was the one click. For a set of
  missed splits the back is now the other runners': `last`, their last crossing there (a pass the set puts there more
  than CHECK_RULES.tailGap after it is out; a pass the set leaves where it was counted is measured as F16 did, the
  runner itself part of the field: a walker is there, however far behind), and `run`, the end of their unbroken run from
  the leaders (each within tailGap of the one before, the column check's tail), which another runner's pass far behind
  (221's 8:49.0 in 800m) does not stretch. A pass past the run costs all it is past, log(t / run), not at most a misfit:
  a pass far behind everyone at the first split is no one leg that fits badly, and a set that leaves it there explains
  nothing of it. The passes where they are (`own`) keep F16's measure: the runner itself may be the back of the field, a
  late start or a walker is never moved for being slow. 491: "Missed 800m, 2400m and 3100m: add them (1500m was read)",
  sure, also with 221's 800m and 1500m missed in the same race (the runNB shape); "Missed 1500m, 2400m and 3100m" now
  costs 1.20 (F16: 0.53; the right set 0.78).
- **A placing that measures nothing is no fit** (missedStarts): one whose passes from the one that moved on are none of
  them measured (the first split missed and every later pass past the last split) is left out: a synthetic walker who
  missed 1.5K had "Missed 1.5K, 2.5K and 4K", its 2.5K pass the finish and the rest cool-down passes, as its one click.
- **How loosely the best set fits** (startMargin `raw`, countPath): the doubt in the margin (F16: COUNT_RULES.doubt of
  what the best set's legs cost) takes every leg in full, not capped at COUNT_RULES.misfit: a synthetic walker 40 %
  slower than the slowest runner at every split had its last leg 6.5 times the runners' in "missed 1K and 3K", judged as
  closely as a runner who fits.
- **A runner far behind with nothing else pointing at it** (engine #farBehind, review.js pastField, the Review list's
  causes, #countHint). A runner whose first crossing is a pass Split Relay counted far past the back of the field there
  (the others' run, beyond tailGap: where the column check finds a pass implausible), and that neither the column check
  nor a look-wrong flag points at, gets the fix of all of its passes as a flag's cause does: the set that fits clearly
  best and better than the passes where they are by a misfit's worth (a late start or a walker gets nothing). 221 (800m,
  1500m and 4200m missed): "8:49.0 looks like 2400m, not 800m, and 16:42.2 like 4400m, not 2400m (missed 800m, 1500m and
  4200m?)." in Splits that look wrong and "Missed here?" on its 800m cell, one click. (F16: the column check places a
  pass one split further at most, and with 4200m missed no leg is short, so nothing at all.)
- **The finish leg is no wild leg** (#missedStartOf `wild`). F15 sets aside, as a rival of a set whose every leg fits, a
  set with a leg the look-wrong check would flag; the look-wrong check measures legs to splits, not to the finish. 568
  with only 4400m missed (its last 700 m 1.84 times the runners of its pace) had "Missed 4400m" set aside, and the two
  sets offered were both wrong; now "Missed 4400m: add it" and "Missed 4200m and 5300m: add them (4400m was read)" are
  offered, neither the one click: "22:31.3 looks like 5300m or the finish, not 4400m: Split Relay can't tell which
  (missed 4400m, or 4200m and 5300m?)".
- **A finisher's last splits** (missedStarts `trail`, startRuns, #missedStartOf, #countHint). With the runner's finish
  known (FinishLynx, a finish read, a marked finish) the passes near it are that finish, measured last; a set that
  leaves the runner's finish read in a split had every split from there to the finish missed too, and those are part of
  the set now, one change with the finish read moved on past the last split. 441 (3100m and 5300m): "Missed 3100m and
  5300m: add them (4200m and 4400m were read)" (F16: "Missed 3100m: add it", which put the finish read in 5300m, then
  "Missed 5300m: add it"). F15's rule that keeps base's own placing for a finish read in a split (every split from there
  on missed) makes it the one click only when it fits clearly best (startMargin): 568 with 4200m and 5300m missed, a
  finisher, had "Missed 4400m and 5300m" sure, its 4400m pass left in 4200m, where "4200m and 5300m" fitted about as
  well; both are offered.
- **The words.** The menu's heading over two sets is the row's, "Split Relay can't tell which" (missedGroup; F16: "can't
  tell yet where", also after the finish); over one, "can't tell yet where" or "can't tell yet how many", as the line
  says. Three or more splits read between two missed mats are a stretch (readWords, `readText`, missedLabel): "Missed
  800m and 5300m: add them (1500m to 4400m were read)". A pass a choice moves past the last split while the stream
  carries the finish passes is the runner's finish pass, as the row says it: "22:31.3 → extra pass (the finish)". The
  Undo dialog names the splits it empties: "4200m and 5300m are empty again in Review" (F16: "Review lists the split as
  missing again" after a fix of two). While Split Relay can't tell which of two sets, a later held pass says where each
  puts it (568: "5300m: Looks like the finish or an extra pass, not 5300m (it moves with the pass before it): Split
  Relay can't tell which"; F16 said the first set's place as a fact), and the pass where the other set's run starts asks
  the row's question ("4400m: Looks like 5300m or the finish, not 4400m: Split Relay can't tell which (missed 4400m, or
  4200m and 5300m?)"); the toast after a one click says the finish too ("30:13.0 is an extra pass now (the finish)").
  The Help, the README (race day, Fix a runner) say it.
- **The Review list's buttons** (style.css). The buttons' column was as wide as the widest row's buttons (max-content):
  with two long sets in a row (586: "Missed 3100m, 4400m and 5300m: add them (4200m was read)") every row was wider than
  the list, and its right end was cut off: on a 1366 px laptop 586's second set and Keep could not be reached, at 1024
  px 568's Keep. The column now gives way down to its widest button and the row's buttons wrap; at 1920 px nothing
  changes.
- **Can't tell yet where, with the best set** (#missedStartOf `best`, #missedHintNow). When the passes as they are fit
  about as well as the best set (F15's "can't tell yet where"), the set that fits best with all of the runner's passes
  is offered beside the cell's own when it is another one (as `alt`, neither the one click): 491 without the finish
  passes in the stream (800m, 1500m and 4200m missed; its passes where they are cost 0.63, the right set 0.51) was
  offered "Missed 2400m" alone; now "Missed 2400m: add it" or "Missed 800m, 1500m and 4200m: add them (2400m and 3100m
  were read)".

Measured through the engine on the final code (the re-check's eval scripts: verify4's wf4, syn4 and live4, and verify3's
counteval and apart; F16's code measured the same way, before → after). The whole real race after the race, one runner
per engine, every complete runner (167) at every placing: one mat missed with the finish passes in the stream 1,162 of
1,169 sure and right (as F16), 7 offered with the right one, none offered without it (F16: 1, 568 with 4400m missed);
without them 999 (999); two in a row 997 and 824 (997, 824); three in a row 819 and 638 (819, 639: 491 with 800m to
2400m missed, without the finish passes, is two offered with the right one); two apart with one, two and three splits
read between them 820, 665, 498 and without the finish passes 664, 667, 500 (820, 665, 498; 663, 667, 500); a single mat
and a pair apart (3,340 shapes, the re-check's tri) with the finish passes 3,286 sure and right (3,193), sure and wrong
0 (1, 491), 45 offered with the right one (49), none without it (2), no hint 3 (89: 221's shapes), the first run alone 6
(6); without them 2,788 (2,783), sure and wrong 0 (1), none offered without the right one (0), no hint 323 (323: a run
that ends at 5300m with nothing after it). FinishLynx has every finish (the same eval with the finishes and places, one
click with the finish place): two apart with one to five splits read between them 831, 667, 500, 333 and 167 sure and
right in one change (F16: 665, 500, 333, 166 and 0 in one change, 166, 167, 167, 167 and 167 the first run alone and a
second one click, 1 sure and wrong, 568); in a row 1,169, 1,001 and 834 (1,168, 1,001, 833); the single mat and a pair
3,322 in one change (1,994, and 1,329 in two), sure and wrong 1 (1: 568, a walker, 3100m, 4200m and 5300m missed, given
"3100m and 4400m+5300m"). On the course (an operator who clicks every sure one click 30 s after each pass): as F16,
never a wrong one click, every runner right at the end. Synthetic races (8 seeds, 6 courses, one runner in four a
cool-down pass): runners whose mats all read never given a one click (0 of 7,971, 7,931, 2,667 and 2,634); runs in a row
1,250 of 1,366 sure and right with the finish pass (1,242), 541 of 868 without (543); two apart 370 of 430 (359) and 118
of 171 (118); sure and wrong 1, 1, 2 and 3 (1, 2, 4 and 5); two offered without the right one 2, 0, 0, 0 (1, 0, 0, 2);
one offered and not the right one 2, 24, 0 and 1 (4, 24, 0, 0; one runner each moved from one of these to the other).
Late starters in the real race (every 6th runner 2 or 3 minutes late, its mats all read): never a one click (F16: 1 at 3
minutes, 568).

Unchanged: the column check (what is held), estimateGaps, the minute rules, Send with finish place, config.js; other
runners' places are not re-sent by a fix (Resend, as before). A finisher's change sent with the finish place sends its
made-up splits as they are made and then the others, the furthest once more at the end (as F16): every line its split's
time, the furthest last.

Not done: on the course, after the first mat's one click, the stream's own pass after a second missed mat at 4200m (the
4400m pass, 200 m on) still goes out a split early until the runner's next pass (2400m and 4200m missed: 160 of 167
runners; 1500m and 4200m: 161; 3100m and 5300m: 7; as F16): when it comes, Split Relay can't tell it from a slow 4200m
pass (the column check does not hold it, and holding it would hold every slow runner's 4200m line), and the next one
click puts it right. Six of the 3,340 shapes of a single mat and a pair without FinishLynx's finishes (800m with 4400m
and 5300m; 800m and 1500m with 5300m) still take two sure one clicks, each right, no line a split early between them:
the second run fits about as well as the runner's finish read as 5300m and its cool-down pass as the finish, so the
first run alone is the sure part. Without the finish passes in the stream, 4200m and 5300m missed stays invisible (the
4400m pass stays in 4200m and nothing comes after it). 568 (a walker who faded to nearly twice the runners of its pace)
is two offered with 4400m and 5300m missed (F16: the one click) and, as a finisher with 3100m, 4200m and 5300m missed, a
sure wrong one click (as F16). On synthetic races 7 sure and wrong one clicks are left (F16: 12): the first mats missed
on a course of even splits or of few splits (1K and 3K as 2K, three times without the finish pass; 1K, 2K and 3K as two;
1 mile and 5K as 1 mile), and two mats apart on the 7-split course (0.8K and 4.2K as 0.8K alone; 3.1K and 4.4K as 3.1K
and 4.2K). TrackScore's own places: TrackScore-Master's XC ingestion was changed on 2026-10-29 at 23:14 (after the
re-check); it now holds a runner known only from split packets at place 0, so the harness checks places on the wire (the
newest line's P).

Tests (review.test.js, app.test.js, e2e.test.js): 491 alone and with 221's 800m and 1500m missed in the same race
(pastField; the one click 800m and 2400m+3100m, every line on both outputs; without the finish passes, 800m, 1500m and
4200m missed, both sets offered, the right one as `alt`); 221's two shapes (4200m or 4400m), the one click in Splits
that look wrong and the runner editor; 568 with 4400m missed (both offered, its held passes' words, the right one sends
every line right) and, FinishLynx having every finish, with 4200m and 5300m missed (both offered); the finishers 441,
543, 401 and 451, one change with the finish place, every split's newest line right on both outputs alike and nothing
left to add; walkers at the back of synthetic races and late starters in the real race never given a one click;
synthetic races on the course with two mats apart (one or two splits read between them, the first split and the last
among them, the finish pass in the stream or not, cool-down passes, the stream cut when half the field has finished):
every sure one click right for what the runner has passed, no line a split early, no runner whose mats all read given
one; the words (missedGroup, readText, the Undo dialog naming two splits); and 491 through the app: Splits that look
wrong's one click, ONE change, seven lines to TrackScore and Karmarush alike, each in its column with its leg, the
furthest last. The F13 to F16 tests whose finish pass moves past the last split say "→ extra pass (the finish)"; F15's
and F16's tests of 568 expect what is above. `node --test`: 670 tests, 670 pass, 0 fail (the perf test too).

The whole harness matrix again on the final code (the re-check's matrix copied and moved to ports 6101 to 6109, each
Split Relay's config.json through normalizeConfig before its start; both outputs captured; TrackScore-Master's own
lynx-listener and XC ingestion run in the harness's process; the strict check from the raw captures, places checked on
the wire): run2, run3 (FLIP), runF, runL (LATE), runM, runD (D3), runX, runX3, runR, runV, runVT, runVF, runMV, runN,
runNT, runNF, runNM, runNM2, runAP and the re-check's runNB, runMA, runNA, runNAF and runNAT. Every scenario sent
exactly F16's lines with the same verdicts but these, each now right after the one click, the operator's fix and the
kill and Ctrl+C restarts, on both outputs alike and in TrackScore's ingestion. NB1 491, Splits that look wrong, sure,
"Missed 800m, 2400m and 3100m: add them (1500m was read)": 800m L2G 7 3:13.183 LS 3:13.183 P177, 1500m L2G 6 6:03.834 LS
2:50.651 P176, 2400m L2G 5 10:53.355 LS 4:49.521 P175, 3100m L2G 4 14:20.191 LS 3:26.836 P172, 4200m L2G 3 20:20.453 LS
6:00.262 P169, 4400m L2G 2 21:30.293 LS 1:09.840 P166, 5300m L2G 1 26:25.234 LS 4:54.941 P163 (F16: "Missed 1500m, 2400m
and 3100m", 6:03.834 left in 800m). NB3 221, one click "Missed 800m, 1500m and 4200m: add them (2400m and 3100m were
read)": 800m L2G 7 2:45.779, 1500m L2G 6 5:08.750 LS 2:22.971, 2400m L2G 5 8:48.975 LS 3:40.225, 3100m L2G 4 11:21.441
LS 2:32.466, 4200m L2G 3 15:46.007 LS 4:24.566, 4400m L2G 2 16:42.192 LS 56.185, 5300m L2G 1 20:07.935 LS 3:25.743 P94
(F16: nothing offered, five changes by hand). NB4 568, not sure, "Missed 4400m: add it" offered with "Missed 4200m and
5300m", the right one taken: 4400m L2G 2 18:03.210 LS 1:11.616 P156, 5300m L2G 1 22:31.293 LS 4:28.083 P159 (F16: two
sets, neither right). NB2 454 (2400m, 4400m and 5300m), not sure: its right set offered beside "Missed 2400m" (F16:
"Missed 2400m" alone, then a second change), one change, 2400m L2G 5 10:00.555 to 5300m L2G 1 23:30.973 LS 4:16.255
P162. The finishers AF2 441, AF4 543 and AF5 401: one change with the finish place (F16: two one clicks), 441 3100m L2G
4 11:17.194 LS 2:37.501, 5300m L2G 1 20:15.429 LS 3:25.770, 4200m L2G 3 15:52.453 LS 4:35.259, 4400m L2G 2 16:49.659 LS
57.206 and 5300m once more, all P102 (its finish place). As F16: MA2 468 (the stream's 4400m pass out as 4200m between
its two one clicks, Not done above); NB5 451 (no FinishLynx; 800m, 4400m and 5300m) two sure one clicks, nothing out
early between them. The PROBLEM verdicts left are the controls, run2's L1 and runNT's N3 and N4 (other runners' places a
fix changes: Resend, not in scope), as at F16, and the mid-race window of runNM's and runNM2's NM3: its own lines as
F16's, two other runners' stream lines reached the Karmarush capture 1 ms after the window's end (5 ms more: the same
1,160 lines on both; F16's runM M2, runNM2 NM1 and runMV MV2 had the same artifact, OK now).

The panel in my own browser tab (my copy on ports 6101 to 6109, the real race streamed at 100x with 568's 4400m read,
408's and 544's 4200m and 5300m reads, 491's 800m, 2400m and 3100m reads and 221's 800m, 1500m and 4200m reads taken
out, the finish passes kept, both outputs on). Passes to check: 408 and 544 one primary each, "Missed 4200m and 5300m:
add them (4400m was read)", under the pointer "15:46.9 and 20:01.1 suggested · 16:41.3 → 4400m, 22:51.9 → extra pass
(the finish)" and "14:18.2 and 18:09.9 suggested · 15:08.2 → 4400m, 20:43.5 → extra pass (the finish)"; 568 "22:31.3
looks like 5300m or the finish, not 4400m: Split Relay can't tell which (missed 4400m, or 4200m and 5300m?)", "Missed
4400m: add it" ("18:03.4 suggested · 22:31.3 → 5300m, 28:22.6 → extra pass (the finish)") and "Missed 4200m and 5300m:
add them (4400m was read)" both as buttons, neither primary, and its 28:22.6 "Looks like the finish or an extra pass,
not 5300m (it moves with the pass before it): Split Relay can't tell which". Splits that look wrong: 221 and 491, each
one click primary ("Missed 800m, 1500m and 4200m: add them (2400m and 3100m were read)", "Missed 800m, 2400m and 3100m:
add them (1500m was read)", the finish read "→ extra pass (the finish)"). 568's editor opens on 4200m ("Missed here?"),
its menu under "SPLIT RELAY CAN'T TELL WHICH" with both sets and what each does, the held passes as above. 544's one
click: the toast "Bib 544: Missed 4200m and 5300m added (14:18.2 and 18:09.9, made up); 15:08.2 → 4400m; 20:43.5 is an
extra pass now (the finish). Sent to TrackScore and Karmarush. …", the two captures alike: 4200m L2G 3 14:18.104 LS
3:54.069, 4400m L2G 2 15:08.133 LS 50.029, 5300m L2G 1 18:09.823 LS 3:01.690; its Undo asks "…; 5300m is empty again in
Review. TrackScore and Karmarush keep 18:09.9 at 5300m: …" (Cancel kept it). An earlier pass of the same check sent
491's one click to both alike, 800m L2G 7 3:13.183 to 5300m L2G 1 26:25.234, each with its leg. At 1024, 1366 and 1920
px no button of the list is cut off.

#### 9.23 F18 (2026-10-30): a late start is no missed mat; a finisher's trail paid for; what a change would hold; the words

The operator's words, as for F13 to F17: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go", and "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets; the easiest way
possible, very user friendly and professional. A one click that sends wrong lines to the boards is a major problem; so
is a runner whose mats all read getting a one click or having good passes held off the boards. An independent re-check
of F17 (the harness's runQL, runQT, runNAF and runQF end to end, two captures and TrackScore-Master's own ingestion; the
whole real race and synthetic courses through the engine) found: a runner who started late, every mat read (423 and
530, five minutes after the gun), went out right during the race, but once FinishLynx's results file was read every
pass was held, and the sure one click "Missed 800m: add it" sent every split a column late to both boards (29 of 167
runners at 3 minutes late, 164 at 5, all at 10 and 15, with FinishLynx and the stream's finish line); without FinishLynx,
2 to 4 minutes late, every pass held after the race and two wrong sets offered (126 of 167 at 3 minutes); 568 (a
walker, a finisher, 3100m, 4200m and 5300m missed) a sure wrong one click, "Missed 3100m, 4400m and 5300m", its real
4400m sent as 4200m; by hand, "Move 15:04.1 to 4200m" on 227 (3100m and 5300m missed) sent its finish read as 5300m
(its preview said "21:46.1 → 5300m" and nothing more); with "This is the finish" and no finish place known, 419's typed
800m was refused with no way out, in words that said TrackScore would take a split's place as the finish place (since
2026-10-29 it does not: TrackScore-Master takes the overall place from finish rows only); a finisher's one click sent
its made-up splits before the moved ones and its 5300m twice ("3100m | 5300m | 4200m | 4400m | 5300m"); and words:
"1 earlier passes need the splits before it", an Undo's toast naming 3100m where the question was on 2400m, NB5's
preview "22:28.7 → 4400m, 28:02.4 → 5300m" for two passes then held, 568's "Missed here?" on 4200m (the first set's
split) where the row asked about 4400m. What changed:

- **A late start is no missed mat** (review.js checkOne `lateStart`, legShape, CHECK_RULES shapeMargin, shapeLegs,
  shapeWithin; RunnerView `lateStart`). The column check measures every pass from the gun (the leaders' references, the
  field fractions × the finish), so a runner who started late has every pass late by the same time and looked like a
  runner a mat missed at the first split, every pass a split on. Before a runner is held, its legs from pass to pass
  (and on to its finish when it is known: FinishLynx's, a finish read, or the stream's finish pass) are measured as
  shares of its own stretch, against the same legs of the runners of the same pace on that stretch (legShape: the 30
  whose time from its first column to its last is nearest its own, as estimateGaps takes them); a start late by any
  time changes none of it. When every leg fits the course as counted (each within the look-wrong check's bounds,
  FIT_RULES.shortBelow and longAbove, and all of them within shapeWithin, 0.2, on average in log terms), with at least
  shapeLegs (4) legs, and clearly better (shapeMargin, 0.15) than the better placing the check found, the runner started
  late: nothing is held (columnCheck's `late`). A runner whose passes stop before the last split for longer than twice
  the field's median leg to the next one is none (it dropped out, or mats missed it). On 2026-10-21's course a missed
  800m shows at once (its 1100 m leg counted as 3100m's 700 m, its 200 m one as 4200m's 1100 m: 0.73 on average, every
  real runner); a late start fits as counted within 0.06 for every complete runner but one walker (568, 0.17, its last
  leg 1.59 times the runners'). On a course of even splits the two fit alike, and the check holds as before. The
  runner's line says it quietly, nothing to do: "Finished 165th in 29:04.7 (FinishLynx) · 8 passes · started about
  5:02 after the gun?" (the runners of its pace's time to its first split, at its pace, against its own). A wrong fix of
  such a runner taken back (a Move back to its split, or Undo) sends every split it changed again, as read, and nothing
  is held again.
- **A finisher's trail is paid for** (review.js missedStarts; engine #missedStartOf `ownCost`). F17 made the splits a
  finisher's finish read would be left in part of the set (`trail`), but charged none of them: 568 (3100m, 4200m and
  5300m missed, a finisher) had "3100m, 4400m and 5300m" (one mat in its run, two in its trail) free and the right set
  (two in its run, one in its trail) paying for one, the sure one click by 0.25. Every missed mat after the first now
  costs COUNT_RULES.perMat wherever it is, a trail's too, and base's own finisher placing (every split from the pass in
  doubt to the finish missed) pays for its own the same way. 568 is two offered, the right one among them; the held
  pass after it asks the row's question instead of one set's splits as a fact ("Looks like the finish, not 4200m (it
  moves with the pass before it): Split Relay can't tell which (missed 3100m, 4400m and 5300m, or 3100m, 4200m and
  5300m?)").
- **What a change would hold, said before and done after** (review.js checkField, checkOne, lastLegFinish; engine
  #previewHeld, #checkFieldOf). The column check is a field part (made once per race state) and a judgment of one runner,
  so the preview of a Move or of "Missed …: add it" judges the runner as the change would leave it by the same rules:
  "15:56.6 → 4400m, 21:46.1 → 5300m (held: it looks like the finish)", "22:28.7 → 4400m (held: it looks like 5300m),
  28:02.4 → 5300m (held: it looks like the finish)". And a runner the operator placed a pass of (judged on evenness only,
  9.17) has its last pass, counted in the last split with no pass soon after it while the stream carries the finish
  passes, looked at by its leg too, as the look-wrong check measures it (lastLegFinish: far longer than the runners' of
  its pace to the last split, and fitting theirs to the finish): 227's finish read after "Move 15:04.1 to 4200m", 5:49
  after its 4400m where the runners of its pace took 3:10 to 5300m, is held as the finish (441's was, by evenness), and
  "Missed 5300m: add it" is its one click; on the course, the finish read of a runner fixed at its first missed mat whose
  second was 5300m is held the same way. A preview that holds a pass as the finish calls no other pass "(the finish)".
- **A walker the column check let go is no missed first mat either** (engine #missedStartOf `stay`). F15 does not let
  the passes where they are count against a set whose first moved pass has nothing before it (the first split missed):
  the column check's field fractions decide that. But when the hint comes from a look-wrong flag, the check did not hold
  the runner: walkers of 8:30 to 15:15 a km on synthetic 5Ks of 1K splits, their mats all read, had every leg 1.8 times
  the runners nearest in time at the split before it (the slowest of the others, far faster), a flag, and "Missed 1K:
  add it" sure, the passes where they are as cheap ("15:15.1 looks like 2K, not 1K (missed 1K?)", s9 208 on the re-check).
  For a flag the passes where they are count: Split Relay can't tell yet where, and offers the set beside the cell's own.
- **A finisher's one click, each split once, in course order** (engine #convergeRace). Convergence sent a finisher's
  made-up splits as soon as the change made them, and #sendFixed then the real ones it moved and the furthest again:
  now a finisher's crossing the change being sent gave a new time goes from #sendFixed, with the others, in course
  order, the furthest last once: 441 "3100m | 4200m | 4400m | 5300m", all with the finish place.
- **The words.** "The pass at 8:56.4 can't be 800m: 1 earlier pass needs a split before it." Two sets offered, neither
  the one click: the cell that says "Missed here?" is the pass the row asks about, both sets in its menu (568 with only
  4400m missed: 4400m, not the first set's 4200m; the hint's `at`). After an Undo the toast names the cell that asks the
  question ("Split Relay now has a question about 2400m: 3100m and the times after it are held until you answer.";
  F17: "about 3100m", the first held split). With no finish place known: the words no longer say a split packet would
  replace the finish place in TrackScore ("A finisher's splits go out with the finish place, so this one waits for
  it."; the panel's FINISHED_NO_PLACE the same), and for a finish the operator marked they say the way out: "Bib 419 has
  finished: you marked 23:54.4 as its finish, and Split Relay doesn't know a finish place for it. A finisher's splits go
  out with the finish place, so nothing of bib 419's can go live. To send it: in 5300m choose "Missed 5300m: add it"
  (23:54.4 is the finish pass again, not the finish), then this split." That choice says what it does: "23:54.4 → extra
  pass (the finish pass, no longer the finish you marked), 24:45.8 → extra pass, 800m can be filled then". TrackScore
  takes a split row's place as that split's only since 2026-10-29, but Karmarush's live results, and a TrackScore before
  that change, may take it as the runner's place: the rule stays (P4), and the operator is told exactly what to do.

Unchanged: the column check for every runner whose legs do not fit the course as counted (what is held), missedCounts'
measure, estimateGaps, the minute rules, Send with finish place and the rule that a finisher's split goes with the finish
place (P4), config.js.

Not done: on the course, after the first mat's one click, the stream's own pass after a second missed mat at 4200m (the
4400m pass, 200 m on) still goes out a split early until the runner's next pass (as F16 and F17): it can't be told from a
slow 4200m pass (one leg 1.18 times the runners' against 1.0), and holding it would hold a fixed runner's good 4200m
lines too; the finish read of a fixed runner whose second missed mat was 5300m is held now (lastLegFinish). Runners with
2400m, 4400m and 5300m missed (487, 544 the race winner, 592), and without the finish line and FinishLynx 800m, 1500m and
4200m or 4400m, or 4200m and 5300m, still get no hint: their legs are each a little long (544's 1.60, just under the
look-wrong bound), and the fit of all of their passes is better than as counted by less than a misfit's worth, which is
what a one click needs; an offer for runners whose times stop early after the race was not added (a runner who dropped
out looks the same). The synthetic courses' sure and wrong one clicks are as F17 but one (the first mats missed on courses
of few or even splits, walkers far from the runners of their pace); three synthetic runners are offered two sets neither
right where one of the two was right before (a flag's passes where they are count now); and a late start on a course of
three splits or fewer, or before a runner's fourth time, is held as before (too few legs to tell it from the first mats
missed).

Measured through the engine on the final code (the re-check's eval scripts; ba243bd measured the same way; before →
after). Late starters (late7: each complete runner of the real race in turn, every mat read and every pass late, the
race streamed a minute at a time with each line out as it comes, FinishLynx's results read after it; 167 runners per
row), 1, 2, 2.5, 3, 3.3, 4, 5, 10 and 15 minutes late: with the stream's finish passes and FinishLynx's finishes, a sure
one click with every pass held 0, 0, 0, 29, 67, 142, 164, 167, 167 → 0, and a split's newest line not its own time 0, 2,
14, 126, 156, 166, 0, 0, 0 → 0; with the finish passes only, every pass held and two wrong sets offered 0, 2, 14, 126,
156, 166, 0, 0, 0 → 0, the lines the same → 0; with split points only, none, as before. The quiet note is on the runners
the check would have held (2 to 166; with FinishLynx 29 to 167), its late start 3 to 4 s from the truth on average (at 5
minutes 135 of 164 within 5 s, the furthest 15 s). The re-check's late6: 0 at every lateness from 1 to 15 minutes, with
and without FinishLynx (was 29, 164, 167 and 167 sure at 3, 5, 10 and 15 minutes with FinishLynx, and 2, 14, 126, 156 and
166 offered at 2 to 4 minutes without). The whole real race, every complete runner at every placing (wf4: one, two and
three mats in a row, two apart with one to three splits read between them, a single mat and a pair, with and without
the finish passes; counteval; apart; and with FinishLynx's finishes one to three in a row and two apart with one to five
read between): exactly ba243bd's results, but with FinishLynx's finishes and a single mat and a pair missed (3,340
shapes) 3,322 → 3,333 sure and right, sure and wrong 1 → 0 (568), offered with the right one 17 → 7. On the course
(live4, an operator clicking every sure one click 30 s after each pass): never a wrong one click and every runner at the
end as ba243bd left it; a line out early after a first click with two splits read between the missed mats 168 → 161 of
668 (3100m and 5300m: 7 → 0; 1500m and 4200m: 161, as before), with one read between 160 of 835 (2400m and 4200m), as
before; regular runners on the course never offered anything (nonelive), as before. Synthetic courses (syn6: the 8
tuning seeds, 16 fresh seeds 9-24 and 16 more never looked at before, 25-40; one runner in seven missing one to three in
a row or two apart, one in four with a cool-down pass, with the finish pass in the stream and without): runners whose
mats all read given a sure one click 1 → 0 (9-24) and 7 → 0 (25-40), none on the tuning seeds, as before; sure one clicks
that sent a wrong line 1, 11 and 6 in a row and 1, 4 and 2 apart → 1, 11, 6 and 1, 3, 2 (the one less: a finish read sent
as 5.3K, lastLegFinish); sure and right 1,250, 2,603 and 2,475 → 1,250, 2,602 and 2,472 (four runners now two offered,
the right one among them); three runners offered two sets neither right where one of the two was right before (s5 202,
a walker who missed the first mat, on two courses; s13 326 without the finish line, 2K and 3K missed): for a flag, the
passes where they are count. Review with 84 runners a mat missed, on a quiet machine: 11 to 14 ms cached (ba243bd 10
to 16), a median of 113 to 120 ms after a change (ba243bd 112 to 115), the runner editor 3 to 7 ms (1 to 4): the change
previews judge each choice's runner by the check's rules.

Tests (review.test.js, app.test.js, e2e.test.js): late starters through the engine, the real race streamed a minute at a
time (runners from the front to the back of the field, and 568), 1, 2, 3, 5, 10 and 15 minutes late, with the stream's
finish passes and FinishLynx's finishes, with the finish passes only and with split points only: never held, never a one
click or a row, every split's newest line its own time on both outputs alike, the note where the check would have held
the runner (at 5 minutes within 10 s of the truth); real first mats missed (800m, two and three in a row from it, 800m and
3100m) still sure and right, with and without FinishLynx; a wrong "Missed 800m" for a late starter taken back by a Move
and by Undo: seven lines, each split's own time, laps to go and leg, with the finish place, the furthest last, nothing
held again; 568 with 3100m, 4200m and 5300m missed (FinishLynx): both offered, the row's question in words, a Move's
preview that holds a pass as the finish calls no other pass the finish, the right one sends 3100m, 4200m, 4400m and
5300m once each with the finish place; finishers' one clicks (three shapes) each split once in course order, the
furthest last; 227's Move by hand (two runners of the fixture): the finish read held as the finish, the preview says so,
then "Missed 5300m" sure and right; 419's marked finish: the refusal's way out, the last split's choice says what it
does, then the typed 800m and its next split go out; walkers whose mats all read on the fresh synthetic seeds never a one
click; the words (1 earlier pass, NB5's preview of what it holds, 568's "Missed here?" on 4400m); the app's words (a
finisher with no place, the Undo toast's question cell, the late start in the runner's line); and 423 three minutes late
through the app (e2e): nothing held, no row, every split to TrackScore and Karmarush alike as read, "started about 3:00
after the gun?" to a few seconds. The F2, F4 and F13 tests of a marked finish with no place known expect the words above.
`node --test`: 679 tests, 679 pass, 0 fail (the perf test too).

The whole harness matrix again on the final code (the re-check's matrix copied and moved to ports 6121 to 6129, each
Split Relay's config.json through normalizeConfig before its start; both outputs captured; TrackScore-Master's own XC
ingestion run in the harness's process; the strict check from the raw captures, places checked on the wire): run2, run3
(FLIP), runF, runL (LATE), runM, runD (D3), runX, runX3, runR, runV, runVT, runVF, runMV, runN, runNT, runNF, runNM,
runNM2, runAP, runNB, runMA, runNA, runNAF, runNAT, runQ, runQT, runQF, runMQ and runQL (run again after the last change
of words). Every run's lines were the same on both outputs, and of 273 scenarios 255 sent exactly ba243bd's lines with
the same verdicts. The others: QL1 568 (FinishLynx; 3100m, 4200m and 5300m missed) not sure, both sets offered (ba243bd:
the sure "Missed 3100m, 4400m and 5300m: add them (4200m was read)", which sent its 4400m, 17:56.153, as 4200m L2G 3 and
5300m twice), the right one taken: 3100m L2G 4 12:04.839 LS 2:46.026, 4200m L2G 3 16:55.077 LS 4:50.238, 4400m L2G 2
17:56.153 LS 1:01.076, 5300m L2G 1 23:35.962 LS 5:39.809, all P164 (its finish place), OK at every phase on both outputs
and in TrackScore's ingestion (ba243bd: PROBLEM); QL2 423 and QL3 530 (five minutes late, FinishLynx) nothing to click
(ba243bd: the sure "Missed 800m: add it", 800m L2G 7 4:09.357 made up and every pass a split late, 423's 4400m 22:29.359
as 5300m), every split as read: 423 800m L2G 7 7:50.053 LS 7:50.053, 1500m L2G 6 10:18.600 LS 2:28.547, 2400m L2G 5
14:06.778 LS 3:48.178, 3100m L2G 4 16:49.139 LS 2:42.361, 4200m L2G 3 21:31.253 LS 4:42.114, 4400m L2G 2 22:29.359 LS
58.106, 5300m L2G 1 26:09.593 LS 3:40.234 (their verdict is the place: the split place sent live, P164, where
FinishLynx's 165th came after the race, as for the control runner); QT Q4 227 by hand, "Move 15:04.1 to 4200m": 4200m
L2G 3 15:04.053 LS 6:26.438 and 4400m L2G 2 15:56.599 LS 52.546 (ba243bd also 5300m L2G 1 21:46.094 LS 5:49.495 P137, its
finish read), the rest and the end as ba243bd; the finishers' one clicks, AF1 to AF5 and QF1, QF4, QF5, QF6, QF10, QF19
and QF22: the same lines, each split once, in course order, the furthest last (AF2 441: 3100m L2G 4 11:17.194, 4200m L2G
3 15:52.453, 4400m L2G 2 16:49.659, 5300m L2G 1 20:15.429, all P102; ba243bd: 3100m, 5300m, 4200m, 4400m and 5300m
again), OK as before; MQ8 594 the same lines, OK in its mid-race window (ba243bd's run had another runner's line 1 ms
apart at its edge); NM4 506 the same lines, its mid-race window PROBLEM by another runner's stream line (562's 4200m),
which reached TrackScore 6 ms before the window's start and Karmarush 1 ms after it (10 ms more: the same 1,770 lines on
both). As F17: MA2 468 and MQ7 444 (the stream's 4400m pass out as 4200m between their two one clicks: Not done above),
and NB5 451's two sure one clicks, nothing out early between them, its first one's preview now "… 22:28.7 → 4400m (held:
it looks like 5300m), 28:02.4 → 5300m (held: it looks like the finish)". Nothing was left listening on 6121 to 6129.

The panel in my own browser tab (my copy on ports 6125 to 6129, merged .lif files on, the real race streamed at 100x with
423 and 530 five minutes late, every mat read, 568 with 3100m, 4200m and 5300m missed and 227 with 3100m and 5300m
missed, then FinishLynx's results file written, as after the race; both outputs captured): 423 "Finished 165th in
29:04.7 (FinishLynx) · 8 passes · started about 5:02 after the gun?", every split as read (800m 7:50.1 to 5300m
26:09.6), no cell held, no "Missed here?", in no Review list (530: "4:57"); 568 "Missed here?" on 3100m, its menu under
"Split Relay can't tell which" with both sets and what each does, and its Moves "Move to 4200m: 28:22.6 → 4400m (held:
it looks like 5300m)" and "Move to 4400m: fits the pace · 28:22.6 → 5300m (held: it looks like the finish), 29:10.4 →
extra pass"; 227's "Move to 4200m: 15:56.6 → 4400m, 21:46.1 → 5300m (held: it looks like the finish)", and its one
click "Missed 3100m and 5300m: add them (4200m and 4400m were read)". A first pass of the check found 568's "Move to
4400m" calling two passes the finish ("…, 29:10.4 → extra pass (the finish)"): fixed (a preview that holds a pass as the
finish calls no other pass so) and tested; on that pass 568's right set, taken from its menu, sent the same four lines to
both captures as QL1 above.

#### 9.23 F19 (2026-10-30): a late start on the course; a late starter who missed a mat; a slow leg; the words

The operator's words, as for F13 to F18: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go", and "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets; the easiest way
possible, very user friendly and professional. A one click that sends wrong lines to the boards is a major problem; so
is a runner whose mats all read getting a one click or having good passes held off the boards. An independent re-check
of F18 (its late9, late8, late8s, synlate and byhand evals through the engine, the harness's runLM, runLS, runLS1 and
runLS1b end to end, two captures and TrackScore-Master's own ingestion, and the panel in a browser) found: late starters
ON THE COURSE, two to four minutes late, every mat read, had their first pass held and the sure one click "Missed 800m:
add it" from it on (166 to 167 of 167 runners), their 800m to 3100m lines held until their fifth pass (up to 14
minutes), and the one click taken (runLM, 490 and 544) sent all fourteen lines a column late for the rest of the race; a
late starter who also missed a mat, with FinishLynx's finishes, was given the sure and wrong "Missed 800m" (167 of 167
for 2400m, 3100m and 4200m and pairs, six minutes late; without FinishLynx "800m, 1500m and 2400m" for a missed 800m),
three in a row for 539 in runLS1; one slow leg, every mat read (2:30 lost on the 700 m from 2400m to 3100m), the sure
"Missed 3100m" after the race with FinishLynx (130 of 167) and right after the pass on the course (124 of 167), and a
late starter with such a leg "Missed 800m" back, every pass held (162 to 166 of 167); 230's finish read sent as 5300m by
"Move 15:12.7 to 4200m" (a cool-down pass 1:21 after it); and words: README and Help said "before its fourth time ...
asks as before" where a late starter was held until its fifth and the editor's gold button was "Missed 800m: add it";
568's empty 4400m and 5300m "made up" 28:22.7 and 28:22.8 between its finish read and FinishLynx's 28:23.0; 568's two
sets called "how many splits in a row"; 539's find row "2 to look at" beside the editor's "3 look wrong"; 571's two
passes after its finish called "After the finish" and "After the last split"; a late starter's made-up 800m placed 56 s
after its start. What changed:

- **A first pass moved on is the one click only when the legs say so** (engine #lateOr, #placingOf, #settled; review.js
  legShape). The column check, the count fit and a far-behind first pass measure the runner's first pass from the gun
  (the leaders' references, the field fractions, the back of the field), which a late start throws: every pass late by
  the same time looks just like the first mat missed, every pass a split on. A hint whose set moves the runner's first
  pass stays the one click only when the runner's legs from pass to pass (legShape, whenever it started) fit it clearly
  better (CHECK_RULES.shapeMargin, on what all its legs are off by together) than any placing that leaves the first pass
  where it is: as counted (a late start), one run of missed splits after it, or two apart (a late start and a mat missed
  later), each with no more missed mats than the one click's side; a pass a placing leaves past the finish costs
  COUNT_RULES.extra, each missed mat CHECK_RULES.shapeGap, and a finish read a placing leaves in a split misses every
  split from there on (its trail). Else the hint is offered, not the one click (`unsure: 'late'`), and the best such
  placing beside it as a set ("Missed 800m: add it if the runner started with the others, or Missed 2400m: add it if it
  started late"); when the legs fit another count from the first pass clearly better (a late start throws the gun's
  count: six minutes late and 800m missed, "800m, 1500m and 2400m"), that count instead. With too few legs to tell (one
  or two passes, a course of three splits) a late start is no reason when the first pass would have needed one longer
  than CHECK_RULES.lateMax (12 minutes) even at the back of the field's pace (a synthetic 8K's 5K pass counted in 1
  mile, 9 to 16 minutes; with 8, the real race's walker 491 six minutes late with 800m missed, 8:56 at the back of the
  field's pace, had the sure and wrong "Missed 800m, 1500m and 2400m" on the course for three minutes).
- **A late start released on the course** (review.js checkOne `legFloor`, leaderLeg, closeFit; CHECK_RULES legFloor,
  shapeClose, shapeCloseLeg, shapePlacings, shapeGap). On the course a placing that moves the first pass on may not make
  the runner's first leg faster than CHECK_RULES.legFloor (0.9) times the leaders' over the same splits (the median of
  the field's five fastest there): a late start makes nobody faster, so a late starter's 800m to 1500m counted as 1500m
  to 2400m is no placing, and nothing is held from its second pass on (with the quiet note when its legs fit). F18's
  late start (legShape, at least shapeLegs legs) is also found with two or three legs, before the last split, when the
  check's placing moves the first pass, every leg fits within shapeCloseLeg (1.15) and all within shapeClose (0.06), and
  no other placing of the same passes where they can be (not before the leaders there) fits within shapeMargin of it, a
  split skipped between two passes costing shapeGap (closeFit: legShape compares a runner with the runners nearest its
  own stretch, so a placing that skips every other split fits nearly as well; the first two mats missed fit as counted
  within 0.05 on a synthetic 7-split course, the right placing better).
- **Every split read before the finish: no missed mat** (review.js completeAt, everySplitRead; legField and checkField
  `near`). A runner with a pass in every split and its finish read at its known finish (within FINISH_NEAR_TICKS of
  FinishLynx's, a finish read, a marked finish) is never held by the column check (it may still be noted as a late
  starter), and the look-wrong check doubts none of its counted passes: a leg minutes longer than the runners' is a slow
  one (a stop, a fall). A late starter with such a leg had every pass held and "Missed 800m" sure; a runner with one,
  "Missed 3100m" sure.
- **A slow leg until the runner's next pass** (engine #nextOr, MOVED_FIT_WITHIN). On the course a one click whose pass
  that moves on is the runner's latest rests on that one leg, and a runner who lost minutes on it looks just like one a
  mat missed: it is the one click once a later pass of the runner is in, its finish is known, or its next pass is
  overdue (twice the field's median leg to the next split, from the split the pass is in now or the one it would go to,
  whichever is longer; to the finish pass when the stream carries them); until then it is offered (`unsure: 'next'`). A
  real missed mat gets its one click a pass later; the held passes stay held meanwhile, and a pass not held went out as
  counted already. While the runner's finish is unknown, a one click whose moved pass fits the split it would go to
  loosely (off the runners of its pace there by more than MOVED_FIT_WITHIN, 1.25, either way) is offered whatever came
  after it (`unsure: 'slow'`): the moved pass of every single mat missed from 1500m to 4400m by the real race's complete
  runners fits within it but 2 of 835 (the median 1.02), and a slow leg does not always undo itself at the next pass
  (2:00 lost on the 700 m from 800m to 1500m, 0.74 of the runners' leg to 2400m, was the sure "Missed 1500m" two passes
  on). Its finish tells.
- **A late starter's missed first split made up from its start** (engine #lateStartFor, LATE_START_TICKS; review.js
  estimateGaps `start`). When a change makes up a runner's first split and its legs as the change leaves them fit the
  course and put its start a minute or more after the gun (every on-time runner of the real race comes out at most 23 s
  after it, also with its 800m missed), the split is placed from that start: "From its start (about 4:00 after the gun)
  and 1500m 9:56.8, placed like the 30 runners nearest in pace".
- **A cool-down pass soon after a finish read** (review.js afterFitsFinish). F18 held a runner's last pass as the finish
  when it was placed in the last split by a Move and its leg fitted the finish, unless a pass came soon after it; 230's
  cool-down 1:21 after its finish read was taken for the finish pass and the finish read went out as 5300m. A pass after
  it that is far shorter (FIT_RULES.shortBelow) than the runners' leg from the last split to the finish is no finish
  pass.
- **The words.** The panel says what Split Relay can't tell (public/app.js missedUnsureText, missedGroup, cellModel):
  "Split Relay can't tell a missed mat from a late start (every pass late by the same time): choose Missed 800m: add it
  only if the runner started with the others.", with a set beside it "…: Missed 800m: add it (…) if the runner started
  with the others, or Missed 2400m: add it (…) if it started late.", "Split Relay can't tell a missed mat from a slow
  leg until the runner's next pass: wait for it, or choose …" (a loose fit: "… until the runner's finish (the time fits
  neither split well): wait for it, or choose …"); the menu heads them "Split Relay can't tell: a missed mat or a late
  start", "Split Relay can't tell yet: its next pass will" and "… its finish will". Two sets that differ in which splits
  are "which mats missed the runner", never "how many splits in a row" (568). A held or flagged pass's own Move is the
  one click only when no cell of the runner says "Missed here?" (moveIsOneClick): in its cell's menu, its row in the
  runner editor and its Review row (hintedBibs). 539, six minutes late and 2400m missed, in a field with other late
  starters, had three gold buttons in the editor: "Move to 1500m" and "Move to 2400m" on its real 800m and 1500m (both
  wrong) and "Missed 2400m: add it", whose one click alone sends every split right (the browser check of this round
  found the editor's two still gold after the menu's fix). No time is made up after a finish read: "4200m 28:22.6 is the
  finish read (the finish 28:23.0): there is no time for 4400m after it." A pass past the last split after the runner's
  known finish is "After the finish". The find row beside a missed split: "missed 2400m? · 2 more to look at". README
  (race day, Fix a runner: a late start, a slow leg) and the panel's Help (A runner who started late, A slow leg) say
  all of it, and no longer "before its fourth time ... asks as before".

Unchanged: the column check's measure (the leaders' ratios, the tails, the field fractions; what it holds changes only
for a runner with every split read before its known finish, and for a placing that moves a first pass on, legFloor),
missedCounts and missedStarts, the look-wrong check's measure (its flags change only for a runner with every split
read), estimateGaps but for a late starter's first split and after a finish read, the minute rules, Send with finish
place and P4, config.js, the other runners' places after a fix (the race tile's "N splits sent are out of date", the
operator's open choice).

Not done: the stream's own pass after a second missed mat can still go out a split early after a first one click taken
before it (1500m and 4200m missed: the 4400m pass, 161 of 167 in live4, as F18): it can't be told from a slow pass. Now
that #nextOr waits for the runner's next pass before the first one click is sure, that click is often one for both runs
(2400m and 4200m: 160 → 0; MA2 468 and MQ7 444 right). Runners with 2400m, 4400m and 5300m missed with the finish line
(487, 544, 592), and 800m, 1500m and 4200m or 4400m, or 4200m and 5300m without the finish line and FinishLynx, still
get no hint. On a course of even splits (5K of 1K splits, 5K of miles, 6K of 2K) a late start and the first mats missed
fit the legs alike: the late starter's passes are still held after the race without FinishLynx's finish (the DESIGN's
limit as F18), but "Missed 1K" is no longer its one click, and a real first mat missed there is offered, not the one
click. A late starter's first time on the course waits for its second (one pass can't tell it from a missed 800m), and
so a real 800m missed gets its one click at its third pass; with a second mat missed after it the column check lets its
first passes go at the second (no placing of one run fits them), and they are on the boards a split early until that
click. A late starter who also missed a mat, on the course without FinishLynx's finish, is offered its set, not the one
click (the re-check's LMM 477: its later lines a split early, as for any missed mat nobody fixes).

Measured through the engine (c53dc9a → F19; the re-check's own evals and mine, a look every 15 s of race time on the
course). Late starters of the real race, every mat read, one at a time: on the course the sure one click 166, 167 and
167 at two, three and four minutes late → 0 ("Missed 800m" offered), with and without FinishLynx and the finish line;
after the race nothing held, no hint, no row, every split's newest line its own (as c53dc9a); one, six and fifteen
minutes: nothing, as before. A late starter who also missed a mat, with FinishLynx, after the race: the sure and wrong
one click 167 (six minutes, 2400m), 167 (4200m), 167 (3100m and 4200m), 167 (1500m and 4200m), 166 (5300m), 162 (two
minutes, 2400m), 167 (twelve minutes, 2400m), 167 (four minutes, 3100m) → 0, the right set offered for every one; a
missed 800m right and sure for all 167, as before. Without FinishLynx: six minutes late with 800m missed, sure and wrong
("800m, 1500m and 2400m") 150 → 0, the right one offered 149 (16 no hint, as before); on the course 152 → 0 (with
lateMax 8 minutes the walker 491 still had it for three minutes). One slow leg, every mat read: on the course sure 124
(2:30 lost from 2400m to 3100m), 115 (2:00 from 800m to 1500m) and 167 (three minutes late and slow) → 0; after the race
with FinishLynx sure 130, 86, 162, 166 and 151 → 0, Review rows 167 → 0, held 160, 165 and 151 → 0; without it, three
minutes late and slow, held 159 and 126 → 0 (on time, without FinishLynx, "Missed 3100m" still offered for 130: no
finish to tell). By hand: the finish read sent as a split by a Move 1 → 0 in seven shapes (none in five), 2 → 1 for
1500m, 3100m and 5300m with a marked finish. Synthetic late starters (seeds 41-60: 2,298 runners two to eight minutes
late among 23,283): sure one clicks 747 → 0 without FinishLynx, 227 → 0 with it; held after the race 1,047 → 848 without
FinishLynx (the courses of even splits, the limit below), 212 → 0 with it; runners on time given a sure one click with
FinishLynx 146 → 0, and with no late starters 0 of 23,283 (the re-check's walkers: 67). Synthetic missed mats after the
race (the fresh seeds 41-60, rows and apart, with the finish pass or not): sure and wrong 21, 8, 6 and 11 → 13, 4, 5 and
11, the lines they send wrong 16, 7, 2 and 1 → 8, 3, 0 and 1, runners whose mats all read sure 0, as before; but the
first mats missed on courses of two to four splits are offered with a late start beside them instead of the one click
(one mat at the first split, sure and right 777 → 255 of 842 with the finish pass, 387 → 32 without; the 7-split course
as before). The real race after the race (one, two or three mats in a row at every split, two apart, three, with
FinishLynx or not): sure and wrong 0, as before; 1 to 7 runners per set offered instead of sure (walkers, and without
the runner's finish a pass that fits its new split loosely: three mats from 3100m without the finish line 139 → 133);
154, a walker with 800m, 1500m and 5300m missed, offered "800m and 1500m" or "800m, 1500m, 2400m, 4400m and 5300m" with
neither right (it was the one click). On the course, two mats apart, an operator clicking every sure one click: never a
wrong one click, as before; a runner whose first mat is 800m gets its one click after its third pass, both runs at once
(334 → 167 clicks), and when the column check lets its first two passes go at the second (800m and 2400m, 800m and
3100m: no placing of one run fits them) they are on the boards a split early until that click (0 → 167 runners each);
with 2400m and 4200m missed, the 4400m line out a split early after the first click 160 → 0 (the re-check's MA2 468 and
MQ7 444: one click for both runs once the 4400m pass is in), 1500m and 4200m 161 as before; with 2400m and 4400m and no
finish line, the second run's one click comes once the runner's next pass is overdue (none comes): after the race for
146 of 167 in the eval, whose operator looks 30 s after each pass. Runners whose mats all read, on the course: never a
one click, as before.

Tests (review.test.js, app.test.js, e2e.test.js): late starters on the course, the real race streamed a minute at a time
with a look every minute, runners from the front to the back of the field and 154 (568, the walker), 1, 2, 3, 5, 10 and
15 minutes late, with the stream's finish passes and FinishLynx's finishes, the finish passes only and split points
only: never the one click at any look, the first two passes out once the third is in, after the race nothing held and no
hint, every split's newest line its own time on both outputs alike; real first mats missed on the course: never a wrong
one click, the one click by the runner's third pass after it; a late starter who also missed a mat (six minutes and
2400m, four and 4200m, six and 3100m and 4200m, two and 2400m, five and 800m, six and 5300m, with FinishLynx; six and
800m without it): "Missed 800m" never the one click, the right set offered, taken it sends every split right on both
outputs (with the finish place; a missed first split made up a minute and more after the late start), nothing held after
it; one slow leg (2:30 lost from 2400m to 3100m) on time and five minutes late, and 2:00 lost from 800m to 1500m (the
sure one click two passes on without MOVED_FIT_WITHIN, offered as 'slow'), FinishLynx after the race: never the one
click on the course, after the race no hint, no Review row, nothing held, every split as read; 230's Move by hand with
its cool-down pass soon after the finish read: the finish read held as the finish, the preview says so, then "Missed
5300m" sure and right; no made-up time after a finish read (568: "4200m 28:22.6 is the finish read (the finish 28:23.0):
there is no time for 4400m after it."); the column check by hand (a complete runner never held, closeFit on even splits
and with the leaders' bound); the app's words (missedUnsureText, missedGroup and the editor's line for a late start and
a slow leg, both choices in the menu with neither primary, no gold Move on a held cell beside "Missed here?" in its menu
or in the runner editor's rows (539's rows rendered: only "Missed 2400m: add it" gold), "which mats missed the runner"
for 568's two sets, "After the finish", "2 more to look at"); and a late starter on the course through the app (e2e: 423
four minutes late, the race streamed in three parts: after its first pass its 800m held and "Missed 800m" offered, not
the one click, in the editor and the Passes to check row; once its second pass is in its 800m and 1500m on TrackScore
and Karmarush alike as read; at the end every split as read, nothing held, nothing offered); 491, a walker six minutes
late who also missed 800m: on the course never "Missed 800m, 1500m and 2400m" (with lateMax 8 minutes it was sure from
17:00 to 20:00), after the race "Missed 800m" sure and right. Changed: CHECK_RULES' keys; F16's on-course operator
clicks 28 times for 28 runners (a one click once the runner's next pass is in, often both runs at once; it clicked 40
times); F17's synthetic races on the course, the one click right for 182 of 581 runners and the right set offered for
332 more (it was the one click for 407): the first mat missed on courses of even splits or of three splits is offered, a
late start fitting it as well, and a one click whose moved pass is the runner's latest waits for its next pass.

The whole harness matrix on the final code (37 runs: the 29 and the re-check's LS, LN, TF, BH, BHF, LM, LS1 and LS1b; my
own Split Relay copies on my own ports, both outputs, TrackScore-Master's own ingestion with no warning): 296 of 320
scenarios sent exactly c53dc9a's lines with the same verdicts. The others: LS1 539 and LS1b 519 (late starters who also
missed a mat) offered the right set with "Missed 800m", taken it every split right (c53dc9a: the sure and wrong one
click, every split a column late); LM2 490 and LM4 544 (late starters on the course) nothing to click, every split as
read (c53dc9a: the sure and wrong one click); LSM2 476 its made-up 800m 6:44.7, from its start (4:56.4, from the gun);
MA2 468 and MQ7 444 one click for both runs once the 4400m pass was in, no line a split early (c53dc9a: 3 and 1); MQ2,
MQ5, MA3, MQ3, MQ6, M1, M3 and MV2 the same right lines a pass later (the one click waited for the runner's next pass);
MA5 548 the same lines, its last three once (c53dc9a: twice); MA4, MA6, M5 and MQ4 the same lines with other places
(other runners' passes in between); Q6 502's Redo sent its six splits with their new places (c53dc9a: one); M4 459 the
window's edge (another runner's line 1 ms apart on the two outputs, the same lines); MQ1 421 its 4200m pass on the
boards as 2400m before its one click, which came a pass later and sent it right; MQ8 594 (800m and 2400m missed)
offered, not sure, at the harness's only try after its second pass (sure at its third), so nothing was fixed there.
Review: 13-15 ms cached, 122-143 ms after a change (c53dc9a 12-13 and 110-128).

The panel in a browser (my own Split Relay copy on my own ports, the real Womens Race streamed at 100x, my FinishLynx
results after it): 536 on the course two minutes late, after its first pass: its 800m held, "800m 4:44.3 may be a later
split's, or bib 536 started late: Split Relay can't tell which (below)", "Missed 800m: add it" and "Keep in 800m" both
plain, the line "Split Relay can't tell a missed mat from a late start (every pass late by the same time): choose Missed
800m: add it (4:44.3 → 1500m) only if the runner started with the others.", the menu headed "Split Relay can't tell: a
missed mat or a late start" with no item gold; after the race every split as read, nothing held. 422, five minutes late,
with FinishLynx: "started about 4:53 after the gun?", nothing held, no hint. 568: "Split Relay can't tell which mats
missed the runner: …", 4400m and 5300m empty ("Check first", no time squeezed in after the finish read), "29:10.4 ·
After the finish". 571: both cool-down passes "After the finish". 539, six minutes late with 2400m missed, in a field
with other late starters: the find row "missed 2400m? · 2 more to look at" beside "3 look wrong"; the editor showed
three gold buttons, "Move to 1500m" and "Move to 2400m" on its real 800m and 1500m (both wrong) and "Missed 2400m: add
it" (the menu's fix had not reached the editor's rows): fixed (moveIsOneClick, hintedBibs), and after the fix only
"Missed 2400m: add it" is gold in the editor and the Passes to check rows; its one click sent 800m and 1500m as read,
2400m made up (15:09.7) and the rest moved on, nothing held, with the finish place.

#### 9.23 F20 (2026-10-30): a stray pass that makes up for a missed mat; a late starter's later mats; one slow leg; three apart; the words

The operator's words, as for F13 to F19: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go", and "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets; the easiest way
possible, very user friendly and professional. An independent re-check of F19 (051d375: its probe8dup, late6 to late9,
late8s, wf4, counteval, apart, live4, rowlive8, syn6 and synlate evals through the engine, the 45-run harness matrix end
to end with TrackScore-Master's own ingestion, and the panel in a browser) found: a runner a mat missed with one stray
read before its finish (a second read 40 s after its 3100m pass, beyond the tag window) had every column filled, so with
FinishLynx's finish known F19 took it as complete: no hint, no Review row, 2400m holding its 3100m time on both boards
(F19's "every split read before the finish"); a late starter one to two minutes late who missed 4400m, or 4200m and
5300m, with FinishLynx, was given the sure and wrong "Missed 4200m" (its good 4200m pass sent as 4400m), and 488 (ZLT3),
two minutes late, had its typed 4400m refused twice ("a pass of this runner looks like another split's", nothing to go
on); one slow leg of two to four minutes on the course was the sure one click on other stretches than F19's (2:30 lost
from 1500m to 2400m, "Missed 2400m" 156 of 167 once its 3100m pass was in; 4:00 from 2400m to 3100m, "3100m and 4400m"
122, its later splits held until its finish and then never sent live; 2:00 from 4400m to 5300m without FinishLynx,
"Missed 5300m" sure with the stream's finish pass, 89); on the course with 800m and a later mat missed, the passes after
the first went out a split early until the later one click (live4, 167 runners); three mats missed apart with FinishLynx
(ZT1 410: 800m, 2400m and 4200m) offered two wrong sets and no way to type one split; after an Undo a held pass's row
said "It went out as 1500m before it was held" where it never went out (475); and, unchanged from F19 and measured
again: a real missed mat's one click a pass later, a late starter twelve minutes late with 800m missed only a flag
without FinishLynx, no hint for some three-mat shapes, and synthetic courses' sure and wrong 32 of 7,366. The rule F20
keeps for all of them: a one click is sure only when its placing of the runner's times fits clearly better than every
other explanation of them (as counted, a late start, one slow leg, a stray pass, the other sets), by the legs from pass
to pass whenever the runner started. What changed:

- **A count made complete by a stray pass is no complete count** (review.js strayLegs, strayIn, completeAt,
  everySplitRead, fieldLeaderLeg; legFlagOf `stray`; CHECK_RULES.strayLeg). A runner is complete for the column check
  and the look-wrong check (F19: never held, its counted passes never doubted) only when, besides a pass in every split
  and its finish read at its known finish, no leg between passes counted in neighbouring splits is shorter than
  CHECK_RULES.strayLeg (0.75) times the leaders' leg there (the median of the field's five fastest on that stretch). On
  the real race the fastest runner's leg on any stretch is 0.97 of it or more, and a stray read 30 s to 1:30 after a mat
  0.13 to 0.68 of it, but on the 200 m from 4200m to 4400m (the leaders take 50 s), where a stray 30 s after the 4200m
  pass is 0.6 and one later than 50 s merges with the 4400m read in the tag window. The look-wrong check flags such a
  leg short (`stray`) whatever the runners of its pace did, with Not a split for the pass that ends it. With a pass in
  every split, so is a leg shorter than CHECK_RULES.strayOwn (0.8) times the runner's own pace (review.js ownShort,
  ownShortAt: the median of its other legs over the leaders', a long one left out, a missed mat's or a slow leg's; three
  other legs at least): 4200m missed and a read 60 s after the 4400m pass, counted in 4400m, takes as long from that
  pass as a real 200 m leg, and leaves the 900 m on to 5300m a minute short, 0.64 to 1.27 of the leaders' there (under
  the strayLeg for 52 of 167) but under 0.8 of the runner's own pace for 163; no hint and no row for 119 of them before.
  The real race's legs are 0.86 of the runner's own pace at least, and a late start changes no leg from pass to pass.
  Such a flag (`ownStray`) needs a set better than the passes as counted by a misfit's worth, as any other set (engine
  #countHint; a strayLeg flag's set need only fit better).
- **A set that sets the stray aside, in one change** (engine #straysOf, #strayPrev, strayWords, #missedStartsOfNow,
  #placingOf and #missedStartOf `aside`, #missedPlan and #missedAsidePlan, #missedChoice, #asideOf, addMissed `aside`;
  public/app.js missedOf, missedKey, missedLabel, missedAlso, addMissedFix). Either pass of such a leg may be the stray
  (a stray soon after a real pass is the later one; one soon before the runner's next pass the earlier, 4200m missed and
  a read 60 s after the 4400m pass leaving the leg after it short on the 900 m to 5300m). For each (at most four), the
  runner's passes from the pass that moves on are placed again with it left out (each such placing costs
  COUNT_RULES.extra more, as a pass past the finish does), every set of missed splits as F16 weighs them, and a set that
  starts before it carries it (`aside`): its one click adds the missed splits, moves the later passes on and makes the
  stray Not a split, one change, one Undo, every changed split sent once with its laps to go and leg, the furthest last
  ("Missed 2400m: add it (11:24.4 is a stray pass)", the choice "10:44.4 → 3100m, 11:24.4 → not a split", the row
  "10:44.4 looks like 3100m, not 2400m (missed 2400m?): … 11:24.4 is a stray pass, 0:40 after 10:44.4."). Not a leg that
  ends at the runner's last pass or at its finish read at its known finish (a cool-down soon after a finish: nothing
  after it tells); not a placing that leaves a split missed between the stray's neighbours (the stray would be that
  split's pass: a walker's real 4400m pass 70 s after its 4200m, counted in 4200m after 800m missed, looked a stray on
  the 1100 m from 3100m), nor, while the runner's finish is unknown, one that leaves the pass before it past the last
  split (a pass past the last split is an extra pass already: 573's cool-down was "set aside" so). And a set that sets a
  stray aside stands only where the runner's legs from pass to pass fit it better than the best of the cheapest sets
  that set nothing aside, one run of one to three splits from each of the first three splits whose pass can move, or no
  missed split (#strayLegsFit, as #lateOr weighs placings): a runner who missed a mat has every later pass a split
  early, so a real leg measured on a longer stretch can look like a stray's (bib 1, five minutes late with 800m missed:
  its real 3100m pass, 2:23 after its 2400m pass, counted on the 900 m from 1500m, 0.73 of the leaders' leg there), and
  the gun's placings of a late starter's late passes fit such a set where nothing else fits the gun ("800m and 1500m
  (15:44.4 is a stray pass)" was its hint, where 051d375 had "Missed 800m" sure and right). A runner with every mat read
  and a stray pass has its flag's Not a split as the one click when the leg is under FIT_RULES.strayBelow of the
  runners' of its pace, as before (else the row says "3:24.8 comes soon after 800m for 1500m", Not a split in the cell's
  choices); nothing is held. A finisher's change with the finish place also sends the runner's later splits that no
  output has as they are now, from the first split it changed (a walker's 4200m to 5300m, held on the course while 2400m
  was in doubt and let go after its finish, stayed off the boards after a stray set's one click, which moved none of
  them). On the course a one click waits for the runner's next pass while its latest pass, where the one click would put
  it, is soon after the one before (a leg shorter than anybody covers there; where nobody has covered that stretch yet,
  the stretch it is counted on): it may be a stray only the next pass shows (#straysOf weighs no stray at the runner's
  last pass). With 2400m missed and a read 40 s after its 3100m pass, "Missed 2400m: add it" (the stray to 4200m) was
  the sure one click until the runner's 4200m pass, 158 of 167 on 051d375; the stray set is the one click after it.
- **A late start for the later columns too** (engine #lateLater, #legScore, #legCtx, LATE_SEEN_TICKS; review.js
  countFrame). F19's #lateOr weighed a one click that moves the runner's first pass. The column check's field fractions
  and the count fit measure every pass from the gun, so a late starter's passes all look late, the later ones less, and
  a good pass can look like the next split's: one to two minutes late with 4400m missed, its good 4200m pass "looks like
  4400m". A one click at a later split, for a runner whose placing's legs put its start LATE_SEEN_TICKS (30 s) or more
  after the gun, is weighed as #lateOr weighs a first pass: against every other set of no more missed mats (one run from
  a counted pass, two apart, or none) by the legs, whenever it started (#legScore: what its legs are off by together, a
  pass past the finish COUNT_RULES.extra, each missed mat CHECK_RULES.shapeGap, a finisher's trail too); one that fits
  about as well or better is offered beside it ("Split Relay can't tell which mats missed the runner"). And the back of
  the field at a split, for the count fit (countFrame), is never before the runner's own pass there: a late starter was
  "far behind" the last other runner, and every placing that left its passes where they are was out.
- **A hint offered already, and stray sets, weighed for a late start** (engine #lateOr). A late starter's passes all
  look late from the gun, and the gun's placings that fit about as well can all be wrong: bib 1 five minutes late with
  800m missed was offered "800m and 1500m (15:44.4 is a stray pass)" or "800m and 1500m" (its real 3100m pass, 2:23
  after its 2400m pass, counted on the 900 m from 1500m: 0.73 of the leaders' leg there), and 118 six minutes late with
  5300m missed "800m" or "4200m", the set its legs fit nowhere. #lateOr now also weighs a first-pass hint that is
  offered already, its other set replaced by the one the legs fit when they fit it clearly better (shapeMargin), and
  measures every placing with the stray passes the hint or its other set sets aside and without them (each one set aside
  costing COUNT_RULES.extra), the best counting. And a late starter's first-pass hint the gun can't settle (`unsure`
  'where', or none), with the runner itself at the back of the field a set that leaves its first pass where it is
  fitting the gun about as well (60, six minutes late with 800m missed: "800m" or "4400m"), is the one click when its
  own set is the one its legs fit best, putting its start LATE_SEEN_TICKS or more after the gun, clearly better
  (shapeMargin) than every set that leaves the first pass where it is, every other count from it, and its other set:
  051d375's sure and right "Missed 800m" for late starters with FinishLynx's finishes, kept.
- **One slow leg, weighed like a late start** (review.js legShape `skip`, checkOne slowLeg and columnCheck `slow`,
  CHECK_RULES.slowLeg and slowLost; engine #slowOr, #legScore `skip`, `unsure: 'leg'` with `leg`, #slowLegOf and the
  runner's `slowLeg`; #nextOr). legShape can leave one leg out (out of the runner's time and the reference runners'),
  and says how much slower than theirs it was. The count fit charged a slow leg twice (the leg, and the next one
  measured against it), so a missed mat was often cheaper. The column check now lets a runner go whose passes as
  counted, one slow leg left out (every other leg within shapeCloseLeg of the runners', all within shapeClose, no more
  than CHECK_RULES.slowLost, 5 minutes, lost on it), fit better than its placing with a mat missed by
  CHECK_RULES.slowLeg (0.15): nothing is held, and its passes go out as read during the race once two passes after the
  leg show it (one can't: a runner who missed 3100m and 4400m has its 4200m pass in 3100m and its 5300m pass in 4200m,
  one slow leg from 2400m to 3100m and the 1100 m from 3100m to 4200m like the runners' 1100 m from 4200m to 5300m; with
  one pass its lines went out a split early on the course for 156 of 167 until the race was over), or the last split's
  pass alone when the slow leg ends just before it (nothing else comes before the runner's finish, and a finisher's
  splits go out only with its finish place: three minutes lost on the 200 m from 4200m to 4400m kept the 4400m and 5300m
  lines off the boards for good), nor while the runner's finish is overdue with a finish pass in the stream (a placing
  with the finish missed waits for it). A one click whose placing does not fit clearly better than that one slow leg is
  offered, not sure (#slowOr, `unsure: 'leg'`, unless the leg has one pass after it and the runner's next pass, which a
  slow leg would have brought, is overdue: twice the field's median leg on from that pass's split), "Split Relay can't
  tell a missed mat from a slow leg (1500m to 2400m took 2:30 longer than runners of the same pace, and its later times
  fit as read)"); the runner's line says it quietly when the check spared it ("about 2:30 lost before 2400m?"). On the
  course a one click whose pass that moves on is the last split's, when the stream carries finish passes, waits for the
  runner's next pass as F19's #nextOr does for others (a slow last leg puts its 5300m pass at the finish's time), unless
  it is later than any slow leg makes one (slowLost after the runners of its pace: the walker 91, its finish read 8:43
  after them at 4400m, had no next pass to wait for). And, while the runner's finish is unknown, a one click is offered,
  not sure, when the runner's next pass fits neither where the one click puts it nor a split after it (the finish too: a
  second run, F16's, follows with its own one click), measured from the moved pass where it puts it (MOVED_FIT_WITHIN):
  three or four minutes lost on the 700 m from 800m to 1500m put the runner's 1500m pass where the runners of its pace
  pass 2400m, too few legs yet to weigh one slow leg, and only the leg after it, its 2400m pass as 3100m, 1.4 times
  theirs, tells it from a missed 1500m ("Missed 1500m" was the sure one click on the course for 162 of 167 at 3:00 lost,
  158 at 4:00, once that pass was in); the finish counts as such a split when the stream carries finish passes. Nor is
  it sure while the pass that moves on fits the split it is counted in better than the one it would go to (the one click
  rests on a later pass then, which one slow leg explains as well): two minutes lost on the 200 m from 4200m to 4400m
  put the 4400m pass where the runners of its pace pass 5300m, and "Missed 4200m" moved the good 4200m pass to 4400m,
  0.89 of their leg there where it fitted 4200m within 1.08 (the sure one click on the course for 30 of 167); not for a
  runner whose legs show a late start (the runners nearest it in time are slower: 570, two minutes late with 4200m
  missed, its real 4400m pass counted in 4200m fitting 4200m as well, keeps its sure one click at its finish read as on
  051d375).
- **While the first pass is in doubt, two more mats** (review.js checkOne `wide`, legTail). On the course with 800m and
  2400m missed the column check placed the first pass a split on, one run, and let the passes after it go: its 3100m
  pass, after a leg longer than any runner's from 1500m to 2400m, went out as 2400m until the one click. When the
  runner's first pass is behind the field's tail there (tailGap) and a later leg is longer than every runner's on its
  stretch (legTail, the slowest of the field before a gap of tailGap) and than the first pass's ratio would make it, the
  check places its passes up to two splits further: nothing goes out a split early while that is open, and the one click
  is sure as soon as the legs rule out a late start.
- **Three runs apart** (review.js missedStarts, startRuns, missedRunsText). A placing can have a third run (one split
  each, a split read between each two): ZT1 410, 800m, 2400m and 4200m missed with FinishLynx, was offered "800m, 2400m
  and 5300m" or "800m, 4200m and 5300m", the right set nowhere; now "Missed 800m, 2400m and 4200m: add them (1500m and
  3100m were read)" is placed with the others, the words "…, and 16:09.6 like 4400m, not 3100m".
- **One split typed alone** (engine #missedView `one`; public/app.js missedOne, the cell's menu). The cell where a set
  of several splits starts offers its own split alone to type, "Missed 800m: type its time…" ("the later times move on
  one split"), its suggestion between the split before and the pass that moves on: every split it changes is sent, and
  the runner's choices then offer the rest.
- **A refusal names the pass and the way on** (engine #canAdd, #stretchHeld). "Check bib 488's 4200m first: 16:33.7 is
  held (it looks like 4400m). Choose "It's right: keep it in 4200m" or Move it in its menu; then 4400m can be filled."
  (F19: "a pass of this runner looks like another split's"). 488's own cause, its good 4200m pass held as a late
  starter's (above), is gone: after "Move 20:30.9 to 5300m" its typed 4400m is taken and sent with the finish place.
- **What the boards show after an Undo** (engine review checks `sentOther`, public/app.js checkSentText, normReview). A
  held pass that never went out where it is held, while an output has another time there, says so: "It never went out:
  TrackScore and the live results show 4:50.8 at 1500m." (475 after an Undo said "It went out as 1500m before it was
  held").
- **The words.** missedLabel, missedAlso and finishedMissedText name the stray ("Missed 2400m: add it (11:24.4 is a
  stray pass): it goes to TrackScore and Karmarush, …"); missedUnsureText, missedGroup and cellModel the slow leg
  ("Split Relay can't tell: a missed mat or a slow leg", "2400m 10:51.5 may be a later split's, or bib 1 lost time on
  one leg: Split Relay can't tell which (below)."); runnerStatusText "about 2:30 lost before 2400m?". README (race day,
  Fix a runner: a late start, a slow leg, a stray pass, three apart, one split typed, the refusal, after an Undo) and
  the panel's Help (A runner who started late, A slow leg, A stray pass, Typing one missed split, Fix a runner) say all
  of it.

Unchanged: the column check's measure (the leaders' ratios, the tails, the field fractions; what it holds changes for a
count with a stray leg, for a runner one slow leg explains, and with the first pass in doubt, `wide`), missedCounts,
estimateGaps, the minute rules, Send with finish place and P4, config.js, the other runners' places after a fix (the
race tile's "N splits sent are out of date", the operator's open choice).

Not done: around the 200 m from 4200m to 4400m a stray read takes no longer than a real leg, or merges with the 4400m
read in the tag window. A runner who missed 4200m with a stray read soon after its 4400m pass has its 4400m pass counted
in 4200m (a leg 1.2 times the runners' of its pace), the stray in 4400m (a leg like theirs) and the 900 m on to 5300m
short by what the stray came after: under 0.8 of the runner's own pace from about 50 s on, not before. Silent at 45 s
for 37 of 167, at 60 s 6, at 75 s and 90 s 1 (051d375: all of them; F20 with the leaders' rule alone 119 at 60 s); the
cells' own choices fix it by hand. 4400m missed and a stray a minute after the 5300m pass, the stream's finish passes
and no FinishLynx: the row is there ("looks like 5300m or the finish, not 4400m"), but its two sets (4400m, or 4200m and
5300m) set nothing aside, and neither is sure (051d375: the same, 8 of 167 sure and right); Not a split for the stray,
then "Missed 4400m", fix it by hand. 3100m missed with a stray 30 s after the 4200m pass that merges with the 4400m read
(64 of 167): offered, "can't tell" between 3100m and 3100m with 4200m and the stray, never sure, never wrong. On the
course, 800m and 3100m missed: the first pass is held until the runner's third pass (its 4200m pass), and then 162 of
167 have their 1500m, 2400m and 4200m passes out a split early, as on 051d375, until the one click a pass later ("800m
and 3100m", sure at the 4400m pass): the column check lets the first two passes go as a late start's once the 4200m pass
is late for one, and the set offered then is not held (800m and 2400m: none out early). Three mats missed apart (800m,
2400m and 4200m, 532 in my browser check) on the course: held until the runner's fourth pass, then let go as one slow
leg fits about as well ("a missed mat or a slow leg"): the passes go out as read, a split or two early, until the one
click after the race (051d375: out from the second pass on, with a wrong set sure). A late starter who missed its first
mat can have a good pass taken for a stray by the gun's placings (bib 1 five minutes late, 800m missed): the set its
legs fit is offered beside the stray set, neither the one click (F19 had "Missed 800m" sure there). One slow leg on the
course: 19 of 4,008 runner-stretches still get a sure and wrong one click (16 of them with three or four minutes lost
just before 4400m or 5300m: little after them tells, and the pass that leg predicts is overdue). Review takes 18-28 ms
with nothing changed (051d375 9-17 ms): the slow leg, the stray sets and the late start are weighed for every runner
with a row each time. The re-check's minor items, measured again on the final code: a real missed mat's one click on the
course a pass later than before F19 (#nextOr), and 4400m without the finish line only after the race (rowlive8); twelve
minutes late with 800m missed and no FinishLynx a flag only (166 offered); no hint for 3 of 167 with 2400m, 4400m and
5300m missed and the finish line (tri: 87, 134 and 174, as 051d375), and for 323 of the 3,340 single-and-pair runners
without it (as 051d375); synthetic courses' sure and wrong one clicks 15 of 7,037 on fresh seeds (051d375 16).

Measured through the engine (051d375 → F20; the re-check's evals on 051d375 and mine on a git-archive copy of it, the
same harnesses on the final code; a look every 15 s of race time on the course). A missed mat and a stray pass
(probe8dup, the re-check's: 2400m missed, a read 40 s after the 3100m pass): with FinishLynx no hint and no row 167 →
the sure and right one click 167 (the stray Not a split, every split right); without it, the finish line in the stream,
offered 163 → sure and right 165, offered 2; sure and wrong 0. Mine (stray8: one stray read 30, 60 or 90 s after each
split from 1500m to 5300m, the mat before it missed, every complete runner, FinishLynx): silent 167 in each shape on
051d375 → the sure and right one click for all 167 with 800m, 1500m or 2400m missed (the stray after 1500m, 2400m or
3100m) and 4200m missed with the stray 30 s after 4400m, and 166 of 167 with 4400m missed (the stray after 5300m, one
offered); 3100m missed and the stray 30 s after 4200m (64 of them merged with the 4400m read in the tag window): no
runner silent (051d375: 103), sure and right 104, offered 63; 60 s and 90 s after 4200m sure and right 167 and 152 (15
offered). 4200m missed and the stray soon after the 4400m pass (the own-pace rule): at 45 s sure and right 129, silent
37; at 60 s 161, silent 6; at 75 s and 90 s 166, silent 1 (051d375: 167 silent at 60 s and at 90 s; F20 with the
leaders' rule alone 119 and 20). Without FinishLynx (the finish line in the stream) 2400m: 165 sure and right, 2
offered; 3100m: 165 and 2; 4200m at 60 s: 160 and 1, 6 silent; 4400m: a row for all 167, none sure (see Not done);
without the finish line either, 2400m 167 sure and right, 3100m 166 and 1, 4400m 165 and 2, 4200m at 60 s a row for 161
(the 5300m pass its last: no hint), 6 silent. Never a sure wrong one click in any shape, on the course or after it. A
complete runner with a stray pass (after 800m, 2400m, 4200m, 5300m; 45 s and 75 s): never held, a row for each where the
stray takes a split (167 of 167 after 800m and after 2400m, nothing sure: Not a split in the cell's choices); after
4200m the stray merges with the 4400m read in the tag window, which then takes its time (45 s after 4200m: "17:04.0
comes soon after 4200m for 4400m (0:45; runners of the same pace took 0:58)." for 73 of 167, no row on 051d375), after
5300m it is an extra pass. On the course the stray set's one click comes with the runner's next pass after the stray,
never before it a sure set without the stray (051d375: "Missed 2400m" without it, the stray to 4200m, sure for 158 of
167 until then).

A late starter who missed a later mat (late8 MISS, FinishLynx after the race): 4400m missed one, one and a half, two and
four minutes late, sure and wrong 21 / 74 / 19 / 1 → 0, sure and right 146 / 92 / 3 / 0 → 166 each (LYNX during the race
too: 74 → 0); 4200m and 5300m: sure and wrong 153 / 166 / 22 / 1 → 0, the right set sure 124 and offered 42 at one
minute, offered 166 at one and a half, two and four (051d375: not offered 145 and 166 at two and four); without
FinishLynx 4400m 164 → 160 sure and right (7 offered), 4200m and 5300m 2 sure wrong → 0. Six minutes late (LYNX): 2400m
167 offered → 167 sure and right, 4200m 167 offered → 166 sure and right, 800m 167 sure and right → 163 sure and right
and 4 offered; twelve minutes late with 800m missed without FinishLynx: 166 offered as before (item 9's flag only,
unchanged).

One slow leg, every mat read (late8s, every stretch, 1:00 to 4:00 lost, with and without FinishLynx; any sure "Missed"
is a wrong one): on the course the sure one click 0 on every stretch at every loss but 1 of 167 with 4:00 lost on the
700 m from 800m to 1500m, 1, 2 and 3 with 2:00, 3:00 and 4:00 on the 200 m from 4200m to 4400m, and 1, 5 and 6 with
2:00, 3:00 and 4:00 from 4400m to 5300m (19 of the 4,008 runner-stretches; 051d375, the re-check's shapes: 2:30 from
1500m to 2400m 156, 4:00 from 2400m to 3100m 122, 2:00 from 4400m to 5300m without FinishLynx 89, now 0, 0 and 1); after
the race with FinishLynx nothing held and nothing offered on every stretch; without it offered as "a missed mat or a
slow leg", never sure but 2 and 3 with 3:00 and 4:00 on the 200 m to 4400m and 1, 5 and 5 with 2:00, 3:00 and 4:00 from
4400m to 5300m; the 200 m from 4200m to 4400m with three or four minutes lost held as well (14 runners), and the last
leg from 4400m to 5300m with three or four minutes lost held until the finish pass (its 5300m line then goes with the
finish place, P4: under Finished, not sent live, for all 167).

On the course with 800m and a later mat missed (live4, the operator taking every sure one click 30 s after a pass):
lines out a split early before the first one click 167 → 1 (800m and 2400m, the finish line in the stream; 0 without
it), the one click by the runner's third pass, every split right; 800m and 3100m 167 → 162 (see Not done). Three mats
missed apart (tri3, mine, 1,670 runners in ten shapes): with FinishLynx sure and right 0 → 167 of 167 (lynx-tri3;
051d375 the right set offered for none); with the finish line sure and right 1,611, sure and wrong 3, offered 50, the
right set missing 3 (051d375: 0, 35, 0, 1,450); without it sure and right 996, offered 667, no hint 7 (051d375: 501,
501, 656 without the right set, 12).

Kept (as 051d375): runners with no missed mat, every look on the course and after the race (wf4 none, nonelive5): no new
sure one click and no new offer (the same 3 sure with the finish line and 1 without it as 051d375: 13 and 109, whose
5300m read looks like the finish, and 115, kept in 3100m by hand; on the course regular runners 0 sure, 0 offered); late
starters every mat read (late6 1 to 15 minutes, late8, late9 on the course): every count the same as 051d375, never
sure, never offered after the race, held on the course as F19; the real race's one clicks after the race (wf4: one, two,
three in a row at every split, two apart, a single and a pair, three apart) with FinishLynx 1,666 of 1,670 sure and
right, 4 offered (051d375 1,500, 3 offered, the 167 of three apart without the right set), without it, the three-apart
shapes left out, 15,226 of 16,700 sure and right, 474 offered (051d375 15,293 and 407); sure and wrong 0 everywhere but
the 3 of three apart above. counteval (one, two, three in a row from 800m, a dozen and every runner) as 051d375 but one
runner of two in a row offered instead of sure; apart.mjs (800m and 2400m, 800m and 3100m) 165 to 167 of 167 sure and
right first time (051d375 167), the others offered; on the course rowlive8 sure and wrong 0, offered at the end 7 to 25
(051d375 4 to 12), lines a split early as 051d375 (166 to 339: a real missed mat's own pass before anything can tell)
but 180 for 175 with one mat missed and the finish line (the one click a pass later, see Not done). Synthetic courses on
fresh seeds 81 to 100 (syn6, 7,037 runners a mat or more missed, rows and apart, with and without the finish pass): sure
and wrong 15 (051d375 16), sure and right 4,190 (4,211), offered 1,246 (1,207), no complete runner sure (52,994 of
them); synlate (2,305 late starters): none sure, held without FinishLynx 793 (051d375 854), on-time runners sure 0
(051d375 6).

Review (perf4, the real race with 84 runners a mat missed, an idle machine): cached 22-28 ms, settling at 18-20 ms over
60 looks, after a change a median of 121 ms (051d375 on the same machine: 14-17 ms settling at 9-11, 118-120 ms); the
runner editor 4-9 ms (4-8). The perf test of test/engine.test.js (600 runners by 3 splits, 2 mats) passes.

Tests (review.test.js, app.test.js, e2e.test.js; each new one fails on 051d375): a missed mat and a stray pass that
makes up for it in the count, the real race, runners from the front to the back of the field (2400m missed and a stray
40 s after 3100m, 1500m and 60 s after 2400m, 800m and 45 s after 1500m), with FinishLynx's finishes and with the
stream's finish passes: never silent, the one click sets the stray aside ("→ not a split" in its effect) and sends every
split right on both outputs alike, the stray in no column; a complete runner with a stray pass: nothing held, its flag's
Not a split the one click, every split right after it; 4200m missed and a stray 60 s after the 4400m pass (2, 3 and 5,
with FinishLynx and with the stream's finish passes): the one click sets it aside, every split right on both outputs; by
hand (strayOwn), a leg 0.74 of the runner's own pace a stray's, a late start and a fast last leg (0.85 of it) not; a
late starter who missed a later mat (4400m, 4200m and 5300m; one to two minutes late, FinishLynx): never a sure wrong
one click, the right set sure or offered, taken it sends every split right with the finish place; and, as on 051d375, a
late starter who missed 800m (one to twelve minutes late, FinishLynx) has "Missed 800m" as its sure and right one click;
one slow leg on every stretch (1:00 to 4:00 lost; 3:00 and 4:00 on the 700 m from 800m to 1500m too), on the course
never the one click, its passes out as read once a pass after it shows it, after the race nothing held, with FinishLynx
nothing offered, without it no sure "Missed 5300m"; 800m and 2400m missed on the course: nothing out a split early while
the first pass is in doubt, the one click by the third pass sending every split right; three mats missed apart (800m,
2400m and 4200m): the right set placed, the cell's own split alone to type, a typed 800m moving the later passes on with
every affected split sent, then the rest offered; by hand, a late starter who missed 4400m (488's shape): its typed
4400m taken after the Move, and the refusal words; after an Undo, a held row's "It never went out: …"; the column check
by hand (strayLegs, a stray leg no complete count, the slow map, the wide rule); the app's words (the stray set's label,
key, request, menu line and finisher's dialog, the slow leg's words, heading and cell line, the one-split typed choice,
checkSentText, normReview, the slow leg's quiet note, the refusal in the runner view); and through the app (e2e: bib 1
of the real race, 2400m missed and a stray read 40 s after its 3100m pass, the stream's finish and cool-down passes: its
Review row names the stray and is sure, its one click sends 2400m made up, 3100m and 4200m with their new legs to
TrackScore and Karmarush alike, the stray in no line, nothing held after it). Changed: CHECK_RULES' keys; F19's late
starter who also missed a mat (the right set sure is right too: with the runner itself at the back of the field the
count fit places a late starter's later passes, 31, 60 and 8 now sure and right), F19's walker 91 ("Missed 800m" sure or
offered with it), F19's one slow leg (its 2:00 on the 700 m from 800m: 'slow' or 'leg'), F17's synthetic races on the
course (sure and right for more than 0.28 of the runners, 0.3 before: 175 sure and 338 offered of 581, F19 182 and 332,
none wrong; a one click weighed against one slow leg is offered instead), the P2 refusal (its words).

The whole harness matrix on the final code (the re-check's 45 runs; my own Split Relay copies on my own ports, both
outputs, TrackScore-Master's own ingestion with no warning in any run, the merged .lif right for 116 of 116 scenario
runners): 389 of 399 scenarios sent exactly 051d375's lines with the same verdicts. The others: ZT1 410 (in ZT and ZTT)
and ZT7 546 (three mats missed apart) one click, every split right (051d375: a wrong one click, repaired by hand); TF5
485 (1500m, 3100m and 4400m missed) one click for all three (051d375: not sure, 1500m offered, its later passes held);
ZLT1 489 (late, 3100m missed) its 3100m typed through "Missed 3100m: type its time…" as 15:34.5 (051d375: not sure, a
made-up 15:40.6); ZLT3 488 its Move by hand to 5300m sent its 4200m too (16:33.7; 051d375: 5300m alone, a PROBLEM in
every phase after it); MQ1 421 its 4200m pass never on the boards as 2400m before its one click (051d375: "2400m
15:56.1" first); ZL6 446 the same lines with other places (051d375: a PROBLEM in every phase); Q4 227 its made-up 3100m
10:58.8 (051d375 10:58.9) and MQ6 442 its made-up 5300m 0.4 s apart, the harness's own wrong set taken in both. 202 one
clicks with an effect preview: every one sent what it said, the passes it said held not sent. Review: 18-28 ms cached, a
median of 121 ms after a change (051d375 9-17 and 118-120 on the same machine).

The panel in a browser (my own Split Relay copy on my own ports, the real Womens Race streamed at 100x, my FinishLynx
results after it; 1024, 1366 and 1920 wide: every Review button inside its row, two lines at most, no page scrolling
sideways). On the course, after 415's 2400m pass (2:30 lost from 1500m, every mat read): its 2400m held, "Split Relay
can't tell a missed mat from a slow leg until the runner's next pass: wait for it, or choose Missed 2400m: add it
(11:17.0 → 3100m).", no button gold; after its 3100m pass under Splits that look wrong, nothing held, "Split Relay can't
tell a missed mat from a slow leg (1500m to 2400m took 2:31 longer than runners of the same pace, and its later times
fit as read): choose Missed 2400m: add it (11:17.0 → 3100m, 13:46.9 → 4200m) only if a mat missed the runner."; after
the race with FinishLynx no row. 436 (2400m missed, a stray read 40 s after its 3100m pass): on the course "wait for it"
with no gold; after the race "Missed 2400m: add it (11:52.6 is a stray pass)" gold, "11:52.6 is a stray pass, 0:40 after
11:12.6.", the choice "8:40.0 suggested · 11:12.6 → 3100m, 11:52.6 → not a split"; with the finish place it sent 2400m
8:39.986, 3100m 11:12.594, 4200m 15:40.254 and 5300m 20:08.401 (the furthest last), place 95, to TrackScore and
Karmarush alike. 221 (4200m missed, a stray read 60 s after its 4400m pass, the own-pace rule): during the race its
lines went out as read (the stray as 4400m: nothing could tell before its 5300m pass); after it "16:42.2 looks like
4400m, not 4200m (missed 4200m?): 5:21 after 3100m, where runners of the same pace took 5:26. 17:42.2 is a stray pass,
1:00 after 16:42.2." with "Missed 4200m: add it (17:42.2 is a stray pass)" gold; it sent 4200m 15:46.046, 4400m
16:42.192 and 5300m 20:07.935, place 99, both outputs alike. 532 (800m, 2400m and 4200m missed): "Missed 800m, 2400m and
4200m: add them (1500m and 3100m were read)" gold; its 800m cell's choices "Missed 800m: type its time… the later times
move on one split"; 2:46.7 typed and sent with the finish place: 800m 2:46.7 and 1500m 5:15.653 out, the later passes
moved on and held, and "Missed 2400m and 4200m: add them (3100m was read)" then the gold one click, which sent 2400m
9:04.075, 3100m 11:45.355, 4200m 16:28.058, 4400m 17:27.493 and 5300m 21:17.993, place 144. Its passes had gone out as
read at the end of the race, before FinishLynx (see Not done). The Help's "A stray pass" says the own-pace rule.

#### 9.23 F21 (2026-10-31): a stray before the missed mat; one margin for every stray set; the leg and the furthest split on the boards; a slow last leg's 5300m

The operator's words, as for F13 to F20: "what i do want tested is what happens if we have to add someone's split
because they are missing at a certain point. It needs to resend all points effected automatically with the correct Laps
to go", and "every time I move someone from one split to another or change their lap series, I need it to resend their
corrected lines of data with the correct laps to go"; Karmarush must get exactly what TrackScore gets; the easiest way
possible, very user friendly and professional. An independent re-check of F20 (23590ad: its stray grid of every split,
30 to 90 s, the mat before or after it missed, with and without FinishLynx and the finish line; one slow leg on every
stretch at 1:00 to 4:00 lost; one fast leg; many strays in one race; the whole real race; synthetic courses on fresh
seeds; the 45-run harness matrix and its V9 and V9T runs end to end with TrackScore-Master's own ingestion; the panel in
a browser) found: after "Not a split" for a stray 30 s after the 800m pass and then "Missed 1500m", 2400m kept on both
boards the leg it had from the stray (5:11.6 where its cell said 3:25.0), its time and column the same as the boards had
(ls1, 825 runner-shapes); a one click on the course that set a stray aside, then FinishLynx's finish: 4400m went again
with the finish place after the 5300m line, the runner's newest line its 4400m (137 of 167, no row); a slow last leg,
every mat read, its 5300m pass held as "it looks like the finish", let go once FinishLynx's finish was known and then
never sent ("not sent live (bib 542 has finished)", 145 to 167 of 167 with 2:30 to 4:00 lost); stray sets that set a
REAL pass aside, sure: 5300m missed and a read 1:30 after the 4400m pass, "Missed 4200m (15:56.6 is a stray pass)" (14
of 167), 4400m missed and a read 30 s after the 4200m pass (4), V9's 453 ("Missed 1500m (11:26.2 is a stray pass)",
11:26.2 its real 3100m), a fast last leg (22 of 167 at 0.7 of the runner's own time); 3100m missed and a read 37 s after
the 4400m pass without the finish line or FinishLynx, "Missed 3100m" sure and the read sent as 5300m (15); V9's 577,
whose row asked about its real 3100m pass ("A stray pass?") with a sure Not a split, and whose Move by hand was refused
without naming the stray in the way; a synthetic 8K runner (seed 109, bib 128: 1 mile and 5K missed, a cool-down pass)
given the sure "Missed 1 mile" where its row said "can't tell which", a regression of F20; the walker 154 (800m, 4200m
and 5300m missed, the stream's finish passes) "Missed 800m, 4400m and 5300m" sure (3); one slow leg on the course still
the sure one click for 32 of 7,014 runner-stretches, most of them the last leg; a slow-leg runner's words on the course
saying a mat missed it ("…, but Split Relay can't tell yet how many"); a complete runner's stray pass whose row offered
only "It's right". The rule F21 keeps, the same for every one click: it is sure only when its placing of the runner's
times fits clearly better (CHECK_RULES.shapeMargin) than every other explanation of them, a stray pass and the passes as
read among them, and a pass the operator never questioned that Split Relay held goes to the boards by itself once it is
let go, for a runner whose times leave no doubt. What changed:

- **The leg each output got is kept with its copy** (engine ledgerEntry `ls`, the flight's `ls`, the race file's ledger
  row; #legOff; #runFix `refresh`; #sendFixed). A change's crossings went where an output's copy differed by time,
  place, gun, laps to go or split count, never by leg: 2400m's time and column after "Missed 1500m" were the boards'
  already (they had it from before the stray was set aside), so its new leg stayed home. An output's copy now says which
  leg it carried, and a change sends again every split of the runner whose copy has its cell as it is now and another
  leg, also one the change gave its old time back (a race file of before has no leg in its rows: nothing is sent again
  for those).
- **The furthest split last after the finish place is put back** (#repairFinishPlaces → #sendFurthestFinished). Revision
  11 sends a finisher's split that went out after its finish with the split place again with the finish place, on its
  own; then the runner's furthest split follows it, as after any earlier split (a one click on the course after the
  runner's finish read, before FinishLynx's file had it, went out with the split place).
- **What the column check let go of a finisher goes out with the finish place** (engine state `letGo`, #recheck,
  #letGoOf, #convergeRace). P4 keeps a finisher's real splits for Send with finish place: a split packet's place would
  replace the finish place. A crossing the column check held (its own question, so no output ever had it) and let go
  once the runner's finish was known (a slow last leg's 5300m pass, held as "it looks like the finish" until
  FinishLynx's finish was later) now goes by itself, with the finish place, as Send with finish place sends it, the
  runner's furthest split last. Only for a runner with every split read and no pass that may be a stray (#straysOf): the
  check lets go of a count a stray made complete too (3100m missed and a read 30 s after the 4200m pass, the real 4200m
  pass in 3100m and the stray in 4200m: before this condition both went out by themselves before the one click, 23 of 80
  on my grid). Not one an output has with another time or column (that still waits for Send with finish place), not a
  paused split's, not one of a runner whose change is being sent (the operator said how it goes), and not after a
  restart (what was let go is not saved).
- **The leaders' leg of the stray rules leaves a stray's leg out** (review.js leadersLeg, CHECK_RULES.leaderFloor;
  leaderLeg `stray`, fieldLeaderLeg; strayLegs, strayLegAt). The median of the five fastest legs on a stretch of those
  no shorter than 0.6 times the stretch's median leg: a leg far ahead of the whole field is a stray's (a read 30 s after
  a runner's 2400m pass, counted in 3100m). V9's field had four of those on the 700 m to 3100m, 453's own among them:
  1:15 was the leaders' leg there, so 453's stray 1:15 after its 3100m pass looked a real leg and its real 3100m pass
  the stray (and 577's row asked about its real 3100m pass); four strays 53 to 57 s after the 4400m pass in one race
  (multistray, seed 4) were the "leaders" on the 900 m to 5300m. The real race's fastest real leg on every stretch is
  0.88 of its median or more, the synthetic courses' 0.65 (2,100 stretches, seeds 1 to 140). Strays are a runner's at a
  time: five legs or more that far ahead (CHECK_RULES.leaders) are a group that ran it so, the leaders' leg as before:
  runners a mat (or the same mats) missed, whose counted legs are another stretch's. Left out, twenty runners in a row
  without 800m and 1500m (their real 200 m from 4200m to 4400m counted on the 900 m from 1500m to 2400m) were each "a
  stray pass", every one with a row "16:33.2 comes soon after 1500m for 2400m (0:55; runners of the same pace took
  0:57)" and Not a split for a real pass in it, and in a field where twenty-one missed 800m, 1500m and 2400m (perf4's)
  three lost their one click. Not the column check's own measures (its first leg against the leaders', legFloor; the
  wide rule): a field's counted legs there include missed mats', which F19 and F20 weighed as they are (with the floor a
  synthetic runner who missed 1.5K and 2.5K was no longer held, its 4K pass and finish read out as 1.5K and 2.5K). A
  first try, a leg with two more within 15 % of it, made a winner far ahead of the second a stray.
- **A stray before the missed mat** (engine #missedStartsOfNow: `can`, `soon`, the trail; `moved`; #missedStartOf and
  #countHint words). F20's stray sets started before the stray (the stray made up for a mat missed before it). With the
  runner's finish known, a set may also start after it: the stray made up in the count for a mat missed after it, the
  passes between them a split late (4400m missed and a read 30 s after the 4200m pass, the read in 4400m and the 5300m
  pass in its own column), or set nothing else (5300m missed and a read 1:30 after the 4400m pass: the finish read is
  then in 5300m, and 5300m is the finisher's trail, every split from there missed). And, with the finish known too,
  F20's rule against a placing that leaves a split missed between the stray's neighbours (the stray would be that
  split's pass) does not hold a stray that came sooner after the pass before it than anybody covers the stretch to that
  split (a read 30 s after a 4200m pass is no 4400m pass). On the course the runner's latest pass may be its last
  split's: there that rule made "Missed 4200m and 5300m (17:22.9 is a stray pass)" the sure one click for 5 of 167
  (4400m missed and a read 30 s after the 4200m pass, my grid streamed with the operator clicking), the real 5300m pass
  taken for the finish. Its words say the stray first: "18:36.8 is a stray pass, 0:30 after 18:06.8. 23:02.0 looks like
  5300m, not 4400m (missed 4400m?): 4:55 after 4200m, where runners of the same pace took 4:50." While the finish is
  unknown, the stream's finish pass may be the last split's and the stray's own flag says Not a split, as before.
- **A stray the one click would put in a split** (#missedStartsOfNow, #asCounted). Either pass of a leg that the placing
  clearly the cheapest would make shorter than anybody covers that stretch may be a stray too, not only as counted:
  3100m missed and a read 37 s after the 4400m pass, counted in 4400m (a leg like a real one there), "Missed 3100m" put
  it in 5300m 0:37 after 4400m; now "Missed 3100m: add it (16:10.6 is a stray pass)". Only from the placing that would
  be the one click: a slow leg on the course, its placings close, had its real passes "set aside" in offers.
- **One margin for every stray set** (#strayLegsFit `near`; #missedStartOf and #countHint `unsure: 'stray'`; strayWords
  `may`; public/app.js missedUnsureText, missedGroup, cellModel). A set that sets a stray aside stood where the runner's
  legs fitted it better than the passes as read and the plain sets, by anything: a runner who ran its last 900 m in 0.7
  of its own time fitted "Missed 5300m (17:40.3 is a stray pass)" (its real 5300m pass set aside) within 0.06 of its
  passes as read. It is the one click now only when it fits clearly better (CHECK_RULES.shapeMargin, as every other one
  click), else offered, its row saying the stray may be one ("15:41.6 may be a stray pass, 0:38 after 15:04.1. …") and
  then "Split Relay can't tell a stray pass from a fast leg (the runner's times fit about as well as they were read):
  choose … only if the runner was not that fast.", the menu heading "Split Relay can't tell: a stray pass or a fast
  leg".
- **A late starter's hint is made sure only over sets its legs can weigh** (#lateOr). F20 made an offered hint the gun
  could not settle the one click when its legs fitted it clearly better than its other set, and when the other set could
  not be measured at all: bib 128 of the synthetic 8K (1 mile and 5K missed, a cool-down pass; its other set one leg too
  few to weigh) had "Missed 1 mile" sure where its row said "Split Relay can't tell which". Not now: both are offered,
  as on 051d375.
- **A third run whose pass fits loosely is a rival** (review.js missedStarts). A second run's did already (`loose`):
  154, a walker who faded, 800m, 4200m and 5300m missed, its finish read 1.6 times the runners' leg from its 4400m pass,
  had "Missed 800m, 4400m and 5300m" as the sure one click with the right set nowhere; now both are offered.
- **A slow last leg on the course, its finish pass after it** (#nextOr). F20 waited for the runner's next pass before a
  one click that makes the last split's pass the finish; the next pass came and it was sure. As one slow leg reads them
  that pass is the runner's finish pass: when it came about when the runner's finish would (its leg from the 5300m pass
  over the runners' nearest in time there, at the runner's own pace: the median of its legs before, within
  FIT_RULES.fitWithin), and the slow leg lost no more than any slow leg (CHECK_RULES.slowLost), a cool-down pass could
  have come then as well, and Split Relay can't tell: offered (`unsure: 'leg'`). (On synthetic 5Ks of mile splits a last
  split missed would be a slow leg of 6 to 7 minutes: their one click stays sure.)
- **The slow leg's words while Split Relay can't tell yet how many** (#slowOr), and **the runner editor's line names the
  leg** (engine legOut, #missedView `leg`). A hint offered because a count can't be measured yet was left as "…, but
  Split Relay can't tell yet how many" on the course, a mat missed the runner for all the words said; #slowOr now weighs
  it too, and with a slow leg as good its words are the slow leg's ("Split Relay can't tell a missed mat from a slow leg
  …"). The Review row named the leg ("(1500m to 2400m took 2:29 longer than runners of the same pace, and its later
  times fit as read)"); the runner editor's line under the cells, from the same hint, did not.
- **A short leg's row offers Not a split** (public/app.js flagChoices). A runner with every mat read and a stray pass
  whose leg is not under FIT_RULES.strayBelow of the runners' had only "It's right" in its Splits that look wrong row
  (the re-check's 549: "5:54.7 comes soon after 1500m for 2400m"), Not a split in the runner's own menu: it is a plain
  choice in the row now, beside It's right, never the gold one. A finisher's row choice asks first with the pass's own
  time (public/app.js flagPass: 577's asked "undefined is not a split.", in my browser check; since efd73b5 for a
  finisher's flag with a suggestion).
- **A Move a stray pass is in the way of names it** (engine #moveProblem `stray`, #strayFlagged; the runner editor's
  targets, POST /move, the Review list's Move). V9's 577 (4400m missed, a stray read 1:30 after its 2400m pass, counted
  in 3100m) had its Move of its real 3100m pass refused eight times: "The pass at 10:54.7 can't be 3100m: 4 earlier
  passes need the splits before it." The pass its look-wrong flag takes for a stray is named as the way on: "… If 9:53.7
  is a stray pass (it came soon after the pass before it), choose Not a split for it first."
- **A Review with nothing changed makes no row's choices again** (#hintView, once per hint of the cached Review list).
  Each row's "Missed …" choices (the plan, the suggestions, what each does and what the check would hold) depend on the
  race's crossings only, as the hint does: the Review list is made again when they change, and so are they.

Unchanged: the column check's measure (what it holds), missedCounts, estimateGaps, the minute rules, Send with finish
place and P4 for a real split the operator changes or a paused split's, config.js, the other runners' places after a fix
(the race tile's "N splits sent are out of date", the operator's open choice), COUNT_RULES and CHECK_RULES' values (one
key more, leaderFloor).
Not done: without FinishLynx a slow last leg's 5300m pass and the stream's finish pass after it read as well as a missed
5300m and a cool-down pass (the race's cool-down passes come 0:25 to 7:39 after the finish): the 5300m pass stays held
with the row's question, offered, never sure, until the operator chooses or FinishLynx's finish comes; and, the other
way, a real missed 5300m whose cool-down pass came about when a slow leg's finish pass would is offered after the race
without FinishLynx, not the one click (6 of 167 with the finish line: 142 sure and right on wf4, 148 on 23590ad; the
same 6 on rowlive8 and counteval, 5 on live4's 3100m and 5300m), as is item 15's "Missed 5300m" after Not a split for a
stray 30 s after the 4400m pass (25 of 167 end on it, 19 on 23590ad). On the course a slow leg of two to four minutes on
the 200 m from 4200m to 4400m (four to five times the runners' leg there) still makes "Missed 4400m" the sure one click
for 1 to 3 of 167 once the finish pass is in (91, 100, 107, 57), 4:00 on the 700 m to 1500m for 1 (134), as on 23590ad,
and the race's slowest walker, 154, with 1:30 to 4:00 more lost from 4400m to 5300m, "Missed 5300m" (91 too at 4:00;
their own pace from their earlier legs says nothing of their fade); FinishLynx's finish then puts each right, nothing
held, nothing offered. A runner who ran its last 900 m in 0.7 of its own time, every mat read, still has a stray set as
the sure one click for 3 of 167 (96, 100, 107: their legs fit it clearly better than as read; 22 on 23590ad). A real
fast leg can look like a stray before a missed mat once the finish is known: offered, never sure, its row saying "… may
be a stray pass" (21 of 167 with 15 s gained on the 200 m to 4400m; 4 to 55 of 167 at 0.7 of the runner's own time on
the legs to 1500m, 2400m, 3100m and 4400m; 0 on 23590ad, where the row said "comes soon after" only). A stray set its
legs fit only about as well as the passes as read is offered, not sure: 4200m missed and a read 60 s after the 4400m
pass, the stream's finish passes and no FinishLynx, 96 sure and right and 64 offered (160 sure on 23590ad), 45 s after
it 119 and 9 (127 and 1); with FinishLynx 160 (161) and 129 (129). Around the 200 m from 4200m to 4400m a stray read
still merges with a real one, as on 23590ad: 4400m missed and a read a minute after the 4200m pass is a 4400m pass a few
seconds late for every check (silent for 166 of 167; 90 s after it 71 without FinishLynx and 147 with it), and 4200m
missed with a read 45 s after the 4400m pass is silent for 37. V9's 577 takes two clicks: its row's plain Not a split
for the stray (not the gold one: its leg is not under a quarter of the runners'), then the gold "Missed 4400m: add it";
the harness, which takes only gold one clicks and Moves, leaves it as on 23590ad. The re-check's minor items unchanged:
on the course with 800m and 3100m missed the passes go out a split early until the one click (item 3); a real missed
mat's one click on the course a pass later than on 051d375 (item 4); a late starter twelve minutes late with 800m missed
and no FinishLynx a flag only (ZLM4 555), LMM 477 offered only (item 6); no hint for some three-mat shapes without the
finish line (item 7); how long a slow leg's passes wait on the course (item 18); the late-start side effects of F20
(items 21 and 22); the re-sends of a runner's lines while other runners' reads move its place by one (item 32).

Measured through the engine (23590ad → F21 on git-archive copies of both, the same seeds; the re-check's evals and
mine). My stray grid (195 combos: one stray 30 to 90 s after every split, the mat before or after it missed or none,
with and without FinishLynx and the finish line, after the race and streamed with the operator taking each sure one
click; 30,671 runner-shapes): right at the end 16,858 → 19,687, sure one clicks that sent a wrong line 61 → 14 (all on
23590ad too: a stray 30 to 60 s after the 3100m pass with 4200m missed, 9; a stray 30 s after the 4400m pass with 5300m
missed and no FinishLynx, 5), silent at the end 1,090 → 891, silent before any click 891 (the same), on the course no
sure one click that sent a wrong line (as on 23590ad; 5 on my snapshot before a set leaving a split between a stray's
neighbours waited for the finish). The re-check's shapes: ls1's (a stray 30 or 60 s after 800m, 1500m, 2400m or 3100m
with the next mat missed, FinishLynx) wrong at the end 1,326 → 0 of 1,336; its two clicks (Not a split, then Missed
1500m) now send 2400m again with its leg, L2G 6 4:56.422 LS 2:16.629, L2G 5 8:21.419 LS 3:24.997, L2G 1 18:58.594 LS
3:12.442, P23 (23590ad: no L2G 5, LS 5:11.626 left on both boards), and its one click is "Missed 1500m: add it (3:09.8
is a stray pass)" with the same lines; 5300m missed and a stray 90 s after 4400m: sure and wrong 14 → 0, right 0 → 167
(fixture 4: "Missed 5300m (17:26.6 is a stray pass)" sent L2G 1 19:05.994 LS 3:09.395 P24); 4400m missed and a stray 30
s after 4200m: right 0 → 162 (fixture 57: L2G 2 19:09.119 LS 1:02.325, L2G 1 23:01.994 LS 3:52.875, P164), streamed: no
sure one click on the course, 162 sure and right after FinishLynx; item 12's shape (4200m missed, a stray 75 s after
4400m, a one click on the course, then FinishLynx): wrong at the end 137 → 2 (fixture 3: L2G 3 15:34.575 LS 4:24.782,
L2G 2 16:30.860 LS 56.285, L2G 1 19:54.493 LS 3:23.633 on the course, then L2G 2 16:30.860 P86 and L2G 1 19:54.493 P86
after FinishLynx); item 14's (3100m missed and a stray 90 s after 4200m, no finish line, no FinishLynx): clicks that
sent a wrong line 15 → 0 (fixture 10: L2G 4 10:34.657, L2G 3 14:40.593 LS 4:05.936, L2G 2 15:32.193 LS 51.600, L2G 1
18:40.252 LS 3:08.059); a stray after the 5300m pass, no mat missed, FinishLynx: wrong at the end 20 → 0 at each of 30,
60 and 90 s. probe8dup (2400m missed, a stray 40 s after 3100m): with FinishLynx 167 sure and right, without 165 and 2
offered, as on 23590ad. Many strays in one race (multistray, 50 seeds, K = 4, 8 and 12): with FinishLynx silent 12, 47
and 120 → 5, 19 and 82, sure one clicks that sent a wrong line 1, 1 and 1 → 0, right at the end 105, 204 and 270 → 153,
293 and 376; without silent 5, 13 and 22 → 5, 9 and 19, sure one clicks that sent a wrong line 1, 7 and 23 as before,
right at the end 87, 174 and 230 → 90, 186 and 260 (with five strays or more on one stretch, at K = 8 and 12, the
leaders' leg is theirs as on 23590ad: the group rule above; without it silent 9 and 14 with FinishLynx).

One slow leg, every mat read (late8s, every stretch, 1:00 to 4:00 lost; any sure "Missed" is a wrong one): with
FinishLynx after the race (34 stretch-losses, 5,678 runner-stretches) the sure one click on the course 31 → 15 (the last
leg 22 → 6: 1 at 1:30 as before, 5, 5, 5 and 6 → 1, 1, 1 and 2 at 2:30 to 4:00, the walker 154 at each and 91 at 4:00;
as on 23590ad the 200 m to 4400m, 1 at 2:00, 2 at 3:00 and 3:30, 3 at 4:00, and 1 at 4:00 to 1500m), the newest line
wrong at the end 675 → 0 (the last leg's 5300m 145, 167, 167 and 167 → 0 at 2:30 to 4:00, 4400m 13 and 6 → 0, the V9 L3
542's shape); FinishLynx live 144 → 0; without FinishLynx (18 stretch-losses) sure on the course and after the race 13 →
5, held after the race 360 as before (a slow last leg is not told from a missed 5300m and a cool-down pass); without the
finish line nothing changes. slowhold: the same waits, the newest line wrong at the end 1, 32 and 167 → 0. One fast leg
(fastx, 0.7, 0.75 and 0.85 of the runner's own time on every leg, with and without FinishLynx; 6,012 runner-legs): sure
22 → 3, offered 0 → 163 (all at 0.7 with FinishLynx), no wrong line.

Kept (as 23590ad): the whole real race's shapes after the race (wf4: one, two and three in a row at every split, two
apart, three apart, none, with FinishLynx and without; counteval; apart; byhand): every count the same but one mat
missed at 5300m with the stream's finish passes and no FinishLynx, 148 → 142 sure and right (Not done); on the course
rowlive8 and live4 the same but those 6 (5300m: one click on the course 26 → 20, offered at the end 19 → 25; 3100m and
5300m: 193 → 188 and 13 → 18). Three apart with the finish line (tri3, 1,670 runners): sure and wrong 3 → 0, the right
set missing 3 → 1, right at the end 1,663 → 1,668. Late starters (late6 1 to 15 minutes, late7 1, 5 and 12 minutes,
late8 and late8miss, late9 on the course): every count the same but one minute late with 5300m missed, sure on the
course 24 → 18 (the others offered there; 167 sure and right after the race). No mat missed (wf4 none, nonelive5): the
same. Synthetic courses (syn6) on the re-check's seeds 101 to 120 and fresh seeds 121 to 140 (14,610 runners a mat or
more missed): sure and wrong 13 → 12 and 12 → 9, none new (the re-check's seed 109 bib 128 has both sets offered again),
sure and right 4,256 → 4,238 and 4,446 → 4,432 (a last split missed whose next pass came when a slow last leg's finish
pass would: offered, as above), complete runners never sure (105,500); synlate (late starters, FinishLynx): the newest
line wrong at the end with FinishLynx 748 → 0 and 754 → 0 (let go with the finish place), held without FinishLynx 748
and 754 as before, on-time runners sure as before (1 and 0).

Review (perf4, the real race with 84 runners a mat missed, an idle machine, four runs of each, one after the other):
cached 27-53 ms → 1-5 ms (each row's choices made once per cached list), after a change a median of 161-186 ms → 164-184
ms, the first Review 322-345 → 330-349 ms, the runner editor 5-12 → 5-13 ms (this machine measured 23590ad at 139-142 ms
after a change in the morning; before the group rule above the 20 extra rows of perf4's field cost F21 20 ms more). The
perf test of test/engine.test.js passes.

Tests (review.test.js, app.test.js, e2e.test.js; each new one fails on 23590ad, and each piece of this round's later
work with that piece switched off): the leg a board got from a stray goes again after "Not a split" then "Missed 1500m"
(the re-check's ls1, every split's newest line with its cell's leg on both outputs, nothing again after a restart); the
furthest split last after the finish place is put back (a one click on the course after the finish read, then
FinishLynx's file); a slow last leg's 5300m (2:30, 3:00, 4:00 lost) out with the finish place once FinishLynx has the
finish, nothing left for Send with finish place, and not a count a stray made complete (3100m missed and a read 30 s
after the 4200m pass: nothing of it out before the one click, which sends every split right); a stray before the missed
mat (5300m missed and a read 1:30 after the 4400m pass, 4400m and 30 s after 4200m, 1500m and 30 s after 800m, 2400m and
60 s after 1500m, FinishLynx): the one click sets it aside and adds the split after it, the stray first in the words,
every split right on both outputs; the same streamed on the course (4400m and 30 s after 4200m, 75 and 104): no sure one
click before the finish, then "Missed 4400m (… is a stray pass)", every split right; a stray the one click would put in
a split (3100m missed and a read 37 s after the 4400m pass, no finish line and no FinishLynx), through the engine and
through the app; V9's 577 (the fixture's 162): its row's Not a split on the stray, the Move refusal naming it, then Not
a split and "Missed 4400m", every split right on both outputs; a fast last leg (0.7 of the runner's own time, every mat
read): never the one click, "a stray pass or a fast leg", "… may be a stray pass", and a real 4400m pass 15 s fast
offered in the same words; the walker 154, three mats apart, both sets offered; a slow last leg on the course with its
finish pass after it: never the one click; the slow leg's words on the course while Split Relay can't tell yet how many,
and the editor's line naming the leg; the leaders' leg by hand (a stray's leg alone at the front, four close together
far ahead of the field, five a group that ran it so, real leaders far ahead of each other) and a mat missed by many
through the engine (twenty runners in a row without 800m and 1500m, FinishLynx: no "comes soon after" row, no wrong one
click); the synthetic 8K's 128 (seed 109): both sets offered; the panel's words for 'stray', the row's plain Not a split
(flagChoices) and a finisher's row question with the pass's time (flagPass). Changed: F20's "a stray soon after the
4400m pass" (2 with the stream's finish passes is offered, its legs 0.14 better than as read, within the margin),
womensLate's `step`, CHECK_RULES' keys.

The whole harness matrix on the final code (the re-check's 45 runs and its V9 and V9T; my own Split Relay copies on my
own ports, both outputs, TrackScore-Master's own ingestion: 83,819 objects from TrackScore as from Karmarush, no warning
in any run; the merged .lif right for 138 of 139 scenario runners, 577 the one): 45 of the 47 runs sent exactly
23590ad's lines with the same verdicts in every scenario. runMQ: MQ1 421 and MQ3 481 the same lines in another order
mid-race, verdicts OK (421 on every run of this round, 481 on some: a place update of an earlier split before or after
the one click's lines in the same pass; 421's 4400m line went after the other splits' place updates, with its new place;
23590ad's own copy on this machine sent 23590ad's order). runV9: S4 453 the one click right (23590ad: a PROBLEM,
repaired by hand), S6 459 and S7 447 one click where 23590ad took two, L3 542 its 5300m out with the finish place
(23590ad: a PROBLEM in every phase); S5 577 (two clicks: Not done) and L1 220, L2 428 and L4 565 (their newest line's
place after FinishLynx: other runners' places, not in scope) as on 23590ad. Runs of this round with my evals beside them
also differed by when a place update landed in a window after a fix mid-race (runM M2 522, runNM NM1 595 and NM4 506,
runQ Q6 502, runQT Q9 564): on an idle machine each is identical to 23590ad.

The panel in a browser (my own Split Relay copy on my own ports, the real Womens Race streamed at 100x with my scenario
runners, my FinishLynx results after it). On the course, 220 (2:30 lost from 1500m to 2400m, every mat read): its 2400m
cell "may be a later split's, or bib 220 lost time on one leg: Split Relay can't tell which (below)", the line "Split
Relay can't tell a missed mat from a slow leg …", no button gold; after the race with FinishLynx no row, its seven lines
its real times (2400m L2G 5 10:51.419 LS 5:54.665). 510 (2400m missed, a stray read 40 s after its 3100m pass): the gold
"Missed 2400m: add it (11:33.7 is a stray pass)", with the finish place, sent 2400m L2G 5 8:25.827 LS 3:31.251 P79,
3100m L2G 4 10:53.659 LS 2:27.832, 4200m L2G 3 15:09.559 LS 4:15.900 and 5300m L2G 1 19:18.134 LS 3:14.341 P79 to both
outputs alike. 423 (800m, 2400m and 4200m missed): 2:50.1 typed in its 800m cell sent 800m L2G 7 2:50.100 and 1500m L2G
6 5:18.600 LS 2:28.500, P137; then the gold "Missed 2400m and 4200m: add them (3100m was read)" sent 2400m L2G 5
9:07.483 LS 3:48.883, 3100m L2G 4 11:49.139 LS 2:41.656, 4200m L2G 3 16:30.271 LS 4:41.132, 4400m L2G 2 17:29.359 LS
59.088 and 5300m L2G 1 21:09.593 LS 3:40.234, P137, both outputs alike. 453 (V9's: 1500m missed, a stray 1:15 after its
3100m pass): the gold "Missed 1500m: add it (12:41.2 is a stray pass)" sent 1500m L2G 6 5:10.954 LS 2:25.072, 2400m L2G
5 8:51.980 LS 3:41.026, 3100m L2G 4 11:26.196 LS 2:34.216, 4200m L2G 3 15:53.092 LS 4:26.896 and 5300m L2G 1 20:12.895
LS 3:24.002, P97, both outputs alike (23590ad: its real 3100m pass set aside, the stray sent as 3100m). 549 and 577
under Splits that look wrong with a plain Not a split beside It's right, 577's on its stray 9:53.7; 577's asked
"undefined is not a split." (flagPass, fixed: "9:53.7 is not a split. …") and sent 3100m L2G 4 10:54.692 LS 2:31.019 and
4200m L2G 3 15:17.033 LS 4:22.341, P67; then its gold "Missed 4400m: add it" sent 4400m L2G 2 16:12.807 LS 55.774 and
5300m L2G 1 19:37.054 LS 3:24.247, P67, both outputs alike.

### 9.24 A split too fast to be real; Stop sending this runner; the boards put right by themselves; the clearing line (2026-11-10)

The meet this is about: IvyXC, 2026-10-31, Women's 6K (seven splits: 600M, 1K, 2K, 2.6K, 3.4K, 4.4K, 5K), bib 142. Places
55, 59, 67, 69 and 74 at the first five splits, then she dropped out, and two more reads of her chip went to TrackScore
and the live results as 4.4K 15:36.4 place 32 (re-sent as 33) and 5K 17:06.3 PLACE 6. Her leg to the first was 3:01.7,
where the leaders took 3:21 and the fastest leg of anybody else was 3:15.9; to the second 1:29.9 (leaders 2:09). The
operator's words: "it was very clear because she ran too fast of times compared to the leaders, and she was dropping and
dropping then ran a really fast split and then another. Then did not read again. so I just want something like that to
be flagged and a way to stop that person from sending, as well as wiping the bad splits and resending after a change is
made". The version of that day (9accc0a) marked nothing in that race. 21b9229, fed the same reads in arrival order,
still sends both lines and marks only the 5K afterwards (its leg under 0.75 of the leaders': a stray; the 4.4K, 0.90 of
the leaders' and 0.87 of the runners of her pace at that moment, passes every rule), one mark per runner, in Review only.

**Marked, never held.** The first build of this section held such a pass like the column check does (not sent until the
operator chose). The operator: "I dont want to hold a split that is too fast. I just want to flag it". So nothing new is
ever held: the line goes out exactly as before, and the hold was taken out again, not switched off. What is new is the
mark, from the moment the read arrives, where it catches the eye.

**The measure** (src/review.js `FAST_RULES`, `fastField`, `fastLegsOf`, `paceAt`, `fastText`). For a runner's real
crossings in two splits next to each other: x = the leg over the leaders' leg on that stretch, the leaders' leg being
the median of the five fastest legs of the OTHER runners with a real crossing at both splits (five of them at least:
`minRefs`; a runner is never its own reference). The runner's own pace = the median x of its earlier legs (its first
split's time over the leaders' time there counts as one). A leg is too fast to be real when

- x < 0.95 (`below`): clearly faster than the leaders ran it, and
- x < 0.88 x the runner's own pace (`ownBelow`): the runner was not running with them, and
- the runner's earlier legs agree, the slowest within 1.5 times the fastest (`steady`): a mat that missed the runner
  makes one counted leg two stretches long and the next ones another stretch's, which can be shorter; those are the
  column check's and the missed-mat fixes' (9.23 F13-F21), never "not a split?".

A runner's mark is the first such pass and the passes right after it that are too fast as well, each measured from the
one before (142: 4.4K, then 5K). A pass that is too fast only because a stray took its split is not part of it: with the
passes before it set aside it would be the split after the last good one, and when its leg from there fits the runner's
own pace (0.88 to 1.15 of it) it is the runner's real split, a column late (the stray's fix moves it back). Not judged:
the first split (no leg), a leg to or from a made-up time (no real crossing there), a leg to or from a pass the operator
placed or said is right, anything after the mark, a runner with a timing point's read, a runner the column check holds
a pass of, a stopped runner's crossing.

**The numbers, from the data.** Every pass of the nine real races on disk (the six two-split races of 2026-10-28, the
7-split race of 2026-10-21, the IvyXC Women's 6K and Men's 8K; 2,807 passes with a split before them, 2,764 of them real
runners' real splits), each judged in the state at the moment it arrived and again after its race:

| | x (leg / leaders') | x / own pace |
|---|---|---|
| lowest real pass at its arrival | 0.973 (W7 544, from 32nd to 8th on the leg to 2400m) | 0.920 (Girls 1A 537, x = 1.11) |
| lowest real pass after its race | 0.913 (Girls 1A 571, a winner far ahead of a field of 51: own pace 0.957) | 0.920 |
| lowest real own-pace ratio among legs faster than the leaders' (x < 1) | | 0.942 |
| bib 142, 4.4K | 0.902 | 0.827 |
| bib 142, 5K | 0.686 at arrival (five others through), 0.695 after | 0.634, 0.642 |

No single number separates them (a winner's 0.913 against 142's 0.902): the two together do. 142's first read is 5 %
inside `below` and 6 % inside `ownBelow`; of the real passes, two are inside `below` (both the leader of their race,
0.957 and 1.002 of their own pace: 9 % outside `ownBelow`), none is inside `ownBelow` at all (the nearest 4.5 % outside,
with x = 1.11; among legs faster than the leaders' 7 % outside). Bib 94 of the Men's 8K, who fell from 40th to 82nd on
one leg, has no leg under the leaders' at all. The pure rule over every runner in every arrival state of the nine races
(386,201 runner-states) calls six legs too fast: 142's two, two athletes of other races in the Men's 8K (161 and 178,
each at 1K: 0.87 and 0.92 of the leaders' from a "600M" at 8 to 10 minutes) and two of 2026-10-28 (Girls 3A 221 and
Girls 2A 213, their "2 Mile" 1:25 and 1:09 after their "1 Mile"). No real split.

`steady`, measured: every complete runner of the three long races with one mat taken out and its passes counted a
column early (W7 167 runners x 7 mats, the Women's 6K 82 x 7, the Men's 8K 84 x 9). Without `steady` every runner with
one of the first four or five mats missed has a "too fast" leg further on; with it none, but W7's first mat (165 of 167:
with one pass before the short leg there is nothing for the legs to disagree about). The column check holds those
(a missed first mat) and the pace check then leaves the runner to it; the replay of 2026-10-21, with four real runners
a mat missed, marks none.

**When and where** (src/engine.js `#recheck`, `#reviewOf`). The measure runs with the column check, as each read comes
in, before anything is sent (one pass over the runners: the six fastest legs of every stretch are kept, so a read stays
cheap), into `state.check.fastOf`; the log says it once ("Women's 6K: Bib 142, 4.4K 15:36.4: 3:01.7 after 3.4K, where
the leaders took 3:21. Too fast for a runner who was 74th: not a split? Marked (Splits that look wrong); it went out as
any split."), and the read's feed row ends "Too fast to be real? Review lists it under Splits that look wrong." From it:

- Review, Splits that look wrong: ONE row per runner that covers every pass of the mark (`passes`), kind 'fast': "Bib
  142, 4.4K 15:36.4: 3:01.7 after 3.4K, where the leaders took 3:21; 5K 17:06.3: 1:29.9 after 4.4K, where the leaders
  took 2:09. Too fast for a runner who was 74th: not splits?". Not a split and It's right act on all of them in one
  change (`movePass` takes `also`): two rows would have let Not a split on the first count the second read into the
  first's split. Stop sending this runner is the row's third choice.
- A missed-mat cause listed for the runner, or its look-wrong flag at the same or an earlier split, comes first, with
  its own words and fixes (a stray under 0.75 of the leaders' keeps "… A stray pass?", its 9.23 fixes and its tests);
  the mark stands for a flag at a later split, which is measured from a pass that is no split (142's old 5K row).
- The counts (`RaceView.review.fast`, `fastBibs`, only when there is one): the Dashboard's Needs attention has a row
  per race ("Bib 142: a split too fast to be real", Open Review); the race tile's Review count and tone had `flagged`
  already. The stray rows about the very split the pace check marks count too (221 and 213 of 2026-10-28, one of
  them PLACE 1 at "2 Mile": nothing had said so on the Dashboard).
- The grid and the runner editor: the mark on every cell it covers, one problem line, the choices with `also`.

**After Not a split for the first read only** (the operator is quick, the second read not in yet): the runner's next
read takes that split by counting and goes out. It is marked when it comes slow for the runner (`afterAbove`: over 1.15
of the runner's own pace measured from its last good split, and not as slow as a missed mat makes a leg, 1.5): "Bib 142,
4.4K 17:06.3: 4:31.6 after 3.4K, where the leaders took 3:21. Slow for this runner, and it follows 15:36.4, which was not
a split: is it 4.4K?" (hers would be 1.24; 99 of 100 real legs are within 1.17 of the runner's own pace). No one click.
A next read that fits the runner's pace is its split and says nothing.

**Stop sending this runner** (`stopRunner`, `resumeRunner`, `#offs`, `#stopPlan`; POST `/runners/:bib/stop` and
`/resume`). The operator's only way to keep a runner off the boards now, so it is on the row, in the marked cell's
choices and at the top of the runner. Journaled as { t: 'runner-off', raceId, bib, from } ('stop' is the journal's clean
stop) and { t: 'runner-on', raceId, bib }, records of a change like a pin: one fix id, Undo and Redo by the inverse,
replayed at a start, kept by Clear race data with the pins (a time of day, as they are). `from` is a time of day: the
pass it was pressed on, else the runner's first split in question, else just after its last pass so far. The runner's
kept crossings from then on are held for a new reason, 'stopped' (`#holdOf`: nothing of them is sent, resent or written
to the merged .lif, a queued packet of theirs is no longer current), they do not count for the places of the others
(`heldBySplit`), they are no reference for estimates or flags, and they carry no question (no Passes to check row, no
mark). What went out before `from` stays as it is: a runner who dropped out was 74th at 3.4K. The grid ("Not sending
from 15:36.4 on"), the cells (Not sending), Review (Not sending, with Send this runner again) and the feed ('not-sending')
say so. The existing grid tier for runners with no read lately is `stopped` in the code and "No read lately" in words;
this one is `off` / "Not sending".

**The boards put right by themselves** (`#runFix` -> `#resendOthers`). 9.23 F4 sent the runner's own changed lines and
left the other runners' places to the race tile's Resend once their minute was over (a place alone would make an old
split's place the runner's place on TrackScore). Now every change (Not a split, a Move, Missed …: add it, a fill, an
Undo or Redo, Stop and Send again) ends by sending, to each output where it is out of date, every line of the other
runners that the change made out of date (what `#staleCount` counts after the change and did not before), in course
order, and then each of those runners' furthest split, so TrackScore ends on the right place. By Resend's rules: not for
a race that is not Active, a paused split or a held pass; a finisher's real split is left alone; a finisher's made-up
split goes with the finish place. `change.resent` = { lines, outputs }, `staleOthers` is what is left (0 unless an output
refused); the toast: "127 lines of other runners re-sent with their new places." The runner's own emptied cells stay
counted as out of date on the race tile, as before: no packet empties them.

**The clearing line** (an output's `clearLines`, kept in the settings only when on; Outputs: "Send a clearing line when
a split is taken back"; `#sendClears`). For each cell a change took back that the output has a copy of (emptied, or
stopped): the runner's row for that split with csTicks, lsTicks and place null, reason 'clear', its laps to go as ever,
rendered by the output's script like any packet (empty place and time fields). Once the output took it, its copy is
forgotten: no "still shows" note for that output, and a time that comes back goes out as new. TrackScore's ingestion
ignores an empty time today, so this is groundwork; with it off not one byte on the wire differs.

**Proof.** Golden replays (the audit's harness, the day's reads in arrival order with the operator's gun and Active
events, then a rebuild from the journal): every packet identical to 21b9229 on all three days (2026-10-28: 1,098,
2026-10-31: 1,587, 2026-10-21: 1,285; the same digests) and live = rebuild on all three. The Review differs only by the
marks: 2026-10-31 Women's 6K, 142's row in place of "17:06.3 comes soon after 4.4K for 5K …"; Men's 8K, 161 (new) and 178
(in place of "20:31.9 looks like 5K, not 2K …", which is measured from the marked pass). 2026-10-28 and 2026-10-21: the
same rows as before; 221 and 213 now count in Needs attention. Through the engine, read by read: 142 is marked by the
very read of 15:36.4 (11:15:35), the row covers both from the read of 17:06.7. Stop sending this runner pressed then:
"Not sent from 15:36.4 on (4.4K taken back)", her furthest split (3.4K) goes again, and neither 17:06 read is ever on
the wire. Not a split on the row after both went out: "15:36.4 and 17:06.3 are not splits now", 127 lines of other
runners re-sent (50 at 4.4K, 77 at 5K), her splits out of the merged .lif data; Undo puts all of it back.

Asked for alongside, and not changed: a runner a mat missed, on the same real race, both outputs. One mat (bib 203,
2.6K): its 3.4K read is held before it goes out ("Looks like 3.4K, not 2.6K (missed 2.6K?)"), the one click "Missed 2.6K:
add it" is sure when its next read arrives, the suggested 9:10.5 is 3.3 s from its real 9:07.1, both outputs get 2.6K,
3.4K and 4.4K alike with their laps to go, legs and places, 72 lines of other runners follow, nothing is a column early.
Two mats in a row (bib 144, 2K and 2.6K): its 3.4K read GOES OUT as "2K 12:22.4 place 85" and is marked at once
("12:22.5 looks like 3.4K, not 2K (missed 2K and 2.6K?)"), its 4.4K read goes out as "2.6K 16:11.8 place 84", and the
one click "Missed 2K and 2.6K: add them" is sure from then: 2K 6:54.6 and 2.6K 9:14.1 (2.5 and 3.8 s from the real
times) replace those two cells, 3.4K and 4.4K follow, both outputs alike. So with two mats missed in a row two wrong
lines are on the boards for about four minutes (the column check places a pass one split further at most, 9.23 F14);
the fix overwrites the same cells. The pace check marks neither runner at any moment, nor after the fixes: a made-up
time is no real crossing.

**What it is not.** No start list: an athlete of another race is marked only when its reads happen to be too fast for
the race it is counted in (2026-10-28: two of the eight that went out; the single passes of the other six went out
unmarked and still do).
The first split is not judged (no leg). A dropped-out runner whose reads come slower than the leaders ran the stretch
is not told from a runner who slowed down. A stop is by time, not by read: a read of an earlier split that RR12 sends
late still goes out. The clearing line needs a receiver that reads it. None of this has run at a meet.

Tests: the pure rule on the 142 shape, a strong leg from far back, a runner far ahead, a collapse, a missed mat, a
stray and the real pass after it, operator-placed passes, too few references, the words (it fails with `below` or
`ownBelow` set to 0); the shape live through the engine on a synthetic race of six mats (sent, marked by its own read,
one row for both, the counts, the grid, the feed, the log; Not a split for both, the 18 lines of the others, the .lif
data, Undo, It's right, a restart); Stop from the row (the later read never sent, the others' places, the grid, Review,
the feed, the journal, a restart, Send this runner again, Undo and Redo, a stop for what comes after); Not a split for
the first read only; the clearing line off and on; the panel's helpers; the settings; the API. Four of 9.23's tests said
"the others' places wait for Resend" and now say they went out.

### 9.23 F22 (2026-11-10): two (or more) mats missed in a row are held before they go out

Found while proving 9.24 on the IvyXC Women's 6K replay (live order, both outputs), a mid-pack runner's 2K and 2.6K reads
dropped: her 3.4K read went out as "2K 12:22.4 place 85" (marked at once: "looks like 3.4K, not 2K (missed 2K and
2.6K?)"), her 4.4K read as "2.6K 16:11.8 place 84", and only then was the one click sure: four minutes of wrong lines on
both boards. With one mat missed the pass is held before it goes out. The operator: two in a row must be held too.

Why it went out. On the course the column check says at most one more missed mat than counting does (9.17 P2: "a runner
twice the leaders' time at 1K and 2K looks just like one at the leaders' pace who missed 1K and 3K, and a slow runner
is far likelier than two missed mats"; 9.23 F20 lets it say two when the first pass is in doubt and a leg is longer than
any runner's). Her 12:22.4 was beyond the field at 2K and beyond it at 2.6K as well, so no placing within one split was
plausible, the check had nothing to suggest, and counting stood.

The rule (src/review.js `checkOne`, `CHECK_RULES.farSpread`). When nothing within one split is clearly better, a
placing may move passes as far on as they fit, on evidence at least as strong as the one-split case needs:

- the runner's first pass stays where counting put it and is plausible there (or the operator placed it): it says how
  far behind the leaders this runner runs. The walker of 9.17's example has no such pass, nor a runner whose first
  pass is itself beyond the field;
- the same test as one split on (counting implausible and the placing at least as even, or counting clearly less
  even), with the same plausibility of every moved pass in its new split, earliest times and pinned passes respected;
- and with the passes moved, the log ratios of ALL of the runner's passes to the leaders spread no more than 0.1
  (`farSpread`): every pass at the first one's level. For one split a placing only has to be clearly better than
  counting; two splits on it has to be right in itself.

Everything after that is what it was: the suspect's moves ("Looks like 3.4K, not 2K (missed 2K and 2.6K?)", the later
passes "it moves with the pass before it"), the held passes out of the places, the missed-mat hint counting the mats
from the runner's later passes ("Missed 2K and 2.6K: add them", sure from her next read), the late-start and slow-leg
sparing (9.23 F18-F20), the release when the passes no longer say so. Not for finishers (the finish method places by
the field's fractions already) and not for a runner's only pass (a lone pass is held one split on, 9.18).

Proof. The replay again, the engine fed read by read, TrackScore and Karmarush captured:
- 2K and 2.6K dropped (bib 144): her 3.4K read is held as it arrives, her 4.4K read with it, no line of hers is ever
  a column early; "Missed 2K and 2.6K: add them" then sends 2K L2G 5 6:54.594 (real 6:52.107), 2.6K L2G 4 9:14.050
  (real 9:10.286), 3.4K L2G 3 12:22.406 and 4.4K L2G 2 16:11.803, the same to both outputs; 5K follows by itself.
- 2K, 2.6K and 3.4K dropped (bib 148): "Looks like 4.4K, not 2K (missed 2K, 2.6K and 3.4K?)", held; the one click
  sends 2K 6:57.305, 2.6K 9:14.813 and 3.4K 12:20.705 (each within a second of the real time), then 4.4K and 5K.
- one mat (bib 203, 2.6K): exactly as before (held, "Missed 2.6K: add it", 9:10.468 against 9:07.129).
- the three real meet days (golden replays against 10358a6): every packet identical, the Review lists identical, live
  = rebuild: nobody is newly held.
- the 9.23 measurements in test/review.test.js (missedCounts on the real race and the synthetic ones, the finish
  column, F15 and F16 through the engine) print the same numbers as before.

Tests: the check by hand on a six-split field (two and three splits on, the next pass with it, one split as before, the
0.1 bound from both sides, the walker, a first pass beyond the field, a kept pass, a split nobody has reached), and live
through the engine with both outputs (held at arrival, the one click, every line, three in a row, a restart). Both fail
with `farSpread` at -1.

### 9.25 Start lists; athletes who are not in the race that reads them (2026-11-10)

RR12 sends a bib and a time of day, nothing about the race. A read belongs to whichever race is Active on its port, so
an athlete of another race who jogs over a mat becomes a split of the race that is running.

- District 11, 2026-10-28: twelve athletes of other races were read. Ten of their lines went to both outputs: bib 213
  in Girls 2A as "1 Mile 3:34.0 place 1" and "2 Mile 4:43.0 place 1", bib 221 in Girls 3A (1 Mile place 44, 2 Mile 8:10.4
  place 1), 48, 167, 170, 171, 253, 243. Four were held with a wrong story ("missed 1 Mile?": 44, 189, 191, 33). Every
  real split place of Girls 3A after bib 221 and of Girls 2A was one too high: 348 lines (154 and 194).
- IvyXC, 2026-10-31: 22 women cooled down over the mats during the Men's 8K and went out as its runners (46 packets an
  output in the replay; the merged men's .lif had 110 runners for 88 men). Chip 3464, nobody's bib, went out in the
  Women's 6K.

There is no FinishLynx events file at these meets. The timer has one text file of entries per event, named by its event
number, and loads them in the panel.

**The entry files** (src/entries.js, pure). The two real files of 2026-10-31 (`1.txt`, 108 athletes; `2.txt`, 104) and
TrackScore's own reader of them agree on the format: one header line,
`NO.;FIRST NAME;LAST NAME;SEX;YEAR;CODE;SCHOOL;DIV;DIVPTS;EVENT;WAVE`, then one line per athlete, eleven fields,
semicolons, CRLF, plain ASCII, the EVENT column holding the event number the file is named by. Reading is tolerant:
the separator is a semicolon, else a tab, else a comma (the first line decides); header names in any case; the bib is
the column called NO. / NO / BIB / BIB# / ID / NUMBER, else the first column; a file without a header line (its first
field is a number) reads the same way; quoted fields; UTF-8 (with or without a BOM) or Windows-1252. The event of a
line is its EVENT column when the file has one and it says something, else the event of the file's name (`1.txt`,
`02.TXT`, `event 3.csv`, a name with exactly one number). When the column and the name disagree the column wins and
the load says so. Lines without a bib are skipped, a bib listed twice in an event counts once, a bib in two events is
said at the load and counts in both. "0142" is 142, as everywhere. Only the bibs are kept: the names come from the
names file, as before.

`loadEntryFiles(lists, files, { races, now })` -> `{ lists, results, notes }`: each event a file holds replaces that
event's list (loading again is how a list is corrected); a file that holds nothing changes nothing. One sentence per
file: "1.txt: 108 athletes entered in event 1 (Men's 8K)."; "7.txt: 2 athletes entered in event 7, which has no race
here."; "1.txt: 104 athletes entered in event 2 (Women's 6K). Its EVENT column says event 2, its name says 1: the
column was used."; "3.txt: no athletes in it (only a header line). Nothing was loaded."; "entries.txt: 1 athlete, but
nothing says which event: … Name it by its event number (3.txt) and load it again."

**Where they are kept.** main.js keeps `{ version: 1, events: { "<event>": { file, loadedAt, bibs } } }` in
`data\startlists.json` (written before it is used; no names) and hands it to the engine (`startLists` option,
`startListsChanged()`). A restart has it. "Start a new meet" copies it into `data\archive\<stamp>` with the old meet
and removes it. API: `POST /api/startlists { files: [{ name, text }] }` -> the state with
`startListLoad: { results, notes, resent, held }`; `DELETE /api/startlists/:event` (`all`: every list);
`POST /api/races/:id/runners/:bib/place { say: 'away' | 'here' }`. The panel reads the files itself (the browser's
file chooser, several at once, or a drop on the page), decodes them and sends their text, in requests of at most 600 KB.
State has `startLists: { events, without }` when any is loaded; a RaceView has `startList: { event, file, loadedAt,
entered, used, on, through, text, warn }` then.

**A race's list** is the list of its event number (`race.event`; round and heat do not matter). In `#recheck`, before
anything is sent, each bib read in the race is one of three kinds:

- **on its own list**: as always.
- **on another event's list only**: with the list in use and the setting on "keep them off the boards" (the default),
  every crossing of the bib is in `state.check.away`: `#holdOf` says `'away'`. Like a stopped runner's (9.24) it is
  read, counted and shown, never sent, not in `raceData()` (the merged .lif), and no part of the others' places
  (`heldBySplit`). The bib is in `state.check.apart`: it is not given to the column check or the pace check (no "missed
  1 Mile?", no "too fast" about it), it is no reference for them, for the estimates (`#refRunners`) or for the
  look-wrong check (`#legsOf`), and Review lists none of its splits as missing. Review has the group **Not in this
  race** (`review.away`: bib, "entered in Boys 2A", its passes here, `onBoards` for a line a scoreboard still shows);
  the race tile counts them quietly ("22 not in this race": `review.away`, and each split's `away`); the feed status is
  `not-in-race`; the grid row and the runner editor say "Not in this race (entered in Boys 2A)". Nothing in Needs
  attention.
- **on no list** (a late entry, a spare chip): sent as always. A quiet row under **Not on the start list**
  (`review.unlisted`) once it has a pass; never an alarm.

**The safety valve** (`LIST_RULES`, `listFits`). A list that does not fit the race must do nothing: a wrong file, a
file of another meet, a race whose event number is off. A race's list is used only when it has athletes, was loaded
within the last 6 days, and fits the runners actually being read. With T runners through (a counted pass) of whom A
are on the race's own list, it does not fit when

- T >= 5 and A < 0.5 T, or
- T >= 3 and A = 0.

Then nobody is kept off the boards by it, every line goes out as without a list, and Needs attention has one line:
"The start list does not match Girls 2A (12 of 40 runners are on it): not used. Check the race's event number, or load
the right file (Races tab)." It is a function of the race's state alone (no memory), so live and a rebuild agree, and
it is used again the moment it fits. Why those numbers, from the eight races of the two real meets, each bib counted
when its first pass arrived:

| | lowest (right list) / highest (wrong list) share of the runners through that are on the race's list, T >= 5 |
| --- | --- |
| the right list | 0.80 (Girls 2A: four of the first five, bib 213 crossed first; Men's 8K: 88 of 110 at the end); the other six races 0.95 to 1.00 |
| another event's list of the same meet (each of the 32 pairings) | 0.20 at most (Girls 2A with the Boys 2A list: bib 213 alone of five; Men's 8K with the women's list: 22 of 110); 0.00 in 26 of the 32 |
| the other meet's files, same event numbers | 0.16 at most (11 of 73) |

0.5 sits in the middle of the gap. "Three and none" is for a race too small to reach five, and still lets two athletes
of another race cross before the field without the list being dropped (one did, on 2026-10-28). The cost of trusting a
list before the numbers are in: with a wrong list that enters the race's own runners elsewhere (the two files swapped),
the first two runners' lines wait until the third is through (the same second, in the replay). With any other wrong
list the runners are on no list and nothing waits.

The 6 days (`days`): the lists are meant to go with "Start a new meet"; when it was not pressed, last week's files fit
this week's bibs by their numbers alone (bibs 1 to 108 in event 1 again), and no share can tell. "The start list of
Girls 2A was loaded 8 days ago: not used. Load this meet's entry files (Races tab)."

**The setting** (`config.entries.otherRace`, stored only when it is `'send'`; Settings, Start lists): "Athletes
entered in another race: keep them off the boards / send and flag". With "send and flag" such an athlete is sent like
any runner and counted in the places, and has a row under Splits that look wrong ("Bib 213 is entered in Boys 2A: not
in this race?", kind `stranger`) whose one click is Not in this race. It stays apart from the checks and the
references: so the four passes the build of 2026-10-28 held with "missed 1 Mile?" go out too, each with its row.
Changing the setting, or a race's event number, or the lists, in the middle of a race puts the boards right as a
change of the operator's does (`#listsSnapshot`, `#listsSettle`): what is no longer kept off goes out, the other
runners' lines whose place moved go out again (9.24 `#resendOthers`), and a line the boards have of an athlete who is
now kept off gets a clearing line where an output takes one; the load's toast says how many lines the boards still show.

**What the operator says** (`placeRunner`, `#says`, journal `{ t: 'runner-say', raceId, bib, say: 'here'|'away' }`, a
change like any other: one journal write, Undo, kept across a restart; a Clear keeps it with the pins).

- **Count them here** (`say: 'here'`, on a row of Not in this race): the runner is this race's whatever the list says.
  Its passes go out like any runner's (`#sendFixed`), are judged like any runner's from then on, and the lines behind
  them go out again with their new places.
- **Not in this race** (`say: 'away'`, on a flag row, a held pass's row, a Not on the start list row, in the runner
  editor): every pass of the runner here, now and later, is kept off as above. What the boards have is taken back (the
  toast says which lines they still show; a clearing line where an output takes one), and every other runner's line
  whose place moved goes out again.
- **It's right** (`say: 'here'` on a flag or a note): the row goes, nothing else changes.

**Without a start list: the day's memory** (`#ranOf`, `#ranElsewhere`, `#strangersOf`). For a race with no list in
use, and for a bib on no list in a race that has one. A bib *ran* a race when it has a real crossing at more than half
of that race's splits (two of two; four of seven), not counting crossings in doubt (held for the column check, marked
too fast, stopped) and not when it is apart there. A bib read in race Y that ran another race X of the day (within 18
hours) is flagged in Y: "Bib 213 ran in Boys 2A today: not in this race?" When it ran both, the race it started first
is its own (a runner runs one race). So a bib read once in an earlier race that later runs its own gets the flag on the
earlier race's line, as soon as its own run counts. **Flag only:** nothing is held and nothing is taken out of any
reference, so every packet is what it was before this section (the proof below); the row (Splits that look wrong, kind
`stranger`; Needs attention; the Review count) is where the one click is. It stands for the runner's other rows there:
a leg that looks wrong or too fast of such a bib is not listed as well, and a pass of it that the column check holds
keeps its hold but says who it is, with Not in this race as its one click instead of "Missed 1 Mile: add it". A meet
that numbers each race's bibs from 1 would flag everybody: when more than half of a race's runners (five or more
through) ran another race today, the day's memory says nothing for that race (the real days: 22 of 110 at most). The
flags depend on the other races, so they are worked out on each call (a few lookups a runner), outside the Review
cache; `#ranOf` is cached per change of its race. Nothing is worked out per read for a race without lists or says (the
600-runner performance test is unchanged).

**A runner with a read but no pass** (a read in the start area, in the first 60 s) is told apart by the lists too, for
the runner editor ("Not in this race (entered in Men's 8K)", "Not on the start list of Women's 6K"). Review and the
valve count only runners with a pass.

**Also fixed here** (9.24, found in the proof): the toast's "N lines of other runners re-sent" counted only the lines
the change's own pass sent, not the ones convergence sent inside their minute (35 said for 83). It counts every line
of another runner that went out again with another place.

**The proof** (replays of the real days in live arrival order, harness outside the repository).

- No start list, all three days: every packet identical to 10358a6 (1,098 / 1,587 / 1,285), live = rebuild. The day's
  memory flags all twelve athletes of 2026-10-28 (213, 243 and 33 in Girls 2A; 221, 44, 48, 189 and 191 in Girls 3A;
  167, 170 and 171 in Boys 1A; 253 in Girls 1A) and all 22 women in the Men's 8K. Those who had run already are flagged
  at their first read (221 at 13:45:38, 213 at 16:22:55, the women from 12:02:51 on); the five read before their own
  race (189, 191, 170, 167, 171) once that race is run (15:50:35 to 15:52:56).
- District 11 with six entry files made in the real format from TrackScore's entries (bibs and event numbers; made-up
  names): none of the ten lines goes out; all twelve are under Not in this race (the four that were held too); the
  1,071 split lines of real runners have the same times, and of the 348 places that were wrong all 348 are right. One
  packet fewer besides (a place update a stranger's line had caused).
- IvyXC with the two real files: nothing of the 22 women goes out in the Men's 8K, on either output; the men's merged
  .lif has 88 runners, all men; every packet of a real runner is identical to 10358a6 (the women had come after the men
  at every mat, so no place was wrong there). Chip 3464 is sent as before and listed under Not on the start list. Bib
  142 is unchanged: sent, and flagged too fast. Bibs 237 (on no list) and 29 and 39 (men) each have one read in the
  first minute of the Women's 6K, the start area: never a pass, nothing sent; the runner editor says where they
  belong. The files against the reads: 20 entered men and 19 entered women were never read; the only bibs read and not
  entered are 237 and 3464.
- The valve: the women's file loaded as event 1; both files swapped; the other meet's files on the District 11 day;
  the right files loaded 8 days before: in each, every packet as without a list (swapped: the boards the same at the
  end, the first two runners' lines one read later), and the warning above. An event number with no race, an empty
  file, a header-only file, commas or tabs, the same file twice, a late entry and a spare chip: the sentences above,
  and every line goes out.
- Count them here and its Undo, Not in this race and its Undo (213 in Girls 2A at 16:27: its two lines taken back, the
  83 lines of the real runners out again on both outputs, none of them wrong after it), a restart in the middle (the
  same packets as without one).

Tests: test/startlist.test.js (the reader on files in the real format; a list in use; Count them here and Undo across
a restart; the valve; on no list; send and flag; the day's memory; the same bib numbers in two races; a list loaded
and removed in the middle of a race),
test/server.test.js (the API, the file in the data folder, a restart, Remove, a new meet), test/app.test.js (the
counts, Needs attention, the Review rows, the Races page's lines, the toast), test/config.test.js (the setting).

### 9.26 Split points that are counted but not sent (2026-11-18)

The timer's words: "I need to be able to collect splits but not send them out. Meaning, I am going to put splits out at
every K marker. There are a couple times that they read like 200 meters after that isn't worth showing." and "I need
to collect all of the splits, but then only send certain ones. The laps to go need to match only the shown splits."

RR12 sends a bib and a time, and Split Relay counts each runner's passes into the race's splits (9.15 L4). A mat that
reads the runners 200 m after a K marker is a pass like any other: left out of the race's splits, every later pass of
every runner lands one split early. So the mat gets a split of its own, and that split is **counted, not sent**.
TrackScore and Karmarush are set up with the shown splits only.

**The setting.** `collectOnly: true` on a split (config.json, the race file's copy of the race, meet files, the API).
Absent means sent, as every split was, so a settings file from before reads as before and nothing is written for a
split that is sent. It is not `sending` (the Pause button, 9.17 P1): a paused split waits and goes out on Play; a split
that is counted only never goes out, and has no Pause (`sending` is true on it; POST …/sending answers 409 in words).
A race needs at least one split that is sent (`allNotSentText`, the same words in the form and from the server). A
save that leaves `collectOnly` out for a split keeps what the split had, as for `sending`: an older panel or a script
that renames a split never starts sending one that is only counted; the race editor says `true` for a split that is not
sent and `false` only for one that was saved as not sent and is sent again.

**Counting and the checks: unchanged.** The split takes passes like any split: `d.groups`, `d.open`, `d.kept`, the
ranks and the places at it are as before. The column check, the missed-mat one clicks, the look-wrong and the
too-fast checks see every split. Only what goes out differs.

**Sending** (`#holdOf` → `'collect'`). The existing hold kinds are `'away'`, `'stopped'`, `'paused'` and `'check'`;
every place that sends, lists or counts asks `#holdOf` first. A crossing of a split that is counted only answers
`'collect'`, last in that order: a pass there whose column is in doubt still shows that question (`'check'`: the one
click that moves the runner's later passes on must be offered), and once it is answered the pass is simply not sent.
Unlike the other kinds it is for good: nothing lets it go. So such a crossing is never ready, never waits for its hold
(`state.unreleased`), never gets a release (`state.rel`), an approval or a ledger entry; it is not in the tile's "held"
count, not stale, not "Ready: not sent", not "Finished: not sent live", not in Resend's count or its packets, not in
Send with finish place, the clearing line or the catch-up after an outage or after a kill; a packet that waits in an
output's queue when its split is switched to Not sent is not written (`isCurrent()`). `#keptSig` and `#lapSig` (what a change sends: 9.23 F3, F4) leave such crossings out, so
a change inside a split that is not sent sends nothing and is no reason to send the runner's furthest split again;
`#sendFixed` skips them without a word (no "not live" line in the toast). The feed row of such a pass is
**Counted, not sent** (`'counted'`, `COUNTED_TEXT`), in the status tables of the README and Help. A made-up or typed
time in such a split (the missed-mat one click makes one) is a fixed point of the count like any other and is never
sent: its feed row and its line in Review say so (`collectOnly` on the ManualView), and it is not "in the merged .lif".

**Laps to go, the split count, the split index.** `compileConfig` gives every race `sent` (its splits that are sent,
in course order) and `sentCount`, and every split `sentIndex` and `l2g`: the number of SENT splits from it to the end
(the last sent split is 1, never 0; null for a split that is counted only). Everything that said
`race.splits.length - c.index` or took `race.splits.length` for the outputs' split count now takes these: `#content`
(so the ledger's `l2g` and `count`), `#packet` and the clearing line (`splitIndex`, `splitCount`, `lapsToGo`),
`#sentAs`, `#sentAfterFinish`, `#staleCount`, `#staleAt`, `staleWhy`, `#leftover` and `#leftoverAt` (the boards'
column j is `race.sent[j]`), the race file of before revision 7. The .lss scripts use one of these fields only, laps to
go (`\14\0a`; `packetVariables`); `packetProblem`, the last check before the wire, counts the race's sent splits, so a
packet with laps to go above that number is refused, and `samplePacket` is a packet of a sent split. With every split
sent all of it is the same number as before (proof a).

**The leg (LS).** `#lapOf` already measured from the nearest earlier split "the outputs get" (not one that is paused or
held): a split that is counted only is skipped the same way, so the leg is the time since the runner's nearest earlier
SENT split, the split time itself when there is none. "LS is re-sent when only the leg changed" (9.23 F12, F21) and
"the runner's furthest split goes last" (9.23 F4, F13) walk the runner's splits with `#holdOf` and therefore follow
the sent splits only.

**The merged .lif** (`raceData`): the sent splits only, in course order; `splitCount` is the number of sent splits and
each runner's `splits` has that length. src/lif.js is unchanged.

**Switching a split between sent and not sent** changes the other splits' laps to go, and is treated exactly as a
change of the number of splits (9.15 L5, L6), because for the boards it is one. `sendSig` (which splits are paused)
now also says which are not sent, so `configChanged` looks at everything again: lines that went out less than a minute
ago are corrected by themselves with their new laps to go; older ones are out of date, the race view says why
(`stale.reason: 'split-count'`, "this race now sends 9 splits instead of 11") and the tile offers Resend; a split
switched back to sent sends what it had counted, as a Play does. No rebuild: the count does not depend on it. In the
panel the switch is part of the race form (saved with Save, unlike the Pause, which acts at once): the form shows the
note it shows for a new number of splits, the save asks the same question first (`splitsChange`, `columnsChangeText`),
and afterwards the tile's prompt is the one of a new number of splits. A split that is only counted added, taken out
or moved between the sent ones leaves the boards' columns alone but counts the passes again: the form and the save
say that instead (`recount`); other splits sent than before, the same number, say "With other splits sent than before"
(`swapped`; the tile then says "in another order, or other splits are sent now"). A split switched to sent sends what it
had counted and, as after any line of an earlier split (9.23 F4), each of those runners' furthest split again.

**The panel.**
- Races page: each split row has a **Send** switch (on), **+** (add a split after this one: before, a split could only
  be added at the end in LapTime mode) and **×** (remove this one, with the question the page already asks for a
  split that has crossings). Off: the row says **Not sent** and **Counted only**, has no laps to go and no Pause, and
  the other rows' laps to go are renumbered at once. The line under Number of splits says the number to set in
  TrackScore and Karmarush (the sent ones) and how many more are counted only (`splitsHint`).
- Dashboard: the tile of such a split is muted (a dashed edge, a grey count, "Not sent", no Pause, no bar); the race's
  line says "9 splits + 2 not sent".
- Review: the grid's column says "not sent" under its name and its cells are grey; the runner editor's cell says
  "Not sent"; an empty cell there opens no time box (there is nothing to send), and the Missing splits list, the grid's
  "missing" counts and Fill in N leave such a split out (`#reviewOf`, `#gridBase`, `runner()`). The missed-mat one
  click stays, as it must.
- Crossings (Races page): "not sent (counted)" where a sent crossing has its time.
- Layout: the split rows have more on them (Send, +, ×), so the race form says how wide it is (a container query on
  `.race-form-card`, not the window): under 720 px, which is the form on a 1366 px laptop, a row has two lines (number,
  name, Send; laps to go, count, Pause, tools). Seen while looking at it in the browser, and there before: a long
  Needs attention title on the race's page made `.editor-main`'s one column wider than its place, so the form slid
  under the column on its right near 1300 px. The column is now `minmax(0, 1fr)`.

**Set up from TrackScore** (src/meet.js `planMeet`). TrackScore knows only the splits that are shown. Its split points
are compared with, and map in order onto, the race's SENT splits; the ones that are counted only stay where they are,
after the same sent split, and the preview says so ("Mens Race: 4.2K is counted, not sent, so TrackScore has no split
point for it: it stays where it is, and TrackScore's 9 split points are compared with the 9 splits that are sent."). The
same number as the sent ones is no difference; another number on a race in use is held back with the sent count
("9 sent here …; 10 in TrackScore …"); on a race not in use the splits are rebuilt by name as before and each split that
is only counted goes back after the sent split it came after (the nearest one before it that is still there; first
when none is). TrackScore's own `hidden` points are as before: still splits, still sent. A meet file says
`{ "name": "4.2K", "collectOnly": true }` (a plain sent split stays a name); a load compares it split by split, changes
it on a race not in use ("4.2K counted, not sent") and holds it back on one with reads ("which splits are sent").

**Mats close together and the tag filter.** The tag filter (`filter.tagWindowSec`) merges the reads of one bib that
come within it into one pass; it was 45 s at the last three meets. A mat 200 m after another is 33 to 45 s away for a
men's field: measured on the 2026-11-13 men's race with a read added 0.2 of the way to the next K, 362 of the 372
added reads (all 186 runners) fall inside 45 s. Merged, the runner's next K read is counted into the split that is not
sent and every later split shows the next split's time: at the end 744 of 1,490 cells on the boards were wrong (5K to
8K of all 186 runners), 186 cells never came, and the column check held nobody (the whole field moved together). Two
guards:
- At setup: the race's page shows the tag filter under the splits of a race that has a split that is not sent, with
  the advice (`closeMatsText`); amber from 30 s (`closeMatsRisk`), quiet below.
- While it happens: `RaceView.lateMerged` (`#lateMerged`), a Needs attention row with the way to the tag filter. A
  read of a counted crossing that came `LATE_MERGE_SEC` (15 s) or more after the runner's previous read and was merged
  all the same is counted; the row shows once `LATE_MERGE_RUNNERS` (3) runners of the race have one. Not counted: the
  runners who are not in the race or probably not (9.25). Why these numbers: the A and B mats of one split read a
  runner 1.3 to 1.8 s apart (the median of 1,104, 1,588 and 1,449 merged reads on 2026-10-28, 10-31 and 10-21); the
  merged reads of 15 s and more on those days were athletes standing by a mat (extra passes after the last split,
  reads before the gun, athletes of another race), which is why only counted crossings and only the race's own runners
  count, and why the gap is measured from the runner's previous read, not the first of the pass.
  In that replay the row came at 12:39.7 of the race clock, with the third runner's merged read: 2 min 10 s before the
  first split failed to show (the leaders' 5K, 14:50) and 5 min 20 s before the first wrong time (their 6K read shown as
  5K, 18:00). On the four real days it never shows, at any moment of the replay.
- Lowering the tag filter changes `#derivSig`, so every race is worked out again from its stored reads at once. What
  is new goes out by itself and lines sent less than a minute ago are corrected; older ones are out of date and wait
  for one Resend (the rule for whatever a setting changes). Measured: lowered to 20 s at 14:00 of the race clock,
  nothing was wrong and nothing needed sending; lowered at 20:00, 172 cells were wrong, 250 packets went by themselves
  (64 corrections, 186 new), 108 cells stayed out of date until the Resend, after which the boards had exactly the
  day's times. The tag filter is one setting for every race: lowering it works the day's earlier races out again too.

**The proof** (replays in live arrival order; the harness and the fixtures are outside the repository).
- Nothing changes without such a split: the four real days give the same packets as 89f6f94, digests and all (1,098,
  1,587, 3,142 and 1,285 packets; live = rebuild), and the same legs.
- The 2026-11-13 meet with extra mats: the Men's Race with "4.2K" after 4K and "8.2K" after 8K, not sent, a read
  there for every runner with the K read (372 reads added), tag filter 20 s. Every one of the 3,142 packets is the
  real day's: race, bib, split, time, place, laps to go, reason, LS and split count. The men's merged .lif data has 9
  splits; 372 crossings are counted only; nothing waits or is held. The same with "2.2K" in the Women's Race (576
  reads added).
- Missed mats in that fixture (three mid-pack runners, the one click pressed 20 s after it is sure): the 4.2K read
  missing: the 5K read is held as it arrives, the one click (sure with the runner's next pass) sends 5K and 6K right
  and makes 4.2K up, counted only; nothing wrong ever goes out. The 4K read missing: the 4.2K read goes out as 4K,
  35 s slow, until the 5K read comes 2:21 later; then both passes are held with a sure "Missed 4K: add it", which
  corrects 4K (0.6 s off the real time) and sends 5K. Both missing: held as the 5K read arrives (9.23 F22), "Missed 4K
  and 4.2K: add them", 4K 0.2 s off. The other runners' lines are the day's. Seen with nobody clicking: when the
  runner's next pass comes (3:14 later) the column check lets that first pass go and holds the later ones, so the 5K
  time goes out as 4K (2:55 slow) until the one click, still offered, corrects it. That is the check as it was: 89f6f94
  does the same with all eleven splits sent, and with two mats a kilometre apart (4K and 5K missed) the hold stays.
  Changed the same day: 9.26 F2 below.
- A live run on test ports (the whole program in one process, real sockets on 127.0.0.1: panel 6450, RR12 6451, a
  stand-in for TrackScore with xcscore.lss on 6452 and one for Karmarush with karmarush-track.lss on 6453): the men's
  2,048 reads as LapTime lines, 40 times faster than the day, a stop and a start half way. Both stand-ins got the
  same packets (1,768 to 1,790 each over four runs: the number of place updates depends on the real timing at that
  speed), the same bib, place, laps to go, CS and LS line for line; laps to go 9 to 1; the restart sent nothing
  again (0 and 0) and lost nothing; both boards ended with exactly the day's 1,676 cells; the merged .lif had 9 split
  times a runner, 5K's leg since 4K.
- The 2026-10-21 race with 4400m not sent: no 4400m packet (173 before); the other 1,112 packets are the baseline's,
  in the same order, with the same time, place and reason; laps to go 6 to 1 of 6; the leg of every 5300m line (169) is
  since 4200m; the same four runners are held at the end (403, 512, 521, 586) with the same one clicks.

Tests: test/engine.test.js (five: the split takes its pass and sends nothing, laps to go, split count, index and leg,
the merged .lif data, Resend, a restart; switching a split is a new number of splits; a change inside such a split
sends nothing and a typed time there holds the columns; an empty one is not a missing split; the merged reads and a
lower tag filter. All five fail on 89f6f94), test/config.test.js (the setting, the refusals), test/meet.test.js (the
file, Set up from TrackScore, a load), test/outputs.test.js (the last check, the sample packet), test/app.test.js
(laps to go and the hint, the draft and the save, add after, what a change does to the boards, the status word and
the cells, the Needs attention row).

### 9.26 F2 (2026-11-18): two mats close together, both missed

Found by the main session's own replay of the 9.26 proofs, before the merge. The meet the Send switch was built for has
mats 200 m after some K markers, and a chip that fails on that stretch misses both. The runner's next two passes (5K
and 6K) are then counted in 4K and 4.2K.

What happened. The first pass was held as it arrived, as 9.23 F22 does ("Looks like 5K, not 4K (missed 4K and
4.2K?)"). When the second came, the column check looked one split on first, as always, and found a placing "clearly
better than counting": the 5K time left in 4K and the 6K time in 5K. For a runner at 1.03 x the leaders that is 1.28 x
and 1.27 x: slow, and with a field that ends at 1.15 x not implausible (the tail margin reaches 1.32 x), so it was
taken, and the far placing of F22 (every pass at the runner's own level, spread 0.03 against 0.22) was never tried.
The hold on the first pass was let go for it: "4K 15:27.0 place 186" went to both boards at the moment the one click
became sure, and stood until the click. With mats a kilometre apart the same pass is implausible one split on, the
near search finds nothing, and F22 is reached: that is why it never showed on the earlier courses.

The rule now (src/review.js checkOne): a placing one split on that itself fits badly (its spread above
CHECK_RULES.farSpread, 0.1) gives way to a placing further on that passes F22's own test (the runner's first pass
stays where it is, plausible; every pass then within farSpread) and is clearly better still (by spreadMargin, 0.1). A
placing one split on that fits well is what it was: one mat missed is never looked at twice.

Measured.
- The 2026-11-13 Men's Race with not-sent mats 200 m after 4K and 8K, tag filter 20 s, a mid-pack runner's 4K and 4.2K
  reads left out: both later passes are held from the read on, nothing wrong goes out with or without a click, and the
  one click sends 4K 12:30.3 (made up; the real one was 12:32.2), 5K and 6K. Before: the wrong 4K line for as long as
  nobody clicked.
- The four golden days (2026-10-21, 10-28, 10-31, 11-13): every packet, the end state and the rebuild are identical
  to 89f6f94, so no runner of a real day is placed differently.
- The 2026-10-21 race with 4400m not sent: the same 1,112 packets and the same four runners held with the same one
  clicks as before this change.

Tests: test/review.test.js ("9.26 two mats close together, both missed": the far placing wins, one mat missed is one
split on as before, a runner who slowed with every mat read is left alone; fails without the change). 764 tests.

### 9.27 Swapped bibs (2026-11-23)

At a championship on 2026-11-21 two athletes had each other's chips. In the Women's Race the mats read bib 11 where the
athlete of bib 510 ran; an hour later in the Men's Race they read bib 510 where the athlete of bib 11 ran. FinishLynx
had the right bibs, so its file had a row for 510 and none for 11 in the women's race: the splits went to the boards
under a man's bib, and the right row of the merged .lif got none. It was put right afterwards by typing every split
under the right bib (`POST /api/races/:id/manual`). A timer must be able to put it right alone, in the panel, before,
during or after the races.

**A swap is a pair of bibs for the whole meet.** "Bib 11 and bib 510 are swapped": every read of chip 11 counts for
runner 510 and every read of chip 510 for runner 11, in every race, the reads already in and the ones still to come.
A pair whose other chip is never read is simply a one-way correction; there is no one-way mode. The rules: both bibs
given; not the same bib ("0458" is 458, `bibKey`, as everywhere); a bib is in one swap at most; at most 50 pairs.

**The journal keeps the truth.** A read record is written as it came in, with the bib RR12 sent. In memory a read has
two bibs: `chip`, the bib as received (what the journal has, and what a repeated line is matched by), and `bib`, the
runner it counts for: the same, or the other bib of its pair while a swap is in force (`Engine #label`). The pair is a
journal record of its own, `{ t: 'swap', a, b, at }`, taken out again by `{ t: 'unswap', a, b, at }`; a start replays
them in order and labels every read at the end. So removing a swap gives back exactly what was.

Where the list lives: in the read journal, not in config.json and not in a meet file. A swap is about this day's chips
and reads, like a Move or "Not in this race", and a meet file never holds anything of the day (9.22 R2): a setup saved
today and loaded next year must not swap two bibs. It survives a restart with the journal, and "Start a new meet"
forgets it with the reads it was about (the new-meet record).

**Everything downstream uses the runner.** The read is relabelled before anything else looks at it, so counting and
the tag filter, the start lists (9.25: chip 11 in the women's race counts as 510, who is on the women's list, so
nothing is held as Not in this race), FinishLynx's finishes, the places, the merged .lif (the right row has the
splits; the chip's bib has no row of them), the packets, Review, the grid and Find all see the runner. Names: a name
RR12 sends with a read is the name of the bib it was read as, so it is learned for that bib, never for the runner who
carried the chip; the names file is by bib as before. What still shows the chip: a feed row of such a read has
`readAs` ("read as 510" under the bib), the runner editor says "Swapped bibs: bib 510 ran with the chip of bib 11. Its
reads here came in as bib 11", each pass of the runner view has `readAs`, and a Find row says "read as bib 510".

**Entering and removing it** (`Engine addSwap`, `removeSwap`, both through `#changeSwap`). Every read of the two
chips gets the bib it counts for now; each race that holds one is worked out again from its reads (the path a changed
setting and a restart take, so live and restart agree), one race at a time, and what the change did to the two
runners there goes out as any change of the operator's does (`#sendChange`, the sending half of `#runFix`, now shared):
- in an Active race the splits go out under the bib they are now, whatever the minute says, the runner's furthest
  split last; the other runners' lines whose place moved go out again by themselves (9.24);
- a runner who has finished is not sent by itself (TrackScore keeps FinishLynx's place): its splits are in Review
  under Finished: not sent live, with Send with finish place;
- a paused split, a split that is counted but not sent, a runner the operator stopped and a runner who is not in the
  race stay as they are;
- a race that is not Active gets nothing live; its merged .lif follows by itself;
- a cell the boards have under the bib that lost it can't be emptied by a packet: the answer says "The boards still
  show 5 splits under bib 11 (sent before): a packet can't empty a cell", the race tile counts them with the cells
  Split Relay can't clear (9.16 F1), and an output with "Send a clearing line" gets one (9.24).

**What was decided about a bib stays with that bib.** Nothing is carried over with the reads, so removing a swap
never has to guess what to carry back:
- Moves, It's right, Not a split and a marked finish are kept by the time of day of the pass under the bib they were
  made for. While that bib has other reads they match nothing and wait; they apply again when the swap is removed.
- Stop sending this runner and Not in this race / Count them here are about the bib: they stay with it.
- A typed or made-up time remembers the chip it was made with (`chip` on its `manual` record, written only when it
  is not the bib's own: a time made while the bib is one of a pair). It is used while that chip's reads are the
  runner's. When they are another runner's (a swap entered or removed since) it is set aside: kept, shown as "not
  used (it was made from reads that count for another bib now: swapped bibs)", sent under neither bib. Except a time
  made for a runner whose own chip was never read in the race: that is a time typed for a runner no mat read (the
  hand fix of 2026-11-21), and it stays the runner's.
- A real read wins over a typed or made-up time of its split, as before, and for a read that a swap brought to the
  runner whatever its place in the journal: it is new to every time made with another chip (`lateReplacements`), so
  the hand-typed 510 splits of 2026-11-21 give way to the real reads the moment the swap is entered, each to the read
  nearest it, and are listed as "not used (a real read replaced it)". A split the mats did not read keeps its typed
  time.
The preview and the answer say what stays behind: "What you changed for bib 11 here (2 changed passes and 1 typed or
made-up time) stays with bib 11: they are not carried over to bib 510."

**Not in a race's Undo list.** A swap spans races, and a race's Undo is one runner's change in one race: half of a
swap undone would be a state nobody asked for. A swap is undone by its own Remove swap, which asks once and says what
changes back. The changes made before or during a swap keep their own Undo, for the bib they were made on.

**The panel.**
- The runner editor has **Swapped bibs…** beside Stop sending this runner, also for a bib with no reads in the race
  ("Did this runner run with the chip of another bib?"). Review's Not in this race rows, and the rows of a runner of
  another race that is sent, have it too: that is where a timer first sees the problem.
- The dialog: "Bib [11] ran with the chip of bib [ ]". As the numbers are typed it shows what Split Relay says the
  swap would do, per race: which splits become which bib's, whether they go out, what the boards still show, what
  stays behind. Nothing changes until Swap bibs.
- While a swap is in force, both runners' editors say so in one line with Remove swap, and the Races page (always)
  and Review (while there is one) list "Swapped bibs": the pair, since when, who has whose reads in which race, Remove
  swap, and what the last change said.

API (`src/server.js`): `GET /api/swaps` -> `{ swaps }`; `POST /api/swaps/preview { bib, other }` or
`{ bib, remove: true }` -> `{ a, b, remove, title, lead, confirm, races: [{ raceId, raceName, active, lines }], notes }`
(changes nothing); `POST /api/swaps { bib, other }` and `DELETE /api/swaps/:bib` (either bib of the pair) -> the
state with `swapChange: { swap, pair, removed, text, races: [{ raceId, raceName, active, owners, lines, cells, leftover,
sentTo, notLive, resent, cleared }] }`. The state has `swaps` while there is one. Refusals in words: "Type both bib
numbers.", "Bib 458 can't be swapped with itself. Type the bib whose chip it ran with.", "Bib 11 is swapped with bib
204 already, and a bib can be in one swap only. Remove that swap first."

Measured, on a copy of the journal of 2026-11-21 (the engine alone: no sockets, the copy's settings on test ports).
- The hand fix in the journal, then the swap 11 <-> 510: the Women's Race has bib 510 with the real reads (3:17.322,
  6:48.358, 10:47.819, 14:16.676, 17:57.856) and nothing under 11; the Men's Race has bib 11 with 1K 2:52.155, 2K
  6:23.785, 3.1K 9:44.220, 4K 12:19.804, 5K 15:53.637, 6K 19:13.980, 7K 22:28.579 (and its five counted-only splits)
  and nothing under 510; the seventeen typed times are "not used (a real read replaced it)". The other 293 and 299
  runners keep every time, split and hold; those behind the pair are one place better at each split, because the
  hand fix had made two runners of one. A restart gives the same. Remove swap gives back exactly the state before
  (every crossing with its place, hold and source, the Review counts, the typed times).
- The day replayed from nothing, the swap entered five minutes before the women's gun: every one of the 8,920
  packets is the day's own with the two bibs renamed, in the same order, none under the chip's bib; the end state is
  the day's with the two bibs renamed. Entered between the races: the women's packets up to then are the day's own,
  then bib 510's five splits go out as new (to both outputs), and the men's race is as with the swap from the start.
- The four golden days, which have no swap: every packet, the end state and the rebuild are identical to 32ac560.

Tests: test/swap.test.js (the rules; after both races and back; a restart, a repeated line, a new meet; before the
gun with start lists; mid-race with and without a start list; a race that is not Active, a finisher, a paused split;
typed times and the hand fix; what stays with the chip's bib; both chips in one race; a time made up during a swap;
the words with start lists; a journal edited by hand), test/server.test.js ("swapped bibs on a running app"),
test/app.test.js ("swapped bibs"). 777 tests.


### 9.28 Updates from GitHub (2026-11-23)

The owner hands Split Relay to other timers, on laptops nobody develops on: "I would also like to make a github repo
for this, and on boot up, I would like to look for an update from Github itself." Decided with the owner: the
repository is public (a laptop checks without signing in), a found update is shown with one button and never installed
by itself, and not while a race is running.

**Releases.** The repository is `Tknick009/SplitRelay` on github.com (`UPDATE_REPO`). A version is a GitHub release:
tag `v<version>`, `package.json`'s `version` the same, and one asset `SplitRelay-<version>.zip` (`git archive` of
the tag: the files at the top, no folder around them). The version numbers follow this document's sections (9.28.0 is
this section). A push without a release reaches no laptop.

**The check** (`src/update.js` `Updater.check`). At start, once Split Relay is up (the inputs are open), it asks
`GET https://api.github.com/repos/Tknick009/SplitRelay/releases/latest`, in the background, with 8 s to answer. The
request carries a User-Agent `SplitRelay/<version>` and nothing about the PC or its user. Newer than this copy (three
numbers compared) is "available". No internet, a slow answer, GitHub's limit of 60 unsigned checks an hour per network
and any other failure end as a sentence in `State.update.error`; Split Relay runs on. 404 (no release yet) is no
error. Only a start from the command line checks (`main()`): Split Relay used as a module, as every test does, never
calls GitHub. **Check for updates** on the Help page asks again.

**Install** (`Updater.install`, `POST /api/update/install`), only on the operator's click:
1. Refused while a race is running, by the rule of Start a new meet (9.22: Active with a gun, its clock under 30
   minutes or a read in the last 20 minutes): installing restarts Split Relay, and RR12's reads of those seconds would
   wait in RR12.
2. Refused on a copy whose folder has a `.git` folder (a development copy is updated with git; files put over it
   would look like local changes).
3. The zip is downloaded (at most 60 MB; only from github.com and its download hosts), its size and the SHA-256 GitHub
   publishes for the asset are checked, and it is unpacked in memory by `src/zip.js` (stored and deflated entries,
   every CRC checked, no zip64, no encryption; a name with `..`, a drive letter, a backslash or a device name is
   refused, so nothing is written outside the folder).
4. It must be a complete Split Relay of the version asked for (`releaseProblem`: the files a start needs, the
   package's name and version, no `data/`, the Node.js it needs against this PC's). The new files are written to
   `data\update\staging` and every `src/*.js` is checked with `node --check`.
5. The program as it is now (the folders `src`, `public`, `lynx`, `test`, and the files next to them that the
   release replaces) is copied to `data\update\backup`, and `data\update\pending.json` notes
   `{ from, to, at, added }`.
6. The new files replace the old ones (a file that is the same is left alone; a file of the managed folders that the
   new version no longer has is removed). The data folder is never touched. When this step fails the backup is put
   back at once.
7. Split Relay stops as for Ctrl+C (the reads saved, the journal's `stop` record written) and exits with code 75.

**The launcher** (`src/launcher.js`). `start.bat` starts the launcher, and the launcher starts `src/main.js` in the
same window with the same options (`SPLITRELAY_LAUNCHER=1` tells Split Relay it will be started again). It ignores
Ctrl+C itself: Split Relay gets it too, stops, and the launcher follows with its exit code. On exit code 75 it starts
Split Relay again: the new version. A new version that is up marks the update as in for good (`confirmStarted`:
`pending.json` becomes `installed.json`). When Split Relay stops with an error while `pending.json` is still there,
the new version did not come up: the launcher puts the backup back (`rollBack`), notes it in
`data\update\rolled-back.json`, and starts the old version; the panel says so until **Hide**. At most four starts
in a minute, so never a loop. Started without the launcher (`node src\main.js`), Split Relay says to be closed and
started again.

`start.bat` runs `launcher.js … & goto done` on one line: cmd reads a batch file again after each command, by
position, and an update may have replaced the file meanwhile; `goto` finds `:done` by name in whatever the file is
then. The launcher stays in memory across an update, so it imports only `update.js` (which imports only `zip.js`),
and what they agree on with later versions is small: exit code 75, `pending.json`, the backup folder.

**The panel.** `State.app = { version }`, `State.update = { current, state, checkedAt, error, available, latest:
{ version, name, notes, publishedAt, pageUrl }, canInstall, cannotWhy, blocked, restartsItself, installed, rolledBack,
releasesUrl }`. A blue chip "Update 9.29.0" in the top bar of every page while one is available (not on a view-only
page). It opens a dialog: the version, what installing does, the release's notes ("What is new"), **Install update**
and **Not now**; while a race is running or on a development copy it says why and has no Install. Help has a card
"Version and updates": the version, the check's last answer in a sentence, **Check for updates**, **Install
update…**, the note of an update that was taken back. A page loaded from another version than Split Relay now answers
as loads itself again, so after an update the panel is the new one without a click; it says once "Split Relay was
updated to version …".

Routes: `POST /api/update/check` -> State; `POST /api/update/install` -> State with `updateDone: { from, to, changed,
removed, restarts }`, 409 in words while a race is running; `POST /api/update/dismiss` -> State. Changes, so from
this PC only, like every other.

**The first version with this** has to be put on each laptop by hand (the zip); from then on they update themselves.

Tests: test/update.test.js (the zip reader and its refusals; versions; releases as GitHub answers; the updater against
a stand-in GitHub: found, not found, offline, installed with the data untouched, taken back, a wrong or damaged
download changing nothing, a development copy; the launcher's decisions; the panel's routes with a running race).
796 tests.
