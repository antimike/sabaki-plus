const {expect} = require('@playwright/test')
const {test} = require('./fixtures/electron-app')
const {loadSgfStringAndWait, waitForRender} = require('./helpers')

// Fork-only (baduk D5, kata 6pvj): when a tsumego frame applies, the board is
// cropped to the frame's window (the window the engine may play in), not to
// the raw VW. Without a frame, or with whole-board analysis on, the plain VW
// crop stays.

// A top-left corner problem whose VW (a1-g6 in SGF terms aa:gf, x 0-6, y 0-5)
// is tighter than its stones plus the 2-line margin: the frame window is x 0-7,
// y 0-5 (the k2vd case).
const CORNER =
  '(;GM[1]FF[4]SZ[19]PL[B]VW[aa:gf]' +
  'AB[ab][bb][cb][db][eb][fc][fd]AW[ac][bc][cc][dc][ec][ed]' +
  'C[Black to kill];B[fe])'

// No frame: VW covers the whole board.
const WHOLE = '(;GM[1]FF[4]SZ[19]PL[B]VW[aa:ss]AB[dd][pp]AW[dp][pd];B[qq])'

// The rendered board's extent, from the vertices Shudan draws.
async function shownRange(page) {
  return page.evaluate(() => {
    let vs = [...document.querySelectorAll('.shudan-vertex')]
    let xs = vs.map((v) => +v.dataset.x)
    let ys = vs.map((v) => +v.dataset.y)

    return {
      count: vs.length,
      rangeX: [Math.min(...xs), Math.max(...xs)],
      rangeY: [Math.min(...ys), Math.max(...ys)],
    }
  })
}

async function setWholeBoard(page, value) {
  await page.evaluate(
    (v) => window.sabaki.setting.set('board.analysis_whole_board', v),
    value,
  )
  await page.waitForFunction(
    (v) => !!window.__sabaki.state.wholeBoardAnalysis === v,
    value,
  )
  await waitForRender(page)
}

test.describe('board crop to the tsumego frame window', () => {
  test.afterEach(async ({page}) => {
    await setWholeBoard(page, false)
  })

  test('crops to the frame window, wider than VW', async ({page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await waitForRender(page)

    expect(await shownRange(page)).toEqual({
      count: 8 * 6,
      rangeX: [0, 7],
      rangeY: [0, 5],
    })
  })

  test('keeps the frame crop on later moves', async ({page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await page.evaluate(() => window.__sabaki.goStep(1))
    await waitForRender(page)

    expect((await shownRange(page)).rangeX).toEqual([0, 7])
  })

  test('moves the frame crop with a board rotation', async ({page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await page.evaluate(() =>
      window.__sabaki.setState({boardTransformation: 'r'}),
    )
    await waitForRender(page)

    // Clockwise rotation maps (x, y) to (18 - y, x)
    expect(await shownRange(page)).toEqual({
      count: 8 * 6,
      rangeX: [13, 18],
      rangeY: [0, 7],
    })

    await page.evaluate(() =>
      window.__sabaki.setState({boardTransformation: ''}),
    )
  })

  test('falls back to the VW crop with whole-board analysis', async ({
    page,
  }) => {
    await loadSgfStringAndWait(page, CORNER)
    await setWholeBoard(page, true)

    expect(await shownRange(page)).toEqual({
      count: 7 * 6,
      rangeX: [0, 6],
      rangeY: [0, 5],
    })
  })

  test('shows the VW crop when no frame applies', async ({page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, WHOLE)
    await waitForRender(page)

    expect((await shownRange(page)).count).toBe(19 * 19)
  })
})
