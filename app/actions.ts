"use server";
/* ============================================================
   actions.ts — server actions: list teams, build a real matchup
   ============================================================ */
import {
  DEFAULT_SEASON,
  getActiveRoster,
  getLeagueData,
  getTeams,
  type NbaPlayerIdentity,
  type NbaTeam,
} from "@/lib/nba/client";
import { fallbackPlayer, makeScout, ratePlayer } from "@/lib/nba/scout";
import type { GameConfig, PlayerConfig, TeamConfig } from "@/lib/types";

/** Primary team colors, keyed by abbreviation. */
const TEAM_COLORS: Record<string, string> = {
  ATL: "#e03a3e", BOS: "#007a33", BKN: "#000000", CHA: "#1d1160", CHI: "#ce1141",
  CLE: "#860038", DAL: "#00538c", DEN: "#0e2240", DET: "#c8102e", GSW: "#1d428a",
  HOU: "#ce1141", IND: "#002d62", LAC: "#c8102e", LAL: "#552583", MEM: "#5d76a9",
  MIA: "#98002e", MIL: "#00471b", MIN: "#0c2340", NOP: "#0c2340", NYK: "#006bb6",
  OKC: "#007ac1", ORL: "#0077c0", PHI: "#006bb6", PHX: "#1d1160", POR: "#e03a3e",
  SAC: "#5a2d81", SAS: "#c4ced4", TOR: "#ce1141", UTA: "#002b5c", WAS: "#002b5c",
};

const colorFor = (abbr: string) => TEAM_COLORS[abbr] || "#777777";

export interface TeamOption {
  id: number;
  abbr: string;
  fullName: string;
  conference: string;
}

export async function listTeams(): Promise<TeamOption[]> {
  const teams = await getTeams();
  return teams.map((t: NbaTeam) => ({
    id: t.id,
    abbr: t.abbreviation,
    fullName: t.full_name,
    conference: t.conference,
  }));
}

async function buildTeam(
  teamId: number,
  season: number
): Promise<TeamConfig> {
  const [roster, league] = await Promise.all([getActiveRoster(teamId), getLeagueData(season)]);
  const scout = makeScout(league.dist);

  // Split the current roster into those with season stats and those without.
  const withStats: { id: NbaPlayerIdentity; min: number }[] = [];
  const withoutStats: NbaPlayerIdentity[] = [];
  for (const id of roster) {
    const s = league.byId.get(id.id);
    if (s && s.gp >= 10 && s.min >= 8) withStats.push({ id, min: s.min });
    else withoutStats.push(id);
  }
  withStats.sort((a, b) => b.min - a.min);

  // Starting five = the five highest-minute players who have stats; backfill
  // from statless identities only if a team is short (rare).
  const players: PlayerConfig[] = [];
  let n = 0;
  for (const { id } of withStats.slice(0, 5)) {
    players.push(ratePlayer(league.byId.get(id.id)!, scout, 30 + n++));
  }
  for (const id of withoutStats) {
    if (players.length >= 5) break;
    players.push(fallbackPlayer(id, 30 + n++));
  }

  const team = roster[0]?.team;
  const abbr = team?.abbreviation || "NBA";
  return {
    name: team?.full_name || "Team",
    abbr,
    color: colorFor(abbr),
    players,
  };
}

export async function buildMatchup(
  teamAId: number,
  teamBId: number,
  season: number = DEFAULT_SEASON
): Promise<GameConfig> {
  const [teamA, teamB] = await Promise.all([
    buildTeam(teamAId, season),
    buildTeam(teamBId, season),
  ]);
  return { quarterMinutes: 12, randomizeEachGame: false, teamA, teamB };
}
