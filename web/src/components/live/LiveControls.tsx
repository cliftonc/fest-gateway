/**
 * The live screen's controls: how far back the window reaches, and whether it
 * is still moving.
 *
 * Deliberately small. This screen is an aggregate, and the filters the old
 * per-request feed carried (model id, credential origin) would answer questions
 * the rollups below already answer by ranking.
 */

import { Pause, Play } from "lucide-react";
import { Button } from "../ui/button.tsx";
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
  connected,
  paused,
  onPaused,
  perMinute,
}: {
  windowMs: number;
  onWindowMs: (ms: number) => void;
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
