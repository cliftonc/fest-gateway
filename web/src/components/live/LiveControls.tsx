/**
 * The live screen's controls: how far back the window reaches, what it is
 * measured in, and whether it is still moving.
 *
 * Deliberately small. This screen is an aggregate, and the filters the old
 * per-request feed carried (model id, credential origin) would answer questions
 * the rollups below already answer by ranking. The measure earns its place
 * because it is not a filter — it changes the unit every magnitude on the page
 * is drawn in, and no ranking can answer "what is this costing".
 */

import { Pause, Play } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { ButtonGroup } from "../ui/button-group.tsx";
import { MEASURE_OPTIONS, type Measure } from "../../lib/measure.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";
import { ConnectionStatus } from "./ConnectionStatus.tsx";

export const WINDOW_OPTIONS = [
  { id: "60000", label: "Last 1 min" },
  { id: "300000", label: "Last 5 min" },
  { id: "900000", label: "Last 15 min" },
  { id: "3600000", label: "Last hour" },
] as const;

export function LiveControls({
  windowMs,
  onWindowMs,
  measure,
  onMeasure,
  connected,
  paused,
  onPaused,
  perMinute,
}: {
  windowMs: number;
  onWindowMs: (ms: number) => void;
  measure: Measure;
  onMeasure: (next: Measure) => void;
  connected: boolean;
  paused: boolean;
  onPaused: (next: boolean) => void;
  perMinute: number;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={String(windowMs)} onValueChange={(v) => onWindowMs(Number(v))}>
        <SelectTrigger size="sm" className="w-[150px]" aria-label="Rolling window length">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WINDOW_OPTIONS.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/*
        What the page is measured in. Sits with the window length because both
        answer "how do I read this screen"; Pause answers "is it still moving".

        `aria-pressed` rather than a radiogroup: a radiogroup obliges arrow-key
        roving focus, and three tabbable buttons read correctly without it. The
        active state is a fill AND the label, so the colour is never the only
        thing saying which one is on.
      */}
      <ButtonGroup aria-label="Measure">
        {MEASURE_OPTIONS.map((o) => (
          <Button
            key={o.id}
            type="button"
            size="sm"
            variant={o.id === measure ? "default" : "outline"}
            aria-pressed={o.id === measure}
            title={o.hint}
            onClick={() => onMeasure(o.id)}
          >
            {o.label}
          </Button>
        ))}
      </ButtonGroup>

      <Button
        type="button"
        size="sm"
        variant={paused ? "default" : "outline"}
        onClick={() => onPaused(!paused)}
      >
        {paused ? <Play /> : <Pause />}
        {paused ? "Resume" : "Pause"}
      </Button>

      <div className="ml-auto">
        <ConnectionStatus connected={connected} paused={paused} perMinute={perMinute} />
      </div>
    </div>
  );
}
