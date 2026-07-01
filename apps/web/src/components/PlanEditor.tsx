"use client";
/* ============================================================
   PlanEditor — build a TeamPlan entirely by hand, no AI. Every
   field the compiler would emit (initiator, scoring options,
   actions, per-player tendency biases, defense, pace, inbound)
   gets a direct form control. The draft is kept loose while you
   edit and run through sanitizePlan() on apply, so half-finished
   rows never reach the engine.
   ============================================================ */
import { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  sanitizePlan,
  type PlanAction,
  type PlanActionType,
  type PlayerDirective,
  type TeamPlan,
  type Tendencies,
} from "@repo/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { PlanSummary } from "@/components/PlanSummary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const BLANK: TeamPlan = {
  summary: "",
  handlerSlot: null,
  scorerSlots: [],
  actions: [],
  directives: [],
  defScheme: null,
  pace: null,
  inbound: null,
  inbounderSlot: null,
};

const NONE = "none";
const ACTION_TYPES: { value: PlanActionType; label: string }[] = [
  { value: "pickAndRoll", label: "Pick & roll" },
  { value: "getOpen", label: "Get open" },
  { value: "iso", label: "Iso" },
  { value: "postUp", label: "Post up" },
];
const TEND_KEYS: (keyof Tendencies)[] = [
  "shoot", "three", "drive", "pass", "kickout", "help", "crash", "gamble",
];

