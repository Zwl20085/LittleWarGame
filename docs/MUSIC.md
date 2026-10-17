# Music — the adaptive war-film score

Everything is procedural: there are no audio assets. A sampled orchestra is synthesised in a
worker at startup, and a composer writes the score one bar at a time from the game state.
The score is in D minor (Aeolian), with D Dorian, the Neapolitan Eb and D major (Picardy /
Lydian) used for colour.

## Modules (`src/audio/`)

| file | role |
|---|---|
| `themes.ts` | chord progressions (lead-sheet symbols), melodies, rhythm patterns |
| `doctrines.ts` | doctrine ids and their orchestration colour (tempo, lead, ostinato, snare, low brass) |
| `director.ts` | situation state machine: events → situation + queued cue (pure) |
| `score.ts` | `Conductor`: picks phrases, tiers and tempo; emits one `BarPlan` per bar (pure) |
| `voicing.ts` | four-part string voice leading (no parallels, tendency tones, spacing) |
| `arrange.ts` | which section plays what: divisi, doublings, brass stabs, ostinato, the tune |
| `percussion.ts` | timpani, field snare, gran cassa, suspended cymbal |
| `orchestra.ts` | sample synthesis (PolyBLEP ensembles, body / bell resonances, bow noise, dynamics layers) |
| `hall.ts` | music reverb impulse: pre-delay, early reflections, a darkening diffuse tail |
| `music.ts` | plays the plans on the audio clock: section buses, crossfades, voice budget |
| `mixer.ts` | master chain, music EQ, music duck, reverbs, the effects voice pool |
| `engine.ts` | process-wide engine and per-game session (intensity, alerts, ducking) |

`score.ts`, `director.ts`, `voicing.ts`, `arrange.ts` and `percussion.ts` use no Web Audio.
The same code drives the game and the offline preview, and the tests run it directly.

## Orchestra

| section | instrument id | range (MIDI) | notes |
|---|---|---|---|
| violins I / II, violas | `strings` | 36–88 | 6-voice ensemble, delayed vibrato, rosin noise, body resonances (290 / 520 / 3000 Hz) |
| celli + basses | `basses` | 28–52 | darker, slower to speak; basses double the cello line an octave below (never below E1) |
| tremolo strings | `trem` | 48–84 | battle / threat colour |
| horns (4) | `horn` | 41–77 | lip scoop on attack; two dynamic layers (p / f) |
| trumpets | `brass` | 53–82 | bright, brightness and drive rise sharply on the forte layer |
| trombones + tuba | `tbn` | 30–66 | open bottom of the stabs, chorale under laments, bass reinforcement at tier 3 |
| oboe / clarinet | `reed` | 45–81 | solo lead, counter-lines, calm woodwind pad |
| flutes | `flute` | 60–96 | an octave above the tune (calm colour, tutti melody) |
| spiccato low strings | `spic` | 26–62 | the articulated ostinato under held chords |
| timpani, snare, bass drum, cymbal | `timp` `snare` `bdrum` `cymbal` | – | one-shots (cymbal v0 = swell, v1 = crash) |

Orchestration rules that the arranger follows:

- Strings are the foundation: violas, second violins and first violins take the tenor, alto and
  soprano of the voicing. At climaxes the first violins split, with one half an octave up.
- Spacing is wide at the bottom and close at the top. There are no close thirds below C3, and
  the tenor stays clear of a low bass.
- Voice leading forbids parallel fifths and octaves. The leading tone of a dominant rises to the
  new root, a chordal seventh falls by step, and common tones are kept.
- Horns bridge the strings and the brass. They hold an inner-voice chorale in tension, pad the
  upper voices in battle, and play the tune in unison at the tier-3 climax.
- Trumpets take the top of the stabs, and trombones take the open bottom (root plus fifth).
- Sustained sections are set against articulated ones: a spiccato ostinato runs under held chords.
- Percussion is used with restraint. Timpani play tonic and dominant, with rolls into cadences;
  there is one crash per phrase head and a swell into the next downbeat.
- Brass brightness follows dynamics. Velocities at or above `DYN_SPLIT` select the forte
  sample layer.

## Form and tiers

The score is built from 8-bar phrases (4 + 4, with a half cadence then a full cadence). Battle
intensity (0–1, from the battle listener), raised to the situation floor, picks a tier with
hysteresis:

| tier | style | themes (default) |
|---|---|---|
| 0 | calm | `main`, `interlude`, `mainB` (title screen: `title` first) |
| 1 | tension | `tension`, `tensionB` (+ doctrine theme) |
| 2–3 | battle | `battleA`, `battle`, `main` at battle tempo (+ doctrine theme) |

Escalating into battle inserts a one-bar `fill`, a dominant build. Retreat, capital lost and
defeat switch to `lament`. Victory switches to `hymn` (the main theme in D major).

## Themes

