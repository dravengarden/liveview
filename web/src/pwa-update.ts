/** Activate a completely installed shell, then reload only after a user tap. */
export async function applyReaderUpdate(): Promise<void> {
  if (
    "serviceWorker" in navigator &&
    ["http:", "https:"].includes(globalThis.location.protocol)
  ) {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.update();
      const installing = registration.installing;
      if (installing) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Update install timed out")),
            60_000,
          );
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" ||
              installing.state === "redundant"
            ) {
              clearTimeout(timer);
              if (installing.state === "redundant") {
                reject(new Error("Update install failed"));
              } else resolve();
            }
          });
        });
      }
      if (registration.waiting) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Update activation timed out"));
          }, 10_000);
          const cleanup = (): void =>
            navigator.serviceWorker.removeEventListener(
              "controllerchange",
              changed,
            );
          const changed = (): void => {
            clearTimeout(timer);
            cleanup();
            resolve();
          };
          navigator.serviceWorker.addEventListener("controllerchange", changed);
          registration.waiting?.postMessage({ type: "SKIP_WAITING" });
        });
      }
    }
  }
  // Content and audio belong to the replica. Updating UI must never clear them.
  globalThis.location.reload();
}
