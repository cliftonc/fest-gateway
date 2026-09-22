/**
 * The Nearform monogram, inline rather than an <img>.
 *
 * Inline because the mark has to work on both themes: the "N" takes
 * `currentColor` so it inherits whatever it is sitting on, and only the
 * underscore keeps the brand green. Two pre-baked SVG files would mean either
 * a network request per theme flip or a wrong-coloured logo for one frame.
 *
 * Decorative by default — the product name is always rendered next to it as
 * real text, so a screen reader announcing "Nearform" here would be repeating
 * attribution nobody navigated for.
 */
export function NearformMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="60.17 60.17 111.65 86.48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="m60.18,60.18h11.3l36.71,53.4v-53.4h12.17v75.36h-11.3l-36.71-53.4v53.4h-12.17V60.18Z"
      />
      <path fill="var(--primary)" d="m126.51,135.54h45.29v11.09h-45.29v-11.09Z" />
    </svg>
  );
}
