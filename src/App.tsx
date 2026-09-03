import * as React from "react";
import { PlannerOrderStore } from "@/modules/organiser/utils/planner-order";
import { normalizeWeeklyColumnMinWidth } from "@/modules/organiser/utils/weekly-layout";
import { WeeklyOrganiserBoard } from "@/modules/organiser/components/WeeklyOrganiserBoard";
import { BuiltInShoppingListService } from "@/modules/cooking/services/BuiltInShoppingListService";
import { resolveDatabaseCoverPath } from "@/modules/cooking/utils/databaseCover";
import { DatabasePanel } from "@/views/components/DatabasePanel";
import { buildDatabaseView, type DatabaseView } from "@/views/components/database-query";
import { RecipeView, type RecipeViewHandle } from "@/views/components/RecipeView";
import { ShoppingListView, type ShoppingListPlan } from "@/views/components/ShoppingListView";
import { AppSidebar } from "./standalone/AppSidebar";
import { DEFAULT_STANDALONE_SETTINGS, type StandaloneSettings } from "./standalone/settings";
import { loadSettings, prepareStandaloneStartup, saveSettings } from "./standalone/storage";
import { initialViewForPathname, pathnameForView } from "./standalone/pwa-route";
import {
  acknowledgePlannerMountReady, cancelPlannerNavigation, createPlannerNavigationIntentState,
  failPlannerNavigation, requestPlannerNavigation, retryPlannerNavigation, settlePlannerNavigation,
  type PlannerNavigationIntent,
} from "./standalone/planner-navigation-intent";
import {
  PLANNER_METADATA_PLACEHOLDER_TIMING, markPlannerSemanticReady, plannerBoardIdentityKey,
  type PlannerBoardIdentity,
} from "./standalone/planner-transition-evidence";
import { parseRecipe, type RecipePlanning } from "./core";
import { readText } from "./host-client/browser-storage";
import {
  addShoppingItem, applyShoppingPlan, clearMarkedRecipes, copyShoppingList, deleteRecipe, removeShopping,
  saveRecipe, toggleShopping, updatePlanRecipe,
} from "./kitchen/actions";
import { setDayNote } from "./kitchen/plan-notes";
import { consumeShareDialogRequest, ShareKitchenDialog } from "./kitchen/KitchenPanel";
import { getKitchenSnapshot, useKitchenSlice, useKitchenText, type KitchenFile } from "./kitchen/store";
import { CommandPalette, HelpDialog, Notices, SettingsDialog, StartupFailure, type Command } from "./views/components/AppOverlays";
import { PreviewPane } from "./views/components/PreviewPane";

export { updatePlanRecipe } from "./kitchen/actions";

type ViewId = "planner" | "database" | "shopping" | "recipe";
type RoutedView = ViewId | "settings";
type Runtime = { settings: StandaloneSettings; plannerOrderStore: PlannerOrderStore };
type PlannerCapability = { status: "idle" | "loading" | "ready" } | { status: "error"; message: string };
const DEFAULT_VIEW: ViewId = "database";
const FAILED_LOAD_MESSAGE = "Failed to load file.";
const basename = (path: string): string => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message?.trim() || "Unknown error";
  return typeof error === "string" ? error : "Unknown error";
}
function notify(message: string): void {
  window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } }));
}
function markPlannerMetadataCompletion(): void {
  if (typeof performance?.mark === "function") performance.mark("mep:planner:metadata-complete");
}
async function flushRecipeSave(ref: React.RefObject<RecipeViewHandle | null>): Promise<boolean> {
  try { await ref.current?.flushSave(); return true; } catch { return false; }
}

function useKitchenImages(): {
  resolveCover: (path: string | null, source: string) => string | null;
  resolveImage: (path: string, source: string) => string | null;
} {
  const files = useKitchenSlice("files");
  const imageUrls = useKitchenSlice("imageUrls");
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
  const resolveCover = React.useCallback((path: string | null, source: string): string | null => (
    path ? resolveImage(path, source) : null
  ), [resolveImage]);
  return { resolveCover, resolveImage };
}

