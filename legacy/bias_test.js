'use strict';
/* Side-bias experiment: same roster pair, both orderings, many games. */
const { Game } = require('./engine.js');
const { PlayerGen } = require('./players.js');

let winsAsTeam0 = 0, winsAsTeam1 = 0, games = 0, diffSum0 = 0;
const N = Number(process.argv[2] || 10);

for (let i = 0; i < N; i++) {
  const used = new Set();
  const r1 = PlayerGen.randomRoster(used);
  const r2 = PlayerGen.randomRoster(used);
  for (const [a, b] of [[r1, r2], [r2, r1]]) {
    const g = new Game({
      quarterMinutes: 12,
      teamA: { name: 'A', abbr: 'A', color: '#f00', players: a },
      teamB: { name: 'B', abbr: 'B', color: '#0f0', players: b },
    }, {});
    let steps = 0;
    while (!g.over && steps++ < 1.5e6) g.step(1 / 30);
    games++;
    const d = g.teams[0].score - g.teams[1].score;
    diffSum0 += d;
    if (d > 0) winsAsTeam0++; else winsAsTeam1++;
  }
}
console.log(`games: ${games}`);
console.log(`avg margin for team slot 0: ${(diffSum0 / games).toFixed(1)}`);
console.log(`wins by slot — team0: ${winsAsTeam0}, team1: ${winsAsTeam1}`);
