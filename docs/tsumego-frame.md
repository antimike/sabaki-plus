# The hidden tsumego frame and its komi

How `src/modules/tsumegoframe.js` builds the frame and balances the framed game.
The decisions behind it (hidden frame, window, attacker, balance) are `baduk` D5
and its 2026-11-20 addendum; this file explains the mechanism and the
measurements that set its constants.

## Why a frame

A tsumego shows a corner or side of an otherwise empty board. Sent to an engine
as it is, the empty board is worth far more than the problem, and the engine
plays big points elsewhere. The frame fills the rest of the board with settled
territory and sets komi so that **whoever wins the local fight wins the game**.
The engine then values exactly the local result.

## Layout

The frame is laid out by Chebyshev distance `d` from the window (the problem's
stones plus a margin, grown to cover `VW`):

| d   | Name      | Contents                                                           |
| --- | --------- | ------------------------------------------------------------------ |
| 0   | window    | the problem; never changed                                         |
| 1   | gap       | always empty, so frame stones never touch the problem              |
| 2–4 | wall      | attacker stones, three lines thick so they hold eyes               |
| ≥ 5 | territory | split: the farthest part to the defender, the rest to the attacker |

Frame groups get eyes on a fixed lattice; a group left with fewer than two is
given to the other colour or removed. Stones outside the window (context stones)
are kept, with the points around them left empty.

The window is also what the board shows and where the engine may play (`allow`).
`sabaki.getProblemFrame` builds the frame once per game tree, and both the
analysis and the board crop (`MainView` → `Goban`'s `cropWindow`) read its
window, so the two cannot drift. Without a frame (none applies, or whole-board
analysis is on) the board falls back to the plain `VW` crop.

## Controls and Show Frame (kata tfg1)

Engines → Tsumego Frame holds the frame's controls:

- **Whole-Board Analysis**: no frame and no `allow` restriction; a saved
  setting.
- **Attacker**: Auto, Black or White. Auto names what inference chose and from
  where, e.g. "Auto (Black, from text)". A choice applies to the current game
  only, is keyed by its root node id (stable across edits), and lasts for the
  session; saving it in the SGF is kata y3sr. Frames are cached per tree and
  attacker (`sabaki.buildProblemFrame`).
- **Show Frame**: a session toggle, off at start. The board shows uncropped, the
  frame applied to the current position appears as large pale ghost stones, and
  the points outside the window are shaded. Use it to tell a bad frame from a
  bad problem; normal use never draws the frame (D5). Not in guess mode.

- **Ko Threats for Black / White**: 0 to 3 each, per game and per session like
  the attacker. When fewer fit than asked, the checked item says so, e.g. "2 (1
  placed)". See [Ko threats](#ko-threats-kata-899v).

## Balance: where komi comes from

Under area scoring every point of a finished board belongs to one side (neutral
points aside). Two outcomes matter:

- **Alive:** the defender lives, owning `L` points of the window (its stones and
  eyes). The attacker owns the rest of the window.
- **Dead:** the attacker owns the whole window.

The frame is balanced when the game is even at the **midpoint** between the two:
then a defender that lives wins by about as much as a dead one loses by. At the
midpoint the defender owns, on average, `L/2` points of the window.

Let `N` be the number of points on the board and `D` the defender's area outside
the window (its frame stones and eyes, plus its context stones). Everything else
outside the window, **the gap included**, is the attacker's: the gap borders
only the attacker's wall on one side and, once the fight is settled, the
attacker's surrounding stones on the other. So at the midpoint:

- defender: `D + L/2`
- attacker: `N − D − L/2`
- defender minus attacker: `2D + L − N`

KataGo scores Black's area minus White's minus komi. Setting that to zero at the
midpoint gives komi = Black area − White area there:

```
komi = floor(defender × (2D + L − N)) + 0.5        (defender: 1 Black, −1 White)
```

The `+ 0.5` makes komi a half point so no result is a draw. The real outcomes
sit about `L` points either side of the midpoint, so the half point never
decides one.

The **territory split** uses the same count in reverse: it gives the defender
`(N − L)/2` points of territory beyond the wall (less its context stones), so
that `2D + L − N` and with it komi come out near zero. Komi only takes up what
the split cannot place.

### The bug this replaced (kata cgbq)

The first model counted the window and the frame zones but **not the gap**, and
assumed a living group owns `2 × stones` of the window. The gap is 13–48 points;
KataGo gives all of it to the attacker in both outcomes. The model's two areas
did not add up to `N`, and every frame tilted toward the attacker by roughly the
gap's size: a defender that lived still lost (straight three in the corner: lead
−6.3 with the vital point played).

