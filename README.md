# Fable Fieldhouse — Basketball Simulator

A browser-based 5-on-5 basketball simulator. Ten dots play a full game on a
2D court with a live play-by-play feed, box score, an in-page roster editor,
and the bookkeeping of a real game: game/shot clocks, inbounds, out of
bounds, steals, blocks, rebounds, loose balls, and turnovers.

## Run it

No build step, no server — open `index.html` in a browser.

- **Controls**: play/pause, sim speed (1×–16×), New Game.
- **Right panel tabs**: play-by-play feed · box score (hover a row for that
  player's ratings) · **EDIT TEAMS** — live roster editor.
- The default matchup is two real-player teams: the **Lockdown Five**
  (Alvarado, Caruso, Smart, Draymond, Gobert) vs the **Firepower Five**
  (Curry, SGA, Durant, LeBron, Jokić).

## Editing players

The **EDIT TEAMS** tab edits the game in progress immediately — pick a
player, drag sliders. Every attribute and tendency below is editable, plus
name and jersey number. "Keep rosters on New Game" controls whether New Game
regenerates random rosters; "Copy rosters as JSON" exports the current
(edited) rosters so you can paste them into `players.js` permanently.

To hand-write rosters in code, edit `players.js` — the `LOCKDOWN` and
`FIREPOWER` arrays show the full format. Any rating you omit is auto-filled
from height/weight/IQ/dunk (see `fillRatings()` in `engine.js`), so a
minimal config with just shooting numbers still works.

## Player model

**Attributes** (25–99): `heightIn`, `weightLb`, `speed`, `acceleration`,
`strength`, `vertical` · `iq`, `threePoint`, `midRange`, `layup`, `dunk`,
`ballHandle`, `passAcc` · `perimeterD`, `interiorD`, `steal`, `block`,
`rebound`.

**Tendencies** (1–99, default 50): `shoot` (eagerness to fire), `three`
(hunts triples), `drive` (attacks the rim), `pass` (moves the ball), `help`
(rotates on drives), `crash` (offensive glass vs getting back), `gamble`
(jumps lanes/reaches — more steals, more risk).

## How the game mechanics work

### Possessions & the ball
The engine (`engine.js`, fully DOM-free) runs a state machine: dead-ball
inbound setup → inbound pass → live play. The ball is always either *held*,
*in flight* (pass or shot), or *loose*. Loose balls have real physics — a
velocity that decays with friction — so blocked shots rocket away, errant
passes skip past their target, and long misses produce long caroms. A loose
ball that rolls out of bounds is a whistle: last team to touch it loses
possession.

### Movement
Players accelerate toward targets and decelerate to arrive: top speed comes
from the `speed` rating, how fast they get there from `acceleration`.
Heavier/taller default-generated players are slower unless you say
otherwise.

### Offense
The ball handler makes a decision every ~0.5–0.9s: **shoot, drive, pass, or
relocate**. Each option is scored in *expected points* and compared against
a threshold that starts high (~1.5) and falls as the shot clock drains —
early in the clock only great looks go up; late, anything goes. `iq` shrinks
the random noise on this comparison (smart players misjudge less), `shoot` /
`three` / `drive` / `pass` tendencies tilt which option wins, and a usage
governor cools off a player who is far ahead of his teammates in attempts.

Shot make probability = base (from the matching rating: `threePoint`,
`midRange`, `layup`/`dunk`) **− distance falloff within the range band**
(deep threes and long twos are worth less than line threes and short
mid-rangers) **− contest penalty**. The contest scales with how close the
nearest defender is, that defender's `perimeterD` or `interiorD`, and his
*effective height* (height + vertical bonus) versus the shooter. Inside,
a `strength` edge helps you finish through the body. Drives weigh the
defenders camped in the lane plus the driver's speed and handle; dunk
attempts replace layups when close, uncontested-ish, and the `dunk` rating
allows.

Off-ball players cycle through real spots (corners, wings, top, elbows,
short corners, blocks, dunker) chosen by their shooting ratings × `three` /
`drive` tendencies. Assists are credited when a catch leads to a make within
~2.4 seconds.

### Defense
Matchups are assigned by **fit, not just height**: each offensive threat
draws the defender whose relevant rating (`perimeterD`+`steal` for
guards/wings, `interiorD`+`block`+`strength` for bigs) is best *after* a
size-mismatch penalty — and `strength` shrinks the effective size gap, which
is exactly why Smart/Caruso-types can guard up. A swap-optimization pass
then ensures nobody is stranded on a hopeless mismatch (no 6'0" guard on a
7-footer). Defenders pick up around their own half — no pointless
full-court pressing — sag off non-shooters, close out hard on snipers, and
pressure the ball tighter the better their `perimeterD`.

Off-ball defenders with high `steal`+`gamble` overplay passing lanes;
defenders with high `help` rotate toward drives. Steals come from on-ball
strips (`steal` vs `ballHandle`, more while driving) and jumped passing
lanes. Blocks happen on tightly contested twos (`block`, vertical-boosted
height differential). Bad passes (low `passAcc`, pressure, long distance)
are thrown away — sometimes out of bounds, sometimes a live loose ball.

### Rebounding
Misses carom off the rim with distance-scaled energy. Nearby players crash
the scramble — but the shooting team only sends players whose `crash`
tendency says so; the rest get back. The contest is won by `rebound` rating,
height, strength, vertical, and proximity. Offensive boards reset the shot
clock to 14.

### Clock awareness
- **2-for-1**: between ~38 and ~27 seconds left in a quarter, teams hurry a
  shot up to guarantee an extra possession.
- **Last shot**: if the game clock is shorter than the shot clock, the
  offense milks it down to ~7 seconds before attacking (unless trailing late).
- **Late & trailing**: down in the last 2 minutes of Q4/OT, teams push the
  pace — the bigger the deficit, the lower the shot bar.
- **Late & leading**: up with under a minute left, teams burn clock.
- **Buzzer beaters**: with under ~2 seconds, whoever has it lets it fly.

### Rules tracked
24-second shot clock (14 on offensive boards; kept, not reset, when the
offense recovers its own blocked shot or fumbled pass) · shot-clock
violations · baseline inbounds after makes, sideline inbounds after
turnovers · out of bounds on passes and rolling loose balls (last touch
loses) · four 12-minute quarters, alternating possession, overtime until a
winner. Quarter length is configurable (`quarterMinutes` in `players.js`).
Not modeled (yet): fouls/free throws, substitutions, timeouts, jump balls.

## Files

| File | Purpose |
|---|---|
| `players.js` | Team & player configs — **edit this for permanent rosters**. |
| `engine.js` | Pure simulation engine, drives everything via `game.step(dt)`. |
| `ui.js` | Canvas renderer (court, players, ball). |
| `main.js` | Game loop, scoreboard, feed, box score, roster editor. |
| `sim_test.js` | Headless sanity test: `node sim_test.js 5` (`-v` for full play-by-play). |
| `nba_test.js` | Lockdown vs Firepower validation: matchups + per-player averages. |
| `bias_test.js` | Verifies neither court side has a structural advantage. |
