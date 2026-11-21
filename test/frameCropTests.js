import assert from 'assert'

import {
  transformRange,
  transformVertex,
} from '../src/modules/gobantransformer.js'

// Backs the crop to the tsumego frame's window (baduk D5, kata 6pvj): the
// window is in board coordinates and Goban needs it in transformed ones.
describe('transformRange', () => {
  const transformations = ['', 'r', 'rr', 'rrr', 'f', 'rf', 'rrf', 'rrrf']

  it('keeps the whole board as the whole board', () => {
    assert.deepStrictEqual(transformRange({}, 'r', 19, 19), {})
  })

  it('leaves a range alone without a transformation', () => {
    let range = {rangeX: [0, 7], rangeY: [0, 5]}
    assert.deepStrictEqual(transformRange(range, '', 19, 19), range)
    assert.deepStrictEqual(transformRange(range, 'i', 19, 19), range)
  })

  it('moves a corner range with a rotation or flip', () => {
    let range = {rangeX: [0, 7], rangeY: [0, 5]}
    // Clockwise rotation maps (x, y) to (18 - y, x)
    assert.deepStrictEqual(transformRange(range, 'r', 19, 19), {
      rangeX: [13, 18],
      rangeY: [0, 7],
    })
    // Horizontal flip maps (x, y) to (18 - x, y)
    assert.deepStrictEqual(transformRange(range, 'f', 19, 19), {
      rangeX: [11, 18],
      rangeY: [0, 5],
    })
  })

  for (let [width, height] of [
    [19, 19],
    [13, 7],
  ]) {
    it(`covers exactly the transformed points on ${width}x${height}`, () => {
      let range = {rangeX: [1, 4], rangeY: [2, 5]}

      for (let transformation of transformations) {
        let {rangeX, rangeY} = transformRange(
          range,
          transformation,
          width,
          height,
        )
        let inside = ([x, y]) =>
          rangeX[0] <= x && x <= rangeX[1] && rangeY[0] <= y && y <= rangeY[1]

        for (let x = range.rangeX[0]; x <= range.rangeX[1]; x++) {
          for (let y = range.rangeY[0]; y <= range.rangeY[1]; y++) {
            let v = transformVertex([x, y], transformation, width, height)
            assert.ok(inside(v), `${transformation}: ${[x, y]} -> ${v}`)
          }
        }

        let area = (rangeX[1] - rangeX[0] + 1) * (rangeY[1] - rangeY[0] + 1)
        assert.strictEqual(area, 16, transformation)
      }
    })
  }
})
