import * as React from "react";
import { PlannerOrderStore } from "@/modules/organiser/utils/planner-order";
import { WeeklyOrganiserBoard } from "@/modules/organiser/components/WeeklyOrganiserBoard";
import { resolveDatabaseCoverPath } from "@/modules/cooking/utils/databaseCover";
import { CookingDatabase } from "@/views/components/CookingDatabase";
import { RecipeView, type RecipeViewHandle } from "@/views/components/RecipeView";
import { ShoppingListView } from "@/views/components/ShoppingListView";
import { AppSidebar } from "./standalone/AppSidebar";
import { DEFAULT_STANDALONE_SETTINGS, type StandaloneSettings } from "./standalone/settings";
import { loadSettings, prepareStandaloneStartup, saveSettings } from "./standalone/storage";
import { initialViewForPathname, pathnameForView } from "./standalone/pwa-route";
import {
  acknowledgePlannerMountReady, cancelPlannerNavigation, createPlannerNavigationIntentState,
  requestPlannerNavigation, retryPlannerNavigation, settlePlannerNavigation,
  type PlannerNavigationIntent,
} from "./standalone/planner-navigation-intent";
import type { RecipePlanning } from "./core";
import {
  addShoppingItem, applyShoppingPlan, clearMarkedRecipes, copyShoppingList, deleteRecipe, removeShopping,
  resetShoppingList, updateShoppingAisle, saveRecipe, toggleShopping, updatePlanRecipe,
} from "./cookbook/actions";
import { setDayNote } from "./cookbook/plan-notes";
import { cardCoverUrl } from "./cookbook/covers";
import { getCookbookSnapshot, useCookbookSlice, useCookbookText, type CookbookFile } from "./cookbook/store";
import { CommandPalette, HelpDialog, Notices, SettingsDialog, StartupFailure, type Command } from "./views/components/AppOverlays";
import { PreviewPane } from "./views/components/PreviewPane";

type ViewId = "planner" | "database" | "shopping" | "recipe";
type RoutedView = ViewId | "settings";
type Runtime = { settings: StandaloneSettings; plannerOrderStore: PlannerOrderStore };
type PlannerCapability = { status: "idle" | "loading" | "ready" } | { status: "error"; message: string };
const DEFAULT_VIEW: ViewId = "database";
const FAILED_LOAD_MESSAGE = "Failed to load file.";
/** The third element is true only when a cold load landed on "/recipe": the open recipe's
 *  identity lives in app state, never the URL, so there is nothing to show and the mount
 *  effect canonicalises the address bar back to the database. */
function initialRouteState(route: RoutedView): readonly [ViewId, boolean, boolean] {
  if (route === "recipe") return [DEFAULT_VIEW, false, true];
  const settingsOpen = route === "settings";
  return [settingsOpen ? DEFAULT_VIEW : route, settingsOpen, false];
}
const basename = (path: string): string => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message?.trim() || "Unknown error";
  return typeof error === "string" ? error : "Unknown error";
}
function notify(message: string): void {
  window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } }));
}
async function flushRecipeSave(ref: React.RefObject<RecipeViewHandle | null>): Promise<boolean> {
  try { await ref.current?.flushSave(); return true; } catch { return false; }
}

function useCookbookImages(): {
  resolveCover: (path: string | null, source: string) => string | null;
  resolveImage: (path: string, source: string) => string | null;
} {
  const files = useCookbookSlice("files");
  const imageUrls = useCookbookSlice("imageUrls");
  const paths = React.useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const resolvePath = React.useCallback((path: string, source: string): string | null => (
    resolveDatabaseCoverPath(path, source, {
      findAbsolutePath: (candidate) => paths.has(candidate) ? candidate : null,
      resolveLinkpath: () => null,
    })
  ), [paths]);
  const resolveImage = React.useCallback((path: string, source: string): string | null => (
    path.startsWith("/") || /^https?:/i.test(path) ? path : imageUrls.get(resolvePath(path, source) ?? "") ?? null
  ), [imageUrls, resolvePath]);
  const resolveCover = React.useCallback((path: string | null, source: string): string | null => {
    if (!path || path.startsWith("/") || /^https?:/i.test(path)) return path || null;
    const coverPath = resolvePath(path, source);
    if (!coverPath) return null;
    return cardCoverUrl(coverPath, imageUrls);
  }, [imageUrls, resolvePath]);
  return { resolveCover, resolveImage };
}

