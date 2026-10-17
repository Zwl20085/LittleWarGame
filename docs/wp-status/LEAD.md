# 3.0 lead status (resume point)

Branch `feat/v3.0`. Spec `docs/V30_SPEC.md`, code map `docs/V30_CODEMAP.md`. Each agent keeps
its own note in this folder (`WP-*.md`) on its worktree branch `worktree-agent-<id>`.

## Merged into feat/v3.0
- WP-L music (branch worktree-agent-a259d347dda45bc8b) — merge 9a59079. Renders copied to
  media/stats/music/v30-*.wav. Still to wire: `musicEvent('offensiveLaunched'|'capitalLost'|'quiet')`
  and `setDoctrineTheme()` once doctrines exist.
- WP-J updater (worktree-agent-a823f640660e717ae) — merged, plus 2957e15 (LF pin for
  scripts/release/*.mjs and electron/*.cjs). User action before release: `npm run release:keygen`,
  paste the public key into `UPDATE_PUBLIC_KEY` in electron/updater.cjs, back up the key.

- WP-K camera (worktree-agent-a8fe6761be36037cd) — merge d76f083 (battle cam respects fog, depth blur off by default; close-in low-angle view 4.4 ms vs 4 ms budget → WP-M).
- WP-I challenge diversity (worktree-agent-a00de1da53255b7d4) — merge 081b993. Baseline: only shadow_strike (open info) takes AI capitals; supply-starved share ~50 % everywhere (band miss); doctrine_* strategies wait for WP-A.

## Wave 1 agents still running (merge each when reported; typecheck + tests after every merge)
| WP | branch | status |
|---|---|---|
| D roads/rail | worktree-agent-ab63c300467793cd5 | running |
| B+C fronts/compliance | worktree-agent-aa55ed9ace45ae466 | running labs |
| I anomaly lab + ammo fix | worktree-agent-a975a400ec14180f9 | running |
| F+G econ zones + works | worktree-agent-a7cde76b4ad393c3f | running |

Merge order when several are ready: D → B+C → F+G → I-anomaly → K → I-challenge (K and I-challenge
touch few sim files; D/B+C/F+G are the conflict-prone ones: types.ts, snapshot.ts, i18n.ts, hud.ts,
behavior.ts, rules.json).

## Wave 2 (start after D, B+C, F+G are merged; each in its own worktree)
- WP-A doctrines (spec §1) + wire music `setDoctrineTheme` / `musicEvent`, HUD doctrine line.
- WP-E infiltration / ZOC / pickets (spec §11) after B+C.
- WP-H unit upgrades (spec §9) after D (movement.ts seam).
- Lab tuning passes per system (Sonnet): doctrine matrix, transport, defence, upgrade, infiltration.

## Wave 3
- Perf round (spec §14), code review (code-reviewer agent), README en+zh (crafting-effective-readmes)
  + GIFs (demo-gif, scripts/capture*.mjs, media/m22 choreography), version 3.0.0, release PR to main
  (user OK needed), `npm run dist:win` + `npm run pack:game`.

## Known decisions made by the lead during merges
- Battle cam must respect fog (player visibility); depth blur default off.
- Release scripts/shell modules are LF (vite-node import of a CRLF shebang file fails).
