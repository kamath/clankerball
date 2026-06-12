/* ============================================================
   nba/client.ts — balldontlie API access (server-only)
   Pulls current rosters and season averages, and builds the
   league-wide distributions the scout model scales against.
   The API key never leaves the server. Pure shapes + the
   distribution math live in ./model.
   ============================================================ */
import "server-only";
import {
  computeDistributions,
  mergeRows,
  type Distributions,
  type MergedStats,
  type NbaPlayerIdentity,
  type NbaTeam,
  type SeasonRow,
} from "./model";

export type { Distributions, MergedStats, NbaPlayerIdentity, NbaTeam } from "./model";
export { per36 } from "./model";

const BASE = "https://api.balldontlie.io";

/** Default season ratings derive from: 2024-25, complete & stable. */
export const DEFAULT_SEASON = 2024;

function authHeader(): HeadersInit {
  const key = process.env.BALLDONTLIE_API_KEY;
  if (!key) throw new Error("BALLDONTLIE_API_KEY is not set");
  return { Authorization: key };
}

interface Page<T> {
  data: T[];
  meta?: { next_cursor?: number | null; per_page?: number };
}

async function getJson<T>(path: string): Promise<Page<T>> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeader(),
    next: { revalidate: 86400 }, // season data is static; cache 1 day
  });
  if (!res.ok) {
    throw new Error(`balldontlie ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Page through a cursor-paginated endpoint, collecting all rows. */
async function getAll<T>(makePath: (cursor: number | null) => string): Promise<T[]> {
  const out: T[] = [];
  let cursor: number | null = null;
  for (let i = 0; i < 40; i++) {
    const page: Page<T> = await getJson<T>(makePath(cursor));
    out.push(...page.data);
    const next = page.meta?.next_cursor;
    if (next == null) break;
    cursor = next;
  }
  return out;
}

export async function getTeams(): Promise<NbaTeam[]> {
  const page = await getJson<NbaTeam>("/v1/teams?per_page=100");
  return page.data
    .filter((t) => t.city && t.abbreviation && t.division)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function getActiveRoster(teamId: number): Promise<NbaPlayerIdentity[]> {
  const page = await getJson<NbaPlayerIdentity>(
    `/v1/players/active?team_ids[]=${teamId}&per_page=100`
  );
  return page.data;
}

export interface LeagueData {
  season: number;
  byId: Map<number, MergedStats>;
  dist: Distributions;
}

const cursorQ = (cursor: number | null) => (cursor == null ? "" : `&cursor=${cursor}`);
const leagueCache = new Map<number, Promise<LeagueData>>();

export function getLeagueData(season: number = DEFAULT_SEASON): Promise<LeagueData> {
  let cached = leagueCache.get(season);
  if (!cached) {
    cached = buildLeagueData(season);
    leagueCache.set(season, cached);
  }
  return cached;
}

async function buildLeagueData(season: number): Promise<LeagueData> {
  const q = `season=${season}&season_type=regular&per_page=100`;
  const [base, defense, hustle] = await Promise.all([
    getAll<SeasonRow>((c) => `/nba/v1/season_averages/general?${q}&type=base${cursorQ(c)}`),
    getAll<SeasonRow>((c) => `/nba/v1/season_averages/general?${q}&type=defense${cursorQ(c)}`),
    getAll<SeasonRow>((c) => `/nba/v1/season_averages/hustle?${q}&type=base${cursorQ(c)}`),
  ]);
  const byId = mergeRows(base, defense, hustle);
  return { season, byId, dist: computeDistributions(byId) };
}