| id | use | character |
|---|---|---|
| `title` | main title | horn call (rising fourth, then fifth), strings answer, Neapolitan turn onto A |
| `builder` | doctrine 优先发育 | pastoral D Dorian, stepwise, string / flute lead, light snare |
| `blitz` | doctrine 一波直捣黄龙 | repeated-note anapests over Phrygian Eb, trumpets, driving 16ths |
| `attrition` | doctrine 稳扎稳打 | narrow, low march over a lament bass, trombones and timpani, slower |
| `maneuver` | doctrine 寻机决战 | octave leaps, pivot through F major, triplet gallop, horns in unison |
| `threat` | home threatened | stopped-horn semitones over a D pedal, timpani heartbeat, low tremolo |
| `offensive` | offensive launched | trumpet call over a snare crescendo into a crash |
| `fall` | capital lost | descending lament through Eb/G (Neapolitan 6) onto A; toll of timpani and bass drum |
| `capital` | capital taken | D-major fanfare |
| `victory` / `defeat` | outcome | Lydian lift to D major / a quiet minor close |

## API

```ts
import { musicEvent, setDoctrineTheme } from './audio';

musicEvent('homeThreatened');   // | 'offensiveLaunched' | 'capitalLost' | 'capitalTaken'
                                // | 'victory' | 'defeat' | 'quiet'
setDoctrineTheme('blitz');      // 'builder' | 'blitz' | 'attrition' | 'maneuver'; null / unknown = default
```

Both calls are safe at any time, from any frame, and before audio is unlocked; the doctrine is
remembered. Unknown event kinds are rejected with a console warning.

### Event state machine (`director.ts`)

| event | situation | lasts | cue | starts | floor | rank |
|---|---|---|---|---|---|---|
| `offensiveLaunched` | offensive | 24 bars | `offensive` | next half-phrase (≤ 4 bars) | 0.6 | 1 |
| `homeThreatened` | threat | 24 bars | `threat` | next bar | 0.42 | 2 |
| `capitalTaken` | triumph | 12 bars | `capital` | next bar | 0.4 | 3 |
| `capitalLost` | falling (sombre) | 32 bars | `fall` | next bar | 0.3 | 4 |
| `victory` / `defeat` | won / lost | terminal | `victory` / `defeat` | next bar, cuts through a cue | 0 | 5 |
| `quiet` | normal | – | clears pending cues | next bar | 0 | – |

- Events are queued. They take effect only at the next bar boundary, when the Conductor ticks
  the director. All transitions therefore land on bar lines, and non-urgent ones also wait for
  a half phrase.
- A lower-ranked event never overrides a running higher-ranked situation. Victory and defeat are
  terminal. If the same situation is refreshed within 16 bars, its timer extends but the cue
  does not replay.
- The situation adds a floor to the intensity, raises layer emphasis (threat: ostinato,
  trombones and tremolo; offensive / triumph: brass and percussion; falling: strings up, brass
  down), and selects theme lists (offensive starts with the doctrine theme, triumph uses the
  heroic main theme).
- Crossfades: an interrupted phrase lets its chord go over the first beat of the new one (a
  string tail). Leaving a battle adds a tremolo and horn bridge with a dying timpani roll.
  Section buses glide to their targets (`setTargetAtTime`, τ ≈ 1.6 s). Nothing is cut.

### Existing hooks

- Battle intensity: `AudioSession.update` → `Music.update(intensity)`.
- Home threatened: the player's `log.hqUnderAttack` alert (`alerts.ts` `threats`) posts
  `homeThreatened`. This is marked as the 3.0 music hook in `engine.ts`.
- `FortuneWatch` (an enemy capital falls, the outcome) still feeds the score through the
  director, as `capitalTaken`, `victory` and `defeat`.

The game still has to wire `offensiveLaunched`, `capitalLost`, `quiet` and the doctrine.

## Mix

- Ten section buses, each with gain, pan (stage seating), reverb send and a brightness lowpass
  for strings, horns, brass and tremolo. All of them feed `musicIn`.
- Music bus EQ: a 32 Hz high-pass, −2 dB at 320 Hz (low-mid mud) and +1 dB of air above 7 kHz.
  The hall return is high-passed at 180 Hz.
- Music duck: under heavy near-field fire the score dips by up to 3.3 dB (`musicDuckGain`). It
  goes down fast (τ 0.25 s), recovers slowly (τ 1.2 s) and scales with the effects volume.
- Master: a gentle glue compressor (−18 dB, 2.5:1, 20 ms attack), then a −2.5 dB safety limiter.
- Music volume: the slider sets the music bus. At zero (or when muted) the score keeps time but
  schedules no notes, which saves CPU.

## Offline preview

```sh
npx vite-node scripts/music-preview.ts 60 7 v30      # all 3.0 renders
npx vite-node scripts/music-preview.ts 80 7          # everything
```

The renders go to `media/stats/music/` (gitignored). Each render prints its peak and RMS level,
notes per second, voice concurrency and the form, for example
`35s fill/t2@92[offensive] > 37s offensive/t2@104[offensive] > …`.

## Cost

- Composer: about 0.06 ms per bar on the main thread (a bar lasts 2–4 s of real time), with
  10 events per bar when calm and about 70 in a full battle.
- Playback: about 27 notes/s and about 31 concurrent voices on average in a full battle (peak
  56, budget 64). Quiet notes are skipped past the budget.
- Audio runs on the audio clock, so 8× game speed does not add music work.
- Sample bank: 133 samples (23 MB), about 4–5 s to synthesise in the worker. Calm instruments
  are built first.