## Living area `L`

`estimateLivingArea` counts, inside the window:

- the defender's stones, plus
- its **eye space**: regions of non-defender points (empty or attacker stones)
  that defender stones and the board edge cut off from the open side of the
  window,
- with at least **3** points of eye space assumed (`MIN_EYE_SPACE`): the
  smallest group that lives adds a stone on the vital point and has two eyes.
  The floor covers problems whose eye space is still open, which is most of them
  before the first move.

How exact `L` must be: an estimate `k` points off moves the midpoint by `k`
points, and each outcome sits about `L` from the midpoint. The winner only flips
when the estimate is off by about the group's whole living area.

What the count cannot see:

- **Dame.** Neutral points in the alive outcome belong to nobody, which moves
  the true midpoint by half their number.
- **Seki.** Under area scoring a defender in seki keeps its stones `S`, but not
  the shared liberties. With the floor, the threshold is `(S + 3)/2`, so a seki
  group of more than three stones still lands on the defender's side.
- **Ko.** The outcome depends on ko threats, which the frame handles separately
  (D5 addendum: a set number of ko threats per side), not through komi. See
  [Ko threats](#ko-threats-kata-899v).

### Engine-based estimate (not built)

KataGo can measure `L` directly: query the framed problem start with the
defender to play and the attacker passing once (the defender's best case), with
ownership on, and count the window's defender-owned points. That sees dame
(ownership near 0) and seki or ko (fractional ownership). Its costs: the frame's
komi would need an engine round trip before analysis starts, which
`getTsumegoFrame` (synchronous, engine-free) cannot do; engines without
ownership output still need the count above; and a short search is noisy. It is
planned for later, with the result cached per problem (`baduk` kata 4hv5).

## Ko threats (kata 899v)

Without threats, a ko in the window goes to whoever takes it first: on Cho
Intermediate 0505 KataGo gives the defender 99% if it may retake and 0% if not.
`getTsumegoFrame(..., {koThreats: {B, W}})` builds up to three threats per
colour into the frame.

**Shape.** A threat for side T is a group of T's opponent against a board edge,
inside T's own zone, ringed by T's stones, whose only liberties are a straight
four on the edge line:

```
. . . . . . . .      x  threatener (T)
x x x x x x x x      o  threatened group
x o o o o o o x
x o o o o o o x      T plays inside the four (say the second point);
x o . . . . o x      the answer, next to it, leaves two eyes.
```

Playing inside the four threatens to kill; the answer leaves the group alive, so
a played and answered threat does not change the score (KataGo: 0505 with the
threat spent first scores −9.7 against −10.3 without it). The group is a
rectangle 6 to 10 points along the edge and at least 3 deep, with area (stones
plus the four) at least `L + 10` (`KO_THREAT_MARGIN`): ignoring a threat must
cost more than the ko. An ignored threat swings the score by twice its area. On
0505 the ko swings it by about 29 (alive +19.1, dead −10.3), more than `2L` = 20
because `L` runs low there (10 against about 15). The first margin, `L + 6`,
gave 18 points, a swing of 36, and with one threat each KataGo found the threat
and the ko nearly equal. `L + 10` gives 21 points, a swing of 42. Across the
2,553 Cho problems that get a frame, one threat per side fits in 91% of them at
`L + 10` (90% at `L + 6`). The size is static; the engine-based `L` (4hv5) would
refine it. Sizing threats by how many are asked for (one large threat, or
several smaller ones sharing a fixed total) was considered and rejected: each
threat must outweigh the ko on its own, so shrinking threats as their number
grows would stop them being threats.

**Placement.** Rectangle and ring lie in T's zone beyond the wall, not in a
corner, at least three lines from other threats, and every frame group around
them must keep two eyes. The defender's threats go as far from the window as
possible, in its territory. The attacker's zone beyond the wall is narrow (the
defender gets the far side), so attacker threats are reserved first, next to the
wall, with the ring allowed on the wall's last line so it joins the living wall.
Threats alternate between the colours until each has its count or no site is
left; the result reports `koThreats` (placed per colour) and `koThreatVertices`
(the eye points). Asking for two per side rarely places all four: there is
seldom room for a second attacker threat next to the wall.

**Side groups only.** Threat groups are never placed in a board corner: every
threat is a side group, with the threatener's stones closing both ends, because
that is the shape tested with KataGo. A corner version (the group touching two
edges) very likely works too, since a straight four lives anywhere and the group
has no outside liberties either way, but it is untested. The cost is room:
corners are often the points farthest from the window. Re-evaluate this when
KataGo is used to evaluate ko fights precisely (the engine-based `L`, kata
4hv5): test the corner shape then and allow it if it holds.

**Balance.** A threat group counts as its owner's area: a defender threat puts
attacker area into the defender's territory, so the defender's share grows by
the group's area before the split, and an attacker threat shrinks it. When fewer
threats fit than asked, the frame is built again for the number placed, and the
build with the smaller komi wins. A changed share can end partway down a
one-line strip along the edge, where the attacker's rest of the strip cannot
live and is removed; komi counts the empty points that only defender stones
surround as the defender's (this case predates ko threats, but they made it
common: 16 points off on 0505 before the fix).

