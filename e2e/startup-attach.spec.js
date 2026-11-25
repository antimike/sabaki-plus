const {test, expect, _electron: electron} = require('@playwright/test')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Fork (baduk, MH 2026-11-23): Sabaki Tsumego attaches an engine from the
// engine list once its window is up (`engines.attach_on_startup`), without
// starting analysis, and its window title names the fork. Launched by hand
// rather than with the shared fixture, which seeds no engines.

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

const ENGINES = [
  {
    name: 'First',
    path: process.execPath,
    args: `"${REPLAY_ENGINE}" --transcript "${TRANSCRIPT}"`,
  },
  {
    name: 'Second',
    path: process.execPath,
    args: `"${REPLAY_ENGINE}" --transcript "${TRANSCRIPT}"`,
  },
]

async function launch(settings) {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabaki-startup-'))
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      'app.startup_check_updates': false,
      'sound.enable': false,
      'engines.list': ENGINES,
      ...settings,
    }),
  )
  let args = [path.resolve(__dirname, '..'), `--user-data-dir=${dir}`]
  if (process.env.CI) args.push('--no-sandbox')

  let app = await electron.launch({
    executablePath: require('electron'),
    args,
    env: {...process.env, SABAKI_E2E: '1'},
  })
  let page = await app.firstWindow()
  await page.waitForSelector('#goban', {timeout: 30000})

  return {app, page, dir}
}

async function close({app, dir}) {
  try {
    await app.evaluate(({app}) => app.exit(0))
  } catch (e) {}
  try {
    await app.close()
  } catch (e) {}
  fs.rmSync(dir, {recursive: true, force: true})
}

const attached = (page) =>
  page.evaluate(() =>
    window.__sabaki.state.attachedEngineSyncers.map((s) => s.engine.name),
  )

test('attaches the first listed engine at startup, without analysing', async () => {
  let run = await launch({})

  try {
    await expect.poll(() => attached(run.page)).toEqual(['First'])
    // Attached means started: the replay engine answered the GTP handshake
    await expect
      .poll(() =>
        run.page.evaluate(
          () => window.__sabaki.state.attachedEngineSyncers[0].commands.length,
        ),
      )
      .toBeGreaterThan(0)
    expect(
      await run.page.evaluate(
        () => window.__sabaki.state.analyzingEngineSyncerId,
      ),
    ).toBe(null)

    expect(await run.page.title()).toBe('Sabaki Tsumego')
  } finally {
    await close(run)
  }
})

test('attaches the engine named by the setting', async () => {
  let run = await launch({'engines.attach_on_startup': 'Second'})

  try {
    await expect.poll(() => attached(run.page)).toEqual(['Second'])
  } finally {
    await close(run)
  }
})

test('attaches nothing when the setting is false', async () => {
  let run = await launch({'engines.attach_on_startup': false})

  try {
    // Give a startup attach time to happen before checking it did not
    await run.page.waitForTimeout(1500)
    expect(await attached(run.page)).toEqual([])
  } finally {
    await close(run)
  }
})