type PlannerKitchenViewProps = Omit<React.ComponentProps<typeof WeeklyOrganiserBoard>, "recipes" | "plan" | "resolveCover" | "dayNotes">;
function PlannerKitchenView(props: PlannerKitchenViewProps): React.JSX.Element {
  const recipes = useKitchenSlice("recipes");
  const plan = useKitchenSlice("plan");
  const dayNotes = React.useMemo(() => Object.fromEntries(plan.notes), [plan.notes]);
  const { resolveCover } = useKitchenImages();
  return <div className="mep-planner"><WeeklyOrganiserBoard {...props} recipes={recipes} plan={plan} dayNotes={dayNotes} resolveCover={resolveCover} /></div>;
}

type DatabaseKitchenViewProps = Omit<React.ComponentProps<typeof DatabasePanel>, "revision" | "resolveCover">;
function DatabaseKitchenView(props: DatabaseKitchenViewProps): React.JSX.Element | null {
  const revision = useKitchenSlice("catalogRevision");
  const { resolveCover } = useKitchenImages();
  return <DatabasePanel {...props} revision={revision} resolveCover={resolveCover} />;
}

type ShoppingKitchenViewProps = Omit<React.ComponentProps<typeof ShoppingListView>, "list">;
function ShoppingKitchenView(props: ShoppingKitchenViewProps): React.JSX.Element {
  const list = useKitchenSlice("shopping");
  return <ShoppingListView {...props} list={list} />;
}

