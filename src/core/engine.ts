import { HexData, WorldGenConfig, PlanarOverlay, PlanarAlignment, HistoryAction, WorldState, TerrainType, TerrainElement, AxialCoord } from './types';
import { DEFAULT_WORLD_CONFIG, WORLD, PLANAR_DEFAULTS } from './config';
import { applyAction, EMPTY_STATE } from './history';
import { generateWorldGrid, mergeTerrain } from './world';
import { applyOverlaysToMap } from './planar';

// --- TerrainProvider: dependency-inversion interface (no GPU imports in core) ---

export interface TerrainResult {
  readonly terrain: TerrainType;
  readonly element: TerrainElement;
  readonly elevation: number;
  readonly description: string;
}

export interface TerrainProvider {
  setCoords(coords: ReadonlyArray<AxialCoord>): void;
  generate(config: WorldGenConfig, hexCount: number, forceNoRiver?: boolean): Promise<TerrainResult[]>;
  destroy(): void;
}

/**
 * Async state machine for world history. Terrain actions delegate to GPU via TerrainProvider.
 * Non-terrain actions (overlay, reveal, updateHex) remain synchronous.
 * Undo/redo are sync cache navigation — no GPU round-trip.
 */
export class WorldEngine {
  private _actions: HistoryAction[];
  private _cache: WorldState[];
  private _redoStack: HistoryAction[];
  private _hexLookup: Map<string, number>;
  private _provider: TerrainProvider;

  private constructor(
    provider: TerrainProvider,
    actions: HistoryAction[],
    cache: WorldState[],
    redoStack: HistoryAction[],
  ) {
    this._provider = provider;
    this._actions = actions;
    this._cache = cache;
    this._redoStack = redoStack;
    this._hexLookup = WorldEngine._buildLookup(this.state.hexes);
  }

  /**
   * Create a new engine: generates the initial world grid, fills terrain via GPU.
   */
  static async create(provider: TerrainProvider, initialConfig?: WorldGenConfig): Promise<WorldEngine> {
    const config = initialConfig ?? DEFAULT_WORLD_CONFIG;
    const grid = generateWorldGrid(config);

    // Upload coords and generate terrain via GPU
    provider.setCoords(grid.map(h => h.coordinates));
    const results = await provider.generate(config, grid.length);
    const hexes = mergeTerrain(grid, results);

    const airDefaults = PLANAR_DEFAULTS[PlanarAlignment.AIR];
    const defaultOverlay: PlanarOverlay = {
      id: 'PLANE-default',
      type: PlanarAlignment.AIR,
      coordinates: { q: 0, r: 0 },
      radius: airDefaults.radius,
      intensity: airDefaults.intensity,
      falloff: airDefaults.falloff,
      fragmentation: airDefaults.fragmentation,
      lift: airDefaults.lift,
    };
    const overlays = [defaultOverlay];
    const hexesWithOverlay = applyOverlaysToMap(hexes, overlays);

    const action: HistoryAction = { type: 'generateWorld', config };
    const state: WorldState = { hexes: hexesWithOverlay, overlays, config };
    return new WorldEngine(provider, [action], [state], []);
  }

  private static _buildLookup(hexes: readonly HexData[]): Map<string, number> {
    const map = new Map<string, number>();
    for (let i = 0; i < hexes.length; i++) {
      const hex = hexes[i]!;
      map.set(`${hex.coordinates.q},${hex.coordinates.r}`, i);
    }
    return map;
  }

  private _rebuildLookup(): void {
    this._hexLookup = WorldEngine._buildLookup(this.state.hexes);
  }

  // --- Internal: generate world (full regeneration) ---

  private async _generateWorld(config: WorldGenConfig): Promise<WorldState> {
    const grid = generateWorldGrid(config);
    this._provider.setCoords(grid.map(h => h.coordinates));
    const results = await this._provider.generate(config, grid.length);
    const hexes = mergeTerrain(grid, results);
    return { hexes, overlays: [], config };
  }

  // --- Internal: regenerate terrain on existing grid ---

  private async _regenTerrain(
    state: WorldState,
    config: WorldGenConfig,
  ): Promise<WorldState> {
    const currentHexes = state.hexes;

    // Upload coords (may have changed if hex count differs)
    this._provider.setCoords(currentHexes.map(h => h.coordinates));
    const results = await this._provider.generate(config, currentHexes.length);

    const newHexes = currentHexes.map((hex, i) => {
      const r = results[i]!;
      return {
        ...hex,
        terrain: r.terrain,
        element: r.element,
        elevation: r.elevation,
        description: r.description,
        baseDescription: r.description,
        baseTerrain: r.terrain,
        planarAlignment: hex.planarAlignment,
        planarIntensity: 0,
        planarFragmentation: 0.5,
        planarLift: 0.5,
        planarInfluences: [],
        reactionEmission: null,
      };
    });

    const withOverlays = applyOverlaysToMap(newHexes, state.overlays);
    return { hexes: withOverlays, overlays: state.overlays, config };
  }

  // --- Internal: apply action (async for terrain, sync otherwise) ---

