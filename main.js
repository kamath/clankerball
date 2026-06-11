'use strict';
/* ============================================================
   main.js — wiring: game loop, scoreboard, feed, box score
   ============================================================ */
(function () {

const cfg = window.GAME_CONFIG;
const feedEl = document.getElementById('feed');
const boxEl = document.getElementById('box');
const renderer = new BBUI.Renderer(document.getElementById('court'));

let game = null;
let speed = 2;
let playing = true;

const $ = (id) => document.getElementById(id);
const teamColors = () => [cfg.teamA.color, cfg.teamB.color];

function esc(s) {
  return s.replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function onEvent(e) {
  const div = document.createElement('div');
  if (e.type === 'period' || e.type === 'final') {
    div.className = 'ev ev-period' + (e.type === 'final' ? ' ev-final' : '');
    div.textContent = e.text;
  } else {
    div.className = 'ev ev-' + e.type;
    div.style.setProperty('--tc', e.team == null ? '#777' : teamColors()[e.team]);
    const text = esc(e.text)
      .replace(/\[([^\]]*look)\]/, '<span class="ev-cov">$1</span>');
    div.innerHTML =
      `<span class="ev-clock">${e.qLabel} ${e.clock}</span>` +
      `<span class="ev-text">${text}</span>`;
  }
  feedEl.prepend(div);
  while (feedEl.children.length > 250) feedEl.lastChild.remove();
}

function newGame() {
  if (cfg.randomizeEachGame !== false && window.PlayerGen) {
    const used = new Set();
    cfg.teamA.players = PlayerGen.randomRoster(used);
    cfg.teamB.players = PlayerGen.randomRoster(used);
  }
  feedEl.innerHTML = '';
  game = new BBEngine.Game(cfg, { onEvent });
  renderer.setTeams(teamColors());
  $('nameA').textContent = cfg.teamA.name;
  $('nameB').textContent = cfg.teamB.name;
  $('abbrA').textContent = game.teams[0].abbr;
  $('abbrB').textContent = game.teams[1].abbr;
  $('chipA').style.background = cfg.teamA.color;
  $('chipB').style.background = cfg.teamB.color;
  buildBox();
  buildEditor();
}

function fmtHeight(inches) {
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

function buildBox() {
  boxEl.innerHTML = game.teams.map((t, ti) => `
    <div class="box-team">
      <h3 style="color:${t.color}">${esc(t.name)}</h3>
      <table>
        <thead><tr>
          <th class="l">PLAYER</th><th>PTS</th><th>REB</th><th>AST</th>
          <th>STL</th><th>BLK</th><th>TO</th><th>FG</th><th>3PT</th>
        </tr></thead>
        <tbody>
          ${t.players.map(p => `
            <tr title="${esc(`${p.position} ${fmtHeight(p.heightIn)} ${p.weightLb} lb — IQ ${p.iq} · 3PT ${p.threePoint} · MID ${p.midRange} · LAY ${p.layup} · DNK ${p.dunk} · SPD ${p.speed} · PER-D ${p.perimeterD} · INT-D ${p.interiorD} · STL ${p.steal} · BLK ${p.block} · REB ${p.rebound}`)}">
              <td class="l">#${p.number} ${esc(p.name)}</td>
              <td data-s="${p.id}-pts"></td><td data-s="${p.id}-reb"></td>
              <td data-s="${p.id}-ast"></td><td data-s="${p.id}-stl"></td>
              <td data-s="${p.id}-blk"></td><td data-s="${p.id}-tov"></td>
              <td data-s="${p.id}-fg"></td><td data-s="${p.id}-tp"></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');
}

function updateBox() {
  for (const t of game.teams) {
    for (const p of t.players) {
      const s = p.stats;
      const set = (k, v) => {
        const el = boxEl.querySelector(`[data-s="${p.id}-${k}"]`);
        if (el) el.textContent = v;
      };
      set('pts', s.pts); set('reb', s.reb); set('ast', s.ast);
      set('stl', s.stl); set('blk', s.blk); set('tov', s.tov);
      set('fg', `${s.fgm}-${s.fga}`); set('tp', `${s.tpm}-${s.tpa}`);
    }
  }
}

function updateScorebug() {
  $('scoreA').textContent = game.teams[0].score;
  $('scoreB').textContent = game.teams[1].score;
  $('qtr').textContent = game.over ? 'FINAL' : game.qLabel();
  $('gclock').textContent = BBEngine.fmtClock(game.gameClock);
  const sEl = $('sclock');
  const sc = Math.max(0, Math.ceil(game.shotClock));
  sEl.textContent = game.over ? '--' : sc;
  sEl.classList.toggle('hot', game.shotClockActive && sc <= 5);
  sEl.classList.toggle('idle', !game.shotClockActive);
  $('possA').classList.toggle('on', !game.over && game.possession === 0);
  $('possB').classList.toggle('on', !game.over && game.possession === 1);
}

/* ---------- roster editor ---------- */
const editEl = document.getElementById('edit');
let selPid = 0;

const ATTR_SECTIONS = [
  ['PHYSICAL', [
    ['heightIn', 'HEIGHT', 66, 90, fmtHeight],
    ['weightLb', 'WEIGHT', 150, 300, (v) => `${v} lb`],
    ['speed', 'SPEED', 25, 99],
    ['acceleration', 'ACCELERATION', 25, 99],
    ['strength', 'STRENGTH', 25, 99],
    ['vertical', 'VERTICAL', 25, 99],
  ]],
  ['OFFENSE', [
    ['threePoint', '3-POINT', 25, 99],
    ['midRange', 'MID-RANGE', 25, 99],
    ['layup', 'LAYUP', 25, 99],
    ['dunk', 'DUNK', 25, 99],
    ['ballHandle', 'BALL HANDLE', 25, 99],
    ['passAcc', 'PASS ACCURACY', 25, 99],
  ]],
  ['DEFENSE', [
    ['perimeterD', 'PERIMETER D', 25, 99],
    ['interiorD', 'INTERIOR D', 25, 99],
    ['steal', 'STEAL', 25, 99],
    ['block', 'BLOCK', 25, 99],
    ['rebound', 'REBOUND', 25, 99],
  ]],
  ['MENTAL', [
    ['iq', 'BBALL IQ', 25, 99],
  ]],
];
const ALL_ATTRS = ATTR_SECTIONS.flatMap(([, rows]) => rows);
const TEND_ROWS = [
  ['shoot', 'SHOOT', 'eager to fire vs keeps working for a better look'],
  ['three', 'TAKE 3s', 'hunts triples vs stays inside the arc'],
  ['drive', 'DRIVE', 'attacks the rim vs stays put'],
  ['pass', 'PASS', 'moves the ball vs holds it'],
  ['help', 'HELP D', 'rotates to stop drives vs stays home'],
  ['crash', 'CRASH GLASS', 'chases offensive boards vs gets back'],
  ['gamble', 'GAMBLE', 'jumps lanes and reaches vs plays it safe'],
];

const livePlayer = (pid) => game.teams[Math.floor(pid / 5)].players[pid % 5];
const cfgPlayer = (pid) => (pid < 5 ? cfg.teamA : cfg.teamB).players[pid % 5];

function buildEditor() {
  if (!game.teams[Math.floor(selPid / 5)]) selPid = 0;
  editEl.innerHTML = `
    <div class="ed-note">Changes apply to the game in progress immediately.</div>
    ${game.teams.map(t => `
      <div class="ed-team">
        <h3 style="color:${t.color}">${esc(t.name)}</h3>
        <div class="ed-list">
          ${t.players.map(p => `
            <button class="ed-p ${p.id === selPid ? 'on' : ''}" data-pid="${p.id}">
              #${p.number} ${esc(p.name)}
            </button>`).join('')}
        </div>
      </div>`).join('')}
    <div class="ed-form" id="edForm"></div>
    <div class="ed-foot">
      <label class="ed-lock">
        <input type="checkbox" id="edLock" ${cfg.randomizeEachGame === false ? 'checked' : ''}>
        Keep rosters on New Game
      </label>
      <button class="ctl" id="edCopy">COPY ROSTERS AS JSON</button>
    </div>`;
  editEl.querySelectorAll('.ed-p').forEach(b => b.addEventListener('click', () => {
    selPid = Number(b.dataset.pid);
    editEl.querySelectorAll('.ed-p').forEach(x =>
      x.classList.toggle('on', Number(x.dataset.pid) === selPid));
    buildForm();
  }));
  $('edLock').addEventListener('change', (e) => {
    cfg.randomizeEachGame = !e.target.checked;
  });
  $('edCopy').addEventListener('click', () => {
    const dump = JSON.stringify(
      { teamA: cfg.teamA.players, teamB: cfg.teamB.players }, null, 2);
    navigator.clipboard.writeText(dump).then(() => {
      $('edCopy').textContent = 'COPIED ✓';
      setTimeout(() => { $('edCopy').textContent = 'COPY ROSTERS AS JSON'; }, 1500);
    });
  });
  buildForm();
}

function sliderRow(attr, label, min, max, value, fmt, hint) {
  return `
    <div class="ed-row" ${hint ? `title="${hint}"` : ''}>
      <label>${label}<output id="edv-${attr}">${fmt ? fmt(value) : value}</output></label>
      <input type="range" min="${min}" max="${max}" value="${value}" data-edit="${attr}">
    </div>`;
}

function buildForm() {
  const p = livePlayer(selPid);
  const form = $('edForm');
  form.innerHTML = `
    <div class="ed-id">
      <input type="text" id="edName" value="${esc(p.name)}" maxlength="22">
      <input type="number" id="edNum" value="${p.number}" min="0" max="99">
    </div>
    ${ATTR_SECTIONS.map(([title, rows]) => `
      <h4>${title}</h4>
      ${rows.map(([a, l, mn, mx, fmt]) => sliderRow(a, l, mn, mx, p[a], fmt)).join('')}
    `).join('')}
    <h4>TENDENCIES</h4>
    ${TEND_ROWS.map(([k, l, hint]) => sliderRow('tend-' + k, l, 1, 99, p.tend[k], null, hint)).join('')}`;

  form.querySelectorAll('[data-edit]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.edit;
      const v = Number(input.value);
      const live = livePlayer(selPid);
      const raw = cfgPlayer(selPid);
      if (key.startsWith('tend-')) {
        const t = key.slice(5);
        live.tend[t] = v;
        raw.tendencies = raw.tendencies || { ...live.tend };
        raw.tendencies[t] = v;
        $('edv-' + key).textContent = v;
      } else {
        live[key] = v;
        raw[key] = v;
        const row = ALL_ATTRS.find(r => r[0] === key);
        $('edv-' + key).textContent = row[4] ? row[4](v) : v;
      }
      buildBox();
      updateBox();
    });
  });
  $('edName').addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'Player';
    livePlayer(selPid).name = name;
    cfgPlayer(selPid).name = name;
    refreshEditorLabels();
    buildBox();
    updateBox();
  });
  $('edNum').addEventListener('change', (e) => {
    const num = Math.max(0, Math.min(99, Number(e.target.value) || 0));
    livePlayer(selPid).number = num;
    cfgPlayer(selPid).number = num;
    refreshEditorLabels();
    buildBox();
    updateBox();
  });
}

