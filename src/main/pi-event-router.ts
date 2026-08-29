import type { PiSdkManager } from "./pi-sdk-manager";
import type {
  PendingPromptCounts,
  PiExtensionUiRequest,
  PiProcessStatus,
  PiRpcEvent,
} from "../shared/ipc-contracts";

/**
 * Routes Pi events from every workspace's PiSdkManager to the renderer.
 *
 * Non-dialog events keep the deliberate active-workspace-only filter: the
 * renderer's piStatus/stream state is a single global view and must track the
 * active workspace. Blocking extension-UI dialogs (select/confirm/input/editor)
 * are different — Pi holds the tool call until an answer arrives, with no
 * timeout on permission confirms — so dropping one from an inactive workspace
 * deadlocks that workspace's turn. The router instead:
 *
 *  - retains the one delivered dialog per workspace (renderer slot is
 *    reconstructible from main state at any moment via flush),
 *  - queues further dialogs per workspace and serializes delivery,
 *  - remembers each request's origin manager so the answer always reaches the
 *    Pi that asked, regardless of which workspace is active at answer time,
 *  - evicts a manager's held prompts when its process stops (a dead Pi can
 *    never consume an answer).
 *
 * Electron-free factory: all I/O goes through injected deps, so tests drive it
 * with bare emitters and an injected clock.
 */

const BLOCKING_UI_METHODS: ReadonlySet<PiExtensionUiRequest["method"]> =
  new Set(["select", "confirm", "input", "editor"]);

interface QueuedPrompt {
  /** The id exposed to the renderer (unique while the prompt is held). */
  event: PiExtensionUiRequest;
  /** The id the originating Pi process expects in its response. */
  originalId: string;
  receivedAt: number;
}

interface PromptOrigin {
  manager: PiSdkManager;
  originalId: string;
}

export interface PiEventRouterDeps {
  getActiveManager(): PiSdkManager | null;
  workspaceIdFor(manager: PiSdkManager): string | null;
  /** Forward one Pi event to the renderer (EVENT_PI). */
  broadcastEvent(event: PiRpcEvent): void;
  /** Push a fresh pending-prompt snapshot to the renderer (EVENT_PENDING_PROMPTS). */
  broadcastPendingCounts(counts: PendingPromptCounts): void;
  now(): number;
}

export interface PiEventRouter {
  /** Wire a manager's event/status-change/exit emissions into the router. Idempotent. */
  attachManager(manager: PiSdkManager): void;
  /** Answer an extension-UI request, routing to its origin manager. */
  respond(id: string, response: Record<string, unknown>): void;
  /** (Re-)deliver the workspace's held dialog; no-op unless it is active now. */
  flush(workspaceId: string): void;
  /** Snapshot of held prompts; reaps timed-out ones so the figures stay honest. */
  getPendingCounts(): PendingPromptCounts;
  /** Re-broadcast counts after an active-workspace change; delivers nothing. */
  handleActiveWorkspaceChanged(): void;
}

