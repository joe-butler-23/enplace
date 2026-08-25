import React from "react";
import { open } from "@/host-client/dialog";
import {
  getOrganiserPresets
} from "@/modules/organiser/presets/organiserPresets";
import { normalizeWeeklyColumnMinWidth } from "@/modules/organiser/utils/weekly-layout";
import { PlannerOrderStore } from "@/modules/organiser/utils/planner-order";
import { CookingDatabase, type DatabaseCoverState, type DatabaseState } from "@/views/components/CookingDatabase";
import { CookingHealth } from "@/views/components/CookingHealth";
import { RecipeView } from "@/views/components/RecipeView";
import { ShoppingListView } from "@/views/components/ShoppingListView";
import { isDatabaseImagePriming, shouldIssueDetailPrewarm } from "@/views/utils/database-image-priming";
import { isDirectCardSource } from "@/views/utils/card-resource-routing";
import { splitViewportPaths } from "@/views/utils/thumbnail-batching";
import { createImageResourceKey, ImageResourceStore, type ImageResource, type ImageResourceKey } from "@/views/utils/image-resources";
import type { RecipeDatabaseQuery, RecipeDatabaseView, RecipeDatabaseItem } from "@/pttNode";
import { HealthService } from "@/services/HealthService";
import { LedgerStore } from "@/services/LedgerStore";
import { RecipeIndexService } from "@/modules/cooking/services/RecipeIndexService";
import { BuiltInShoppingListService } from "@/modules/cooking/services/BuiltInShoppingListService";
import { checkShoppingItem } from "@/modules/cooking/services/checkShoppingItem";
import { resolveDatabaseCoverPath } from "@/modules/cooking/utils/databaseCover";
import { projectMarkedInDatabaseViews } from "@/modules/cooking/utils/database-cache";
import { compareRecipeDatabaseItems } from "@/modules/cooking/utils/recipe-order";
import { setDiagnostics } from "@/diagnostics";
import {
  createStandaloneApp,
  Notice,
  normalizePath,
  setIcon,
  TAbstractFile,
  TFile,
  type CachedMetadata
} from "@/platform";
import { isHostedRuntime } from "@/runtime";
import {
  createChannel,
  mepGetThumbnail,
  mepPrepareDatabaseThumbnails,
  mepShoppingAdd,
  mepShoppingApply,
  mepShoppingCheck,
  mepShoppingList,
  mepShoppingRemove,
  mepShoppingRollback,
  mepRecipeDatabaseStream,
  mepUnwatchVault,
  mepVaultChangesSince,
  mepWatchVault,
  type RecipeDatabaseStreamEvent,
  type ShoppingList,
  type ShoppingListPlan,
  type VaultWatchBatch,
  type VaultWatchEvent
} from "@/host-client/commands";
import {
  advanceVaultWatchGeneration,
  applyVaultWatchBatchEntries,
  hasVaultWatchGenerationGap,
  reconcileThenRestartVaultWatcher,
  startAndReconcileVaultWatcher,
  vaultWatchAction
} from "@/vault-watch-state";
import { installPttFallback } from "./pttNode";
import { DEFAULT_STANDALONE_SETTINGS, type StandaloneSettings } from "./standalone/settings";
import {
  ensureVaultStructure,
  getSettingsPath,
  loadLedger,
  loadSettings,
  prepareStandaloneStartup,
  saveLedger,
  saveSettings
} from "./standalone/storage";
import {
  initialViewForPathname,
  pathnameForView,
  shoppingShareUrl
} from "./standalone/pwa-route";
import {
  createIndexedMetadataHydrator,
  DatabaseMetadataHydrationGate,
  isCurrentDatabaseCoverSettlement,
  PlannerMetadataHydration,
  type PlannerMetadataStatus
} from "./standalone/metadata-hydration";
import { markVaultRefreshOutcome } from "./standalone/vault-refresh-completion";
import {
  acknowledgePlannerBoardReady,
  cancelPlannerNavigation,
  createPlannerNavigationIntentState,
  failPlannerNavigation,
  requestPlannerNavigation,
  retryPlannerNavigation,
  settlePlannerNavigation,
  type PlannerNavigationIntent,
} from "./standalone/planner-navigation-intent";
import {
  createPlannerRefreshPriorityState,
  prioritizePlannerRefresh,
  registerPlannerRefreshStart,
  resetPlannerRefreshPriority,
} from "./standalone/planner-refresh-priority";
import {
  PLANNER_METADATA_PLACEHOLDER_TIMING,
  PLANNER_SUSPENSE_PLACEHOLDER_TIMING,
  markPlannerSemanticReady,
  plannerBoardIdentityKey,
  type PlannerBoardIdentity
} from "./standalone/planner-transition-evidence";

declare const __MEP_DEV__: boolean;

function loadWeeklyOrganiserBoard() {
  return import("@/modules/organiser/components/WeeklyOrganiserBoard");
}

function notifyEmbeddedReady() {
  if (window.parent === window) return;
  window.parent.postMessage({ type: "mep-standalone-ready" }, "*");
}

const LazyWeeklyOrganiserBoard = React.lazy(() =>
  loadWeeklyOrganiserBoard().then((mod) => ({
    default: mod.WeeklyOrganiserBoard
  }))
);
type ViewId = "planner" | "database" | "shopping" | "health" | "settings" | "recipe";

type WeeklyOrganiserBoardComponent = typeof import("@/modules/organiser/components/WeeklyOrganiserBoard")["WeeklyOrganiserBoard"];

type RuntimeState = {
  app: Awaited<ReturnType<typeof createStandaloneApp>>;
  settings: StandaloneSettings;
  ledger: LedgerStore;
  plannerOrderStore: PlannerOrderStore;
  plannerMetadata: PlannerMetadataHydration;
  weeklyOrganiserBoard?: WeeklyOrganiserBoardComponent;
};

const READY_PLANNER_METADATA: PlannerMetadataStatus = { status: "ready" };
const NOOP_UNSUBSCRIBE = () => undefined;

function markPlannerMetadataCompletion(): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    // Evidence only: Planner readiness remains owned by PlannerMetadataHydration completion.
    performance.mark("mep:planner:metadata-complete");
  }
}

type PreviewErrorBoundaryProps = {
  fallback: React.ReactNode;
  children: React.ReactNode;
};

type PreviewErrorBoundaryState = {
  hasError: boolean;
};

class PreviewErrorBoundary extends React.Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PreviewErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Preview render failed", error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

const URL_PATTERN = /^(https?:\/\/[^\s]+)$/i;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(([^)]+)\)/g;

function normalizeImageSource(path: string): string {
  return path.trim();
}

function isDirectImageSource(path: string): boolean {
  return isDirectCardSource(path);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim() || "Unknown error";
    const firstStackLine = error.stack?.split("\n").find((line) => line.trim().length > 0);
    return firstStackLine ? `${message}\n${firstStackLine}` : message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "Unknown startup error.";
  }
}

const FAILED_LOAD_MESSAGE = "Failed to load file.";
const CONTENT_CACHE_STORAGE_KEY = "mep:content-cache:v1";
const CONTENT_CACHE_MAX_ENTRIES = 80;
const CONTENT_CACHE_MAX_ITEM_CHARS = 100_000;
// Persists app.metadataCache's frontmatter+tags across sessions so the next boot can hydrate it
// synchronously while current recipesFolder content is verified before readiness. Capped
// generously above realistic vault sizes; skip persisting past it rather than build LRU eviction
// for a warm-cache convenience.
const METADATA_CACHE_STORAGE_KEY = "mep:metadata-cache:v1";
const METADATA_CACHE_MAX_ENTRIES = 4000;

function hydrateMetadataCacheFromStorage(metadataCache: {
  hydrate: (entries: Record<string, CachedMetadata>) => void;
}): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(METADATA_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CachedMetadata>;
    if (!parsed || typeof parsed !== "object") return;
    metadataCache.hydrate(parsed);
  } catch (error) {
    console.warn("Failed hydrating persisted metadata cache", error);
  }
}

const PREWARM_FILE_LIMIT = 72;
const PREWARM_IMAGE_LIMIT_PER_FILE = 4;
const PREWARM_CONCURRENCY = 2;
const DATABASE_IMAGE_PRELOAD_LIMIT = 500;

function resolveMarkedFilter(
  marked: DatabaseState["marked"]
): boolean | undefined {
  if (marked === "marked") return true;
  if (marked === "unmarked") return false;
  return undefined;
}

function resolveScheduledFilter(
  scheduled: DatabaseState["scheduled"]
): boolean | undefined {
  if (scheduled === "scheduled") return true;
  if (scheduled === "unscheduled") return false;
  return undefined;
}

function resolveAddedAfter(
  added: DatabaseState["added"]
): number | undefined {
  if (added !== "last-7-days") return undefined;
  const since = new Date();
  since.setDate(since.getDate() - 7);
  since.setHours(0, 0, 0, 0);
  return since.getTime();
}

async function decodeImageSource(url: string): Promise<ImageResource> {
  if (typeof Image === "undefined") return { url, width: 16, height: 9 };
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Failed to decode image: ${url}`));
  });
  image.src = url;
  if (typeof image.decode === "function") {
    try {
      await image.decode();
      return { url, width: image.naturalWidth || 16, height: image.naturalHeight || 9 };
    } catch (error) {
      if (image.complete && image.naturalWidth === 0) {
        throw error;
      }
    }
  }
  await loaded;
  return { url, width: image.naturalWidth || 16, height: image.naturalHeight || 9 };
}

async function decodeCardThumbnail(url: string): Promise<ImageResource> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Thumbnail request failed: ${response.status}`);
  const blob = await response.blob();
  return { url: URL.createObjectURL(blob), width: 0, height: 0 };
}

function disposeImageResource(resource: ImageResource): void {
  if (resource.url.startsWith("blob:")) URL.revokeObjectURL(resource.url);
}

// Stable sentinel objects so cards without a settled store record (no cover, or still decoding)
// keep the same reference across renders -- RecipeCard's memo compares coverState by reference,
// and a freshly allocated object per render would defeat that memo for every unsettled card.
const NO_COVER_STATE: DatabaseCoverState = { status: "none" };
const PENDING_COVER_STATE: DatabaseCoverState = { status: "pending" };

function extractMarkdownImagePaths(content: string, limit = Number.POSITIVE_INFINITY): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const imageMatches = content.matchAll(MARKDOWN_IMAGE_RE);
  for (const match of imageMatches) {
    const rawTarget = match[1];
    if (!rawTarget) continue;
    const trimmedTarget = rawTarget.trim();
    const wrappedPath = trimmedTarget.match(/^<([^>]+)>/);
    const path = (wrappedPath?.[1] ?? trimmedTarget.split(/\s+/)[0] ?? "").trim();
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    results.push(path);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function resolveEventPath(value: TAbstractFile | string): string {
  return typeof value === "string" ? value : value.path;
}

function isRelevantWatchPath(value?: string | null): boolean {
  if (!value) return false;
  const normalized = normalizePath(value).toLowerCase();
  if (normalized.includes("/.mep/") || normalized.startsWith(".mep/")) {
    return false;
  }
  return normalized.endsWith(".md");
}

function isTextEntryElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[contenteditable='true']"));
}

function hasRecipeType(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "recipe" || normalized === "meal";
  }
  if (!Array.isArray(value)) return false;
  return value.some((entry) => hasRecipeType(entry));
}

function isPathInFolder(path: string, folder: string): boolean {
  if (!folder) return false;
  const normalizedPath = normalizePath(path);
  const normalizedFolder = normalizePath(folder).replace(/\/+$/, "");
  return normalizedPath.startsWith(`${normalizedFolder}/`);
}

function initialDatabaseState(settings: StandaloneSettings): DatabaseState {
  return {
    search: "",
    sort: settings.databaseSort,
    marked: settings.databaseMarkedFilter,
    scheduled: settings.databaseScheduledFilter,
    added: "all",
    tags: []
  };
}

type PersistedContentCacheEntry = {
  mtime: number;
  content: string;
  lastUsed: number;
};

type PersistedContentCache = Record<string, PersistedContentCacheEntry>;

function useLazyRef<T>(createValue: () => T): React.RefObject<T> {
  const ref = React.useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = createValue();
  }
  return ref as React.RefObject<T>;
}

