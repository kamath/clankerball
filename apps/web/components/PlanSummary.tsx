"use client";
/* A compact card describing a compiled TeamPlan in plain language. */
import { describePlan, type TeamPlan } from "@repo/shared";
import { cn } from "@/lib/utils";

interface PlanSummaryProps {
  title: string;
  plan: TeamPlan;
  /** display names by roster slot */
  names: string[];
  className?: string;
}

export function PlanSummary({ title, plan, names, className }: PlanSummaryProps) {
  const lines = describePlan(plan, names);
  return (
    <div className={cn("rounded-md border px-3 py-2", className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="mt-0.5 text-sm font-medium">{plan.summary}</div>
      {lines.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {lines.map((l, i) => (
            <li key={i}>• {l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
