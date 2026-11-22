// First-move check of the tsumego frame and window restriction (baduk kata
// 24ys).
//
// For a stratified sample of sanderland life-and-death problems, this asks
// KataGo for its best move from the problem start, framed and restricted to
// the window the way the app does it (frame komi, area rules, `allow` lists
// for both players with the window, the frame's ko threats and pass), and
// compares it with the problem's SOL first moves. SOL lists the accepted first
// moves; it has no follow-up, so only the first move is checked.
//
//   PASS  the top move is one of the SOL moves and the side to play wins
//   ALT   it is not, but the top move and the SOL move both win for the side
//         to play (move order or a second solution)
//   FAIL  anything else
//
// Each FAIL is rerun with one change at a time to name its cause, in order:
//
//   no-frame        getTsumegoFrame returned null (no engine run)
//   outside-window  no SOL move lies in the window (no engine run)
//   attacker        passes with the attacker flipped (kata v2s9)
//   ko              passes with one frame ko threat for the defender
//   depth           passes at --rerun-visits
//   engine-dead     the engine reads the book move as failing (kata 9ds2):
//                   framed with the side to play defending, the defender's
//                   lead after the SOL move is the frame's "defender dead"
//                   score, -L (L the living-area estimate) within
//                   DEAD_TOLERANCE. The frame is balanced as designed; the
//                   engine and the book disagree (a misread, or a ko or seki
//                   answer). Try a stronger --model.
//   frame           none of the above: frame komi or balance
//
// A control search per problem, with no frame and no restriction (komi 0),
// shows whether the frame made a problem harder: control PASS, framed FAIL.
//
// --window-check skips the engine and lists every 19x19 problem in the corpus
// whose SOL moves all lie outside the window.
//
// --auto-attacker judges each problem with the attacker the app picks (baduk
// D10): a stones guess is flipped when the side to play loses with it at the
// start and wins with the flip (`auto` in the results). The `attacker` rerun
// then tries the other one.
//
// --summary prints the tables again from a saved results file.
//
// Usage (from the repo root):
//   npx tsx scripts/frame-calibration/firstmove.js [--visits N]
//     [--rerun-visits N] [--per-tier N] [--seed N] [--tiers 1a,1b,1c,1d]
//     [--limit N] [--json FILE] [--problems DIR] [--katago BIN]
//     [--model FILE] [--config FILE] [--window-check] [--auto-attacker]
//     [--summary FILE.json] [FILE.json ...]
//
// Problem files named on the command line replace the sample. Problems are
// read at run time from the sanderland-tsumego checkout and never copied into
// this repo: some collections are copyrighted. Results go to
// scripts/frame-calibration/results/ (gitignored) by default.
//
// Needs KataGo (default ~/.local/bin/katago), a network (default
// ~/.local/share/katago/models/b10c384h6nbttflrs.bin.gz) and a GTP config
// (default ~/.config/katago/gtp.cfg). Not part of npm test.

import {spawn} from 'child_process'
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'fs'
import {homedir} from 'os'
import {basename, dirname, join, relative} from 'path'
import {createInterface} from 'readline'
import {fileURLToPath} from 'url'

import {
  AUTO_ATTACKER,
  chooseAttacker,
  getTsumegoFrame,
  estimateLivingArea,
  getWindowVertices,
} from '../../src/modules/tsumegoframe.js'

const here = dirname(fileURLToPath(import.meta.url))
const alpha = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
const size = 19
const minPerAuthor = 5

// The rules the engine syncer sends with a framed position.
const rules = {
  scoring: 'AREA',
  ko: 'SIMPLE',
  tax: 'NONE',
  suicide: false,
  hasButton: false,
  whiteHandicapBonus: '0',
  friendlyPassOk: true,
}

