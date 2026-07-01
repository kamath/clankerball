/* ============================================================
   queries.ts — React Query hooks over the typed Hono RPC client.
   Reads (team list) are queries; the write-shaped calls (build a
   matchup, compile a plan) are mutations the components await.
   ============================================================ */
"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { BuildMatchupInput, CompileRequest } from "@repo/shared";
import { fetchCompiledPlan, fetchMatchup, fetchTeams } from "./api";

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

/** Build a real NBA matchup into a GameConfig. */
export function useBuildMatchup() {
  return useMutation({
    mutationKey: ["matchup"],
    mutationFn: (input: BuildMatchupInput) => fetchMatchup(input),
  });
}

/** Compile free-text coaching instructions into a TeamPlan. */
export function useCompilePlan() {
  return useMutation({
    mutationKey: ["compile"],
    mutationFn: (input: CompileRequest) => fetchCompiledPlan(input),
  });
}
