import type { ReactNode } from "react";
import { ConnectionBanner } from "@/_shell";
import { connectionStore } from "@/connectionStore";
import { useI18n } from "@/i18n";

// Thin wrapper over the shared ConnectionBanner, bound to liveview's connection
// store. The visual + countdown live in @shared-utils/ui now; App.tsx renders
// <ReconnectBanner /> unchanged.
export function ReconnectBanner(): ReactNode {
  const { t } = useI18n();
  return <ConnectionBanner store={connectionStore} updateLabel={t("pwa.update")} updateFailedLabel={t("pwa.updateFailed")} />;
}
