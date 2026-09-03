import * as React from "react";
import { CookingDatabase, type DatabaseState } from "./CookingDatabase";
import type { RecipeIndexQuery } from "@/modules/cooking/types";
import type { DatabaseView } from "./database-query";
import { databaseQuery, initialDatabaseState } from "./database-query";
import type { StandaloneSettings } from "@/standalone/settings";

type DatabasePanelProps = {
  settings: StandaloneSettings;
  revision: number;
  initialView?: DatabaseView;
  loadView: (query: RecipeIndexQuery) => Promise<DatabaseView>;
  resolveCover: (coverPath: string | null, sourcePath: string) => string | null;
  onOpenRecipe: (path: string, split: boolean) => void;
  onPointerDownRecipe?: (path: string, coverUrl?: string) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
  onClearMarked: () => Promise<void>;
  onPreferencesChange: (updates: Partial<StandaloneSettings>) => void | Promise<void>;
};


type ViewRequest = { identity: string; query: RecipeIndexQuery };

const EMPTY_DATABASE_VIEW: DatabaseView = { items: [], total: 0, availableTags: [], markedCount: 0 };

export function DatabasePanel({ settings, revision, initialView, loadView, resolveCover, onOpenRecipe,
  onPointerDownRecipe, onToggleMarked, onClearMarked, onPreferencesChange
}: DatabasePanelProps): React.JSX.Element | null {
  const [state, setState] = React.useState<DatabaseState>(() => initialDatabaseState(settings));
  const [view, setView] = React.useState(initialView ?? EMPTY_DATABASE_VIEW);
  const [pending, setPending] = React.useState(initialView === undefined);
  const [published, setPublished] = React.useState(initialView !== undefined);
  const [sourceError, setSourceError] = React.useState<string | null>(null);
  const initialViewRef = React.useRef(initialView);
  const activeRequestRef = React.useRef<ViewRequest | null>(null);
  const queuedRequestRef = React.useRef<ViewRequest | null>(null);
  const desiredIdentityRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setState((current) => {
      if (
        current.sort === settings.databaseSort
        && current.marked === settings.databaseMarkedFilter
        && current.scheduled === settings.databaseScheduledFilter
      ) return current;
      return {
        ...current,
        sort: settings.databaseSort,
        marked: settings.databaseMarkedFilter,
        scheduled: settings.databaseScheduledFilter,
      };
    });
  }, [settings.databaseMarkedFilter, settings.databaseScheduledFilter, settings.databaseSort]);

  const handleStateChange = React.useCallback((next: DatabaseState) => {
    setState(next);
    if (
      next.sort !== settings.databaseSort
      || next.marked !== settings.databaseMarkedFilter
      || next.scheduled !== settings.databaseScheduledFilter
    ) {
      void onPreferencesChange({
        databaseSort: next.sort,
        databaseMarkedFilter: next.marked,
        databaseScheduledFilter: next.scheduled,
      });
    }
  }, [onPreferencesChange, settings.databaseMarkedFilter, settings.databaseScheduledFilter, settings.databaseSort]);

  const runRequest = React.useCallback((request: ViewRequest) => {
    activeRequestRef.current = request;
    void loadView(request.query).then((next) => {
      if (request.identity !== desiredIdentityRef.current) return;
      setView(next);
      setPending(false);
      setPublished(true);
      setSourceError(null);
    }, (error: unknown) => {
      if (request.identity !== desiredIdentityRef.current) return;
      setPending(false);
      setPublished(true);
      setSourceError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (activeRequestRef.current !== request) return;
      activeRequestRef.current = null;
      const queued = queuedRequestRef.current;
      queuedRequestRef.current = null;
      if (queued) runRequest(queued);
    });
  }, [loadView]);

  React.useEffect(() => {
    return () => {
      desiredIdentityRef.current = null;
      queuedRequestRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const seeded = initialViewRef.current;
    if (seeded) {
      initialViewRef.current = undefined;
      return;
    }
    const query = databaseQuery(settings, state);
    const request = { identity: JSON.stringify([revision, query]), query };
    if (desiredIdentityRef.current === request.identity) return;
    desiredIdentityRef.current = request.identity;
    setPending(true);
    setSourceError(null);
    if (activeRequestRef.current) queuedRequestRef.current = request;
    else runRequest(request);
  }, [revision, runRequest, settings, state]);

  if (!published) return null;
  return <div className="mep-database-panel"><CookingDatabase
    recipes={view.items} totalCount={view.total} markedCount={view.markedCount}
    availableTags={view.availableTags} state={state}
    onStateChange={handleStateChange} onSearchChange={(search) => setState((prev) => prev.search === search ? prev : { ...prev, search })}
    onOpenRecipe={onOpenRecipe} onPointerDownRecipe={onPointerDownRecipe}
    onToggleMarked={onToggleMarked} onClearMarked={onClearMarked}
    resolveCover={resolveCover} isPending={pending} sourceError={sourceError}
  /></div>;
}
