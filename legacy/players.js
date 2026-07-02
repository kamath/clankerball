'use strict';
/* ============================================================
   players.js — team & player configuration
   This is the file to edit when you want different players.

   Each player object (all ratings 25–99):
     name        display name
     number      jersey number
     pos         label only (PG/SG/SF/PF/C)
     heightIn    height in inches  (e.g. 78 = 6'6")
     weightLb    weight in pounds

     iq          basketball IQ (decision quality everywhere)
     threePoint  three-point shooting
     midRange    mid-range shooting
     layup       inside layup finishing
     dunk        dunking
     ballHandle  dribble security & finishing through traffic
     passAcc     pass accuracy (turnover avoidance, assists)

     speed       top speed
     acceleration  how fast they reach top speed
     strength    body strength (guarding up, rebounding, strips)
     vertical    leaping (contests, blocks, boards, dunks)

     perimeterD  contesting jumpers, on-ball pressure outside
     interiorD   contesting shots inside
     steal       hands: strips & passing-lane picks
     block       shot blocking
     rebound     rebounding craft

     tendencies (each 1–99, defaults 50):
       shoot   eager to fire vs keeps working for better looks
       three   hunts three-pointers
       drive   attacks the rim
       pass    willing to move the ball
       help    rotates to help on drives
       crash   crashes the offensive glass vs gets back
       gamble  jumps passing lanes / reaches for strips

   Any rating you omit is filled in with a plausible value derived
   from height/weight/IQ/dunk — see fillRatings() in engine.js.
   ============================================================ */
