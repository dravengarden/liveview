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
        d="M212 330C340 352 447 420 494 522V860C418 787 321 744 212 724V330Z"
        fill={monochrome ? "currentColor" : "var(--lv-brand-navy, #19376d)"}
      />
      <path
        d="M530 522C577 420 684 352 812 330V724C703 744 606 787 530 860V522Z"
        fill={monochrome ? "currentColor" : "var(--lv-brand-plum, #754b86)"}
      />
      <path
        d="M512 110C523 225 556 292 668 330C556 368 523 405 512 470C501 405 468 368 356 330C468 292 501 225 512 110Z"
        fill={monochrome ? "currentColor" : "var(--lv-activity, #f0a51f)"}
      />
    </svg>
  );
}
