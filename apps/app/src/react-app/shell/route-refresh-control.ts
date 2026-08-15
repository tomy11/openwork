// Concurrency and degraded-state policy for the session route's
// refreshRouteState. Extracted as pure helpers so the desktop restart
// recovery contract is unit-testable without rendering the route.

export type RouteRefreshAttempt = {
  readonly generation: number;
  /**
   * False once a newer refresh began. Stale attempts must stop writing
   * route state: their remaining awaits resolve against a connection that
   * newer attempts already replaced.
   */
  isCurrent(): boolean;
  /**
   * Release the in-flight slot if this attempt still owns it. A superseded
   * attempt no longer owns the slot, so its completion cannot re-open the
   * route for a duplicate refresh while the newer attempt is still running.
   */
  finish(): boolean;
};

export type RouteRefreshLifecycle = {
  /**
   * Start a refresh attempt. Returns null while another attempt is in
   * flight unless `supersede` is set, which cancels the in-flight attempt
   * (its `isCurrent()` turns false) instead of forcibly resetting a shared
   * latch and letting two writers race.
   */
  begin(options?: { supersede?: boolean }): RouteRefreshAttempt | null;
  isInFlight(): boolean;
};

export function createRouteRefreshLifecycle(): RouteRefreshLifecycle {
  let latestGeneration = 0;
  let inFlightGeneration = 0;

  return {
    begin(options) {
      if (inFlightGeneration !== 0 && !options?.supersede) return null;
      const generation = ++latestGeneration;
      inFlightGeneration = generation;
      return {
        generation,
        isCurrent: () => latestGeneration === generation,
        finish: () => {
          if (inFlightGeneration !== generation) return false;
          inFlightGeneration = 0;
          return true;
        },
      };
    },
    isInFlight: () => inFlightGeneration !== 0,
  };
}

export type RouteConnectionGapPlan = {
  /**
   * Keep the workspaces, session lists, selection, and host info as display
   * state instead of clearing them. The live client and endpoint resolver
   * are quarantined either way: during a gap the previous loopback port is
   * no longer owned by our server, so no request may carry the previous
   * bearer token there.
   */
  retainExistingState: boolean;
  /**
   * Whether this refresh may report route readiness to the boot overlay.
   * A transient desktop gap must not: the overlay stays up until a refresh
   * that actually established a connection (or recovery definitively fails).
   */
  markRouteReady: boolean;
};

/**
 * Decide what a refresh does when it resolves no usable OpenWork server
 * URL/token.
 *
 * On desktop the local server owns that URL and mints fresh tokens on every
 * (re)start, so an empty resolution during boot, an app update, or a server
 * restart is a transient gap: boot or the local reconnect path will publish
 * new connection info and trigger another refresh. Clearing the *display*
 * state here is what used to drop the active session list and flash
 * disconnected UI mid-restart; the *connection* is still torn down for the
 * duration of the gap.
 *
 * On web there is no local process to wait for — an empty resolution is a
 * real disconnected state and the route should reflect it immediately.
 */
export function planRouteConnectionGap(input: { desktopRuntime: boolean }): RouteConnectionGapPlan {
  if (input.desktopRuntime) {
    return { retainExistingState: true, markRouteReady: false };
  }
  return { retainExistingState: false, markRouteReady: true };
}
