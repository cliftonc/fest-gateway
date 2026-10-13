/**
 * The global tag filter: one select per tag key seen in the range, each
 * defaulting to "All". Lives in the page header next to the range, and like
 * the range it reads and writes the URL (`tag=key:value`), so a refresh or a
 * shared link reopens the same filtered view.
 *
 * The options come from `/api/tags`, which ignores the active tag filter — the
 * reader has to be able to switch `project=fest` to `project=web` without
 * clearing it first.
 */

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type Range } from "../lib/api.ts";
import { setUrlParams } from "../lib/router.ts";
import { withParam } from "../lib/url-state.ts";
import { formatTagFilter, type TagFilter } from "../../../shared/tags.ts";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

/** Radix refuses `""` as an item value, so "All" needs a sentinel. */
const ALL = "__all__";

/** More than this and the header becomes a form; the rest are still filterable by link. */
const MAX_KEYS = 4;

export function setTagFilter(next: TagFilter): void {
  setUrlParams((p) => withParam(p, "tag", formatTagFilter(next)));
}

/** Add or replace one key in the global filter — e.g. from a table row. */
export function addTagFilter(current: TagFilter, key: string, value: string): void {
  setTagFilter({ ...current, [key]: value });
}

export function TagFilterBar({ range }: { range: Range }): React.JSX.Element | null {
  const active = range.tags ?? {};
  const options = useQuery({
    // Keyed WITHOUT the tags: the options do not depend on them.
    queryKey: ["tags", "options", range.fromMs, range.toMs],
    queryFn: () => api.tags({ fromMs: range.fromMs, toMs: range.toMs }),
    staleTime: 60_000,
  });

  const keys = (options.data?.keys ?? []).slice(0, MAX_KEYS);
  // A filtered key with no traffic in range still gets a control, so the
  // filter that is emptying the page can be seen and cleared.
  for (const key of Object.keys(active)) {
    if (!keys.some((k) => k.key === key)) keys.push({ key, values: [] });
  }
  if (keys.length === 0) return null;

  return (
    <>
      {keys.map(({ key, values }) => {
        const current = active[key];
        const listed = values.map((v) => v.value);
        if (current !== undefined && !listed.includes(current)) listed.unshift(current);
        return (
          <span key={key} className="flex items-center gap-1.5">
            <label htmlFor={`tag-${key}`} className="ml-1 text-xs text-muted-foreground">
              {key}
            </label>
            <Select
              value={current ?? ALL}
              onValueChange={(v) => {
                const next = { ...active };
                if (v === ALL) delete next[key];
                else next[key] = v;
                setTagFilter(next);
              }}
            >
              <SelectTrigger id={`tag-${key}`} size="sm" className="max-w-[180px] min-w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All</SelectItem>
                {listed.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        );
      })}
      {Object.keys(active).length > 0 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setTagFilter({})}>
          <X />
          Clear tags
        </Button>
      )}
    </>
  );
}
