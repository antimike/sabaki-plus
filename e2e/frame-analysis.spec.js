const {expect} = require('@playwright/test')
const {test} = require('./fixtures/electron-app')
const {
  loadSgfStringAndWait,
  waitForRender,
  attachAndWaitForEngines,
  detachAndWait,
} = require('./helpers')

// Fork-only (baduk D5, kata mer7 and xtpb): with the tsumego frame on, the
// heatmap and the best line from a real engine stay inside the cropped window
// and never touch frame stones, also under a board rotation.
//
// This needs a real KataGo, so it is skipped unless SABAKI_E2E_KATAGO names the
// binary; SABAKI_E2E_KATAGO_ARGS holds its arguments (`gtp -model ... -config
// ...`). A replayed transcript cannot stand in: the point is what the engine
// does with the frame and the `allow` lists Sabaki sends it.

const KATAGO = process.env.SABAKI_E2E_KATAGO
const KATAGO_ARGS = process.env.SABAKI_E2E_KATAGO_ARGS || ''

// The corner fixture of frame-crop.spec.js: VW x 0-6, y 0-5; frame window
// x 0-7, y 0-5.
const CORNER =
  '(;GM[1]FF[4]SZ[19]PL[B]VW[aa:gf]' +
  'AB[ab][bb][cb][db][eb][fc][fd]AW[ac][bc][cc][dc][ec][ed]' +
  'C[Black to kill];B[fe])'

const WINDOW = {rangeX: [0, 7], rangeY: [0, 5]}
const MIN_VISITS = 400
const MIN_LINE = 3

// Clockwise rotation, as Goban draws it: (x, y) to (18 - y, x).
const rotate = ([x, y]) => [18 - y, x]
const identity = (v) => v

const inBox = ([x, y], {rangeX, rangeY}) =>
  x >= rangeX[0] && x <= rangeX[1] && y >= rangeY[0] && y <= rangeY[1]

// The analysis Sabaki holds, and the frame stones the engine saw.
async function analysisState(page) {
  return page.evaluate(() => {
    let s = window.__sabaki
    let frame = s.getAnalysisFrame(s.state.treePosition)
    let board = s.inferredState.board
    let frameStones = []

    frame.signMap.forEach((row, y) =>
      row.forEach((sign, x) => {
        if (sign !== 0 && board.signMap[y][x] === 0) frameStones.push([x, y])
      }),
    )

    return {
      window: frame.window,
      frameStones,
      sign: s.state.analysis.sign,
      variations: s.state.analysis.variations.map((v) => ({
        vertex: v.vertex,
        visits: v.visits,
        moves: v.moves,
      })),
    }
  })
}

// What the board shows: the vertices with heat, and the line's labels.
async function shown(page) {
  return page.evaluate(() => {
    let vs = [...document.querySelectorAll('.shudan-vertex')]
    let at = (v) => [+v.dataset.x, +v.dataset.y]

    return {
      // Shudan draws a .shudan-heat element on every vertex; only vertices
      // with heat get a shudan-heat_<strength> class.
      heat: vs
        .filter((v) => [...v.classList].some((c) => /^shudan-heat_/.test(c)))
        .map(at),
      // Shudan puts a label marker's text in the vertex's title.
      labels: vs
        .filter((v) => v.classList.contains('shudan-marker_label'))
        .filter((v) => /^\d+$/.test(v.title))
        .map((v) => ({n: +v.title, vertex: at(v)}))
        .sort((a, b) => a.n - b.n),
      rangeX: [
        Math.min(...vs.map((v) => +v.dataset.x)),
        Math.max(...vs.map((v) => +v.dataset.x)),
      ],
      rangeY: [
        Math.min(...vs.map((v) => +v.dataset.y)),
        Math.max(...vs.map((v) => +v.dataset.y)),
      ],
    }
  })
}

const key = ([x, y]) => `${x},${y}`
const sortVs = (vs) => vs.map(key).sort()

async function setTransformation(page, t) {
  await page.evaluate(
    (t) => window.__sabaki.setState({boardTransformation: t}),
    t,
  )
  await waitForRender(page)
}

