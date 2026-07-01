/* Headless check for coached game plans.
   A) engine mechanics: run lab possessions with a hand-built pick-and-roll
      plan and a get-open plan, confirm screens happen and possessions end.
   B) AI compile: turn real coach-speak into plans via AI Gateway
      (needs AI_GATEWAY_API_KEY; skipped if missing).
   Run with: npx tsx scripts/plan-check.ts */
import "dotenv/config";
import { Game } from "../lib/engine";
import { DEFAULT_CONFIG } from "../lib/players";
import type { TeamPlan } from "../lib/plan";
import { describePlan } from "../lib/plan";
import { compileTeamPlan } from "../lib/ai/compile";
import { scoutRoster } from "../lib/roster-scout";
import type { SimEvent } from "../lib/types";

const DT = 1 / 30;

function runPossessions(plan: TeamPlan, n: number) {
  const events: SimEvent[] = [];
  const game = new Game(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), {
    onEvent: (e) => events.push(e),
  });
  // FIREPOWER is teamB (index 1): Curry 0, SGA 1, KD 2, LeBron 3, Jokic 4
  let picks = 0;
  let scores = 0;
  let stalls = 0;
  for (let i = 0; i < n; i++) {
    events.length = 0;
    game.runPossession({ offense: 1, plan });
    let guard = 0;
    while (!game.frozen && guard++ < 60 * 30) game.step(DT);
    if (guard >= 60 * 30) stalls++;
    picks += events.filter((e) => e.text.includes("sets the pick")).length;
    scores += events.filter((e) => e.type === "score" || e.type === "dunk").length;
  }
  return { picks, scores, stalls };
}

// ---- A) engine mechanics ----
const pnrPlan: TeamPlan = {
  summary: "Curry/Jokic pick and roll",
  handlerSlot: 0,
  scorerSlots: [0, 4],
  actions: [
    { type: "pickAndRoll", handlerSlot: 0, screenerSlot: 4, targetSlot: null, finish: "roll" },
  ],
  directives: [],
  defScheme: null,
  pace: null,
  inbound: null,
  inbounderSlot: null,
};
const pnr = runPossessions(pnrPlan, 25);
console.log(`PnR plan over 25 possessions: picks set=${pnr.picks} scores=${pnr.scores} stalls=${pnr.stalls}`);
if (pnr.picks === 0) throw new Error("pick-and-roll never produced a screen");
if (pnr.stalls > 0) throw new Error("possessions stalled");

const openPlan: TeamPlan = {
  summary: "Get Steph open",
  handlerSlot: 3,
  scorerSlots: [0],
  actions: [{ type: "getOpen", handlerSlot: null, screenerSlot: 4, targetSlot: 0, finish: null }],
  directives: [{ slot: 0, note: "HUNT 3s", tendencyBias: { three: 25, shoot: 20 } }],
  defScheme: null,
  pace: null,
  inbound: null,
  inbounderSlot: null,
};
const open = runPossessions(openPlan, 25);
console.log(`Get-open plan over 25 possessions: scores=${open.scores} stalls=${open.stalls}`);
if (open.stalls > 0) throw new Error("possessions stalled");
console.log("A) engine mechanics OK\n");

// ---- B) AI compile ----
(async () => {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log("B) skipped — no AI_GATEWAY_API_KEY");
    return;
  }
  const game = new Game(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), {});
  const fire = scoutRoster(game.teams[1].players);
  const lock = scoutRoster(game.teams[0].players);
  const names = game.teams[1].players.map((p) => p.name.split(" ").slice(-1)[0]);

  for (const instructions of [
    "team initiative: pick and roll, jokic screener, curry ball handler",
    "get steph open",
  ]) {
    const res = await compileTeamPlan({
      instructions,
      teamName: "Firepower Five",
      roster: fire,
      opponentName: "Lockdown Five",
      opponentRoster: lock,
      context: "lab-offense",
    });
    console.log(`\n"${instructions}" →`);
    if (!res.ok) throw new Error(res.error);
    console.log("  summary:", res.plan.summary);
    for (const l of describePlan(res.plan, names)) console.log("  •", l);
    const out = runPossessions(res.plan, 10);
    console.log(`  10 possessions: picks=${out.picks} scores=${out.scores} stalls=${out.stalls}`);
    if (out.stalls > 0) throw new Error("possessions stalled");
  }

  const defRes = await compileTeamPlan({
    instructions: "2-3 zone, crash the defensive glass, no gambling",
    teamName: "Lockdown Five",
    roster: lock,
    opponentName: "Firepower Five",
    opponentRoster: fire,
    context: "lab-defense",
  });
  console.log(`\n"2-3 zone, crash the defensive glass, no gambling" →`);
  if (!defRes.ok) throw new Error(defRes.error);
  console.log("  summary:", defRes.plan.summary);
  console.log("  defScheme:", defRes.plan.defScheme, "| directives:", JSON.stringify(defRes.plan.directives));
  console.log("\nB) AI compile OK");
})();
