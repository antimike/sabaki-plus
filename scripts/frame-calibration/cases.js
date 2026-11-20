// Calibration positions for the tsumego frame's komi. All written for this
// check; none is taken from a published collection.
//
// Each case is a group whose life hangs on one vital point: an eye space of
// three in a row. The defender playing it lives; the attacker playing it kills.
// Rows use 'X' for the defender, 'O' for the attacker and '.' for empty, placed
// on a board of `size` (default 19) with their top-left corner at [left, top].

export const cases = [
  {
    // The position from baduk kata cgbq: straight three on the top edge.
    name: 'corner-small',
    left: 0,
    top: 0,
    rows: ['...XO', 'XXXXO', 'OOOOO'],
    vital: [1, 0],
  },
  {
    name: 'corner-large',
    left: 0,
    top: 0,
    rows: ['...XXXXXO', 'XXXXXXXXO', 'XXXXXXXXO', 'OOOOOOOOO'],
    vital: [1, 0],
  },
  {
    // The same group with loose attacker stones farther out, as in a problem
    // set up from the 4-4 point: the window grows past what the territory
    // behind the wall can balance, so komi has to.
    name: 'corner-wide',
    left: 0,
    top: 0,
    rows: [
      '...XO.....',
      'XXXXO.....',
      'OOOOO...O.',
      '..........',
      '..........',
      '..........',
      '.......O..',
      '..O.......',
    ],
    vital: [1, 0],
  },
  {
    // Wider still: the window is 13x13, near the half-board limit.
    name: 'corner-wider',
    left: 0,
    top: 0,
    rows: [
      '...XO.....',
      'XXXXO.....',
      'OOOOO...O.',
      '..........',
      '..........',
      '..........',
      '.......O..',
      '..O.......',
      '..........',
      '..........',
      '..........O',
    ],
    vital: [1, 0],
  },
  {
    name: 'corner-13x13',
    size: 13,
    left: 0,
    top: 0,
    rows: ['...XO', 'XXXXO', 'OOOOO'],
    vital: [1, 0],
  },
  {
    name: 'side-small',
    left: 6,
    top: 0,
    rows: ['OX...XO', 'OXXXXXO', 'OOOOOOO'],
    vital: [9, 0],
  },
  {
    name: 'side-large',
    left: 2,
    top: 0,
    rows: [
      'OXXXXX...XXXXXO',
      'OXXXXXXXXXXXXXO',
      'OXXXXXXXXXXXXXO',
      'OOOOOOOOOOOOOOO',
    ],
    vital: [9, 0],
  },
  {
    name: 'centre-small',
    left: 6,
    top: 7,
    rows: ['OOOOOOO', 'OXXXXXO', 'OX...XO', 'OXXXXXO', 'OOOOOOO'],
    vital: [9, 9],
  },
  {
    // As large as a centre problem gets before the window (box plus margin)
    // comes within the wall's reach of the edges and is pushed out to them.
    name: 'centre-large',
    left: 6,
    top: 6,
    rows: [
      'OOOOOOO',
      'OXXXXXO',
      'OXXXXXO',
      'OX...XO',
      'OXXXXXO',
      'OXXXXXO',
      'OOOOOOO',
    ],
    vital: [9, 9],
  },
]

/**
 * The case's position as a signMap, with the defender as `defender` (1 Black,
 * -1 White).
 */
export function caseSignMap({rows, left, top, size = 19}, defender) {
  let map = Array.from({length: size}, () => Array(size).fill(0))

  rows.forEach((row, dy) => {
    ;[...row].forEach((c, dx) => {
      if (c === 'X') map[top + dy][left + dx] = defender
      if (c === 'O') map[top + dy][left + dx] = -defender
    })
  })

  return map
}
