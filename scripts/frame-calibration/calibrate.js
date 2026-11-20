// Engine-backed check of the tsumego frame's komi (baduk kata cgbq).
//
// For each case in cases.js, in both colours, this builds the frame with
// getTsumegoFrame, then asks KataGo's analysis engine for the score of two
// settled positions under the frame's komi and area rules:
//
//   alive  the defender has played the vital point (attacker to move)
//   dead   the attacker has played the vital point (defender to move)
//
// and of the problem itself (defender to move). The frame is balanced when the
// two settled scores sit symmetrically around zero: the defender wins by about
// as much when it lives as it loses by when it dies. The midpoint of the two
// scores is the komi error; `ideal` is the komi that would cancel it.
//
// Ownership is summed by region (window, one-line gap, frame) to show where
// the points go in each outcome.
//
// Usage (from the repo root):
//   npx tsx scripts/frame-calibration/calibrate.js [--visits N] [--json FILE]
//     [--katago BIN] [--model FILE] [--case NAME]
//
// Needs KataGo (default ~/.local/bin/katago) and a network (default
// ~/.local/share/katago/models/b10c384h6nbttflrs.bin.gz). Not part of npm test.

import {spawn} from 'child_process'
import {writeFileSync} from 'fs'
import {homedir} from 'os'
import {dirname, join} from 'path'
import {createInterface} from 'readline'
import {fileURLToPath} from 'url'

import {
  applyTsumegoFrame,
  getTsumegoFrame,
} from '../../src/modules/tsumegoframe.js'
import {caseSignMap, cases} from './cases.js'

const here = dirname(fileURLToPath(import.meta.url))
const alpha = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

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
    visits: 500,
    json: null,
    katago: join(homedir(), '.local/bin/katago'),
    model: join(
      homedir(),
      '.local/share/katago/models/b10c384h6nbttflrs.bin.gz',
    ),
    config: join(here, 'analysis.cfg'),
    case: null,
  }

  for (let i = 0; i < argv.length; i++) {
    let key = argv[i].replace(/^--/, '')
    if (!(key in args)) throw new Error(`unknown option ${argv[i]}`)
    args[key] = key === 'visits' ? Number(argv[++i]) : argv[++i]
  }

  return args
}

function coord([x, y], size) {
  return `${alpha[x]}${size - y}`
}

function stonesOf(signMap) {
  let size = signMap.length
  let stones = []

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sign = signMap[y][x]
      if (sign !== 0) stones.push([sign > 0 ? 'B' : 'W', coord([x, y], size)])
    }
  }

  return stones
}

// A long-lived analysis engine; query() resolves with the final response.
function startEngine({katago, config, model}) {
  let child = spawn(katago, ['analysis', '-config', config, '-model', model], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let pending = new Map()
  let lines = createInterface({input: child.stdout})

  lines.on('line', (line) => {
    let response = JSON.parse(line)
    let entry = pending.get(response.id)
    if (entry == null) return

    pending.delete(response.id)
    if (response.error != null) entry.reject(new Error(response.error))
    else entry.resolve(response)
  })

  return {
    query(request) {
      return new Promise((resolve, reject) => {
        pending.set(request.id, {resolve, reject})
        child.stdin.write(JSON.stringify(request) + '\n')
      })
    },
    close() {
      child.stdin.end()
    },
  }
}

// Ownership (Black's view, row-major from the top) summed into regions by
// distance from the window: 0 window, 1 gap, 2 or more frame. Points count as
// owned when the engine is more than half sure.
function ownershipByRegion(ownership, window, size, defender) {
  let {rangeX, rangeY} = window
  let regions = {}

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d = Math.max(
        rangeX[0] - x,
        x - rangeX[1],
        rangeY[0] - y,
        y - rangeY[1],
        0,
      )
      let name = d === 0 ? 'window' : d === 1 ? 'gap' : 'frame'
      let own = ownership[y * size + x] * defender
      let region = (regions[name] ??= {defender: 0, attacker: 0, neutral: 0})

      if (own > 0.5) region.defender++
      else if (own < -0.5) region.attacker++
      else region.neutral++
    }
  }

  return regions
}

