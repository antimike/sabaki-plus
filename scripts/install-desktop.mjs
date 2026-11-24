// Install a built snapshot of `plus` as a desktop app, "Sabaki Tsumego"
// (baduk: MH's app launcher). Fork-only.
//
//   npm run install:desktop            build plus and install it
//   npm run install:desktop -- --check report whether the installed snapshot
//                                      is behind plus (exit 1 if it is)
//
// The snapshot (electron-builder --dir) is copied to
// $XDG_DATA_HOME/../lib/sabaki-tsumego (~/.local/lib/sabaki-tsumego), outside
// the repo, so building a feature branch later does not change what the
// launcher runs. BUILT_FROM there records the commit. The entry goes to
// $XDG_DATA_HOME/applications/sabaki-tsumego.desktop. It registers .sgf as
// application/x-go-sgf (shared-mime-info's SGF type), not text/plain.
//
// Builds only from a clean `plus` checkout: the launcher should run merged
// work, not whatever branch is checked out.

import {spawnSync} from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import {homedir} from 'os'
import {dirname, join, resolve} from 'path'
import {fileURLToPath} from 'url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share')
const target = join(dataHome, '..', 'lib', 'sabaki-tsumego')
const entryPath = join(dataHome, 'applications', 'sabaki-tsumego.desktop')
const stampPath = join(target, 'BUILT_FROM')
const branch = 'plus'

function git(...args) {
  let r = spawnSync('git', args, {cwd: repo, encoding: 'utf8'})
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function run(cmd, args) {
  let r = spawnSync(cmd, args, {cwd: repo, stdio: 'inherit'})
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
    process.exit(1)
  }
}

function installedCommit() {
  if (!existsSync(stampPath)) return null
  return readFileSync(stampPath, 'utf8').split('\n')[0].trim() || null
}

function check() {
  let built = installedCommit()
  let tip = git('rev-parse', branch)

  if (built == null) {
    console.log(`Not installed (${stampPath} missing).`)
    process.exit(1)
  }
  if (built === tip) {
    console.log(`Up to date: ${branch} ${tip.slice(0, 8)}.`)
    return
  }

  let behind = git('rev-list', '--count', `${built}..${tip}`)
  console.log(
    `Behind: installed ${built.slice(0, 8)}, ${branch} ${tip.slice(0, 8)} ` +
      `(${behind} commits). Run: npm run install:desktop`,
  )
  process.exit(1)
}

function install() {
  let current = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (current !== branch) {
    console.error(`Check out ${branch} first (on ${current}).`)
    process.exit(1)
  }
  if (spawnSync('git', ['diff', '--quiet', 'HEAD'], {cwd: repo}).status !== 0) {
    console.error('Tracked files have uncommitted changes; commit or stash.')
    process.exit(1)
  }

  let commit = git('rev-parse', 'HEAD')
  let describe = git('describe', '--tags', '--always')

  run('npm', ['run', 'build'])

  // Swap the new snapshot in whole, so a failed copy leaves the old one
  let staging = `${target}.new`
  rmSync(staging, {recursive: true, force: true})
  mkdirSync(dirname(target), {recursive: true})
  run('cp', ['-a', join(repo, 'dist', 'linux-unpacked'), staging])
  copyFileSync(join(repo, 'logo.png'), join(staging, 'logo.png'))
  writeFileSync(
    join(staging, 'BUILT_FROM'),
    `${commit}\n${describe}\n${new Date().toISOString()}\n`,
  )
  rmSync(target, {recursive: true, force: true})
  renameSync(staging, target)

  mkdirSync(dirname(entryPath), {recursive: true})
  writeFileSync(
    entryPath,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Sabaki Tsumego',
      `Comment=Sabaki fork for tsumego study (${describe})`,
      `Exec=${join(target, 'sabaki')} %F`,
      `TryExec=${join(target, 'sabaki')}`,
      `Icon=${join(target, 'logo.png')}`,
      'Terminal=false',
      'Categories=Game;BoardGame;',
      // The app's Wayland app_id (app.setDesktopName in src/main.js)
      'StartupWMClass=sabaki-tsumego',
      // The shared-mime-info SGF type, never text/plain
      'MimeType=application/x-go-sgf;',
      '',
    ].join('\n'),
  )

  let db = spawnSync('update-desktop-database', [dirname(entryPath)])
  if (db.error == null && db.status !== 0) {
    console.warn('update-desktop-database failed; the entry is still written')
  }

  console.log(`Installed ${describe} to ${target}\nEntry: ${entryPath}`)
}

if (process.argv.includes('--check')) check()
else install()
