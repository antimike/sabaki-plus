const {expect} = require('@playwright/test')
const path = require('path')
const {test} = require('./fixtures/electron-app')
const {
  loadSgfStringAndWait,
  waitForRender,
  attachAndWaitForEngines,
  detachAndWait,
} = require('./helpers')

// Fork-only (baduk mcms): candidates the cropped board cannot show, a frame ko
// threat and a pass, are listed in a strip under the board, the one with the
// most visits highlighted. The engine replays a made-up transcript
// (test/resources/engine-transcripts/made-up/), so this checks the parsing,
// folding and display deterministically; that KataGo really plays frame
// threats is frame-analysis.spec.js's concern.

const REPLAY_ENGINE = path.resolve(
  __dirname,
  '..',
  'test',
  'engines',
  'replayEngine.js',
)
const TRANSCRIPT = path.resolve(
  __dirname,
  '..',
  'test',
  'resources',
  'engine-transcripts',
  'made-up',
  'offwindow-corner.kata-analyze.txt',
)

// The corner fixture of frame-crop.spec.js: frame window x 0-7, y 0-5.
const CORNER =
  '(;GM[1]FF[4]SZ[19]PL[B]VW[aa:gf]' +
  'AB[ab][bb][cb][db][eb][fc][fd]AW[ac][bc][cc][dc][ec][ed]' +
  'C[Black to kill];B[fe])'

const entries = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#offwindow .entry')].map((el) => ({
      text: el.textContent,
      best: el.classList.contains('best'),
    })),
  )

test('ko threat and tenuki candidates show under the cropped board', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sabaki.setting.set('board.analysis_whole_board', false)
    window.sabaki.setting.set('board.show_analysis', true)
  })
  await loadSgfStringAndWait(page, CORNER)
  await waitForRender(page)

  expect(await page.locator('#offwindow').count()).toBe(0)

  let [syncerId] = await attachAndWaitForEngines(page, [
    {
      name: 'ReplayEngine',
      path: process.execPath,
      args: `"${REPLAY_ENGINE}" --transcript "${TRANSCRIPT}" --analyze-command kata-analyze`,
    },
  ])

  try {
    await page.evaluate((id) => window.__sabaki.startAnalysis(id), syncerId)

    await expect
      .poll(() => entries(page))
      .toEqual([
        {text: 'Ko threat · 97% · +19.7', best: true},
        {text: 'Tenuki · 41% · -2', best: false},
      ])

    // The in-window candidate stays on the board; the others do not
    let shown = await page.evaluate(() =>
      window.__sabaki.state.analysis.variations.map(({vertex}) => vertex),
    )
    expect(shown).toEqual([[1, 1]])

    // The board makes room for the strip rather than sitting under it
    let [main, strip] = await page.evaluate(() =>
      ['main', '#offwindow'].map(
        (s) => document.querySelector(s).getBoundingClientRect().bottom,
      ),
    )
    expect(main).toBeLessThanOrEqual(strip - 24)

    // Hiding analysis hides the strip
    await page.evaluate(() =>
      window.sabaki.setting.set('board.show_analysis', false),
    )
    await expect.poll(() => page.locator('#offwindow').count()).toBe(0)
  } finally {
    await page.evaluate(() => {
      window.sabaki.setting.set('board.show_analysis', true)
      window.__sabaki.stopAnalysis()
    })
    await detachAndWait(page, [syncerId])
  }
})
