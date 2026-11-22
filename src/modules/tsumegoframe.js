// Hidden tsumego frame (baduk D5 and its 2026-11-20 addendum).
//
// A tsumego shows only part of the board. Sent to an engine as it is, the empty
// rest of the board matters more than the problem, so the engine plays big
// points elsewhere. The frame fills the rest of the board with settled
// territory, split so that whoever wins the local fight wins the game. The
// frame goes only into the position sent to the engine; it is never drawn in
// normal use.
//
// Written from the general idea of a tsumego frame, without reference to
// KaTrain's or LizGoban's implementation.
//
// Layout, by Chebyshev distance d from the window box W:
//
//   d = 0      the window: problem stones, never changed
//   d = 1      the gap: always empty, so frame stones never touch the problem
//   d = 2..4   the wall: attacker stones, three lines thick so it has eyes
//   d >= 5     territory: the farthest part goes to the defender, the rest
//              to the attacker
//
// Context stones (stones outside the window, "play as if White has stones
// nearby") are kept, and the points next to them stay empty. Every frame block
// gets empty points on a lattice as eyes; a frame group that still ends up
// with fewer than two eyes is given to the other colour, and failing that,
// removed. Komi is set from area counts so that the game is even at the
// midpoint between "the defender lives" and "the defender dies". The komi
// model and its calibration against KataGo: docs/tsumego-frame.md.
//
// Ko threats (option koThreats): a threat for side T is a group of T's
// opponent on the board edge, inside T's own zone, whose only liberties are a
// straight four of eye space on the edge. Playing inside the eye space
// threatens to kill it; the answer leaves it alive, so the exchange does not
// change the score. Its points count as the opponent's area.

const WALL_END = 4 // last wall line, as a distance from the window
const MIN_DEFENDER_BLOCK = 12 // smaller defender territory is not worth a block
const MAX_WINDOW_SHARE = 0.5 // no frame if the window covers more of the board
const MIN_EYE_SPACE = 3 // a stone on the vital point plus two eyes
// No frame if balancing it takes a larger komi. KataGo scored the calibration
// cases accurately up to komi 209 (a 13x13 window in a 19x19 corner) and
// wrongly at 335 and more (centre windows, where the defender gets no
// territory); see scripts/frame-calibration.
const MAX_KOMI = 250
// Ko threats (baduk 899v): a threat's group must be worth more than the local
// fight. Its area (stones plus eye space) is at least the living area plus
// this margin. L runs low (Cho Intermediate 0505: estimate 10, about 15 from
// KataGo's scores), and an 18-point threat there outweighed the ko by only
// about 7 points; L + 10 gives 21 points, worth 42 against a ko of about 29.
const KO_THREAT_MARGIN = 10
const KO_THREAT_MIN_DEPTH = 3 // rows, as in the tested shape
const KO_THREAT_MAX_WIDTH = 10
const KO_THREAT_MAX = 3

/**
 * Infer the attacker from a problem's text, e.g. "Black to live" or
 * "White to play and kill". Returns 1 (Black), -1 (White) or null.
 *
 * @param {string} text - problem comment and/or game name
 * @param {number} [toPlay] - 1 or -1, used when the text names no colour
 */
export function inferAttackerFromText(text, toPlay = 0) {
  if (typeof text !== 'string' || text.trim() === '') return null

  let live = '(?:live|lives|living|survive|escape|make life|be alive)'
  let kill = '(?:kill|kills|capture|captures|dead)'
  let colored = new RegExp(
    `\\b(black|white)\\b[^.!?\\n]{0,30}?\\b(?:(${live})|(${kill}))\\b`,
    'i',
  )
  let match = text.match(colored)

  if (match != null) {
    let color = match[1].toLowerCase() === 'black' ? 1 : -1
    return match[2] != null ? -color : color
  }

  if (toPlay !== 1 && toPlay !== -1) return null

  if (new RegExp(`\\b${live}\\b`, 'i').test(text)) return -toPlay
  if (new RegExp(`\\b${kill}\\b`, 'i').test(text)) return toPlay

  return null
}

