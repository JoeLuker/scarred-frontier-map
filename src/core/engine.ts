import { HexData, WorldGenConfig, PlanarOverlay, HistoryAction, WorldState } from './types';
import { DEFAULT_WORLD_CONFIG } from './config';
import { applyAction, EMPTY_STATE, replayFrom } from './history';

/**
 * Pure state machine for world history. No React, no GPU — just actions, cache, and queries.
 * Synchronous. Suitable for headless tests, CLI tools, and scripted scenarios.
 */
export class WorldEngine {
  private _actions: HistoryAction[];
  private _cache: WorldState[];       // cache[i] = state after actions[0..i]
  private _redoStack: HistoryAction[];
  private _hexLookup: Map<string, number>;  // "q,r" → index in hexes[]

  private constructor(actions: HistoryAction[], cache: WorldState[], redoStack: HistoryAction[]) {
    this._actions = actions;
    this._cache = cache;
    this._redoStack = redoStack;
    this._hexLookup = WorldEngine._buildLookup(this.state.hexes);
  }

  static create(initialConfig?: WorldGenConfig): WorldEngine {
    const config = initialConfig ?? DEFAULT_WORLD_CONFIG;
    const action: HistoryAction = { type: 'generateWorld', config };
    const state = applyAction(EMPTY_STATE, action);
    return new WorldEngine([action], [state], []);
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

  // --- Core state machine ---

  dispatch(action: HistoryAction): void {
    const prevState = this._cache[this._cache.length - 1] ?? EMPTY_STATE;
    const newState = applyAction(prevState, action);
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
    const prevState = this._cache[this._cache.length - 1] ?? EMPTY_STATE;
    const newState = applyAction(prevState, action);
    this._actions.push(action);
    this._cache.push(newState);
    this._rebuildLookup();
    return true;
  }

  removeAction(index: number): void {
    if (index <= 0 || index >= this._actions.length) return;
    this._actions.splice(index, 1);
    const baseState = this._cache[index - 1] ?? EMPTY_STATE;
    const replayedCache = replayFrom(baseState, this._actions, index);
    this._cache.splice(index);
    this._cache.push(...replayedCache);
    this._redoStack = [];
    this._rebuildLookup();
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

  addOverlay(overlay: PlanarOverlay): void {
    this.dispatch({ type: 'addOverlay', overlay });
  }

  removeOverlay(id: string): void {
    this.dispatch({ type: 'removeOverlay', overlayId: id });
  }

  modifyOverlay(overlay: PlanarOverlay): void {
    this.dispatch({ type: 'modifyOverlay', overlay });
  }

  revealSector(groupId: string): void {
    this.dispatch({ type: 'revealSector', groupId });
  }

  revealAll(): void {
    this.dispatch({ type: 'revealAll' });
  }

  updateHex(hexId: string, changes: Partial<HexData>): void {
    this.dispatch({ type: 'updateHex', hexId, changes });
  }

  setWorldConfig(config: WorldGenConfig, preserveExplored: boolean): void {
    this.dispatch({ type: 'worldConfig', config, preserveExplored });
  }

  importMap(hexes: HexData[]): void {
    this.dispatch({ type: 'importMap', hexes });
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
}