**Engine.** The eye points join both `allow` lists, so threats can be played and
answered at any depth. Candidates outside the window are still dropped from the
heatmap, but the winrate and score shown are taken over every candidate, so they
stay right when the best move is a threat or a pass. Until mcms the parser
dropped pass candidates (as upstream does), so a best pass was missed; under a
frame it now keeps them.

**Ko threat and Tenuki strip (kata mcms).** The cropped board cannot show a
frame threat or a pass, so while an engine analyses a framed problem with
analysis shown, a strip under the board lists them: the best threat by visits as
"Ko threat" and the pass as "Tenuki", each with win rate and score
(`foldOffWindowAnalysis`). They are listed whenever the engine reports them,
like heatmap cells, so their presence gives nothing away that turning analysis
on does not; the one with the most visits of all candidates is highlighted. The
strip keeps its room for the whole analysis so the board does not jump, and it
follows the analysis toggle, in guess mode too (as the heatmap does). Answering
a tenuki problem in guess mode is kata 8mf0; playing a threat from the board,
758v.

Validation (2026-11-21, b10c384h6nbttflrs, 3000 visits, frame komi, area rules,
margin `L + 10`; Cho problems, defender's win rate at the problem start):

| problem               | ko for    | none | B 1  | W 1 | B 1, W 1 | B 2, W 1 |
| --------------------- | --------- | ---- | ---- | --- | -------- | -------- |
| Intermediate 0505     | B to live | 0%   | 98%  | 0%  | 0%       | 97%      |
| Elementary 0299, 0319 | B to kill | 100% | 0–1% |     |          |          |
| Elementary 0565       | B to kill | 99%  | 0%   |     |          |          |

With one threat the book answer becomes KataGo's best move in each; with equal
threats the side that takes the ko first wins, as it should. Elementary 0305 was
inconclusive: its frame is about 27 points off before any ko (kata v2s9). On
0505 threats leave the alive–dead midpoint where it was (+4.2 against +4.3). At
`L + 6` the results were the same except for one threat each on 0505: Black then
gave up White's threat group to finish the ko and lost by 3.6. At `L + 10` it
answers the threat and loses the ko, by 9.7.

## When there is no frame

`getTsumegoFrame` returns `null`, and analysis runs on the whole board, when:

- the window has no stones, or covers more than half the board
  (`MAX_WINDOW_SHARE`), or
- balancing would take a komi above `MAX_KOMI` (250). This catches centre
  problems, where the three-line wall reaches the board edges and the defender's
  territory shrinks to one-line strips that cannot hold eyes (kata xw69 tracks a
  layout that fixes this).

## Calibration

`scripts/frame-calibration/` checks the model against KataGo. For written
positions (a straight-three eye space whose vital point decides life, in the
corner, on the side and in the centre, small and large, both colours, plus a
13×13 board), it builds the frame and asks KataGo's analysis engine for the
score of the alive and dead outcomes under the frame's komi and area rules. The
midpoint of the two is the **error**; zero is perfect.

```
npx tsx scripts/frame-calibration/calibrate.js [--max-komi Infinity] [--case NAME]
```

Results on 2026-11-20 (b10c384h6nbttflrs network, 500 visits, Black defending;
White defending agrees within about 1 point), with the komi limit lifted to show
every case:

| case         | window | komi   | alive | dead  | error, old model | error |
| ------------ | ------ | ------ | ----- | ----- | ---------------- | ----- |
| corner-small | 35     | 1.5    | +6.5  | −6.8  | −13.7            | −0.1  |
| corner-large | 66     | 1.5    | +21.8 | −24.2 | −36.4            | −1.2  |
| corner-wide  | 110    | −50.5  | +6.6  | −8.1  |                  | −0.7  |
| corner-wider | 169    | −208.5 | +7.3  | −7.5  |                  | −0.1  |
| corner-13x13 | 35     | −20.5  | +7.3  | −7.6  |                  | −0.1  |
| side-small   | 55     | 1.5    | +8.0  | −9.3  | −26.2            | −0.7  |
| side-large   | 114    | 0.5    | +38.1 | −40.5 | −53.6            | −1.2  |
| centre-small | 99     | −345.5 | +12.4 | −3.7  | −42.5            | +4.4  |
| centre-large | 121    | −335.5 | +19.8 | −3.1  | −58.1            | +8.4  |

Corner and side cases are balanced to within about a point, even where komi
carries most of the balance (up to ±209). The centre cases are not: the
alive–dead gap is compressed (16 where about 30 is expected) and, with White
defending, a dead centre-small defender still wins. Whether that comes from the
komi's size or from a frame that leaves the defender no territory, these cases
cannot tell apart; `MAX_KOMI` sits between the last good komi (209) and the
first bad one (335).

The mocha tests (`test/tsumegoFrameTests.js`) check the same balance without an
engine, by area-scoring the framed alive and dead outcomes.

## First-move check (kata 24ys)

`scripts/frame-calibration/firstmove.js` checks the frame and the window
restriction against real problems: for each one it asks KataGo for its best move
from the problem start, framed and restricted as the app does it (frame komi,
area rules, `allow` lists for both players), and compares it with the problem's
SOL first moves. The script's header has the method; problems are read from the
sanderland checkout at run time and never committed.

- **Sample:** sanderland life-and-death tiers 1a–1d, 50 problems each (seed 1,
  at least 5 per author, the rest in proportion; non-19×19 problems and "Backup
  solution detector" answers left out).
- **Engine:** b10c384h6nbttflrs at 2000 visits, failures rerun at 10000.
- **PASS:** the top move is a SOL move and the side to play wins. **ALT:** the
  top move is not a SOL move, but it and the SOL move both win. **FAIL:**
  anything else. A first run without the "wins" condition scored a wrong frame
  as PASS whenever the book move topped a lost search (Ishigure 001: attacker
  guessed Black, White ahead by 84).
- **Control:** the same search with no frame and no restriction. "Frame hurt"
  counts problems that pass the control and fail framed.

Run of 2026-11-21:

| tier | n   | PASS | ALT | FAIL | FAIL on SOL | control PASS | frame hurt |
| ---- | --- | ---- | --- | ---- | ----------- | ------------ | ---------- |
| 1a   | 50  | 36   | 7   | 7    | 7           | 31           | 4          |
| 1b   | 50  | 34   | 6   | 10   | 4           | 34           | 6          |
| 1c   | 50  | 39   | 7   | 4    | 1           | 24           | 2          |
| 1d   | 50  | 33   | 3   | 14   | 2           | 32           | 8          |
| all  | 200 | 142  | 23  | 35   | 14          | 121          | 20         |

"FAIL on SOL": the top move is a SOL move but the side to play loses. The frame
turns 121 control passes into 165 (PASS or ALT). Each FAIL's cause is the first
one-change rerun that makes it pass:

| cause          | n   | rerun                                                 |
| -------------- | --- | ----------------------------------------------------- |
| attacker       | 22  | attacker flipped (kata v2s9)                          |
| ko             | 1   | one frame ko threat for the defender                  |
| depth          | 0   | 10000 visits                                          |
| frame          | 12  | none of the above passes; all `engine-dead` on rerun  |
| outside-window | 0   | also 0 over the whole 19×19 corpus (`--window-check`) |
| no-frame       | 0   |                                                       |

- **The split is not stable.** Every FAIL of the first run failed again, but the
  causes of 5 moved: 4 were `attacker` in the first run and `frame` here (the
  flipped-attacker rerun is borderline for them), and Maeda 1k-1d 117 passed the
  ko rerun once. Read the causes as attacker 22–26, frame 7–12.
- **Attacker.** All 200 attackers come from the stones (no problem text says
  "kill" or "live"). The guess is the side to play in 139 problems, and 21 of
  the 22 attacker failures are among them (15%); in the other 61 there is one.
  The usual case is a Black-to-live problem guessed as Black attacking, lost for
  Black by 15 to 110 points whatever it plays. Other stones rules did worse on
  the 187 problems whose attacker the run settles (165 right now): the share of
  stones touching the open outside 131 right of 171 decided, the largest
  enclosed group 64 of 91, the farthest stone from the edge 145 of 171; and no
  threshold on the current rule's margin helps, since problems where the side to
  play defends reach margins up to 0.90, inside the range of those where it
  attacks. What does tell them apart is the side to play's win rate at the
  start: at least 0.3 in all 165 right guesses, below 0.3 in 20 of the 22 wrong
  ones (kata v2s9).

### Engine check of the attacker (baduk D10)

The app checks a stones guess with the engine (`chooseAttacker`, `AUTO_ATTACKER`
in `tsumegoframe.js`; `checkAutoAttacker` in `sabaki.js`): at 500 visits from
the problem start, a side to play below 0.3 has the flipped frame analysed, and
the flip is kept if the side to play reaches 0.3 with it. Otherwise the guess
stays and the menu warns that the side to play loses with either attacker.

Validation on a fresh sample (seed 2, 200 problems, 14 shared with the first;
b10, `--auto-attacker`, 2026-11-22): 153 PASS, 36 ALT, 11 FAIL, against 142, 23
and 35 for the first sample with the stones guess.

- **24 flips, all PASS or ALT.** Each had the side to play at 0.08 or less with
  the guess and 0.77 or more with the flip; no flip landed between.
- **9 warnings, all FAILs:** 5 `engine-dead`, 2 `ko`, 2 `frame`.
- **2 FAILs unflagged:** Maeda 1k-5k 167 and Hashimoto MTAP Elementary 038
  (`frame`, win 0.65).
- **167 is not a wrong guess** (checked by hand, 5000 visits): Black surrounds
  White's corner group, so the guess (Black attacking) is right; KataGo kills
  with S19, while the book's S15 lets White live (+18.4). It is labelled
  `attacker` only because the flipped frame makes Black a defender whose outer
  wall lives anyway, so any reasonable move wins. The `attacker` rerun is
  therefore not proof of a wrong guess when the side to play wins with the guess
  at the start. The first sample's two such cases (Maeda 1k-5k 184, Hashimoto
  Fifty Three To Go 006: the top move wins, the SOL move loses, the flip passes)
  have the same signature and are not checked; so "20 of 22" above may be 20
  of 20.
- **Frame: the engine, not the frame (kata 9ds2).** These fail with either
  attacker, a ko threat and 10000 visits. Framed with the side to play
  defending, all 12 score the defender's lead after the SOL move at -L within
  1.9 points (L the living-area estimate; Maeda 10k-5k 123: -13.6 with L 13).
  That is the frame's score for "defender dead", so the balance is right and
  KataGo reads the group as dead after the book move, framed and unframed (123:
  W Q1 kills against every Black reply; Maeda 1k-5k 013: T18 T17 S17 T19). When
  the defender does live, it leads (123 after Q2 T3 R1: +20.6). The "lost by 40
  to 96" cases were the wrong attacker on top (123 with Black attacking: -96).
  The harness now names these `engine-dead` (`deadAfterSol` in `firstmove.js`).
  Two defender ko threats seem to pass 013, but that is search noise: W picks
  S15 for +20 while T17 still kills at -12.8.
- **Stronger network.** Rerun with kata1-tf3-b11c768-s12382M (the strongest
  confidently rated network, 2026-11-22; 1.6× b10's time per visit on the
  T1000): 10 of the 12 are `engine-dead` again, so b10's reading is not the
  cause; the books' answers are probably ko or seki lines the sanderland files
  do not mark. Two differ: Fujisawa Intermediate 45 scores -10.7 with L 22,
  about -L/2, the defender living small (a seki-like result the frame counts as
  a loss); Hashimoto MTAP Elementary 036 scores -19.7 with L 15, 4.7 below
  "dead", so the defender loses more than the window there.
- **Ko.** Yamada Basic 1006 passes with one ko threat for the defender (b10),
  and with none under tf3.

### Ownership as an attacker signal (kata 8ar0, not adopted)

**Decision (MH, 2026-11-23): not adopted; D10 stays.** The hybrid below would
only relabel problems that fail anyway and already carry D10's warning. The
signal is kept in the harness for quiz mode's status reading (kata tb1s).

A candidate to replace or extend D10 (`firstmove.js --own-attacker`,
`ownAttacker`): search the problem start twice at 500 visits, once with the side
to play moving first and once with it passing first, and read KataGo's ownership
of the window's stones. A colour's loss is how many of its window stones the
other colour owns, summed over both orders; the colour that loses more is the
defender. Under a one-stone margin the stones guess stays. Unlike D10 it does
not need the side to play to win, so it still answers when the engine reads the
book move as failing.

**Which position.** `--own-frame` tried three, on both samples with
`--signal-only`:

- `none`, the bare problem with komi 0 and both players kept to the window: the
  net reads the attacker's outer stones as weak (the whole empty board is around
  them) and the inside group as able to escape.
