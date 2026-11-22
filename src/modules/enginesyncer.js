import EventEmitter from 'events'
import {existsSync} from 'fs'
import {dirname, resolve} from 'path'
import argvsplit from 'argv-split'
import {v4 as uuid} from 'uuid'

import {fromDimensions as newBoard} from '@sabaki/go-board'
import {Controller, ControllerStateTracker, Command} from '@sabaki/gtp'
import {parseCompressedVertices} from '@sabaki/sgf'

import i18n from '../i18n.js'
import {getBoard, getRootProperty} from './gametree.js'
import {noop, equals} from './helper.js'
import {parseAnalysis} from './analysis.js'
import {restrictAnalysisToWindow} from './tsumegoframe.js'

const t = i18n.context('EngineSyncer')
const setting = {
  get: (key) => window.sabaki.setting.get(key),
}

const alpha = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

// Rules for a framed position: the frame's komi assumes area scoring. No
// handicap bonus, because KataGo may count the frame's opening run of Black
// stones as handicap stones.
const frameRules = JSON.stringify({
  scoring: 'AREA',
  ko: 'SIMPLE',
  tax: 'NONE',
  suicide: false,
  hasButton: false,
  whiteHandicapBonus: '0',
  friendlyPassOk: true,
})
const quitTimeout = setting.get('gtp.engine_quit_timeout')

function parseVertex(coord, size) {
  if (coord == null || coord === 'resign') return null
  if (coord === 'pass') return [-1, -1]

  let x = alpha.indexOf(coord[0].toUpperCase())
  let y = size - +coord.slice(1)

  return [x, y]
}

export default class EngineSyncer extends EventEmitter {
  constructor(engine) {
    super()

    let {path, args, commands} = engine

    this._busy = false
    this._suspended = true
    this._analysis = null
    this._rules = null
    this._defaultRules = null

    this.id = uuid()
    // The window of the hidden tsumego frame in the synced position, or null
    // when the position was synced without a frame.
    this.analysisWindow = null
    this.engine = engine
    this.commands = []
    this.treePosition = null

    let absolutePath = resolve(path)
    let executePath = existsSync(absolutePath) ? absolutePath : path
    let executeArgs = [...argvsplit(args)]

    // In a Flatpak sandbox, host engine binaries can't be run directly; route
    // them through flatpak-spawn --host, preserving the working directory.
    if (process.env.FLATPAK_ID != null) {
      executeArgs = [
        '--host',
        `--directory=${dirname(absolutePath)}`,
        executePath,
        ...executeArgs,
      ]
      executePath = 'flatpak-spawn'
    }

    this.controller = new Controller(executePath, executeArgs, {
      cwd: dirname(absolutePath),
    })

    this.stateTracker = new ControllerStateTracker(this.controller)

    this.controller.on('started', () => {
      this.treePosition = null
      this.analysis = null
      this._rules = null
      this._defaultRules = null

      Promise.all([
        this.controller.sendCommand({name: 'name'}),
        this.controller.sendCommand({name: 'version'}),
        this.controller.sendCommand({name: 'protocol_version'}),
        this.controller
          .sendCommand({name: 'list_commands'})
          .then((response) => {
            this.commands = response.content.split('\n')
          }),
        ...(commands != null && commands.trim() !== ''
          ? commands
              .split(';')
              .filter((x) => x.trim() !== '')
              .map((command) =>
                this.controller.sendCommand(Command.fromString(command)),
              )
          : []),
      ]).catch(noop)
    })

    this.controller.on('stopped', () => {
      this.treePosition = null
      this.analysis = null
    })

    this.controller.on(
      'command-sent',
      async ({command, subscribe, getResponse}) => {
        if (
          command.name.match(/^(lz-)?(genmove_)?analyze$/) != null ||
          command.args.length > 0
        ) {
          // Handle analysis commands

          let sign = command.args[0].toUpperCase() === 'W' ? -1 : 1
          let boardsize = this.stateTracker.state.boardsize || [19, 19]
          let board = newBoard(...boardsize)
          // kata-analyze reports a float winrate; lz-analyze/analyze report an
          // integer in ten-thousandths.
          let winrateFormat = command.name.startsWith('kata')
            ? 'float'
            : 'integer'
          let analysisWindow = this.analysisWindow

          subscribe(({line}) => {
            // Parse analysis info

            if (line.startsWith('info ')) {
              let allVariations = parseAnalysis(line, board, winrateFormat)
              // Ignore an update with no parseable variations rather than let
              // Math.max(...[]) === -Infinity become a non-finite SBKV.
              if (allVariations.length === 0) return

              // Fork (baduk 899v): the position's winrate and score come from
              // every candidate, so they stay right when the best move is
              // outside the window (a frame ko threat, or a pass); only the
              // candidates shown are kept inside it.
              let variations =
                analysisWindow != null
                  ? restrictAnalysisToWindow(allVariations, analysisWindow)
                  : allVariations

              this.analysis = {
                sign,
                variations,
                winrate: Math.max(...allVariations.map(({winrate}) => winrate)),
                scoreLead: Math.max(
                  ...allVariations.map(({scoreLead}) =>
                    scoreLead == null ? NaN : scoreLead,
                  ),
                ),
              }
            } else if (line.startsWith('play ')) {
              sign = -sign

              this.analysis = null
              this.treePosition = null
            }
          })
        } else if (this.treePosition != null) {
          // Invalidate treePosition

          let prevHistory = JSON.parse(
            JSON.stringify(this.stateTracker.state.history),
          )

          await getResponse()

          if (!equals(prevHistory, this.stateTracker.state.history)) {
            this.treePosition = null
            this.analysis = null
          }
        }
      },
    )

    // Sync properties

    for (let eventName of [
      'started',
      'stopped',
      'command-sent',
      'response-received',
    ]) {
      this.controller.on(eventName, () => {
        this.busy = this.controller.busy
        this.suspended = this.controller.process == null
      })
    }
  }

