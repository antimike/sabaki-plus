import assert from 'assert'
import Board from '@sabaki/go-board'

import {
  applyTsumegoFrame,
  getTsumegoFrame,
  getWindowVertices,
  guessAttacker,
  inferAttackerFromText,
  restrictAnalysisToWindow,
} from '../src/modules/tsumegoframe.js'

// All positions here are made up for these tests.

// Build a size x size signMap from rows of '.', 'X' (Black) and 'O' (White),
// placed with their top-left corner at [left, top].
function position(size, rows, {left = 0, top = 0} = {}) {
  let map = Array.from({length: size}, () => Array(size).fill(0))

  rows.forEach((row, dy) => {
    ;[...row].forEach((c, dx) => {
      if (c === 'X') map[top + dy][left + dx] = 1
      if (c === 'O') map[top + dy][left + dx] = -1
    })
  })

  return map
}

// Black lives in the top-left corner; White surrounds it.
const CORNER = ['.XX.O', 'X.XO.', 'XXOO.O', 'OO...']

// White on the top edge with Black surrounding it from below.
const SIDE = ['...O..O...', '..XOOOOX..', '..X....X..', '...XXXX...']

// Only its geometry matters: with Black as attacker, the defender's share of
// territory ends partway through the ring at distance 5 from the window.
const STRIP = ['..OOOO..', '.OXXXXO.', '.OX..XO.', '..X..X..']

function distanceFromWindow([x, y], {rangeX, rangeY}) {
  return Math.max(rangeX[0] - x, x - rangeX[1], rangeY[0] - y, y - rangeY[1], 0)
}

// Frame chains with their eyes: empty points whose neighbours all belong to
// that one chain.
function frameChains(board, frameVertices) {
  let isFrame = new Set(frameVertices.map(String))
  let seen = new Set()
  let chains = []

  for (let vertex of frameVertices) {
    if (seen.has(String(vertex))) continue

    let chain = board.getChain(vertex)
    chain.forEach((v) => seen.add(String(v)))

    let inChain = new Set(chain.map(String))
    let eyes = new Set()

    for (let v of chain) {
      for (let n of board.getNeighbors(v)) {
        if (board.get(n) !== 0) continue
        if (board.getNeighbors(n).every((m) => inChain.has(String(m)))) {
          eyes.add(String(n))
        }
      }
    }

    chains.push({
      chain,
      eyes: eyes.size,
      allFrame: chain.every((v) => isFrame.has(String(v))),
    })
  }

  return chains
}

function checkFrame(map, frame) {
  let board = new Board(frame.signMap)

  assert.ok(board.isValid(), 'framed position has a chain without liberties')

  // Problem and context stones are unchanged.
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map.length; x++) {
      if (map[y][x] !== 0) assert.strictEqual(frame.signMap[y][x], map[y][x])
    }
  }

  // No frame stone in the window or the gap, or next to a context stone.
  for (let vertex of frame.frameVertices) {
    let [x, y] = vertex
    assert.strictEqual(map[y][x], 0, `frame stone on a problem stone ${vertex}`)
    assert.ok(
      distanceFromWindow(vertex, frame.window) >= 2,
      `frame stone in the window or gap at ${vertex}`,
    )
    for (let n of board.getNeighbors(vertex)) {
      assert.ok(
        map[n[1]][n[0]] === 0,
        `frame stone ${vertex} touches problem stone ${n}`,
      )
    }
  }

  // Every frame chain is made only of frame stones and has two eyes.
  for (let {chain, eyes, allFrame} of frameChains(board, frame.frameVertices)) {
    assert.ok(allFrame, `frame chain at ${chain[0]} joined a problem stone`)
    assert.ok(eyes >= 2, `frame chain at ${chain[0]} has ${eyes} eye(s)`)
  }

  assert.strictEqual(Math.abs(frame.komi % 1), 0.5, 'komi must be a half point')
}