- `flip`, the frame of the other attacker: worst (under 270 of the 374 settled,
  against 334 for `guess`).
- `guess`, the stones guess's frame: best, so the numbers below use it. Starting
  from a frame does tilt the reading toward its attacker, but this had the
  fewest misses.

**Against D10** (b10, 2026-11-22; seed 1 and seed 2, 200 problems each; D10
recomputed in the same runs). "Settled": the attacker a judged run confirms (a
PASS or ALT, or a FAIL whose `attacker` rerun passes). "Engine-dead":
`engine-dead` and `frame` FAILs, counted right when the side to play defends,
the 9ds2 reading. "Hand": `baduk/private-tests` (Maeda 1k-5k 167 and 013,
Ishigure Basic 104, Maeda 10k-5k 123, Cho Elementary 0340).

| attacker right      | n   | stones guess | D10 | ownership (`guess`) | ownership (`none`) | hybrid |
| ------------------- | --- | ------------ | --- | ------------------- | ------------------ | ------ |
| settled, seed 1     | 185 | 165          | 183 | 163                 | 158                | 183    |
| settled, seed 2     | 189 | 165          | 189 | 171                 | 168                | 189    |
| engine-dead, seed 1 | 12  | 5            | 6   | 9                   | 8                  | 10     |
| engine-dead, seed 2 | 8   | 5            | 5   | 8                   | 8                  | 8      |
| hand                | 5   | 2            | 3   | 5                   | 5                  | 5      |