  get state() {
    return this.stateTracker.state
  }

  get busy() {
    return this._busy
  }

  set busy(value) {
    if (value !== this._busy) {
      this._busy = value
      this.emit('busy-changed')
    }
  }

  get suspended() {
    return this._suspended
  }

  set suspended(value) {
    if (value !== this._suspended) {
      this._suspended = value
      this.emit('suspended-changed')
    }
  }

  get analysis() {
    return this._analysis
  }

  set analysis(value) {
    if (value !== this._analysis) {
      this._analysis = value
      this.emit('analysis-update')
    }
  }

  start() {
    this.controller.start()
  }

  async stop() {
    await this.controller.stop(quitTimeout)
  }

  async sendAbort() {
    if (this.controller.busy) {
      try {
        await this.controller.sendCommand({name: 'protocol_version'})
      } catch (err) {
        // Best-effort interrupt: callers don't await this, so swallow the
        // rejection when the engine has already stopped.
      }
    }
  }

  async queueCommand(...args) {
    this.sendAbort()
    return await this.stateTracker.queueCommand(...args)
  }

  // Sets the engine's rules (KataGo only): a kata-set-rules argument, or null
  // for the rules the engine started with.
  async _setRules(rules) {
    if (!(await this.stateTracker.knowsCommand('kata-set-rules'))) return

    if (this._defaultRules == null) {
      let response = await this.stateTracker.queueCommand({
        name: 'kata-get-rules',
      })
      if (response == null || response.error) return

      this._defaultRules = response.content.trim()
      this._rules = this._defaultRules
    }

    if (rules == null) rules = this._defaultRules
    if (rules === this._rules) return

    let response = await this.stateTracker.queueCommand({
      name: 'kata-set-rules',
      args: [rules],
    })

    if (response == null || response.error) {
      // Rules the engine doesn't know (an unusual RU): use its own.
      if (rules !== this._defaultRules) return await this._setRules(null)
      return
    }

    this._rules = rules
  }