/**
 * Guess the attacker from the stones alone: the colour whose stones sit
 * farther from the board edges is taken to be surrounding the other.
 * Returns 1 or -1; White on a tie.
 *
 * @param {number[][]} signMap
 * @param {Array<[number, number]>} vertices - the problem's stones
 */
export function guessAttacker(signMap, vertices) {
  let height = signMap.length
  let width = signMap[0].length
  let sums = {1: 0, '-1': 0}
  let counts = {1: 0, '-1': 0}

  for (let [x, y] of vertices) {
    let sign = signMap[y][x]
    if (sign === 0) continue

    sums[sign] += Math.min(x, y, width - 1 - x, height - 1 - y)
    counts[sign]++
  }

  if (counts[1] === 0 && counts[-1] === 0) return -1
  if (counts[1] === 0) return 1
  if (counts[-1] === 0) return -1

  let black = sums[1] / counts[1]
  let white = sums[-1] / counts[-1]

  return black > white ? 1 : -1
}

// Engine check of a stones guess (baduk D10, kata v2s9). The stones guess is
// wrong in about one problem in eight, nearly always as "the side to play
// attacks" when it has to live, and the side to play then loses at the
// problem start. After `visits` at the start, a win rate below `maxWin` for
// the side to play has the flipped frame analysed too.
export const AUTO_ATTACKER = {visits: 500, maxWin: 0.3}

/**
 * Decide the attacker from the side to play's win rates (0 to 1) at the
 * problem start: `guessWin` under the stones guess, `flipWin` under the
 * flipped attacker (null until analysed). The flip is kept only if the side
 * to play wins with it; otherwise the guess stays. `suspect`: the side to
 * play loses with either attacker, so the problem, its answer or the frame
 * may be wrong (a ko answer needs ko threats).
 *
 * Returns null when the flipped attacker still has to be analysed.
 *
 * @param {number} guess - the stones guess, 1 or -1
 * @param {number} guessWin
 * @param {number | null} [flipWin]
 * @returns {null | {attacker: number, flipped: boolean, suspect: boolean}}
 */
export function chooseAttacker(guess, guessWin, flipWin = null) {
  let {maxWin} = AUTO_ATTACKER
  if (guessWin >= maxWin)
    return {attacker: guess, flipped: false, suspect: false}
  if (flipWin == null) return null

  let flipped = flipWin >= maxWin
  return {attacker: flipped ? -guess : guess, flipped, suspect: !flipped}
}

/**
 * Build the hidden frame for a problem.
 *
 * Returns null when no frame applies: no stones in the window, or the window
 * covers more than half the board.
 *
 * Komi assumes area scoring (stones plus territory); the caller should analyse
 * the framed position under area rules.
 *
 * @param {number[][]} signMap - the problem position, signMap[y][x]
 * @param {object} [options]
 * @param {{rangeX?: number[], rangeY?: number[]}} [options.window] - the VW
 *   box, as returned by gametree.getViewRange; empty means no VW
 * @param {number} [options.attacker] - 1 or -1, overrides any inference
 * @param {string} [options.text] - problem text for inferAttackerFromText
 * @param {number} [options.toPlay] - 1 or -1
 * @param {number} [options.margin] - lines added around the problem's stones
 * @param {number} [options.maxKomi] - no frame when balancing it takes a
 *   larger komi
 * @param {{B?: number, W?: number}} [options.koThreats] - ko threats to build
 *   for each colour, 0 to 3 each; as many as fit are placed
 * @returns {null | {
 *   signMap: number[][],
 *   komi: number,
 *   attacker: number,
 *   attackerSource: 'option' | 'text' | 'stones',
 *   window: {rangeX: number[], rangeY: number[]},
 *   frameVertices: Array<[number, number]>,
 *   koThreats: {B: number, W: number},
 *   koThreatVertices: Array<[number, number]>,
 * }} - koThreats: the threats placed per colour; koThreatVertices: their eye
 *   points, where threats are played and answered
 */
