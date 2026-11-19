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
3. Before the argv fix (branch `fix/argv-dot-slash`), `electron ./` and
   therefore `npm start` treated `./` as the file to open. With the fix both `.`
   and `./` work.

## Public repo: no copyrighted SGF

This repo is public. Never commit tsumego collections or library SGF from the
`baduk` project: they are copyrighted. Test fixtures must be written by us or be
freely licensed, with their source noted next to them. `.gitignore` blocks SGF
files at the repo root and `collections/` and `library/` folders as a guard.