function parseArgs(argv) {
  let args = {
    visits: 2000,
    'rerun-visits': 10000,
    'per-tier': 50,
    seed: 1,
    tiers: '1a,1b,1c,1d',
    limit: null,
    json: join(here, 'results', 'firstmove.json'),
    problems: join(homedir(), 'Documents/baduk/sanderland-tsumego/problems'),
    katago: join(homedir(), '.local/bin/katago'),
    model: join(
      homedir(),
      '.local/share/katago/models/b10c384h6nbttflrs.bin.gz',
    ),
    config: join(homedir(), '.config/katago/gtp.cfg'),
    'window-check': false,
    'auto-attacker': false,
    summary: null,
    files: [],
  }
  let numeric = ['visits', 'rerun-visits', 'per-tier', 'seed', 'limit']

  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      args.files.push(argv[i])
      continue
    }

    let key = argv[i].slice(2)
    if (!(key in args) || key === 'files') {
      throw new Error(`unknown option ${argv[i]}`)
    }
    if (key === 'window-check' || key === 'auto-attacker') args[key] = true
    else args[key] = numeric.includes(key) ? Number(argv[++i]) : argv[++i]
  }

  return args
}

const coord = ([x, y]) => `${alpha[x]}${size - y}`
const fromSgf = (s) => [s.charCodeAt(0) - 97, s.charCodeAt(1) - 97]
const colorOf = (sign) => (sign > 0 ? 'B' : 'W')

// Problems

function walk(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith('.json')
        ? [join(dir, e.name)]
        : [],
  )
}

// A problem as the app sees it after tools/tsumego_json2sgf.py: PL is the
// colour of the first SOL move, and the root comment carries C.
function loadProblem(file, root) {
  let data = JSON.parse(readFileSync(file, 'utf8'))
  let rel = relative(root, file)
  let [tierDir, author] = rel.split('/')
  let sol = (data.SOL ?? []).filter(([, move]) => move)
  let signMap = Array.from({length: size}, () => Array(size).fill(0))

  for (let [key, sign] of [
    ['AB', 1],
    ['AW', -1],
  ]) {
    for (let p of data[key] ?? []) {
      let [x, y] = fromSgf(p)
      signMap[y][x] = sign
    }
  }

  return {
    file,
    id: rel,
    tier: tierDir.split('.')[0],
    author,
    size: Number(data.SZ ?? 19),
    backup: sol.some(([, , , note]) => /Backup solution/.test(note ?? '')),
    toPlay: sol[0]?.[0] === 'W' ? -1 : 1,
    text: data.C ?? '',
    sol: sol.map(([, move]) => fromSgf(move)),
    signMap,
  }
}

function eligible(p) {
  return p.size === size && !p.backup && p.sol.length > 0
}