export function getTsumegoFrame(
  signMap,
  {
    window = {},
    attacker = null,
    text = '',
    toPlay = 0,
    margin = 2,
    maxKomi = MAX_KOMI,
    koThreats = {},
  } = {},
) {
  let height = signMap.length
  let width = signMap[0].length
  let stones = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (signMap[y][x] !== 0) stones.push([x, y])
    }
  }

  // Problem stones are the ones inside VW, or all stones without VW.

  let hasVW = window.rangeX != null && window.rangeY != null
  let inBox = ([x, y], [x0, x1], [y0, y1]) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1
  let problemStones = hasVW
    ? stones.filter((v) => inBox(v, window.rangeX, window.rangeY))
    : stones

  if (problemStones.length === 0) return null

  // Window: the stones' bounding box plus the margin, grown to cover VW, and
  // pushed out to the board edge where too few lines remain for gap and wall.

  let xs = problemStones.map(([x, _]) => x)
  let ys = problemStones.map(([_, y]) => y)
  let x0 = Math.min(...xs) - margin
  let x1 = Math.max(...xs) + margin
  let y0 = Math.min(...ys) - margin
  let y1 = Math.max(...ys) + margin

  if (hasVW) {
    x0 = Math.min(x0, window.rangeX[0])
    x1 = Math.max(x1, window.rangeX[1])
    y0 = Math.min(y0, window.rangeY[0])
    y1 = Math.max(y1, window.rangeY[1])
  }

  if (x0 <= WALL_END - 1) x0 = 0
  if (y0 <= WALL_END - 1) y0 = 0
  if (x1 >= width - WALL_END) x1 = width - 1
  if (y1 >= height - WALL_END) y1 = height - 1

  let rangeX = [x0, x1]
  let rangeY = [y0, y1]
  let windowSize = (x1 - x0 + 1) * (y1 - y0 + 1)

  if (windowSize > MAX_WINDOW_SHARE * width * height) return null

  // Attacker

  let attackerSource = 'option'

  if (attacker !== 1 && attacker !== -1) {
    attacker = inferAttackerFromText(text, toPlay)
    attackerSource = 'text'
  }

  if (attacker == null) {
    attacker = guessAttacker(signMap, problemStones)
    attackerSource = 'stones'
  }

  let defender = -attacker

  // Distance from the window, and the points kept clear around context stones

  let distance = (x, y) => Math.max(x0 - x, x - x1, y0 - y, y - y1, 0)
  let contextStones = stones.filter(([x, y]) => distance(x, y) > 0)
  let blocked = makeGrid(width, height, false)

  for (let [cx, cy] of contextStones) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x >= 0 && x < width && y >= 0 && y < height) blocked[y][x] = true
      }
    }
  }

  // Zones: which colour owns each frame point (0 = not part of the frame)

  let zone = makeGrid(width, height, 0)
  let territory = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let d = distance(x, y)
      if (d < 2 || blocked[y][x]) continue

      zone[y][x] = attacker
      if (d > WALL_END) territory.push([x, y, d])
    }
  }

  // Defender territory: the points farthest from the window, as many as make
  // the midpoint even before komi (see the komi below).
  //
  // Ko threats change the split: a defender threat puts an attacker group in
  // the defender's territory, so the defender's share grows by the group's
  // area to stay even; an attacker threat does the opposite. When fewer
  // threats fit than were asked for, the frame is built again for the number
  // that fit, so komi does not have to make up the difference.

  let livingArea = estimateLivingArea(signMap, defender, rangeX, rangeY)
  let contextArea = (sign) =>
    contextStones.filter(([x, y]) => signMap[y][x] === sign).length
  let threatShapes = getKoThreatShapes(livingArea + KO_THREAT_MARGIN)
  let threatArea = threatShapes[0].width * threatShapes[0].depth
  let requested = {}

  for (let sign of [1, -1]) {
    let n = Math.floor(Number(koThreats[sign > 0 ? 'B' : 'W']) || 0)
    requested[sign] = Math.max(0, Math.min(KO_THREAT_MAX, n))
  }

  territory.sort(([ax, ay, ad], [bx, by, bd]) => bd - ad || ay - by || ax - bx)

  let build = (counts) => {
    let threatShift = (counts[defender] - counts[attacker]) * threatArea
    let defenderSize = Math.max(
      0,
      Math.min(
        territory.length,
        Math.round(
          (width * height - livingArea) / 2 -
            contextArea(defender) +
            threatShift,
        ),
      ),
    )

    if (defenderSize < MIN_DEFENDER_BLOCK) defenderSize = 0

    // Attacker threats need room beyond the wall, which the defender's share
    // would otherwise take from the far side of the board: keep sites
    // nearest the window back from it.

    let reserved = new Set()
    let reservedRects = []

    for (let i = 0; i < counts[attacker]; i++) {
      let site = findKoThreatSites(
        zone,
        attacker,
        threatShapes,
        reservedRects,
        distance,
        true,
      )[0]
      if (site == null) break

      reservedRects.push(site.rect)
      let {x0, x1, y0, y1} = site.rect

      for (let y = y0 - 1; y <= y1 + 1; y++) {
        for (let x = x0 - 1; x <= x1 + 1; x++) reserved.add(y * width + x)
      }
    }

    // Stones and eyes. Repairing groups without two eyes can hand planned
    // defender points back to the attacker (a one-line strip beside the wall
    // cannot hold eyes); retry with those points skipped so the defender
    // still gets its share.

    let lost = new Set()
    let frame

    for (let attempt = 0; attempt < 4; attempt++) {
      let planned = territory
        .filter(
          ([x, y]) => !lost.has(y * width + x) && !reserved.has(y * width + x),
        )
        .slice(0, defenderSize)
      let trial = zone.map((row) => [...row])

      for (let [x, y] of planned) trial[y][x] = defender

      frame = settleZones(trial)

      let missing = planned.filter(([x, y]) => frame.zone[y][x] !== defender)
      if (missing.length === 0) break

      for (let [x, y] of missing) lost.add(y * width + x)
    }

    // Ko threats, one side at a time so neither takes all the room

    let placed = {1: 0, '-1': 0}
    let threatVertices = []
    let threatRects = []

    for (let round = 0; round < KO_THREAT_MAX; round++) {
      for (let sign of [defender, attacker]) {
        if (round >= counts[sign] || placed[sign] < round) continue

        let eyes = placeKoThreat(
          frame,
          sign,
          threatShapes,
          threatRects,
          distance,
          sign === attacker,
        )
        if (eyes == null) continue

        placed[sign]++
        threatVertices.push(...eyes)
      }
    }

    return {frame, placed, threatVertices}
  }

  // Komi: area at the midpoint between the defender living (with livingArea
  // points of the window) and dying (the attacker takes the window). Outside
  // the window the defender holds its frame zone and context stones; every
  // other point, the gap included, ends up the attacker's. So at the midpoint
  // the defender has D + L/2 of the N points, the attacker N - D - L/2, and the
  // difference is 2D + L - N. Ko threat groups count as their owner's.
  //
  // A frame group removed for lack of eyes leaves its points empty and in no
  // zone. Where only defender stones surround them (an attacker strip one
  // line wide along the edge, beyond the defender's share), the defender owns
  // them in the count, so they belong to D.

  let getKomi = ({zone, stones}) => {
    let enclosed = 0
    let seen = makeGrid(width, height, false)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (seen[y][x] || zone[y][x] !== 0 || stones[y][x] !== 0) continue
        if (distance(x, y) < 2 || blocked[y][x]) continue

        let size = 0
        let onlyDefender = true
        let stack = [[x, y]]
        seen[y][x] = true

        while (stack.length > 0) {
          let [cx, cy] = stack.pop()
          size++

          for (let [nx, ny] of neighbors(cx, cy, width, height)) {
            let sign = stones[ny][nx]
            if (sign !== 0) {
              if (sign !== defender) onlyDefender = false
              continue
            }
            if (zone[ny][nx] !== 0 || distance(nx, ny) < 2 || blocked[ny][nx]) {
              onlyDefender = false
              continue
            }
            if (seen[ny][nx]) continue
            seen[ny][nx] = true
            stack.push([nx, ny])
          }
        }

        if (onlyDefender) enclosed += size
      }
    }

    let defenderArea =
      countZone(zone, defender) + contextArea(defender) + enclosed
    let difference = 2 * defenderArea + livingArea - width * height
    return Math.floor(defender * difference) + 0.5
  }

  let built = build(requested)

  if (built.placed[1] < requested[1] || built.placed[-1] < requested[-1]) {
    let rebuilt = build(built.placed)
    if (Math.abs(getKomi(rebuilt.frame)) <= Math.abs(getKomi(built.frame)))
      built = rebuilt
  }

  let {frame, placed, threatVertices: koThreatVertices} = built
  let komi = getKomi(frame)

  // Result

  let result = signMap.map((row) => [...row])
  let frameVertices = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (frame.stones[y][x] === 0) continue

      result[y][x] = frame.stones[y][x]
      frameVertices.push([x, y])
    }
  }

  // A komi this large means the frame found almost no room for the
  // defender's share of territory (a centre problem). KataGo's scores were
  // wrong there, so analyse without a frame.

  if (Math.abs(komi) > maxKomi) return null

  return {
    signMap: result,
    komi,
    attacker,
    attackerSource,
    window: {rangeX, rangeY},
    frameVertices,
    koThreats: {B: placed[1], W: placed[-1]},
    koThreatVertices,
  }
}

