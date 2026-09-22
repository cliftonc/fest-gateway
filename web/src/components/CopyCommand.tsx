/**
 * A shell command, shown as something to run and to take away.
 *
 * The whole row is the copy target, not just the icon: these commands are long
 * enough that selecting one by hand in a terminal-width column is fiddly, and a
 * half-selected command pasted into a shell is worse than none.
 *
 * `navigator.clipboard` is unavailable on insecure origins, which is exactly
 * where a gateway trial starts (`http://fest.corp:8787`), so there is a
 * `execCommand` fallback and, failing both, the command stays selectable text.
 */

import { useCallback, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path rather than reporting failure early */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: a `display: none` textarea cannot be
    // selected, which is what execCommand needs.
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}): React.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(() => {
    void writeClipboard(command).then((ok) => {
      setState(ok ? "copied" : "failed");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1600);
    });
  }, [command]);

  return (
    <button
      type="button"
      onClick={copy}
      // The accessible name carries the command, because "Copy" alone in a list
      // of three commands tells a screen reader nothing about which one.
      aria-label={`Copy: ${command}`}
      title="Copy to clipboard"
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-left",
        "ring-1 ring-foreground/10 transition-colors hover:bg-muted hover:ring-foreground/20",
        "focus-visible:ring-2 focus-visible:ring-status-sub focus-visible:outline-none",
        className,
      )}
    >
      <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-foreground">
        <span className="mr-2 text-muted-foreground select-none">$</span>
        {command}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-[11px] transition-colors",
          state === "copied" ? "text-status-ok" : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {state === "copied" ? (
          <>
            <Check className="size-3.5" /> Copied
          </>
        ) : state === "failed" ? (
          <>Select and copy</>
        ) : (
          <>
            <Copy className="size-3.5" /> Copy
          </>
        )}
      </span>
    </button>
  );
}