async function main() {
  let args = parseArgs(process.argv.slice(2))
  let engine = startEngine(args)
  let size = 19
  let jobs = []

  for (let c of cases) {
    if (args.case != null && c.name !== args.case) continue

    for (let defender of [1, -1]) {
      let attacker = -defender
      let start = caseSignMap(c, defender, size)
      let frame = getTsumegoFrame(start, {attacker, toPlay: defender})
      let [vx, vy] = c.vital
      let settled = (sign) => {
        let map = start.map((row) => [...row])
        map[vy][vx] = sign
        return applyTsumegoFrame(frame, start, map)
      }
      let positions = {
        problem: {signMap: frame.signMap, toPlay: defender},
        alive: {signMap: settled(defender), toPlay: attacker},
        dead: {signMap: settled(attacker), toPlay: defender},
      }
      let label = `${c.name}/${defender > 0 ? 'B' : 'W'}`

      let queries = Object.entries(positions).map(([kind, {signMap, toPlay}]) =>
        engine
          .query({
            id: `${label}/${kind}`,
            initialStones: stonesOf(signMap),
            initialPlayer: toPlay > 0 ? 'B' : 'W',
            moves: [],
            rules,
            komi: frame.komi,
            boardXSize: size,
            boardYSize: size,
            maxVisits: args.visits,
            includeOwnership: true,
          })
          .then((response) => [kind, response]),
      )

      jobs.push(
        Promise.all(queries).then((responses) => {
          let result = {
            case: c.name,
            defender: defender > 0 ? 'B' : 'W',
            defenderStones: c.rows.join('').split('X').length - 1,
            window: frame.window,
            windowSize:
              (frame.window.rangeX[1] - frame.window.rangeX[0] + 1) *
              (frame.window.rangeY[1] - frame.window.rangeY[0] + 1),
            komi: frame.komi,
          }

          for (let [kind, response] of responses) {
            let lead = response.rootInfo.scoreLead * defender
            result[kind] = {
              lead: round(lead),
              best: response.moveInfos[0]?.move,
              regions: ownershipByRegion(
                response.ownership,
                frame.window,
                size,
                defender,
              ),
            }
          }

          let mid = (result.alive.lead + result.dead.lead) / 2
          result.error = round(mid)
          result.gap = round(result.alive.lead - result.dead.lead)
          result.idealKomi = round(frame.komi + mid * defender)

          return result
        }),
      )
    }
  }

  let results = await Promise.all(jobs)
  engine.close()

  console.log(
    [
      'case'.padEnd(16),
      'def',
      'stones',
      'win',
      'komi'.padStart(6),
      'alive'.padStart(7),
      'dead'.padStart(7),
      'error'.padStart(7),
      'gap'.padStart(6),
      'ideal'.padStart(7),
      ' alive window d/a/n',
    ].join(' '),
  )

  for (let r of results) {
    let w = r.alive.regions.window
    console.log(
      [
        r.case.padEnd(16),
        r.defender.padStart(3),
        String(r.defenderStones).padStart(6),
        String(r.windowSize).padStart(3),
        String(r.komi).padStart(6),
        String(r.alive.lead).padStart(7),
        String(r.dead.lead).padStart(7),
        String(r.error).padStart(7),
        String(r.gap).padStart(6),
        String(r.idealKomi).padStart(7),
        ` ${w.defender}/${w.attacker}/${w.neutral}`,
      ].join(' '),
    )
  }

  if (args.json != null) {
    writeFileSync(args.json, JSON.stringify(results, null, 2) + '\n')
  }
}

function round(x) {
  return Math.round(x * 10) / 10
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
