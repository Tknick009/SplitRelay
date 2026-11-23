# Split Relay

Split Relay takes the split passings from Race Result 12 and sends them on as FinishLynx scoreboard packets. TrackScore
and the live results (Karmarush) get their splits from Split Relay. FinishLynx only gets the finish reads, so the photo
shows finish lines only.

Split Relay also writes copies of the FinishLynx `.lif` result files with the splits added. TrackScore, XC-Analytics
and the web results read those copies.

```
RR12 exporter (split mats) ──► Split Relay ──► TrackScore XC (port 5555, XCScore.lss)
  (a 2nd exporter, 2nd port,        │      ──► live results (Karmarush-Track.lss)
   for a race that overlaps)        └────────► merged .lif files
RR12 exporter to FinishLynx ──► FinishLynx (Finish timing point only)
```

## What you need

- A Windows PC on the timing network. It can be the FinishLynx PC.
- Node.js 18.17 or newer. Get the LTS version from https://nodejs.org. Split Relay needs nothing else.
- Split Relay itself: the newest `SplitRelay-<version>.zip` from https://github.com/Tknick009/SplitRelay/releases.
  Unpack it into a folder of its own, for example on the Desktop. After that it updates itself from the control
  panel (see **Updates** below).

## Starting and stopping

- Double-click `start.bat`. A black window opens, and the control panel opens in the browser.
- Keep the black window open during the meet. Closing it stops Split Relay.
- The first time, Windows Firewall asks about Node.js. Allow it on **private networks**. Otherwise RR12 on another PC
  cannot connect.
- To stop, press **Ctrl+C** in the black window. If an output has not received some splits yet, the window says how
  many. They are sent when Split Relay starts again and the output is reachable.
- When you start again, every race carries on where it was. Nothing an output already has is sent again.
- If the control panel did not open, open **http://localhost:5590/** in the browser.
- Started it twice by mistake? The second window just opens the control panel and closes.

## Updates

Each time Split Relay starts it asks GitHub once whether there is a newer version. It needs internet for that; without
internet it starts as usual and says nothing.

- When there is a newer version, a blue **Update 9.29.0** chip shows at the top of every page. Click it to read what
  is new.
- **Install update** downloads the new version from GitHub, checks it, keeps a copy of the version you have, and
  starts Split Relay again in the same black window. That takes about ten seconds, and the control panel comes back
  by itself. RR12, TrackScore and the live results connect again by themselves.
- Nothing is ever installed by itself. **Not now** leaves everything as it is; the chip stays until you install.
- Install is not offered while a race is running (Active with its gun, from the gun until 30 minutes after it, or
  while its reads keep coming). The dialog then says which race. Update before the meet or after it.
- Your races, settings, reads and logs are not touched: an update replaces the program only, never the `data`
  folder.
- If the new version does not start, Split Relay puts the version you had back by itself and starts it. The Help
  page then says so.
- **Help → Version and updates** shows the version this PC has, when it last checked, and **Check for updates**.

A PC that never has internet is updated by hand: unpack the new zip over the Split Relay folder (the `data` folder
stays), then start it again.

## The control panel

A dark control-room page, made to be read at a glance on the timing laptop:

- **The status strip** at the top has the lights in three groups: **IN** (one per RR12 port), **OUT** (one per
  output) and **FILES** (the merged `.lif` files, and **Names** while there is no names file): green working, amber
  waiting, red a problem, grey off. A light that
  isn't green also says why in a word ("not connected", "off"). Point at a light (or Tab to it) for the details; click
  it to open its page. An output or an RR12 port turns red when it stays down while its race is running. **Live** at
  the far right means the page is connected to Split Relay; while it is not, the lights are grey ("last known") and
  the buttons that need Split Relay say so instead of failing. With many ports or outputs, or a narrow window, the
  strip makes room by itself: shorter names (the port number), then just a dot and the name, then one light for all
  the ports (or outputs) with a dot each and a count, "IN ●●● 3 ports". Point at it for the whole list. No light is
  ever cut off.
- **The bar on the left** has the pages: **Dashboard**, **Review**, **Races**, **Outputs**, **Inputs**, **Settings**
  and **Help**. A number beside a page says what waits there (Dashboard: problems to check; Review: runners to look
  at). The browser tab shows the count too, with ⚠ when something is red.
- **Dashboard** (race day): a setup checklist until the meet is set up, then one tile per Active race, and **Needs
  attention** beside the tiles on a wide screen (above them on a narrow one). A race tile has its gun time (the
  pencil changes it in place), where its splits go (a chip per output, and "Not on TrackScore" when TrackScore shows
  another race), **No names** while there is no names file (click it to choose one), its RR12 port (said in amber or red when nothing is connected to it), a tile per split point with the
  runners counted there and its **Pause**, and the **Review** button. Needs attention has one line per problem, red
  first, with its fix; the arrow opens the full explanation, and "N more" the rest. Which race TrackScore shows is a
  choice, not a fault: its line ("TrackScore shows Girls 5K · Boys 5K also running") offers **Switch to …** (it asks
  first, and names the race TrackScore leaves) and **Keep** (the line comes back when the races running change).
  Below: the races that are not Active with **Switch to …**, and the **Live feed** (pick a race, problems only,
  filtered reads, a search; click a row, or use the arrow keys and Enter, for its detail; **Freeze list** holds it
  still to read; **Show more** for older rows). There is no running race clock: the gun is shown as a time of day.
