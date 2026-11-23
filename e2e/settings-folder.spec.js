const {test, expect, _electron: electron} = require('@playwright/test')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Fork: the app keeps its settings in <appData>/sabaki-tsumego, not in the
// <appData>/Sabaki of an installed Sabaki (same productName). This launches
// without --user-data-dir, with XDG_CONFIG_HOME (Electron's appData on Linux)
// pointed at a temp dir, so MH's own ~/.config is never touched. The other
// half, an explicit --user-data-dir still winning, is what every other spec's
// fixture relies on (settings-cache.spec.js checks it reads that folder).
test('settings go to sabaki-tsumego, not Sabaki', async () => {
  test.skip(process.platform !== 'linux', 'XDG_CONFIG_HOME is Linux-only')

  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sabaki-xdg-'))
  const args = [path.resolve(__dirname, '..')]
  if (process.env.CI) args.push('--no-sandbox')

  const app = await electron.launch({
    executablePath: require('electron'),
    args,
    env: {...process.env, SABAKI_E2E: '1', XDG_CONFIG_HOME: configHome},
  })

  try {
    const userData = await app.evaluate(({app}) => app.getPath('userData'))
    expect(userData).toBe(path.join(configHome, 'sabaki-tsumego'))
    expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(configHome, 'Sabaki'))).toBe(false)
  } finally {
    try {
      await app.evaluate(({app}) => app.exit(0))
    } catch (e) {}
    try {
      await app.close()
    } catch (e) {}
    fs.rmSync(configHome, {recursive: true, force: true})
  }
})
