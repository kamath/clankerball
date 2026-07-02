/* Headless sanity check for the engine: simulate full games and report
   stat lines, pass volume/types, interceptions, and fast-break behavior.
   Run with: npx tsx scripts/sim-check.ts [games] */
import { Game } from "../lib/engine";
import { DEFAULT_CONFIG } from "../lib/players";
import type { SimEvent } from "../lib/types";

const GAMES = Number(process.argv[2] || 5);
const DT = 1 / 30;

interface Tally {
  scores: number[][];
  passes: number;
  passTypes: Map<string, number>;
  lanePicks: number;
  deflections: number;
  steals: number;
  tovs: number;
  fga: number;
  events: number;
}

const tally: Tally = {
  scores: [],
  passes: 0,
  passTypes: new Map(),
  lanePicks: 0,
  deflections: 0,
  steals: 0,
  tovs: 0,
  fga: 0,
  events: 0,
};

for (let g = 0; g < GAMES; g++) {
  const events: SimEvent[] = [];
  const game = new Game(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), {
    onEvent: (e) => events.push(e),
  });
  let guard = 0;
  while (!game.over && guard++ < 60 * 60 * 4 * 30) game.step(DT);
  if (!game.over) {
    console.error("game did not finish!");
    process.exit(1);
  }
  tally.scores.push(game.teams.map((t) => t.score));
  tally.events += events.length;
  for (const e of events) {
    if (e.type === "pass") {
      tally.passes++;
      const verb = e.text;
      const type =
        ["bounce", "skip", "lob", "outlet", "ahead|up the floor", "pocket|roll", "kick|spray", "no-look|looking", "block|inside"].find((k) =>
          k.split("|").some((w) => verb.includes(w))
        ) || "chest/swing";
      tally.passTypes.set(type, (tally.passTypes.get(type) || 0) + 1);
    }
    if (e.type === "steal" && e.text.includes("passing lane")) tally.lanePicks++;
    if (e.type === "loose" && e.text.includes("deflected")) tally.deflections++;
  }
  for (const t of game.teams) {
    for (const p of t.players) {
      tally.steals += p.stats.stl;
      tally.tovs += p.stats.tov;
      tally.fga += p.stats.fga;
    }
  }
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`games: ${GAMES}`);
console.log(
  `avg score: ${avg(tally.scores.map((s) => s[0])).toFixed(1)} - ${avg(
    tally.scores.map((s) => s[1])
  ).toFixed(1)}`
);
console.log(`per game: passes=${(tally.passes / GAMES).toFixed(1)} fga=${(tally.fga / GAMES).toFixed(1)} steals=${(tally.steals / GAMES).toFixed(1)} tov=${(tally.tovs / GAMES).toFixed(1)} lanePicks=${(tally.lanePicks / GAMES).toFixed(1)} deflections=${(tally.deflections / GAMES).toFixed(1)}`);
console.log("pass types:", Object.fromEntries(tally.passTypes));

/* ---- lane interception test: throw a pass straight through a parked
   defender many times and confirm it gets picked or deflected often ---- */
let picked = 0,
  deflected = 0,
  completed = 0;
const TRIES = 300;
for (let i = 0; i < TRIES; i++) {
  const game = new Game(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), { onEvent: () => {} });
  game.phase = "live";
  game.deadTimer = 0;
  const off = game.teams[game.possession].players;
  const def = game.teams[1 - game.possession].players;
  const h = off[0];
  const m = off[1];
  // cross-court pass with a defender camped dead-center on the lane
  h.pos = { x: 60, y: 5 };
  m.pos = { x: 60, y: 45 };
  def[0].pos = { x: 60, y: 25 };
  def[0].vel = { x: 0, y: 0 };
  // park everyone else far away
  off.slice(2).forEach((p, j) => (p.pos = { x: 10 + j, y: 5 }));
  def.slice(1).forEach((p, j) => (p.pos = { x: 10 + j, y: 45 }));
  game.ball.holder = h;
  game.ball.loose = null;
  game.tryPass(h, m);
  let steps = 0;
  while (game.ball.flight && steps++ < 200) game.step(DT);
  if (game.ball.holder === m) completed++;
  else if (game.ball.loose) deflected++;
  else picked++;
}
console.log(
  `\nlane test (defender parked mid-lane, ${TRIES} cross-court passes):` +
    ` picked=${((picked / TRIES) * 100).toFixed(0)}%` +
    ` deflected=${((deflected / TRIES) * 100).toFixed(0)}%` +
    ` completed=${((completed / TRIES) * 100).toFixed(0)}%`
);
