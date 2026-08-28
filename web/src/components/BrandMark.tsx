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
        d="M144 354c136 0 252 45 344 134v326c-90-84-205-128-344-128V354Z"
        fill={monochrome ? "currentColor" : "var(--lv-brand-navy, #19376d)"}
      />
      <path
        d="M536 488c92-89 208-134 344-134v332c-139 0-254 44-344 128V488Z"
        fill={monochrome ? "currentColor" : "var(--lv-brand-plum, #754b86)"}
      />
      <path
        d="M512 126c14 65 51 102 116 116-65 14-102 51-116 116-14-65-51-102-116-116 65-14 102-51 116-116Z"
        fill={monochrome ? "currentColor" : "var(--lv-activity, #f0a51f)"}
      />
    </svg>
  );
}