test.describe('engine analysis inside the tsumego frame window', () => {
  test.skip(!KATAGO, 'set SABAKI_E2E_KATAGO to run against a real KataGo')
  test.setTimeout(180000)

  test('heatmap and best line stay in the window, also rotated', async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.sabaki.setting.set('board.analysis_whole_board', false)
      window.sabaki.setting.set('board.show_analysis', true)
      window.sabaki.setting.set('board.variation_replay_mode', 'instantly')
    })
    await loadSgfStringAndWait(page, CORNER)
    await waitForRender(page)

    let [syncerId] = await attachAndWaitForEngines(page, [
      {name: 'KataGo', path: KATAGO, args: KATAGO_ARGS},
    ])

    try {
      await page.evaluate((id) => window.__sabaki.startAnalysis(id), syncerId)

      // Let the search grow a real candidate list and line, then stop the
      // engine so the analysis is fixed while it is checked.
      await page.waitForFunction(
        ({minVisits, minLine}) => {
          let s = window.__sabaki.state
          let a = s.analysis
          if (a == null || s.analysisTreePosition !== s.treePosition)
            return false
          let visits = a.variations.reduce((sum, v) => sum + v.visits, 0)
          let longest = Math.max(...a.variations.map((v) => v.moves.length))
          return visits >= minVisits && longest >= minLine
        },
        {minVisits: MIN_VISITS, minLine: MIN_LINE},
        {timeout: 120000},
      )
      await page.evaluate(() =>
        window.__sabaki.inferredState.analyzingEngineSyncer.sendAbort(),
      )
      await waitForRender(page)

      let a = await analysisState(page)
      expect(a.window).toEqual(WINDOW)
      expect(a.frameStones.length).toBeGreaterThan(0)
      expect(a.frameStones.every((v) => !inBox(v, WINDOW))).toBe(true)

      let frameKeys = new Set(a.frameStones.map(key))
      let best = [...a.variations].sort((p, q) => q.visits - p.visits)[0]
      let longest = [...a.variations].sort(
        (p, q) => q.moves.length - p.moves.length,
      )[0]
      expect(longest.moves.length).toBeGreaterThanOrEqual(MIN_LINE)

      // Engine side: every candidate and every move of every line is in the
      // window, so none lands on a frame stone.
      for (let v of a.variations) {
        for (let m of [v.vertex, ...v.moves]) {
          expect(inBox(m, WINDOW), `move ${m} in window`).toBe(true)
          expect(frameKeys.has(key(m)), `move ${m} on frame`).toBe(false)
        }
      }

      for (let [t, map, range] of [
        ['', identity, WINDOW],
        ['r', rotate, {rangeX: [13, 18], rangeY: [0, 7]}],
      ]) {
        await setTransformation(page, t)

        // Heatmap: one heat cell per candidate, at its (transformed) vertex,
        // all inside the shown board.
        let s = await shown(page)
        expect({rangeX: s.rangeX, rangeY: s.rangeY}).toEqual(range)
        expect(sortVs(s.heat)).toEqual(
          sortVs(a.variations.map((v) => map(v.vertex))),
        )

        // Lines: hovering a candidate numbers its line's moves on the board.
        // The best candidate's line can be a single move (it ends at a pass),
        // so the longest line is checked too.
        for (let line of [best, longest]) {
          let [hx, hy] = map(line.vertex)
          await page.hover(`.shudan-vertex[data-x="${hx}"][data-y="${hy}"]`)
          await page.waitForFunction(
            () =>
              document.querySelector('.shudan-vertex.shudan-marker_label') !=
              null,
          )

          // One label per point of the line, at the (transformed) move, inside
          // the shown window. A later move can retake a point; its label
          // shows the last move played there.
          let expected = new Map()
          line.moves.forEach((m, i) => expected.set(key(map(m)), i + 1))

          s = await shown(page)
          expect(s.labels.every(({vertex}) => inBox(vertex, range))).toBe(true)
          expect(
            new Map(s.labels.map(({n, vertex}) => [key(vertex), n])),
          ).toEqual(expected)
          expect(s.heat).toEqual([])

          await page.mouse.move(0, 0)
          await waitForRender(page)
        }
      }
    } finally {
      await setTransformation(page, '')
      await page.evaluate(() => window.__sabaki.stopAnalysis())
      await detachAndWait(page, [syncerId])
    }
  })
})
