import type { ReactNode } from "react";
import { ConnectionBanner } from "@/_shell";
import { connectionStore } from "@/connectionStore";

// Thin wrapper over the shared ConnectionBanner, bound to liveview's connection
// store. The visual + countdown live in @shared-utils/ui now; App.tsx renders
// <ReconnectBanner /> unchanged.
export function ReconnectBanner(): ReactNode {
  return <ConnectionBanner store={connectionStore} />;
}
