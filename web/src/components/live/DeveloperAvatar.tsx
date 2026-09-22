/**
 * Who made the request, as a glanceable mark.
 *
 * Unattributed usage gets its own loud variant rather than a neutral fallback
 * avatar. A null `userId` means somebody is pointing Claude Code at the gateway
 * with no identity token, so their usage lands in nobody's column — that is a
 * thing an admin has to notice, not a missing-avatar placeholder to style
 * around.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

/**
 * A stable hue per identity. Hashing the id rather than assigning colours by
 * position keeps a developer the same colour as rows stream past and reorder.
 */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initials(label: string): string {
  const cleaned = label.replace(/@.*$/, "");
  const parts = cleaned.split(/[.\-_\s]+/).filter((p) => p.length > 0);
  const first = parts[0]?.[0] ?? label[0] ?? "?";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function DeveloperAvatar({
  userId,
  label,
}: {
  userId: string | null;
  label: string;
}): React.JSX.Element {
  if (userId === null || userId === "") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-status-warn text-[10px] font-semibold text-status-warn"
            aria-label="unattributed"
          >
            ?
          </span>
        </TooltipTrigger>
        <TooltipContent>
          No Fest identity token was presented, so this usage lands in nobody's column.
        </TooltipContent>
      </Tooltip>
    );
  }

  const h = hue(userId);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
          style={{
            // Generated rather than tokenised: the palette has to be open-ended
            // because the set of developers is.
            background: `oklch(0.7 0.12 ${h} / 0.22)`,
            color: `oklch(0.72 0.14 ${h})`,
          }}
          aria-label={label}
        >
          {initials(label)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
