import type React from "react";

interface BrandMarkProps extends React.SVGProps<SVGSVGElement> {
  /** Use one colour where the full Knowledge Sprout palette is unavailable. */
  monochrome?: boolean;
}

/** The canonical LiveView Knowledge Sprout mark. */
export function BrandMark({
  monochrome = false,
  ...props
}: BrandMarkProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" {...props}>
      <path
        d="M512 816V450"
        stroke="currentColor"
        strokeWidth="74"
        strokeLinecap="round"
      />
      <path
        d="M512 560c-178-18-258-122-234-310 176 18 258 122 234 310z"
        fill="currentColor"
      />
      <path
        d="M512 650c178-18 258-122 234-310-176 18-258 122-234 310z"
        fill={monochrome ? "currentColor" : "var(--lv-accent, #7d61ff)"}
      />
      <circle
        cx="512"
        cy="450"
        r="54"
        fill={monochrome ? "currentColor" : "var(--lv-activity, #ffb51b)"}
      />
    </svg>
  );
}
