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
// midpoint between "the defender lives" and "the defender dies".

const WALL_END = 4 // last wall line, as a distance from the window
const MIN_DEFENDER_BLOCK = 12 // smaller defender territory is not worth a block
const MAX_WINDOW_SHARE = 0.5 // no frame if the window covers more of the board

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
 * @returns {null | {
 *   signMap: number[][],
 *   komi: number,
 *   attacker: number,
 *   attackerSource: 'option' | 'text' | 'stones',
 *   window: {rangeX: number[], rangeY: number[]},
 *   frameVertices: Array<[number, number]>,
 * }}
 */
export function getTsumegoFrame(
  signMap,
  {window = {}, attacker = null, text = '', toPlay = 0, margin = 2} = {},
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
  // the midpoint even before komi.

  let defenderInWindow = problemStones.filter(
    ([x, y]) => signMap[y][x] === defender,
  ).length
  let livingArea = 2 * defenderInWindow // rough area of a living defender
  let contextArea = (sign) =>
    contextStones.filter(([x, y]) => signMap[y][x] === sign).length
  let wallSize = countZone(zone, attacker) - territory.length
  let surplus =
    wallSize +
    territory.length +
    windowSize -
    livingArea +
    contextArea(attacker) -
    contextArea(defender)
  let defenderSize = Math.max(
    0,
    Math.min(territory.length, Math.round(surplus / 2)),
  )

  if (defenderSize < MIN_DEFENDER_BLOCK) defenderSize = 0

  territory.sort(([ax, ay, ad], [bx, by, bd]) => bd - ad || ay - by || ax - bx)

  // Stones and eyes. Repairing groups without two eyes can hand planned
  // defender points back to the attacker (a one-line strip beside the wall
  // cannot hold eyes); retry with those points skipped so the defender still
  // gets its share.

  let lost = new Set()
  let frame

  for (let attempt = 0; attempt < 4; attempt++) {
    let planned = territory
      .filter(([x, y]) => !lost.has(y * width + x))
      .slice(0, defenderSize)
    let trial = zone.map((row) => [...row])

    for (let [x, y] of planned) trial[y][x] = defender

    frame = settleZones(trial)

    let missing = planned.filter(([x, y]) => frame.zone[y][x] !== defender)
    if (missing.length === 0) break

    for (let [x, y] of missing) lost.add(y * width + x)
  }

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

  // Komi: area at the midpoint between the defender living (with about
  // livingArea points of the window) and dying (attacker takes the window).

  let area = {
    [attacker]:
      countZone(frame.zone, attacker) +
      contextArea(attacker) +
      windowSize -
      livingArea / 2,
    [defender]:
      countZone(frame.zone, defender) + contextArea(defender) + livingArea / 2,
  }
  let komi = Math.floor(area[1] - area[-1]) + 0.5

  return {
    signMap: result,
    komi,
    attacker,
    attackerSource,
    window: {rangeX, rangeY},
    frameVertices,
  }
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
