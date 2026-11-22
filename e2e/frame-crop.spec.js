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

// Fork-only (baduk D5, kata tfg1): Engines > Tsumego Frame holds the
// whole-board switch, a session-only attacker override and Show Frame.

// The Tsumego Frame submenu as the main process built it, '&' stripped.
async function frameMenu(electronApp) {
  return electronApp.evaluate(({Menu}) => {
    let strip = (label) => label.replace(/&/g, '')
    let engines = Menu.getApplicationMenu().items.find(
      (item) => strip(item.label) === 'Engines',
    )
    let frame = engines.submenu.items.find(
      (item) => strip(item.label) === 'Tsumego Frame',
    )

    return frame.submenu.items
      .filter((item) => item.type !== 'separator')
      .map((item) => ({
        label: strip(item.label),
        checked: item.checked,
        enabled: item.enabled,
      }))
  })
}

async function clickFrameMenu(electronApp, prefix) {
  await electronApp.evaluate(({Menu, BrowserWindow}, prefix) => {
    let strip = (label) => label.replace(/&/g, '')
    let engines = Menu.getApplicationMenu().items.find(
      (item) => strip(item.label) === 'Engines',
    )
    let frame = engines.submenu.items.find(
      (item) => strip(item.label) === 'Tsumego Frame',
    )
    let item = frame.submenu.items.find((item) =>
      strip(item.label).startsWith(prefix),
    )

    item.click(undefined, BrowserWindow.getAllWindows()[0])
  }, prefix)
}

// The menu is rebuilt over IPC after each render, so poll for it.
async function expectFrameMenu(electronApp, expected) {
  await expect
    .poll(async () => {
      let items = await frameMenu(electronApp)
      return Object.fromEntries(
        items.map(({label, checked, enabled}) => [label, {checked, enabled}]),
      )
    })
    .toMatchObject(expected)
}

test.describe('tsumego frame controls', () => {
  test.afterEach(async ({page}) => {
    await setWholeBoard(page, false)
  })

  test('auto attacker shows its colour and source', async ({
    electronApp,
    page,
  }) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await waitForRender(page)

    await expectFrameMenu(electronApp, {
      'Whole-Board Analysis': {checked: false, enabled: true},
      'Attacker: Auto (Black, from text)': {checked: true, enabled: true},
      'Attacker: Black': {checked: false, enabled: true},
      'Attacker: White': {checked: false, enabled: true},
      'Show Frame': {checked: false, enabled: true},
    })
  })

  test('the attacker override applies to this game only', async ({
    electronApp,
    page,
  }) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await waitForRender(page)

    await clickFrameMenu(electronApp, 'Attacker: White')
    await expectFrameMenu(electronApp, {
      'Attacker: Auto (Black, from text)': {checked: false},
      'Attacker: White': {checked: true},
    })

    let frame = await page.evaluate(() => {
      let f = window.__sabaki.getProblemFrame()
      return {attacker: f.attacker, source: f.attackerSource}
    })
    expect(frame).toEqual({attacker: -1, source: 'option'})

    // A new move makes a new tree with the same root: the override stays.
    let treeChanged = await page.evaluate(async () => {
      let before = window.__sabaki.inferredState.gameTree
      await window.__sabaki.makeMove([10, 10])
      return window.__sabaki.inferredState.gameTree !== before
    })
    expect(treeChanged).toBe(true)
    expect(
      await page.evaluate(() => window.__sabaki.getProblemFrame().attacker),
    ).toBe(-1)

    // Another game starts on Auto.
    await loadSgfStringAndWait(page, CORNER)
    await waitForRender(page)
    await expectFrameMenu(electronApp, {
      'Attacker: Auto (Black, from text)': {checked: true},
      'Attacker: White': {checked: false},
    })

    await page.evaluate(() => window.__sabaki.setFrameAttacker(null))
  })

  test('whole-board analysis disables the attacker choice', async ({
    electronApp,
    page,
  }) => {
    await loadSgfStringAndWait(page, CORNER)
    await setWholeBoard(page, true)

    await expectFrameMenu(electronApp, {
      'Whole-Board Analysis': {checked: true},
      'Attacker: Auto (Black, from text)': {enabled: false},
      'Attacker: Black': {enabled: false},
      'Attacker: White': {enabled: false},
      'Show Frame': {enabled: false},
    })
  })

  test('no frame leaves a plain, disabled Auto', async ({
    electronApp,
    page,
  }) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, WHOLE)
    await waitForRender(page)

    await expectFrameMenu(electronApp, {
      'Attacker: Auto': {checked: true, enabled: false},
    })
  })

  // Fork-only (kata 899v): ko threats per colour, 0 to 3; the checked count
  // says how many the frame could place when fewer fit.
  test('ko threat counts show how many were placed', async ({
    electronApp,
    page,
  }) => {
    let koMenu = (color) =>
      electronApp.evaluate(({Menu}, color) => {
        let strip = (label) => label.replace(/&/g, '')
        let find = (items, label) =>
          items.find((item) => strip(item.label) === label)
        let engines = find(Menu.getApplicationMenu().items, 'Engines')
        let frame = find(engines.submenu.items, 'Tsumego Frame')
        let ko = find(frame.submenu.items, `Ko Threats for ${color}`)

        return {
          enabled: ko.enabled,
          items: ko.submenu.items.map((item) => ({
            label: strip(item.label),
            checked: item.checked,
          })),
        }
      }, color)
    let clickKo = (color, count) =>
      electronApp.evaluate(
        ({Menu, BrowserWindow}, [color, count]) => {
          let strip = (label) => label.replace(/&/g, '')
          let find = (items, label) =>
            items.find((item) => strip(item.label) === label)
          let engines = find(Menu.getApplicationMenu().items, 'Engines')
          let frame = find(engines.submenu.items, 'Tsumego Frame')
          let ko = find(frame.submenu.items, `Ko Threats for ${color}`)

          ko.submenu.items[count].click(
            undefined,
            BrowserWindow.getAllWindows()[0],
          )
        },
        [color, count],
      )

    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await waitForRender(page)

    let start = await koMenu('Black')
    expect(start.enabled).toBe(true)
    expect(start.items).toEqual([
      {label: '0', checked: true},
      {label: '1', checked: false},
      {label: '2', checked: false},
      {label: '3', checked: false},
    ])

    await clickKo('Black', 3)
    let placed = await page.evaluate(
      () => window.__sabaki.getProblemFrame().koThreats.B,
    )
    expect(placed).toBeLessThan(3)

    await expect
      .poll(async () => (await koMenu('Black')).items[3])
      .toEqual({label: `3 (${placed} placed)`, checked: true})
    expect((await koMenu('White')).items[0].checked).toBe(true)

    await clickKo('Black', 0)
    await expect
      .poll(async () => (await koMenu('Black')).items[0].checked)
      .toBe(true)
  })
})

