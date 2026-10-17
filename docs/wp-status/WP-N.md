# WP-N status — README (en + zh) and media for 3.0

Branch `worktree-agent-a8afeff94d884d5c5` (reset to `feat/v3.0` fd3a892). Spec: V30_SPEC §15. State: **delivered**.

## Pipeline (media/ is gitignored; scripts live in this worktree's `media/m30/`)
- Copied from the 2.2 set (`media/m22` in worktree agent-aab159ceaefee5936), OUT → `media/m30`, dev server
  `npx vite --port 5233 --strictPort`. ffmpeg: miniconda `Library/bin/ffmpeg.exe`.
- `run.mjs` (spectate setup + canvas record), `shot.mjs`, tab-capture HUD shots (`TAB=1`): `dochud.mjs`,
  `fronts.mjs`, `zones.mjs`, `upgpanel.mjs`, `camera.mjs`, `infil.mjs`; setups `spear.js`, `doc_style.js`,
  `rail.js`, `works_close.js`, `works_mine2.js`, `upg_tank.js`, `upg_gun.js`, `perimeter.js`.
- `LOCAL=1` (lib.mjs): the page hides `Worker`, so game.ts runs the sim on the page thread and capture staging can
  call sim modules on the real world. Capture-only; no game code changed.
- `cut.py` (multi-shot GIF: crop, caption chip, crossfade, per-shot palette + frame diff via gifopt2.py),
  `all.py` (rebuilds every 3.0 GIF from `spec_*.json`), `build.py` (hero cut), `recomp.py` (re-encode old GIFs).
- Staging used (all in capture scripts, labelled there): upgrades granted for the tank / gun-team shots;
  a minefield laid ahead of a tank pair; a bunker given its fortress state / an AT emplacement laid out;
  a raid party and an infiltration party ordered through the command bus; money added for the zone / research clips.

## Done
- version 3.0.0 (package.json / lock); GIFs (docs/media); README.md + README.zh-CN.md; roadmap.svg (3.0 starred).
- Old GIFs re-encoded smaller (README total about 27 MB per language, was about 60 MB).

## Not done / open
- roadside.gif "inside the building" moment: three seeds tried, the staged shelling never housed a squad in a
  roadside building on camera (`roadside.js` `__inside`); the 2.2 clip is kept (re-encoded).
- rail.gif has no engineer-road moment: the engineer road jobs stalled around 55 % in every try.
- Fortress close-up: the only bunkers near capitals stand between town buildings; works.gif shows the perimeter
  strongpoint, an AT emplacement and a minefield instead.