// mulberry32
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, random) {
  let a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    let j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// `perTier` problems per tier, spread over authors in proportion to their
// size, with at least `minPerAuthor` each (or all of a smaller author).
function sample(problems, tiers, perTier, seed) {
  let random = rng(seed)
  let chosen = []

  for (let tier of tiers) {
    let byAuthor = new Map()
    for (let p of problems.filter((p) => p.tier === tier)) {
      if (!byAuthor.has(p.author)) byAuthor.set(p.author, [])
      byAuthor.get(p.author).push(p)
    }

    let authors = [...byAuthor.keys()].sort()
    let n = (a) => byAuthor.get(a).length
    let total = authors.reduce((sum, a) => sum + n(a), 0)
    let quota = new Map(authors.map((a) => [a, Math.min(minPerAuthor, n(a))]))
    let left = perTier - [...quota.values()].reduce((x, y) => x + y, 0)

    // What is left goes out in proportion to author size (whole parts
    // first, then by largest remainder), never past an author's count.
    let exact = new Map(authors.map((a) => [a, (left * n(a)) / total]))
    for (let a of authors) {
      let add = Math.min(Math.floor(exact.get(a)), n(a) - quota.get(a))
      quota.set(a, quota.get(a) + add)
      left -= add
    }
    let byRest = [...authors].sort(
      (x, y) => (exact.get(y) % 1) - (exact.get(x) % 1),
    )
    while (left > 0 && byRest.some((a) => quota.get(a) < n(a))) {
      for (let a of byRest) {
        if (left === 0) break
        if (quota.get(a) < n(a)) {
          quota.set(a, quota.get(a) + 1)
          left--
        }
      }
    }

    for (let a of authors) {
      let picks = shuffle(byAuthor.get(a), random).slice(0, quota.get(a))
      chosen.push(...picks.sort((x, y) => x.id.localeCompare(y.id)))
    }
  }

  return chosen
}

// Frames

function buildFrame(p, {attacker = null, koThreats = {B: 0, W: 0}} = {}) {
  return getTsumegoFrame(p.signMap, {
    text: p.text,
    toPlay: p.toPlay,
    attacker,
    koThreats,
  })
}

function solInWindow(p, frame) {
  let win = new Set(getWindowVertices(frame.window).map((v) => v.join()))
  return p.sol.filter((v) => win.has(v.join()))
}

// Engine

function startEngine({katago, model, config}) {
  let child = spawn(katago, ['gtp', '-model', model, '-config', config], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let lines = createInterface({input: child.stdout})
  let buffer = []
  let waiter = null

  lines.on('line', (line) => {
    if (line !== '') {
      buffer.push(line)
      return
    }
    let out = buffer.join('\n')
    buffer = []
    let w = waiter
    waiter = null
    w?.(out)
  })

  let gtp = (command) =>
    new Promise((resolve, reject) => {
      waiter = (out) =>
        out.startsWith('?')
          ? reject(new Error(`${command}: ${out}`))
          : resolve(out)
      child.stdin.write(command + '\n')
    })

  return {gtp, close: () => child.stdin.end()}
}

function parseInfo(out) {
  return out
    .split(/(?=info )/)
    .filter((s) => s.startsWith('info '))
    .map((m) => {
      let get = (k) => (m.match(new RegExp(`${k} (\\S+)`)) ?? [])[1]
      return {
        move: get('move'),
        visits: Number(get('visits')),
        winrate: Number(get('winrate')),
        scoreLead: Number(get('scoreLead')),
        pv: (m.match(/ pv (.*?)( ownership| info|$)/) ?? [])[1]?.trim(),
      }
    })
}

// One search. With a frame: frame komi and the app's allow lists for both
// players; without: komi 0 and the whole board. `moves` are played first,
// from `toPlay`. Winrates are for the side to move after `moves`.
async function search(engine, {signMap, frame, toPlay, moves = [], visits}) {
  let {gtp} = engine
  let stones = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (signMap[y][x]) stones.push(colorOf(signMap[y][x]), coord([x, y]))
    }
  }

  await gtp(`boardsize ${size}`)
  await gtp('clear_board')
  await gtp(`set_position ${stones.join(' ')}`)
  await gtp(`kata-set-rules ${JSON.stringify(rules)}`)
  await gtp(`komi ${frame?.komi ?? 0}`)

  let player = toPlay
  for (let m of moves) {
    await gtp(`play ${colorOf(player)} ${m}`)
    player = -player
  }

  await gtp(`kata-set-param maxVisits ${visits}`)
  let command = `kata-search_analyze ${colorOf(player)}`
  if (frame != null) {
    let allow = [
      ...getWindowVertices(frame.window),
      ...(frame.koThreatVertices ?? []),
    ]
      .map(coord)
      .concat(['pass'])
      .join(',')
    for (let c of [player, -player]) {
      command += ` allow ${colorOf(c)} ${allow} 1000`
    }
  }

  return parseInfo(await gtp(command))
}

// PASS / ALT / FAIL for one frame at `visits`.
async function judge(engine, p, frame, visits) {
  let base = {signMap: frame.signMap, frame, toPlay: p.toPlay, visits}
  let infos = await search(engine, base)
  let top = infos[0]?.move
  let solCoords = p.sol.map(coord)
  // rootWin: the side to play's win rate with its best move. A SOL top move
  // in a lost position is a FAIL: a wrong attacker or komi can leave the
  // book move on top of a lost search.
  let result = {
    top,
    topVisits: infos[0]?.visits,
    rootWin: r2(infos[0]?.winrate ?? 0),
    rootLead: r2(infos[0]?.scoreLead ?? 0),
    pv: infos[0]?.pv,
  }

  if (solCoords.includes(top)) {
    let won = result.rootWin > 0.5
    return won
      ? {...result, verdict: 'PASS'}
      : {...result, verdict: 'FAIL', solMove: top, solWin: result.rootWin}
  }

  // The SOL move to compare with: the one the search liked best.
  let sol =
    infos.find((i) => solCoords.includes(i.move))?.move ??
    coord(solInWindow(p, frame)[0] ?? p.sol[0])
  let moverWin = async (move) => {
    let after = await search(engine, {...base, moves: [move]})
    return 1 - after[0].winrate
  }
  let topWin = top == null ? 0 : await moverWin(top)
  let solWin = await moverWin(sol)
  let verdict = topWin > 0.5 && solWin > 0.5 ? 'ALT' : 'FAIL'

  return {
    ...result,
    verdict,
    solMove: sol,
    topWin: r2(topWin),
    solWin: r2(solWin),
  }
}