// Group shapes for a ko threat of at least `area` points, smallest first: a
// rectangle `width` points along the edge and `depth` rows deep.
function getKoThreatShapes(area) {
  let shapes = []

  for (let width = 6; width <= KO_THREAT_MAX_WIDTH; width++) {
    let depth = Math.max(KO_THREAT_MIN_DEPTH, Math.ceil(area / width))
    shapes.push({width, depth})
  }

  return shapes.sort(
    (a, b) => a.width * a.depth - b.width * b.depth || a.depth - b.depth,
  )
}

// Where a ko threat for `threatener` fits in `zone`, best first: rectangle and
// ring in the threatener's zone beyond the wall, not into a corner, three
// lines or more from the threats in `threatRects`. With `onWall` (attacker
// threats), the ring may lie on the wall's last line and must reach it, so it
// joins the living wall; sites nearest the window come first. Otherwise the
// farthest come first.
function findKoThreatSites(
  zone,
  threatener,
  shapes,
  threatRects,
  distance,
  onWall,
) {
  let height = zone.length
  let width = zone[0].length
  let onBoard = (x, y) => x >= 0 && x < width && y >= 0 && y < height
  let sites = []

  for (let shape of shapes) {
    for (let side = 0; side < 4; side++) {
      // side 0 top, 1 bottom, 2 left, 3 right; `along` runs the edge
      let vertical = side >= 2
      let edgeLength = vertical ? height : width
      let [w, h] = vertical
        ? [shape.depth, shape.width]
        : [shape.width, shape.depth]

      // Not into a corner: the ring closes both ends, as in the tested shape
      for (let along = 1; along + shape.width <= edgeLength - 1; along++) {
        let x0 = vertical ? (side === 2 ? 0 : width - w) : along
        let y0 = vertical ? along : side === 0 ? 0 : height - h
        let rect = {x0, y0, x1: x0 + w - 1, y1: y0 + h - 1}
        let offset = 1 + Math.floor((shape.width - 6) / 2)
        let eyes = [0, 1, 2, 3].map((i) =>
          vertical
            ? [side === 2 ? 0 : width - 1, y0 + offset + i]
            : [x0 + offset + i, side === 0 ? 0 : height - 1],
        )

        let ok = true
        let nearest = Infinity

        for (let y = rect.y0 - 1; y <= rect.y1 + 1 && ok; y++) {
          for (let x = rect.x0 - 1; x <= rect.x1 + 1; x++) {
            if (!onBoard(x, y)) continue

            let d = distance(x, y)
            let inRect =
              x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1
            let minDistance = onWall && !inRect ? WALL_END : WALL_END + 1

            if (zone[y][x] !== threatener || d < minDistance) {
              ok = false
              break
            }
            nearest = Math.min(nearest, d)
          }
        }

        if (onWall && nearest > WALL_END) ok = false

        let apart = (r) =>
          Math.max(
            r.x0 - rect.x1,
            rect.x0 - r.x1,
            r.y0 - rect.y1,
            rect.y0 - r.y1,
          ) >= 3

        if (ok && threatRects.every(apart)) {
          sites.push({rect, eyes, area: w * h, nearest, side, along})
        }
      }
    }
  }

  // Smallest shape first, then by distance from the window
  sites.sort(
    (a, b) =>
      a.area - b.area ||
      (onWall ? a.nearest - b.nearest : b.nearest - a.nearest) ||
      a.side - b.side ||
      a.along - b.along,
  )

  return sites
}