export function createPiEventRouter(deps: PiEventRouterDeps): PiEventRouter {
  // Blocking dialogs are owned by a Pi process, not a project. Multiple live
  // session runtimes may share one workspace cwd, so workspace-keyed queues
  // would deliver one session's prompt to another.
  const queues = new Map<PiSdkManager, QueuedPrompt[]>();
  // The one dialog currently owned by the renderer slot per Pi process. The
  // full payload is retained until answered or evicted so flush can replay it.
  const delivered = new Map<PiSdkManager, QueuedPrompt>();
  // Every blocking dialog's asking manager and original Pi id, until answered
  // or evicted. The renderer-facing id is normally the original id; a suffix is
  // added only when two live runtimes happen to reuse the same id.
  const origins = new Map<string, PromptOrigin>();
  let nextDisambiguator = 1;
  const attached = new WeakSet<PiSdkManager>();

  const isBlockingDialog = (event: PiRpcEvent): event is PiExtensionUiRequest =>
    event.type === "extension_ui_request" &&
    BLOCKING_UI_METHODS.has(event.method);

  const activeWorkspaceId = (): string | null => {
    const manager = deps.getActiveManager();
    return manager ? deps.workspaceIdFor(manager) : null;
  };

  const promptIdInUse = (id: string): boolean => {
    if (origins.has(id)) return true;
    for (const entry of delivered.values())
      if (entry.event.id === id) return true;
    for (const entries of queues.values()) {
      if (entries.some((entry) => entry.event.id === id)) return true;
    }
    return false;
  };

  const track = (event: PiExtensionUiRequest): QueuedPrompt => {
    let exposedId = event.id;
    while (promptIdInUse(exposedId)) {
      exposedId = `${event.id}#${nextDisambiguator++}`;
    }
    const exposedEvent =
      exposedId === event.id ? event : { ...event, id: exposedId };
    return {
      event: exposedEvent,
      originalId: event.id,
      receivedAt: deps.now(),
    };
  };

  /**
   * Once the extension-supplied timeout elapses, Pi has auto-resolved the
   * request and deleted its pending entry, so a dialog shown from here on could
   * never be answered. Sole expiry rule for held prompts, queued or delivered.
   */
  const isExpired = (entry: QueuedPrompt): boolean =>
    entry.event.timeout !== undefined &&
    deps.now() - entry.receivedAt >= entry.event.timeout;

  /** Drop expired entries, forgetting their origins; returns the live ones. */
  const reapExpired = (entries: readonly QueuedPrompt[]): QueuedPrompt[] => {
    const live: QueuedPrompt[] = [];
    for (const entry of entries) {
      if (isExpired(entry)) origins.delete(entry.event.id);
      else live.push(entry);
    }
    return live;
  };

  /** An empty queue is deleted rather than stored, so counts omit zero entries. */
  const storeQueue = (manager: PiSdkManager, entries: QueuedPrompt[]): void => {
    if (entries.length === 0) queues.delete(manager);
    else queues.set(manager, entries);
  };

  const getPendingCounts = (): PendingPromptCounts => {
    // Reap queued entries first, then expire delivered entries. Promotion of a
    // visible slot must happen before counting so the same prompt is not
    // counted once as queued and again as delivered.
    for (const [manager, entries] of queues) {
      const live = reapExpired(entries);
      if (live.length !== entries.length) storeQueue(manager, live);
    }
    for (const [manager, entry] of [...delivered]) {
      if (!isExpired(entry)) continue;
      delivered.delete(manager);
      origins.delete(entry.event.id);
      if (manager === deps.getActiveManager()) deliverNext(manager);
    }

    const counts: PendingPromptCounts = {};
    for (const [manager, entries] of queues) {
      const workspaceId = deps.workspaceIdFor(manager);
      if (workspaceId && entries.length > 0)
        counts[workspaceId] = (counts[workspaceId] ?? 0) + entries.length;
    }
    for (const manager of delivered.keys()) {
      const workspaceId = deps.workspaceIdFor(manager);
      if (workspaceId) counts[workspaceId] = (counts[workspaceId] ?? 0) + 1;
    }
    return counts;
  };

  const emitCounts = (): void => {
    deps.broadcastPendingCounts(getPendingCounts());
  };

  /**
   * Pop the workspace's queue into its empty delivered slot and broadcast,
   * reaping expired entries on the way. Returns whether state changed.
   */
  const deliverNext = (manager: PiSdkManager): boolean => {
    if (delivered.has(manager)) return false;
    const entries = queues.get(manager);
    if (entries === undefined) return false;
    const live = reapExpired(entries);
    const next = live.shift();
    if (next !== undefined) {
      delivered.set(manager, next);
      deps.broadcastEvent(next.event);
    }
    storeQueue(manager, live);
    return live.length !== entries.length;
  };

  const enqueue = (manager: PiSdkManager, entry: QueuedPrompt): void => {
    const queue = queues.get(manager);
    if (queue) queue.push(entry);
    else queues.set(manager, [entry]);
  };

  const handleBlockingDialog = (
    manager: PiSdkManager,
    event: PiExtensionUiRequest,
  ): void => {
    const entry = track(event);
    origins.set(entry.event.id, { manager, originalId: entry.originalId });
    const workspaceId = deps.workspaceIdFor(manager);
    if (workspaceId === null) {
      // Manager unknown to the workspace registry: there is no queue slot to
      // hold it under, so deliver directly when active (origin routing above
      // still answers it) and let the inactive case fall through as a drop.
      if (manager === deps.getActiveManager()) {
        delivered.set(manager, entry);
        deps.broadcastEvent(entry.event);
      } else {
        // There is no workspace slot to hold an inactive unknown manager. Drop
        // the origin rather than leaving an undeliverable prompt in memory.
        origins.delete(entry.event.id);
      }
      return;
    }
    if (manager === deps.getActiveManager() && !delivered.has(manager)) {
      delivered.set(manager, entry);
      deps.broadcastEvent(entry.event);
    } else {
      // Inactive session runtime, or a dialog already on screen: hold for later.
      enqueue(manager, entry);
    }
    emitCounts();
  };

  const handleManagerEvent = (
    manager: PiSdkManager,
    event: PiRpcEvent,
  ): void => {
    if (isBlockingDialog(event)) {
      handleBlockingDialog(manager, event);
      return;
    }
    if (manager === deps.getActiveManager()) {
      deps.broadcastEvent(event);
    }
  };

  /**
   * A manager that stopped, crashed, or is restarting has abandoned its
   * pending requests: purge every prompt it originated so none can ghost-
   * deliver against a process that will never consume the answer.
   */
  const evictManager = (manager: PiSdkManager): void => {
    const ownedIds = new Set<string>();
    for (const [id, origin] of origins) {
      if (origin.manager === manager) ownedIds.add(id);
    }
    if (ownedIds.size === 0) return;
    for (const id of ownedIds) origins.delete(id);
    for (const [manager, entries] of queues) {
      const kept = entries.filter((entry) => !ownedIds.has(entry.event.id));
      if (kept.length !== entries.length) storeQueue(manager, kept);
    }
    for (const [manager, entry] of delivered) {
      if (ownedIds.has(entry.event.id)) delivered.delete(manager);
    }
    emitCounts();
  };

  const attachManager = (manager: PiSdkManager): void => {
    // WorkspaceManager's wiredPairs already dedups its listener attachment;
    // this guard makes the router safe against any second wiring path.
    if (attached.has(manager)) return;
    attached.add(manager);
    manager.on("event", (event: PiRpcEvent) =>
      handleManagerEvent(manager, event),
    );
    manager.on("status-change", (status: PiProcessStatus) => {
      if (manager === deps.getActiveManager()) {
        deps.broadcastEvent({ type: "status_change", ...manager.getStatus() });
      }
      if (status !== "running") evictManager(manager);
    });
    manager.on("exit", () => evictManager(manager));
  };

  const respond = (id: string, response: Record<string, unknown>): void => {
    const origin = origins.get(id) ?? null;
    origins.delete(id);
    // Purge the id everywhere FIRST — regardless of a routing hit — so an
    // answered request can never linger as a queued or delivered ghost.
    let purgedManager: PiSdkManager | null = null;
    for (const [manager, entries] of queues) {
      const kept = entries.filter((entry) => entry.event.id !== id);
      if (kept.length === entries.length) continue;
      purgedManager = manager;
      storeQueue(manager, kept);
    }
    for (const [manager, entry] of delivered) {
      if (entry.event.id !== id) continue;
      delivered.delete(manager);
      purgedManager = manager;
    }
    // Origin miss (notify dismissal, evicted prompt): fall back to the active
    // manager — Pi ignores unknown ids — or drop when no workspace is active.
    const target = origin?.manager ?? deps.getActiveManager();
    target?.sendExtensionUiResponse(origin?.originalId ?? id, response);
    if (purgedManager !== null && purgedManager === deps.getActiveManager()) {
      deliverNext(purgedManager);
    }
    emitCounts();
  };

  const flush = (workspaceId: string): void => {
    // Only the active workspace and its active session runtime may be flushed:
    // a stale flush must not resurface another session's dialog.
    if (workspaceId !== activeWorkspaceId()) return;
    const manager = deps.getActiveManager();
    if (!manager) return;
    const held = delivered.get(manager);
    if (held !== undefined && !isExpired(held)) {
      // Self-healing re-broadcast: rebuilds the renderer slot after a reload,
      // a switch-back, or a same-workspace re-activation. The renderer's
      // id-guard tolerates the duplicate when the dialog is already up.
      deps.broadcastEvent(held.event);
      return;
    }
    if (held !== undefined) {
      // The slot's dialog timed out while the workspace was away: releasing it
      // lets the next queued dialog take the slot instead of waiting on an
      // answer Pi would discard.
      delivered.delete(manager);
      origins.delete(held.event.id);
    }
    const promoted = deliverNext(manager);
    if (held !== undefined || promoted) emitCounts();
  };

  return {
    attachManager,
    respond,
    flush,
    getPendingCounts,
    handleActiveWorkspaceChanged: emitCounts,
  };
}
