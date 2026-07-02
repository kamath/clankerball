"use client";
import { useState } from "react";
import { Loader2, Swords } from "lucide-react";
import { useBuildMatchup } from "@/lib/queries";
import type { TeamOption } from "@repo/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GameConfig } from "@repo/shared";

interface TeamPickerProps {
  teams: TeamOption[];
  onLoad: (config: GameConfig) => void;
}

function TeamSelect({
  label,
  teams,
  value,
  onChange,
}: {
  label: string;
  teams: TeamOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select a team" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {teams.map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>
                {t.fullName}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

export function TeamPicker({ teams, onLoad }: TeamPickerProps) {
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const matchup = useBuildMatchup();
  const pending = matchup.isPending;

  const load = async () => {
    setError(null);
    try {
      const config = await matchup.mutateAsync({ teamAId: Number(a), teamBId: Number(b) });
      onLoad(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build matchup");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Real NBA matchup</CardTitle>
        <CardDescription>
          Ratings are derived from 2024-25 season stats — including hustle and
          defensive-impact metrics, so lockdown defenders grade like lockdown defenders.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TeamSelect label="Home" teams={teams} value={a} onChange={setA} />
        <TeamSelect label="Away" teams={teams} value={b} onChange={setB} />
        <Button onClick={load} disabled={!a || !b || a === b || pending} className="gap-2">
          {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Swords data-icon="inline-start" />}
          {pending ? "Building rosters…" : "Load matchup"}
        </Button>
        {a && b && a === b && (
          <p className="text-sm text-muted-foreground">Pick two different teams.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
