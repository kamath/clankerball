/* ============================================================
   roster-scout.ts — serialize live rosters into the compact,
   serializable snapshot the plan compiler reads.
   ============================================================ */
import type { ScoutPlayer } from "./schemas";
import type { Player } from "./types";

export function scoutRoster(players: Player[]): ScoutPlayer[] {
  return players.map((p, slot) => ({
    slot,
    name: p.name,
    number: p.number,
    pos: p.position,
    heightIn: p.heightIn,
    ratings: {
      iq: p.iq,
      threePoint: p.threePoint,
      midRange: p.midRange,
      layup: p.layup,
      dunk: p.dunk,
      ballHandle: p.ballHandle,
      passAcc: p.passAcc,
      speed: p.speed,
      strength: p.strength,
      perimeterD: p.perimeterD,
      interiorD: p.interiorD,
      steal: p.steal,
      block: p.block,
      rebound: p.rebound,
    },
    // base tendencies, so a re-compile isn't biased by the current plan
    tendencies: { ...p.baseTend },
  }));
}
