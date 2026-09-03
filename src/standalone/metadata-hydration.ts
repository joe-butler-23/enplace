type DatabaseQueryGeneration = {
  queryKey: string;
  items: readonly unknown[] | null;
  released: boolean;
};

/** Owns the exact database query/items generation allowed to release deferred metadata work. */
export class DatabaseMetadataHydrationGate {
  private current: DatabaseQueryGeneration | null = null;

  begin(queryKey: string): DatabaseQueryGeneration {
    const generation = { queryKey, items: null, released: false };
    this.current = generation;
    return generation;
  }

  invalidate(): void {
    this.current = null;
  }

  completeSource(
    generation: DatabaseQueryGeneration,
    items: readonly unknown[]
  ): boolean {
    if (this.current !== generation) return false;
    generation.items = items;
    return items.length === 0 && this.release(generation);
  }

  failSource(generation: DatabaseQueryGeneration): boolean {
    return this.release(generation);
  }

  isAwaitingFirstTranche(queryKey: string, items: readonly unknown[]): boolean {
    return this.owns(queryKey, items) && !this.current!.released;
  }

  completeFirstTrancheScheduling(queryKey: string, items: readonly unknown[]): boolean {
    return this.releaseOwned(queryKey, items);
  }

  failFirstTrancheScheduling(queryKey: string, items: readonly unknown[]): boolean {
    return this.releaseOwned(queryKey, items);
  }

  private releaseOwned(queryKey: string, items: readonly unknown[]): boolean {
    return this.owns(queryKey, items) && this.release(this.current!);
  }

  private release(generation: DatabaseQueryGeneration): boolean {
    if (this.current !== generation || generation.released) return false;
    generation.released = true;
    return true;
  }

  private owns(queryKey: string, items: readonly unknown[]): boolean {
    return this.current?.queryKey === queryKey && this.current.items === items;
  }
}
