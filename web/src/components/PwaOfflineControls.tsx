import { Button, Stack, Switch, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import {
  installedPwa,
  pwaAudioSupported,
  pwaDownloadsEnabled,
  setPwaDownloadsEnabled,
} from "@/pwa";
import { loadPolicy, persistPolicy } from "@/replica/mod.ts";

/** Browser storage is best-effort unless the UA grants persistent storage. */
export function PwaOfflineControls(): React.JSX.Element {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(pwaDownloadsEnabled());
  const [persistent, setPersistent] = useState(false);
  const [quota, setQuota] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    const refresh = (): void => setEnabled(pwaDownloadsEnabled());
    globalThis.addEventListener("lv-download-policy", refresh);
    return () => globalThis.removeEventListener("lv-download-policy", refresh);
  }, []);
  useEffect(() => {
    let disposed = false;
    void navigator.storage?.persisted?.().then((value) => {
      if (!disposed) setPersistent(value);
    }).catch(() => undefined);
    void navigator.storage?.estimate?.().then((value) => {
      if (!disposed) setQuota(value.quota ?? null);
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <Stack spacing={1.25}>
      {!pwaAudioSupported() && (
        <Typography variant="body2" color="text.secondary">
          {t("pwa.audioUnsupported")}
        </Typography>
      )}
      {!installedPwa() && (
        <Typography variant="body2" color="text.secondary">
          {t("pwa.installHint")}
        </Typography>
      )}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="body2">{t("pwa.downloads")}</Typography>
        <Switch
          checked={enabled}
          size="small"
          onChange={(event) => {
            const on = event.target.checked;
            setEnabled(on);
            setPwaDownloadsEnabled(on);
            void persistPolicy(loadPolicy());
          }}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {t("pwa.lifecycle")}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {persistent ? t("pwa.persistent") : t("pwa.storageHint")}
        {quota != null &&
          ` · ${t("pwa.quota", { gb: (quota / 1_073_741_824).toFixed(1) })}`}
      </Typography>
      {!persistent && typeof navigator.storage?.persist === "function" && (
        <Button
          size="small"
          disabled={pending}
          sx={{ alignSelf: "flex-start" }}
          onClick={() => {
            setPending(true);
            void navigator.storage.persist().then((granted) => {
              setPersistent(granted);
              setStatus(granted ? null : t("pwa.storageDeclined"));
            }).catch(() => setStatus(t("pwa.storageDeclined"))).finally(() =>
              setPending(false)
            );
          }}
        >
          {t("pwa.keepDownloads")}
        </Button>
      )}
      {status && (
        <Typography role="status" variant="caption" color="text.secondary">
          {status}
        </Typography>
      )}
    </Stack>
  );
}