// react-doctor-disable-next-line no-giant-component
// react-doctor-disable-next-line prefer-useReducer
function App(): React.JSX.Element {
  const imageResourceStoreRef = useLazyRef(() => new ImageResourceStore(600, disposeImageResource, 12));
  const databaseImageResourceStoreRef = useLazyRef(() => new ImageResourceStore(600, disposeImageResource, 128));
  const databaseViewCacheRef = React.useRef<Map<string, RecipeDatabaseView>>(new Map());
  const databaseViewStaleRef = React.useRef<Set<string>>(new Set());
  const databaseQueryKeyRef = React.useRef<string | null>(null);
  const databaseVaultRevisionRef = React.useRef<number | null>(null);
  const recipeIndexRevisionRef = React.useRef<number | null>(null);
  const noticeTimerRef = React.useRef<Set<number>>(new Set());
  const fileContentCacheRef = React.useRef<Map<string, string>>(new Map());
  const persistedContentCacheRef = React.useRef<PersistedContentCache>({});
  const persistedContentCacheDirtyRef = React.useRef(false);
  const persistedContentFlushTimerRef = React.useRef<number | null>(null);
  const prewarmedContentVersionRef = React.useRef<Map<string, number>>(new Map());
  const prewarmInFlightPathsRef = React.useRef<Set<string>>(new Set());
  const databaseImagePrimingRef = React.useRef(false);
  const previewLoadingTimerRef = React.useRef<number | null>(null);
  const previewReadRequestIdRef = React.useRef(0);
  const settingsRef = React.useRef<StandaloneSettings>(DEFAULT_STANDALONE_SETTINGS);
  const plannerMetadataRef = React.useRef<PlannerMetadataHydration | null>(null);
  const observedMetadataCompletionRef = React.useRef<PlannerMetadataHydration | null>(null);
  const plannerMetadataBlockedByVaultRefreshRef = React.useRef(false);
  const retryVaultRefreshRef = React.useRef<(() => void) | null>(null);
  const initializeGenerationRef = React.useRef(0);
  const databaseMetadataHydrationGateRef = useLazyRef(
    () => new DatabaseMetadataHydrationGate()
  );

  const [runtime, setRuntime] = React.useState<RuntimeState | null>(null);
  const plannerMetadataStatus = React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) => runtime?.plannerMetadata.subscribe(listener) ?? NOOP_UNSUBSCRIBE,
      [runtime]
    ),
    React.useCallback(
      () => runtime?.plannerMetadata.getSnapshot() ?? READY_PLANNER_METADATA,
      [runtime]
    ),
    () => READY_PLANNER_METADATA
  );
  const [settingsRevision, setSettingsRevision] = React.useState(0);
  const [activeView, setActiveViewInternal] = React.useState<ViewId>(() => {
    if (isHostedRuntime()) return initialViewForPathname(window.location.pathname);
    return "planner";
  });
  const activeViewRef = React.useRef<ViewId>(activeView);
  const plannerTransitionGenerationRef = React.useRef(0);
  const plannerNavigationIntentRef = React.useRef(createPlannerNavigationIntentState());
  const plannerRefreshPriorityRef = React.useRef(createPlannerRefreshPriorityState());
  const [plannerNavigationIntentRevision, setPlannerNavigationIntentRevision] = React.useState(0);
  const [plannerTransitionGeneration, setPlannerTransitionGeneration] = React.useState(0);
  const [plannerBoardIdentity, setPlannerBoardIdentity] = React.useState<PlannerBoardIdentity | null>(null);
  const [plannerBoardRetryRevision, setPlannerBoardRetryRevision] = React.useState(0);
  const [plannerDatasetReady, setPlannerDatasetReady] = React.useState(false);
  const [plannerDatasetFailure, setPlannerDatasetFailure] = React.useState<string | null>(null);
  const pendingPlannerFailure = plannerNavigationIntentRef.current.failure ?? (
    plannerNavigationIntentRef.current.pending !== null || activeView === "planner"
      ? plannerDatasetFailure
      : null
  );
  const plannerResidentMounted = Boolean(
    runtime && plannerDatasetReady && plannerMetadataStatus.status === "ready"
  );
  const plannerBoardReady = plannerDatasetReady && plannerBoardIdentity !== null;
  const emittedPlannerIdentitiesRef = React.useRef<Set<string>>(new Set());
  const [viewHistory, setViewHistory] = React.useState<ViewId[]>(() => [activeView]);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const [previewWidth, setPreviewWidth] = React.useState(420);
  const [isPreviewResizing, setIsPreviewResizing] = React.useState(false);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const previewResizeRef = React.useRef<{
    startX: number;
    startWidth: number;
    currentWidth: number;
  } | null>(null);
  const [activeFile, setActiveFile] = React.useState<TFile | null>(null);
  const [activeContent, setActiveContent] = React.useState<string>("");
  const [previewFile, setPreviewFile] = React.useState<TFile | null>(null);
  const [previewContent, setPreviewContent] = React.useState<string>("");
  const [previewIsRecipe, setPreviewIsRecipe] = React.useState(false);
  const [isPreviewContentLoading, setIsPreviewContentLoading] = React.useState(false);
  const [databaseState, setDatabaseState] = React.useState<DatabaseState>(() =>
    initialDatabaseState(DEFAULT_STANDALONE_SETTINGS)
  );
  const [vaultRevision, setVaultRevision] = React.useState(0);
  // Each vaultRevision bump below fires from an already-settled completion (a resolved
  // refresh/refreshFolder, one native watcher batch, or a finally block) --
  // 81a8639c removed the metadataCache "changed" -> bump() wiring that used to make the deferred
  // recipesFolder background reindex raise vaultRevision on its own, so boot now has exactly one
  // producer (the deferred refreshVaultIndex() completion below), not two landing a beat apart.
  // No silence-debounce is needed to coalesce a pair that no longer exists.
  const [isCommandOpen, setIsCommandOpen] = React.useState(false);
  const [isHelpOpen, setIsHelpOpen] = React.useState(false);
  const helpDialogRef = React.useRef<HTMLDialogElement>(null);
  const [commandQuery, setCommandQuery] = React.useState("");
  const [databaseView, setDatabaseView] = React.useState<RecipeDatabaseView>({
    items: [],
    total: 0,
    availableTags: [],
    markedCount: 0
  });
  const databaseCoverRequestKeyRef = React.useRef<string | null>(null);
  const embeddedReadyNotifiedRef = React.useRef(false);
  const [databaseIsPending, setDatabaseIsPending] = React.useState(false);
  const [databaseSourceError, setDatabaseSourceError] = React.useState<string | null>(null);
  // Couples cover settlement to the exact item-array generation so an old empty/settled view
  // cannot make a newly streamed non-empty view look settled before its own store pass runs.
  const [databaseCoverSettlement, setDatabaseCoverSettlement] = React.useState<{
    items: RecipeDatabaseItem[];
    settled: boolean;
  } | null>(null);
  const databaseCoversSettled = isCurrentDatabaseCoverSettlement(
    databaseView.items,
    databaseCoverSettlement
  );
  const organiserPresets = React.useMemo(() => getOrganiserPresets(), [runtime]);
  const [notices, setNotices] = React.useState<{ id: string; message: string }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [startupPhase, setStartupPhase] = React.useState("Preparing startup");
  const [startupError, setStartupError] = React.useState<string | null>(null);
  const [startupEvents, setStartupEvents] = React.useState<string[]>([]);
  const [startupStartedAt, setStartupStartedAt] = React.useState<number>(Date.now());
  const [startupElapsedSeconds, setStartupElapsedSeconds] = React.useState(0);
  const [isSidebarExpanded, setIsSidebarExpanded] = React.useState(false);
  const [healthRevision, setHealthRevision] = React.useState(0);
  const [shoppingList, setShoppingList] = React.useState<ShoppingList | null>(null);
  const [shoppingPlan, setShoppingPlan] = React.useState<ShoppingListPlan | null>(null);
  const [shoppingBusy, setShoppingBusy] = React.useState(false);
  const [shoppingError, setShoppingError] = React.useState<string | null>(null);
  const databaseImagesArePriming = isDatabaseImagePriming(
    activeView === "database",
    databaseIsPending,
    databaseView.items,
    databaseCoversSettled
  );
  const detailPrewarmAllowed = shouldIssueDetailPrewarm(activeView, databaseImagesArePriming);

  React.useEffect(() => {
    databaseImagePrimingRef.current = !detailPrewarmAllowed;
  }, [detailPrewarmAllowed]);

  React.useEffect(() => {
    if (!isHelpOpen) return;
    const dialog = helpDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [isHelpOpen]);



  const clearPreviewLoadingTimer = React.useCallback(() => {
    if (previewLoadingTimerRef.current !== null) {
      window.clearTimeout(previewLoadingTimerRef.current);
      previewLoadingTimerRef.current = null;
    }
  }, []);

  const flushPersistedContentCache = React.useCallback(() => {
    if (typeof window === "undefined" || !persistedContentCacheDirtyRef.current) return;
    const payload = JSON.stringify(persistedContentCacheRef.current);
    window.localStorage.setItem(CONTENT_CACHE_STORAGE_KEY, payload);
    persistedContentCacheDirtyRef.current = false;
  }, []);

  const clearPersistedContentFlushTimer = React.useCallback(() => {
    if (persistedContentFlushTimerRef.current !== null) {
      window.clearTimeout(persistedContentFlushTimerRef.current);
      persistedContentFlushTimerRef.current = null;
    }
  }, []);

  const schedulePersistedContentFlush = React.useCallback(() => {
    clearPersistedContentFlushTimer();
    persistedContentFlushTimerRef.current = window.setTimeout(() => {
      persistedContentFlushTimerRef.current = null;
      try {
        flushPersistedContentCache();
      } catch (error) {
        console.warn("Failed flushing persisted content cache", error);
      }
    }, 240);
  }, [clearPersistedContentFlushTimer, flushPersistedContentCache]);

  const rememberFileContent = React.useCallback(
    (file: TFile | null, content: string) => {
      if (!file) return;
      fileContentCacheRef.current.delete(file.path);
      fileContentCacheRef.current.set(file.path, content);
      while (fileContentCacheRef.current.size > 200) {
        const oldestPath = fileContentCacheRef.current.keys().next().value as string | undefined;
        if (!oldestPath) break;
        fileContentCacheRef.current.delete(oldestPath);
      }

      if (content.length > CONTENT_CACHE_MAX_ITEM_CHARS) {
        return;
      }

      const now = Date.now();
      const cache = persistedContentCacheRef.current;
      cache[file.path] = {
        mtime: file.stat?.mtime ?? now,
        content,
        lastUsed: now
      };
      persistedContentCacheDirtyRef.current = true;

      const paths = Object.keys(cache);
      if (paths.length > CONTENT_CACHE_MAX_ENTRIES) {
        paths
          .sort((a, b) => cache[a]!.lastUsed - cache[b]!.lastUsed)
          .slice(0, paths.length - CONTENT_CACHE_MAX_ENTRIES)
          .forEach((path) => {
            delete cache[path];
          });
      }

      schedulePersistedContentFlush();
    },
    [schedulePersistedContentFlush]
  );

  const startPlannerMetadataHydration = React.useCallback(() => {
    if (plannerMetadataBlockedByVaultRefreshRef.current) {
      return;
    }
    const hydration = plannerMetadataRef.current;
    if (!hydration) return;
    const status = hydration.getSnapshot().status;
    if (
      observedMetadataCompletionRef.current === hydration &&
      (status === "loading" || status === "ready")
    ) {
      return;
    }
    observedMetadataCompletionRef.current = hydration;
    void hydration.start()
      .then(() => {
        if (plannerMetadataRef.current !== hydration) return;
        markPlannerMetadataCompletion();
      })
      .catch((error: unknown) => {
        if (plannerMetadataRef.current !== hydration) return;
        observedMetadataCompletionRef.current = null;
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed hydrating planner metadata", error);
      });
  }, []);

  const beginPlannerTransition = React.useCallback((generation?: number) => {
    const nextGeneration = generation ?? plannerTransitionGenerationRef.current + 1;
    plannerTransitionGenerationRef.current = nextGeneration;
    setPlannerTransitionGeneration(nextGeneration);
  }, []);

  const preparePlannerNavigation = React.useCallback(() => {
    prioritizePlannerRefresh(plannerRefreshPriorityRef.current);
    startPlannerMetadataHydration();
  }, [startPlannerMetadataHydration]);

  const requestPendingPlannerNavigation = React.useCallback((
    history: PlannerNavigationIntent["history"]
  ) => {
    const intent = requestPlannerNavigation(plannerNavigationIntentRef.current, history);
    if (plannerDatasetFailure !== null) {
      failPlannerNavigation(plannerNavigationIntentRef.current, plannerDatasetFailure);
      if (typeof performance?.mark === "function") {
        performance.mark("mep:planner:navigation-failed", {
          detail: { generation: intent.generation, message: plannerDatasetFailure }
        });
      }
    }
    beginPlannerTransition(intent.generation);
    setPlannerNavigationIntentRevision((revision) => revision + 1);
    preparePlannerNavigation();
  }, [beginPlannerTransition, plannerDatasetFailure, preparePlannerNavigation]);

  const cancelPendingPlannerNavigation = React.useCallback(() => {
    if (plannerNavigationIntentRef.current.pending === null) return;
    // The authoritative refresh is app-owned background work. Cancelling navigation
    // does not cancel it; Planner intent only promotes its already-owned start.
    cancelPlannerNavigation(plannerNavigationIntentRef.current);
    setPlannerNavigationIntentRevision((revision) => revision + 1);
  }, []);

  const retryPendingPlannerNavigation = React.useCallback(() => {
    if (plannerNavigationIntentRef.current.pending !== null) {
      retryPlannerNavigation(plannerNavigationIntentRef.current);
    }
    setPlannerDatasetFailure(null);
    setPlannerBoardRetryRevision((revision) => revision + 1);
    setPlannerNavigationIntentRevision((revision) => revision + 1);
    preparePlannerNavigation();
    retryVaultRefreshRef.current?.();
  }, [preparePlannerNavigation]);

  const handlePlannerBoardReady = React.useCallback((identity: PlannerBoardIdentity) => {
    setPlannerBoardIdentity((current) => (
      current && plannerBoardIdentityKey(current) === plannerBoardIdentityKey(identity)
        ? current
        : identity
    ));
    if (plannerNavigationIntentRef.current.pending !== null) {
      acknowledgePlannerBoardReady(plannerNavigationIntentRef.current);
      setPlannerNavigationIntentRevision((revision) => revision + 1);
    }
  }, []);

  const handlePlannerBoardError = React.useCallback((error: unknown) => {
    const detail = formatErrorMessage(error);
    setPlannerBoardIdentity(null);
    setPlannerDatasetFailure(detail);
    if (plannerNavigationIntentRef.current.pending !== null) {
      failPlannerNavigation(plannerNavigationIntentRef.current, detail);
      setPlannerNavigationIntentRevision((revision) => revision + 1);
      if (typeof performance?.mark === "function") {
        performance.mark("mep:planner:navigation-failed", {
          detail: { generation: plannerNavigationIntentRef.current.pending?.generation, message: detail }
        });
      }
    }
  }, []);

  React.useEffect(() => {
    if (activeView !== "planner" && !plannerResidentMounted) {
      setPlannerBoardIdentity(null);
    }
  }, [activeView, plannerResidentMounted]);

  React.useLayoutEffect(() => {
    if (
      activeView !== "planner"
      || plannerTransitionGeneration <= 0
      || !plannerDatasetReady
      || plannerBoardIdentity === null
    ) {
      return;
    }
    const evidenceKey = `${plannerTransitionGeneration}:${plannerBoardIdentityKey(plannerBoardIdentity)}`;
    if (emittedPlannerIdentitiesRef.current.has(evidenceKey)) return;
    emittedPlannerIdentitiesRef.current.add(evidenceKey);
    markPlannerSemanticReady(plannerTransitionGeneration, plannerBoardIdentity);
  }, [activeView, plannerBoardIdentity, plannerDatasetReady, plannerTransitionGeneration]);

  const setActiveView = React.useCallback((view: ViewId) => {
    if (activeViewRef.current === view) return;
    if (view === "planner" && !plannerBoardReady) {
      requestPendingPlannerNavigation("push");
      return;
    }
    cancelPendingPlannerNavigation();
    if (isHostedRuntime()) {
      const pathname = pathnameForView(view);
      if (window.location.pathname !== pathname) {
        window.history.pushState(null, "", pathname);
      }
    }
    if (view === "planner") beginPlannerTransition();
    activeViewRef.current = view;
    setViewHistory((history) => [...history.slice(-9), view]);
    setActiveViewInternal(view);
  }, [
    beginPlannerTransition,
    cancelPendingPlannerNavigation,
    plannerBoardReady,
    requestPendingPlannerNavigation,
  ]);

  const goBack = React.useCallback(() => {
    setViewHistory((history) => {
      if (history.length <= 1) return history;
      return history.slice(0, -1);
    });
  }, []);

  React.useEffect(() => {
    const last = viewHistory[viewHistory.length - 1];
    if (last !== undefined && activeView !== last) {
      if (last === "planner" && !plannerBoardReady) {
        requestPendingPlannerNavigation("replace");
        return;
      }
      cancelPendingPlannerNavigation();
      if (last === "planner") beginPlannerTransition();
      activeViewRef.current = last;
      setActiveViewInternal(last);
    }
    if (last !== undefined && isHostedRuntime()) {
      const pathname = pathnameForView(last);
      if (window.location.pathname !== pathname) {
        window.history.replaceState(null, "", pathname);
      }
    }
  }, [
    activeView,
    beginPlannerTransition,
    cancelPendingPlannerNavigation,
    plannerBoardReady,
    requestPendingPlannerNavigation,
    viewHistory,
  ]);

  React.useEffect(() => {
    if (!isHostedRuntime()) return;
    const handlePopState = () => {
      const view = initialViewForPathname(window.location.pathname);
      setViewHistory([view]);
      if (activeViewRef.current === view) {
        if (view !== "planner") cancelPendingPlannerNavigation();
        return;
      }
      if (view === "planner" && !plannerBoardReady) {
        requestPendingPlannerNavigation("none");
        return;
      }
      cancelPendingPlannerNavigation();
      if (view === "planner") beginPlannerTransition();
      activeViewRef.current = view;
      setActiveViewInternal(view);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    beginPlannerTransition,
    cancelPendingPlannerNavigation,
    plannerBoardReady,
    requestPendingPlannerNavigation,
  ]);

  React.useLayoutEffect(() => {
    const intent = settlePlannerNavigation(
      plannerNavigationIntentRef.current,
      plannerBoardReady
    );
    if (intent === null) return;
    if (isHostedRuntime() && intent.history !== "none") {
      const pathname = pathnameForView("planner");
      if (window.location.pathname !== pathname) {
        if (intent.history === "push") window.history.pushState(null, "", pathname);
        else window.history.replaceState(null, "", pathname);
      }
    }
    activeViewRef.current = "planner";
    setViewHistory((history) => [...history.slice(-9), "planner"]);
    setActiveViewInternal("planner");
  }, [plannerBoardReady, plannerNavigationIntentRevision]);

  React.useEffect(() => {
    if (activeView === "planner" && plannerMetadataStatus.status === "waiting") {
      startPlannerMetadataHydration();
    }
  }, [activeView, plannerMetadataStatus.status, startPlannerMetadataHydration]);

  React.useEffect(() => {
    if (!plannerDatasetReady || typeof performance?.mark !== "function") return;
    performance.mark("mep:planner:dataset-ready", {
      detail: { initializeGeneration: initializeGenerationRef.current }
    });
  }, [plannerDatasetReady]);

  const canGoBack = viewHistory.length > 1;

  const cardImageVersions = React.useMemo(
    () => new Map(
      runtime?.app.vault.getFiles().map((file) => [
        file.absolutePath,
        `${file.stat.mtime}:${file.stat.size}`,
      ]) ?? []
    ),
    [runtime, vaultRevision]
  );

  const cardImageResourceKey = React.useCallback(
    (path: string): ImageResourceKey => {
      const imagePath = normalizeImageSource(path);
      return createImageResourceKey(
        imagePath,
        imagePath,
        cardImageVersions.get(imagePath) ?? `source:${imagePath}`,
        "card"
      );
    },
    [cardImageVersions]
  );

  React.useEffect(() => {
    return () => {
      for (const timer of noticeTimerRef.current.values()) {
        window.clearTimeout(timer);
      }
      noticeTimerRef.current.clear();
      imageResourceStoreRef.current.clear();
      databaseImageResourceStoreRef.current.clear();
    };
  }, [databaseImageResourceStoreRef, imageResourceStoreRef]);

  const loadCachedImage = React.useCallback(
    (cacheKey: ImageResourceKey, loader: () => Promise<ImageResource | null>): Promise<ImageResource | null> => {
      return imageResourceStoreRef.current.load(
        cacheKey,
        loader
      );
    },
    [imageResourceStoreRef]
  );

  const loadImage = React.useCallback(async (path: string, keyOverride?: ImageResourceKey): Promise<ImageResource | null> => {
    const imagePath = normalizeImageSource(path);
    if (!imagePath) return null;
    const resource = await loadCachedImage(keyOverride ?? createImageResourceKey(imagePath, imagePath, "filesystem"), async () => {
      if (isDirectImageSource(imagePath)) return decodeImageSource(imagePath);
      try {
        const thumbnailPath = await mepGetThumbnail({ path: imagePath, size: "detail" });
        return await decodeImageSource(thumbnailPath);
      } catch (e) {
        console.warn("Failed to load image", imagePath, e);
        return null;
      }
    });
    return resource;
  }, [loadCachedImage]);

  const loadThumbnailResource = React.useCallback(async (path: string): Promise<ImageResource | null> => {
    const imagePath = normalizeImageSource(path);
    if (!imagePath) return null;
    const resource = await databaseImageResourceStoreRef.current.load(cardImageResourceKey(imagePath), async () => {
      if (isDirectImageSource(imagePath)) return decodeImageSource(imagePath);
      try {
        const thumbPath = await mepGetThumbnail({ path: imagePath, size: "card" });
        return await decodeCardThumbnail(thumbPath);
      } catch (e) {
        console.warn("Thumbnail failed", imagePath, e);
        return null;
      }
    });
    return resource;
  }, [cardImageResourceKey, databaseImageResourceStoreRef]);

  const loadThumbnail = React.useCallback(async (path: string) => {
    return (await loadThumbnailResource(path))?.url ?? null;
  }, [loadThumbnailResource]);

  const getLoadedThumbnail = React.useCallback((path: string): string | undefined => {
    return databaseImageResourceStoreRef.current.get(cardImageResourceKey(path))?.url;
  }, [cardImageResourceKey, databaseImageResourceStoreRef]);

  const markStartup = React.useCallback((phase: string, detail?: string) => {
    const timestamp = new Date().toISOString();
    const line = detail
      ? `[${timestamp}] ${phase}: ${detail}`
      : `[${timestamp}] ${phase}`;
    setStartupPhase(phase);
    setStartupEvents((prev) => [...prev.slice(-39), line]);
    if (detail) {
      console.info("[startup]", phase, detail);
    } else {
      console.info("[startup]", phase);
    }
  }, []);

  React.useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => {
      setStartupElapsedSeconds(Math.max(0, Math.floor((Date.now() - startupStartedAt) / 1000)));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loading, startupStartedAt]);

  const initialize = React.useCallback(async (override?: StandaloneSettings) => {
    initializeGenerationRef.current += 1;
    const initializeGeneration = initializeGenerationRef.current;
    const isCurrentInitialization = () => initializeGeneration === initializeGenerationRef.current;
    plannerMetadataRef.current?.cancel();
    plannerMetadataRef.current = null;
    observedMetadataCompletionRef.current = null;
    plannerMetadataBlockedByVaultRefreshRef.current = false;
    retryVaultRefreshRef.current = null;
    cancelPlannerNavigation(plannerNavigationIntentRef.current);
    resetPlannerRefreshPriority(
      plannerRefreshPriorityRef.current,
      activeViewRef.current === "planner"
    );
    setPlannerNavigationIntentRevision((revision) => revision + 1);
    setPlannerBoardIdentity(null);
    setPlannerDatasetFailure(null);
    setPlannerDatasetReady(false);
    setLoading(true);
    setRuntime(null);
    databaseMetadataHydrationGateRef.current.invalidate();
    setStartupError(null);
    setStartupEvents([]);
    setStartupStartedAt(Date.now());
    setStartupElapsedSeconds(0);
    markStartup("Startup sequence started", override ? "using overridden settings" : undefined);
    try {
      markStartup(
        "Runtime detection",
        isHostedRuntime() ? "web host API detected" : "no host API; running unhosted"
      );
      if (!isHostedRuntime()) {
        const absoluteSettingsPath = await getSettingsPath();
        if (!isCurrentInitialization()) return;
        markStartup("Settings read target", `${absoluteSettingsPath} (absolute path)`);
      }

      markStartup("Loading settings");
      const stored = override ?? (await loadSettings());
      if (!isCurrentInitialization()) return;
      const settings: StandaloneSettings = { ...DEFAULT_STANDALONE_SETTINGS, ...stored };

      markStartup("Observing standalone storage");
      const finalSettings = await prepareStandaloneStartup(settings);
      if (!isCurrentInitialization()) return;
      const vaultPath = finalSettings.vaultPath;

      markStartup("Creating standalone app");
      const app = await createStandaloneApp(
        vaultPath,
        (file) => {
          if (isCurrentInitialization()) setActiveFile(file);
        },
        { deferInitialRefresh: true }
      );
      if (!isCurrentInitialization()) return;
      if (!isHostedRuntime()) {
        markStartup("Installing web fallback shims");
        installPttFallback(app);
      }

      const deferRecipeMetadata =
        isHostedRuntime() && activeViewRef.current === "database";
      if (!deferRecipeMetadata) {
        markStartup("Hydrating metadata cache from previous session");
        hydrateMetadataCacheFromStorage(app.metadataCache);
      }

      markStartup("Indexing recipes folder");
      const plannerOrderStore = new PlannerOrderStore(app);
      const viewPreload = loadWeeklyOrganiserBoard().catch((error) => {
        console.warn("Failed to preload view modules", error);
      });
      const ledgerPreload = loadLedger();
      const recipeMetadataStartup = app.vault
        .indexFolder(finalSettings.recipesFolder)
        .then(async (folderIndex) => {
          const plannerMetadata = new PlannerMetadataHydration(
            createIndexedMetadataHydrator(
              folderIndex,
              () => app.vault.indexFolder(finalSettings.recipesFolder)
            )
          );
          if (!isCurrentInitialization()) {
            plannerMetadata.cancel();
            return plannerMetadata;
          }
          plannerMetadataRef.current = plannerMetadata;
          if (!deferRecipeMetadata) {
            markStartup("Hydrating current recipe metadata");
            await plannerMetadata.start();
            if (!isCurrentInitialization()) {
              plannerMetadata.cancel();
              return plannerMetadata;
            }
            markPlannerMetadataCompletion();
          }
          return plannerMetadata;
        });
      const [plannerMetadata, , weeklyOrganiserModule] = await Promise.all([
        recipeMetadataStartup,
        plannerOrderStore.load(),
        viewPreload,
        ledgerPreload,
      ]);
      if (!isCurrentInitialization()) {
        plannerMetadata.cancel();
        return;
      }

      markStartup("Loading ledger");
      const ledgerEntries = await ledgerPreload;
      if (!isCurrentInitialization()) {
        plannerMetadata.cancel();
        return;
      }
      const ledger = new LedgerStore(ledgerEntries, async (entries) => saveLedger(entries));
      markStartup("Runtime ready");
      settingsRef.current = finalSettings;
      setRuntime({
        app,
        settings: finalSettings,
        ledger,
        plannerOrderStore,
        plannerMetadata,
        weeklyOrganiserBoard: weeklyOrganiserModule?.WeeklyOrganiserBoard,
      });
      setSettingsRevision((prev) => prev + 1);
      setDatabaseState(initialDatabaseState(finalSettings));

      let vaultRefreshQueued = false;
      let vaultRefreshInFlight: Promise<void> | null = null;
      const queueVaultRefresh = () => {
        if (vaultRefreshQueued) return;
        vaultRefreshQueued = true;
        markStartup("Refreshing vault index in background");
        const refreshVaultIndex = () => {
          if (initializeGeneration !== initializeGenerationRef.current) return;
          retryVaultRefreshRef.current = refreshVaultIndex;
          if (vaultRefreshInFlight !== null) return;
          vaultRefreshInFlight = app.vault
            .refresh()
            .then((hasChanges) => {
              markVaultRefreshOutcome(
                "success",
                initializeGeneration,
                initializeGenerationRef.current
              );
              if (initializeGeneration !== initializeGenerationRef.current) return;
              retryVaultRefreshRef.current = null;
              setPlannerDatasetFailure(null);
              // If refresh changed metadata, the currently rendered board identity predates
              // the full-dataset patch. Clear it and wait for the board's owned patch callback.
              if (hasChanges) setPlannerBoardIdentity(null);
              plannerMetadataBlockedByVaultRefreshRef.current = false;
              observedMetadataCompletionRef.current = plannerMetadata;
              plannerMetadata.completeFromAuthoritativeHydration();
              markPlannerMetadataCompletion();
              setPlannerDatasetReady(true);
              markStartup("Vault refresh complete");
              if (hasChanges) setVaultRevision((prev) => prev + 1);
            })
            .catch((error) => {
              markVaultRefreshOutcome(
                "failure",
                initializeGeneration,
                initializeGenerationRef.current
              );
              if (initializeGeneration !== initializeGenerationRef.current) return;
              const detail = formatErrorMessage(error);
              setPlannerDatasetFailure(detail);
              const pending = plannerNavigationIntentRef.current.pending;
              if (pending !== null) {
                failPlannerNavigation(plannerNavigationIntentRef.current, detail);
                setPlannerNavigationIntentRevision((revision) => revision + 1);
                if (typeof performance?.mark === "function") {
                  performance.mark("mep:planner:navigation-failed", {
                    detail: { generation: pending.generation, message: detail }
                  });
                }
              }
              markStartup("Vault refresh failed", detail);
              console.warn("Initial vault refresh failed", error);
            })
            .finally(() => {
              vaultRefreshInFlight = null;
            });
        };
        // Keep Database startup foreground work uncontended, but let explicit Planner
        // intent promote the already-owned refresh immediately during the press.
        const startVaultRefresh = registerPlannerRefreshStart(
          plannerRefreshPriorityRef.current,
          refreshVaultIndex
        );
        if (!plannerRefreshPriorityRef.current.prioritized) {
          if (typeof window.requestIdleCallback === "function") {
            window.requestIdleCallback(startVaultRefresh, { timeout: 2000 });
          } else {
            window.setTimeout(startVaultRefresh, 300);
          }
        }
      };
      if (deferRecipeMetadata) {
        plannerMetadataBlockedByVaultRefreshRef.current = true;
      }
      queueVaultRefresh();
    } catch (error) {
      if (!isCurrentInitialization()) return;
      (plannerMetadataRef.current as PlannerMetadataHydration | null)?.cancel();
      plannerMetadataRef.current = null;
      const detail = formatErrorMessage(error);
      setStartupError(detail);
      markStartup("Startup failed", detail);
      console.error("Failed to initialize app", error);
      throw error;
    } finally {
      if (isCurrentInitialization()) setLoading(false);
    }
  }, [markStartup]);

  React.useEffect(() => {
    void initialize().catch(() => undefined);
  }, [initialize]);

  React.useEffect(
    () => () => {
      initializeGenerationRef.current += 1;
      resetPlannerRefreshPriority(plannerRefreshPriorityRef.current);
      cancelPlannerNavigation(plannerNavigationIntentRef.current);
      (plannerMetadataRef.current as PlannerMetadataHydration | null)?.cancel();
      plannerMetadataRef.current = null;
      clearPreviewLoadingTimer();
      clearPersistedContentFlushTimer();
      try {
        flushPersistedContentCache();
      } catch (error) {
        console.warn("Failed flushing persisted content cache on shutdown", error);
      }
    },
    [clearPersistedContentFlushTimer, clearPreviewLoadingTimer, flushPersistedContentCache]
  );

  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(CONTENT_CACHE_STORAGE_KEY);
      if (!raw) {
        persistedContentCacheRef.current = {};
        return;
      }

      const parsed = JSON.parse(raw) as PersistedContentCache;
      if (!parsed || typeof parsed !== "object") {
        persistedContentCacheRef.current = {};
        return;
      }

      const fileByPath = new Map(
        currentRuntime.app.vault.getMarkdownFiles().map((file) => [file.path, file] as const)
      );
      const hydrated: PersistedContentCache = {};
      for (const [path, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object") continue;
        const file = fileByPath.get(path);
        if (!file) continue;
        if (typeof entry.content !== "string") continue;
        if (typeof entry.mtime !== "number") continue;
        if (entry.mtime !== file.stat.mtime) continue;

        hydrated[path] = {
          mtime: entry.mtime,
          content: entry.content,
          lastUsed: typeof entry.lastUsed === "number" ? entry.lastUsed : Date.now()
        };
        fileContentCacheRef.current.set(path, entry.content);
        prewarmedContentVersionRef.current.set(path, entry.mtime);
      }

      persistedContentCacheRef.current = hydrated;
      if (Object.keys(hydrated).length !== Object.keys(parsed).length) {
        persistedContentCacheDirtyRef.current = true;
        schedulePersistedContentFlush();
      }
    } catch (error) {
      console.warn("Failed hydrating persisted content cache", error);
      persistedContentCacheRef.current = {};
    }
  }, [runtime, schedulePersistedContentFlush]);

  // Mirrors metadataCache's frontmatter+tags to localStorage for normal startup seeding. The seed
  // is never readiness authority: current Markdown hydration still completes before Planner mounts,
  // and direct database startup skips the seed until its completion-gated hydration runs.
  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || typeof window === "undefined") return;
    const metadataCache = currentRuntime.app.metadataCache;
    let dirty = false;
    let timer: number | undefined;

    const flush = () => {
      if (!dirty) return;
      dirty = false;
      try {
        const snapshot = metadataCache.snapshot();
        if (Object.keys(snapshot).length > METADATA_CACHE_MAX_ENTRIES) return;
        window.localStorage.setItem(METADATA_CACHE_STORAGE_KEY, JSON.stringify(snapshot));
      } catch (error) {
        console.warn("Failed persisting metadata cache", error);
      }
    };
    const scheduleFlush = () => {
      dirty = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, 500);
    };

    const ref = metadataCache.on("changed", scheduleFlush);
    return () => {
      window.clearTimeout(timer);
      flush();
      metadataCache.offref(ref);
    };
  }, [runtime]);

  // react-doctor-disable-next-line effect-needs-cleanup
  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || !activeFile) {
      setActiveContent("");
      return;
    }
    const app = currentRuntime.app;
    const activePath = activeFile.path;
    let cancelled = false;
    let readToken = 0;

    const syncActiveContent = () => {
      const token = ++readToken;
      const latest = app.vault.getAbstractFileByPath(activePath);
      const fileToRead =
        latest instanceof TFile ? latest : activeFile;

      app.vault
        .read(fileToRead)
        .then((content) => {
          if (cancelled || token !== readToken) return;
          rememberFileContent(fileToRead, content);
          setActiveContent((prev) => (prev === content ? prev : content));
        })
        .catch(() => {
          if (cancelled || token !== readToken) return;
          setActiveContent((prev) =>
            prev === FAILED_LOAD_MESSAGE ? prev : FAILED_LOAD_MESSAGE
          );
        });
    };

    const handleVaultModify = (file: TAbstractFile) => {
      if (resolveEventPath(file) !== activePath) return;
      syncActiveContent();
    };

    const handleMetadataChanged = (changed: TAbstractFile | string) => {
      if (resolveEventPath(changed) !== activePath) return;
      syncActiveContent();
    };

    syncActiveContent();

    const modifyRef = app.vault.on("modify", handleVaultModify);
    const metadataRef = app.metadataCache.on("changed", handleMetadataChanged);

    return () => {
      cancelled = true;
      app.vault.offref(modifyRef);
      app.metadataCache.offref(metadataRef);
    };
  }, [rememberFileContent, runtime, activeFile]);

  // react-doctor-disable-next-line effect-needs-cleanup
  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || !previewFile) {
      setPreviewContent("");
      setIsPreviewContentLoading(false);
      return;
    }
    const app = currentRuntime.app;
    const previewPath = previewFile.path;
    let cancelled = false;
    let readToken = 0;

    const syncPreviewContent = () => {
      const token = ++readToken;
      const latest = app.vault.getAbstractFileByPath(previewPath);
      const fileToRead =
        latest instanceof TFile
          ? latest
          : previewFile;

      app.vault
        .read(fileToRead)
        .then((content) => {
          if (cancelled || token !== readToken) return;
          rememberFileContent(fileToRead, content);
          setPreviewContent((prev) => (prev === content ? prev : content));
          setIsPreviewContentLoading(false);
        })
        .catch(() => {
          if (cancelled || token !== readToken) return;
          setPreviewContent((prev) =>
            prev === FAILED_LOAD_MESSAGE ? prev : FAILED_LOAD_MESSAGE
          );
          setIsPreviewContentLoading(false);
        });
    };

    const handleVaultModify = (file: TAbstractFile) => {
      if (resolveEventPath(file) !== previewPath) return;
      syncPreviewContent();
    };

    const handleMetadataChanged = (changed: TAbstractFile | string) => {
      if (resolveEventPath(changed) !== previewPath) return;
      syncPreviewContent();
    };

    syncPreviewContent();

    const modifyRef = app.vault.on("modify", handleVaultModify);
    const metadataRef = app.metadataCache.on("changed", handleMetadataChanged);

    return () => {
      cancelled = true;
      app.vault.offref(modifyRef);
      app.metadataCache.offref(metadataRef);
    };
  }, [rememberFileContent, runtime, previewFile]);

  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || databaseImagesArePriming) return;
    const app = currentRuntime.app;
    const adapter = app.vault.adapter;
    if (!adapter?.append) return;
    const configDir = app.vault.configDir ?? ".mep";
    const logFile = normalizePath(`${configDir}/diagnostics.log`);
    const log = (message: string, data?: Record<string, unknown>) => {
      const payload = {
        message,
        data: data ?? null,
        timestamp: new Date().toISOString()
      };
      adapter
        .mkdir?.(configDir)
        .then(() => adapter.append!(logFile, `${JSON.stringify(payload)}\n`))
        .catch((error) => console.warn("Failed to write diagnostics log", error));
    };
    setDiagnostics({
      logFile,
      log,
      nativeGuard: {
        begin: () => log("native_guard_begin"),
        success: () => log("native_guard_success"),
        fail: (reason) => log("native_guard_fail", { reason })
      }
    });
    return () => setDiagnostics({ logFile: null, log: () => undefined });
  }, [databaseImagesArePriming, runtime]);

  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string }>).detail;
      const id = Math.random().toString(36).slice(2);
      setNotices((prev) => [...prev, { id, message: detail.message }]);
      const timer = window.setTimeout(() => {
        noticeTimerRef.current.delete(timer);
        setNotices((prev) => prev.filter((note) => note.id !== id));
      }, 4000);
      noticeTimerRef.current.add(timer);
    };
    window.addEventListener("mep-notice", handler);
    return () => window.removeEventListener("mep-notice", handler);
  }, []);

  React.useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen(true);
        setCommandQuery("");
        setIsHelpOpen(false);
      }
      if (event.key === "?" && !isTextEntryElement(event.target)) {
        event.preventDefault();
        setIsHelpOpen((prev) => !prev);
        setIsCommandOpen(false);
      }
      if (event.key === "Escape") {
        setIsCommandOpen(false);
        setIsHelpOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const watcherLifecycleRef = useLazyRef(() => Promise.resolve());
  const watcherGenerationRef = useLazyRef(() => 0);
  const watcherEstablishedRef = useLazyRef(() => false);

  // react-doctor-disable-next-line effect-needs-cleanup
  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime) return;
    const app = currentRuntime.app;
    let disposed = false;
    let applyingWatchBatch = false;
    let watchBatchChanged = false;
    let watchGeneration = watcherGenerationRef.current;
    let attentionQueued = false;
    let watchChain: Promise<void> = Promise.resolve();
    const markVaultChanged = () => {
      if (disposed) return;
      if (applyingWatchBatch) {
        watchBatchChanged = true;
      } else {
        setVaultRevision((prev) => prev + 1);
      }
    };
    const refreshVault = async (): Promise<boolean> => {
      const changed = await app.vault.refresh(true);
      if (changed) markVaultChanged();
      return changed;
    };
    const reconcileSourceTruth = refreshVault;
    const adoptGeneration = (observed: number) => {
      watchGeneration = advanceVaultWatchGeneration(watchGeneration, observed);
      watcherGenerationRef.current = watchGeneration;
    };
    const refs = [
      app.vault.on("create", ((file: TAbstractFile) => {
        imageResourceStoreRef.current.invalidatePath(file.path);
        if ("absolutePath" in file) imageResourceStoreRef.current.invalidatePath((file as TFile).absolutePath);
        markVaultChanged();
      }) as any),
      app.vault.on("modify", ((file: TAbstractFile) => {
        imageResourceStoreRef.current.invalidatePath(file.path);
        if ("absolutePath" in file) imageResourceStoreRef.current.invalidatePath((file as TFile).absolutePath);
        markVaultChanged();
      }) as any),
      app.vault.on("delete", ((file: TAbstractFile) => {
        fileContentCacheRef.current.delete(file.path);
        imageResourceStoreRef.current.invalidatePath(file.path);
        if ("absolutePath" in file) imageResourceStoreRef.current.invalidatePath((file as TFile).absolutePath);
        markVaultChanged();
      }) as any),
      app.vault.on("rename", ((file: TAbstractFile, oldPath: string) => {
        fileContentCacheRef.current.delete(oldPath);
        imageResourceStoreRef.current.invalidatePath(oldPath);
        imageResourceStoreRef.current.invalidatePath(file.path);
        markVaultChanged();
      }) as any)
    ];
    // No metadataCache "changed" wiring here: every genuine edit path that calls
    // metadataCache.updateFile (direct writes, applyExternalChange) already pairs it with a
    // vault "modify"/"create"/"rename" trigger, which the listeners above already record.
    // The only call sites that update metadataCache WITHOUT a paired vault event are the bulk
    // background reindex passes (refreshFolder/refresh catching up files it hasn't read yet) --
    // reacting to those here re-fires the whole vaultRevision-keyed pipeline (recipe stream +
    // thumbnail scheduling) for cache catch-up that carries no new information for those views.
    const watcherChannel = createChannel<VaultWatchBatch>();
    const shouldRefreshFromWatchEvent = (event: VaultWatchEvent): boolean => {
      if (event.selfAuthored) return false;
      return isRelevantWatchPath(event.path) || isRelevantWatchPath(event.oldPath);
    };
    const queueWatcherStart = (sourceAlreadyReconciled = false) => {
      const started = watcherLifecycleRef.current.then(async () => {
        if (disposed || !settingsRef.current.vaultPath) return;
        watchGeneration = advanceVaultWatchGeneration(
          watchGeneration,
          watcherGenerationRef.current
        );
        const replacement = watcherEstablishedRef.current && !sourceAlreadyReconciled;
        const generation = await startAndReconcileVaultWatcher(
          watchGeneration,
          replacement,
          async (cursor) => {
            const status = await mepWatchVault({
              vaultPath: settingsRef.current.vaultPath,
              generation: cursor,
              onEvent: watcherChannel
            });
            if (status.alive) watcherEstablishedRef.current = true;
            return status;
          },
          reconcileSourceTruth
        );
        adoptGeneration(generation);
      });
      watcherLifecycleRef.current = started.catch(() => undefined);
      return started;
    };
    const recoverWatcher = async () => {
      try {
        await reconcileThenRestartVaultWatcher(
          reconcileSourceTruth,
          () => queueWatcherStart(true)
        );
      } catch (error) {
        console.warn("Failed to recover vault watcher", error);
      }
    };
    watcherChannel.onmessage = (batch) => {
      watchChain = watchChain
        .then(async () => {
          if (disposed) return;
          if (!batch.alive) {
            await recoverWatcher();
            return;
          }
          if (batch.generation <= watchGeneration) return;

          const generationGap = hasVaultWatchGenerationGap(
            watchGeneration,
            batch.generation
          );
          let reconciled = true;
          watchBatchChanged = false;
          if (generationGap) {
            try {
              await reconcileSourceTruth();
            } catch (error) {
              reconciled = false;
              console.warn("Failed to reconcile missed vault changes", error);
            }
          } else {
            applyingWatchBatch = true;
            try {
              await applyVaultWatchBatchEntries(
                batch.events,
                shouldRefreshFromWatchEvent,
                async (event) => {
                  imageResourceStoreRef.current.invalidatePath(event.path);
                  imageResourceStoreRef.current.invalidatePath(event.oldPath ?? "");
                  const watchedFile = app.vault.getAbstractFileByPath(event.path);
                  if (watchedFile && "absolutePath" in watchedFile) {
                    imageResourceStoreRef.current.invalidatePath((watchedFile as TFile).absolutePath);
                  }
                  return app.vault.applyExternalChange(event);
                },
                async () => undefined,
                async (error) => {
                  if (error) {
                    console.warn("Failed applying native vault batch", error);
                  }
                  await reconcileSourceTruth();
                }
              );
            } catch (error) {
              reconciled = false;
              console.warn("Failed to reconcile native vault batch", error);
            } finally {
              applyingWatchBatch = false;
            }
          }
          if (watchBatchChanged && !disposed) {
            setVaultRevision((prev) => prev + 1);
          }
          if (reconciled) {
            adoptGeneration(batch.generation);
          }
        })
        .catch((error) => {
          console.warn("Native vault watcher processing failed", error);
        });
    };
    const hasPushWatcher = isHostedRuntime();
    if (hasPushWatcher && settingsRef.current.vaultPath) {
      void queueWatcherStart().catch((error) => {
        console.warn("Failed to start vault watcher", error);
      });
    }
    const reconcileOnAttention = () => {
      if (disposed || document.visibilityState === "hidden" || attentionQueued) return;
      attentionQueued = true;
      watchChain = watchChain
        .then(async () => {
          if (disposed) return;
          if (!hasPushWatcher) {
            await refreshVault();
            return;
          }
          const status = await mepVaultChangesSince({ generation: watchGeneration });
          const action = vaultWatchAction(watchGeneration, status);
          if (action === "none") return;
          if (action === "recover") {
            await recoverWatcher();
            return;
          }
          await reconcileSourceTruth();
          adoptGeneration(status.generation);
        })
        .catch((error) => {
          console.warn("Failed to reconcile vault on attention", error);
        })
        .finally(() => {
          attentionQueued = false;
        });
    };
    window.addEventListener("focus", reconcileOnAttention);
    document.addEventListener("visibilitychange", reconcileOnAttention);
    return () => {
      disposed = true;
      refs.forEach((ref) => app.vault.offref(ref));
      window.removeEventListener("focus", reconcileOnAttention);
      document.removeEventListener("visibilitychange", reconcileOnAttention);
      if (hasPushWatcher) {
        watcherLifecycleRef.current = watcherLifecycleRef.current
          .then(() => mepUnwatchVault())
          .catch((error) =>
            console.warn("Failed to stop vault watcher", error)
          );
      }
    };
  }, [imageResourceStoreRef, runtime, settingsRevision, watcherEstablishedRef, watcherGenerationRef, watcherLifecycleRef]);

  const updateSettings = React.useCallback(async (updates: Partial<StandaloneSettings>) => {
    const currentRuntime = runtime;
    if (!currentRuntime) return;
    const previous = settingsRef.current;
    const next = { ...previous, ...updates };
    let normalizedNext = next;
    try {
      const vaultPath = await ensureVaultStructure(next);
      normalizedNext = { ...next, vaultPath };
      if (updates.vaultPath && updates.vaultPath !== vaultPath) {
        new Notice(`Selected folder is outside ~/vault; using ${vaultPath} instead.`);
      }
    } catch (error) {
      console.error("Failed to ensure vault structure", error);
      new Notice("Failed to update vault folders. Check logs for details.");
      return;
    }
    const vaultChanged = updates.vaultPath !== undefined && normalizedNext.vaultPath !== previous.vaultPath;
    if (!vaultChanged) {
      Object.assign(settingsRef.current, normalizedNext);
      setSettingsRevision((prev) => prev + 1);
    }
    try {
      await saveSettings(normalizedNext);
    } catch (error) {
      console.error("Failed to save settings", error);
      new Notice("Failed to save settings. Check logs for details.");
    }
    if (vaultChanged) {
      try {
        await initialize(normalizedNext);
      } catch (error) {
        console.error("Failed to switch vault", error);
        new Notice("Failed to switch vault. Reverting to previous path.");
        settingsRef.current = previous;
        setSettingsRevision((prev) => prev + 1);
      }
    }
  }, [initialize, runtime]);

  const selectVault = async () => {
    try {
      if (isHostedRuntime()) {
        new Notice("Vault selection is managed by the host server.");
        return;
      }
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await updateSettings({ vaultPath: selected });
      }
    } catch (error) {
      console.error("Failed to select vault", error);
      new Notice("Failed to select vault folder.");
    }
  };

  const recipeIndex = React.useMemo(() => {
    if (!runtime) return null;
    return new RecipeIndexService(runtime.app, () => settingsRef.current);
  }, [runtime]);
  const healthService = React.useMemo(() => {
    if (!runtime) return null;
    return new HealthService(() => runtime.ledger.serialize());
  }, [runtime]);
  React.useEffect(() => {
    if (window.parent === window || loading || !runtime || !recipeIndex || !healthService || embeddedReadyNotifiedRef.current) return;
    let cancelled = false;
    let presentationFrame: number | null = null;
    const commitFrame = window.requestAnimationFrame(() => {
      presentationFrame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        embeddedReadyNotifiedRef.current = true;
        notifyEmbeddedReady();
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(commitFrame);
      if (presentationFrame !== null) window.cancelAnimationFrame(presentationFrame);
    };
  }, [healthService, loading, recipeIndex, runtime]);
  const healthSnapshot = React.useMemo(
    () => healthService?.getSnapshot() ?? null,
    [healthService, healthRevision]
  );
  const shoppingService = React.useMemo(() => {
    if (!runtime) return null;
    return new BuiltInShoppingListService(runtime.app);
  }, [runtime]);

  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || !recipeIndex) return;
    if (recipeIndexRevisionRef.current !== vaultRevision) {
      recipeIndex.markDirty();
      recipeIndexRevisionRef.current = vaultRevision;
    }
    const query: RecipeDatabaseQuery = {
      sortBy: databaseState.sort,
      recipesFolder: settingsRef.current.recipesFolder,
      filter: {
        marked: resolveMarkedFilter(databaseState.marked),
        scheduled: resolveScheduledFilter(databaseState.scheduled),
        tags: databaseState.tags.length > 0 ? databaseState.tags : undefined,
        addedAfter: resolveAddedAfter(databaseState.added)
      },
      search: databaseState.search,
      limit: Math.min(settingsRef.current.databaseMaxCards, DATABASE_IMAGE_PRELOAD_LIMIT)
    };
    const queryKey = JSON.stringify(query);
    databaseQueryKeyRef.current = queryKey;
    const vaultRevisionChanged =
      databaseVaultRevisionRef.current !== null && databaseVaultRevisionRef.current !== vaultRevision;
    databaseVaultRevisionRef.current = vaultRevision;
    const databaseViewWasStale = databaseViewStaleRef.current.has(queryKey);
    const cachedView = databaseViewCacheRef.current.get(queryKey);
    if (cachedView && activeView === "database") {
      setDatabaseView(cachedView);
    }

    if (activeView !== "database") {
      databaseMetadataHydrationGateRef.current.invalidate();
      if (vaultRevisionChanged) databaseViewStaleRef.current.add(queryKey);
      return;
    }
    if (databaseViewWasStale) {
      databaseViewStaleRef.current.delete(queryKey);
    }

    let cancelled = false;
    const generation = databaseMetadataHydrationGateRef.current.begin(queryKey);

    const onEvent = createChannel<RecipeDatabaseStreamEvent>();
    let accumulatedItems: RecipeDatabaseItem[] = [];
    setDatabaseSourceError(null);
    setDatabaseIsPending(true);

    onEvent.onmessage = (msg) => {
      if (cancelled) return;
      if (msg.event === "started") {
        accumulatedItems = [];
        setDatabaseView((prev) => ({ ...prev, total: msg.data.total }));
      } else if (msg.event === "batch") {
        accumulatedItems.push(...msg.data.items);
      } else if (msg.event === "done") {
        const nextView = {
          items: [...accumulatedItems].sort((left, right) =>
            compareRecipeDatabaseItems(left, right, query.sortBy ?? "added-desc")
          ),
          total: msg.data.totalCount,
          markedCount: msg.data.markedCount,
          availableTags: msg.data.availableTags
        };
        databaseViewCacheRef.current.set(queryKey, nextView);
        setDatabaseView(nextView);
        setDatabaseSourceError(null);
        setDatabaseIsPending(false);
        if (databaseMetadataHydrationGateRef.current.completeSource(generation, nextView.items)) {
          startPlannerMetadataHydration();
        }
        if (databaseViewCacheRef.current.size > 20) {
          const firstKey = databaseViewCacheRef.current.keys().next().value as string | undefined;
          if (firstKey) databaseViewCacheRef.current.delete(firstKey);
        }
      }
    };

    mepRecipeDatabaseStream({
      vaultPath: settingsRef.current.vaultPath || undefined,
      query,
      onEvent
    }).catch((error) => {
      if (isHostedRuntime()) {
        console.error("Failed to stream recipe database", error);
      } else {
        console.info("Using local recipe database fallback in browser mode");
      }
      if (!cancelled) {
        if (!isHostedRuntime()) {
          const fallbackView = recipeIndex.queryRecipes(query);
          databaseViewCacheRef.current.set(queryKey, fallbackView);
          setDatabaseView(fallbackView);
          setDatabaseSourceError(null);
          if (databaseMetadataHydrationGateRef.current.completeSource(generation, fallbackView.items)) {
            startPlannerMetadataHydration();
          }
        } else {
          setDatabaseSourceError(formatErrorMessage(error));
          if (databaseMetadataHydrationGateRef.current.failSource(generation)) {
            startPlannerMetadataHydration();
          }
        }
        setDatabaseIsPending(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    databaseMetadataHydrationGateRef,
    databaseState,
    recipeIndex,
    runtime,
    settingsRevision,
    startPlannerMetadataHydration,
    vaultRevision
  ]);

  const commandActions = React.useMemo(
    () => [
      { id: "planner", label: "Go to Planner", action: () => setActiveView("planner") },
      { id: "database", label: "Go to Recipe Database", action: () => setActiveView("database") },
      { id: "shopping", label: "Open Shopping List", action: () => setActiveView("shopping") },
      { id: "health", label: "Go to Cooking Health", action: () => setActiveView("health") },
      { id: "settings", label: "Open Settings", action: () => setActiveView("settings") },
      { id: "help", label: "Open Help Overlay", action: () => setIsHelpOpen(true) }
    ],
    []
  );

  const filteredCommands = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return commandActions;
    return commandActions.filter((action) => action.label.toLowerCase().includes(query));
  }, [commandActions, commandQuery]);

  const refreshShoppingList = React.useCallback(async () => {
    setShoppingBusy(true);
    try {
      setShoppingList(await mepShoppingList());
      setShoppingError(null);
    } catch (error) {
      setShoppingError(formatErrorMessage(error));
    } finally {
      setShoppingBusy(false);
    }
  }, []);

  const handleCopyShoppingLink = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shoppingShareUrl(window.location.origin));
      new Notice("Shopping list link copied.");
    } catch (error) {
      console.error("Failed to copy shopping list link", error);
      new Notice("Could not copy the shopping list link.");
    }
  }, []);

  const recoverShoppingListAfterError = React.useCallback(async (error: unknown) => {
    const message = formatErrorMessage(error);
    try {
      setShoppingList(await mepShoppingList());
      setShoppingPlan(null);
    } catch {
      // Keep the mutation error as the actionable message.
    }
    setShoppingError(message);
  }, []);

  React.useEffect(() => {
    if (activeView === "shopping" && shoppingList === null) {
      void refreshShoppingList();
    }
  }, [activeView, refreshShoppingList, shoppingList]);

  const handleSendShoppingList = React.useCallback(
    (payload: { recipePaths: string[]; weekLabel: string }) => {
      if (!shoppingService) return;
      setShoppingBusy(true);
      setShoppingError(null);
      void shoppingService
        .previewWeek(payload)
        .then((plan) => {
          setShoppingPlan(plan);
          setActiveView("shopping");
        })
        .catch((error) => {
          setShoppingError(formatErrorMessage(error));
          setActiveView("shopping");
        })
        .finally(() => setShoppingBusy(false));
    },
    [shoppingService]
  );

  const handleApplyShoppingList = React.useCallback(() => {
    if (!shoppingPlan) return;
    setShoppingBusy(true);
    setShoppingError(null);
    void mepShoppingApply({
      expectedRevision: shoppingPlan.baseRevision,
      weekLabel: shoppingPlan.weekLabel,
      desiredItems: shoppingPlan.items.map(({ content, labels, sources }) => ({
        content,
        labels,
        sources
      }))
    })
      .then((list) => {
        setShoppingList(list);
        setShoppingPlan(null);
      })
      .catch((error) => void recoverShoppingListAfterError(error))
      .finally(() => setShoppingBusy(false));
  }, [recoverShoppingListAfterError, shoppingPlan]);

  const handleCheckShoppingItem = React.useCallback(
    (itemId: string, checked: boolean) => {
      if (!shoppingList) return;
      setShoppingBusy(true);
      setShoppingError(null);
      void checkShoppingItem({
        list: shoppingList,
        itemId,
        checked,
        publish: setShoppingList,
        persist: mepShoppingCheck
      })
        .catch(recoverShoppingListAfterError)
        .finally(() => setShoppingBusy(false));
    },
    [recoverShoppingListAfterError, shoppingList]
  );

  const handleAddShoppingItem = React.useCallback(
    async (content: string, labels: string[]) => {
      // Guarding matches the other mutations: adding against an unloaded list would
      // send revision 0 and be rejected as stale.
      if (!shoppingList) return;
      setShoppingBusy(true);
      setShoppingError(null);
      try {
        setShoppingList(
          await mepShoppingAdd({ expectedRevision: shoppingList.revision, content, labels })
        );
      } catch (error) {
        await recoverShoppingListAfterError(error);
        // Rethrow so the composer keeps the typed text for correction.
        throw error;
      } finally {
        setShoppingBusy(false);
      }
    },
    [recoverShoppingListAfterError, shoppingList]
  );

  const handleRemoveShoppingItem = React.useCallback(
    (itemId: string) => {
      if (!shoppingList) return;
      setShoppingBusy(true);
      setShoppingError(null);
      void mepShoppingRemove({ expectedRevision: shoppingList.revision, itemId })
        .then(setShoppingList)
        .catch((error) => void recoverShoppingListAfterError(error))
        .finally(() => setShoppingBusy(false));
    },
    [recoverShoppingListAfterError, shoppingList]
  );

  const handleRollbackShoppingList = React.useCallback(() => {
    if (!shoppingList) return;
    setShoppingBusy(true);
    setShoppingError(null);
    void mepShoppingRollback({ expectedRevision: shoppingList.revision })
      .then(setShoppingList)
      .catch((error) => void recoverShoppingListAfterError(error))
      .finally(() => setShoppingBusy(false));
  }, [recoverShoppingListAfterError, shoppingList]);

  const handleSaveDayNote = React.useCallback(
    async (date: string, note: string) => {
      const dayNotes = { ...settingsRef.current.dayNotes };
      if (note) {
        dayNotes[date] = note;
      } else {
        delete dayNotes[date];
      }
      await updateSettings({ dayNotes });
    },
    [updateSettings]
  );

  const handleSaveMarkedWidth = React.useCallback(
    async (width: number) =>
      updateSettings({
        weeklyOrganiserMarkedWidth: normalizeWeeklyColumnMinWidth(width)
      }),
    [updateSettings]
  );

  const handleDatabaseStateChange = React.useCallback((state: DatabaseState) => {
    setDatabaseState(state);
  }, []);

  const handleOpenPlanner = React.useCallback(() => {
    setActiveView("planner");
  }, [setActiveView]);

  const handleHealthRefresh = React.useCallback(() => {
    setHealthRevision((prev) => prev + 1);
  }, []);

  const handleToggleMarked = React.useCallback(
    async (path: string, marked: boolean) => {
      if (!recipeIndex || !runtime) {
        return;
      }

      const file = runtime.app.vault.getAbstractFileByPath(path);

      const applyMarkedToCurrentView = (prev: RecipeDatabaseView, nextMarked: boolean) => {
        const queryKey = databaseQueryKeyRef.current;
        if (queryKey) databaseViewCacheRef.current.set(queryKey, prev);
        projectMarkedInDatabaseViews(databaseViewCacheRef.current, path, nextMarked);
        return queryKey ? databaseViewCacheRef.current.get(queryKey) ?? prev : prev;
      };

      setDatabaseView((prev) => {
        const nextView = applyMarkedToCurrentView(prev, marked);
        const queryKey = databaseQueryKeyRef.current;
        if (queryKey) {
          databaseViewCacheRef.current.set(queryKey, nextView);
        }
        return nextView;
      });

      try {
        await recipeIndex.setMarked(path, marked);
      } catch (error) {
        setDatabaseView((prev) => {
          const nextView = applyMarkedToCurrentView(prev, !marked);
          const queryKey = databaseQueryKeyRef.current;
          if (queryKey) {
            databaseViewCacheRef.current.set(queryKey, nextView);
          }
          return nextView;
        });
        throw error;
      }

      recipeIndex.markDirty();

      if (file instanceof TFile) {
        try {
          const content = await runtime.app.vault.read(file);
          runtime.app.metadataCache.updateFile(file, content);
        } catch (err) {
          console.warn("Failed to update metadata cache after marking", err);
        }
      }
    },
    [recipeIndex, runtime]
  );

  const handlePlannerUnmark = React.useCallback(
    (path: string) => handleToggleMarked(path, false),
    [handleToggleMarked]
  );

  const handleClearMarked = React.useCallback(async () => {
    if (!recipeIndex || !runtime) return;

    try {
      let markedItems: RecipeDatabaseItem[] = [];
      if (!isHostedRuntime()) {
        await recipeIndex.clearAllMarked();
      } else {
        const onEvent = createChannel<RecipeDatabaseStreamEvent>();
        onEvent.onmessage = (msg) => {
          if (msg.event === "batch") {
            markedItems.push(...msg.data.items);
          }
        };

        const query: RecipeDatabaseQuery = {
          sortBy: databaseState.sort,
          recipesFolder: settingsRef.current.recipesFolder,
          filter: { marked: true }
        };
        await mepRecipeDatabaseStream({
          vaultPath: settingsRef.current.vaultPath || undefined,
          query,
          onEvent
        });

        await Promise.all(markedItems.map((item) => recipeIndex.setMarked(item.path, false)));
      }

      recipeIndex.markDirty();
      const knownMarkedPaths = new Set<string>();
      for (const view of databaseViewCacheRef.current.values()) {
        for (const item of view.items) {
          if (item.marked) knownMarkedPaths.add(item.path);
        }
      }
      for (const path of knownMarkedPaths) {
        projectMarkedInDatabaseViews(databaseViewCacheRef.current, path, false);
      }
      setDatabaseView((prev) => {
        const queryKey = databaseQueryKeyRef.current;
        if (!queryKey) return prev;
        const next = databaseViewCacheRef.current.get(queryKey);
        return next ?? prev;
      });
    } catch (error) {
      console.error("Failed to clear marked items", error);
      new Notice("Failed to clear all marked items. The view will resync.");
    } finally {
      setVaultRevision((prev) => prev + 1);
    }
  }, [databaseState.sort, recipeIndex, runtime]);

  const resolveDatabaseCover = React.useCallback(
    (coverPath: string | null, sourcePath: string): string | null => {
      if (!runtime || !coverPath) return null;
      const app = runtime.app;
      return resolveDatabaseCoverPath(coverPath, sourcePath, {
        imagesFolder: settingsRef.current.imagesFolder,
        recipesFolder: settingsRef.current.recipesFolder,
        findAbsolutePath: (path) => {
          const file = app.vault.getAbstractFileByPath(path);
          return file && "absolutePath" in file ? (file as TFile).absolutePath : null;
        },
        resolveLinkpath: (linkpath, normalizedSourcePath) => {
          const resolved = app.metadataCache.getFirstLinkpathDest(linkpath, normalizedSourcePath);
          return resolved && "absolutePath" in resolved ? (resolved as TFile).absolutePath : null;
        }
      });
    },
    [runtime]
  );

  const recipeImageResourceKey = React.useCallback(
    (imagePath: string, sourcePath: string): ImageResourceKey | null => {
      const trimmed = imagePath.trim();
      if (!trimmed) return null;
      const sourceFile = runtime?.app.vault.getAbstractFileByPath(sourcePath);
      const sourceStats = sourceFile && "stat" in sourceFile ? (sourceFile as TFile).stat : null;
      const sourceVersion = sourceStats ? `${sourceStats.mtime}:${sourceStats.size}` : "source";
      if (/^(https?:|data:|blob:|file:|asset:|app:|obsidian:)/i.test(trimmed)) {
        return createImageResourceKey(sourcePath, trimmed, `${sourceVersion}|direct:${trimmed}`);
      }
      const absolutePath = resolveDatabaseCover(trimmed, sourcePath);
      if (!absolutePath) return null;
      const imageFile = runtime?.app.vault.getFiles().find((file) => file.absolutePath === absolutePath);
      const imageVersion = imageFile ? `${imageFile.stat.mtime}:${imageFile.stat.size}` : "image";
      return createImageResourceKey(sourcePath, absolutePath, `${sourceVersion}|${imageVersion}`, "detail");
    },
    [resolveDatabaseCover, runtime]
  );

  const resolveRecipeImageResource = React.useCallback(
    (imagePath: string, sourcePath: string): Promise<ImageResource | null> => {
      const key = recipeImageResourceKey(imagePath, sourcePath);
      return key ? loadImage(key.resolvedPath, key) : Promise.resolve(null);
    },
    [loadImage, recipeImageResourceKey]
  );

  const getDatabaseCoverState = React.useCallback((coverPath: string | null): DatabaseCoverState => {
    if (!coverPath) return NO_COVER_STATE;
    return databaseImageResourceStoreRef.current.getState(cardImageResourceKey(coverPath)) ?? PENDING_COVER_STATE;
  }, [cardImageResourceKey, databaseImageResourceStoreRef]);

  // Request thumbnails for the current filtered/sorted view in two stages: first the
  // first-row/overscan items so cards appear immediately, then the remainder. Each stage
  // hands its batch to the store's own concurrency-limited decode queue and nothing here
  // waits for decode to finish -- each card reveals independently the moment its own key
  // settles in the store (see getDatabaseCoverState above and the CookingDatabase
  // subscription).
  React.useEffect(() => {
    const items = databaseView.items;
    const queryKey = databaseQueryKeyRef.current;
    if (!runtime || items.length === 0 || queryKey === null) {
      if (items.length === 0) databaseCoverRequestKeyRef.current = null;
      return;
    }
    const requestKey = [vaultRevision, ...items.map((item) => {
      const coverPath = resolveDatabaseCover(item.coverPath, item.path);
      return [
        item.path,
        item.coverPath ?? "",
        coverPath ?? "",
        coverPath ? cardImageResourceKey(coverPath).version : "none",
      ].join("\u0001");
    })].join("\u0000");
    const coversAlreadyScheduled = databaseCoverRequestKeyRef.current === requestKey;
    const metadataTrancheRequired = databaseMetadataHydrationGateRef.current
      .isAwaitingFirstTranche(queryKey, items);
    if (coversAlreadyScheduled) {
      if (
        metadataTrancheRequired &&
        databaseMetadataHydrationGateRef.current.completeFirstTrancheScheduling(queryKey, items)
      ) {
        startPlannerMetadataHydration();
      }
      return;
    }
    databaseCoverRequestKeyRef.current = requestKey;
    let cancelled = false;
    let fullyScheduled = false;
    let firstTrancheFinished = false;

    // Split unique cover paths into first-row/overscan batch (first 5 items in sorted view)
    // and remainder, preserving first-occurrence order within each batch.
    const VIEWPORT_BATCH = 5;
    const { firstBatch, restBatch } = splitViewportPaths(
      items,
      VIEWPORT_BATCH,
      (item) => resolveDatabaseCover(item.coverPath, item.path)
    );

    void (async () => {
      // --- Stage 1: first visible row ---
      const firstLocalPaths = firstBatch.filter((coverPath) => !isDirectImageSource(coverPath));
      let firstThumbnailPaths: Array<string | null> = [];
      if (firstLocalPaths.length > 0) {
        firstThumbnailPaths = await mepPrepareDatabaseThumbnails({ paths: firstLocalPaths });
      }
      if (cancelled) return;

      const firstUrls = new Map<string, string | null>();
      for (const coverPath of firstBatch) {
        if (isDirectImageSource(coverPath)) firstUrls.set(coverPath, coverPath);
      }
      firstLocalPaths.forEach((coverPath, index) => {
        const thumbnailPath = firstThumbnailPaths[index];
        firstUrls.set(coverPath, thumbnailPath ? thumbnailPath : null);
      });
      const firstRequests = firstBatch.map((coverPath) => {
        const url = firstUrls.get(coverPath) ?? null;
        return {
          key: cardImageResourceKey(coverPath),
          priority: 0,
          loader: () => url
            ? (isDirectImageSource(coverPath) ? decodeImageSource(url) : decodeCardThumbnail(url))
            : Promise.resolve(null)
        };
      });
      if (firstRequests.length > 0) {
        databaseImageResourceStoreRef.current.schedule(firstRequests);
      }
      firstTrancheFinished = true;
      if (databaseMetadataHydrationGateRef.current.completeFirstTrancheScheduling(queryKey, items)) {
        startPlannerMetadataHydration();
      }

      // --- Stage 2: remainder batch ---
      if (restBatch.length === 0) {
        fullyScheduled = true;
        return;
      }
      const restLocalPaths = restBatch.filter((coverPath) => !isDirectImageSource(coverPath));
      let restThumbnailPaths: Array<string | null> = [];
      if (restLocalPaths.length > 0) {
        restThumbnailPaths = await mepPrepareDatabaseThumbnails({ paths: restLocalPaths });
      }
      if (cancelled) return;

      const restUrls = new Map<string, string | null>();
      for (const coverPath of restBatch) {
        if (isDirectImageSource(coverPath)) restUrls.set(coverPath, coverPath);
      }
      restLocalPaths.forEach((coverPath, index) => {
        const thumbnailPath = restThumbnailPaths[index];
        restUrls.set(coverPath, thumbnailPath ? thumbnailPath : null);
      });
      const restRequests = restBatch.map((coverPath) => {
        const url = restUrls.get(coverPath) ?? null;
        return {
          key: cardImageResourceKey(coverPath),
          priority: 0,
          loader: () => url
            ? (isDirectImageSource(coverPath) ? decodeImageSource(url) : decodeCardThumbnail(url))
            : Promise.resolve(null)
        };
      });
      if (restRequests.length > 0) {
        // Schedule the union so the store retains every key in the current view;
        // already-loaded first-stage items are skipped by the store's internal dedup.
        databaseImageResourceStoreRef.current.schedule([...firstRequests, ...restRequests]);
      }
      fullyScheduled = true;
    })().catch((error) => {
      console.warn("Database thumbnail batch failed", error);
      if (!cancelled && !firstTrancheFinished) {
        if (databaseMetadataHydrationGateRef.current.failFirstTrancheScheduling(queryKey, items)) {
          startPlannerMetadataHydration();
        }
      }
      if (!cancelled) databaseCoverRequestKeyRef.current = null;
    });
    // A dependency churn (e.g. a vaultRevision bump landing while this effect is mid-flight) can
    // re-fire this effect before schedule() above has run, cancelling this instance. If this
    // instance's key is still the one recorded and it never actually reached schedule(), clear the
    // ref rather than leaving it "claimed" -- otherwise a later run with the same requestKey would
    // bail on the guard above and every card's cover would stay pending forever with nothing left
    // to retry it.
    return () => {
      cancelled = true;
      if (!fullyScheduled && databaseCoverRequestKeyRef.current === requestKey) {
        databaseCoverRequestKeyRef.current = null;
      }
    };
  }, [
    cardImageResourceKey,
    databaseImageResourceStoreRef,
    databaseMetadataHydrationGateRef,
    databaseView.items,
    resolveDatabaseCover,
    runtime,
    startPlannerMetadataHydration,
    vaultRevision
  ]);

  // Keeps databaseCoversSettled current for cross-view prewarm throttling only; the Database
  // grid itself never reads this -- it re-renders per-card straight off the store subscription.
  // Tracks a shrinking set of still-pending cover paths rather than rescanning the whole view on
  // every publish, so a large fixture settling doesn't cost O(items) work per individual decode.
  React.useEffect(() => {
    const store = databaseImageResourceStoreRef.current;
    let pendingCoverPaths = databaseView.items
      .map((item) => resolveDatabaseCover(item.coverPath, item.path))
      .filter((coverPath): coverPath is string => Boolean(coverPath));
    const recomputeSettled = () => {
      pendingCoverPaths = pendingCoverPaths.filter(
        (coverPath) => store.getState(cardImageResourceKey(coverPath)) === undefined
      );
      const settled = pendingCoverPaths.length === 0;
      setDatabaseCoverSettlement((previous) =>
        previous?.items === databaseView.items && previous.settled === settled
          ? previous
          : { items: databaseView.items, settled }
      );
    };
    recomputeSettled();
    if (pendingCoverPaths.length === 0) return undefined;
    return store.subscribe(recomputeSettled);
  }, [cardImageResourceKey, databaseImageResourceStoreRef, databaseView.items, resolveDatabaseCover]);

  const getRecipeImageResource = React.useCallback(
    (imagePath: string, sourcePath: string): ImageResource | undefined => {
      const key = recipeImageResourceKey(imagePath, sourcePath);
      return key ? imageResourceStoreRef.current.get(key) : undefined;
    },
    [imageResourceStoreRef, recipeImageResourceKey]
  );

  React.useEffect(() => {
    const currentRuntime = runtime;
    if (!currentRuntime || !detailPrewarmAllowed) return;

    const app = currentRuntime.app;
    const markdownFiles = app.vault.getMarkdownFiles();
    if (markdownFiles.length === 0) return;

    const fileByPath = new Map(markdownFiles.map((file) => [file.path, file] as const));
    const candidateScore = new Map<string, number>();
    const assignCandidate = (file: TFile | null, score: number) => {
      if (!file) return;
      const existingScore = candidateScore.get(file.path);
      if (existingScore === undefined || score < existingScore) {
        candidateScore.set(file.path, score);
      }
    };

    assignCandidate(activeFile, 0);
    assignCandidate(previewFile, 1);

    const byRecentMtime = [...markdownFiles].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const recipeRecent = byRecentMtime
      .filter((file) => isPathInFolder(file.path, settingsRef.current.recipesFolder))
      .slice(0, 48);
    const eventRecent = byRecentMtime
      .filter((file) => isPathInFolder(file.path, settingsRef.current.eventsFolder))
      .slice(0, 32);

    recipeRecent.forEach((file, index) => assignCandidate(file, 10 + index));
    eventRecent.forEach((file, index) => assignCandidate(file, 100 + index));
    byRecentMtime.slice(0, 24).forEach((file, index) => assignCandidate(file, 200 + index));

    const candidates: Array<{ file: TFile; score: number }> = [];
    for (const [path, score] of candidateScore) {
      const file = fileByPath.get(path);
      if (file) candidates.push({ file, score });
    }
    candidates.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return b.file.stat.mtime - a.file.stat.mtime;
    });
    const queue: TFile[] = [];
    for (const { file } of candidates) {
      const warmedVersion = prewarmedContentVersionRef.current.get(file.path);
      if (warmedVersion === file.stat.mtime || prewarmInFlightPathsRef.current.has(file.path)) continue;
      queue.push(file);
      if (queue.length === PREWARM_FILE_LIMIT) break;
    }

    if (queue.length === 0) return;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;
    let cursor = 0;
    let activeWorkers = 0;
    const hasIdleCallback = typeof (window as any).requestIdleCallback === "function";

    const pump = () => {
      if (cancelled) return;
      while (activeWorkers < PREWARM_CONCURRENCY && cursor < queue.length) {
        const file = queue[cursor++];
        if (!file) continue;
        if (prewarmInFlightPathsRef.current.has(file.path)) continue;
        const warmedVersion = prewarmedContentVersionRef.current.get(file.path);
        if (warmedVersion === file.stat.mtime) continue;

        activeWorkers += 1;
        prewarmInFlightPathsRef.current.add(file.path);
        void app.vault
          .read(file)
          .then((content) => {
            if (cancelled || databaseImagePrimingRef.current) return;
            rememberFileContent(file, content);
            prewarmedContentVersionRef.current.set(file.path, file.stat.mtime);
            const imagePaths = extractMarkdownImagePaths(content, PREWARM_IMAGE_LIMIT_PER_FILE);
            for (const imagePath of imagePaths) {
              if (cancelled || databaseImagePrimingRef.current) return;
              void resolveRecipeImageResource(imagePath, file.path);
            }
          })
          .catch(() => {
            // Ignore prewarm failures; user-initiated reads still handle errors.
          })
          .finally(() => {
            prewarmInFlightPathsRef.current.delete(file.path);
            activeWorkers = Math.max(0, activeWorkers - 1);
            if (cancelled) return;
            if (cursor < queue.length) {
              schedulePump();
            }
          });
      }
    };

    const schedulePump = () => {
      if (cancelled) return;
      if (cursor >= queue.length) return;
      if (hasIdleCallback) {
        idleId = (window as any).requestIdleCallback(
          () => {
            idleId = null;
            pump();
          },
          { timeout: 650 }
        );
      } else {
        timeoutId = window.setTimeout(() => {
          timeoutId = null;
          pump();
        }, 70);
      }
    };

    schedulePump();
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (idleId !== null && typeof (window as any).cancelIdleCallback === "function") {
        (window as any).cancelIdleCallback(idleId);
      }
    };
  }, [activeFile, detailPrewarmAllowed, previewFile, rememberFileContent, resolveRecipeImageResource, runtime, settingsRevision]);

  const handleHealthClear = React.useCallback(() => {
    if (!runtime) return;
    runtime.ledger.clear();
    void saveLedger(runtime.ledger.serialize());
    setHealthRevision((prev) => prev + 1);
  }, [runtime]);

  // Preload images when active content changes for faster recipe view rendering
  React.useEffect(() => {
    if (!activeFile || !activeContent) return;
    const imageMatches = activeContent.matchAll(MARKDOWN_IMAGE_RE);
    for (const match of imageMatches) {
      const imgPath = match[1]?.trim();
      if (imgPath) {
        void resolveRecipeImageResource(imgPath, activeFile.path);
      }
    }
  }, [activeContent, activeFile, resolveRecipeImageResource]);

  // Preload images when preview content changes for faster side pane rendering
  React.useEffect(() => {
    if (!previewFile || !previewContent) return;
    const imageMatches = previewContent.matchAll(MARKDOWN_IMAGE_RE);
    for (const match of imageMatches) {
      const imgPath = match[1]?.trim();
      if (imgPath) {
        void resolveRecipeImageResource(imgPath, previewFile.path);
      }
    }
  }, [previewContent, previewFile, resolveRecipeImageResource]);

  const saveActiveFileContent = React.useCallback(
    async (nextContent: string) => {
      if (!runtime || !activeFile) return;
      await runtime.app.vault.modify(activeFile, nextContent);
      rememberFileContent(activeFile, nextContent);
    },
    [activeFile, rememberFileContent, runtime]
  );

  const savePreviewFileContent = React.useCallback(
    async (nextContent: string) => {
      if (!runtime || !previewFile) return;
      await runtime.app.vault.modify(previewFile, nextContent);
      rememberFileContent(previewFile, nextContent);
      setPreviewContent(nextContent);
    },
    [previewFile, rememberFileContent, runtime]
  );

  const openPreviewForFile = React.useCallback(
    (file: TFile, options?: { isRecipe?: boolean }) => {
      if (!runtime) return;
      const requestId = ++previewReadRequestIdRef.current;
      clearPreviewLoadingTimer();
      const cachedContent =
        fileContentCacheRef.current.get(file.path) ??
        (activeFile?.path === file.path ? activeContent : null);
      setPreviewFile(file);
      setPreviewIsRecipe(options?.isRecipe ?? false);
      setPreviewContent(cachedContent ?? "");
      setIsPreviewContentLoading(false);
      setIsPreviewOpen(true);

      if (cachedContent === null) {
        previewLoadingTimerRef.current = window.setTimeout(() => {
          if (previewReadRequestIdRef.current !== requestId) return;
          setIsPreviewContentLoading(true);
        }, 120);
      }

      void runtime.app.vault
        .read(file)
        .then((content) => {
          if (previewReadRequestIdRef.current !== requestId) return;
          clearPreviewLoadingTimer();
          rememberFileContent(file, content);
          setPreviewContent((prev) => (prev === content ? prev : content));
          setIsPreviewContentLoading(false);
          // Start preloading images immediately for faster display
          const imageMatches = content.matchAll(MARKDOWN_IMAGE_RE);
          for (const match of imageMatches) {
            const imgPath = match[1]?.trim();
            if (imgPath) {
              void resolveRecipeImageResource(imgPath, file.path);
            }
          }
        })
        .catch(() => {
          if (previewReadRequestIdRef.current !== requestId) return;
          clearPreviewLoadingTimer();
          setPreviewContent((prev) =>
            prev === FAILED_LOAD_MESSAGE ? prev : FAILED_LOAD_MESSAGE
          );
          setIsPreviewContentLoading(false);
        });
    },
    [
      activeContent,
      activeFile?.path,
      clearPreviewLoadingTimer,
      rememberFileContent,
      resolveRecipeImageResource,
      runtime
    ]
  );

  const handlePreviewResizeStart = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    previewResizeRef.current = {
      startX: event.clientX,
      startWidth: previewWidth,
      currentWidth: previewWidth
    };
    setIsPreviewResizing(true);
  }, [previewWidth]);

  React.useEffect(() => {
    if (!isPreviewResizing) return;

    const minWidth = 320;
    const maxWidth = 760;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const drag = previewResizeRef.current;
      if (!drag) return;
      const diff = drag.startX - moveEvent.clientX;
      const nextWidth = Math.max(minWidth, Math.min(maxWidth, drag.startWidth + diff));
      drag.currentWidth = nextWidth;
      const shell = shellRef.current;
      if (shell) {
        shell.style.setProperty("--mep-preview-width", `${nextWidth}px`);
      }
    };

    const handleMouseUp = () => {
      const drag = previewResizeRef.current;
      if (drag) {
        setPreviewWidth(drag.currentWidth);
      }
      previewResizeRef.current = null;
      setIsPreviewResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isPreviewResizing]);

  const openPathFromCard = React.useCallback(
    (path: string, options: { split: boolean }) => {
      if (!runtime) return;
      const file = runtime.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      const cachedContent = fileContentCacheRef.current.get(file.path) ?? "";

      setActiveContent(cachedContent);
      setActiveFile(file);
      runtime.app.workspace.setActiveFile(file);
      const cache = runtime.app.metadataCache.getFileCache(file);
      const isRecipe =
        hasRecipeType(cache?.frontmatter?.type) ||
        isPathInFolder(file.path, settingsRef.current.recipesFolder);

      if (options.split) {
        openPreviewForFile(file, { isRecipe });
        return;
      }

      previewReadRequestIdRef.current += 1;
      clearPreviewLoadingTimer();
      setPreviewFile(null);
      setPreviewIsRecipe(false);
      setPreviewContent("");
      setIsPreviewContentLoading(false);
      setIsPreviewOpen(false);
      if (isRecipe) {
        setActiveView("recipe");
      }
    },
    [clearPreviewLoadingTimer, openPreviewForFile, runtime]
  );

  const openRecipeFromDatabase = React.useCallback(
    (path: string, split: boolean) => {
      if (!runtime) return;
      const file = runtime.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      const cachedContent = fileContentCacheRef.current.get(file.path) ?? "";

      setActiveContent(cachedContent);
      setActiveFile(file);
      runtime.app.workspace.setActiveFile(file);
      if (split) {
        openPreviewForFile(file, { isRecipe: true });
        return;
      }
      previewReadRequestIdRef.current += 1;
      clearPreviewLoadingTimer();
      setPreviewFile(null);
      setPreviewIsRecipe(false);
      setPreviewContent("");
      setIsPreviewContentLoading(false);
      setIsPreviewOpen(false);
      setActiveView("recipe");
    },
    [clearPreviewLoadingTimer, openPreviewForFile, runtime]
  );

  const retryStartup = () => {
    void initialize().catch(() => undefined);
  };

  const copyStartupDiagnostics = async () => {
    const payload = [
      "Enplace startup diagnostics",
      `timestamp: ${new Date().toISOString()}`,
      `phase: ${startupPhase}`,
      `elapsed_seconds: ${startupElapsedSeconds}`,
      `error: ${startupError ?? "none"}`,
      "events:",
      ...startupEvents
    ].join("\n");

    try {
      await navigator.clipboard.writeText(payload);
      new Notice("Startup diagnostics copied to clipboard.");
    } catch (error) {
      console.error("Failed to copy startup diagnostics", error);
      new Notice("Could not copy diagnostics. See browser console for details.");
    }
  };

  const startupBlocked = !loading && !runtime && Boolean(startupError);
  if (loading || !runtime || !recipeIndex || !healthService) {
    return (
      <div className={"mep-root"}>
        <div className="mep-shell mep-shell--loading">
          <div className={`mep-loading ${startupBlocked ? "mep-loading--error" : ""}`}>
            <div className="mep-loading__title">
              {startupBlocked ? "Startup failed" : "Loading Enplace..."}
            </div>
            <div className="mep-loading__phase">
              {startupPhase}
              {loading ? ` (${startupElapsedSeconds}s)` : ""}
            </div>
            {startupError ? (
              <pre className="mep-loading__error">{startupError}</pre>
            ) : null}
            {startupEvents.length > 0 ? (
              <pre className="mep-loading__trace">{startupEvents.slice(-8).join("\n")}</pre>
            ) : null}
            {startupBlocked ? (
              <div className="mep-loading__actions">
                <button type="button" className="mep-button mep-button--ghost" onClick={retryStartup}>
                  Retry startup
                </button>
                <button type="button" className="mep-button mep-button--ghost" onClick={copyStartupDiagnostics}>
                  Copy diagnostics
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const { app, settings } = runtime;
  const WeeklyOrganiserBoardComponent = runtime.weeklyOrganiserBoard ?? LazyWeeklyOrganiserBoard;
  const usesResidentPanels = plannerResidentMounted
    && (activeView === "planner" || activeView === "database");
  const remoteHost = isHostedRuntime();
  const databaseDisplayItems = databaseView.items;

  return (
    <div className={"mep-root"}>
      <div
        ref={shellRef}
        className={`mep-shell ${isSidebarExpanded ? "mep-shell--sidebar-open" : "mep-shell--sidebar-compact"} ${isPreviewOpen ? "mep-shell--preview-open" : "mep-shell--preview-closed"} ${activeView === "shopping" ? "mep-shell--shopping" : ""}`}
        style={
          isPreviewResizing
            ? undefined
            : ({
                "--mep-preview-width": isPreviewOpen ? `${previewWidth}px` : "0px"
              } as React.CSSProperties)
        }
      >
      <aside className="mep-sidebar">
        <button
          className={`mep-sidebar__back ${canGoBack ? "" : "is-disabled"}`}
          type="button"
          onClick={goBack}
          disabled={!canGoBack}
          title="Go back"
          ref={(el) => {
            if (el) setIcon(el, "arrow-left");
          }}
        />
        <div className="mep-brand">
          <div className="mep-brand__title">Enplace</div>
          <div className="mep-brand__subtitle">Standalone planner</div>
        </div>
        <nav className="mep-nav">
          <button
            type="button"
            className={`mep-nav__item ${activeView === "planner" ? "is-active" : ""}`}
            onPointerDown={(event) => {
              if (event.button === 0) preparePlannerNavigation();
            }}
            onClick={() => setActiveView("planner")}
            title="Planner"
          >
            <span className="mep-nav__icon" aria-hidden="true" ref={(el) => {
              if (el) setIcon(el, "calendar-days");
            }} />
            <span className="mep-nav__label">Planner</span>
          </button>
          <button
            type="button"
            className={`mep-nav__item ${activeView === "database" ? "is-active" : ""}`}
            onClick={() => setActiveView("database")}
            title="Recipe Database"
          >
            <span className="mep-nav__icon" aria-hidden="true" ref={(el) => {
              if (el) setIcon(el, "layout-grid");
            }} />
            <span className="mep-nav__label">Recipe Database</span>
          </button>
          <button
            type="button"
            className={`mep-nav__item ${activeView === "shopping" ? "is-active" : ""}`}
            onClick={() => setActiveView("shopping")}
            title="Shopping List"
          >
            <span className="mep-nav__icon" aria-hidden="true" ref={(el) => {
              if (el) setIcon(el, "shopping-cart");
            }} />
            <span className="mep-nav__label">Shopping List</span>
          </button>
          <button
            type="button"
            className={`mep-nav__item ${activeView === "health" ? "is-active" : ""}`}
            onClick={() => setActiveView("health")}
            title="Cooking Health"
          >
            <span className="mep-nav__icon" aria-hidden="true" ref={(el) => {
              if (el) setIcon(el, "activity");
            }} />
            <span className="mep-nav__label">Cooking Health</span>
          </button>
          <button
            type="button"
            className={`mep-nav__item ${activeView === "settings" ? "is-active" : ""}`}
            onClick={() => setActiveView("settings")}
            title="Settings"
          >
            <span className="mep-nav__icon" aria-hidden="true" ref={(el) => {
              if (el) setIcon(el, "settings");
            }} />
            <span className="mep-nav__label">Settings</span>
          </button>
        </nav>
        <div className="mep-sidebar__footer">
          <button
            className="mep-sidebar__toggle"
            type="button"
            onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
            title={isSidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            ref={(el) => {
              if (el) setIcon(el, isSidebarExpanded ? "chevrons-left" : "chevrons-right");
            }}
          />
          <div className="mep-sidebar__vault-meta">
            <div className="mep-vault-label">Vault</div>
            <div className="mep-vault-path">{settings.vaultPath || "Not set"}</div>
          </div>
          {remoteHost ? (
            <div className="mep-vault-label">Host-managed</div>
          ) : (
            <button type="button" className="mep-button mep-sidebar__vault-button" onClick={selectVault}>
              Choose folder
            </button>
          )}
        </div>
      </aside>

      <main
        className={`mep-main ${usesResidentPanels ? "mep-main--resident-panels" : ""} ${activeView === "planner" && !usesResidentPanels ? "mep-main--planner" : ""} ${activeView === "database" && !usesResidentPanels ? "mep-main--database" : ""} ${activeView === "shopping" ? "mep-main--shopping" : ""}`}
      >
        {pendingPlannerFailure ? (
          <div className="mep-planner-intent-error" role="alert">
            <span>{`Planner data failed to load: ${pendingPlannerFailure}`}</span>
            <button
              type="button"
              className="mep-button mep-button--ghost"
              onClick={retryPendingPlannerNavigation}
            >
              Retry planner data
            </button>
          </div>
        ) : null}

        {activeView === "planner" && (!plannerDatasetReady || plannerMetadataStatus.status !== "ready") && (
          <div
            className="mep-loading"
            data-planner-metadata-status={plannerMetadataStatus.status}
            data-planner-dataset-status={plannerDatasetFailure ? "error" : plannerDatasetReady ? "ready" : "loading"}
            // @ts-expect-error elementtiming is a valid Element Timing API attribute.
            elementtiming={PLANNER_METADATA_PLACEHOLDER_TIMING}
          >
            {plannerDatasetFailure || plannerMetadataStatus.status === "error" ? (
              <>
                <div>{plannerDatasetFailure
                  ? `Planner data failed to load: ${plannerDatasetFailure}`
                  : `Planner metadata failed to load: ${plannerMetadataStatus.status === "error" ? plannerMetadataStatus.message : "Unknown error"}`}</div>
                <button
                  type="button"
                  className="mep-button mep-button--ghost"
                  onClick={plannerDatasetFailure ? retryPendingPlannerNavigation : startPlannerMetadataHydration}
                >
                  Retry planner data
                </button>
              </>
            ) : "Loading planner data…"}
          </div>
        )}

        {plannerDatasetReady && plannerMetadataStatus.status === "ready"
          && (activeView === "planner" || plannerResidentMounted) && (
          <div
            className={`mep-planner-resident ${activeView === "planner" ? "is-active" : "is-hidden"}`}
            aria-hidden={activeView !== "planner"}
            inert={activeView !== "planner"}
          >
            <React.Suspense
              fallback={(
                <div
                  className="mep-loading"
                  // @ts-expect-error elementtiming is a valid Element Timing API attribute.
                  elementtiming={PLANNER_SUSPENSE_PLACEHOLDER_TIMING}
                >
                  Loading planner…
                </div>
              )}
            >
              <WeeklyOrganiserBoardComponent
                key={plannerBoardRetryRevision}
                app={app}
                presets={organiserPresets}
                eventsFolder={settings.eventsFolder}
                dayNotes={settings.dayNotes}
                onOpenFile={openPathFromCard}
                onSendShoppingList={handleSendShoppingList}
                onSaveDayNote={handleSaveDayNote}
                markedWidth={settings.weeklyOrganiserMarkedWidth}
                onSaveMarkedWidth={handleSaveMarkedWidth}
                onUnmarkRecipe={handlePlannerUnmark}
                onLoadImage={loadThumbnail}
                onGetLoadedImage={getLoadedThumbnail}
                plannerOrderStore={runtime.plannerOrderStore}
                onBoardReady={handlePlannerBoardReady}
                onBoardError={handlePlannerBoardError}
              />
            </React.Suspense>
          </div>
        )}

        {activeView === "database" && (
          <div className="mep-database-panel">
            <CookingDatabase
              recipes={databaseDisplayItems}
            totalCount={databaseView.total}
            markedCount={databaseView.markedCount}
            availableTags={databaseView.availableTags}
            settings={settings}
            state={databaseState}
            onStateChange={handleDatabaseStateChange}
            onOpenRecipe={openRecipeFromDatabase}
            onToggleMarked={handleToggleMarked}
            onClearMarked={handleClearMarked}
            onOpenPlanner={handleOpenPlanner}
            resolveCover={resolveDatabaseCover}
            getCoverState={getDatabaseCoverState}
            coverStore={databaseImageResourceStoreRef.current}
            isPending={databaseIsPending}
              sourceError={databaseSourceError}
            />
          </div>
        )}

        {activeView === "health" && (
          <CookingHealth
            snapshot={healthSnapshot ?? healthService.getSnapshot()}
            onRefresh={handleHealthRefresh}
            onClear={handleHealthClear}
          />
        )}

        {activeView === "shopping" && (
          <ShoppingListView
            list={shoppingList}
            plan={shoppingPlan}
            busy={shoppingBusy}
            error={shoppingError}
            onApply={handleApplyShoppingList}
            onCheck={handleCheckShoppingItem}
            onRollback={handleRollbackShoppingList}
            onRefresh={refreshShoppingList}
            onAdd={handleAddShoppingItem}
            onRemove={handleRemoveShoppingItem}
            onCopyLink={remoteHost ? handleCopyShoppingLink : undefined}
          />
        )}

        {activeView === "recipe" && activeFile && (
          <RecipeView
            key={activeFile.path}
            path={activeFile.path}
            title={activeFile.basename}
            content={activeContent}
            mode="full"
            onSave={saveActiveFileContent}
            resolveImageResource={resolveRecipeImageResource}
            getImageResource={getRecipeImageResource}
          />
        )}

        {activeView === "settings" && (
          <SettingsPanel
            settings={settings}
            settingsRevision={settingsRevision}
            onChange={updateSettings}
            onSelectVault={selectVault}
            vaultSource={remoteHost ? "host-managed" : "selectable"}
          />
        )}
      </main>

      {isPreviewOpen && (
        <aside className="mep-preview" data-preview-path={previewFile?.path ?? ""}>
          <div
            className="mep-preview__resizer"
            role="separator"
            aria-label="Resize side pane"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={760}
            aria-valuenow={previewWidth}
            tabIndex={0}
            onMouseDown={handlePreviewResizeStart}
            onKeyDown={(event) => {
              const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
              if (!delta) return;
              event.preventDefault();
              setPreviewWidth((width) => Math.max(320, Math.min(760, width + delta)));
            }}
          />
          <div className="mep-preview__header-row">
            <button
              type="button"
              className="mep-preview__close"
              onClick={() => {
                previewReadRequestIdRef.current += 1;
                clearPreviewLoadingTimer();
                setIsPreviewOpen(false);
                setPreviewFile(null);
                setPreviewIsRecipe(false);
                setPreviewContent("");
                setIsPreviewContentLoading(false);
              }}
            >
              x
            </button>
          </div>
          {previewFile ? (
            isPreviewContentLoading && previewContent.length === 0 ? (
              <div className="mep-loading">Loading editor…</div>
            ) : previewContent === FAILED_LOAD_MESSAGE ? (
              <div className="mep-preview__empty">Failed to load file.</div>
            ) : !previewIsRecipe ? (
              <div className="mep-preview__content">
                <pre>{previewContent || `# ${previewFile.basename}`}</pre>
              </div>
            ) : (
              <PreviewErrorBoundary
                key={`${previewFile.path}:${previewReadRequestIdRef.current}`}
                fallback={
                  <div className="mep-preview__content">
                    <div className="mep-preview__empty">
                      Could not render this note preview. Showing raw markdown.
                    </div>
                    <pre>{previewContent || `# ${previewFile.basename}`}</pre>
                  </div>
                }
              >
                <div className="mep-preview__content">
                  <RecipeView
                    path={previewFile.path}
                    title={previewFile.basename}
                    content={previewContent}
                    mode="rendered"
                    onSave={savePreviewFileContent}
                    resolveImageResource={resolveRecipeImageResource}
                    getImageResource={getRecipeImageResource}
                  />
                </div>
              </PreviewErrorBoundary>
            )
          ) : (
            <div className="mep-preview__empty">Open a card to see the note.</div>
          )}
        </aside>
      )}

      <div className="mep-notices">
        {notices.map((notice) => (
          <div key={notice.id} className="mep-notice">
            {notice.message}
          </div>
        ))}
      </div>

      {isCommandOpen && (
        <div className="mep-modal-overlay" role="presentation" onClick={() => setIsCommandOpen(false)}>
          <div className="mep-command" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              placeholder="Type a command…"
              value={commandQuery}
              onChange={(event) => setCommandQuery(event.target.value)}
            />
            <div className="mep-command__list">
              {filteredCommands.length === 0 ? (
                <div className="mep-command__empty">No matches.</div>
              ) : (
                filteredCommands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    onClick={() => {
                      command.action();
                      setIsCommandOpen(false);
                    }}
                  >
                    {command.label}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {isHelpOpen && (
        <div className="mep-modal-overlay" onClick={() => setIsHelpOpen(false)}>
          <dialog
            ref={helpDialogRef}
            className="mep-help"
            aria-label="Enplace help"
            onCancel={(event) => {
              event.preventDefault();
              setIsHelpOpen(false);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mep-help__header">
              <h3>Quick Help</h3>
              <button type="button" className="mep-button" onClick={() => setIsHelpOpen(false)}>
                Close
              </button>
            </div>
            <div className="mep-help__hint">
              Press <kbd>?</kbd> to open or close this overlay.
            </div>
            <div className="mep-help__section">
              <h4>Core shortcuts</h4>
              <ul>
                <li>
                  <kbd>Ctrl/Cmd</kbd> + <kbd>K</kbd>: open command palette
                </li>
                <li>
                  <kbd>Esc</kbd>: close open overlays and modals
                </li>
                <li>
                  Sidebar: Planner, Recipe Database, Cooking Health, Settings
                </li>
              </ul>
            </div>
            <div className="mep-help__section">
              <h4>Planner basics</h4>
              <ul>
                <li>Drag cards between columns to schedule or re-plan.</li>
                <li>
                  Hold <kbd>Shift</kbd> while dragging to duplicate instead of move.
                </li>
                <li>
                  Hold <kbd>Ctrl/Cmd</kbd> when clicking a card to open in a split.
                </li>
              </ul>
            </div>
            <div className="mep-help__section">
              <h4>Quick add ad hoc meals</h4>
              <ul>
                <li>Switch to the Meal preset in Planner.</li>
                <li>Click the day header note button (<kbd>+</kbd>) for that day.</li>
                <li>
                  Fill the Quick Meal form and click <strong>Add meal</strong> to create and
                  schedule it.
                </li>
              </ul>
            </div>
          </dialog>
        </div>
      )}
      </div>
    </div>
  );
}

type SettingsPanelProps = {
  settings: StandaloneSettings;
  settingsRevision: number;
  onChange: (updates: Partial<StandaloneSettings>) => void | Promise<void>;
  onSelectVault: () => void;
  vaultSource: "host-managed" | "selectable";
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  onChange,
  onSelectVault,
  vaultSource,
  settingsRevision
}) => {
  const [draft, setDraft] = React.useState(settings);
  const draftRef = React.useRef(settings);
  const committedRef = React.useRef<Partial<StandaloneSettings>>({});

  React.useEffect(() => {
    draftRef.current = settings;
    committedRef.current = {};
    setDraft(settings);
  }, [settings, settingsRevision]);

  const updateDraft = <K extends keyof StandaloneSettings,>(field: K, value: StandaloneSettings[K]) => {
    draftRef.current = { ...draftRef.current, [field]: value };
    setDraft(draftRef.current);
  };

  const commitField = <K extends keyof StandaloneSettings>(field: K) => {
    const value = draftRef.current[field];
    if (committedRef.current[field] === value || settings[field] === value) return;
    committedRef.current[field] = value;
    void onChange({ [field]: value } as Pick<StandaloneSettings, K>);
  };

  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>, field: keyof StandaloneSettings) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      commitField(field);
    }
  };

  return (
    <div className="mep-settings">
      <h2>Settings</h2>
      <div className="mep-settings__section">
        <h3>Vault</h3>
        <p>
          {vaultSource === "host-managed"
            ? "This app is connected to a host-managed vault."
            : "Choose the folder where this app should read and write your vault files."}
        </p>
        <div className="mep-settings__row">
          <label htmlFor="mep-vault-location">Vault location</label>
          <div className="mep-settings__inline">
            <input id="mep-vault-location" value={settings.vaultPath} readOnly />
            {vaultSource === "selectable" ? (
              <button className="mep-button" type="button" onClick={onSelectVault}>
                Choose folder
              </button>
            ) : (
              <span>Managed by host server</span>
            )}
          </div>
        </div>
      </div>

      <div className="mep-settings__section">
        <h3>Folders</h3>
        <div className="mep-settings__grid">
          <label>
            Recipes folder
            <input
              value={draft.recipesFolder}
              onChange={(event) => updateDraft("recipesFolder", event.target.value)}
              onBlur={() => commitField("recipesFolder")}
              onKeyDown={(event) => commitOnEnter(event, "recipesFolder")}
            />
          </label>
          <label>
            Images folder
            <input
              value={draft.imagesFolder}
              onChange={(event) => updateDraft("imagesFolder", event.target.value)}
              onBlur={() => commitField("imagesFolder")}
              onKeyDown={(event) => commitOnEnter(event, "imagesFolder")}
            />
          </label>
          <label>
            Events folder
            <input
              value={draft.eventsFolder}
              onChange={(event) => updateDraft("eventsFolder", event.target.value)}
              onBlur={() => commitField("eventsFolder")}
              onKeyDown={(event) => commitOnEnter(event, "eventsFolder")}
            />
          </label>
        </div>
      </div>

      <div className="mep-settings__section">
        <h3>Recipe database</h3>
        <div className="mep-settings__grid">
          <label>
            Card minimum width
            <input
              type="number"
              value={draft.databaseCardMinWidth}
              onChange={(event) => updateDraft("databaseCardMinWidth", Number(event.target.value) || 220)}
              onBlur={() => commitField("databaseCardMinWidth")}
              onKeyDown={(event) => commitOnEnter(event, "databaseCardMinWidth")}
            />
          </label>
          <label>
            Max cards
            <input
              type="number"
              value={draft.databaseMaxCards}
              onChange={(event) => updateDraft("databaseMaxCards", Number(event.target.value) || 500)}
              onBlur={() => commitField("databaseMaxCards")}
              onKeyDown={(event) => commitOnEnter(event, "databaseMaxCards")}
            />
          </label>
        </div>
      </div>

    </div>
  );
}

export default App;
