const {expect} = require('@playwright/test')
const {test} = require('./fixtures/electron-app')
const {
  loadSgfStringAndWait,
  waitForRender,
  attachAndWaitForEngines,
  detachAndWait,
} = require('./helpers')

// Fork-only (baduk D10, kata v2s9): the engine checks a stones guess of the
// attacker. When the side to play loses at the problem start with the guess,
// the flipped frame is analysed and kept if the side to play wins with it;
// when it loses with both, the guess stays and the problem is flagged.
//
// This needs a real KataGo, so it is skipped unless SABAKI_E2E_KATAGO names the
// binary; SABAKI_E2E_KATAGO_ARGS holds its arguments (`gtp -model ... -config
// ...`).

const KATAGO = process.env.SABAKI_E2E_KATAGO
const KATAGO_ARGS = process.env.SABAKI_E2E_KATAGO_ARGS || ''

// Positions made up for this test. Black is inside in both, but its stones
// sit farther from the edges than White's, so the stones guess is Black
// attacking. FLIP: Black lives with White attacking (KataGo b10: Black 4% with
// the guess, 100% flipped). SUSPECT: Black's group is dead either way. The
// move after the root is only there for the load helper.
const FLIP =
  '(;GM[1]FF[4]SZ[19]PL[B]AB[nb][nc][nd][ne][oe][pe][qe][re]' +
  'AW[ma][mb][mc][md][me][nf][of][pf][qf][rf][sf][qb][la][lb][lc][rg][sg][qg]' +
  'C[Black to play];B[pc])'
const SUSPECT =
  '(;GM[1]FF[4]SZ[19]PL[B]AB[nb][nc][nd][oe][pe][qe][re]' +
  'AW[ma][mb][mc][md][me][nf][of][pf][qf][rf][sf][qb][rc]' +
  'C[Black to play];B[pc])'

async function runCheck(page, sgf) {
  await page.evaluate(() => {
    window.sabaki.setting.set('board.analysis_whole_board', false)
  })
  await loadSgfStringAndWait(page, sgf)
  await waitForRender(page)

  let guess = await page.evaluate(() => {
    let frame = window.__sabaki.getAutoProblemFrame()
    return {attacker: frame.attacker, source: frame.attackerSource}
  })
  expect(guess).toEqual({attacker: 1, source: 'stones'})

  let [syncerId] = await attachAndWaitForEngines(page, [
    {name: 'KataGo', path: KATAGO, args: KATAGO_ARGS},
  ])

  try {
    await page.evaluate((id) => window.__sabaki.startAnalysis(id), syncerId)
    await page.waitForFunction(
      () => window.__sabaki.getAutoAttacker()?.phase === 'done',
      null,
      {timeout: 150000},
    )

    return await page.evaluate(() => {
      let s = window.__sabaki
      let auto = s.getAutoAttacker()
      return {
        auto,
        frameAttacker: s.getProblemFrame().attacker,
      }
    })
  } finally {
    await detachAndWait(page, [syncerId])
  }
}

test.describe('engine check of the stones attacker guess', () => {
  test.skip(!KATAGO, 'set SABAKI_E2E_KATAGO to run against a real KataGo')
  test.setTimeout(180000)

  test('flips a losing guess when the flip wins', async ({page}) => {
    let {auto, frameAttacker} = await runCheck(page, FLIP)

    expect(auto.guessWin).toBeLessThan(0.3)
    expect(auto.flipWin).toBeGreaterThanOrEqual(0.3)
    expect(auto).toMatchObject({flipped: true, suspect: false, attacker: -1})
    expect(frameAttacker).toBe(-1)
  })

  test('keeps the guess and flags the problem when both lose', async ({
    page,
  }) => {
    let {auto, frameAttacker} = await runCheck(page, SUSPECT)

    expect(auto.flipWin).toBeLessThan(0.3)
    expect(auto).toMatchObject({flipped: false, suspect: true, attacker: 1})
    expect(frameAttacker).toBe(1)
  })
})
