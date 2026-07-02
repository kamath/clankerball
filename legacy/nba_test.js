'use strict';
/* NBA roster validation: node nba_test.js [games]
   Lockdown Five vs Firepower Five — prints matchups, aggregate
   per-player lines, and team results. */
const { Game } = require('./engine.js');
const { PlayerGen } = require('./players.js');

const N = Number(process.argv[2] || 8);
const agg = {}; // name -> totals
let winsA = 0, ptsA = 0, ptsB = 0;

for (let g = 0; g < N; g++) {
  const game = new Game({
    quarterMinutes: 12,
    teamA: { name: 'Lockdown Five', abbr: 'LCK', color: '#21b0b8', players: PlayerGen.LOCKDOWN },
    teamB: { name: 'Firepower Five', abbr: 'FPW', color: '#ef5b2b', players: PlayerGen.FIREPOWER },
  }, {});

  if (g === 0) {
    console.log('--- matchups (defender -> assignment) ---');
    for (const t of game.teams) {
      for (const p of t.players) {
        const mark = game.teams[1 - p.team].players.find(q => q.slot === p.markSlot);
        console.log(`  ${p.name.padEnd(24)} guards ${mark.name}`);
      }
    }
  }

  let steps = 0;
  while (!game.over && steps++ < 1.5e6) game.step(1 / 30);
  if (!game.over) throw new Error('game never finished');

  if (game.teams[0].score > game.teams[1].score) winsA++;
  ptsA += game.teams[0].score;
  ptsB += game.teams[1].score;
  for (const t of game.teams) {
    for (const p of t.players) {
      const a = agg[p.name] || (agg[p.name] = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, team: t.abbr });
      for (const k of ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fgm', 'fga', 'tpm', 'tpa']) a[k] += p.stats[k];
    }
  }
}

console.log(`\n--- per-game averages over ${N} games ---`);
for (const [name, a] of Object.entries(agg)) {
  console.log(
    `  ${a.team} ${name.padEnd(24)} ` +
    `${(a.pts / N).toFixed(1).padStart(5)} pts  ` +
    `${(a.reb / N).toFixed(1).padStart(4)} reb  ` +
    `${(a.ast / N).toFixed(1).padStart(4)} ast  ` +
    `${(a.stl / N).toFixed(1).padStart(4)} stl  ` +
    `${(a.blk / N).toFixed(1).padStart(4)} blk  ` +
    `${(a.tov / N).toFixed(1).padStart(4)} tov  ` +
    `FG ${(100 * a.fgm / Math.max(1, a.fga)).toFixed(0)}%  ` +
    `3P ${(100 * a.tpm / Math.max(1, a.tpa)).toFixed(0)}% (${(a.tpa / N).toFixed(1)}/g)`);
}
console.log(`\nLCK avg ${(ptsA / N).toFixed(1)} — FPW avg ${(ptsB / N).toFixed(1)}, LCK wins ${winsA}/${N}`);
