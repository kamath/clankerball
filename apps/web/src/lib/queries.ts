/* ============================================================
   queries.ts — React Query hooks over the typed Hono RPC client.
   Reads (team list) are queries; the write-shaped calls (build a
   matchup) are mutations the components await.
   ============================================================ */
"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { BuildMatchupInput } from "@repo/shared";
import { fetchAllPlayers, fetchMatchup, fetchTeams } from "./api";

/** The NBA team list for the picker. Static per season, so cache hard. */
export function useTeams() {
  return useQuery({
    queryKey: ["teams"],
    queryFn: fetchTeams,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/** The leaguewide rated player pool, fetched lazily — only once a combobox is
    actually searching beyond its own team. Static per season, so cache hard;
    the first search pays for it and every later one is instant. */
export function useAllPlayers(enabled = true) {
  return useQuery({
    queryKey: ["players"],
    queryFn: fetchAllPlayers,
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/** Build a real NBA matchup into a GameConfig. */
export function useBuildMatchup() {
  return useMutation({
    mutationKey: ["matchup"],
    mutationFn: (input: BuildMatchupInput) => fetchMatchup(input),
  });
}
