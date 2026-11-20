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

## Settings folder: keep dev runs apart from an installed Sabaki

`productName` is still `Sabaki`, so the fork reads and writes the same settings
folder as an installed Sabaki (`~/.config/Sabaki` on Linux), engines list
included. For development runs, give the fork its own folder:

```
npx electron . --user-data-dir="$HOME/.config/sabaki-plus-dev" path/to/file.sgf
```

`--user-data-dir` sets the folder itself (no `Sabaki` subfolder is added), and
upstream's e2e fixture uses it the same way.

## KataGo engine

Local analysis uses KataGo over GTP (`kata-analyze`), set up like any Sabaki
engine under Preferences → Engines. The setup checked on 2026-11-20 (Fedora 44,
Quadro T1000 4 GB, NVIDIA 615.78, OpenCL 3.0) reuses KaTrain's KataGo files:

| Field | Value |
|---|---|
| Name | `KataGo 1.18.1 OpenCL` |
| Path | `~/.katrain/katago-v1.18.1-opencl/AppRun` (written out in full) |
| Arguments | `gtp -model <models>/b10c384h6nbttflrs.bin.gz -config ~/.katrain/gtp.cfg` (paths written out in full) |

`<models>` is KaTrain's bundled model folder,
`~/.local/pipx/venvs/katrain/lib/python3.14/site-packages/katrain/models`.
Sabaki starts the engine without a shell, so `~` and `$HOME` are not expanded:
write absolute paths.

Notes:

1. **Use the extracted AppImage, not the release file.** KataGo's Linux release
   binaries (1.18.1) are AppImages. With AppImageLauncher installed, every launch
   of one opens an "integrate this AppImage?" dialog. Under xvfb nobody can see
   or answer it, so the engine appears to hang. Extract it once and point Sabaki
   at `AppRun`, which sets `LD_LIBRARY_PATH` to the bundled libraries:
   ```
   cd ~/.katrain
   APPIMAGELAUNCHER_DISABLE=1 ./katago-v1.18.1-opencl-linux-x64 --appimage-extract
   mv squashfs-root katago-v1.18.1-opencl
   ```
   Do not click "Integrate and run": it moves the file, and KaTrain's path to it
   breaks.
2. **Config.** `~/.katrain/gtp.cfg` is the GTP config KaTrain generated:
   Japanese rules, 4 search threads, and full GTP logging to `gtp_logs/`.
   Sabaki runs an engine from that engine's own folder, so the logs land in
   `~/.katrain/katago-v1.18.1-opencl/gtp_logs/`.
3. **Speed.** On the T1000, `b10c384h6nbttflrs` (KaTrain's default net, about
   10.5 M parameters) loads in under a second with the cached OpenCL tuning and
   reaches about 72 visits/s in Sabaki's analysis. `katago benchmark -t
   4,8,12,16,24` showed the GPU saturating at about 70 network evaluations/s:
   16 threads gave 85 visits/s against 77 for 4, and KataGo's Elo estimate
   prefers 4. Keep 4.
4. **Larger nets.** `kata1-tf3-b11c768` (in `~/.katrain`) needs OpenCL
   autotuning for its size on first use, which takes several minutes. It has
   not been tried in the fork.
5. **Analysis interval.** Sabaki sends `kata-analyze <color> 50`
   (`board.analysis_interval`, in centiseconds), so the heatmap updates twice a
   second.
6. **Whole board only for now.** Without the hidden tsumego frame and the move
   restriction (`baduk` D5), KataGo plays big points elsewhere on the board
   instead of the problem area.

## Public repo: no copyrighted SGF

This repo is public. Never commit tsumego collections or library SGF from the
`baduk` project: they are copyrighted. Test fixtures must be written by us or be
freely licensed, with their source noted next to them. `.gitignore` blocks SGF
files at the repo root and `collections/` and `library/` folders as a guard.
