"use client";
/* ============================================================
   PlayerCombobox — searchable player picker for a lineup slot.
   Opens focused on a search box that lists the loaded team's
   roster first; as soon as you type, it pulls the full league so
   you can drop in anyone in the NBA. Players already starting in
   another slot are hidden, so the five on the court stay distinct.
   ============================================================ */
import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAllPlayers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { PlayerConfig, RosterPlayer } from "@repo/shared";

interface PlayerComboboxProps {
  /** the player currently in this slot */
  current: { number: number; name: string; pos?: string; nbaId?: number };
  /** the loaded team's full roster, shown before any search */
  teamPool: PlayerConfig[];
  /** nbaIds already starting in other slots — hidden to avoid duplicates */
  excludeIds: Set<number | undefined>;
  onSelect: (p: PlayerConfig) => void;
}

const lastName = (n: string) => n.split(" ").slice(-1)[0];
const MAX_RESULTS = 60;

export function PlayerCombobox({ current, teamPool, excludeIds, onSelect }: PlayerComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();

  // Only reach for the leaguewide pool once the user actually searches.
  const { data: allPlayers = [], isFetching } = useAllPlayers(q.length > 0);

  const keep = (p: PlayerConfig) => p.nbaId === current.nbaId || !excludeIds.has(p.nbaId);
  // No search: the team roster. Searching: everyone whose name matches.
  const list = (
    q.length === 0
      ? teamPool.filter(keep)
      : allPlayers.filter((p) => keep(p) && p.name.toLowerCase().includes(q))
  ).slice(0, MAX_RESULTS);

  const choose = (p: RosterPlayer | PlayerConfig) => {
    // strip the display-only team tag so only PlayerConfig fields reach the game
    const { teamAbbr: _omit, ...player } = p as RosterPlayer;
    onSelect(player);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 flex-1 justify-between gap-2 font-normal"
        >
          <span className="truncate">
            #{current.number} {lastName(current.name)}
            {current.pos ? ` · ${current.pos}` : ""}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        {/* shouldFilter off: we decide the list (team vs. league) ourselves. */}
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder="Search all NBA players…"
          />
          <CommandList>
            {list.length === 0 && (
              <CommandEmpty>
                {q.length > 0 && isFetching ? "Searching…" : "No player found."}
              </CommandEmpty>
            )}
            {list.map((p) => (
              <CommandItem
                key={p.nbaId ?? p.name}
                value={`${p.name} ${p.nbaId ?? ""}`}
                onSelect={() => choose(p)}
              >
                <Check
                  className={cn("size-3.5", p.nbaId === current.nbaId ? "opacity-100" : "opacity-0")}
                />
                <span className="flex-1 truncate">
                  #{p.number} {p.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {(p as RosterPlayer).teamAbbr ? `${(p as RosterPlayer).teamAbbr} · ` : ""}
                  {p.pos}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