/**
 * Build one ko threat for `threatener` into a settled frame ({zone, stones},
 * changed in place). The threat is a rectangle against a board edge, filled
 * with the opponent's stones except for a straight four of eye space on the
 * edge line, and ringed by the threatener's stones. Rectangle and ring lie in
 * the threatener's zone beyond the wall, three lines or more from any other
 * threat, and every frame group around them must keep two eyes.
 *
 * Returns the four eye points, or null when no shape fits.
 */
function placeKoThreat(
  frame,
  threatener,
  shapes,
  threatRects,
  distance,
  onWall = false,
) {
  let {zone, stones} = frame
  let height = zone.length
  let width = zone[0].length
  let onBoard = (x, y) => x >= 0 && x < width && y >= 0 && y < height
  let sites = findKoThreatSites(
    zone,
    threatener,
    shapes,
    threatRects,
    distance,
    onWall,
  )

  for (let site of sites) {
    let {rect, eyes} = site
    let inRect = (x, y) =>
      x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1
    let isEye = (x, y) => eyes.some(([ex, ey]) => ex === x && ey === y)
    let trialZone = zone.map((row) => [...row])
    let trialStones = stones.map((row) => [...row])

    for (let y = rect.y0 - 1; y <= rect.y1 + 1; y++) {
      for (let x = rect.x0 - 1; x <= rect.x1 + 1; x++) {
        if (!onBoard(x, y)) continue

        if (!inRect(x, y)) {
          trialStones[y][x] = threatener
        } else {
          trialZone[y][x] = -threatener
          trialStones[y][x] = isEye(x, y) ? 0 : -threatener
        }
      }
    }

    // Every frame group but the threat groups themselves keeps two eyes
    let rects = [...threatRects, rect]
    let inAnyRect = (x, y) =>
      rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)
    let frameEyes = []

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (
          trialZone[y][x] !== 0 &&
          trialStones[y][x] === 0 &&
          !inAnyRect(x, y)
        )
          frameEyes.push([x, y])
      }
    }

    let weak = findWeakGroups(trialStones, frameEyes).filter(
      (group) => !group.some(([x, y]) => inAnyRect(x, y)),
    )
    if (weak.length > 0) continue

    frame.zone = trialZone
    frame.stones = trialStones
    threatRects.push(rect)
    return eyes
  }

  return null
}