/** A slot picker with a "None" option; value/onChange speak slot-or-null. */
function SlotSelect({
  value,
  onChange,
  names,
  placeholder = "None",
  allowNone = true,
}: {
  value: number | null;
  onChange: (slot: number | null) => void;
  names: string[];
  placeholder?: string;
  allowNone?: boolean;
}) {
  return (
    <Select
      value={value === null ? NONE : String(value)}
      onValueChange={(v) => onChange(v === NONE ? null : Number(v))}
    >
      <SelectTrigger className="h-8">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{placeholder}</SelectItem>}
        {names.map((n, i) => (
          <SelectItem key={i} value={String(i)}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface PlanEditorProps {
  names: string[];
  /** lab contexts expose the inbound controls; game hides them */
  context: "game" | "lab-offense" | "lab-defense";
  /** seed value — the plan the editor opens on */
  initialPlan: TeamPlan | null;
  onApply: (plan: TeamPlan | null) => void;
  className?: string;
}

export function PlanEditor({ names, context, initialPlan, onApply, className }: PlanEditorProps) {
  const [draft, setDraft] = useState<TeamPlan>(initialPlan ?? BLANK);
  const isLab = context !== "game";

  const patch = (p: Partial<TeamPlan>) => setDraft((d) => ({ ...d, ...p }));
  const preview = useMemo(() => sanitizePlan(draft), [draft]);

  const toggleScorer = (slot: number) =>
    setDraft((d) => {
      const has = d.scorerSlots.includes(slot);
      if (has) return { ...d, scorerSlots: d.scorerSlots.filter((s) => s !== slot) };
      if (d.scorerSlots.length >= 3) return d;
      return { ...d, scorerSlots: [...d.scorerSlots, slot] };
    });

  const setAction = (i: number, a: Partial<PlanAction>) =>
    setDraft((d) => ({
      ...d,
      actions: d.actions.map((x, j) => (j === i ? { ...x, ...a } : x)),
    }));
  const addAction = () =>
    setDraft((d) =>
      d.actions.length >= 3
        ? d
        : {
            ...d,
            actions: [
              ...d.actions,
              { type: "pickAndRoll", handlerSlot: null, screenerSlot: null, targetSlot: null, finish: null },
            ],
          }
    );
  const removeAction = (i: number) =>
    setDraft((d) => ({ ...d, actions: d.actions.filter((_, j) => j !== i) }));

  const setDirective = (i: number, dir: Partial<PlayerDirective>) =>
    setDraft((d) => ({
      ...d,
      directives: d.directives.map((x, j) => (j === i ? { ...x, ...dir } : x)),
    }));
  const setBias = (i: number, key: keyof Tendencies, v: number) =>
    setDraft((d) => ({
      ...d,
      directives: d.directives.map((x, j) => {
        if (j !== i) return x;
        const bias = { ...(x.tendencyBias ?? {}) };
        if (v === 0) delete bias[key];
        else bias[key] = v;
        return { ...x, tendencyBias: Object.keys(bias).length ? bias : null };
      }),
    }));
  const addDirective = () =>
    setDraft((d) =>
      d.directives.length >= 5
        ? d
        : { ...d, directives: [...d.directives, { slot: 0, note: null, tendencyBias: null }] }
    );
  const removeDirective = (i: number) =>
    setDraft((d) => ({ ...d, directives: d.directives.filter((_, j) => j !== i) }));

  return (
    <div className={className}>
      <div className="flex flex-col gap-4">
        {/* Summary */}
        <Field label="Summary (optional)">
          <Input
            value={draft.summary}
            onChange={(e) => patch({ summary: e.target.value })}
            placeholder="Custom game plan"
            className="h-8"
          />
        </Field>

        {/* Initiator */}
        <Field label="Initiator (brings it up)">
          <SlotSelect
            value={draft.handlerSlot}
            onChange={(handlerSlot) => patch({ handlerSlot })}
            names={names}
            placeholder="Best ball-handler"
          />
        </Field>

        {/* Scoring options */}
        <Field label={`Scoring options (priority order, max 3)`}>
          <div className="flex flex-wrap gap-1.5">
            {names.map((n, i) => {
              const rank = draft.scorerSlots.indexOf(i);
              const active = rank >= 0;
              return (
                <Button
                  key={i}
                  type="button"
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  className="h-7"
                  onClick={() => toggleScorer(i)}
                  disabled={!active && draft.scorerSlots.length >= 3}
                >
                  {active && <span className="mr-1 text-xs font-bold text-primary">{rank + 1}</span>}
                  {n}
                </Button>
              );
            })}
          </div>
        </Field>

        {/* Actions */}
        <Field
          label="Actions"
          action={
            <Button size="sm" variant="ghost" className="h-7" onClick={addAction} disabled={draft.actions.length >= 3}>
              <Plus className="mr-1 size-3.5" /> Add
            </Button>
          }
        >
          {draft.actions.length === 0 && (
            <p className="text-xs text-muted-foreground">No actions — players run their normal game.</p>
          )}
          <div className="flex flex-col gap-2">
            {draft.actions.map((a, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <Select value={a.type} onValueChange={(v) => setAction(i, { type: v as PlanActionType })}>
                    <SelectTrigger className="h-8 flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => removeAction(i)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {a.type === "pickAndRoll" && (
                    <>
                      <LabeledSlot label="Handler" value={a.handlerSlot} onChange={(handlerSlot) => setAction(i, { handlerSlot })} names={names} />
                      <LabeledSlot label="Screener" value={a.screenerSlot} onChange={(screenerSlot) => setAction(i, { screenerSlot })} names={names} />
                      <div className="col-span-2 flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Finish</span>
                        <Select
                          value={a.finish ?? NONE}
                          onValueChange={(v) => setAction(i, { finish: v === NONE ? null : (v as "roll" | "pop") })}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue placeholder="Screener's call" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Screener's call</SelectItem>
                            <SelectItem value="roll">Roll to rim</SelectItem>
                            <SelectItem value="pop">Pop to arc</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}
                  {a.type === "getOpen" && (
                    <>
                      <LabeledSlot label="Get open" value={a.targetSlot} onChange={(targetSlot) => setAction(i, { targetSlot })} names={names} />
                      <LabeledSlot label="Screener" value={a.screenerSlot} onChange={(screenerSlot) => setAction(i, { screenerSlot })} names={names} />
                    </>
                  )}
                  {(a.type === "iso" || a.type === "postUp") && (
                    <LabeledSlot label="For" value={a.targetSlot} onChange={(targetSlot) => setAction(i, { targetSlot })} names={names} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </Field>

        {/* Directives */}
        <Field
          label="Player emphasis"
          action={
            <Button size="sm" variant="ghost" className="h-7" onClick={addDirective} disabled={draft.directives.length >= 5}>
              <Plus className="mr-1 size-3.5" /> Add
            </Button>
          }
        >
          {draft.directives.length === 0 && (
            <p className="text-xs text-muted-foreground">No per-player tweaks.</p>
          )}
          <div className="flex flex-col gap-2">
            {draft.directives.map((d, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <SlotSelect value={d.slot} onChange={(s) => setDirective(i, { slot: s ?? 0 })} names={names} allowNone={false} />
                  </div>
                  <Input
                    value={d.note ?? ""}
                    onChange={(e) => setDirective(i, { note: e.target.value || null })}
                    placeholder="Label (e.g. HUNT 3s)"
                    maxLength={12}
                    className="h-8 flex-1"
                  />
                  <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => removeDirective(i)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {TEND_KEYS.map((k) => {
                    const v = d.tendencyBias?.[k] ?? 0;
                    return (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-xs capitalize text-muted-foreground">{k}</span>
                        <Slider
                          value={[v]}
                          min={-40}
                          max={40}
                          step={1}
                          onValueChange={([nv]) => setBias(i, k, nv)}
                          className="flex-1"
                        />
                        <span className={`w-8 shrink-0 text-right text-xs tabular-nums ${v === 0 ? "text-muted-foreground" : "font-medium"}`}>
                          {v > 0 ? `+${v}` : v}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Field>

        {/* Defense + pace */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Defense">
            <Select
              value={draft.defScheme ?? NONE}
              onValueChange={(v) => patch({ defScheme: v === NONE ? null : (v as TeamPlan["defScheme"]) })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Default (man)</SelectItem>
                <SelectItem value="man">Man-to-man</SelectItem>
                <SelectItem value="switch">Switch everything</SelectItem>
                <SelectItem value="zone">2-3 zone</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pace">
            <Select
              value={draft.pace ?? NONE}
              onValueChange={(v) => patch({ pace: v === NONE ? null : (v as TeamPlan["pace"]) })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Default</SelectItem>
                <SelectItem value="fast">Fast</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="slow">Slow</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        {/* Inbound (lab only) */}
        {isLab && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Inbound from">
              <Select
                value={draft.inbound ?? NONE}
                onValueChange={(v) => patch({ inbound: v === NONE ? null : (v as TeamPlan["inbound"]) })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Default</SelectItem>
                  <SelectItem value="full">Full court</SelectItem>
                  <SelectItem value="side-top">Sideline (top)</SelectItem>
                  <SelectItem value="side-bot">Sideline (bottom)</SelectItem>
                  <SelectItem value="base-top">Baseline (top)</SelectItem>
                  <SelectItem value="base-bot">Baseline (bottom)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Inbounder">
              <SlotSelect value={draft.inbounderSlot} onChange={(inbounderSlot) => patch({ inbounderSlot })} names={names} placeholder="Any" />
            </Field>
          </div>
        )}

        {/* Live preview */}
        <PlanSummary title="Preview" plan={preview} names={names} />

        {/* Apply / clear */}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => onApply(sanitizePlan(draft))}>
            Apply plan
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(BLANK);
              onApply(null);
            }}
          >
            <X className="mr-1.5 size-3.5" /> Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}

function LabeledSlot({
  label,
  value,
  onChange,
  names,
}: {
  label: string;
  value: number | null;
  onChange: (slot: number | null) => void;
  names: string[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SlotSelect value={value} onChange={onChange} names={names} />
    </div>
  );
}
