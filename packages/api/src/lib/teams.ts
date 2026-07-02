/* ============================================================
   teams.ts — list NBA teams and assemble a real head-to-head
   matchup from balldontlie rosters + season-derived ratings.
   Server-only: pulls behind the API key, then hands the client a
   plain GameConfig. (Formerly app/actions.ts.)
   ============================================================ */
import type { GameConfig, PlayerConfig, RosterPlayer, TeamConfig, TeamOption } from "@repo/shared";
import {
  DEFAULT_SEASON,
  getActiveRoster,
  getLeagueData,
  getTeams,
  type NbaPlayerIdentity,
  type NbaTeam,
} from "./nba/client";
import { fallbackPlayer, makeScout, ratePlayer } from "./nba/scout";

export { DEFAULT_SEASON };

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

/** Every rated player in the league (this season), so the picker can sub in
    anyone — not just the two teams in the matchup. Ordered by minutes so the
    most relevant names surface first before the user types a search. */
export async function listAllPlayers(season: number = DEFAULT_SEASON): Promise<RosterPlayer[]> {
  const league = await getLeagueData(season);
  const scout = makeScout(league.dist);
  const rows = [...league.byId.values()]
    .filter((s) => s.gp >= 5 && s.min >= 5)
    .sort((a, b) => b.min - a.min);
  return rows.map((s, i) => ({
    ...ratePlayer(s, scout, 30 + (i % 70)),
    teamAbbr: s.player.team?.abbreviation,
  }));
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

async function buildTeam(teamId: number, season: number): Promise<TeamConfig> {
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

  // Rate the whole active roster so any teammate can be subbed onto the court:
  // statted players first (ordered by minutes), then the statless ones.
  const pool: PlayerConfig[] = [];
  let n = 0;
  for (const { id } of withStats) {
    pool.push(ratePlayer(league.byId.get(id.id)!, scout, 30 + n++));
  }
  for (const id of withoutStats) {
    pool.push(fallbackPlayer(id, 30 + n++));
  }

  const team = roster[0]?.team;
  const abbr = team?.abbreviation || "NBA";
  return {
    name: team?.full_name || "Team",
    abbr,
    color: colorFor(abbr),
    // default starters = the five highest-minute players; the rest sit on the
    // bench and can be swapped in from the full roster below.
    players: pool.slice(0, 5),
    roster: pool,
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