/**
 * Estimate how many points of the window a living defender owns: its stones
 * plus its eye space, the non-defender points in the window that defender
 * stones (and the board edge) cut off from the rest of the window's outside.
 * Eye space still open to the outside is not yet the defender's, so at least
 * MIN_EYE_SPACE points are assumed: the smallest group that lives adds a
 * stone on the vital point and has two eyes.
 *
 * @param {number[][]} signMap
 * @param {number} defender - 1 or -1
 * @param {number[]} rangeX - the window
 * @param {number[]} rangeY
 */
export function estimateLivingArea(signMap, defender, rangeX, rangeY) {
  let height = signMap.length
  let width = signMap[0].length
  let [x0, x1] = rangeX
  let [y0, y1] = rangeY
  let inWindow = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1
  let seen = makeGrid(width, height, false)
  let stones = 0
  let eyeSpace = 0

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (signMap[y][x] === defender) {
        stones++
        continue
      }
      if (seen[y][x]) continue

      // A region of non-defender points; open if it reaches past the window.
      let size = 0
      let open = false
      let stack = [[x, y]]
      seen[y][x] = true

      while (stack.length > 0) {
        let [cx, cy] = stack.pop()
        size++

        for (let [nx, ny] of neighbors(cx, cy, width, height)) {
          if (!inWindow(nx, ny)) {
            open = true
            continue
          }
          if (signMap[ny][nx] === defender || seen[ny][nx]) continue
          seen[ny][nx] = true
          stack.push([nx, ny])
        }
      }

      if (!open) eyeSpace += size
    }
  }

  return stones + Math.max(eyeSpace, MIN_EYE_SPACE)
}

