const fs = require('fs')
const path = require('path')
const {expect} = require('@playwright/test')
const {test} = require('./fixtures/electron-app')
const {runAttackerCheck} = require('./helpers')

// Fork-only (baduk kata 9cd1): engine checks on problems that cannot be
// fixtures here (copyrighted books, licensed sites). Nothing is copied into
// this repo: SABAKI_PRIVATE_PROBLEMS names a directory outside it holding
// `expected.json`, and each entry points at a problem file by a path relative
// to that directory. Skipped unless both it and SABAKI_E2E_KATAGO are set.
//
// expected.json:
//
//   {"problems": [
//     {"file": "path/to/problem.sgf" | "path/to/sanderland.json",
//      "attacker": "B" | "W",      the right attacker, checked by hand
//      "note": "...",              why, for the reader
//      "fails": "..."}             optional: a known miss, run as an expected
//                                  failure; an unexpected pass means it was
//                                  fixed and the entry should lose "fails"
//   ]}
//
// SGF files need at least one move after the root (the load helper waits for
// one); sanderland JSON is turned into SGF with its first SOL move.

const KATAGO = process.env.SABAKI_E2E_KATAGO
const KATAGO_ARGS = process.env.SABAKI_E2E_KATAGO_ARGS || ''
const DIR = process.env.SABAKI_PRIVATE_PROBLEMS

function readManifest() {
  if (!DIR) return []
  let manifest = JSON.parse(
    fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'),
  )
  return manifest.problems
}

// A sanderland problem as SGF: setup stones, comment, first SOL move.
function sanderlandToSgf(data) {
  let size = data.SZ ?? '19'
  let list = (points) => points.map((p) => `[${p}]`).join('')
  let [color, point] = data.SOL[0]
  let escape = (text) => text.replace(/\\/g, '\\\\').replace(/]/g, '\\]')

  return (
    `(;GM[1]FF[4]SZ[${size}]PL[${color}]` +
    `AB${list(data.AB)}AW${list(data.AW)}C[${escape(data.C ?? '')}]` +
    `;${color}[${point}])`
  )
}

function loadProblem(file) {
  let text = fs.readFileSync(path.resolve(DIR, file), 'utf8')
  return file.endsWith('.json') ? sanderlandToSgf(JSON.parse(text)) : text
}

test.describe('private problems: engine check of the attacker', () => {
  test.skip(
    !KATAGO || !DIR,
    'set SABAKI_E2E_KATAGO and SABAKI_PRIVATE_PROBLEMS to run',
  )
  test.setTimeout(180000)

  for (let entry of readManifest()) {
    test(`${entry.attacker} attacks: ${entry.file}`, async ({page}) => {
      test.fail(!!entry.fails, entry.fails)

      let {frameAttacker} = await runAttackerCheck(
        page,
        loadProblem(entry.file),
        {
          name: 'KataGo',
          path: KATAGO,
          args: KATAGO_ARGS,
        },
      )

      expect(frameAttacker).toBe(entry.attacker === 'B' ? 1 : -1)
    })
  }
})
