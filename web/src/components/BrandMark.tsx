import type React from "react";
import { useId } from "react";

interface BrandMarkProps extends React.SVGProps<SVGSVGElement> {
  /** Use one colour where the full Living Book palette is unavailable. */
  monochrome?: boolean;
}

/** The canonical LiveView Living Book mark. */
export function BrandMark({
  monochrome = false,
  ...props
}: BrandMarkProps): React.JSX.Element {
  const nightGradientId = useId();

  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" {...props}>
      {!monochrome && (
        <>
          <defs>
            <linearGradient id={nightGradientId} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#081831" />
              <stop offset="0.58" stopColor="#111a3d" />
              <stop offset="1" stopColor="#241542" />
            </linearGradient>
          </defs>
          <rect
            width="1024"
            height="1024"
            rx="224"
            fill={`url(#${nightGradientId})`}
          />
        </>
      )}
      <path
        d="M174 462V780C300 792 405 830 488 894"
        fill="none"
        stroke={monochrome
          ? "currentColor"
          : "var(--lv-brand-page-light, #fff7e9)"}
        strokeWidth="28"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <path
        d="M850 462V780C724 792 619 830 536 894"
        fill="none"
        stroke={monochrome
          ? "currentColor"
          : "var(--lv-brand-page-edge, #936dce)"}
        strokeWidth="28"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <path
        d="M218 414C342 421 442 472 498 554V850C418 782 324 744 218 728V414Z"
        fill={monochrome
          ? "currentColor"
          : "var(--lv-brand-page-light, #fff7e9)"}
      />
      <path
        d="M526 554C582 472 682 421 806 414V728C700 744 606 782 526 850V554Z"
        fill={monochrome
          ? "currentColor"
          : "var(--lv-brand-page-plum, #ae8dde)"}
      />
      <path
        d="M512 148C523 228 557 267 637 284C557 301 523 340 512 420C501 340 467 301 387 284C467 267 501 228 512 148Z"
        fill={monochrome ? "currentColor" : "var(--lv-activity, #f5bd48)"}
      />
      <path
        d="M326 244C331 282 347 300 385 308C347 316 331 334 326 372C321 334 305 316 267 308C305 300 321 282 326 244Z"
        fill={monochrome
          ? "currentColor"
          : "var(--lv-brand-page-light, #fffaf0)"}
      />
      <path
        d="M698 244C703 282 719 300 757 308C719 316 703 334 698 372C693 334 677 316 639 308C677 300 693 282 698 244Z"
        fill={monochrome
          ? "currentColor"
          : "var(--lv-brand-glint-plum, #8f63c6)"}
      />
    </svg>
  );
}