  private async _applyActionAsync(state: WorldState, action: HistoryAction): Promise<WorldState> {
    switch (action.type) {
      case 'generateWorld':
        return this._generateWorld(action.config);
      case 'worldConfig':
        return this._regenTerrain(state, action.config);
      default:
        return applyAction(state, action);
    }
  }

  // --- Core state machine ---

  async dispatch(action: HistoryAction): Promise<void> {
    const prevState = this._cache[this._cache.length - 1] ?? EMPTY_STATE;
    const newState = await this._applyActionAsync(prevState, action);
    this._actions.push(action);
    this._cache.push(newState);
    this._redoStack = [];
    this._rebuildLookup();
  }

  undo(): boolean {
    if (this._actions.length <= 1) return false;
    const undone = this._actions.pop()!;
    this._cache.pop();
    this._redoStack.unshift(undone);
    this._rebuildLookup();
    return true;
  }

  redo(): boolean {
    if (this._redoStack.length === 0) return false;
    const action = this._redoStack.shift()!;
    // Redo for terrain actions is handled by re-dispatching async
    // But for cache-based redo, we need the state. For now, sync redo
    // only works for non-terrain actions. Terrain redo falls through.
    const prevState = this._cache[this._cache.length - 1] ?? EMPTY_STATE;
    if (action.type === 'generateWorld' || action.type === 'worldConfig') {
      // Terrain actions can't be sync redo'd — push back and return false
      this._redoStack.unshift(action);
      return false;
    }
    const newState = applyAction(prevState, action);
    this._actions.push(action);
    this._cache.push(newState);
    this._rebuildLookup();
    return true;
  }

  async redoAsync(): Promise<boolean> {
    if (this._redoStack.length === 0) return false;
    const action = this._redoStack.shift()!;
    const prevState = this._cache[this._cache.length - 1] ?? EMPTY_STATE;
    const newState = await this._applyActionAsync(prevState, action);
    this._actions.push(action);
    this._cache.push(newState);
    this._rebuildLookup();
    return true;
  }

  async removeAction(index: number): Promise<void> {
    if (index <= 0 || index >= this._actions.length) return;
    this._actions.splice(index, 1);
    const baseState = this._cache[index - 1] ?? EMPTY_STATE;

    // Async replay from splice point
    const newCache: WorldState[] = [];
    let state = baseState;
    for (let i = index; i < this._actions.length; i++) {
      const action = this._actions[i];
      if (!action) break;
      state = await this._applyActionAsync(state, action);
      newCache.push(state);
    }

    this._cache.splice(index);
    this._cache.push(...newCache);
    this._redoStack = [];
    this._rebuildLookup();
  }

  /**
   * Compute terrain without committing to history. Used for live preview (slider drag).
   */
  async computeTerrain(
    coords: ReadonlyArray<AxialCoord>,
    config: WorldGenConfig,
    forceNoRiver?: boolean,
  ): Promise<TerrainResult[]> {
    this._provider.setCoords(coords);
    return this._provider.generate(config, coords.length, forceNoRiver);
  }

  // --- State queries (readonly) ---

  get state(): WorldState {
    return this._cache[this._cache.length - 1] ?? EMPTY_STATE;
  }

  get hexes(): readonly HexData[] {
    return this.state.hexes;
  }

  get overlays(): readonly PlanarOverlay[] {
    return this.state.overlays;
  }

  get config(): WorldGenConfig {
    return this.state.config;
  }

  get actions(): readonly HistoryAction[] {
    return this._actions;
  }

  get canUndo(): boolean {
    return this._actions.length > 1;
  }

  get canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  // --- Convenience wrappers (delegate to dispatch) ---

  async addOverlay(overlay: PlanarOverlay): Promise<void> {
    await this.dispatch({ type: 'addOverlay', overlay });
  }

  async removeOverlay(id: string): Promise<void> {
    await this.dispatch({ type: 'removeOverlay', overlayId: id });
  }

  async modifyOverlay(overlay: PlanarOverlay): Promise<void> {
    await this.dispatch({ type: 'modifyOverlay', overlay });
  }

  async updateHex(hexId: string, changes: Partial<HexData>): Promise<void> {
    await this.dispatch({ type: 'updateHex', hexId, changes });
  }

  async setWorldConfig(config: WorldGenConfig): Promise<void> {
    await this.dispatch({ type: 'worldConfig', config });
  }

  async importMap(hexes: HexData[]): Promise<void> {
    await this.dispatch({ type: 'importMap', hexes });
  }

  // --- Hex queries ---

  getHex(id: string): HexData | undefined {
    return this.state.hexes.find(h => h.id === id);
  }

  getHexAt(q: number, r: number): HexData | undefined {
    const index = this._hexLookup.get(`${q},${r}`);
    if (index === undefined) return undefined;
    return this.state.hexes[index];
  }

  findHexes(predicate: (hex: HexData) => boolean): HexData[] {
    return this.state.hexes.filter(predicate);
  }

  destroy(): void {
    this._provider.destroy();
  }
}
