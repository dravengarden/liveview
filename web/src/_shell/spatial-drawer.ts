import { predictSpatialDrawerOffset } from "./spatial-drawer-motion.ts";

export type SpatialDrawerSettle = (
  open: boolean,
  releaseVelocity?: number,
  onSettled?: () => void,
  cachedWidth?: number,
) => void;

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
  backdrop,
  phone,
  reservedLeadingEdge = 0,
  getOpen,
  setOpen,
  onPrepareThreshold,
  onThreshold,
}: {
  readonly gestureTarget: HTMLElement;
  readonly surface: HTMLElement;
  readonly drawer: HTMLElement;
  readonly drawerMask: HTMLElement;
  readonly backdrop: HTMLElement;
  readonly phone: boolean;
  /** Leave this many leading-edge pixels to the host's native-style back
   *  gesture while the drawer is closed. An open drawer still owns the full
   *  surface so it can always be swiped closed. */
  readonly reservedLeadingEdge?: number;
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
  let releaseFrame = 0;
  let releaseIdle: number | undefined;

  const drawerWidth = (): number => {
    const width = surface.clientWidth;
    return phone ? Math.min(360, width * 0.84) : Math.min(440, width * 0.52);
  };
  const applyDepth = (): void => {
    // Keep the heavy reader translation-only. Clipping or shadowing that layer
    // makes iPhone WebKit re-rasterize the entire document on every touch frame.
    // The empty mask follows the same offset and cheaply owns the depth cue.
    drawerMask.style.boxShadow = "-18px 0 42px rgba(0,0,0,0.16)";
  };
  const clearDepth = (): void => {
    drawerMask.style.removeProperty("box-shadow");
  };
  const render = (offset: number): void => {
    currentOffset = offset;
    const progress = presentationWidth > 0
      ? Math.max(0, Math.min(1, offset / presentationWidth))
      : 0;
    const parallax = presentationWidth * (phone ? 0.28 : 0.22) * (1 - progress);
    surface.style.transform = `translate3d(${String(offset)}px,0,0)`;
    drawer.style.transform = `translate3d(-${String(parallax)}px,0,0)`;
    drawer.style.opacity = String(0.72 + progress * 0.28);
    drawerMask.style.transform = `translate3d(${String(offset)}px,0,0)`;
    backdrop.style.opacity = String(progress);
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
    for (const element of [surface, drawer, drawerMask, backdrop]) {
      element.style.removeProperty("transition");
      element.style.removeProperty("will-change");
    }
  };
  const releaseDirectManipulation = (): void => {
    const finish = (): void => {
      releaseIdle = undefined;
      delete gestureTarget.dataset["spatialDrawerMoving"];
    };
    releaseFrame = requestAnimationFrame(() => {
      releaseFrame = 0;
      if (typeof globalThis.requestIdleCallback === "function") {
        releaseIdle = globalThis.requestIdleCallback(finish, { timeout: 180 });
      } else {
        releaseIdle = globalThis.setTimeout(finish, 32) as unknown as number;
      }
    });
  };
  const settle: SpatialDrawerSettle = (
    open,
    releaseVelocity = 0,
    onSettled,
    cachedWidth,
  ): void => {
    globalThis.clearTimeout(settleTimer);
    if (open) {
      gestureTarget.dataset["spatialDrawerOpen"] = "true";
    }
    const releaseOffset = renderFrame === 0 ? currentOffset : pendingOffset;
    if (renderFrame !== 0) {
      cancelAnimationFrame(renderFrame);
    }
    renderFrame = 0;
    const width = cachedWidth ?? drawerWidth();
    presentationWidth = width;
    const target = open ? width : 0;
    const remaining = Math.min(1, Math.abs(target - releaseOffset) / width);
    const duration = Math.max(150, Math.min(260, 160 + remaining * 100 - Math.min(70, Math.abs(releaseVelocity) * 45)));
    applyDepth();
    surface.style.willChange = "transform";
    drawer.style.willChange = "transform,opacity";
    drawerMask.style.willChange = "transform";
    backdrop.style.willChange = "opacity";
    surface.style.transition = `transform ${String(duration)}ms cubic-bezier(0.22,1,0.36,1)`;
    drawer.style.transition = `transform ${String(duration)}ms cubic-bezier(0.22,1,0.36,1),opacity ${
      String(duration)
    }ms cubic-bezier(0.22,1,0.36,1)`;
    drawerMask.style.transition = `transform ${String(duration)}ms cubic-bezier(0.22,1,0.36,1)`;
    backdrop.style.transition = `opacity ${
      String(duration)
    }ms cubic-bezier(0.22,1,0.36,1)`;
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
        delete gestureTarget.dataset["spatialDrawerOpen"];
        clearDepth();
      }
      onSettled?.();
    }, duration + 20);
  };

  const onTouchStart = (event: TouchEvent): void => {
    const [touch] = event.touches;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const startOpen = getOpen();
    if (
      !touch || hasExpandedSelection() ||
      (!startOpen && touch.clientX <= reservedLeadingEdge) ||
      target?.closest("input,textarea,[contenteditable='true'],[data-spatial-drawer-ignore]") ||
      hasHorizontalScroller(event.target, gestureTarget)
    ) {
      gesture = null;
      return;
    }
    const now = performance.now();
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
    if (!gesture || !touch) {
      return;
    }
    if (hasExpandedSelection()) {
      gesture = null;
      commit = false;
      return;
    }
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.locked && Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx) * 1.15) {
      gesture = null;
      // Once vertical intent is clear, release this recognizer while shielding
      // the same stream from an outer horizontal pager.
      event.stopPropagation();
      return;
    }
    if (!gesture.locked && (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy) * 1.15)) {
      return;
    }
    if ((!gesture.startOpen && dx < 0) || (gesture.startOpen && dx > 0)) {
      return;
    }
    if (!gesture.locked) {
      if (releaseFrame !== 0) cancelAnimationFrame(releaseFrame);
      if (releaseIdle !== undefined) {
        if (typeof globalThis.cancelIdleCallback === "function") {
          globalThis.cancelIdleCallback(releaseIdle);
        } else {
          globalThis.clearTimeout(releaseIdle);
        }
        releaseIdle = undefined;
      }
      applyDepth();
      gestureTarget.dataset["spatialDrawerMoving"] = "true";
      surface.style.transition = "none";
      surface.style.willChange = "transform";
      drawer.style.transition = "none";
      drawer.style.willChange = "transform,opacity";
      drawerMask.style.transition = "none";
      drawerMask.style.willChange = "transform";
      backdrop.style.transition = "none";
      backdrop.style.willChange = "opacity";
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
    const { velocity, width } = gesture;
    const open = Math.abs(velocity) >= 0.45 ? velocity > 0 : commit;
    gesture = null;
    commit = false;
    settle(open, velocity, releaseDirectManipulation, width);
  };
  const onTouchCancel = (): void => {
    const open = gesture?.startOpen ?? getOpen();
    const width = gesture?.width;
    const locked = gesture?.locked === true;
    gesture = null;
    if (locked) {
      settle(open, 0, releaseDirectManipulation, width);
    } else {
      delete gestureTarget.dataset["spatialDrawerMoving"];
    }
  };
  const onResize = (): void => {
    presentationWidth = drawerWidth();
    render(getOpen() ? presentationWidth : 0);
  };

  if (getOpen()) {
    gestureTarget.dataset["spatialDrawerOpen"] = "true";
    applyDepth();
  } else {
    delete gestureTarget.dataset["spatialDrawerOpen"];
    clearDepth();
  }
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
      delete gestureTarget.dataset["spatialDrawerOpen"];
      if (releaseFrame !== 0) {
        cancelAnimationFrame(releaseFrame);
      }
      if (releaseIdle !== undefined) {
        if (typeof globalThis.cancelIdleCallback === "function") {
          globalThis.cancelIdleCallback(releaseIdle);
        } else {
          globalThis.clearTimeout(releaseIdle);
        }
      }
      for (const element of [surface, drawer, drawerMask, backdrop]) {
        element.style.removeProperty("transform");
        element.style.removeProperty("opacity");
        element.style.removeProperty("transition");
        element.style.removeProperty("will-change");
      }
      clearDepth();
    },
  };
}
