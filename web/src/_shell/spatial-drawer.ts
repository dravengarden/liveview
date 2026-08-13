import { predictSpatialDrawerOffset, spatialDrawerVisual } from "./spatial-drawer-motion.ts";

export type SpatialDrawerSettle = (open: boolean, releaseVelocity?: number) => void;

function hasExpandedSelection(): boolean {
  const selection = globalThis.getSelection?.();
  return Boolean(selection && !selection.isCollapsed);
}

function hasHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== root) {
    const style = getComputedStyle(element);
    if (
      element.scrollWidth > element.clientWidth + 1 &&
      (style.overflowX === "auto" || style.overflowX === "scroll")
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

export function bindSpatialDrawer({
  gestureTarget,
  surface,
  drawer,
  drawerMask,
  phone,
  getOpen,
  setOpen,
  onPrepareThreshold,
  onThreshold,
}: {
  readonly gestureTarget: HTMLElement;
  readonly surface: HTMLElement;
  readonly drawer: HTMLElement;
  readonly drawerMask: HTMLElement;
  readonly phone: boolean;
  readonly getOpen: () => boolean;
  readonly setOpen: (open: boolean) => void;
  readonly onPrepareThreshold?: () => void;
  readonly onThreshold?: () => void;
}): { readonly settle: SpatialDrawerSettle; readonly dispose: () => void } {
  let gesture: {
    x: number;
    y: number;
    lastX: number;
    lastAt: number;
    velocity: number;
    locked: boolean;
    startOffset: number;
    startOpen: boolean;
    width: number;
    thresholdFired: boolean;
  } | null = null;
  let settleTimer: ReturnType<typeof globalThis.setTimeout> | undefined = undefined;
  let renderFrame = 0;
  let pendingOffset = 0;
  let pendingAt = 0;
  let pendingVelocity = 0;
  let currentOffset = 0;
  let presentationWidth = 1;
  let commit = false;
  let pendingThresholdHaptic = false;
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const drawerWidth = (): number => {
    const width = surface.clientWidth;
    return phone ? Math.min(360, width * 0.84) : Math.min(440, width * 0.52);
  };
  const applyDepth = (): void => {
    surface.style.borderRadius = `${String(phone ? 36 : 30)}px`;
    surface.style.boxShadow = [
      "-18px 0 42px rgba(0,0,0,0.24)",
      "inset 0 0 0 1px color-mix(in srgb, currentColor 10%, transparent)",
    ].join(", ");
  };
  const clearDepth = (): void => {
    surface.style.removeProperty("border-radius");
    surface.style.removeProperty("box-shadow");
  };
  const render = (offset: number): void => {
    currentOffset = offset;
    const visual = spatialDrawerVisual(offset, presentationWidth, { phone, reducedMotion });
    const parallax = presentationWidth * (phone ? 0.28 : 0.22) * (1 - visual.progress);
    surface.style.transform = `translate3d(${String(offset)}px,0,0) scale(${String(visual.scale)})`;
    surface.style.opacity = String(visual.opacity);
    drawer.style.transform = `translate3d(-${String(parallax)}px,0,0)`;
    drawer.style.opacity = String(0.72 + visual.progress * 0.28);
    drawerMask.style.transform = `translate3d(${String(offset)}px,0,0)`;
  };
  const scheduleRender = (offset: number, at: number, velocity: number): void => {
    pendingOffset = offset;
    pendingAt = at;
    pendingVelocity = velocity;
    if (renderFrame !== 0) {
      return;
    }
    renderFrame = requestAnimationFrame((frameAt) => {
      renderFrame = 0;
      render(predictSpatialDrawerOffset(pendingOffset, pendingVelocity, frameAt - pendingAt));
      if (pendingThresholdHaptic) {
        pendingThresholdHaptic = false;
        onThreshold?.();
      }
    });
  };
  const clearTransitions = (): void => {
    for (const element of [surface, drawer, drawerMask]) {
      element.style.removeProperty("transition");
      element.style.removeProperty("will-change");
    }
  };
  const settle: SpatialDrawerSettle = (open, releaseVelocity = 0): void => {
    globalThis.clearTimeout(settleTimer);
    const releaseOffset = renderFrame === 0 ? currentOffset : pendingOffset;
    if (renderFrame !== 0) {
      cancelAnimationFrame(renderFrame);
    }
    renderFrame = 0;
    const width = drawerWidth();
    presentationWidth = width;
    const target = open ? width : 0;
    const remaining = Math.min(1, Math.abs(target - releaseOffset) / width);
    const duration = Math.max(150, Math.min(260, 160 + remaining * 100 - Math.min(70, Math.abs(releaseVelocity) * 45)));
    applyDepth();
    surface.style.willChange = "transform,opacity";
    drawer.style.willChange = "transform,opacity";
    drawerMask.style.willChange = "transform";
    surface.style.transition = `transform ${String(duration)}ms cubic-bezier(0.22,1,0.36,1),opacity ${
      String(duration)
    }ms cubic-bezier(0.22,1,0.36,1)`;
    drawer.style.transition = `transform ${String(duration)}ms cubic-bezier(0.22,1,0.36,1),opacity ${
      String(duration)
    }ms cubic-bezier(0.22,1,0.36,1)`;
    drawerMask.style.transition = `transform ${String(duration)}ms cubic-bezier(0.22,1,0.36,1)`;
    render(target);
    if (pendingThresholdHaptic) {
      pendingThresholdHaptic = false;
      requestAnimationFrame(() => onThreshold?.());
    }
    if (open) {
      setOpen(true);
    }
    settleTimer = globalThis.setTimeout(() => {
      clearTransitions();
      if (!open) {
        setOpen(false);
        clearDepth();
      }
      delete gestureTarget.dataset["spatialDrawerMoving"];
    }, duration + 20);
  };

  const onTouchStart = (event: TouchEvent): void => {
    const [touch] = event.touches;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      !touch || hasExpandedSelection() ||
      target?.closest("input,textarea,[contenteditable='true'],[data-spatial-drawer-ignore]") ||
      hasHorizontalScroller(event.target, gestureTarget)
    ) {
      gesture = null;
      return;
    }
    const now = performance.now();
    const startOpen = getOpen();
    const width = drawerWidth();
    presentationWidth = width;
    onPrepareThreshold?.();
    gesture = {
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastAt: now,
      velocity: 0,
      locked: false,
      startOffset: startOpen ? width : 0,
      startOpen,
      width,
      thresholdFired: false,
    };
    commit = startOpen;
  };
  const onTouchMove = (event: TouchEvent): void => {
    const [touch] = event.touches;
    if (!gesture || !touch || hasExpandedSelection()) {
      return;
    }
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.locked && Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx) * 1.15) {
      gesture = null;
      return;
    }
    if (!gesture.locked && (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.15)) {
      return;
    }
    if ((!gesture.startOpen && dx < 0) || (gesture.startOpen && dx > 0)) {
      return;
    }
    if (!gesture.locked) {
      applyDepth();
      gestureTarget.dataset["spatialDrawerMoving"] = "true";
      for (const element of [surface, drawer, drawerMask]) {
        element.style.transition = "none";
        element.style.willChange = element === drawerMask ? "transform" : "transform,opacity";
      }
    }
    gesture.locked = true;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    const elapsed = Math.max(1, now - gesture.lastAt);
    const instantaneousVelocity = (touch.clientX - gesture.lastX) / elapsed;
    gesture.velocity = gesture.velocity * 0.65 + instantaneousVelocity * 0.35;
    gesture.lastX = touch.clientX;
    gesture.lastAt = now;
    let offset = gesture.startOffset + dx;
    if (offset < 0) {
      offset *= 0.18;
    }
    if (offset > gesture.width) {
      offset = gesture.width + (offset - gesture.width) * 0.18;
    }
    scheduleRender(offset, now, gesture.velocity);
    const progress = Math.max(0, Math.min(1, offset / gesture.width));
    const nextCommit = gesture.startOpen ? progress > 0.66 : progress >= 0.34;
    if (nextCommit !== commit && !gesture.thresholdFired) {
      gesture.thresholdFired = true;
      pendingThresholdHaptic = true;
    }
    commit = nextCommit;
  };
  const onTouchEnd = (): void => {
    if (!gesture?.locked) {
      gesture = null;
      return;
    }
    const { velocity } = gesture;
    const open = Math.abs(velocity) >= 0.45 ? velocity > 0 : commit;
    gesture = null;
    commit = false;
    settle(open, velocity);
  };
  const onTouchCancel = (): void => {
    const open = gesture?.startOpen ?? getOpen();
    const locked = gesture?.locked === true;
    gesture = null;
    if (locked) {
      settle(open);
    } else {
      delete gestureTarget.dataset["spatialDrawerMoving"];
    }
  };
  const onResize = (): void => {
    presentationWidth = drawerWidth();
    render(getOpen() ? presentationWidth : 0);
  };

  presentationWidth = drawerWidth();
  render(getOpen() ? presentationWidth : 0);
  gestureTarget.addEventListener("touchstart", onTouchStart, { passive: true });
  gestureTarget.addEventListener("touchmove", onTouchMove, { passive: false });
  gestureTarget.addEventListener("touchend", onTouchEnd, { passive: true });
  gestureTarget.addEventListener("touchcancel", onTouchCancel, { passive: true });
  globalThis.addEventListener("resize", onResize);

  return {
    settle,
    dispose: () => {
      gestureTarget.removeEventListener("touchstart", onTouchStart);
      gestureTarget.removeEventListener("touchmove", onTouchMove);
      gestureTarget.removeEventListener("touchend", onTouchEnd);
      gestureTarget.removeEventListener("touchcancel", onTouchCancel);
      globalThis.removeEventListener("resize", onResize);
      globalThis.clearTimeout(settleTimer);
      if (renderFrame !== 0) {
        cancelAnimationFrame(renderFrame);
      }
      delete gestureTarget.dataset["spatialDrawerMoving"];
      for (const element of [surface, drawer, drawerMask]) {
        element.style.removeProperty("transform");
        element.style.removeProperty("opacity");
        element.style.removeProperty("transition");
        element.style.removeProperty("will-change");
      }
      clearDepth();
    },
  };
}
