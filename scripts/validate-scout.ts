/* Throwaway validation: pull real 2024 season data, run the scout model,
   and print ratings for defenders the box score normally misses. */
import { config } from "dotenv";
config();
import { computeDistributions, mergeRows, type SeasonRow } from "../lib/nba/model";
import { makeScout, ratePlayer } from "../lib/nba/scout";

const BASE = "https://api.balldontlie.io";
const KEY = process.env.BALLDONTLIE_API_KEY!;
const H = { Authorization: KEY };

async function getAll(make: (c: number | null) => string): Promise<SeasonRow[]> {
  const out: SeasonRow[] = [];
  let cursor: number | null = null;
  for (let i = 0; i < 40; i++) {
    const resp = await fetch(`${BASE}${make(cursor)}`, { headers: H });
    const j: { data: SeasonRow[]; meta?: { next_cursor?: number | null } } = await resp.json();
    out.push(...j.data);
    if (j.meta?.next_cursor == null) break;
    cursor = j.meta.next_cursor;
  }
  return out;
}

const cq = (c: number | null) => (c == null ? "" : `&cursor=${c}`);

async function main() {
  const q = "season=2024&season_type=regular&per_page=100";
  const [base, defense, hustle] = await Promise.all([
    getAll((c) => `/nba/v1/season_averages/general?${q}&type=base${cq(c)}`),
    getAll((c) => `/nba/v1/season_averages/general?${q}&type=defense${cq(c)}`),
    getAll((c) => `/nba/v1/season_averages/hustle?${q}&type=base${cq(c)}`),
  ]);
  console.log(`pulled base=${base.length} defense=${defense.length} hustle=${hustle.length}`);
  const byId = mergeRows(base, defense, hustle);
  const dist = computeDistributions(byId);
  const scout = makeScout(dist);

  const names = [
    "Marcus Smart", "Jose Alvarado", "Draymond Green", "Rudy Gobert",
    "Alex Caruso", "Stephen Curry", "Nikola Jokic", "Shai Gilgeous-Alexander",
    "Kevin Durant", "Victor Wembanyama", "Dyson Daniels", "Herbert Jones",
  ];
  const byName = new Map<string, ReturnType<typeof byId.get>>();
  for (const s of byId.values()) byName.set(`${s.player.first_name} ${s.player.last_name}`, s);

  const cols = ["perimeterD", "interiorD", "steal", "block", "rebound", "threePoint", "midRange", "iq", "speed"] as const;
  console.log("\nPLAYER".padEnd(26) + cols.map((c) => c.slice(0, 5).toUpperCase().padStart(6)).join("") + "   gp  min  defWS  defl  chrg");
  for (const name of names) {
    const s = byName.get(name);
    if (!s) { console.log(name.padEnd(26) + "  (no 2024 stats)"); continue; }
    const p = ratePlayer(s, scout, 0);
    const row = cols.map((c) => String((p as any)[c]).padStart(6)).join("");
    const extra = `  ${String(s.gp).padStart(3)} ${String(Math.round(s.min)).padStart(4)} ${String(s.def_ws ?? "-").padStart(6)} ${String(s.deflections ?? "-").padStart(5)} ${String(s.charges_drawn ?? "-").padStart(5)}`;
    console.log(name.padEnd(26) + row + extra);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