function refreshEditorLabels() {
  editEl.querySelectorAll('.ed-p').forEach(b => {
    const p = livePlayer(Number(b.dataset.pid));
    b.textContent = `#${p.number} ${p.name}`;
  });
}

/* ---------- controls ---------- */
$('btnPlay').addEventListener('click', () => {
  playing = !playing;
  $('btnPlay').textContent = playing ? '⏸ PAUSE' : '▶ PLAY';
});
$('btnNew').addEventListener('click', () => {
  newGame();
  playing = true;
  $('btnPlay').textContent = '⏸ PAUSE';
});
document.querySelectorAll('[data-speed]').forEach(btn => {
  btn.addEventListener('click', () => {
    speed = Number(btn.dataset.speed);
    document.querySelectorAll('[data-speed]').forEach(b =>
      b.classList.toggle('on', b === btn));
  });
});
const panes = { feed: feedEl, box: boxEl, edit: document.getElementById('edit') };
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b =>
      b.classList.toggle('on', b === btn));
    for (const key in panes) panes[key].classList.toggle('hidden', key !== btn.dataset.tab);
  });
});

/* ---------- loop ---------- */
let lastT = performance.now();
let boxTimer = 0;
function frame(now) {
  const real = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (playing && game && !game.over) {
    let sim = real * speed;
    while (sim > 0) {
      const s = Math.min(sim, 1 / 30);
      game.step(s);
      sim -= s;
    }
  }
  if (game) {
    renderer.draw(game, real);
    updateScorebug();
    boxTimer += real;
    if (boxTimer > 0.25) { boxTimer = 0; updateBox(); }
  }
  requestAnimationFrame(frame);
}

newGame();
document.querySelector(`[data-speed="${speed}"]`).classList.add('on');
requestAnimationFrame(frame);

})();