The hand row overlaps the others (123, 0340 and 013 are engine-dead in seed 1).
"Hybrid": D10 as it is, with ownership deciding only when D10 warns (the side to
play loses with either attacker), i.e. 2 more searches for about 5% of problems.

- **Ownership alone is worse where the answer is known.** It disagrees with D10
  on 48 of the 400 problems. Judged with the ownership attacker (2000 visits),
  17 pass, and D10 passes all of them too (either attacker works). 23 fail where
  D10 passes or gets an ALT, and in 8 both fail. Typical miss: Black to play,
  D10 flips to White attacking, and ownership has White's window stones lost in
  both orders (Ishigure Basic 084: White 6.2 and 3.7 stones, Black 0.1 and 0.2).
  The signal answers "whose stones are at stake", but the frame needs "whose
  wall surrounds the window". In these problems the defender lives by capturing
  attacker stones. This explanation is a hypothesis: the misses have not been
  checked one by one.
- **It does fix the engine-dead attackers.** In 7 of the 21 problems where D10
  warns (12 in seed 1, 9 in seed 2), ownership picks the colour the 9ds2 reading
  supports where D10 keeps the wrong guess: Maeda 10k-5k 123, Cho 0340, Maeda
  Newly Selected 089, Maeda 1k-1d 117, Ishigure Shodan 013, and Enjoy 010 and
  015 (margins 1.3 to 21). None of them passes afterwards: they stay
  `engine-dead` (117: `ko`), now with the right attacker. Ownership is wrong on
  MTAP Elementary 036, and Fujisawa Intermediate 45 is a tie (margin 0.01), so
  both keep the guess.
- **The 167 signature.** Maeda 1k-5k 184 and Fifty Three To Go 006 (the top move
  wins, the SOL move loses, the flip passes) keep the stones guess under
  ownership too (margins 5.1 and -12.8), as do D10 and the hand check of 167.
  That supports, but does not prove, reading "20 of 22" above as 20 of 20; a
  hand check of the two would settle it.
- **Private e2e** (`--project=private-problems`, b10): 12 pass, and 123 and Cho
  0340 are the expected failures, still under D10. The harness reading of the
  five problems is right for ownership and the hybrid (5 of 5) and wrong for D10
  on those two. The app does not have the ownership rule, so the expected
  failures stay until it is built.

The run's per-problem results stay in `scripts/frame-calibration/results/`
(gitignored); `firstmove.js --summary FILE` reprints these tables from one.
