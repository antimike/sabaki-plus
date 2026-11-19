import assert from 'assert'
import * as sgf from '@sabaki/sgf'

import * as gametree from '../src/modules/gametree.js'
import {transformVertex} from '../src/modules/gobantransformer.js'
import {getId} from '../src/modules/utils.js'

// Backs the board crop to the SGF VW (view) property in Goban. Ranges are in
// transformed coordinates, because BoundedGoban draws the transformed board.
describe('getViewRange', () => {
  const transformations = ['', 'r', 'rr', 'rrr', 'f', 'rf', 'rrf', 'rrrf']

  let load = (content) => {
    let [root] = sgf.parse(content, {getId})
    return gametree.new({root})
  }

  // Root VW crops the top-left corner (columns a-f, rows a-e); the first child
  // inherits it, the second resets it with VW[], and the third sets its own.
  let tree = load(
    '(;SZ[19]VW[aa:fe];B[cc](;W[dd];B[ee])(;VW[];W[pp];B[qq])(;VW[ss][rr];W[rs]))',
  )
  let root = tree.root
  let ids = (path) => path.reduce((node, i) => node.children[i], root).id
  let range = (id, transformation = '') =>
    gametree.getViewRange(tree, id, gametree.getBoard(tree, id), transformation)

  it('crops to the VW rectangle', () => {
    assert.deepStrictEqual(range(root.id), {rangeX: [0, 5], rangeY: [0, 4]})
  })

  it('inherits VW from the nearest ancestor', () => {
    assert.deepStrictEqual(range(ids([0, 0, 0])), {
      rangeX: [0, 5],
      rangeY: [0, 4],
    })
  })

  it('shows the whole board after an empty VW[] reset', () => {
    assert.deepStrictEqual(range(ids([0, 1])), {})
    assert.deepStrictEqual(range(ids([0, 1, 0])), {})
  })

  it('takes the bounding box of several VW values', () => {
    assert.deepStrictEqual(range(ids([0, 2, 0])), {
      rangeX: [17, 18],
      rangeY: [17, 18],
    })
  })

  it('shows the whole board without VW', () => {
    let plain = load('(;SZ[19];B[dd])')
    let board = gametree.getBoard(plain, plain.root.id)
    assert.deepStrictEqual(
      gametree.getViewRange(plain, plain.root.id, board),
      {},
    )
  })

  it('ignores VW points outside the board', () => {
    let small = load('(;SZ[9]VW[aa:cc][zz])')
    let board = gametree.getBoard(small, small.root.id)
    assert.deepStrictEqual(gametree.getViewRange(small, small.root.id, board), {
      rangeX: [0, 2],
      rangeY: [0, 2],
    })
  })

  it('moves the crop with a rotation or flip', () => {
    // Clockwise rotation maps (x, y) to (18 - y, x)
    assert.deepStrictEqual(range(root.id, 'r'), {
      rangeX: [14, 18],
      rangeY: [0, 5],
    })
    // Horizontal flip maps (x, y) to (18 - x, y)
    assert.deepStrictEqual(range(root.id, 'f'), {
      rangeX: [13, 18],
      rangeY: [0, 4],
    })
    // Color inversion does not move anything
    assert.deepStrictEqual(range(root.id, 'i'), range(root.id))
  })

  for (let content of ['(;SZ[19]VW[cb:hn])', '(;SZ[13:7]VW[bc:fd])']) {
    it(`keeps exactly the VW points visible under all transformations: ${content}`, () => {
      let t = load(content)
      let board = gametree.getBoard(t, t.root.id)
      let points = sgf.parseCompressedVertices(t.root.data.VW[0])

      for (let transformation of transformations) {
        let {rangeX, rangeY} = gametree.getViewRange(
          t,
          t.root.id,
          board,
          transformation,
        )
        let inside = ([x, y]) =>
          rangeX[0] <= x && x <= rangeX[1] && rangeY[0] <= y && y <= rangeY[1]

        for (let point of points) {
          let v = transformVertex(
            point,
            transformation,
            board.width,
            board.height,
          )
          assert.ok(inside(v), `${transformation}: ${point} -> ${v} outside`)
        }

        let area = (rangeX[1] - rangeX[0] + 1) * (rangeY[1] - rangeY[0] + 1)
        assert.strictEqual(area, points.length, transformation)
      }
    })
  }
})