type PlannerCookbookViewProps = Omit<React.ComponentProps<typeof WeeklyOrganiserBoard>, "recipes" | "plan" | "resolveCover" | "dayNotes"> & { active: boolean; capability: PlannerCapability; onRetry: () => void };
function PlannerCookbookView({ active, capability, onRetry, ...props }: PlannerCookbookViewProps): React.JSX.Element | null {
  const recipes = useCookbookSlice("recipes"); const plan = useCookbookSlice("plan");
  const dayNotes = React.useMemo(() => Object.fromEntries(plan.notes), [plan.notes]); const { resolveCover } = useCookbookImages();
  if (capability.status === "error") return active
    ? <div className="mep-loading"><div>Planner failed to load: {capability.message}</div><button type="button" className="mep-button mep-button--ghost" onClick={onRetry}>Retry planner</button></div>
    : <div className="mep-planner-intent-error" role="alert"><span>Planner failed to load: {capability.message}</span><button type="button" className="mep-button mep-button--ghost" onClick={onRetry}>Retry planner</button></div>;
  if (!active || capability.status !== "ready") return null;
  return <div className="mep-planner"><WeeklyOrganiserBoard {...props} recipes={recipes} plan={plan} dayNotes={dayNotes} resolveCover={resolveCover} /></div>;
}

type DatabaseCookbookViewProps = Omit<React.ComponentProps<typeof CookingDatabase>, "recipes" | "plan" | "resolveCover">;
function DatabaseCookbookView(props: DatabaseCookbookViewProps): React.JSX.Element {
  const recipes = useCookbookSlice("recipes");
  const plan = useCookbookSlice("plan");
  const { resolveCover } = useCookbookImages();
  return <div className="mep-database-panel"><CookingDatabase {...props} recipes={recipes} plan={plan} resolveCover={resolveCover} /></div>;
}

type ShoppingCookbookViewProps = Omit<React.ComponentProps<typeof ShoppingListView>, "list">;
function ShoppingCookbookView(props: ShoppingCookbookViewProps): React.JSX.Element {
  const list = useCookbookSlice("shopping");
  return <ShoppingListView {...props} list={list} />;
}

function RecipeCookbookView({ path, recipeRef, onDelete }: {
  path: string;
  recipeRef: React.RefObject<RecipeViewHandle | null>;
  onDelete: () => Promise<void>;
}): React.JSX.Element {
  const content = useCookbookText(path) ?? FAILED_LOAD_MESSAGE;
  const { resolveImage } = useCookbookImages();
  return <RecipeView
    key={path}
    ref={recipeRef}
    path={path}
    title={basename(path)}
    content={content}
    mode="full"
    onSave={(base, next) => saveRecipe(path, base, next)}
    onDelete={onDelete}
    resolveImage={resolveImage}
  />;
}

function PreviewCookbookView({ file, isRecipe, width, recipeRef, onClose, onWidth }: {
  file: CookbookFile;
  isRecipe: boolean;
  width: number;
  recipeRef: React.RefObject<RecipeViewHandle | null>;
  onClose: () => void;
  onWidth: (width: number) => void;
}): React.JSX.Element {
  const content = useCookbookText(file.path) ?? FAILED_LOAD_MESSAGE;
  const { resolveImage } = useCookbookImages();
  return <PreviewPane
    path={file.path}
    content={content}
    isRecipe={isRecipe}
    width={width}
    recipeRef={recipeRef}
    onClose={onClose}
    onWidth={onWidth}
    onSave={(base, next) => saveRecipe(file.path, base, next)}
    resolveImage={resolveImage}
  />;
}

