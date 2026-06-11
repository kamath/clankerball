'use strict';
/* Headless sanity test: node sim_test.js
   Simulates full games and prints pace/score/stat summaries. */
const { Game } = require('./engine.js');
const { PlayerGen } = require('./players.js');

function runGame(verbose) {
  const used = new Set();
  const counts = {};
  const game = new Game({
    quarterMinutes: 12,
    teamA: { name: 'Ironwood Elks', abbr: 'IRW', color: '#ef5b2b', players: PlayerGen.randomRoster(used) },
    teamB: { name: 'Bayside Kingfishers', abbr: 'BAY', color: '#21b0b8', players: PlayerGen.randomRoster(used) },
  }, {
    onEvent: (e) => {
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (verbose) console.log(`[${e.qLabel} ${e.clock}] ${e.text}`);
    },
  });

  let steps = 0;
  const MAX = 1.5e6;
  while (!game.over && steps < MAX) {
    game.step(1 / 30);
    steps++;
    for (const t of game.teams) {
      for (const p of t.players) {
        if (!isFinite(p.pos.x) || !isFinite(p.pos.y)) {
          throw new Error(`NaN position for ${p.name} at step ${steps}`);
        }
        if (Math.abs(p.pos.x) > 120 || Math.abs(p.pos.y) > 80) {
          throw new Error(`${p.name} escaped the arena: ${p.pos.x},${p.pos.y}`);
        }
      }
    }
    if (!isFinite(game.ball.pos.x)) throw new Error('NaN ball position');
  }
  if (!game.over) throw new Error('game never finished');

  const sum = (t, k) => t.players.reduce((s, p) => s + p.stats[k], 0);
  const line = (t) => {
    const fga = sum(t, 'fga'), fgm = sum(t, 'fgm');
    const tpa = sum(t, 'tpa'), tpm = sum(t, 'tpm');
    return `${t.abbr} ${String(t.score).padStart(3)}  ` +
      `FG ${fgm}/${fga} (${(100 * fgm / Math.max(1, fga)).toFixed(1)}%)  ` +
      `3P ${tpm}/${tpa}  REB ${sum(t, 'reb')}  AST ${sum(t, 'ast')}  ` +
      `STL ${sum(t, 'stl')}  TOV ${sum(t, 'tov')}`;
  };
  console.log(line(game.teams[0]));
  console.log(line(game.teams[1]));
  console.log('events:', JSON.stringify(counts));
  console.log(`sim seconds stepped: ${(steps / 30).toFixed(0)}, quarters: ${game.quarter}`);

  // sanity assertions
  const totFGA = sum(game.teams[0], 'fga') + sum(game.teams[1], 'fga');
  console.assert(game.teams[0].score >= 50 && game.teams[0].score <= 180, 'score A out of range');
  console.assert(game.teams[1].score >= 50 && game.teams[1].score <= 180, 'score B out of range');
  console.assert(totFGA > 100 && totFGA < 280, `total FGA odd: ${totFGA}`);
  console.log('---');
  return game;
}

const N = Number(process.argv[2] || 5);
for (let i = 0; i < N; i++) runGame(process.argv.includes('-v'));
console.log('all games completed OK');