async function control(engine, p, visits) {
  let infos = await search(engine, {
    signMap: p.signMap,
    frame: null,
    toPlay: p.toPlay,
    visits,
  })
  let top = infos[0]?.move
  return {top, pass: p.sol.map(coord).includes(top)}
}

const passes = (r) => r.verdict !== 'FAIL'

// The attacker the app picks (baduk D10): a stones guess is checked at
// AUTO_ATTACKER.visits from the problem start and flipped if the side to play
// loses with it and wins with the flip.
async function autoAttacker(engine, p, frame) {
  let rootWin = async (f) => {
    let infos = await search(engine, {
      signMap: f.signMap,
      frame: f,
      toPlay: p.toPlay,
      visits: AUTO_ATTACKER.visits,
    })
    return r2(infos[0]?.winrate ?? 0)
  }

  let guessWin = await rootWin(frame)
  let choice = chooseAttacker(frame.attacker, guessWin)
  let flipWin = null
  if (choice == null) {
    let flippedFrame = buildFrame(p, {attacker: -frame.attacker})
    flipWin = flippedFrame == null ? 0 : await rootWin(flippedFrame)
    choice = chooseAttacker(frame.attacker, guessWin, flipWin)
  }

  return {guessWin, flipWin, ...choice}
}

async function check(engine, p, args) {
  let frame = buildFrame(p)
  let result = {
    id: p.id,
    tier: p.tier,
    author: p.author,
    toPlay: colorOf(p.toPlay),
    sol: p.sol.map(coord),
    control: await control(engine, p, args.visits),
  }

  if (frame == null) return {...result, verdict: 'FAIL', cause: 'no-frame'}

  if (args['auto-attacker'] && frame.attackerSource === 'stones') {
    result.auto = await autoAttacker(engine, p, frame)
    if (result.auto.flipped) frame = buildFrame(p, {attacker: -frame.attacker})
  }

  Object.assign(result, {
    attacker: colorOf(frame.attacker),
    attackerSource: frame.attackerSource,
    komi: frame.komi,
    window: frame.window,
  })

  if (solInWindow(p, frame).length === 0) {
    return {...result, verdict: 'FAIL', cause: 'outside-window'}
  }

  Object.assign(result, await judge(engine, p, frame, args.visits))
  if (passes(result)) return result

  let defender = -frame.attacker
  let reruns = [
    ['attacker', buildFrame(p, {attacker: -frame.attacker}), args.visits],
    [
      'ko',
      buildFrame(p, {koThreats: {B: 0, W: 0, [colorOf(defender)]: 1}}),
      args.visits,
    ],
    ['depth', frame, args['rerun-visits']],
  ]

  result.reruns = {}
  for (let [cause, f, visits] of reruns) {
    if (f == null) {
      result.reruns[cause] = 'no-frame'
      continue
    }
    let r = await judge(engine, p, f, visits)
    result.reruns[cause] = r.verdict
    if (passes(r)) return {...result, cause}
  }

  let dead = await deadAfterSol(engine, p, args['rerun-visits'])
  if (dead != null) result.dead = dead
  return {...result, cause: dead?.dead ? 'engine-dead' : 'frame'}
}

// 9ds2: the 12 frame FAILs of the 2026-11-21 run scored within 1.9 of -L
// after the SOL move at 10000 visits (Fujisawa Int. 45 was 3.3 off at 4000).
const DEAD_TOLERANCE = 3

// The defender's lead after the SOL move, framed with the side to play
// defending, against the frame's "defender dead" score -L.
async function deadAfterSol(engine, p, visits) {
  let frame = buildFrame(p, {attacker: -p.toPlay})
  if (frame == null) return null

  let sol = solInWindow(p, frame)[0]
  if (sol == null) return null

  let {rangeX, rangeY} = frame.window
  let livingArea = estimateLivingArea(p.signMap, p.toPlay, rangeX, rangeY)
  let infos = await search(engine, {
    signMap: frame.signMap,
    frame,
    toPlay: p.toPlay,
    moves: [coord(sol)],
    visits,
  })
  // After the SOL move the attacker is to move: its lead, negated.
  let lead = -(infos[0]?.scoreLead ?? 0)

  return {
    livingArea,
    lead: r2(lead),
    dead: Math.abs(lead + livingArea) <= DEAD_TOLERANCE,
  }
}