- **Review**: the work queue of one race at a time, the race as a grid of runners by splits, and the runner editor
  (see [Review](#review-missing-splits-and-made-up-times) and [Fix a runner](#fix-a-runner)).
- **Bib or name** at the top (**B** on every page): type a bib (or part of a name or team) and press **Enter** to open
  that runner in Review, in whichever race they are.
- **Races**, **Outputs**, **Inputs** (the RR12 ports and the exporter to set up in RR12), **Settings** (tag filter,
  names file, merged `.lif` files, control panel) and **Help** (the checklists, the status words, what to do when
  something goes wrong). A small **?** beside a field opens its longer explanation.
- **Keys** (not while typing in a box): **B** finds a runner (the box at the top), **/** finds (the feed search on the
  Dashboard, the runner box elsewhere), **R** opens Review, **1** to **7** open the pages, **Esc** closes the output
  editor. In the runner editor: **← →** move between the splits, **Enter** sends a suggested time or opens the choices,
  a digit types a time, **Shift+← →** moves a time one split with the later times, **F** / **Delete** open the choices
  on This is the finish / Not a split, **Ctrl+Z** undoes the runner's last change (**Ctrl+Y** does it again).

**Nothing is lost.** Every read RR12 sends is saved in `data\reads.jsonl` the moment it arrives, before Split Relay
uses it, so a crash loses no reads. (If the PC itself lost power, press Replay in RR12 once Split Relay is back: reads
it already has are ignored.) The outputs catch up by themselves: after an outage, a script fix or a restart, each
output gets the splits it missed.

## First-time setup

**The quick way.** Load the meet setup: **Races → Load meet file…** (or drop the `.json` anywhere on the page), or
**Set up from TrackScore** to read the races and their split points from TrackScore's Race Setup. A preview says what
will be added and changed; nothing changes until **Apply**, and nothing is sent. Then check steps 1-7 below.

- A **meet file** brings the races (names, events, ports, splits), the outputs, the RR12 ports, the names file, the
  merged `.lif` folders and the tag filter. Never gun times, reads or Pause: you type each gun on race day.
- **Set up from TrackScore** reads the meet TrackScore shows now (TrackScore's web page: the TrackScore output's address,
  port 5000; Settings → Meet setup to change it). Each TrackScore race becomes a race here with its event number,
  distance and split points, named and counted exactly as TrackScore has them (capitals too), so the columns always
  match. Races that are already here keep their name (FinishLynx's). A new race takes FinishLynx's name when FinishLynx
  has written that event's file today, else TrackScore's: the preview says which, and each name must be exactly
  FinishLynx's event name. If TrackScore is not showing a race of its meet, the preview says to check it is this meet.
- A load never deletes or empties anything. A race that already has reads or a gun keeps them, and only its split
  names can change; anything else it would change is listed under "Needs your attention". Removing races that are not
  in the file is a tick box in the preview, for races with no reads only.
- Just before a load, the setup as it was is kept (Settings → Meet setup → "Before the load at 15:02"). Loading it puts
  back what it has, as it was: the races it has, the settings. What the load added stays: its preview offers to remove
  the races with no reads, and says which outputs and RR12 ports to delete by hand.
- A file you load with **Load meet file…** or a drop is kept in `data\meets` too, so it is one click next time.

**Save the meet setup.** Type the meet's name in **Settings → Meet setup → Meet name**, then press **Save meet setup**
(there, or on the Races page): it saves the name and writes `data\meets\<meet name>.json` (with no name, the file is
called after today's date). Your browser downloads a copy (keep it on a USB stick for the next meet or another PC). A
meet saved again under the same name replaces its file; the copy it replaces goes to `data\meets\old`. Next time, load
it with one click: in the setup checklist on the Dashboard, on the empty Races page, or in Settings → Meet setup.

Do these once per meet. Until they are done, the Dashboard shows them as a checklist that ticks itself; Help has the
same list, and the race-day checklist with tick boxes.

### 1. Race Result 12: the Split Relay exporter

Add one exporter that sends the **split mats** to Split Relay. It sends the same line as RR12's exporter to FinishLynx
(the FinishLynx LapTime line): the bib and the time of day, nothing else.

- Type: **TCP/IP** (not Pooled).
- Destination: the Split Relay PC's address and port **5565**. The **Inputs** page shows the address, for example
  `192.168.0.21:5565` (click it to copy it; a PC with several networks lists the others under **More addresses**).
  Use `127.0.0.1:5565` if RR12 runs on the same PC.
- Timing points: **the split mats only (A and B), not the finish.**
- Line end: **CRLF**.
- Min. Seconds Between: **0**.
- Export Data (the **Inputs** page and the setup checklist have it with a Copy button):

  ```
  chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]
  ```

  Each read then arrives as a line like `S,15:17:44.215,254`: time of day 15:17:44.215, bib 254.

**Races that overlap.** One exporter feeds one running race. When two races are on the course at the same time, add a
**second exporter** in RR12, filtered to the second race, with the same settings but sending to a **second port**
(for example 5566). Add that port on the **Inputs** page (**Add a port**), and choose it on the race (**RR12 port**).
The status strip then has a light for each port.

### 2. Race Result 12 and FinishLynx: finishes only

- The RR12 exporter to FinishLynx sends the **Finish** timing point only.
- In FinishLynx, every event has **Total Laps = 1**.

### 3. The meet's names file (.ppl): load it first

RR12's line carries only the bib. **Without a names file, TrackScore and the live results show splits with no names
and no schools.** Load FinishLynx's people file for this meet (often `Lynx.ppl`) before the first race:
**Settings → Names file → Choose…** (or the setup checklist, or **Choose names file…** in Needs attention). The file
picker opens at once and the file is used as soon as you click it: "✓ 412 athletes loaded". Names are then spelled
exactly as FinishLynx has them, so TrackScore never shows two spellings of one runner. The file reloads by itself when
FinishLynx changes it.

- Once FinishLynx's folder is set (step 7), the `.ppl` files in it and in the folder above it are offered on top, with
  their date: "Use C:\Lynx\Lynx.ppl (modified today 09:12)". An old date means last meet's file. Nothing is loaded
  until you click.
- Missing it? Needs attention says "No names file" in amber, and in red once a race has sent splits ("TrackScore gets
  no names"); each race tile shows **No names**.
- Loaded it after splits went out? Needs attention offers **Send names now** for each race: its splits go again, now
  with names (runners who have finished are left out: FinishLynx sent their names). **Not now** hides it for that file.

### 4. Split Relay: the races

On the **Races** page, add one race for each race of the meet (**+ New race**), or load them all at once (see "The
quick way" above). **Set up from TrackScore** names and counts the splits exactly as TrackScore's Race Setup, so the
columns match.

- Name: type it **exactly as FinishLynx's event name**. Once FinishLynx writes its file, the merged `.lif` file
  carries FinishLynx's name, and TrackScore treats a new name as a new race. The race's page warns when they differ.
- Event number, round and heat **as FinishLynx has them**. The merged `.lif` files are matched on these. Each race
  needs its own event, round and heat.
- **RR12 port**: the port of the exporter that sends this race (5565, or the second port of an overlapping
  race).
- **Number of splits** (1 to 20, the − and + buttons): how many times a runner passes the split mats before the
  finish. The rows are named "Split 1", "Split 2" … (type other names if you like). Each row shows the **laps to go**
  it is sent with.
- Each row has a **Send** switch, on for every split, a **+** that adds a split right after it, and a **×** that
  removes it. Switch **Send** off for a mat that must be counted but is not worth showing (see
  [Splits you collect but don't send](#splits-you-collect-but-dont-send)).
- **Gun time** (a new race only, optional): set it in the same step when the race is created as the gun goes.
- **Active**: one RR12 port feeds one Active race at a time. Between two races on the same port, press
  **Switch to …** (Dashboard, or the race): the next race becomes Active and the finished one is unticked in one step.

**How passes become splits.** RR12 sends only the bib and the time, so Split Relay counts each runner's passes. Reads
of one runner within the tag filter window (10 s, Settings) are one pass: the A and B mats. The first pass is split 1,
the next split 2, and so on. A pass after the race's last split is ignored (**Extra pass**). If every runner gets an
extra pass, the exporter probably sends the finish too: it must send the split mats only.

**The tag filter and mats close together.** The tag filter must be shorter than the fastest runner's time between the
two closest mats on the course. A fast runner covers 200 m in about 35 s: with a tag filter of 45 s, a mat 200 m after
another one is merged into it for the fast runners and counted for the slow ones, and the fast runners' later splits
all land one column early. The A and B mats of one split read a runner a second or two apart, so 10 to 20 s is plenty.

**A missed mat.** If runners can miss a mat, open **Advanced** on the race's page and give a split an **earliest race
time** in minutes and seconds (for example `8:00` for split 2; a later split needs a later time). A pass at or after
that time is at least that split, so one missed mat does not shift the later splits. A pass before the next split's
earliest time is ignored (**Too early for this split**).

**Laps to go, never 0.** TrackScore and Karmarush put each split in a column by laps to go: with 3 splits, split 1 goes
out as 3, split 2 as 2, split 3 as 1. Laps to go 0 means the finish, so Split Relay never sends a split with laps to
go 0 (or more than the race's splits, or with a finish time): such a packet is refused, logged, and counted as
**Refused** on the output's card. If you change the number of splits after splits went out, those splits are in the
wrong columns: the race tile says so and offers **Resend splits…**. Resend corrects every split Split Relay
has, but it can't empty a cell: a runner who has no split in a column under the new setting may still show an old time
there in TrackScore and the live results until that race is cleared there (see Resend below).

**Where the reads go: six rules.** A read goes to the Active race that reads from its RR12 port (with SR lines, the
Active race that lists its contest; see Advanced below). In the rules below, "contest" also means "port". Before you
save or delete a race, Split Relay says exactly what will happen to the reads it has, for example "3 reads from port
5565 move from Girls 5K to this race".

1. **A race that is not Active keeps exactly the reads it has, and takes no new ones.** Changing other races never
   moves a read into it or out of it, so a finished race keeps its reads and its merged `.lif` file keeps its splits.
   Reads that only races that are not Active would take wait for them ("Race paused"): they are not used, the new
   ones neither. Tick Active on the race (or press Switch to), and it takes them all. So a race switched off by
   mistake can be switched on again.
2. **Deleting a race takes its reads out of use for good** ("Race deleted (not used)"), even if you add the race again.
   To stop a race but keep its reads, untick Active instead of deleting it. A contest of its reads (reads without a
   contest never are) is also set aside (rule 5), so that the reads of it still to come are not used either, when all
   of these are true: new reads of the contest went to the deleted race (it was Active and listed the contest, or took
   every contest) or waited for it (it listed the contest and was not Active, or it was missing); no race lists the
   contest now; no Active race has reads of it; and no missing race (rule 6) holds the contest. Otherwise new reads go
   where the other rules put them, for example to the Active race that already has reads of the contest. Only the
   Delete button deletes a race: a race that is gone from the settings any other way is missing (rule 6).
3. **Clear race data takes the reads the race holds now out of use** ("Cleared (not used)"). To rebuild the race, press
   **Replay** on the exporter in RR12 afterwards: the reads count again as new reads (reads from before the gun stay
   out, so a false start's or a test's reads don't come back as splits). What you set for passes in Review stays and
   applies again to the same reads; made-up times are forgotten ([Fix a runner](#fix-a-runner)).
4. **When you change a race, the reads in Active races and in no race are worked out again, among the Active races:**
   the Active race that lists their contest takes them; if only races that are not Active list it, they wait for them
   (rule 1); a race that takes every contest keeps the ones it has, and gets back the ones that came from it (a contest
   you added to another race by mistake and took out again); reads that never had a race go to the race that takes
   every contest. Reads that a race took off its contest list and that have nowhere to go are set aside (rule 5).
5. **A set-aside contest** ("Set aside (not used)") is not used, its new reads neither, until you list it on a race.
   List it on an **Active** race and they all count there; listed on a race that is not Active, they wait for it
   (rule 1). A race that takes every contest does not take them, because it would place those runners among its own.
   The Dashboard says so, with a button to fix it.
6. **A race that is gone from the settings, but was not deleted, is missing** ("Race missing (not used)"). That
   happens when `config.json` was put back from its backup (`config.json.bak`, the copy from the last start), reset or
   edited by hand. Its reads wait for it. It also holds its contests (those of its reads, and of reads that came from
   it): while no race lists one and it is not set aside, the other reads of it wait too, new ones included, instead of
   going into the race that takes every contest (unless that race already has reads of the contest and none of them
   would be set aside: then they go there, with them). Nothing changes for good: press **Put it back** on the red
   warning on the Dashboard (Needs attention), and the race comes back with the settings kept in its race file; its
   reads are in it again, and the ones that waited for it go where rule 4 puts them. Delete it there only if you don't
   want it back: like any delete, that takes its reads out of use.

"Takes every contest" means a race with no contests and no port. A race with a port takes that port's reads only.

Fixed a setting late? It counts for the reads already received too. Set the number of splits, choose the port, add a
contest to an Active race or move the gun, and the earlier reads are worked out again.

**Finished runners.** Split Relay never sends a split live for a runner who has finished, because TrackScore would
replace their finish place with the split place. Their splits are still in the merged `.lif` files. Split Relay knows
a runner has finished from FinishLynx's own `.lif` file (when merged `.lif` files are on), or from a finish timing
point (SR lines). **Review** lists those splits, with **Send with finish place** (see below).

**The start area.** On many courses the start runs over a split mat: every runner is read there seconds after the gun.
Those reads must not count, or they would be split 1. So every read in the first **60 s** after the gun is ignored
(status **Start area**). If a real split comes that early, lower **Ignore reads in the first … s** on the Settings
page (Tag filter); 0 switches it off. A change counts for the reads already received too.

### 4b. The start lists: the meet's entry files

RR12 sends a bib and a time, nothing about the race: a read belongs to the race that is Active on its port. An athlete
of another race who jogs over a mat becomes a split of the race that is running, with a place on the boards, and
every runner behind them is one place too low. With the meet's entries loaded, Split Relay knows who is entered where
and keeps such an athlete off the boards.

- On the **Races** page press **Load start lists…** and choose the entry files (several at once), or drop them on the
  page. One text file per event, **named by its event number**: `1.txt`, `2.txt`. Each has a header line and one
  line per athlete, the bib first: `NO.;FIRST NAME;LAST NAME;SEX;YEAR;CODE;SCHOOL;DIV;DIVPTS;EVENT;WAVE`. Semicolons,
  commas or tabs all read. When the file has an EVENT column, that is the event, not the name (the page says so when
  the two differ).
- The page says what each file held, one sentence per file: "1.txt: 108 athletes entered in event 1 (Men's 8K)."
  "7.txt: 2 athletes entered in event 7, which has no race here." "3.txt: no athletes in it (only a header line).
  Nothing was loaded." Then each race shows its list ("Men's 8K: 108 entered, from 1.txt"), and a race without one
  says "no start list".
- A race gets the list of its **event number** (round and heat do not matter). Loading a file again replaces that
  event's list; **Remove** takes one away.
- Split Relay keeps only the bibs of each event, in `data\startlists.json`, so a restart has them. **Start a new
  meet** puts them away with the old meet. The names still come from the names file.
- A list that does not fit a race does nothing there: see [Athletes of another race](#athletes-of-another-race).

Without start lists everything is sent as before, and Split Relay remembers the day instead: a bib that ran another
race today is flagged when it is read in this one.

### 5. TrackScore and Karmarush: the number of splits

In TrackScore, set each race's **Intermediate splits** to the race's number of splits in Split Relay, and set the same
number in Karmarush. Both put each split in a column by laps to go: if the numbers differ, the splits land in the
wrong columns. The race editor says it for each race: "Set the number of splits to 3 in TrackScore (Intermediate
splits) and in Karmarush." Or the other way round: set up TrackScore's Race Setup first and press **Set up from
TrackScore** (Races page): Split Relay's splits then match TrackScore's split points, one for one.

A split whose **Send** is off is not in that number: TrackScore and Karmarush are set up with the splits that are sent
only. The race editor then says, for example, "Set the number of splits to 9 in TrackScore (Intermediate splits) and in
Karmarush. 2 more splits are counted only …". **Set up from TrackScore** compares TrackScore's split points with the
splits that are sent, in order, and leaves the ones that are only counted where they are; its preview says so.

### 6. Split Relay: the outputs

On the **Outputs** page (each output is edited in a panel at the side; **Esc** closes it):

- **TrackScore XC**: press **+ TrackScore**. That is TCP client, IP `127.0.0.1` (or the TrackScore PC's address),
  port **5555**, script `C:\Lynx\XCScore.lss`, sections **Results**, event number from the race, 3 decimals.
- **Live results**: press **+ Karmarush live results**. TCP client to the live-results address and port, script
  `C:\Lynx\Karmarush-Track.lss`, sections **Results**. Type this meet's number in **MID** (the script has last meet's).
- Press **Preview packet** on each output. It shows exactly what will be sent and whether it is valid JSON.
- Each output's light at the top turns green when it is connected.
- **Send a clearing line when a split is taken back** (off): leave it off for TrackScore and Karmarush. When it is on,
  a split that went out and is taken back (Not a split, a Move, an Undo, Stop sending this runner) goes to that output
  once more as the runner's row for that split with an empty time and place, for a receiver that can blank a cell.
  TrackScore ignores a row with an empty time today, so there it changes nothing; with it off nothing extra is sent.

### 7. Merged .lif files

On the **Settings** page, under Merged .lif files (or **Set the folders** in the setup checklist):

- Tick the box to switch it on.
- FinishLynx folder: where FinishLynx writes its `.lif` files, for example `C:\Lynx\Meet` or `\\192.168.0.5\Lynx\Meet`.
  Type full paths: a drive letter, or two backslashes for a network share.
- Output folder: a **separate** folder, for example `C:\Lynx\Merged`. Split Relay never writes into the FinishLynx
  folder.
- Until FinishLynx saves its first race, the status says "No FinishLynx .lif files in C:\Lynx\Meet yet": that is
  normal. A FinishLynx folder that does not exist (or a share that is down) says "not found": check the path.

Then point the other programs at the **output folder**:

- TrackScore: its Lynx folder / file watch.
- XC-Analytics: its watch path.
- The web results upload.

**TrackScore's file watch** shows only runners with a place, as it did with FinishLynx's own files. Runners still on
the course appear when they finish. Live splits reach TrackScore over port 5555 while it is not watching a file for
that race.

**A missed mat in TrackScore's file watch.** When a runner missed a split mat, the merged file leaves that split empty.
TrackScore's results-file watch drops empty split entries, so that runner's later splits move one column to the left
there (FinishLynx's own files had the same effect). XC-Analytics reads them in the right columns. Live splits on port
5555 are not affected: each one says which split it is.

A `.lif` file whose event number, round and heat match a race gets the splits added. Any other `.lif` file is copied
as it is. A race that has splits but no FinishLynx file yet gets a file of its own.

## Advanced: timing point names (SR lines)

An RR12 exporter can send timing point names, contests and runner names instead of the LapTime line. Use it only if
you need that: on the **Inputs** page, open **Advanced: send timing point names instead**. It has the field editor
and the Export Data expression to copy. With the standard fields it is:

```
"SR|" & [RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk") & "|" & [Contest.Name] & "|" & [Firstname] & "|" & [Lastname] & "|" & [Club] & "|" & [Gender]
```

Split Relay reads either kind of line on any port, by itself. With SR lines:

- Send all split timing points (primary and backup are separate timing points in RR12, for example `1K-A` and `1K-B`).
  Each split gets its timing points with "+ add"; the list offers the names RR12 has already sent. Split Relay keeps
  the earliest read of each runner at each split and ignores the rest.
- **Contests** choose the race: list each race's RR12 contests. A race can then read from no port ("None: only reads
  that name one of its contests"), so several Active races can share one exporter.
- A **finish timing point** (optional) marks the runner as finished: later reads of that runner are ignored, and no
  more splits are sent for them. Finish reads are never sent.
- **Loop courses**: a timing point belongs to one split only. If runners cross the same mat twice, set RR12 up to send
  a different timing point name for each pass, for example `Loop-1` and `Loop-2`, and give each name its own split.
- Optional: Connect message `SR|HELLO|RR12`. Split Relay then logs when RR12 connects.

## Race-day checklist

0. New meet? **Settings → Meet setup → Start a new meet…**, then load the meet file or **Set up from TrackScore**.
   (Last meet's reads are put away and a copy of the data folder goes to `data\archive`; nothing is deleted.)
1. **First, load the meet's names file (.ppl)**: Settings → Names file → Choose…. RR12 sends only bibs: without it
   TrackScore shows no names or schools. The Dashboard's **No names** chip and Needs attention say when it is missing.
2. **Then load the start lists**: Races → **Load start lists…**, the meet's entry files (`1.txt`, `2.txt`: one per
   event). Each race then says how many are entered. Without them, an athlete of another race who crosses a mat is a
   split of the race that is running.
3. Start Split Relay **before** pressing play on the RR12 exporter. RR12 won't start an exporter it can't connect to.
4. Check the lights at the top: each RR12 port green (receiving), each output green. With two ports, Needs attention
   on the Dashboard names every port nothing is connected to ("RR12 isn't connected on port 5566"), with its race.
5. Each race that is running is **Active**, reads from the right RR12 port, and has the right number of splits.
6. TrackScore (Intermediate splits) and Karmarush: the same number of splits, for every race. **Set up from
   TrackScore** (Races page, or Settings → Meet setup while a race runs) makes Split Relay's splits match
   TrackScore's Race Setup.
7. When the gun goes, set the gun time on the race's tile on the Dashboard (the box shows while no gun is set; the
   pencil changes it) or on the Races page. Type the time from the start clock (`10:00:00.000`) and press **Set**
   (or Enter). Once FinishLynx has written the race's file, the **FinishLynx** button puts its start time in the box
   for you to check and Set. The gun time is exactly what you type: Split Relay never sets it from a clock (there is
   no "Set to now"). Reads that came in before the gun time was set wait, and go out the moment it is set.
8. Watch the Dashboard. First split reads show as **Sent** in the live feed and the counts on the split tiles go up.
   Read **Needs attention**: each line says what to fix, for example "12 reads are waiting for the gun time".
9. TrackScore shows one race at a time. While two races run, send TrackScore only the race it shows: a split from
   another race makes TrackScore switch to that race and clear the one it showed. Needs attention says which race
   TrackScore shows while others run, with **Switch to …** (it asks first) and **Keep**.
10. A split point in trouble (a mat down, a mat reading the wrong runners): press **⏸ Pause** on its tile. Its splits
   are kept, not sent, until **▶ Play**. See [Pausing a split](#pausing-a-split).
11. A split that is too fast to be real: Needs attention says "Bib 142: a split too fast to be real" the moment the
   read comes in, and the race tile's Review count goes up. The split went out as it is (Split Relay holds nothing for
   this). Press **Open Review**: the row under **Splits that look wrong** says why ("Bib 142, 4.4K 15:36.4: 3:01.7 after
   3.4K, where the leaders took 3:21. Too fast for a runner who was 74th: not a split?") and has three choices:
   **Not a split** takes the time back, **Stop sending this runner** keeps everything of the runner from that time on
   off the boards (a runner who dropped out and walks over the mats), **It's right** leaves it. The other runners'
   places go out again by themselves. See [A split too fast to be real](#a-split-too-fast-to-be-real).
12. An athlete of another race over the mats: with the start lists loaded they are kept off the boards by
   themselves. The race tile says "22 not in this race", and Review lists them under **Not in this race** with the
   race they are entered in (**Count them here** if one does run here). Without start lists Needs attention says "Bib
   213 ran in Boys 2A today: not in this race?": in Review, **Not in this race** takes the lines back and puts the
   other runners' places right, **It's right** leaves them. See [Athletes of another race](#athletes-of-another-race).
13. Runners who missed a mat: press **Review** on the race tile (or open Review on the left). For a runner a mat
   missed, the one click is **Missed 2400m: add it** (on the row in **Passes to check** or **Splits that look wrong**,
   and first in the menu of the cell that says **Missed here?**): the time in 2400m and the later ones move on one
   split, 2400m gets the suggested time, and TrackScore and Karmarush get every changed split at once, each with its
   laps to go, the runner's furthest split last. Two or three mats missed in a row: **Missed 2400m and 3100m: add
   them**. Two mats missed apart, a split read between them: **Missed 4200m and 5300m: add them (4400m was read)**,
   both in one change, 4200m, 4400m and 5300m each sent once; for a finisher whose 5300m was missed too, 5300m is part
   of the same change (**Missed 3100m and 5300m: add them (4200m and 4400m were read)**). Split Relay works out which
   mats missed the runner from all of the runner's later times, so the row can be about an earlier time than the one
   it holds (561: its 5300m time went out as 4200m, and the row of its held 4400m time says "19:41.6 looks like 5300m,
   not 4200m (missed 4200m and 4400m?)", **Missed 4200m and 4400m: add them**). A runner whose first time is far behind
   every other runner at the first split is listed too, also when nothing else looks wrong ("8:49.0 looks like 2400m,
   not 800m, and 16:42.2 like 4400m, not 2400m (missed 800m, 1500m and 4200m?)"). A runner who started late (every
   mat read, minutes after the gun) is not a missed mat: its times from split to split fit the course as read, so
   nothing is held and every split goes out as read; the line under its name may say "started about 5:00 after the
   gun?", nothing to do (on the course its first time waits for its second or third, and "Missed 800m: add it" is
   offered meanwhile but never the one click, and its later times wait with it). A runner who lost minutes on one leg
   (a fall, a stop), every mat read, is no missed mat either once later times show it: its times go out as read, the
   line under its name may say "about 2:30 lost before 2400m?", and **Missed 2400m: add it** may stay offered, never as
   the one click. A stray pass (a second read 30 s to a minute and a half after a mat) that made up for a missed mat
   in the count is set aside in the same change: **Missed 2400m: add it (11:24.4 is a stray pass)** sends 2400m made
   up, the later times a split on, and the stray in no column; a stray before the missed mat too, once the runner's
   finish is known (**Missed 4400m: add it (18:36.8 is a stray pass)**). A runner whose mats all read but who ran one
   leg very fast can look like a stray: then the set is offered, not the one click ("Split Relay can't tell a stray pass
   from a fast leg"). A slow last leg's 5300m time held as "it looks like the finish" goes to TrackScore and Karmarush
   by itself, with the finish place, once FinishLynx's finish shows it was 5300m's. When it can't tell (one time so far
   after the missed mats, a late start or a leg minutes slower than the runners', two splits close together, or two sets
   of mats that fit about as well), the row says so, offers the choices with what each does, and none is the one click:
   wait for what the row says (the runner's next time, or its finish), or choose. One missed split can always be typed
   by hand from the cell that holds the later time (**Missed 800m: type its time…**: the later times move on one split).
   A held time before the one that says **Missed here?** keeps its own Move, but not as the one click: the missed mat's
   fix usually settles it. One Undo puts it back. Then send the other made-up times Review lists. A missed split whose
   read RR12 sends later goes out by itself. A coach asks about a runner: **B**, the bib, **Enter**. See
   [Review](#review-missing-splits-and-made-up-times) and [Fix a runner](#fix-a-runner).
14. After a race, press **Switch to …** for the next race on the same port (or turn off **Active**). Don't delete it: it
   keeps its reads, and its merged `.lif` file keeps its splits.

## Resend

A read that gives a runner's split another time (an earlier backup read, a missed split's read that RR12 sends late
and that moves the runner's later passes on, a real read that replaces a made-up time) goes out by itself whenever it
comes, with the runner's furthest split last. Other changes to splits an output already has go out by themselves for a
minute after the first send: another runner's place at an old split (sending it later would show that old place as the
runner's place on TrackScore), and what a setting changed (a new gun time, the number of splits, an earliest time).
After a change you make to a runner (Not a split, a Move, **Missed …: add it**, a fill, an Undo, Stop sending this
runner) the boards are put right by themselves, whatever the minute says: the runner's own changed splits go out, and
so does every line of the other runners whose place the change moved, each of those runners' furthest split last, so
TrackScore keeps showing each runner's place at its furthest split. The toast says how many ("51 lines of other
runners re-sent with their new places"). As with Resend, a finished runner's real splits are left alone (the place on
TrackScore is FinishLynx's), paused splits and held times wait, and a race that is not Active gets nothing.

For what a read or a setting changes after the minute, the race tile offers **Resend splits…** (and the race page
**Resend…**). It also offers it when the number
or the order of the splits changed after they went out: "TrackScore and Karmarush put splits in columns by laps to
go; this race now has 3 splits instead of 2, so the splits already sent are in the wrong columns."

The numbers count the same thing everywhere: a runner's split that is out of date on the boards counts once, however
many outputs show it, and the words name the outputs ("58 splits sent are out of date on TrackScore and Karmarush";
after a fill: "58 other places on TrackScore and Karmarush are now out of date"). The Resend dialog says how many
splits it sends (all of the race's splits, the out-of-date ones with them, and how many of them are out of date), and
its toast says that same number when they went.

- Resend leaves out runners who have finished, so TrackScore keeps their finish place. Tick the box in the dialog to
  send them too. Their made-up and typed times (Review) go anyway: they carry the finish place. A finished runner's
  split that TrackScore has with an old time is not counted as "out of date" on the race tile: Review lists it under
  **Finished: not sent live**, where **Send with finish place** corrects it and keeps the finish place.
- Resend is refused for a race that is not Active: TrackScore is probably showing another race, and would switch to
  this one and clear it. The dialog lets you resend anyway.
- **What Resend can't fix.** Resend corrects every split Split Relay has. But a split packet can only fill a cell in
  TrackScore or the live results, never empty one. So after a setting change (the number of splits, an earliest time,
  the start area, the gun time), a runner who has **no** split in a column under the new setting may still show an old
  time there in TrackScore and the live results until that race is cleared there. When Split Relay can tell, the race
  card, the race's page and the Resend dialog say how many, for example "2 cells sent earlier can't be removed from
  TrackScore by Split Relay (runners: 507, 519)". Split Relay does nothing in TrackScore itself: if those cells matter,
  clear the race in TrackScore and in the live results, then resend.

## Pausing a split

Each split tile on the Dashboard, and each split on the race's page (Races), has a **⏸ Pause** button.
One click pauses that split point; there is no dialog, because nothing is lost.

- A paused split is still worked out and counted: the tile gets an amber edge and says **Paused · 14 held**.
- Nothing of it goes to TrackScore or the live results, and it is left out of the merged `.lif` file. Its reads show as
  **Split paused** in the live feed.
- Press **▶ Play** (same button) and everything it held goes out at once, and into the `.lif` file. The message after
  it says how many went out and how many wait in Review because their runner finished meanwhile (with a **Review**
  button).
  Play first reads FinishLynx's results folder (a few seconds at most; the button says **Playing…** meanwhile), so it knows who has
  finished up to that moment.
- A runner who finished while the split was paused, even a moment before Play, is not sent live (that would replace
  their finish place in TrackScore). Review lists them under **Finished: not sent live**. Only a finish FinishLynx
  has not saved to its file yet can't be known at Play: once the file has it, Split Relay sends that split again with
  the finish place by itself, so TrackScore shows the finish place again within a second or two.
- Saving the race on the Races page never plays a paused split.

Use it when a mat is down or reads the wrong runners, or when you want to look at a split before it goes out.

## Splits you collect but don't send

Sometimes a mat reads the runners where no split is worth showing: a second mat about 200 m after a K marker, say.
It still has to be **counted**. RR12 sends only a bib and a time, and Split Relay counts each runner's passes: without
a split for that mat, every later pass of every runner would land one split early. So give the mat its own split, and
switch its **Send** off.

1. On the race's page (Races), put the split where the mat is on the course: the **+** on a row adds a split right
   after it. Type its name ("4.2K").
2. Switch its **Send** off. The row now says **Not sent** and **Counted only**: no laps to go, no Pause. The other
   rows' laps to go change at once, and the line under Number of splits says the number to set in TrackScore and
   Karmarush: the splits that are sent, not the ones that are only counted.
3. Save the race.

What it does:

- The split takes passes like any split. The column check, "Missed 4.2K: add it", the look-wrong and too-fast marks all
  see it as before.
- **Nothing of it goes out**: not to TrackScore, not to Karmarush, not into the merged `.lif` file (whose split count
  is the number of sent splits). It never waits, is never held or stale, and Resend, Send with finish place and the
  catch-up after an outage leave it alone.
- **Laps to go** of a sent split is the number of sent splits from it to the end: the last sent split is 1. With 1K to
  9K sent and 4.2K and 8.2K only counted, 1K goes out with 9 and 9K with 1, exactly as without the two mats.
- **Lap time (LS)** of a split is the time since the runner's last split that was sent: 5K's is since 4K, not since 4.2K.
- The Dashboard tile of such a split is grey with a dashed edge: its count and **Not sent**. In Review the column is
  marked "not sent" and grey; the Missing splits list never asks for a time there. The live feed says **Counted, not
  sent**.
- A runner the mat missed is fixed as always: "Missed 4.2K: add it" puts a made-up time there, which keeps the later
  passes in their own splits and is never sent either.
- When the K mat itself misses a runner, the read of the mat after it is taken for the K split at first, some 35 s
  late for 200 m: one read alone can't tell them apart. The runner's next read shows it: Review then holds both passes
  with "Missed 4K: add it", which puts a made-up 4K time on the boards instead and moves the rest on.
- Press a one click when it shows. When both mats missed a runner and the click is left until after the runner's next
  pass, the pass Review held first goes out in the 4K split (it is the runner's 5K time) until the click corrects it.

Switching **Send** on or off after splits went out changes the laps to go of the others, exactly like a new number of
splits: the page asks first, and afterwards the race tile says the splits already sent are in the wrong columns and
offers **Resend splits…**. Set the number of splits in TrackScore and Karmarush to the new number first. The Pause
button is something else: a paused split waits and goes out on Play; a split that is not sent never goes out.

**Two mats close together: check the tag filter.** The tag filter (Settings → Tag filter) makes one pass of the reads
of one runner that come within its window. Set it **below the fastest runner's time between the two mats**: about 35 s
for 200 m, so 20 s is safe. With 45 s nearly every runner of a fast race has the second mat's read merged into the
first, and the later splits land one column early without anything being held. Split Relay warns twice: the race's
page shows the tag filter under the splits when a split is not sent (amber from 30 s), and the Dashboard says so under
Needs attention once reads that came 15 s or more after the runner's last one were merged for three runners ("24
reads of 12 runners came 20 to 45 s after the runner's last one and were merged into it by the tag filter (45 s) …").
Lowering the tag filter then works every race out again from the reads it has: what is new goes out by itself, lines
sent less than a minute ago are corrected, older ones are marked out of date and one **Resend splits…** puts the boards
right.

## Review: missing splits and made-up times

**Review** (on the left, with a count) is the work queue, one race at a time (the chips at the top). The race tile's
**Review** button opens it on that race and shows how many wait there, for example **Review 4** (the tooltip says
"3 missing splits · 1 to check · 1 looks wrong"). It has two views: **To do** and **All runners**. In To do, the
counters at the top say how many of each kind wait; the lists come in the order to work them: **Passes to check**,
**Splits that look wrong**, **Missing splits**, **Finished: not sent live**, and **Made-up and typed times**. A row that
comes in while the list is open is added at the end with **New**, so nothing moves under the pointer. Any bib opens
that runner in the runner editor ([Fix a runner](#fix-a-runner)), on top of the page.

**Missing splits.** A runner is missing a split when they have a later split, or a FinishLynx finish, but no time at
that split: a mat missed them. For each one Split Relay makes up a time from the runner's split before and after it
(or the gun and the finish), placed like the 30 runners nearest in pace over that stretch. Point at the time (or its
**Made-up** chip) to see how, for example "From 1K 3:20.4 and 3K 10:45.1, placed like the 30 runners nearest in pace
(2K at 48.5% of that stretch)"; Find runner shows it under the time. Nothing is sent until you approve it:

- Check the time. Type another one if you know better (it is then a **Typed time**; **Use estimate** puts the estimate
  back). The list says once where Send puts the times ("Send puts the time to TrackScore and Live results, and into
  the merged .lif file"); a row says more only when it is not the usual: a runner who has finished, a paused split, a
  time that doesn't fit.
- **Send** sends that row (one click; **Enter** in the time box does the same, and moves on to the next row).
- **Fill in N missing…** (one split's chip, or all) shows the list to check, a tick per row, and which runners are left
  out and why: runners with no read after their last split and no finish (they may have dropped out: Split Relay
  makes nothing up for them), runners who finished without a known finish place, runners with a split that looks wrong
  (a time made up from it would be wrong too: fix that split, or choose **It's right**, first), runners whose columns
  are to check first. **Send N** sends the ticked rows together, exactly as the list showed them (one change: one Undo); a row
  another window filled meanwhile is named in the message. A row you typed a time into goes with its own Send.
- A time must be later than the runner's split before it and earlier than the split after it (or the finish); a time
  that doesn't fit is refused with a plain message.
- A row with no estimate yet says "waiting for a later split or the finish". You can type a time there.

**What "made-up" means for the results.** A made-up time is an estimate, not a timed split. Once sent, TrackScore,
the live results and the merged `.lif` file (so XC-Analytics and the web results) show it like any other split, ranked
with the real ones; only Review (and the log) say which times were made up. The finish time and place come from
FinishLynx and are never changed. If a real read for that split comes in later, it replaces the made-up time by itself
("Real read replaced the made-up time"). It replaces only the made-up time of the split it belongs to (the one whose
time it is nearest, between the runner's other splits); a read that fits an empty split instead counts there.
**Remove…** takes a made-up or typed time back out of Split Relay and the `.lif` file, but TrackScore and the live
results keep a time they were sent: a split packet can fill a cell, never empty one. Clear the race there if that cell
matters.

**Runners who have finished.** A split packet carries a place, and TrackScore takes it as the runner's place. So a
made-up time for a runner who has finished goes with their FinishLynx finish place, and TrackScore keeps it; the
dialog says so. TrackScore then also shows that place as the runner's place at that split (a packet carries only one
place). If the finish place isn't known (no merged `.lif` file yet), the row can't be sent and says why.
Real splits that came after the runner finished are listed under **Finished: not sent live**, with **Send with
finish place** (one, or all). So are splits that went out with an old time and were corrected after the runner
finished (a **Move**, an earlier backup read, a new gun time): the row says "Sent with an old time (29:12.1)", and Send
with finish place puts the corrected time in that cell. A split that went out just after the runner finished, with the split
place, is sent again with the finish place by Split Relay itself as soon as FinishLynx's file has the finish. **Find
runner** shows the same on the runner's split.
Before any of these sends, Split Relay reads FinishLynx's results folder once more, so a finish place FinishLynx
changed a moment ago is the one that goes.

**Check column.** Split Relay counts each runner's passes in order (1st pass = split 1). A runner who missed the first
mat would get their second pass in the first column. Split Relay compares every runner with the field, and when a pass
clearly belongs in another column it holds that pass (not sent, not in the `.lif` file; feed: **Check column**) and
asks in Review (**Passes to check**): **Missed 1K: add it** (the pass moves on to 2K with the later ones, and 1K gets
the suggested time, one change) or **Keep in 1K**. Your choice sticks (a restart keeps it), and the runner's other
passes are counted around it: one fix usually settles all of that runner's passes. When the RR12 stream carries the
finish line too, a runner who missed a mat has the finish pass in the last split, every split filled: Split Relay
then also looks at that pass as the finish, and keeps holding the runner (the finish pass row says "Looks like the
finish, not 5300m"), so nothing goes out a split early. It knows the stream carries the finish line once three
runners have passed again soon after their last split, so from the fourth finisher on. A runner who missed only the
last mat is held the same way: **Missed 5300m: add it**. A runner with every mat read is never held for it (measured
on synthetic races: none of 4,271 such runners, and 295 of 297 runners who missed a mat held with the right placing;
1 of 239 held runners let go when the finish pass came). Two mats missed in a row with a cool-down pass after the
finish fill every split too: the row says how many (**Missed 1500m and 2400m: add them**).

Two or three mats missed in a row are held the same way, before anything goes out: a runner whose 2K and 2.6K mats
missed her has her 3.4K time counted in 2K, far behind everybody there and at 2.6K too. Split Relay holds it when it
arrives ("Looks like 3.4K, not 2K (missed 2K and 2.6K?)"), and her next time with it; from then the one click is
**Missed 2K and 2.6K: add them**: both get their suggested times and the later ones move on, every line right on both
boards. It does this only for a runner whose first time is where it should be (that says how far behind the leaders
she runs) and whose held time is at that same level in the later split: a slow runner is never taken for one who
missed two mats.

- A runner's **first** pass that is well behind everybody at 1K but fits the runners at 2K is held before it goes
  out (most likely the runner missed the 1K mat). You don't have to decide at once: the runner's next pass (or their
  finish) settles it, and a slow runner's 1K then goes out by itself. Its later passes wait with it while that is
  open (a runner who missed 800m and 2400m has its 3100m time next, and that leg, far longer than any runner's, holds
  the next two mats in doubt too), so none goes out a split early. Measured on 10 real FinishLynx races: 97 % of
  the runners who missed the first mat are held before anything goes out, and no runner read at every mat is held.
- **What Split Relay can't tell.** One pass says only "this bib crossed a mat now". A runner near the front who
  missed the 1K mat crosses the 2K mat while the slowest runners are still reaching 1K: that pass fits both splits,
  so it goes out as 1K (most common in races with 2 splits, where the leaders reach the second mat soon after the
  last runners pass the first). Review then says "It went out as 1K before it was held" once the runner's finish (or
  next pass) shows it. After **Move to 2K**, send the made-up 1K time that Review lists: it replaces that 1K time in
  TrackScore and the live results. The finished race ends up right; only the live boards showed the wrong 1K for a
  while. A held pass that never went out there (held again after an **Undo**, say) says what the boards show instead:
  "It never went out: TrackScore and the live results show 4:50.8 at 1500m."
- For certainty from the first pass, each split mat would need its own RR12 exporter and port, so a read says which
  split it is. Split Relay can't use that yet (a race takes one port); it is a possible future option.
- For a runner who has **finished**, a Move or Keep here puts the pass in the merged `.lif` file only. Review then lists
  it under **Finished: not sent live**, with **Send with finish place**. (In the runner editor a finisher's Move asks
  once and goes with the finish place at once: [Fix a runner](#fix-a-runner).)
- A Move or a fill can change the places of the runners behind that pass at that split. Places a minute old or more
  are not changed by themselves (an old split's place would become the runner's place on TrackScore): the toast says
  how many, and the race tile offers **Resend splits…**.

## Fix a runner

One place to fix a runner: type the bib in the box at the top (**B**), or click a bib anywhere (the live feed, Review's
lists, the grid). The runner editor shows each split as a cell: the time and the place, and where it came from
(**Moved**, **Kept**, **Made-up**, **Typed**; a plain read says nothing), then the **Finish** cell. An empty split is
dashed: **Suggested** with Split Relay's time in grey when it can make one up; **Check first**, **Place unknown** or
**Not possible** when it can't (the line under the cells says why); **Not yet** when the runner has no later split and
no finish (still on the course, or dropped out). The line under the cells explains the cell you are on. Lines below
say what to look at, each with its one-click fix: a missed mat is one line with one fix (the held times after it move
with it and have no buttons of their own), so the runner's name line says "1 looks wrong" for it, and the search list
says "missed 2400m and 3100m?" with no other things to look at. The editor opens on the cell that says **Missed
here?**, whose first choice is the one click, and a held time after it offers that cell's one click first.

- **Fill**: on an empty cell, **Enter** (or **Send**) sends the suggested time. Click it, or type a digit, to type
  another time. The line under the box says how it is read: "Race time 8:12.3", or, with an hour of 3 or more, "Time
  of day 16:36:43.6 = race time 8:43.1". A time typed after the runner's last read, with no finish, asks first
  ("may have dropped out"). **Fill in N missing** at the top of the runner sends all of its suggestions at once.
- **Move**: on a time, **Enter** (or a click, or a tap) opens the choices. **Move to 4200m** puts the time in that split,
  and the runner's later times move with it (a missed mat shifts every later pass one split); each choice says what
  it does to the later times ("22:28.8 → 4400m, 26:22.1 → 5300m, 29:45.0 → extra pass"), the one that fits the
  runner's pace (when the time doesn't fit where it is) is first and says **fits the pace**, and the choices that can't
  be made come last, each saying why. A Move far from the runner's pace (a time much too early or late for that split)
  asks first. Made-up times the Move would put out of order are taken out with it (the choice says so). A time the
  Move leaves where Split Relay has a question about it is held, not sent, and the choice says so first: a runner who
  missed 3100m and 5300m, with **Move to 4200m** on its 4200m time, puts its finish read in 5300m, "21:46.1 → 5300m
  (held: it looks like the finish)", also with a cool-down pass a minute after it (far too soon to be the finish from
  5300m); its **Missed 5300m: add it** then makes 5300m up. **Only this time to …** moves this time alone (the others
  are kept where they are). With a mouse, drag a time onto another split (hold **Alt** for only this time), onto
  **Finish**, or onto **Other passes**. **Shift+→** moves it one split later at once.
- **Missed 2400m: add it**: a mat missed the runner at 2400m, so the time there is really 3100m's and every later
  time sits one split early. One change moves the time in 2400m and the later ones on one split and gives 2400m the
  suggested time, made up from the split before it and the time that moved on (placed like the runners nearest in
  pace), or a time you type (**Missed 2400m: type its time…**). A time moved past the last split is an extra pass
  (never laps to go 0). TrackScore and Karmarush get every changed split at once, in its column with its leg (LS), the
  runner's furthest split last, and one **Undo** puts it all back. A split whose time and column are what the boards
  have already but whose leg is not goes again too, whatever change gave it that leg (**Not a split** for a stray, then
  **Missed 1500m**: 2400m keeps its time and gets its new leg). When FinishLynx's finish puts a finisher's place back on
  a split that went out with its split place, the runner's furthest split follows it, so the boards end with it. The
  cell where the column check or Splits that look wrong points says **Missed here?** and has it first; every other time
  has it in its choices too. For the last split the finish pass becomes an extra pass, so it works with merged `.lif`
  files off: the runner is not finished for Split Relay, and 5300m goes with its own place. If you marked that pass as
  **the finish** already, the empty 5300m cell offers the same. When the cell's choices are sets of several splits
  (three mats missed apart, say), its own split can still be typed alone: **Missed 800m: type its time…** ("the later
  times move on one split"), every split it changes sent again; type the next one from its own cell. A split that can't
  be filled yet says which time to check first and how: "Check bib 488's 4200m first: 16:33.7 is held (it looks like
  4400m). Choose "It's right: keep it in 4200m" or Move it in its menu; then 4400m can be filled."
- **How many in a row.** Split Relay works out how many splits the mat missed from all of the runner's later times:
  for each count, every later time moved on that many splits (past the last split the first is the finish when RR12
  sends the finish line, the rest extra passes), each leg measured against the runners of the same pace. When one
  count fits clearly best it is the one click (**Missed 2400m and 3100m: add them**, **Missed 3100m, 4200m and 4400m:
  add them**). When two fit about as well, Split Relay says it can't tell which and offers both, each with what it does
  ("Missed 2400m and 3100m: add them (15:18.4 → 4200m)" or "Missed 2400m, 3100m and 4200m: add them (15:18.4 →
  4400m)"), neither as the one click: on the course the runner's next time usually settles it. A count that does not
  fit, with made-up times, is refused in words ("15:18.4 looks like 4200m: bib 459 missed 2400m and 3100m? Add them
  together, or type the time"); a time you type is yours.
- **Where the run starts.** Passes to check and Splits that look wrong point at the time they doubt, and that is not
  always the first time that moved on: a runner who missed 4200m and 4400m can have its 5300m time in 4200m among the
  slowest runners' times there (it goes out as 4200m) and only its finish time held in 4400m; a runner who missed
  4200m alone has its 4400m time in 4200m, 200 m before; one who missed the first three mats has its 3100m time in
  800m. Split Relay places all of the runner's times every way the mats can have missed them (from every split, one
  run or two apart), and the one click is where they fit clearly best: the cell there says **Missed here?**, the
  editor's line and the Review row say why ("19:41.6 looks like 5300m, not 4200m (missed 4200m and 4400m?): 8:28 after
  3100m, where runners of the same pace took 8:44"), and the row of the runner's first held time carries it ("…;
  22:29.3 moves on with it (the finish)"). Its one click sends 4200m and 4400m made up and 19:41.6 as 5300m, so no
  column keeps a time of another split. A finisher's finish read held in a split (within 10 s of the FinishLynx finish)
  is that finish: every split from there on was missed ("21:44.4 looks like the finish, not 4200m (missed 4200m, 4400m
  and 5300m?)"); Splits that look wrong says it the same way, with the runners' time to the finish. When another start,
  or the times as they are, fit about as well, none is the one click ("Split Relay can't tell yet where the mat missed
  the runner"): its next time may tell, or choose the one its times say. The set that fits best with all of the
  runner's times is offered beside the cell's own when it is another one (491 without the finish line in the stream,
  800m, 1500m and 4200m missed: "Missed 2400m: add it" or "Missed 800m, 1500m and 4200m: add them (2400m and 3100m were
  read)").
- **The first split.** A time at the first split has no time before it to measure a leg from, so Split Relay compares
  it with the other runners there: a time far behind every one of them (491's 1500m time, 6:03.9, counted in 800m
  where everyone else was by 3:08) is no fit for a set of missed mats that leaves it there, and **Missed 800m, 2400m
  and 3100m: add them (1500m was read)** is the one click, not "Missed 1500m, 2400m and 3100m". A runner like that is
  listed under Splits that look wrong even when no leg looks wrong and no time is held (221 missed 800m, 1500m and
  4200m: "8:49.0 looks like 2400m, not 800m, and 16:42.2 like 4400m, not 2400m (missed 800m, 1500m and 4200m?)"). A
  late starter or a walker whose mats all read is never moved for being far behind: the one click needs the runner's
  times to fit a set of missed mats clearly better than where they are.
- **A late start.** A runner who started minutes after the gun has every time late by the same minutes, so its first
  times are far behind everyone (and with FinishLynx's finish, behind where the field's finish says they belong). Split
  Relay measures its times from split to split: when every leg fits the course as read, like the runners of the same
  pace on that stretch, and clearly better than with a mat missed, it started late. Nothing is held, nothing is
  offered, every split goes out as read (with the finish place once FinishLynx has it), and the line under the name
  says it quietly: "started about 5:00 after the gun?". On the course its first time waits for its second (a missed
  800m looks just the same until then): it goes out with the second when that leg was faster than the leaders could
  have run it a split on, else with the third once its legs fit the course as read closely. Until Split Relay can tell,
  **Missed 800m: add it** is offered but never the one click ("Split Relay can't tell a missed mat from a late start"):
  choose it only if the runner started with the others. So too after the race on a course of even splits, where the
  legs can't tell, and for a late starter who missed a mat later, both offered ("Missed 800m: add it if the runner
  started with the others, or Missed 2400m: add it if it started late"). A late starter whose first mat missed it has
  that split made up from its start, not the gun. Its later splits are measured from its start too: a late starter who
  missed 4400m (or 4200m and 5300m) has a good 4200m time that looks late from the gun, and the set its legs fit (4400m)
  is the one click only when it fits clearly better than the others; else both are offered ("Split Relay can't tell
  which mats missed the runner"), never "Missed 4200m" as the one click. A wrong fix taken back (a Move back to its
  split, or **Undo**) sends every split it changed again, as read.
- **A slow leg.** A runner who lost minutes on one leg (a fall, a stop), every mat read, has a time that looks like a
  later split's. Split Relay weighs that leg like a late start: the runner's times as read with that one leg left out
  (up to 5 minutes lost) against every set of missed mats, and a missed mat is the one click only when it fits clearly
  better. On the course the time waits for the runner's next one ("Split Relay can't tell a missed mat from a slow leg
  until the runner's next pass"), and that one must fit where the missed mat would put it (three minutes lost from 800m
  to 1500m put the 1500m time where 2400m's belong; only the next time tells); once two later times fit the course as
  read, the held times go out as read during the race, and **Missed 2400m: add it** stays offered, never the one click:
  "Split Relay can't tell a missed mat from a slow leg (1500m to 2400m took 2:30 longer than runners of the same pace,
  and its later times fit as read): choose Missed 2400m: add it (10:51.5 → 3100m, 13:14.4 → 4200m) only if a mat missed
  the runner." The line under the name may say it quietly: "about 2:30 lost before 2400m?". A time that fits neither
  split well stays offered until the runner's finish ("... until the runner's finish"): a real missed mat's time nearly
  always fits the next split like the runners of its pace. A slow last leg (4400m to 5300m) whose pass looks like the
  finish waits for the stream's finish pass after it; when that pass comes about when the runner's finish would after
  its 5300m time (at the runner's own pace), Split Relay can't tell a slow leg from a missed 5300m and a cool-down pass:
  no sure "Missed 5300m", the 5300m time held with the row's question. Once FinishLynx's finish shows it was 5300m's, it
  goes to TrackScore and Karmarush by itself, with the finish place: no **Send with finish place** needed (for a runner
  with every split read and no time that looks like a stray pass; the others wait for their one click). While Split
  Relay can't tell yet how many splits a mat missed, a time one slow leg explains as well says so too ("a missed mat or
  a slow leg"). Once the runner's finish is known (FinishLynx's, with its finish read) and every split has its time
  before it, no mat can have missed it: nothing is held and nothing is offered.
- **A stray pass.** A second read of a runner 30 s to a minute and a half after a mat (later than the tag window: a
  runner who turned back, a tag carried close to a mat) is counted as the next split, and every later time sits a split
  early. With a mat missed as well, the stray makes up for it in the count: every column filled, nothing missing.
  Split Relay checks the legs, not only the count: a leg far shorter than the leaders' on that stretch (under three
  quarters of it), or, with every column filled, far shorter than the runner's own pace on its other legs (under 0.8 of
  it), is a stray pass, and the one click sets it aside in the same change: **Missed 2400m: add it (11:24.4
  is a stray pass)**, the row saying "11:24.4 is a stray pass, 0:40 after 10:44.4." and the choice what it does
  ("10:44.4 → 3100m, 11:24.4 → not a split"): 2400m made up, every later split right, the stray in no column, sent once
  each. On the course the one click waits for the runner's next time after a stray: only that time shows it. A runner
  with every mat read and a stray pass is listed under Splits that look wrong ("3:24.8 comes soon after
  800m for 1500m"), nothing held; **Not a split** for the stray is its one click when the leg is under a quarter of the
  runners' of its pace, else a plain choice beside **It's right** in that row (and in the cell's choices). Around the
  200 m from 4200m to 4400m a stray takes no longer than a real leg: with 4200m missed, a stray a minute after the 4400m
  pass shows only in the 900 m on to 5300m, a minute short of the runner's own pace. One under a minute after it can
  still look complete, and its cells' own choices (**Missed 4200m: add it**, **Not a split**) fix it by hand. A stray
  before the missed mat (a read 30 s after the 4200m pass with 4400m missed: the read in 4400m, the 5300m time where it
  belongs; or a read 1:30 after the 4400m pass with 5300m missed) is one change too once the runner's finish is known
  (FinishLynx's): **Missed 4400m: add it (18:36.8 is a stray pass)**, the row saying the stray first ("18:36.8 is a
  stray pass, 0:30 after 18:06.8. 23:02.0 looks like 5300m, not 4400m (missed 4400m?)"). A stray the one click would put
  in a split is set aside with it: 3100m missed and a read 37 s after the 4400m pass (as counted a 4400m time a split
  late) is **Missed 3100m: add it (16:10.6 is a stray pass)**, not "Missed 3100m" with the read sent as 5300m. Split
  Relay picks a stray by how the runner's times then fit, and the leaders' time on a stretch leaves a stray's out (a
  field with a few strays on one stretch no longer makes a real time look like one; five or more that far ahead are
  runners a mat missed, whose legs count as they are). A set that sets a stray aside is the one click only when the
  runner's times fit it clearly better than as they were read: a runner who ran one leg very fast, every mat read, can
  look like a stray, so the set is offered, never the one click (the row says "15:41.6 may be a stray pass, 0:38 after
  15:04.1.", then "Split Relay can't tell a stray pass from a fast leg"; the menu heads it "Split Relay can't tell: a
  stray pass or a fast leg"): choose it only if the runner was not that fast.
- **Two mats missed apart.** A runner the mats missed at 4200m and 5300m, read at 4400m between them, is one change:
  **Missed 4200m and 5300m: add them (4400m was read)**. The row says which times move ("15:08.2 looks like 4400m, not
  4200m, and 20:43.5 like the finish, not 4400m (missed 4200m and 5300m?)") and the choice what it does ("15:08.2 →
  4400m, 20:43.5 → extra pass"). TrackScore and Karmarush get 4200m and 5300m made up and 15:08.2 as 4400m, each once
  with its laps to go and leg, the furthest last, so no line goes out a split early; one Undo puts it all back. Split
  Relay weighs every set of missed mats against the others (one mat, two or three in a row, two apart) with all of the
  runner's times, and the one click is the set that fits clearly best. On the course it is the first mat alone until
  the runner's times after the second are in. Once the runner's finish would be in by now (twice the field's usual time
  from the last split to the finish, after the runner's last time), a set that leaves the runner on the course counts
  the finish mat as missed too; before that, Split Relay may say it can't tell yet. When two sets fit about as well
  (568, a walker far behind the runners of its pace: 4200m and 5300m apart, or 4400m and 5300m in a row; or 4400m
  alone, its last 700 m nearly twice as slow as the runners of its pace, or 4200m and 5300m), Review says "Split Relay
  can't tell which mats missed the runner" and offers both, each with what it does, neither as the one click (the
  cell's menu heads them the same way): choose the one its times say. A finisher (FinishLynx has its finish) whose
  finish read sits in a split had every split from there to the finish missed too, and those are part of the same
  change: **Missed 3100m and 5300m: add them (4200m and 4400m were read)** sends 3100m, 4200m, 4400m and 5300m once
  each, in course order, with the finish place. Many splits read between the two are said as a stretch: "(1500m to
  4400m were read)". A time that moves past the last split while RR12 sends the finish line is the runner's finish:
  "20:43.5 → extra pass (the finish)". Three mats missed apart, one read between each, are one change too: **Missed
  800m, 2400m and 4200m: add them (1500m and 3100m were read)**. When it is offered and not the one click, start by
  hand from the first: its cell's **Missed 800m: type its time…** fills 800m alone and moves the later times on one
  split, and the runner's choices then offer the rest (**Missed 2400m and 4200m: add them (3100m was read)**).
- **A made-up time that doesn't fit.** When a runner's later times don't fit a made-up time (a fix with too few splits,
  say), Review lists it under Splits that look wrong with its fix, never **Not a split** for the real time after it:
  "2400m's made-up 11:00.0 doesn't fit: 15:18.4 looks like 4200m, not 3100m (missed 2400m and 3100m?)". Its one click
  makes 2400m up again, adds 3100m and moves the later times on, every changed split sent again with its laps to go and
  leg, the furthest last. A time you type for a split moves a made-up time out of course order with it out of the way:
  it is made up again in its new stretch (or taken out when it can't be), and the toast says so ("4400m 15:02.9 typed;
  the made-up 4200m time (16:47.7) made up again (14:12.3)"). A real time you set aside as **Not a split** by mistake
  comes back with **Undo**, or in **Other passes** with its own **Let Split Relay count it**: its split goes out again.
- **Not a split**: a cool-down or stray pass takes no split; the later passes count on without it. A Move that a stray
  pass is in the way of says which ("The pass at 10:54.7 can't be 3100m: 4 earlier passes need the splits before it. If
  9:53.7 is a stray pass (it came soon after the pass before it), choose Not a split for it first.").
- **This is the finish**: when the stream carried the finish line too and FinishLynx has no finish for the runner, the
  pass is the finish. No more splits go live for the runner, and the split before it shows as missing. A runner who
  has finished gets no live split without the finish place (it comes from FinishLynx's file): with merged `.lif` files
  off, a finish pass that sat in 5300m stays there on the boards, so use **Missed 5300m: add it** instead (the choice
  says so). Marked already, and another split to send (800m, say)? Its cell says what to do: **Missed 5300m: add it**
  in 5300m ("23:54.4 → extra pass (the finish pass, no longer the finish you marked), 800m can be filled then"), then
  800m, which goes out with its own place.
- **Let Split Relay count it** forgets what you set for a pass. **It's right** says a time that looks wrong is right.
- Every change goes out at once (to TrackScore and Karmarush in its column, and into the merged `.lif` file), whatever
  the minute rule says (you decided it), when an output was down as soon as it is back, and on a paused split when you
  press ▶ Play. The runner's furthest split goes out last, so TrackScore shows the runner's place there (also after an
  Undo that sends nothing else, and after anything Split Relay sends by itself for an earlier split). A real read
  that replaces a made-up time goes out by itself, whenever it comes. The toast says what went where, what the boards
  keep, and after a fill how many other places are now out of date and on which outputs (Resend), with **Undo**.
- A runner who has **finished**: a change asks once, then the splits it changes go with the FinishLynx finish place,
  so TrackScore keeps it, the runner's furthest split last as for everyone. Without the finish place (merged `.lif`
  files off) they go into the `.lif` file only.
- **Stop sending this runner** (at the top of the runner, on the row of a split too fast to be real or a stray pass, and
  in that split's choices): from that time on nothing of the runner goes to TrackScore or the live results or into the
  merged `.lif` file. Its reads are still read, counted and shown (the cells say **Not sending**, the grid's row says
  "Not sending from 15:36.4 on", Review lists the runner under **Not sending**), and they no longer count for the
  places of the others. Pressed on a split that looks wrong, it starts at that split: the split and the ones after it
  are taken back ("Not sent from 15:36.4 on (4.4K and 5K taken back)"). Pressed at the top of a runner with nothing
  marked, it is for what comes after the runner's last time so far ("Not sent after 12:34.7"): what went out stays.
  **Send this runner again** (the same place, or Review's Not sending) puts it back: what was held goes out if it still
  fits. It is a change like any other: Undo works, and it is still so after a restart.
- **Undo** (in the toast, beside "Last change", or **Ctrl+Z**) puts the runner's last change back, also after a restart;
  then **Redo**. A cell TrackScore and Karmarush were sent stays filled there: a packet can fill a cell but never empty
  one. An Undo that empties such a cell asks first, naming the splits it empties ("4200m and 5300m are empty again in
  Review"), and so does the Undo of the fix of a runner the column check held
  (**Missed 2400m: add it** on a pass in Passes to check): the passes go back there, held, and the boards keep what the
  fix sent until you choose. Only the runner's newest change can be undone; a change made in another window is refused
  in words, never undone by accident.

### A split too fast to be real

At the IvyXC meet of 2026-10-31 a runner who had dropped out (55th, 59th, 67th, 69th and 74th at the first five
splits) had her chip read twice more, and both reads went to TrackScore and the live results as her next two splits,
the second as place 6. Nothing marked the first, and a line that went out can't be taken off TrackScore.

Split Relay now checks every split as its read comes in: the leg from the runner's split before against the leaders'
leg on that stretch (the middle one of the five fastest legs of the others) and against the runner's own legs so far.
A leg under 0.95 of the leaders' AND under 0.88 of the runner's own pace is too fast to be real. Nothing is held: the
split goes out like any other, and it is marked from that moment:

- **Needs attention** on the Dashboard: "Bib 142: a split too fast to be real", with **Open Review**; the race tile's
  Review count goes up and turns amber; the live feed's line ends "Too fast to be real? Review lists it under Splits
  that look wrong."; the runner's cell in the grid has the alert mark.
- Review, **Splits that look wrong**: one row per runner, for all of its times in question: "Bib 142, 4.4K 15:36.4:
  3:01.7 after 3.4K, where the leaders took 3:21; 5K 17:06.3: 1:29.9 after 4.4K, where the leaders took 2:09. Too fast
  for a runner who was 74th: not splits?"
- **Not a split** takes them all back in one change (one Undo): they are in no column, gone from the merged `.lif`
  file, and the other runners' places at those splits go out again by themselves. TrackScore keeps the cells it was
  sent (a packet can't empty a cell); the toast says which.
- **Stop sending this runner**: the runner is off the course. The marked splits are taken back and nothing more of the
  runner goes out, whatever its chip is read at.
- **It's right**: the mark goes away and the splits stay.

If you press Not a split when only the first read is in, the runner's next read takes that split and goes out; when
it comes slow for the runner it is marked too ("Slow for this runner, and it follows 15:36.4, which was not a split:
is it 4.4K?"). For a runner who has dropped out, Stop sending this runner is the one that ends it.

What it never marks: a runner far ahead of the field (every leg of hers is ahead of the leaders'), a runner from far
back who runs one of the fastest legs (it is not 5 % faster than the leaders'), a runner who slows or collapses, and a
runner a mat missed (those legs are another stretch's: Passes to check and **Missed …: add it** deal with them, and a
made-up time is never judged). On the nine real races on file (2,764 real splits) it marks no real split and both of
the dropped-out runner's.

**Splits that look wrong (advice only).** On race day 2026-10-21 the RR12 stream carried the finish line and cool-down
passes too: a runner who missed a mat had every split column filled (the finish went out as the last split), so the
column check never asked and nothing was missing. Review now compares each runner's legs with the runners nearest in
time at the split before, and lists a split whose leg is far too long (a missed mat: the time is a later split, or the
finish) or far too short (a stray pass), with what it looks like and the runners' time to there: "16:10.8 looks like
4200m, not 3100m (missed 3100m?): 6:45 after 2400m, where runners of the same pace took 7:32." A time that looks like
the finish says it the same way, every split from there on and the runners' time to the finish: "22:27.4 looks like the
finish, not 4200m (missed 4200m, 4400m and 5300m?): 11:27 after 3100m, where runners of the same pace took 11:22." One
click does what it suggests (for a missed mat: **Missed 3100m: add it**, as many splits as the runner's later times
fit); **It's right** silences it. A time you moved yourself is looked at too once a time you type before it makes its
leg look wrong ("You moved 18:07.1 to 4400m, but it looks like 5300m (missed 4400m?): 3:49 after 4200m, where runners
of the same pace took 4:02", after the real 4200m was typed): its one click moves it on; **It's right** keeps your
Move. (Since the column check also takes the finish as a split, most such runners are now held before anything goes
out: this list is for what still went out, a pass you kept from Passes to check, say.) When a leg looks wrong because
of something before it, the list shows that instead, with its fix: a made-up time that doesn't fit, or the first two
mats missed (every time two splits early, which neither check placed: "8:13.9 looks like 2400m, not 800m (missed 800m
and 1500m?)").
Nothing is held: these went out as they are, but a split is not made up from a time that looks wrong until you decide
about it. Its limits: it needs 5 runners of the same pace at both splits; it looks at the first wrong
leg of a runner only (later legs are measured from it); a missed mat between two splits close together (a 200 m
stretch) shows only as the next leg's, so Split Relay then flags the time before that leg ("15:32.0 looks like 4400m,
not 4200m … then 18:41.2 fits 5300m"); walkers and fading runners are far enough from the field to be told apart in
the races measured (DESIGN 9.23 F6, F11).

**All runners.** Review's second view: every runner by split, the runners with something to fix first (held, looks
wrong, missing, the boards out of date), then the rest; **No read lately** lists the runners with no read after a split
for much longer than the field took (they may have dropped out). A missing cell fills in place (**Enter** sends the
suggestion, or type a time); any other cell opens the runner with its choices. Filters: **To fix**, **Changed by you**,
**No read lately**, a bib or name, and the order (problems first, bib, furthest along). A split's header says how many
are missing there, with **Fill…**. On a narrow screen each runner is a card with a square per split. The keys: the
arrows, **Home**/**End**, **PgUp**/**PgDn**, **N** to the next problem.

**Clear race data keeps your Moves.** Clear race data forgets the race's made-up and typed times, but keeps what you
set for passes (Move, Not a split, This is the finish): they apply again when RR12's Replay brings back the very same
reads (a false start's new reads have other times, so nothing applies to them). Fill the missing splits in again
after the Replay. The Clear dialog says so, with the counts.

### Athletes of another race

At the District 11 meet of 2026-10-28 twelve athletes of other races were read while a race ran. Ten of their lines
went to TrackScore and the live results: bib 213 as place 1 at both splits of the next race, 3:34 and 4:43 after its
gun. Every real runner of the two races was one place too low, 348 split places in all. Four more were held with the
wrong story ("missed 1 Mile?"). At the IvyXC meet of 2026-10-31 22 women cooled down over the mats during the men's
race and went out as its runners: 110 runners in the men's merged `.lif` file for 88 men.

**With the start lists loaded** (Races → Load start lists…), a race whose list fits its runners knows three kinds of
bib:

- **On its own list:** as always.
- **On another race's list:** "Not in this race (entered in Boys 2A)". The reads are read, counted and shown, but
  nothing of them goes to TrackScore or the live results or into the merged `.lif` file, and they take nobody's
  place. No alarm: the race tile counts them ("22 not in this race"), the feed says **Not in this race**, and Review
  has a group **Not in this race** with one row per athlete: the race they are entered in and their passes here.
  **Count them here** sends their passes like any runner's (the toast has Undo). Split Relay tells no missed-mat or
  too-fast story about them, and they are no reference for the estimates and checks of the others.
- **On no list** (a late entry, a spare chip): sent as always, with a quiet row in Review under **Not on the start
  list**. **It's right** takes the note away; **Not in this race** takes the runner off the boards.

**Settings → Start lists** has the one setting, "Athletes entered in another race": **Keep them off the boards** (the
default) or **Send and flag**: then they go out like any runner, each with a row under Splits that look wrong ("Bib
213 is entered in Boys 2A: not in this race?") whose one click is **Not in this race**.

**A start list that does not fit does nothing.** A wrong file, another meet's file or a wrong event number must never
silence a race. So a race's list is used only while it fits the runners actually being read: once **five** runners are
through and **fewer than half** of them are on the list, or **three** are through and **none** is, the list is not
used for that race. Everybody is sent as without a list, and Needs attention says "The start list does not match Girls
2A (12 of 40 runners are on it): not used. Check the race's event number, or load the right file (Races tab)." On the
two real meets the right lists had at least 80% of the runners through on them at every moment (four of the first five
in the race where bib 213 crossed first; 88 of 110 at the end of the men's race), a wrong list of the same meet at most
20%, the other meet's files at most 16%. With a wrong list, at most the first two runners' lines wait for the third
runner, a moment. A list **loaded more than 6 days ago** is not used either ("The start list of Girls 2A was loaded 8
days ago: not used"): last week's files, left in the data folder, would fit this week's bibs by their numbers alone.

**Without a start list** (none loaded, or none for the race) nothing is held and every line goes out as before. Split
Relay remembers the day: a bib that ran another race today (a real split at more than half of that race's mats) is
flagged the moment it is read in this one: "Bib 213 ran in Boys 2A today: not in this race?", in Needs attention and
under Splits that look wrong. **Not in this race** takes its lines back, sends the other runners' lines again with
their right places, and keeps its later reads here off the boards; **It's right** silences it. A bib read once in an
earlier race that later runs its own race gets the same flag on the earlier race's line. A pass of such a bib that
the column check holds says who it is, not "missed 1 Mile?", and **Not in this race** is its one click. At a meet
that numbers each race's bibs from 1, more than half of a race's runners would be flagged: Split Relay then says
nothing for that race (load the start lists instead).

What "Not in this race" takes back stays on TrackScore (a packet can't empty a cell); Review says which lines the
boards still show. Outputs has "Send a clearing line when a split is taken back" for a receiver that can blank one.

### Swapped bibs

Two athletes ran with each other's chips: the mats read bib 11 where the athlete of bib 510 runs, and bib 510 where
the athlete of bib 11 runs. FinishLynx has the right bibs, so the splits go to the boards under the wrong one and the
right row of the merged `.lif` file gets none.

**Swapped bibs…** puts it right, before, during or after the races:

- open either runner (the top bar's box, or a bib anywhere) and press **Swapped bibs…**, or press it on the row of
  the bib under **Not in this race** in Review (with start lists loaded that is where the wrong bib shows up), or on
  the Races page under **Swapped bibs**;
- type the other bib: "Bib 11 ran with the chip of bib 510". The dialog says what will happen in each race before
  anything changes: which splits become which bib's, whether they go out, what the boards still show;
- **Swap bibs**.

From then on every read of chip 11 counts for bib 510 and every read of chip 510 for bib 11, in **every race**: the
reads already in and the ones still to come. It is one pair for the whole meet, so the athlete's other race is right
too, and it can be entered before the gun.

What goes out, by the rules of a Resend:

- **An Active race:** the splits go out again under the right bib, and the other runners' lines whose place moved go
  out with them.
- **A runner who has finished:** nothing goes out by itself (TrackScore keeps FinishLynx's place). The splits are in
  the merged `.lif` file at once, and in Review under **Finished: not sent live**: **Send with finish place** sends
  them.
- **A race that is not Active:** nothing is sent; its merged `.lif` file follows by itself.
- **What the boards already show under the wrong bib stays there:** a packet can't empty a cell. The dialog and the
  answer say how many ("The boards still show 5 splits under bib 11"), and the race tile counts them with the cells
  Split Relay can't clear. They stay until the race is cleared on the scoreboard itself; an output with "Send a
  clearing line when a split is taken back" gets one.

The live feed shows such a read under the runner's bib with "read as 11" beneath it, and both runners' pages say
"Swapped bibs: bib 510 ran with the chip of bib 11" with **Remove swap**. The Races page, and Review while there is
one, list the pairs: since when, and who has whose reads in which race.

**Remove swap** asks once, says what changes back, and puts every read back under the bib it came in as. The reads
themselves are never changed: Split Relay keeps each one as RR12 sent it.

What you did to either bib **before** the swap stays with that bib and is not carried over: a moved pass, Not a
split, Stop sending this runner, Not in this race, a typed or made-up time. So after a swap, look at the right
runner once: a split you had filled in for the wrong bib is missing again there (one click in Review), and a time you
had typed for the right bib gives way to the real read of that split ("the typed time 6:48.4 is not used (a real read
replaced it)"). It all comes back if the swap is removed.

A bib can be in one swap at a time. "Start a new meet" forgets the swaps with the old meet's reads; they are not
part of a saved meet setup.

## What the status words mean

| Word | Meaning |
| --- | --- |
| Sent | An output (TrackScore, live results) took it. |
| Holding | First read of this runner at this split. Held for a moment in case the backup mat has an earlier time. |
| Ready: not sent | The split is ready, but no output took it: no output sends this race, every output is switched off, or an output's script can't be loaded (the detail says which). It goes out by itself as soon as an output can take it, unless the runner has finished by then. |
| Corrected | An earlier read arrived after the split was sent. The earlier time won and the split was sent again. |
| Made-up time | A split time Split Relay worked out for a runner a mat missed, sent because you approved it in Review. Sent and in the `.lif` file like a real split; an estimate, not timed. A real read for that split replaces it. |
| Typed time | A split time you typed in Review instead of the estimate. Sent and in the `.lif` file like a real split. A real read for that split replaces it. |
| Finish (not sent) | A read at a finish timing point (SR lines). Recorded, never sent: FinishLynx sends finishes. |
| Finished: not sent live | The runner had finished, so the split was not sent by itself: a finisher's splits go out with the finish place. It is in the merged `.lif` file. Review offers **Send with finish place**. Also a split TrackScore has with an old time (sent before a Move corrected it): "Sent with an old time"; or one sent just after the runner finished, with the split place: "Sent after the runner finished". |
| Split paused | The split is paused (⏸ on its tile). Kept and counted, but not sent and not in the `.lif` file until you press ▶ Play. |
| Check column | The pass looks like it belongs in another split column (the runner probably missed a mat). Held, not sent and not in the `.lif` file, until you choose in Review: Move or Keep. |
| Backup read (filtered) | The same runner at the same split again, usually from the backup mat. The earliest time is kept. |
| Duplicate (ignored) | Exactly the same read again, for example after Replay in RR12. Nothing changes. A read of a race you cleared counts again when RR12 sends it again; the reads of a deleted race stay out of use. |
| Repeat (ignored) | The same runner at the same split again, much later. The first crossing stands. |
| Start area (ignored) | Too soon after the gun (the first 60 s): a runner crossing a mat at the start. Not counted. Change "Ignore reads in the first … s" in Settings if it is a real split. |
| After finish (ignored) | A split read later than the runner's finish, for example walking back over a mat. Not counted. |
| Out of order (ignored) | Not earlier than the runner's time at a later split, for example crossing the 1K mat on the way back. Not counted. |
| Not sending | You stopped sending this runner (Stop sending this runner). The pass is read, counted and shown, but not sent, not in the `.lif` file, and it does not count for the places of the others. "Send this runner again" in the runner takes that back. |
| Counted, not sent | A pass in a split whose **Send** is off on the Races page (a mat a little after a K marker). Counted like any split, so the later passes land in their own splits; never sent, never in the `.lif` file, never waiting. Switch Send on for the split to show it: the other splits' laps to go then change, so set the number of splits in TrackScore and Karmarush and resend. |
| Not in this race | The runner is not in this race: a start list enters them in another race, or you said so in Review. The pass is read, counted and shown, but not sent, not in the `.lif` file, and it does not count for the places of the others. Review lists the runner under Not in this race: **Count them here** sends their splits like any runner's. |
| Not a split | You set this pass aside in Review (a finish, cool-down or stray pass): it is in no column, not sent and not in the `.lif` file. "Let Split Relay count it" in the runner takes that back. |
| Extra pass (ignored) | More passes than this race has splits. Not sent: a split after the last one would go out as laps to go 0, which is the finish. Raise the number of splits if the course has more split passes; if every runner gets one, the exporter probably sends the finish too. |
| Too early for this split (ignored) | The pass came before the earliest race time set for the runner's next split (Races page, Advanced). Not counted. |
| Waiting for gun | The race has no gun time yet. The read is kept and sent when you set it. |
| Before gun | The read is earlier than the gun time, so it does not count. Check the gun time: if you fix it, the read counts. |
| Unmapped | SR lines: the timing point is not one of the race's splits. Add it to a split, and its reads count, the earlier ones too. |
| No race | No Active race takes the read: none reads from the port it came in on (or, with SR lines, lists its contest). Choose the port on an **Active** race (or list the contest), and its reads count there, the earlier ones too. |
| Set aside (not used) | The race that had these reads was deleted, or no longer takes them. They are not used, the new ones neither, until an **Active** race takes them (listed on a race that is not Active, they wait for it). |
| Race paused | The read's race is not Active, so it is not sent. Either the race had the read when you unticked Active (it keeps it), or only races that are not Active take it and it waits for them in no race. Tick Active on the race (or press Switch to), and they are used. |
| Race missing (not used) | The read's race is not in the settings, but nobody deleted it: `config.json` was put back from its backup, or edited. The read waits for it, and so do new reads that no other race takes. Press **Put it back** on the Dashboard, and they come back to it. |
| Race deleted (not used) | The race this read was in was deleted. The read is not used any more, even if you add the race again. |
| Cleared (not used) | The read was in the race when you pressed Clear race data. It is not used any more, wherever the settings would move it. |
| Bad line | Split Relay could not read the line from RR12 (the detail says why). Check the Export Data expression. |

## If something goes wrong

**The races are gone after a restart.**
This copy of Split Relay keeps its data in the folder the Races page names ("This copy of Split Relay keeps its data
in …"). If it isn't the one you used before, you started another copy: close it and start the one you used (its
`start.bat`), or load your meet file, or that copy's `data\config.json`, with **Load meet file…**.

**The fast runners' splits are one column early, the slow runners' are right.**
Two mats are closer together than the tag filter: a fast runner is read at the second one inside the window, and that
pass is merged into the first. The Dashboard says so under Needs attention ("… merged into it by the tag filter").
Set the tag filter (Settings → Tag filter) below the fastest runner's time between the two mats, then press **Resend
splits…** on the race tile when it offers it. See [Splits you collect but don't send](#splits-you-collect-but-dont-send).

**RR12 will not start the exporter, or says it cannot connect.**
Split Relay is not running, or the address or port in RR12 is wrong, or Windows Firewall blocks it. Start Split
Relay, compare the address with the Inputs page, and allow Node.js on private networks in Windows Firewall.

**RR12 says the exporter is connected, but Split Relay says it is not.**
RR12 is connected to something else. A running exporter keeps the address it was started with: after you change its
destination port (for example 5556 to 5565), **Stop** the exporter and start it again. Pause and Resume keep the old
connection. Check that the destination is this PC's address and the port on the Inputs page. (5556 is TrackScore's
clock port: splits sent there never reach Split Relay.)

**"Port 5565 is already in use".**
Another program uses that port, or Split Relay is already running. Close the other program, or choose another port
on the Inputs page and change it in RR12 too.

**The control panel says "Lost connection to Split Relay".**
The black window was closed. Start `start.bat` again. It still has every read it got, and each output gets what it
missed. RR12 keeps its reads while Split Relay is away and sends them when it is back. Reads Split Relay already had
show as Duplicate.

**An output was down, or its script path was wrong.**
Fix it. The splits it missed are sent by themselves as soon as it works. Runners who finished meanwhile are left out.

**Split Relay was closed by force (Task Manager, a crash, a power cut), then started again.**
Nothing is lost. Split Relay can't know whether the splits of the last minute before it stopped reached TrackScore,
so it sends them again. For runners who have finished since, that would replace their finish place, so Review lists
those splits under **Finished: not sent live** instead: press **Send all … with finish place…** to be sure TrackScore
has them. (Ctrl+C in the black window is a clean stop: then nothing needs sending again.)

**TrackScore hung, or was restarted, while splits were going out.**
Nothing to do. When a connection that was up drops (or you press Reconnect), Split Relay sends the splits of the
minute before again once it is connected, because TrackScore may never have read them. A repeated split changes nothing
in TrackScore (same place, same time). Runners who finished meanwhile are left out, and a split that has changed since
goes out as it is now.

**TrackScore shows no splits.** Check the output's light is green. Press Preview packet: it must say Valid JSON. Check
Intermediate splits in TrackScore. If TrackScore watches a results file for the race, it ignores port 5555 and shows
only runners with a place.

**A preview says "Not valid JSON".**
For `XCScore.lss`, sections must be **Results**. Its Started sections are broken in the script itself.

**The splits are in the wrong TrackScore or Karmarush columns.**
The number of splits in TrackScore (Intermediate splits) and in Karmarush must equal the race's number of splits in
Split Relay. After fixing it, resend the race's splits (the race tile offers it). That corrects every split Split Relay
has. A runner who has no split in a column under the new number (one who missed a mat, say) may still show an old time
there until the race is cleared in TrackScore and the live results; the race tile says how many cells and which
runners.

**Every runner gets an "Extra pass".**
The RR12 exporter sends the finish too: it must send the split mats only (A and B). Or the course has more split
passes than the race's number of splits: raise it on the Races page. The earlier reads are worked out again.

**A split mat stopped reading, or reads the wrong runners.**
Press **⏸ Pause** on that split's tile: nothing of it is sent meanwhile, and nothing is lost. When it is fixed (or
you have checked it), press **▶ Play**. For the runners the mat missed, press **Review** on the race tile: each has a
made-up time from their other splits; check them and press **Send all**. If the counting put a runner's later pass in
the missed split's column, Review asks you to check it (**Move to …** or **Keep in …**).

**Two races run at the same time, and one gets nothing.**
Each running race needs its own RR12 port: a second exporter in RR12, filtered to that race, sending to a second port
(Inputs page, Add a port), and that port chosen on the race.

**TrackScore shows splits with no names or schools.**
No names file was loaded (the race tiles say **No names**). Press **Choose names file…** in Needs attention and pick
the meet's `.ppl`. Then press **Send names now** on each race: its splits go again, now with names. Runners who have
finished already have theirs from FinishLynx.

**Names look different in TrackScore after a split.**
Choose FinishLynx's own names file for this meet (Settings → Names file), so Split Relay sends FinishLynx's names,
teams and gender, in FinishLynx's spelling.

**The gun time was wrong.**
Fix it. Every split is worked out again from the new gun time. Splits sent in the last minute are corrected by
themselves; for older ones the race tile offers a resend (see Resend above). Runners who have finished are listed in
Review under **Finished: not sent live**: send them with the finish place. A split that no longer counts with the new
gun time (now before the gun, or in the start area) can't be taken back from TrackScore: the race tile says so.

**A read says "Ready: not sent".**
No output took the split. The detail says why: no output sends this race (tick it in an output's races on the Outputs
page), every output is switched off, or an output's script can't be loaded. It goes out by itself once an output can
take it.

**Pressing Replay in RR12.**
Safe. Reads Split Relay already has show as Duplicate and change nothing. Reads of a race you deleted stay out of use.
Reads you cleared with **Clear race data** count again: clear, then Replay, rebuilds a race (for example after loading
the names file, so every split goes out again with names).

**A race was deleted by mistake.**
Its own reads are no longer used ("Race deleted (not used)"); that can't be undone. Its port (or, with SR lines, its
contests) is set aside, and the Dashboard says "Reads from port 5565 are not used" (or "Reads of '…'"). Press **Add a
race for it** there (or add the race again yourself): the new race reads from that port (or lists those contests).
Give it the same number of splits and set its gun time: the reads that came after the delete, and the new ones, count
there. Next time, untick **Active** (or press **Switch to …**) to stop a race: it keeps its reads.

**A red warning on the Dashboard says a race "isn't in the settings".**
`config.json` was damaged and Split Relay started with `config.json.bak` (the copy from the last start), or the file
was edited while Split Relay was stopped. The race was not deleted: its reads are kept and wait for it ("Race missing
(not used)"), and nothing was sent for them. Press **Put it back** on the warning: the race comes back with the
settings kept in its file in `data\races`, and its reads with it; each output gets only what it is missing. If it
would take the reads of a race that is Active now, it comes back not Active. A damaged `config.json` is kept as
`data\config.broken-….json`: it may have other changes made since the last start. If you don't want the race back,
press **Delete it…** on the warning: like any delete, that takes its reads out of use.

**A red warning says two races were both Active and one was unticked.**
At start Split Relay found two Active races that take the same reads (the same port, the same contest, or both every
contest), for example after `config.json` was put back from a copy. A read can go to only one race, so it kept the first
one Active and unticked the other. If the other one is the race running now, press **Switch to …** on the warning.

**A red warning says a deleted race is back in the settings.**
`config.json` was put back from an older copy that still had a race you deleted. The reads it had when you deleted it
stay out of use; only its reads from now on count. Press **Keep it** if it should be there, or **Delete it again…**.

**Needs attention says "The start list does not match … not used".**
The list loaded for that race's event number is not that race's field: the wrong file, another meet's file, or the
race's event number differs from the file's. Nothing is kept off the boards by it. Check the race's event number
(Races page), or load the right entry file: the Races page lists each race with its file and count.

**An athlete of another race shows on the boards.**
Without start lists Split Relay can only flag them once they have run their own race ("Bib 213 ran in Boys 2A today:
not in this race?"): press **Not in this race** on the row in Review. Load the meet's entry files (Races → Load start
lists…) and they are kept off by themselves. A line that went out stays on TrackScore: a packet can't empty a cell.

**A runner who does run this race is listed under "Not in this race".**
The start list enters them in another race (a late change of race). Press **Count them here** on the row: their
splits go out like any runner's.

**A runner's later splits are all one column early (a mat missed them).**
Open the runner (**B**, the bib, **Enter**). Review's **Splits that look wrong** usually points at the first wrong
time already: press its **Move to …**. The later times move with it; then the missed split is empty with a suggested
time: **Enter** sends it. TrackScore gets each moved split in its new column, and the runner's furthest split last.

**A runner's finish went out as their last split** (the RR12 exporter sends the finish mat too, and there are no
FinishLynx finishes). Open the runner, and on that time choose **This is the finish** (or **Not a split** for a
cool-down pass). Turn on merged `.lif` files so Split Relay knows who has finished: a split sent to a runner who has
finished replaces their place in TrackScore.

**TrackScore still shows a time in a split I emptied (a Move, Not a split, an Undo).**
A split packet can fill a cell but never empty one. Fill that split (its suggested time replaces the old cell), or
clear the race in TrackScore. The runner editor shows such a cell as "TrackScore: 16:10.8".

**Undo says the runner was changed after this.**
Only the runner's newest change can be undone (another window, or a later change of yours, came after it). Undo that
one first, or change the runner by hand.

## Where things are kept

Everything is in the `data` folder next to `start.bat`:

- `data\config.json`: the settings, races and outputs. `config.json.bak` is the copy from the last start. If
  `config.json` is ever damaged, Split Relay uses the copy and keeps the damaged file as `config.broken-....json`.
- `data\reads.jsonl`: every read RR12 sent, in order, saved the moment it arrived, with the port it came in on, and
  every Review decision (made-up and typed times, removals, Move and Keep). Split Relay rebuilds the races from it when
  it starts, so a restart keeps them all. Do not delete it during a meet.
- `data\races\`: each race's settings and what each output has received from it, so a restart sends only what is
  missing. A race that is gone from `config.json` without being deleted keeps its file here (that is what **Put it
  back** uses); a deleted race's file goes to `data\races\deleted`.
- `data\startlists.json`: the start lists you loaded: the bibs of each event and the file each came from. No names.
  **Start a new meet** moves it into the copy in `data\archive`.
- `data\meets\`: meet files from **Save meet setup** (an older copy of the same meet goes to `data\meets\old`), and in
  `before-load\` the setup as it was before each load.
- `data\archive\<date-time>\`: the copies **Start a new meet** makes of the data folder. Nothing reads them.
- `data\update\backup\`: the program files of the version before the last update. Split Relay puts them back by
  itself if an update does not start. Nothing else reads them.
- `data\logs\YYYY-MM-DD.log`: one log file per day. It has every line received from RR12 (with the time, the port and
  the connection), what Split Relay did with each read, every packet sent to each output, every refused packet, and
  every error. Use it to answer "what did RR12 send for bib 254, and what went to TrackScore?".

Reads stay until you press **Clear race data** or delete their race. Those reads are then no longer used (a Replay in
RR12 after a clear sends the race again, and its reads count again); new reads count as usual. For a new meet, press
**Settings → Meet setup → Start a new meet…**: every read of the last meet is put away (kept in `reads.jsonl`, out of
use), every gun time and Pause is cleared, and a copy of the data folder goes to `data\archive`. The races, outputs and
settings stay. It is refused while a race is running (Active with its gun, from the gun until 30 minutes after it, or
while its reads keep coming): the button then says which race. A gun left from an earlier day does not count.

## Watching from another computer

On the Settings page, under Control panel, tick **Let other computers on the network open this page**. Other PCs can
then open `http://<Split Relay PC address>:5590/` and watch. They cannot change anything; changes are only accepted on
the Split Relay PC itself.

## Command line

`start.bat` passes its options on to Split Relay:

```
start.bat [--data <folder>] [--port <panel port>] [--no-open]
```

- `--data <folder>`: keep settings, races and logs in another folder.
- `--port <number>`: use another control panel port for this run.
- `--no-open`: do not open the browser.

For developers: `node --test` runs the tests. DESIGN.md describes how Split Relay works inside.
