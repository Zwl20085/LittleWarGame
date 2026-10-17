# WP-N status — README (en + zh) and media for 3.0

Branch `worktree-agent-a8afeff94d884d5c5` (reset to `feat/v3.0` fd3a892). Spec: V30_SPEC §15.

## Pipeline
- Capture scripts: `media/m30/` (gitignored; copied from the 2.2 set in `media/m22`, OUT → media/m30, dev
  server port 5233). `run.mjs` (spectate setup + canvas record), `shot.mjs`, `orders.mjs`-style tab captures
  (`TAB=1`, HUD included), `mk.mjs` (two-pass palette + `gifopt.py` frame diff), `build.py` (hero cut).
- Dev server: `npx vite --port 5233 --strictPort`. ffmpeg: miniconda `Library/bin/ffmpeg.exe`.

## Progress
- [ ] version 3.0.0 (package.json / lock)
- [ ] GIFs: doctrines, fronts, rail, zones, works, upgrades, camera, infiltration, hero (en/zh), overview, roadside fix
- [ ] README.md / README.zh-CN.md: What's new 3.0, Features, Controls, Under the hood, Roadmap, Build, updater
- [ ] alt text + link check; typecheck + tests
