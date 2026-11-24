# sabaki-plus

A fork of [Sabaki](https://github.com/SabakiHQ/Sabaki) for solving and studying
tsumego collections. Plans, decisions and issues live outside this repo, in the
`baduk` project (its `docs/roadmap.md` and `docs/decisions.md`, D1 and D7).

## Branches and remotes

- `origin` is `antimike/sabaki-plus`; `upstream` is `SabakiHQ/Sabaki`.
- `master` mirrors `upstream/master` and carries no fork commits.
- Changes that upstream could use (for example the `VW` crop and the argv fix)
  go on their own topic branch off `master`, so they can be sent as upstream
  pull requests unchanged. Fork-only work branches off `plus`.
- `plus` is the fork's working branch: it merges the topic branches and holds
  fork-only changes such as this file.

To take in new upstream work:

```
git fetch upstream
git switch master && git merge --ff-only upstream/master
git switch plus && git merge master
```

## Build and run

Upstream's [Building & Tests](docs/guides/building-tests.md) guide covers the
general case. This is the sequence checked on Fedora 44 with Node 22.22.2:

```
npm ci
node node_modules/electron/install.js    # see note 1
npx webpack --mode development           # or `npm run watch` while editing
npx electron . path/to/collection.sgf    # or `npm start` for an empty board
npm test                                 # mocha unit tests
npm run test:e2e                         # Playwright; needs xvfb-run on Linux
```

Notes:

1. `npm ci` may leave the Electron binary undownloaded. The first `npx electron`
   then downloads it (about 40 s), which is easy to mistake for a hang. Running
   `install.js` once fetches it up front.
2. On Wayland, Electron prints a harmless Vulkan/ozone error line on stderr; the
   window renders fine.
3. Under a Wayland session, `xvfb-run` alone does not hide the test windows:
   Electron still picks Wayland from `WAYLAND_DISPLAY` or `XDG_SESSION_TYPE`.
   For a run that stays off screen, unset both:
   `env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE npm run test:e2e` (50 tests
   passed this way on 2026-11-19).
4. Before the argv fix (branch `fix/argv-dot-slash`), `electron ./` and
   therefore `npm start` treated `./` as the file to open. With the fix both `.`
   and `./` work.
5. `e2e/frame-analysis.spec.js` runs a real KataGo and is skipped unless
   `SABAKI_E2E_KATAGO` names the binary; `SABAKI_E2E_KATAGO_ARGS` holds its
   arguments, for example
   `gtp -model ~/.local/share/katago/models/<net>.bin.gz -config ~/.config/katago/gtp.cfg`
   (expand `~` yourself). It takes about 15 s on a Quadro T1000 with OpenCL.
   `e2e/frame-auto-attacker.spec.js` needs the same variables.
6. `e2e/private-problems.spec.js` runs the engine's attacker check on problems
   that cannot be fixtures here (copyrighted or licensed). It also needs
   `SABAKI_PRIVATE_PROBLEMS`, a directory outside this repo with an
   `expected.json` that points at the problems; the format is in the spec's
   header. MH's is `~/Documents/baduk/private-tests`.

## Settings folder: apart from an installed Sabaki

`productName` is still `Sabaki`, which would put the fork's settings in the
same folder as an installed Sabaki (`~/.config/Sabaki` on Linux), engines list
included. So `src/main.js` sets Electron's `userData` to
`<appData>/sabaki-tsumego` (`~/.config/sabaki-tsumego`) before anything reads
settings. `e2e/settings-folder.spec.js` checks it. A full rename (productName,
window class, About text) is left for the decision on keeping the fork.

An explicit `--user-data-dir` still wins, for a throwaway folder in a dev run:

```
npx electron . --user-data-dir="$HOME/.config/sabaki-plus-dev" path/to/file.sgf
```

`--user-data-dir` sets the folder itself (no subfolder is added), and
upstream's e2e fixture uses it the same way.

## Desktop entry: a built snapshot of plus

For daily use the fork is installed as "Sabaki Tsumego" in the app launcher:

```
npm run install:desktop             # build plus and install the snapshot
npm run install:desktop -- --check  # is the installed snapshot behind plus?
```

`scripts/install-desktop.mjs` builds with `npm run build` (electron-builder
`--dir`), copies `dist/linux-unpacked` to `~/.local/lib/sabaki-tsumego`, and
writes `~/.local/share/applications/sabaki-tsumego.desktop`. `BUILT_FROM` in
that folder records the commit. It builds only from a clean `plus`, so the
launcher runs merged work; feature branches built later do not touch it.

**Re-run it after every merge into plus.** The fork has no version numbers of
its own yet (the version is upstream's; kata p751 decides), so "a new release"
means a new `plus` tip, and `--check` says when the snapshot is behind.

The entry registers `.sgf` as `application/x-go-sgf` (shared-mime-info's SGF
type, never `text/plain`). `src/main.js` calls
`app.setDesktopName('sabaki-tsumego.desktop')`, so on Wayland the window's
app_id is `sabaki-tsumego`, not upstream's `sabaki`, and matches the entry's
`StartupWMClass`. Under X11 the WM_CLASS still comes from `productName`.

## KataGo engine

Local analysis uses KataGo over GTP (`kata-analyze`), set up like any Sabaki
engine under Preferences → Engines. KataGo, its nets and its GTP config are
installed and pinned by MH's dotfiles (chezmoi), not by this repo. The setup
checked on 2026-11-20 (Fedora 44, Quadro T1000 4 GB, NVIDIA 615.78, OpenCL 3.0):

| Field | Value |
|---|---|
| Name | `KataGo v1.18.1 OpenCL` |
| Path | `~/.local/bin/katago` (written out in full) |
| Arguments | `gtp -model ~/.local/share/katago/models/b10c384h6nbttflrs.bin.gz -config ~/.config/katago/gtp.cfg` (paths written out in full) |

Sabaki starts the engine without a shell, so `~` and `$HOME` are not expanded:
write absolute paths.

Notes:

1. **Not an AppImage.** `~/.local/bin/katago` is a stable link to KataGo's
   release AppImage, extracted once at install time, so AppImageLauncher never
   sees it: no "integrate this AppImage?" dialog, which nobody could answer
   under xvfb. A version bump moves the payload but keeps this path.
2. **Config.** `~/.config/katago/gtp.cfg`: Japanese rules, 4 search threads,
   GTP logs in `~/.local/state/katago/gtp_logs/`.
3. **Speed.** On the T1000, `b10c384h6nbttflrs` (KaTrain's default net, about
   10.5 M parameters) loads in under a second with the cached OpenCL tuning and
   reaches about 72 visits/s in Sabaki's analysis. `katago benchmark -t
   4,8,12,16,24` showed the GPU saturating at about 70 network evaluations/s:
   16 threads gave 85 visits/s against 77 for 4, and KataGo's Elo estimate
   prefers 4. Keep 4.
4. **Larger nets.** `kata1-tf3-b11c768` (in `~/.katrain`, not managed) needs
   OpenCL autotuning for its size on first use, which takes several minutes. It has
   not been tried in the fork.
5. **Analysis interval.** Sabaki sends `kata-analyze <color> 50`
   (`board.analysis_interval`, in centiseconds), so the heatmap updates twice a
   second.
6. **Tsumego frame.** By default, analysis sends KataGo the problem with a
   hidden tsumego frame (`baduk` D5, `src/modules/tsumegoframe.js`) built for
   the root position: the frame's komi, area rules (`kata-set-rules`) and
   `allow` clauses that keep candidates and best lines inside the window. The
   frame is never drawn. Engines → Whole-Board Analysis
   (`board.analysis_whole_board`) turns it off: no frame, no `allow`, the
   problem's own `KM` and `RU` (or the engine's rules without `RU`). Without
   the frame, KataGo plays big points elsewhere on the board. How the frame
   is laid out and balanced: [docs/tsumego-frame.md](docs/tsumego-frame.md).

## Public repo: no copyrighted SGF

This repo is public. Never commit tsumego collections or library SGF from the
`baduk` project: they are copyrighted. Test fixtures must be written by us or be
freely licensed, with their source noted next to them. `.gitignore` blocks SGF
files at the repo root and `collections/` and `library/` folders as a guard.