describe('tsumegoframe', () => {
  describe('getTsumegoFrame', () => {
    it('frames a 19x19 corner problem', () => {
      let map = position(19, CORNER)
      let frame = getTsumegoFrame(map)

      checkFrame(map, frame)
      assert.deepStrictEqual(frame.window, {rangeX: [0, 7], rangeY: [0, 5]})
      assert.strictEqual(frame.attacker, -1)
      assert.strictEqual(frame.attackerSource, 'stones')
      assert.ok(frame.frameVertices.length > 200)
    })

    it('walls the window with the attacker on the line after the gap', () => {
      for (let attacker of [1, -1]) {
        let map = position(19, CORNER)
        let frame = getTsumegoFrame(map, {attacker})

        assert.strictEqual(frame.attacker, attacker)
        assert.strictEqual(frame.attackerSource, 'option')

        for (let y = 0; y < 19; y++) {
          for (let x = 0; x < 19; x++) {
            if (distanceFromWindow([x, y], frame.window) === 2) {
              assert.strictEqual(frame.signMap[y][x], attacker, `at ${[x, y]}`)
            }
          }
        }
      }
    })

    it('balances 19x19 problems with territory, not komi', () => {
      // In STRIP the defender's share ends partway along the one-line strip
      // between the wall and the left edge, which cannot hold eyes; the split
      // has to move that share elsewhere instead of leaving it to komi.
      for (let [rows, opts] of [
        [CORNER, {}],
        [SIDE, {left: 5}],
        [STRIP, {left: 6}],
      ]) {
        let map = position(19, rows, opts)
        let frame = getTsumegoFrame(map)

        checkFrame(map, frame)
        assert.ok(Math.abs(frame.komi) <= 2, `komi ${frame.komi}`)
      }
    })

    it('frames a problem away from the corner on the side', () => {
      let map = position(19, SIDE, {left: 5})
      let frame = getTsumegoFrame(map)

      checkFrame(map, frame)
      assert.deepStrictEqual(frame.window, {rangeX: [5, 14], rangeY: [0, 5]})
      // Black's stones are farther from the edge, so Black attacks.
      assert.strictEqual(frame.attacker, 1)
    })

    it('extends the window to an edge too close for gap and wall', () => {
      // Stones from 4-4: the margin puts the window at 2, leaving two lines
      // to the edge, fewer than the gap and the three-line wall need.
      let map = position(19, CORNER, {left: 4, top: 4})
      let frame = getTsumegoFrame(map)

      checkFrame(map, frame)
      assert.deepStrictEqual(frame.window, {rangeX: [0, 11], rangeY: [0, 9]})
    })

    it('grows the window to cover VW', () => {
      let map = position(19, CORNER)
      let frame = getTsumegoFrame(map, {
        window: {rangeX: [0, 9], rangeY: [0, 8]},
      })

      checkFrame(map, frame)
      assert.deepStrictEqual(frame.window, {rangeX: [0, 9], rangeY: [0, 8]})
    })

    it('keeps context stones outside VW and clears the points around them', () => {
      let map = position(19, CORNER)
      map[3][12] = -1 // White context stone, outside VW

      let frame = getTsumegoFrame(map, {
        window: {rangeX: [0, 6], rangeY: [0, 4]},
      })

      checkFrame(map, frame)
      assert.strictEqual(frame.signMap[3][12], -1)
      for (let [x, y] of frame.frameVertices) {
        assert.ok(Math.max(Math.abs(x - 12), Math.abs(y - 3)) >= 2)
      }
    })

    it('takes the attacker from the problem text', () => {
      let map = position(19, CORNER)
      let frame = getTsumegoFrame(map, {text: 'White to live', toPlay: -1})

      checkFrame(map, frame)
      assert.strictEqual(frame.attacker, 1)
      assert.strictEqual(frame.attackerSource, 'text')
    })

    it('prefers the attacker option over the text', () => {
      let map = position(19, CORNER)
      let frame = getTsumegoFrame(map, {attacker: -1, text: 'White to live'})

      assert.strictEqual(frame.attacker, -1)
      assert.strictEqual(frame.attackerSource, 'option')
    })

    it('frames a 13x13 corner problem on its own board', () => {
      let map = position(13, CORNER)
      let frame = getTsumegoFrame(map)

      checkFrame(map, frame)
      // Too little room for an even split: komi does the balancing. Phase 2's
      // 24ys check decides whether such komi is acceptable (D5 addendum).
      assert.ok(Math.abs(frame.komi) > 10)
    })

    it('returns null when there is nothing to frame', () => {
      assert.strictEqual(getTsumegoFrame(position(19, [])), null)
      // VW given, but no stones inside it.
      assert.strictEqual(
        getTsumegoFrame(position(19, CORNER), {
          window: {rangeX: [10, 18], rangeY: [10, 18]},
        }),
        null,
      )
    })

    it('returns null when the window covers more than half the board', () => {
      assert.strictEqual(getTsumegoFrame(position(9, CORNER)), null)

      // Stones from the top-left corner to 12-12: with the margin the window
      // is 15x15 = 225 points, more than half of 361.
      let wide = position(19, ['X.......O'])
      wide[12][12] = 1
      assert.strictEqual(getTsumegoFrame(wide), null)
    })

    it('is deterministic', () => {
      let map = position(19, SIDE, {left: 5})
      assert.deepStrictEqual(getTsumegoFrame(map), getTsumegoFrame(map))
    })

    it('does not modify its input', () => {
      let map = position(19, CORNER)
      let copy = map.map((row) => [...row])
      getTsumegoFrame(map)
      assert.deepStrictEqual(map, copy)
    })
  })

  describe('inferAttackerFromText', () => {
    let cases = [
      ['Black to live.', 0, -1],
      ['Black to play and live', 0, -1],
      ['White to play and kill', 0, -1],
      ['Black to kill', 0, 1],
      ['White to capture the black stones', 0, -1],
      ['Can White escape?', 0, 1],
      ['to live', 1, -1],
      ['Kill!', -1, -1],
      ['Black to play', 1, null],
      ['', 1, null],
      ['Live', 0, null],
    ]

    for (let [text, toPlay, expected] of cases) {
      it(`reads ${JSON.stringify(text)} with toPlay ${toPlay}`, () => {
        assert.strictEqual(inferAttackerFromText(text, toPlay), expected)
      })
    }
  })

  describe('guessAttacker', () => {
    it('picks the colour farther from the edges', () => {
      let map = position(19, CORNER)
      let stones = []
      map.forEach((row, y) =>
        row.forEach((s, x) => s !== 0 && stones.push([x, y])),
      )
      assert.strictEqual(guessAttacker(map, stones), -1)
    })

    it('picks the missing colour when only one colour is present', () => {
      let map = position(19, ['XX', 'X.'])
      assert.strictEqual(guessAttacker(map, [[0, 0]]), -1)

      map = position(19, ['OO', 'O.'])
      assert.strictEqual(guessAttacker(map, [[0, 0]]), 1)
    })
  })

  describe('applyTsumegoFrame', () => {
    it('frames a later position with the starting frame', () => {
      let start = position(19, CORNER)
      let frame = getTsumegoFrame(start)
      let later = start.map((row) => [...row])
      later[3][3] = 1 // a move inside the window

      let framed = applyTsumegoFrame(frame, start, later)

      assert.strictEqual(framed[3][3], 1)
      for (let [x, y] of frame.frameVertices) {
        assert.strictEqual(framed[y][x], frame.signMap[y][x])
      }
      assert.ok(new Board(framed).isValid())
      assert.strictEqual(later[10][10], 0, 'input must not be changed')
    })

    it('gives up when the position changed outside the window', () => {
      let start = position(19, CORNER)
      let frame = getTsumegoFrame(start)
      let later = start.map((row) => [...row])
      later[15][15] = 1

      assert.strictEqual(applyTsumegoFrame(frame, start, later), null)
    })
  })

  describe('getWindowVertices', () => {
    it('lists every point of the window', () => {
      let vertices = getWindowVertices({rangeX: [2, 4], rangeY: [0, 1]})

      assert.strictEqual(vertices.length, 6)
      assert.deepStrictEqual(vertices[0], [2, 0])
      assert.deepStrictEqual(vertices[5], [4, 1])
    })
  })

  describe('restrictAnalysisToWindow', () => {
    let window = {rangeX: [0, 7], rangeY: [0, 5]}

    it('drops candidates outside the window', () => {
      let variations = [
        {vertex: [1, 1], moves: [[1, 1]]},
        {vertex: [10, 10], moves: [[10, 10]]},
      ]
      let result = restrictAnalysisToWindow(variations, window)

      assert.deepStrictEqual(
        result.map(({vertex}) => vertex),
        [[1, 1]],
      )
    })

    it('cuts a best line at its first move outside the window', () => {
      let variations = [
        {
          vertex: [1, 1],
          moves: [
            [1, 1],
            [2, 2],
            [12, 3],
            [3, 3],
          ],
        },
      ]
      let [result] = restrictAnalysisToWindow(variations, window)

      assert.deepStrictEqual(result.moves, [
        [1, 1],
        [2, 2],
      ])
      assert.strictEqual(variations[0].moves.length, 4)
    })
  })
})
