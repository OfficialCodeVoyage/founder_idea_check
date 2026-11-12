/**
 * The Founder Idea Check mark: a gate (an arch) with a check inside it, because every phase of
 * the conversation ends at a gate that only opens on evidence. Drawn on a 64-unit grid in the
 * app's blue (`--chart-2`, Tailwind blue-600), which keeps white strokes above 5:1.
 *
 * `app/icon.svg` holds the same drawing as a static file for browsers; the generated images
 * (`app/apple-icon.tsx`, `app/opengraph-image.tsx`) render this component through `next/og`,
 * so the paths live here once. Change both together.
 */
export const BRAND_BLUE = "#2563eb";

export function BrandMark({
  size,
  square = false,
}: {
  size: number;
  /** Full-bleed square for platforms that apply their own corner mask (iOS home screen). */
  square?: boolean;
}) {
  return (
    <svg
      aria-label="Founder Idea Check"
      height={size}
      role="img"
      viewBox="0 0 64 64"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill={BRAND_BLUE} height="64" rx={square ? 0 : 15} width="64" />
      <path
        d="M16 51V30a16 16 0 0 1 32 0v21"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <path
        d="M24.5 38.5 30 44l9.5-11.5"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="5.5"
      />
    </svg>
  );
}