/**
 * Turn colour zones into stones and eyes. Eyes are zone points on the lattice
 * (x + 2y) % 5 == 0 whose neighbours and diagonals are all the same zone; no
 * two lattice points touch, even diagonally. A group with fewer than two eyes
 * is removed from the frame, together with its zone.
 */
function settleZones(zone) {
  let height = zone.length
  let width = zone[0].length
  zone = zone.map((row) => [...row])

  // Removing a group can cost a same-coloured neighbour a diagonal of one of
  // its eyes, so repeat until every group is settled.
  while (true) {
    let {stones, eyes} = placeStones(zone)
    let weak = findWeakGroups(stones, eyes)

    if (weak.length === 0) return {zone, stones}

    for (let group of weak) {
      for (let [x, y] of group) zone[y][x] = 0
    }
  }

  function placeStones(zone) {
    let stones = zone.map((row) => [...row])
    let eyes = []

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sign = zone[y][x]
        if (sign === 0 || (x + 2 * y) % 5 !== 0) continue

        let surrounded = true

        for (let dy = -1; dy <= 1 && surrounded; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            let nx = x + dx
            let ny = y + dy
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
            if (zone[ny][nx] !== sign) {
              surrounded = false
              break
            }
          }
        }

        if (surrounded) {
          stones[y][x] = 0
          eyes.push([x, y])
        }
      }
    }

    return {stones, eyes}
  }
}

