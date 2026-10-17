# WP-K — camera and visuals: status

Branch `worktree-agent-a8fe6761be36037cd` (base `feat/v3.0` @ bd00fdc). Not pushed or merged.

## Done

| SHA | Commit |
|---|---|
| 77dbb37 | feat(render): time-of-day drift, richer sky backdrop and high-tier tilt-shift |
| b2ce53f | feat(render): camera modes — orbit, follow, battle cam, overview |
| fe3466c | fix(render): prewarm tilt-shift shaders; readable camera strip label |
| ed59640 | fix(render): battle cam respects fog of war; depth blur off by default |

- Camera modes: `src/render/cameraModes.ts` (state machine), `src/render/battleHeat.ts` (fx heat grid,
  `SeenMask` fog filter), `src/ui/cameraControls.ts` (keys, HUD strip, dip to black). The modes are
  registered once in `src/game.ts` through `InputController.keyHandlers`.
- Keys: O orbit · K battle cam · F follow the selected unit or the expanded front (or double-click a
  front card) · Tab overview, press again to return · `[` / `]` tilt (PgDn / PgUp still work) ·
  Esc back to free. R and F were already taken (retreat / follow), so tilt is not on R/F.
- Fog of war: the battle cam only counts and films fights near the player's own units or enemies
  the player currently sees. Spectators and defeated players see everything.
- Visuals: `src/render/timeOfDay.ts` runs dawn → noon → dusk over one game hour, then holds at
  dusk; there is no night. The setting `dayCycle` (on by default) switches it off, and off
  reproduces the 2.x light. `src/render/tiltShift.ts` is a light blur on the high tier at low
  close-in angles only; the setting `depthBlur` is off by default.
- Tests: `tests/camera.test.ts`, 18 tests, no WebGL. They cover the modes, battle-cam fight
  picking, the fog filter, time of day and when the blur switches on.

## Perf: `renderer.frame` in ms

Measured in Edge at 1600×900, high tier, 8× speed, seed 7, on built bundles. These runs predate
ed59640, so in the "close-low" row the blur was on.

| View | Before | After | Budget |
|---|---|---|---|
| Overview | 6.26 (first baseline run: 5.70) | 5.88 | ≤ 6 |
| Front | 4.53 | 4.23 | — |
| Close | 4.11 | 4.07 | ≤ 4 |
| Close, low angle (blur on) | 4.44 | 5.01 | ≤ 4 |

With the blur now off by default, the close-in low-angle view should be back near 4.4 ms. That is
the same as the base code, but still above 4 ms; I have not re-measured since ed59640.

## Screenshots

`media/review/v30-camera/` in this worktree: 11 PNGs, 15.6 MB, gitignored. Regenerate with
`node scripts/camera-shots.mjs <url> media/review/v30-camera`.

## Next steps

- Re-run `scripts/perf-browser.mjs` after the merge (WP-M) to confirm the default close-low view
  with the blur off.
- Full `npm test` after ed59640: see the latest report (the camera tests and typecheck are green).
