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

Ko threats per side get their control with the frame option (kata 899v).

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
  (D5 addendum: a set number of ko threats per side), not through komi.

### Engine-based estimate (not built)

KataGo can measure `L` directly: query the framed problem start with the
defender to play and the attacker passing once (the defender's best case), with
ownership on, and count the window's defender-owned points. That sees dame
(ownership near 0) and seki or ko (fractional ownership). Its costs: the frame's
komi would need an engine round trip before analysis starts, which
`getTsumegoFrame` (synchronous, engine-free) cannot do; engines without
ownership output still need the count above; and a short search is noisy. It is
planned for later, with the result cached per problem (`baduk` kata 4hv5).

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