// Groups of frame stones with fewer than two eyes of their own. An eye counts
// for a group when all its on-board neighbours are stones of that group.
function findWeakGroups(stones, eyes) {
  let height = stones.length
  let width = stones[0].length
  let groupOf = makeGrid(width, height, -1)
  let groups = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (stones[y][x] === 0 || groupOf[y][x] >= 0) continue

      let sign = stones[y][x]
      let group = []
      let stack = [[x, y]]
      groupOf[y][x] = groups.length

      while (stack.length > 0) {
        let [cx, cy] = stack.pop()
        group.push([cx, cy])

        for (let [nx, ny] of neighbors(cx, cy, width, height)) {
          if (stones[ny][nx] !== sign || groupOf[ny][nx] >= 0) continue
          groupOf[ny][nx] = groups.length
          stack.push([nx, ny])
        }
      }

      groups.push(group)
    }
  }

  let eyeCount = groups.map(() => 0)

  for (let [x, y] of eyes) {
    let owners = neighbors(x, y, width, height).map(
      ([nx, ny]) => groupOf[ny][nx],
    )
    if (owners.every((g) => g >= 0 && g === owners[0])) eyeCount[owners[0]]++
  }

  return groups.filter((_, i) => eyeCount[i] < 2)
}

function neighbors(x, y, width, height) {
  return [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ].filter(([nx, ny]) => nx >= 0 && nx < width && ny >= 0 && ny < height)
}

function makeGrid(width, height, value) {
  return Array.from({length: height}, () => Array(width).fill(value))
}

function countZone(zone, sign) {
  return zone.reduce(
    (sum, row) => sum + row.filter((value) => value === sign).length,
    0,
  )
}

/**
 * Put a frame built for a problem's starting position onto a later position
 * of the same problem (a node further down its tree).
 *
 * The frame stays the one built for the start, so its komi and window hold
 * for the whole line being explored. Returns the framed signMap, or null when
 * the position no longer matches the start outside the window (a stone was
 * played or captured there), since the frame may then touch it.
 *
 * @param {{signMap: number[][], window: {rangeX: number[], rangeY: number[]},
 *   frameVertices: Array<[number, number]>}} frame - from getTsumegoFrame
 * @param {number[][]} startSignMap - the position the frame was built for
 * @param {number[][]} signMap - the position to frame
 */
export function applyTsumegoFrame(frame, startSignMap, signMap) {
  let {rangeX, rangeY} = frame.window
  let result = signMap.map((row) => [...row])

  for (let y = 0; y < signMap.length; y++) {
    for (let x = 0; x < signMap[y].length; x++) {
      let inWindow =
        x >= rangeX[0] && x <= rangeX[1] && y >= rangeY[0] && y <= rangeY[1]

      if (!inWindow && signMap[y][x] !== startSignMap[y][x]) return null
    }
  }

  for (let [x, y] of frame.frameVertices) {
    result[y][x] = frame.signMap[y][x]
  }

  return result
}

/**
 * The window's points as [x, y] vertices, row by row.
 *
 * @param {{rangeX: number[], rangeY: number[]}} window
 */
export function getWindowVertices({rangeX, rangeY}) {
  let vertices = []

  for (let y = rangeY[0]; y <= rangeY[1]; y++) {
    for (let x = rangeX[0]; x <= rangeX[1]; x++) {
      vertices.push([x, y])
    }
  }

  return vertices
}

/**
 * Keep analysis inside the window: drop candidate moves outside it, and cut
 * each best line at its first move outside it. The engine is already told to
 * stay in the window (`allow`); this makes sure nothing in the frame reaches
 * the heatmap or the best line even if an engine ignores that.
 *
 * @param {Array<{vertex: number[], moves: number[][]}>} variations - from
 *   parseAnalysis
 * @param {{rangeX: number[], rangeY: number[]}} window
 */
export function restrictAnalysisToWindow(variations, {rangeX, rangeY}) {
  let inWindow = (vertex) =>
    vertex != null &&
    vertex[0] >= rangeX[0] &&
    vertex[0] <= rangeX[1] &&
    vertex[1] >= rangeY[0] &&
    vertex[1] <= rangeY[1]

  return variations
    .filter(({vertex}) => inWindow(vertex))
    .map((variation) => {
      let end = variation.moves.findIndex((vertex) => !inWindow(vertex))
      if (end < 0) return variation

      return {...variation, moves: variation.moves.slice(0, end)}
    })
}