// Reports

function summarize(results) {
  let out = []
  let tiers = [...new Set(results.map((r) => r.tier))]
  let row = (cells) => `| ${cells.join(' | ')} |`

  out.push(
    row([
      'tier',
      'n',
      'PASS',
      'ALT',
      'FAIL',
      'FAIL on SOL',
      'control PASS',
      'frame hurt',
    ]),
  )
  out.push(row(Array(8).fill('---')))
  for (let tier of [...tiers, 'all']) {
    let rs = tier === 'all' ? results : results.filter((r) => r.tier === tier)
    let count = (v) => rs.filter((r) => r.verdict === v).length
    out.push(
      row([
        tier,
        rs.length,
        count('PASS'),
        count('ALT'),
        count('FAIL'),
        rs.filter((r) => r.verdict === 'FAIL' && r.sol.includes(r.top)).length,
        rs.filter((r) => r.control.pass).length,
        rs.filter((r) => r.control.pass && r.verdict === 'FAIL').length,
      ]),
    )
  }

  let fails = results.filter((r) => r.verdict === 'FAIL')
  let causes = [
    'no-frame',
    'outside-window',
    'attacker',
    'ko',
    'depth',
    'engine-dead',
    'frame',
  ]
  out.push('', row(['cause', 'n']), row(['---', '---']))
  for (let c of causes) {
    out.push(row([c, fails.filter((r) => r.cause === c).length]))
  }

  out.push('', row(['problem', 'cause', 'top', 'SOL', 'control']))
  out.push(row(Array(5).fill('---')))
  for (let r of fails) {
    out.push(
      row([
        r.id.replace(/\.json$/, ''),
        r.cause,
        r.top ?? '',
        r.sol.join(' '),
        r.control.pass ? 'PASS' : r.control.top,
      ]),
    )
  }

  return out.join('\n')
}

function windowCheck(problems) {
  let byTier = {}
  let outside = []

  for (let p of problems.filter((p) => p.size === size && p.sol.length)) {
    let frame = buildFrame(p)
    if (frame == null) continue
    let t = (byTier[p.tier] ??= {framed: 0, outside: 0})
    t.framed++
    if (solInWindow(p, frame).length === 0) {
      t.outside++
      outside.push(`${p.id}  SOL ${p.sol.map(coord).join(' ')}`)
    }
  }

  for (let [tier, t] of Object.entries(byTier)) {
    console.log(`${tier}  framed ${t.framed}  SOL outside window ${t.outside}`)
  }
  for (let line of outside) console.log(`  ${line}`)
}

async function main() {
  let args = parseArgs(process.argv.slice(2))
  let root = args.problems

  if (args.summary != null) {
    console.log(
      summarize(JSON.parse(readFileSync(args.summary, 'utf8')).results),
    )
    return
  }

  if (args['window-check']) {
    windowCheck(walk(root).map((f) => loadProblem(f, root)))
    return
  }

  let problems = args.files.length
    ? args.files.map((f) => loadProblem(f, root))
    : sample(
        walk(root)
          .map((f) => loadProblem(f, root))
          .filter(eligible),
        args.tiers.split(','),
        args['per-tier'],
        args.seed,
      )
  if (args.limit != null) problems = problems.slice(0, args.limit)

  let engine = startEngine(args)
  let results = []

  for (let [i, p] of problems.entries()) {
    let r = await check(engine, p, args)
    results.push(r)
    console.error(
      `${String(i + 1).padStart(3)}/${problems.length} ${r.verdict.padEnd(4)}` +
        ` ${(r.cause ?? '').padEnd(14)} ${basename(dirname(p.id))}/${basename(p.id)}`,
    )
  }
  engine.close()

  mkdirSync(dirname(args.json), {recursive: true})
  writeFileSync(
    args.json,
    JSON.stringify({args: {...args, files: undefined}, results}, null, 2) +
      '\n',
  )
  console.log(summarize(results))
}

function r2(x) {
  return Math.round(x * 100) / 100
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
