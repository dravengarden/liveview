import type React from "react";

interface BrandMarkProps extends React.SVGProps<SVGSVGElement> {
  /** Use one colour where the full Living Book palette is unavailable. */
  monochrome?: boolean;
}

/** The canonical LiveView Living Book mark. */
export function BrandMark({
  monochrome = false,
  ...props
}: BrandMarkProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" {...props}>
      <path
        d="M140 365C300 392 430 452 484 522V748C390 687 274 648 140 632V365Z"
        fill={monochrome ? "currentColor" : "var(--lv-brand-navy, #19376d)"}
      />
      <path
        d="M540 522C594 452 724 392 884 365V632C750 648 634 687 540 748V522Z"
        fill={monochrome ? "currentColor" : "var(--lv-brand-plum, #754b86)"}
      />
      <path
        d="M512 190C525 285 565 320 690 335C565 350 525 385 512 475C499 385 459 350 334 335C459 320 499 285 512 190Z"
        fill={monochrome ? "currentColor" : "var(--lv-activity, #f0a51f)"}
      />
    </svg>
  );
}