(function (global) {

/* ----------------------------------------------------------------
   REAL-PLAYER ROSTERS (the default matchup)
   Lockdown Five: small elite defenders + rim protection.
   Firepower Five: maximum offensive talent.
   ---------------------------------------------------------------- */
const LOCKDOWN = [
  { name: 'Jose Alvarado', number: 15, pos: 'PG', heightIn: 72, weightLb: 179,
    iq: 88, threePoint: 78, midRange: 72, layup: 75, dunk: 30, ballHandle: 84, passAcc: 82,
    speed: 92, acceleration: 95, strength: 55, vertical: 70,
    perimeterD: 90, interiorD: 40, steal: 95, block: 25, rebound: 40,
    tendencies: { shoot: 55, three: 65, drive: 55, pass: 70, help: 85, crash: 40, gamble: 92 } },
  { name: 'Alex Caruso', number: 9, pos: 'SG', heightIn: 77, weightLb: 186,
    iq: 95, threePoint: 80, midRange: 74, layup: 78, dunk: 70, ballHandle: 78, passAcc: 85,
    speed: 85, acceleration: 86, strength: 70, vertical: 80,
    perimeterD: 97, interiorD: 60, steal: 96, block: 55, rebound: 55,
    tendencies: { shoot: 40, three: 60, drive: 45, pass: 80, help: 92, crash: 35, gamble: 85 } },
  { name: 'Marcus Smart', number: 36, pos: 'SF', heightIn: 76, weightLb: 220,
    iq: 92, threePoint: 75, midRange: 73, layup: 74, dunk: 55, ballHandle: 82, passAcc: 84,
    speed: 80, acceleration: 82, strength: 88, vertical: 70,
    perimeterD: 96, interiorD: 70, steal: 92, block: 40, rebound: 50,
    tendencies: { shoot: 50, three: 68, drive: 50, pass: 78, help: 88, crash: 35, gamble: 80 } },
  { name: 'Draymond Green', number: 23, pos: 'PF', heightIn: 78, weightLb: 230,
    iq: 97, threePoint: 62, midRange: 65, layup: 72, dunk: 60, ballHandle: 75, passAcc: 92,
    speed: 72, acceleration: 70, strength: 90, vertical: 65,
    perimeterD: 88, interiorD: 92, steal: 80, block: 75, rebound: 78,
    tendencies: { shoot: 30, three: 45, drive: 40, pass: 92, help: 95, crash: 45, gamble: 60 } },
  { name: 'Rudy Gobert', number: 27, pos: 'C', heightIn: 85, weightLb: 258,
    iq: 75, threePoint: 25, midRange: 40, layup: 85, dunk: 92, ballHandle: 35, passAcc: 55,
    speed: 65, acceleration: 58, strength: 92, vertical: 85,
    perimeterD: 60, interiorD: 97, steal: 45, block: 97, rebound: 95,
    tendencies: { shoot: 35, three: 5, drive: 70, pass: 35, help: 80, crash: 70, gamble: 25 } },
];

const FIREPOWER = [
  { name: 'Stephen Curry', number: 30, pos: 'PG', heightIn: 74, weightLb: 185,
    iq: 96, threePoint: 99, midRange: 90, layup: 85, dunk: 35, ballHandle: 95, passAcc: 90,
    speed: 84, acceleration: 86, strength: 60, vertical: 65,
    perimeterD: 62, interiorD: 35, steal: 70, block: 20, rebound: 40,
    tendencies: { shoot: 85, three: 95, drive: 45, pass: 75, help: 50, crash: 25, gamble: 55 } },
  { name: 'Shai Gilgeous-Alexander', number: 2, pos: 'SG', heightIn: 78, weightLb: 195,
    iq: 92, threePoint: 80, midRange: 94, layup: 93, dunk: 75, ballHandle: 93, passAcc: 82,
    speed: 86, acceleration: 88, strength: 70, vertical: 75,
    perimeterD: 78, interiorD: 55, steal: 82, block: 50, rebound: 50,
    tendencies: { shoot: 80, three: 45, drive: 85, pass: 60, help: 60, crash: 30, gamble: 65 } },
  { name: 'Kevin Durant', number: 35, pos: 'SF', heightIn: 83, weightLb: 240,
    iq: 90, threePoint: 90, midRange: 97, layup: 88, dunk: 85, ballHandle: 85, passAcc: 78,
    speed: 76, acceleration: 74, strength: 70, vertical: 75,
    perimeterD: 72, interiorD: 70, steal: 50, block: 70, rebound: 60,
    tendencies: { shoot: 85, three: 60, drive: 55, pass: 55, help: 55, crash: 30, gamble: 35 } },
  { name: 'LeBron James', number: 23, pos: 'PF', heightIn: 81, weightLb: 250,
    iq: 99, threePoint: 75, midRange: 80, layup: 95, dunk: 90, ballHandle: 90, passAcc: 96,
    speed: 80, acceleration: 78, strength: 95, vertical: 80,
    perimeterD: 75, interiorD: 78, steal: 65, block: 65, rebound: 75,
    tendencies: { shoot: 60, three: 50, drive: 80, pass: 90, help: 70, crash: 45, gamble: 50 } },
  { name: 'Nikola Jokic', number: 15, pos: 'C', heightIn: 83, weightLb: 284,
    iq: 99, threePoint: 78, midRange: 85, layup: 95, dunk: 70, ballHandle: 88, passAcc: 99,
    speed: 60, acceleration: 55, strength: 92, vertical: 50,
    perimeterD: 50, interiorD: 75, steal: 70, block: 55, rebound: 92,
    tendencies: { shoot: 55, three: 40, drive: 65, pass: 95, help: 60, crash: 60, gamble: 50 } },
];

/* ----------------------------------------------------------------
   RANDOM ROSTER GENERATOR (used when randomizeEachGame is true)
   ---------------------------------------------------------------- */
const FIRST = ['Jalen', 'Marcus', 'Dre', 'Theo', 'Kofi', 'Luka', 'Mateo', 'Zion',
  'Andre', 'Cole', 'Darius', 'Idris', 'Niko', 'Trey', 'Omar', 'Sasha',
  'Jordan', 'Kai', 'Reggie', 'Vince', 'Eli', 'Moses', 'Pax', 'Rudy'];
const LAST = ['Brooks', 'Okafor', 'Vance', 'Whitfield', 'Carter', 'Reyes', 'Mbeki',
  'Halvorsen', 'Drummond', 'Pierce', 'Sato', 'Kovac', 'Ellison', 'Fontaine',
  'Marsh', 'Quarles', 'Tidwell', 'Osei', 'Navarro', 'Bright', 'Calloway', 'Iversen'];

const ARCHETYPES = [
  { pos: 'PG', h: [71, 76], w: [165, 195], iq: [70, 99], three: [60, 92], mid: [60, 92], layup: [65, 92], dunk: [25, 60],
    bh: [80, 96], pas: [75, 95], spd: [82, 95], acc: [85, 96], str: [40, 65], vrt: [55, 85],
    pd: [55, 90], idf: [30, 55], stl: [55, 90], blk: [25, 40], reb: [30, 50],
    tShoot: [40, 70], tThree: [45, 80], tDrive: [45, 80], tPass: [70, 99], tHelp: [40, 75], tCrash: [20, 45], tGamble: [40, 85] },
  { pos: 'SG', h: [74, 78], w: [180, 210], iq: [60, 92], three: [65, 95], mid: [62, 94], layup: [60, 88], dunk: [35, 75],
    bh: [70, 90], pas: [55, 80], spd: [78, 90], acc: [80, 92], str: [50, 72], vrt: [60, 88],
    pd: [55, 92], idf: [35, 60], stl: [50, 85], blk: [30, 55], reb: [35, 55],
    tShoot: [50, 85], tThree: [55, 88], tDrive: [40, 75], tPass: [40, 70], tHelp: [40, 75], tCrash: [25, 50], tGamble: [40, 80] },
  { pos: 'SF', h: [77, 81], w: [200, 235], iq: [55, 90], three: [55, 88], mid: [58, 90], layup: [62, 90], dunk: [50, 88],
    bh: [60, 85], pas: [50, 80], spd: [72, 86], acc: [72, 86], str: [60, 82], vrt: [60, 88],
    pd: [55, 90], idf: [45, 75], stl: [45, 80], blk: [40, 70], reb: [45, 70],
    tShoot: [45, 80], tThree: [40, 75], tDrive: [50, 85], tPass: [45, 75], tHelp: [45, 80], tCrash: [30, 60], tGamble: [35, 70] },
  { pos: 'PF', h: [80, 83], w: [225, 255], iq: [50, 88], three: [35, 78], mid: [50, 85], layup: [68, 92], dunk: [60, 95],
    bh: [45, 70], pas: [40, 70], spd: [62, 78], acc: [60, 78], str: [72, 92], vrt: [55, 85],
    pd: [45, 75], idf: [60, 90], stl: [35, 65], blk: [55, 85], reb: [65, 90],
    tShoot: [40, 70], tThree: [25, 60], tDrive: [50, 85], tPass: [35, 65], tHelp: [50, 85], tCrash: [40, 75], tGamble: [25, 60] },
  { pos: 'C',  h: [82, 87], w: [240, 285], iq: [45, 85], three: [25, 60], mid: [40, 78], layup: [72, 96], dunk: [70, 99],
    bh: [30, 55], pas: [35, 65], spd: [50, 70], acc: [48, 68], str: [80, 97], vrt: [50, 85],
    pd: [35, 60], idf: [70, 97], stl: [30, 55], blk: [65, 97], reb: [75, 97],
    tShoot: [35, 65], tThree: [10, 45], tDrive: [55, 90], tPass: [30, 60], tHelp: [55, 90], tCrash: [50, 85], tGamble: [20, 50] },
];

const ri = (r) => r[0] + Math.floor(Math.random() * (r[1] - r[0] + 1));

function randomRoster(usedNames) {
  usedNames = usedNames || new Set();
  const usedNumbers = new Set();
  return ARCHETYPES.map(a => {
    let name;
    do { name = `${FIRST[Math.floor(Math.random() * FIRST.length)]} ${LAST[Math.floor(Math.random() * LAST.length)]}`; }
    while (usedNames.has(name));
    usedNames.add(name);
    let number;
    do { number = Math.floor(Math.random() * 45); } while (usedNumbers.has(number));
    usedNumbers.add(number);
    return {
      name, number, pos: a.pos,
      heightIn: ri(a.h), weightLb: ri(a.w),
      iq: ri(a.iq), threePoint: ri(a.three), midRange: ri(a.mid),
      layup: ri(a.layup), dunk: ri(a.dunk),
      ballHandle: ri(a.bh), passAcc: ri(a.pas),
      speed: ri(a.spd), acceleration: ri(a.acc), strength: ri(a.str), vertical: ri(a.vrt),
      perimeterD: ri(a.pd), interiorD: ri(a.idf), steal: ri(a.stl), block: ri(a.blk), rebound: ri(a.reb),
      tendencies: {
        shoot: ri(a.tShoot), three: ri(a.tThree), drive: ri(a.tDrive), pass: ri(a.tPass),
        help: ri(a.tHelp), crash: ri(a.tCrash), gamble: ri(a.tGamble),
      },
    };
  });
}

global.PlayerGen = { randomRoster, ARCHETYPES, LOCKDOWN, FIREPOWER };

global.GAME_CONFIG = {
  quarterMinutes: 12,
  /* false = keep the rosters below on New Game (default: real players).
     true  = generate fresh random rosters every New Game. */
  randomizeEachGame: false,
  teamA: {
    name: 'Lockdown Five',
    abbr: 'LCK',
    color: '#21b0b8',
    players: LOCKDOWN,
  },
  teamB: {
    name: 'Firepower Five',
    abbr: 'FPW',
    color: '#ef5b2b',
    players: FIREPOWER,
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlayerGen: global.PlayerGen, GAME_CONFIG: global.GAME_CONFIG };
}

})(typeof window !== 'undefined' ? window : globalThis);