function App(): React.JSX.Element | null {
  const settingsRef = React.useRef(DEFAULT_STANDALONE_SETTINGS);
  const [runtime, setRuntime] = React.useState<Runtime | null>(null);
  const [startupError, setStartupError] = React.useState("");
  const [startupPhase, setStartupPhase] = React.useState("Preparing startup");
  const [startupEvents, setStartupEvents] = React.useState<string[]>([]);
  const initialize = React.useCallback(async () => {
    setStartupError(""); setStartupEvents([]); setStartupPhase("Loading preferences");
    try {
      const stored = await loadSettings();
      const settings = await prepareStandaloneStartup({ ...DEFAULT_STANDALONE_SETTINGS, ...stored });
      settingsRef.current = settings;
      setRuntime({ settings, plannerOrderStore: new PlannerOrderStore() });
    } catch (error) {
      const detail = formatError(error);
      setStartupError(detail); setStartupEvents([`[${new Date().toISOString()}] Startup failed: ${detail}`]);
    }
  }, []);
  React.useEffect(() => { void initialize(); }, [initialize]);

  const [initialView, initialSettingsOpen, initialRecipeFallback] = React.useRef(initialRouteState(initialViewForPathname(window.location.pathname))).current;
  const [activeView, setActiveViewState] = React.useState<ViewId>(initialView);
  const activeViewRef = React.useRef(activeView); activeViewRef.current = activeView;
  const [settingsOpen, setSettingsOpen] = React.useState(initialSettingsOpen);
  const [history, setHistory] = React.useState<ViewId[]>([activeView]);
  const historyRef = React.useRef(history); historyRef.current = history;
  React.useEffect(() => {
    if (initialRecipeFallback) window.history.replaceState(null, "", pathnameForView(DEFAULT_VIEW));
  }, [initialRecipeFallback]);
  const recipeRequest = React.useRef(0);
  const activeRecipeRef = React.useRef<RecipeViewHandle>(null);
  const previewRecipeRef = React.useRef<RecipeViewHandle>(null);

  const plannerIntent = React.useRef(createPlannerNavigationIntentState());
  const [intentRevision, setIntentRevision] = React.useState(0);
  const plannerLoad = React.useRef<Promise<void> | null>(null);
  const [plannerCapability, setPlannerCapability] = React.useState<PlannerCapability>({ status: "idle" });
  const plannerReady = plannerCapability.status === "ready";
  // The database stays mounted once shown, hidden rather than removed, so returning to it never
  // recreates its cover images and never paints a partial frame.
  const databaseSeen = React.useRef(activeView === "database");
  const startPlanner = React.useCallback((): Promise<void> => {
    if (!runtime) return Promise.resolve();
    if (plannerLoad.current) return plannerLoad.current;
    setPlannerCapability({ status: "loading" });
    const load = runtime.plannerOrderStore.load(); plannerLoad.current = load;
    void load.then(() => {
      if (plannerLoad.current !== load) return;
      setPlannerCapability({ status: "ready" });
      if (plannerIntent.current.pending) setIntentRevision((value) => value + 1);
    }, (error) => {
      if (plannerLoad.current !== load) return;
      plannerLoad.current = null; setPlannerCapability({ status: "error", message: formatError(error) });
    });
    return load;
  }, [runtime]);
  const preparePlannerNavigation = React.useCallback(() => { void startPlanner().catch(() => undefined); }, [startPlanner]);
  React.useEffect(() => {
    if (runtime && activeView === "planner" && plannerCapability.status === "idle") {
      preparePlannerNavigation();
    }
  }, [activeView, plannerCapability.status, preparePlannerNavigation, runtime]);
  const requestPendingPlanner = React.useCallback((mode: PlannerNavigationIntent["history"]) => {
    recipeRequest.current += 1;
    requestPlannerNavigation(plannerIntent.current, mode);
    setIntentRevision((value) => value + 1); preparePlannerNavigation();
  }, [preparePlannerNavigation]);
  const cancelPendingPlanner = React.useCallback(() => {
    if (!plannerIntent.current.pending) return;
    cancelPlannerNavigation(plannerIntent.current); setIntentRevision((value) => value + 1);
  }, []);
  const retryPlanner = React.useCallback(() => {
    if (plannerCapability.status === "error") { window.location.reload(); return; }
    if (plannerIntent.current.pending) retryPlannerNavigation(plannerIntent.current);
    setIntentRevision((value) => value + 1); preparePlannerNavigation();
  }, [plannerCapability.status, preparePlannerNavigation]);

  const setActiveView = React.useCallback(async (view: ViewId): Promise<boolean> => {
    if (activeViewRef.current === view) return true;
    if (!await flushRecipeSave(activeRecipeRef)) return false;
    if (view === "planner" && !plannerReady) { requestPendingPlanner("push"); return false; }
    cancelPendingPlanner(); recipeRequest.current += 1;
    const path = pathnameForView(view); if (window.location.pathname !== path) window.history.pushState(null, "", path);
    databaseSeen.current ||= view === "database";
    activeViewRef.current = view; setHistory((values) => [...values.slice(-9), view]); setActiveViewState(view); return true;
  }, [cancelPendingPlanner, plannerReady, requestPendingPlanner]);
  // Back always replays a real browser history entry, never a synthetic replaceState: the
  // internal stack's only job is gating whether a previous entry of ours exists to go back to.
  const goBack = React.useCallback(async () => {
    if (historyRef.current.length <= 1) return;
    if (!await flushRecipeSave(activeRecipeRef)) return;
    window.history.back();
  }, []);
  React.useLayoutEffect(() => {
    const pop = () => {
      const routed = initialViewForPathname(window.location.pathname);
      if (routed === "settings") { setSettingsOpen(true); return; }
      setSettingsOpen(false);
      if (routed === activeViewRef.current) return;
      const previous = activeViewRef.current;
      void flushRecipeSave(activeRecipeRef).then((saved) => {
        if (!saved) { window.history.pushState(null, "", pathnameForView(previous)); return; }
        // One popstate is one real step of browser history: pop exactly one entry when it lands
        // where our own stack expects (a genuine back step), and only reset the stack when it
        // does not (a jump this stack cannot account for, e.g. arriving from outside the app's
        // own entries) so the internal stack and browser stack stay one-to-one.
        setHistory((values) => (
          values.length > 1 && values[values.length - 2] === routed ? values.slice(0, -1) : [routed]
        ));
        if (routed === "planner" && !plannerReady) requestPendingPlanner("none");
        else { cancelPendingPlanner(); databaseSeen.current ||= routed === "database"; activeViewRef.current = routed; setActiveViewState(routed); }
      });
    };
    window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop);
  }, [cancelPendingPlanner, plannerReady, requestPendingPlanner]);
  React.useLayoutEffect(() => {
    if (plannerReady && plannerIntent.current.pending) acknowledgePlannerMountReady(plannerIntent.current);
    const intent = settlePlannerNavigation(plannerIntent.current, plannerReady); if (!intent) return;
    if (intent.history !== "none") {
      const path = pathnameForView("planner");
      if (intent.history === "push") window.history.pushState(null, "", path); else window.history.replaceState(null, "", path);
    }
    activeViewRef.current = "planner"; setHistory((values) => [...values.slice(-9), "planner"]); setActiveViewState("planner");
  }, [intentRevision, plannerReady]);
  React.useEffect(() => () => cancelPlannerNavigation(plannerIntent.current), []);

  const openSettings = React.useCallback(() => {
    setSettingsOpen(true); if (window.location.pathname !== pathnameForView("settings")) window.history.pushState(null, "", pathnameForView("settings"));
  }, []);
  const closeSettings = React.useCallback(() => { setSettingsOpen(false); window.history.replaceState(null, "", pathnameForView(activeViewRef.current)); }, []);
  const navigate = React.useCallback((view: RoutedView) => { if (view === "settings") openSettings(); else { setSettingsOpen(false); void setActiveView(view); } }, [openSettings, setActiveView]);

  const updateSettings = React.useCallback(async (updates: Partial<StandaloneSettings>) => {
    if (!runtime) return;
    const settings = { ...settingsRef.current, ...updates }; await saveSettings(settings); settingsRef.current = settings;
    setRuntime((value) => value ? { ...value, settings } : value);
  }, [runtime]);

  const [shoppingBusy, setShoppingBusy] = React.useState(false);
  const [shoppingError, setShoppingError] = React.useState<string | null>(null);
  const shoppingWork = React.useCallback((work: () => Promise<unknown>) => {
    setShoppingBusy(true); setShoppingError(null);
    return work().catch((error) => { setShoppingError(formatError(error)); throw error; }).finally(() => setShoppingBusy(false));
  }, []);
  const handleSendShopping = React.useCallback((recipePaths: string[]) => {
    void shoppingWork(() => applyShoppingPlan(recipePaths))
      .catch(() => undefined)
      .then(() => { void setActiveView("shopping"); });
  }, [setActiveView, shoppingWork]);
  const handleCheckShopping = React.useCallback((ids: string[], checked: boolean) => {
    const items = getCookbookSnapshot().shopping.items.filter((item) => ids.includes(item.id));
    void shoppingWork(() => toggleShopping(items, checked)).catch(() => undefined);
  }, [shoppingWork]);
  const handleRemoveShopping = React.useCallback((ids: string[]) => {
    const items = getCookbookSnapshot().shopping.items.filter((item) => ids.includes(item.id));
    void shoppingWork(() => removeShopping(items)).catch(() => undefined);
  }, [shoppingWork]);
  const handleCopyShopping = React.useCallback(() => { void copyShoppingList().then(() => notify("Shopping list copied."), () => notify("Could not copy the shopping list.")); }, []);

  const updatePlanning = React.useCallback(async (path: string, update: (value: RecipePlanning) => RecipePlanning) => {
    const recipe = getCookbookSnapshot().recipes.find((candidate) => candidate.path === path);
    if (!recipe) throw new Error(`Recipe not found: ${path}`);
    await updatePlanRecipe(recipe, update);
  }, []);
  const toggleMarked = React.useCallback((path: string, marked: boolean) => updatePlanning(path, (value) => ({ ...value, marked })), [updatePlanning]);
  const [activeFile, setActiveFile] = React.useState<CookbookFile | null>(null);
  const [previewFile, setPreviewFile] = React.useState<CookbookFile | null>(null);
  const [previewIsRecipe, setPreviewIsRecipe] = React.useState(false);
  const [previewWidth, setPreviewWidth] = React.useState(420);
  const closePreview = React.useCallback(async () => {
    if (!await flushRecipeSave(previewRecipeRef)) return false;
    setPreviewFile(null); setPreviewIsRecipe(false); return true;
  }, []);
  const openPreview = React.useCallback(async (file: CookbookFile, isRecipe: boolean) => {
    if (!await flushRecipeSave(previewRecipeRef)) return;
    setPreviewFile(file); setPreviewIsRecipe(isRecipe);
  }, []);
  const openPath = React.useCallback(async (path: string, options: { split: boolean }) => {
    const file = getCookbookSnapshot().files.find((candidate) => candidate.path === path); if (!file) return;
    const recipe = getCookbookSnapshot().recipes.some((candidate) => candidate.path === path);
    if (options.split) { await openPreview(file, recipe); return; }
    if (!await closePreview()) return; setActiveFile(file); if (recipe) await setActiveView("recipe");
  }, [closePreview, openPreview, setActiveView]);
  const openRecipe = React.useCallback(async (path: string, split: boolean) => {
    if (activeViewRef.current !== "database") return;
    const file = getCookbookSnapshot().files.find((candidate) => candidate.path === path); if (!file) return;
    if (split) { await openPreview(file, true); return; }
    if (!await closePreview()) return;
    setActiveFile(file); void setActiveView("recipe");
  }, [closePreview, openPreview, setActiveView]);
  const { resolveImage } = useCookbookImages();
  // The card thumbnail is already decoded and on screen. What the recipe page still has to
  // decode is its full-size cover, so press warms exactly that one image and nothing else.
  const prepareRecipe = React.useCallback((path: string) => {
    const cover = getCookbookSnapshot().recipes.find((recipe) => recipe.path === path)?.cover;
    const url = cover ? resolveImage(cover, path) : null;
    if (!url) return;
    const image = new Image();
    image.src = url;
    void image.decode().catch(() => undefined);
  }, [resolveImage]);

  const [notices, setNotices] = React.useState<{ id: string; message: string }[]>([]);
  React.useEffect(() => {
    const handler = (event: Event) => {
      const message = (event as CustomEvent<{ message: string }>).detail.message;
      const id = Math.random().toString(36).slice(2); setNotices((values) => [...values, { id, message }]);
      window.setTimeout(() => setNotices((values) => values.filter((notice) => notice.id !== id)), 4000);
    };
    window.addEventListener("mep-notice", handler); return () => window.removeEventListener("mep-notice", handler);
  }, []);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");
  React.useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const entering = target?.matches("input,textarea,select,[contenteditable=true]") ?? false;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); setCommandQuery(""); setHelpOpen(false); }
      if (event.key === "?" && !entering) { event.preventDefault(); setHelpOpen((value) => !value); setCommandOpen(false); }
      if (event.key === "Escape") { setCommandOpen(false); setHelpOpen(false); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  const commands: Command[] = React.useMemo(() => [
    { id: "planner", label: "Go to Planner", action: () => { void setActiveView("planner"); } },
    { id: "database", label: "Go to Recipe Database", action: () => { void setActiveView("database"); } },
    { id: "shopping", label: "Open Shopping List", action: () => { void setActiveView("shopping"); } },
    { id: "settings", label: "Open Settings", action: openSettings },
    { id: "help", label: "Open Help Overlay", action: () => setHelpOpen(true) },
  ], [openSettings, setActiveView]);
  const filteredCommands = commands.filter((command) => command.label.toLowerCase().includes(commandQuery.trim().toLowerCase()));

  if (!runtime) return startupError ? <StartupFailure phase={startupPhase} error={startupError} events={startupEvents} onRetry={() => void initialize()} /> : null;
  const { settings } = runtime;
  return <div className="mep-root"><div className={`mep-shell ${previewFile ? "mep-shell--preview-open" : "mep-shell--preview-closed"} ${activeView === "shopping" ? "mep-shell--shopping" : ""}`} style={{ "--mep-preview-width": previewFile ? `${previewWidth}px` : "0px" } as React.CSSProperties}>
    <AppSidebar activeView={settingsOpen ? "settings" : activeView} canGoBack={history.length > 1} onBack={goBack} onNavigate={navigate} onPreparePlanner={preparePlannerNavigation} />
    <main className={`mep-main ${activeView === "planner" ? "mep-main--planner" : ""} ${activeView === "database" ? "mep-main--database" : ""} ${activeView === "shopping" ? "mep-main--shopping" : ""}`}>
      <h1 className="mep-sr-only">Enplace</h1>
      {activeView === "planner" || plannerCapability.status === "error" ? <PlannerCookbookView active={activeView === "planner"} capability={plannerCapability} onRetry={retryPlanner} updatePlanning={updatePlanning} notify={notify} onOpenFile={openPath} onSendShoppingList={handleSendShopping} onSaveDayNote={setDayNote} onUnmarkRecipe={(path) => toggleMarked(path, false)} plannerOrderStore={runtime.plannerOrderStore} /> : null}
      {databaseSeen.current ? <div className="mep-view" hidden={activeView !== "database"}><DatabaseCookbookView settings={settings} onOpenRecipe={openRecipe} onPointerDownRecipe={prepareRecipe} onToggleMarked={toggleMarked} onClearMarked={() => clearMarkedRecipes().catch(() => notify("Failed to clear all marked items. The view will resync."))} onPreferencesChange={updateSettings} /></div> : null}
      {activeView === "shopping" ? <ShoppingCookbookView busy={shoppingBusy} error={shoppingError} onCheck={handleCheckShopping} onAdd={(content) => shoppingWork(() => addShoppingItem(content)).then(() => undefined)} onRemove={handleRemoveShopping} onCopyLink={handleCopyShopping} onReset={() => { void shoppingWork(resetShoppingList).catch(() => undefined); }} onAisle={(id, aisle) => {
        const text = getCookbookSnapshot().shopping.items.find((item) => item.id === id)?.content;
        if (text) void shoppingWork(() => updateShoppingAisle(text, aisle)).catch(() => undefined);
      }} /> : null}
      {activeView === "recipe" && activeFile ? <RecipeCookbookView path={activeFile.path} recipeRef={activeRecipeRef} onDelete={async () => { const path = activeFile.path; if (!await setActiveView("database")) return; await deleteRecipe(path); setActiveFile(null); }} /> : null}
      {settingsOpen ? <SettingsDialog routePath={pathnameForView(activeView)} onClose={closeSettings} /> : null}
    </main>
    {previewFile ? <PreviewCookbookView file={previewFile} isRecipe={previewIsRecipe} width={previewWidth} recipeRef={previewRecipeRef} onClose={() => { void closePreview(); }} onWidth={setPreviewWidth} /> : null}
    <Notices notices={notices} />
    {commandOpen ? <CommandPalette commands={filteredCommands} query={commandQuery} onQuery={setCommandQuery} onClose={() => setCommandOpen(false)} /> : null}
    {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
  </div></div>;
}
export default App;