  /**
   * Sync the engine to the position at `id`.
   *
   * With `frame` (from applyTsumegoFrame and getTsumegoFrame), the engine gets
   * the framed position, the frame's komi and area rules; its analysis is kept
   * inside `frame.window`. Without it, the engine gets the position as it is,
   * with the game's komi and rules.
   *
   * @param {object} [options.frame] - {signMap, frameVertices, komi, window},
   *   where signMap is the framed position at `id`
   */
  async sync(tree, id, {frame = null} = {}) {
    this.sendAbort()
    let board = getBoard(tree, id)

    if (!board.isValid()) {
      throw new Error(t('GTP engines don’t support invalid board positions.'))
    } else if (Math.max(board.width, board.height) > alpha.length) {
      throw new Error(
        t(
          (p) =>
            `GTP engines only support board sizes that don’t exceed ${p.length}.`,
          {
            length: alpha.length,
          },
        ),
      )
    }

    let komi = +getRootProperty(tree, 'KM', 0)
    let rules = getRootProperty(tree, 'RU')
    let boardsize = [board.width, board.height]

    // Replay

    let nodeBoard = getBoard(tree, id)
    let engineBoard = newBoard(board.width, board.height)
    let history = []
    let boardSynced = true

    if (frame != null) {
      // Frame stones first, then the game as usual. The frame never touches
      // the problem's stones, so they can be played in any order.

      board = board.clone()
      for (let [x, y] of frame.frameVertices) {
        board.set([x, y], frame.signMap[y][x])
      }
      nodeBoard = board

      for (let vertex of frame.frameVertices) {
        let sign = board.get(vertex)

        history.push({
          name: 'play',
          args: [sign > 0 ? 'B' : 'W', board.stringifyVertex(vertex)],
        })
        engineBoard = engineBoard.makeMove(sign, vertex)
      }

      komi = frame.komi
      rules = frameRules
    } else if (rules != null) {
      rules = rules.trim().toLowerCase().replace(/\s+/g, '-')
    }
    let nodes = [...tree.listNodesVertically(id, -1, {})].reverse()

    for (let node of nodes) {
      let placedHandicapStones = false

      if (
        node.data.AB &&
        node.data.AB.length >= 2 &&
        engineBoard.isEmpty() &&
        (await this.stateTracker.knowsCommand('set_free_handicap'))
      ) {
        // Place handicap stones

        let vertices = []
          .concat(...node.data.AB.map(parseCompressedVertices))
          .sort()
        let coords = vertices
          .map((v) => board.stringifyVertex(v))
          .filter((x) => x != null)
          .filter((x, i, arr) => i === 0 || x !== arr[i - 1])

        if (coords.length > 0) {
          history.push({name: 'set_free_handicap', args: coords})

          for (let vertex of vertices) {
            if (engineBoard.get(vertex) !== 0) continue

            engineBoard = engineBoard.makeMove(1, vertex)
          }

          placedHandicapStones = true
        }
      }

      for (let prop of ['B', 'W', 'AB', 'AW']) {
        if (node.data[prop] == null || (placedHandicapStones && prop === 'AB'))
          continue

        let color = prop.slice(-1)
        let sign = color === 'B' ? 1 : -1
        let vertices = [].concat(
          ...node.data[prop].map(parseCompressedVertices),
        )

        for (let vertex of vertices) {
          if (engineBoard.has(vertex) && engineBoard.get(vertex) !== 0) continue

          let coord = !engineBoard.has(vertex)
            ? 'pass'
            : board.stringifyVertex(vertex)

          history.push({name: 'play', args: [color, coord]})
          engineBoard = engineBoard.makeMove(sign, vertex)
        }
      }
    }

    if (!equals(engineBoard.signMap, nodeBoard.signMap)) {
      boardSynced = false
    }

    // Incremental rearrangement

    if (!boardSynced) {
      history = [...this.state.history]
      engineBoard = newBoard(board.width, board.height)

      for (let command of this.state.history) {
        if (command.name === 'play') {
          let [color, coord] = command.args
          let sign = color.toUpperCase() === 'B' ? 1 : -1

          engineBoard = engineBoard.makeMove(
            sign,
            parseVertex(coord, boardsize),
          )
        } else if (command.name === 'set_free_handicap') {
          for (let coord of command.args) {
            engineBoard = engineBoard.makeMove(1, parseVertex(coord, boardsize))
          }
        }
      }

      let diff = engineBoard.diff(board).filter((v) => board.get(v) !== 0)

      for (let vertex of diff) {
        let sign = board.get(vertex)
        let color = sign > 0 ? 'B' : 'W'
        let coord = board.stringifyVertex(vertex)

        history.push({name: 'play', args: [color, coord]})
        engineBoard = engineBoard.makeMove(sign, vertex)
      }

      if (equals(engineBoard.signMap, board.signMap)) {
        boardSynced = true
      }
    }

    // Complete rearrangement

    if (!boardSynced) {
      history = []
      engineBoard = newBoard(board.width, board.height)

      for (let x = 0; x < board.width; x++) {
        for (let y = 0; y < board.height; y++) {
          let vertex = [x, y]
          let sign = board.get(vertex)
          let color = sign > 0 ? 'B' : 'W'
          if (sign === 0) continue

          history.push({
            name: 'play',
            args: [color, board.stringifyVertex(vertex)],
          })
          engineBoard = engineBoard.makeMove(sign, vertex)
        }
      }

      if (equals(engineBoard.signMap, board.signMap)) {
        boardSynced = true
      }
    }

    if (!boardSynced) {
      throw new Error(
        t('Current board arrangement can’t be recreated on the GTP engine.'),
      )
    }

    try {
      await this._setRules(rules || null)
      await this.stateTracker.sync({komi, boardsize, history})
    } catch (err) {
      throw new Error(t('GTP engine can’t be synced to current state.'))
    }

    this.treePosition = id
    this.analysisWindow = frame != null ? frame.window : null
    this.analysis = null
  }
}