function RecipeKitchenView({ path, recipeRef, onDelete }: {
  path: string;
  recipeRef: React.RefObject<RecipeViewHandle | null>;
  onDelete: () => Promise<void>;
}): React.JSX.Element {
  const content = useKitchenText(path) ?? FAILED_LOAD_MESSAGE;
  const { resolveImage } = useKitchenImages();
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

function PreviewKitchenView({ file, isRecipe, width, recipeRef, onClose, onWidth }: {
  file: KitchenFile;
  isRecipe: boolean;
  width: number;
  recipeRef: React.RefObject<RecipeViewHandle | null>;
  onClose: () => void;
  onWidth: (width: number) => void;
}): React.JSX.Element {
  const content = useKitchenText(file.path) ?? FAILED_LOAD_MESSAGE;
  const { resolveImage } = useKitchenImages();
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
      markPlannerMetadataCompletion();
      performance.mark?.("mep:planner:dataset-ready", { detail: { revision: getKitchenSnapshot().revision } });
    } catch (error) {
      const detail = formatError(error);
      setStartupError(detail); setStartupEvents([`[${new Date().toISOString()}] Startup failed: ${detail}`]);
    }
  }, []);
  React.useEffect(() => { void initialize(); }, [initialize]);

  const initialRoute = React.useRef<RoutedView>(initialViewForPathname(window.location.pathname)).current;
  const [activeView, setActiveViewState] = React.useState<ViewId>(initialRoute === "settings" ? DEFAULT_VIEW : initialRoute);
  const activeViewRef = React.useRef(activeView); activeViewRef.current = activeView;
  const [settingsOpen, setSettingsOpen] = React.useState(initialRoute === "settings");
  const [shareOpen, setShareOpen] = React.useState(consumeShareDialogRequest);
  const settingsOpenRef = React.useRef(settingsOpen); settingsOpenRef.current = settingsOpen;
  const [history, setHistory] = React.useState<ViewId[]>([activeView]);
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
  const [databaseSeen, setDatabaseSeen] = React.useState(activeView === "database");
  React.useEffect(() => { if (activeView === "database") setDatabaseSeen(true); }, [activeView]);
  const [plannerTransition, setPlannerTransition] = React.useState(0);
  const transitionRef = React.useRef(0);
  const [plannerIdentity, setPlannerIdentity] = React.useState<PlannerBoardIdentity | null>(null);
  const [plannerBoardRevision, setPlannerBoardRevision] = React.useState(0);
  const [plannerFailure, setPlannerFailure] = React.useState<string | null>(null);
  const emittedIdentities = React.useRef(new Set<string>());
  const beginPlannerTransition = React.useCallback((generation?: number) => {
    const next = generation ?? transitionRef.current + 1; transitionRef.current = next; setPlannerTransition(next);
  }, []);
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
      beginPlannerTransition(); preparePlannerNavigation();
    }
  }, [activeView, beginPlannerTransition, plannerCapability.status, preparePlannerNavigation, runtime]);
  const requestPendingPlanner = React.useCallback((mode: PlannerNavigationIntent["history"]) => {
    recipeRequest.current += 1;
    const intent = requestPlannerNavigation(plannerIntent.current, mode);
    if (plannerFailure) failPlannerNavigation(plannerIntent.current, plannerFailure);
    beginPlannerTransition(intent.generation); setIntentRevision((value) => value + 1); preparePlannerNavigation();
  }, [beginPlannerTransition, plannerFailure, preparePlannerNavigation]);
  const cancelPendingPlanner = React.useCallback(() => {
    if (!plannerIntent.current.pending) return;
    cancelPlannerNavigation(plannerIntent.current); setIntentRevision((value) => value + 1);
  }, []);
  const retryPlanner = React.useCallback(() => {
    if (plannerCapability.status === "error") { window.location.reload(); return; }
    if (plannerIntent.current.pending) retryPlannerNavigation(plannerIntent.current);
    setPlannerFailure(null); setPlannerBoardRevision((value) => value + 1); setIntentRevision((value) => value + 1); preparePlannerNavigation();
  }, [plannerCapability.status, preparePlannerNavigation]);

  const setActiveView = React.useCallback(async (view: ViewId): Promise<boolean> => {
    if (activeViewRef.current === view) return true;
    if (!await flushRecipeSave(activeRecipeRef)) return false;
    if (view === "planner" && !plannerReady) { requestPendingPlanner("push"); return false; }
    cancelPendingPlanner(); recipeRequest.current += 1;
    const path = pathnameForView(view); if (window.location.pathname !== path) window.history.pushState(null, "", path);
    if (view === "planner") beginPlannerTransition();
    activeViewRef.current = view; setHistory((values) => [...values.slice(-9), view]); setActiveViewState(view); return true;
  }, [beginPlannerTransition, cancelPendingPlanner, plannerReady, requestPendingPlanner]);
  const goBack = React.useCallback(async () => {
    if (!await flushRecipeSave(activeRecipeRef)) return;
    setHistory((values) => values.length <= 1 ? values : values.slice(0, -1));
  }, []);
  React.useEffect(() => {
    const last = history[history.length - 1]; if (!last || last === activeView) return;
    if (last === "planner" && !plannerReady) { requestPendingPlanner("replace"); return; }
    cancelPendingPlanner(); activeViewRef.current = last; setActiveViewState(last);
    if (!settingsOpenRef.current) window.history.replaceState(null, "", pathnameForView(last));
  }, [activeView, cancelPendingPlanner, history, plannerReady, requestPendingPlanner]);
  React.useLayoutEffect(() => {
    const pop = () => {
      const routed = initialViewForPathname(window.location.pathname);
      if (routed === "settings") { setSettingsOpen(true); return; }
      setSettingsOpen(false);
      if (routed === activeViewRef.current) return;
      const previous = activeViewRef.current;
      void flushRecipeSave(activeRecipeRef).then((saved) => {
        if (!saved) { window.history.pushState(null, "", pathnameForView(previous)); return; }
        setHistory([routed]);
        if (routed === "planner" && !plannerReady) requestPendingPlanner("none");
        else { cancelPendingPlanner(); activeViewRef.current = routed; setActiveViewState(routed); }
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
  const handlePlannerReady = React.useCallback((identity: PlannerBoardIdentity) => {
    setPlannerIdentity((current) => current && plannerBoardIdentityKey(current) === plannerBoardIdentityKey(identity) ? current : identity);
  }, []);
  const handlePlannerError = React.useCallback((error: unknown) => {
    const message = formatError(error); setPlannerIdentity(null); setPlannerFailure(message);
    if (plannerIntent.current.pending) { failPlannerNavigation(plannerIntent.current, message); setIntentRevision((value) => value + 1); }
  }, []);
  React.useLayoutEffect(() => {
    if (activeView !== "planner" || !plannerIdentity || plannerTransition <= 0) return;
    const key = `${plannerTransition}:${plannerBoardIdentityKey(plannerIdentity)}`;
    if (!emittedIdentities.current.has(key)) { emittedIdentities.current.add(key); markPlannerSemanticReady(plannerTransition, plannerIdentity); }
  }, [activeView, plannerIdentity, plannerTransition]);
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

  const [shoppingPlan, setShoppingPlan] = React.useState<ShoppingListPlan | null>(null);
  const [shoppingBusy, setShoppingBusy] = React.useState(false);
  const [shoppingError, setShoppingError] = React.useState<string | null>(null);
  const shoppingService = React.useMemo(() => new BuiltInShoppingListService(async (path) => parseRecipe(path, await readText(path))), []);
  const shoppingWork = React.useCallback((work: () => Promise<unknown>) => {
    setShoppingBusy(true); setShoppingError(null);
    return work().catch((error) => { setShoppingError(formatError(error)); throw error; }).finally(() => setShoppingBusy(false));
  }, []);
  const handleSendShopping = React.useCallback((payload: { recipePaths: string[]; weekLabel: string }) => {
    void shoppingWork(async () => { const plan = await shoppingService.previewWeek(payload); await applyShoppingPlan(plan); setShoppingPlan(null); await setActiveView("shopping"); }).catch(() => { void setActiveView("shopping"); });
  }, [setActiveView, shoppingService, shoppingWork]);
  const handleCheckShopping = React.useCallback((id: string, checked: boolean) => {
    const text = getKitchenSnapshot().shopping.items.find((item) => item.id === id)?.content; if (!text) return;
    void shoppingWork(() => toggleShopping(text, id, checked)).catch(() => undefined);
  }, [shoppingWork]);
  const handleRemoveShopping = React.useCallback((id: string) => {
    const text = getKitchenSnapshot().shopping.items.find((item) => item.id === id)?.content; if (!text) return;
    void shoppingWork(() => removeShopping(text, id)).catch(() => undefined);
  }, [shoppingWork]);
  const handleCopyShopping = React.useCallback(() => { void copyShoppingList().then(() => notify("Shopping list copied."), () => notify("Could not copy the shopping list.")); }, []);

  const updatePlanning = React.useCallback(async (path: string, update: (value: RecipePlanning) => RecipePlanning) => {
    const recipe = getKitchenSnapshot().recipes.find((candidate) => candidate.path === path);
    if (!recipe) throw new Error(`Recipe not found: ${path}`);
    await updatePlanRecipe(recipe, update);
  }, []);
  const toggleMarked = React.useCallback((path: string, marked: boolean) => updatePlanning(path, (value) => ({ ...value, marked })), [updatePlanning]);
  const loadDatabaseView = React.useCallback(async (query: Parameters<typeof buildDatabaseView>[2]): Promise<DatabaseView> => {
    const data = getKitchenSnapshot(); return buildDatabaseView(data.recipes, data.plan, query);
  }, []);

  const [activeFile, setActiveFile] = React.useState<KitchenFile | null>(null);
  const [previewFile, setPreviewFile] = React.useState<KitchenFile | null>(null);
  const [previewIsRecipe, setPreviewIsRecipe] = React.useState(false);
  const [previewWidth, setPreviewWidth] = React.useState(420);
  const closePreview = React.useCallback(async () => {
    if (!await flushRecipeSave(previewRecipeRef)) return false;
    setPreviewFile(null); setPreviewIsRecipe(false); return true;
  }, []);
  const openPreview = React.useCallback(async (file: KitchenFile, isRecipe: boolean) => {
    if (!await flushRecipeSave(previewRecipeRef)) return;
    setPreviewFile(file); setPreviewIsRecipe(isRecipe);
  }, []);
  const openPath = React.useCallback(async (path: string, options: { split: boolean }) => {
    const file = getKitchenSnapshot().files.find((candidate) => candidate.path === path); if (!file) return;
    const recipe = getKitchenSnapshot().recipes.some((candidate) => candidate.path === path);
    if (options.split) { await openPreview(file, recipe); return; }
    if (!await closePreview()) return; setActiveFile(file); if (recipe) await setActiveView("recipe");
  }, [closePreview, openPreview, setActiveView]);
  const openRecipe = React.useCallback(async (path: string, split: boolean) => {
    if (activeViewRef.current !== "database") return;
    const file = getKitchenSnapshot().files.find((candidate) => candidate.path === path); if (!file) return;
    if (split) { await openPreview(file, true); return; }
    if (!await closePreview()) return;
    setActiveFile(file); void setActiveView("recipe");
  }, [closePreview, openPreview, setActiveView]);
  const prepareRecipe = React.useCallback((_path: string, cardUrl?: string) => {
    if (cardUrl) { const image = new Image(); image.src = cardUrl; void image.decode().catch(() => undefined); }
  }, []);

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
  const plannerError = plannerCapability.status === "error" ? plannerCapability.message : plannerFailure;
  return <div className="mep-root"><div className={`mep-shell ${previewFile ? "mep-shell--preview-open" : "mep-shell--preview-closed"} ${activeView === "shopping" ? "mep-shell--shopping" : ""}`} style={{ "--mep-preview-width": previewFile ? `${previewWidth}px` : "0px" } as React.CSSProperties}>
    <AppSidebar activeView={settingsOpen ? "settings" : activeView} canGoBack={history.length > 1} onBack={goBack} onNavigate={navigate} onShare={() => setShareOpen(true)} onPreparePlanner={preparePlannerNavigation} onPrepareShopping={() => undefined} />
    <main className={`mep-main ${activeView === "planner" ? "mep-main--planner" : ""} ${activeView === "database" ? "mep-main--database" : ""} ${activeView === "shopping" ? "mep-main--shopping" : ""}`}>
      <h1 className="mep-sr-only">Enplace</h1>
      {plannerError && activeView !== "planner" ? <div className="mep-planner-intent-error" role="alert"><span>Planner failed to load: {plannerError}</span><button type="button" className="mep-button mep-button--ghost" onClick={retryPlanner}>Retry planner</button></div> : null}
      {activeView === "planner" && plannerError ? <div {...({ className: "mep-loading", "data-planner-capability-status": plannerCapability.status, "data-planner-dataset-status": "ready", elementtiming: PLANNER_METADATA_PLACEHOLDER_TIMING } as React.HTMLAttributes<HTMLDivElement>)}><div>Planner failed to load: {plannerError}</div><button type="button" className="mep-button mep-button--ghost" onClick={retryPlanner}>Retry planner</button></div> : null}
      {activeView === "planner" && plannerReady ? <PlannerKitchenView key={plannerBoardRevision} updatePlanning={updatePlanning} notify={notify} onOpenFile={openPath} onSendShoppingList={handleSendShopping} onSaveDayNote={setDayNote} markedWidth={settings.weeklyOrganiserMarkedWidth} onSaveMarkedWidth={(width) => updateSettings({ weeklyOrganiserMarkedWidth: normalizeWeeklyColumnMinWidth(width) })} onUnmarkRecipe={(path) => toggleMarked(path, false)} plannerOrderStore={runtime.plannerOrderStore} onBoardReady={handlePlannerReady} onBoardError={handlePlannerError} /> : null}
      {databaseSeen ? <div className="mep-view" hidden={activeView !== "database"}><DatabaseKitchenView settings={settings} loadView={loadDatabaseView} onOpenRecipe={openRecipe} onPointerDownRecipe={prepareRecipe} onToggleMarked={toggleMarked} onClearMarked={() => clearMarkedRecipes().catch(() => notify("Failed to clear all marked items. The view will resync."))} onPreferencesChange={updateSettings} /></div> : null}
      {activeView === "shopping" ? <ShoppingKitchenView plan={shoppingPlan} busy={shoppingBusy} error={shoppingError} onApply={() => { if (shoppingPlan) void shoppingWork(() => applyShoppingPlan(shoppingPlan)).then(() => setShoppingPlan(null)); }} onCheck={handleCheckShopping} onRefresh={() => undefined} onAdd={(content) => shoppingWork(() => addShoppingItem(content)).then(() => undefined)} onRemove={handleRemoveShopping} onCopyLink={handleCopyShopping} /> : null}
      {activeView === "recipe" && activeFile ? <RecipeKitchenView path={activeFile.path} recipeRef={activeRecipeRef} onDelete={async () => { const path = activeFile.path; if (!await setActiveView("database")) return; await deleteRecipe(path); setActiveFile(null); }} /> : null}
      {settingsOpen ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={closeSettings} /> : null}
      {shareOpen ? <ShareKitchenDialog onClose={() => setShareOpen(false)} /> : null}
    </main>
    {previewFile ? <PreviewKitchenView file={previewFile} isRecipe={previewIsRecipe} width={previewWidth} recipeRef={previewRecipeRef} onClose={() => { void closePreview(); }} onWidth={setPreviewWidth} /> : null}
    <Notices notices={notices} />
    {commandOpen ? <CommandPalette commands={filteredCommands} query={commandQuery} onQuery={setCommandQuery} onClose={() => setCommandOpen(false)} /> : null}
    {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
  </div></div>;
}
export default App;