// What Show Frame draws: vertex count, faint ghost stones by colour, and the
// points painted as outside the window, with the unpainted points' extent.
async function overlay(page) {
  return page.evaluate(() => {
    let vs = [...document.querySelectorAll('.shudan-vertex')]
    let has = (v, c) => v.classList.contains(c)
    let faint = vs.filter((v) => has(v, 'shudan-ghost_faint'))
    let inside = vs.filter((v) => !has(v, 'shudan-paint_1'))
    let xs = inside.map((v) => +v.dataset.x)
    let ys = inside.map((v) => +v.dataset.y)

    return {
      count: vs.length,
      ghostBlack: faint.filter((v) => has(v, 'shudan-ghost_1')).length,
      ghostWhite: faint.filter((v) => has(v, 'shudan-ghost_-1')).length,
      shaded: vs.length - inside.length,
      unshaded: {
        rangeX: [Math.min(...xs), Math.max(...xs)],
        rangeY: [Math.min(...ys), Math.max(...ys)],
      },
    }
  })
}

async function setShowFrame(electronApp, page, value) {
  if ((await page.evaluate(() => window.__sabaki.state.showFrame)) !== value) {
    await clickFrameMenu(electronApp, 'Show Frame')
  }
  await page.waitForFunction(
    (v) => window.__sabaki.state.showFrame === v,
    value,
  )
  await waitForRender(page)
}

test.describe('show frame overlay', () => {
  test.afterEach(async ({page}) => {
    await page.evaluate(() => {
      window.__sabaki.setShowFrame(false)
      window.__sabaki.setFrameAttacker(null)
      window.__sabaki.setState({boardTransformation: ''})
    })
    await setWholeBoard(page, false)
  })

  test('uncrops and draws the frame as ghost stones', async ({
    electronApp,
    page,
  }) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await setShowFrame(electronApp, page, true)

    let frame = await page.evaluate(() => {
      let f = window.__sabaki.getProblemFrame()
      let count = (s) =>
        f.frameVertices.filter(([x, y]) => f.signMap[y][x] === s).length
      return {black: count(1), white: count(-1)}
    })
    expect(frame.black + frame.white).toBeGreaterThan(0)

    expect(await overlay(page)).toEqual({
      count: 19 * 19,
      ghostBlack: frame.black,
      ghostWhite: frame.white,
      shaded: 19 * 19 - 8 * 6,
      unshaded: {rangeX: [0, 7], rangeY: [0, 5]},
    })

    await setShowFrame(electronApp, page, false)
    let off = await overlay(page)
    expect(off.count).toBe(8 * 6)
    expect(off.ghostBlack + off.ghostWhite + off.shaded).toBe(0)
  })

  test('follows the attacker override', async ({electronApp, page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await setShowFrame(electronApp, page, true)
    let auto = await overlay(page)

    await clickFrameMenu(electronApp, 'Attacker: White')
    await page.waitForFunction(
      () => window.__sabaki.getProblemFrame().attacker === -1,
    )
    await waitForRender(page)
    let white = await overlay(page)

    // The wall changes colour, so the split of frame stones changes.
    expect(white.ghostBlack).not.toBe(auto.ghostBlack)
    expect(white.unshaded).toEqual(auto.unshaded)
  })

  test('moves with a board rotation', async ({electronApp, page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await page.evaluate(() =>
      window.__sabaki.setState({boardTransformation: 'r'}),
    )
    await setShowFrame(electronApp, page, true)

    // Clockwise rotation maps (x, y) to (18 - y, x)
    expect(await overlay(page)).toMatchObject({
      count: 19 * 19,
      shaded: 19 * 19 - 8 * 6,
      unshaded: {rangeX: [13, 18], rangeY: [0, 7]},
    })
  })

  test('draws nothing in guess mode', async ({electronApp, page}) => {
    await setWholeBoard(page, false)
    await loadSgfStringAndWait(page, CORNER)
    await setShowFrame(electronApp, page, true)
    await page.evaluate(() => window.__sabaki.setMode('guess'))
    await waitForRender(page)

    let guess = await overlay(page)
    expect(guess.count).toBe(8 * 6)
    expect(guess.ghostBlack + guess.ghostWhite).toBe(0)

    await page.evaluate(() => window.__sabaki.setMode('play'))
  })
})
