import { useEffect, useState } from "react";
import { Box, Button, Collapse, Typography } from "@mui/material";
import { BUNDLED, REMOTE } from "@/apiBase";
import { useI18n } from "@/i18n";

interface Status { paused: boolean; total: number; ready: number; running: number; waiting: number; failed: number }
const base = (): string => BUNDLED ? REMOTE : "";

/** Constant-size server summary; no chapter enumeration in the reader. */
export function AudioPreparation(): React.JSX.Element | null {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let epoch = 0;
    const refresh = async (): Promise<void> => {
      if (disposed || document.hidden) return;
      const requestEpoch = ++epoch;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch(`${base()}/api/speech-preparation`, { signal: controller.signal });
        if (response.ok) {
          const next = await response.json() as Status;
          if (!disposed && requestEpoch === epoch) setStatus(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
        }
      } catch { /* Keep the last summary during a connection interruption. */ }
      finally { clearTimeout(timeout); if (!disposed && requestEpoch === epoch && !document.hidden) timer = setTimeout(() => void refresh(), 10000); }
    };
    const visibility = (): void => { ++epoch; clearTimeout(timer); controller?.abort(); if (!document.hidden) timer = setTimeout(() => void refresh(), 500); };
    timer = setTimeout(() => void refresh(), 1000);
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  async function pause(): Promise<void> {
    if (!status || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base()}/api/speech-preparation`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: !status.paused }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(await response.text());
      setStatus(await response.json() as Status);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  if (!status || status.total === 0) return null;
  return <Box sx={{ mb: 2 }} data-testid="audio-preparation">
    <Button size="small" onClick={() => setOpen(value => !value)} aria-expanded={open}>{t("speech.preparationSummary", { ready: status.ready, total: status.total })}{status.paused ? ` · ${t("speech.preparationPaused")}` : status.running > 0 ? ` · ${t("speech.preparationRunning", { n: status.running })}` : ""}</Button>
    <Collapse in={open}><Box sx={{ px: 1, pb: 1 }}>
      <Typography variant="body2" color="text.secondary">{t("speech.preparationDetail", { waiting: status.waiting, failed: status.failed })}</Typography>
      <Typography variant="caption" color="text.secondary">{t("speech.preparationHint")}</Typography>
      <Box><Button disabled={busy} onClick={() => void pause()}>{t(status.paused ? "speech.resumePreparation" : "speech.pausePreparation")}</Button></Box>
      {error && <Typography role="alert" color="error">{error}</Typography>}
    </Box></Collapse>
  </Box>;
}
