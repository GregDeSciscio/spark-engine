import * as THREE from 'three/webgpu';
import type { Inspector as ThreeInspector } from 'three/addons/inspector/Inspector.js';
import type { Parameters, ParametersGroup } from 'three/addons/inspector/tabs/Parameters.js';
import type { Item } from 'three/addons/inspector/ui/Item.js';
import { QUALITY_PRESETS, type QualityPreset } from '../core/Config';
import type { Disposable } from '../core/Disposable';
import type { Engine } from '../core/Engine';
import { Logger } from '../core/Logger';
import { Animator } from '../animation/Animator';
import type { Entity } from '../ecs/EntityWorld';
import { DEBUG_VIEW_NAMES, POST_EFFECT_NAMES, type DebugViewName, type PostEffectName } from '../rendering/RenderPipeline';
import type { DebugSnapshot } from './DebugStats';
import { BoundsDebugRenderer } from './DebugViews';
import {
  InspectorState,
  countScene,
  debugViewOptions,
  engineRows,
  formatCount,
  formatMs,
  postRows,
  sortComponentCounts,
  topSystems,
  type CountableObject,
} from './InspectorModel';

/** Repaint cadence of the engine panels, ms. The addon repaints its own tabs on its own cycle. */
const REFRESH_INTERVAL_MS = 250;
/** Systems listed in the Entities panel. */
const TOP_SYSTEMS = 8;
/** Hierarchy rows the Scene panel will build before it truncates. */
const MAX_HIERARCHY_ROWS = 1500;

// ---- the addon's untyped surface ------------------------------------------------
// @types/three covers the Inspector, Parameters and Item constructors; the
// members below are real on the r185 JS classes but missing from the typings.

interface TabLike {
  readonly id: string;
  readonly isActive: boolean;
}

interface ItemLike {
  add(item: Item, index?: number): ItemLike;
  remove(item: Item): ItemLike;
  setCollapsible(collapsible: boolean): ItemLike;
  close(): ItemLike;
}

interface EditorLike {
  setValue(value: unknown): void;
  getValue(): unknown;
}

interface ProfilerLike {
  readonly panel: HTMLElement;
  readonly activeTabId: string | null;
  togglePanel(): void;
}

interface AddonModules {
  readonly Inspector: new () => ThreeInspector;
  readonly Parameters: new (options: { name: string }) => Parameters;
  readonly Item: new (...data: unknown[]) => Item;
}

async function loadAddon(): Promise<AddonModules> {
  const [inspector, parameters, item] = await Promise.all([
    import('three/addons/inspector/Inspector.js'),
    import('three/addons/inspector/tabs/Parameters.js'),
    import('three/addons/inspector/ui/Item.js'),
  ]);
  return {
    Inspector: inspector.Inspector,
    Parameters: parameters.Parameters as unknown as AddonModules['Parameters'],
    Item: item.Item,
  };
}

/** Label/value rows inside a parameters group, created on first `set`, removed by `prune`. */
class RowTable {
  private readonly rows = new Map<string, { item: Item; value: HTMLSpanElement; last: string }>();

  constructor(
    private readonly addon: AddonModules,
    private readonly parent: Item,
  ) {}

  set(label: string, text: string): void {
    let row = this.rows.get(label);
    if (!row) {
      const value = document.createElement('span');
      value.className = 'value';
      const item = new this.addon.Item(label, value);
      (this.parent as unknown as ItemLike).add(item);
      row = { item, value, last: '' };
      this.rows.set(label, row);
    }
    if (row.last !== text) {
      row.last = text;
      row.value.textContent = text;
    }
  }

  /** Remove every row whose label is not in `keep`. */
  prune(keep: ReadonlySet<string>): void {
    for (const [label, row] of this.rows) {
      if (keep.has(label)) continue;
      (this.parent as unknown as ItemLike).remove(row.item);
      this.rows.delete(label);
    }
  }

  clear(): void {
    this.prune(new Set());
  }
}

/**
 * The engine inspector (kickoff §25): three's `Inspector` addon, attached to
 * the renderer, with engine panels added as tabs next to the addon's own
 * Performance / Memory / Timeline / Console / Settings tabs. Engine, Post,
 * Entities, Physics, Animation, VFX and Scene are `Parameters` tabs built with
 * the addon's UI so they look and behave like the built-in ones.
 *
 * Created only on demand (`?inspector=1` or F2): the addon is a dynamic import,
 * nothing is allocated while it is off, and hiding it detaches it from the
 * renderer so a hidden inspector costs no per-frame work either.
 */
export class SparkInspector implements Disposable {
  /** The three.js Inspector instance (render-pass views, profiler, console). */
  readonly three: ThreeInspector;
  readonly state = new InspectorState();

  private readonly log = new Logger('inspector');
  private readonly engine: Engine;
  private readonly addon: AddonModules;
  private readonly tabs: Parameters[] = [];
  private readonly bounds = new BoundsDebugRenderer();
  private removeBoundsSystem: (() => void) | null = null;
  private visibleValue = false;
  private lastRefresh = 0;
  private disposed = false;

  // panel state
  private engineTab!: Parameters;
  private postTab!: Parameters;
  private entitiesTab!: Parameters;
  private physicsTab!: Parameters;
  private animationTab!: Parameters;
  private vfxTab!: Parameters;
  private sceneTab!: Parameters;
  private engineRowsTable!: RowTable;
  private viewsRows!: RowTable;
  private presetEditor!: EditorLike;
  private presetModel!: { preset: QualityPreset };
  private viewEditor!: EditorLike;
  private viewModel!: { view: string };
  private effectEditors = new Map<PostEffectName, EditorLike>();
  private effectFlags!: Record<PostEffectName, boolean>;
  private scaleEditor!: EditorLike;
  private scaleModel!: { renderScale: number; dynamicResolution: boolean };
  private dynamicEditor!: EditorLike;
  private focusModel!: { distance: number; range: number };
  private focusEditors: EditorLike[] = [];
  private postRowsTable!: RowTable;
  private entityRows!: RowTable;
  private componentRows!: RowTable;
  private systemRows!: RowTable;
  private physicsRows!: RowTable;
  private collidersEditor!: EditorLike;
  private boundsEditor!: EditorLike;
  private animationRows!: RowTable;
  private selectedRows!: RowTable;
  private paramRows!: RowTable;
  private vfxRows!: RowTable;
  private sceneRows!: RowTable;
  private hierarchyGroup!: ParametersGroup;
  private hierarchyItems: Item[] = [];
  private hierarchyFor: THREE.Scene | null = null;
  private hierarchyDirty = true;

  private constructor(engine: Engine, addon: AddonModules, inspector: ThreeInspector) {
    this.engine = engine;
    this.addon = addon;
    this.three = inspector;
  }

  /** Load the addon, attach it to the renderer, build the engine tabs. Hidden until `setVisible(true)`. */
  static async create(engine: Engine): Promise<SparkInspector> {
    const addon = await loadAddon();
    const inspector = new addon.Inspector();
    const instance = new SparkInspector(engine, addon, inspector);
    instance.build();
    return instance;
  }

  get visible(): boolean {
    return this.visibleValue;
  }

  /**
   * Show (attaching to the renderer) or hide (detaching, so nothing runs per
   * frame). The addon's own panel toggle only collapses its window.
   */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visibleValue) return;
    this.visibleValue = visible;
    const renderer = this.engine.renderer.three;
    if (visible) {
      renderer.inspector = this.three;
      // three only calls init() from renderer.init(); assigning afterwards
      // means we mount the panel ourselves (init is idempotent for the DOM).
      this.three.init();
      this.three.domElement.style.display = '';
      const profiler = (this.three as unknown as { profiler: ProfilerLike }).profiler;
      if (!profiler.panel.classList.contains('visible')) profiler.togglePanel();
      if (profiler.activeTabId === null || profiler.activeTabId === 'performance') this.three.setActiveTab(this.engineTab);
      this.syncOverlayParents();
      this.refresh(this.engine.stats?.snapshot() ?? null, true);
    } else {
      this.three.domElement.style.display = 'none';
      renderer.inspector = new THREE.InspectorBase();
      // The setter nulled the addon's renderer, but its timestamp resolve is a pending
      // requestAnimationFrame that dereferences it (`nodeFrame`). Point it back: nothing
      // schedules new work once the renderer stops calling begin()/finish().
      this.three.setRenderer(renderer);
    }
  }

  /** Pick the entity the Animation panel describes (scenes call this for their hero). */
  select(eid: Entity | null): void {
    this.state.selected = eid;
  }

  /** Once per frame from the engine, after the stats snapshot. Repaints the active panel at a fixed cadence. */
  update(snapshot: DebugSnapshot | null): void {
    if (this.disposed || !this.visibleValue) return;
    this.syncOverlayParents();
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;
    this.refresh(snapshot, false);
  }

  // ---- building ------------------------------------------------------------------

  private build(): void {
    this.buildEngineTab();
    this.buildPostTab();
    this.buildEntitiesTab();
    this.buildPhysicsTab();
    this.buildAnimationTab();
    this.buildVfxTab();
    this.buildSceneTab();
    for (const tab of this.tabs) this.three.addTab(tab);
    this.three.domElement.style.display = 'none';
    this.log.info('ready (F2 toggles)');
  }

  private tab(name: string): Parameters {
    const tab = new this.addon.Parameters({ name });
    this.tabs.push(tab);
    return tab;
  }

  private buildEngineTab(): void {
    const engine = this.engine;
    this.engineTab = this.tab('Engine');
    const quality = this.engineTab.createGroup('Quality');
    this.presetModel = { preset: engine.getQuality().preset };
    this.presetEditor = quality
      .add(this.presetModel, 'preset', QUALITY_PRESETS)
      .name('Preset')
      .onChange((preset) => {
        if (preset !== engine.getQuality().preset) engine.setQuality(preset);
      }) as unknown as EditorLike;

    const views = this.engineTab.createGroup('Debug views');
    this.viewModel = { view: 'none' };
    this.viewEditor = views
      .add(this.viewModel, 'view', debugViewOptions(DEBUG_VIEW_NAMES))
      .name('Buffer')
      .onChange((view) => this.applyDebugView(view)) as unknown as EditorLike;
    this.viewsRows = new RowTable(this.addon, views.paramList);

    const frame = this.engineTab.createGroup('Frame');
    this.engineRowsTable = new RowTable(this.addon, frame.paramList);
  }

  private buildPostTab(): void {
    const renderer = this.engine.renderer;
    const pipeline = renderer.pipeline;
    this.postTab = this.tab('Post');

    const effects = this.postTab.createGroup('Effects');
    const flags = {} as Record<PostEffectName, boolean>;
    for (const state of pipeline.getEffects()) flags[state.name] = state.enabled;
    this.effectFlags = flags;
    for (const name of POST_EFFECT_NAMES) {
      const editor = effects
        .add(flags, name)
        .name(name)
        .onChange((enabled) => pipeline.setEffectEnabled(name, enabled)) as unknown as EditorLike;
      this.effectEditors.set(name, editor);
    }

    const resolution = this.postTab.createGroup('Resolution');
    this.scaleModel = { renderScale: renderer.getRenderScale(), dynamicResolution: renderer.dynamicResolution.enabled };
    this.scaleEditor = resolution
      .add(this.scaleModel, 'renderScale', 0.25, 1, 0.05)
      .name('Render scale')
      .onChange((scale) => {
        if (!renderer.dynamicResolution.enabled) renderer.setRenderScale(scale);
      }) as unknown as EditorLike;
    this.dynamicEditor = resolution
      .add(this.scaleModel, 'dynamicResolution')
      .name('Dynamic resolution')
      .onChange((enabled) => renderer.setDynamicResolutionEnabled(enabled)) as unknown as EditorLike;

    const focus = this.postTab.createGroup('Depth of field');
    const current = pipeline.getFocus();
    this.focusModel = { distance: current.distance, range: current.range };
    const apply = (): void => pipeline.setFocus(this.focusModel.distance, this.focusModel.range);
    this.focusEditors = [
      focus.add(this.focusModel, 'distance', 0.1, 80, 0.1).name('Focus distance').onChange(apply) as unknown as EditorLike,
      focus.add(this.focusModel, 'range', 0.1, 30, 0.1).name('Focus range').onChange(apply) as unknown as EditorLike,
    ];

    const active = this.postTab.createGroup('Active graph');
    this.postRowsTable = new RowTable(this.addon, active.paramList);
  }

  private buildEntitiesTab(): void {
    this.entitiesTab = this.tab('Entities');
    const world = this.entitiesTab.createGroup('World');
    this.entityRows = new RowTable(this.addon, world.paramList);
    this.boundsEditor = world
      .add(this.state, 'bounds')
      .name('Bounding spheres')
      .onChange((enabled) => this.setBounds(enabled)) as unknown as EditorLike;
    const components = this.entitiesTab.createGroup('Components');
    this.componentRows = new RowTable(this.addon, components.paramList);
    const systems = this.entitiesTab.createGroup(`Systems (top ${TOP_SYSTEMS} by ms)`);
    this.systemRows = new RowTable(this.addon, systems.paramList);
  }

  private buildPhysicsTab(): void {
    this.physicsTab = this.tab('Physics');
    const world = this.physicsTab.createGroup('World');
    this.physicsRows = new RowTable(this.addon, world.paramList);
    this.collidersEditor = world
      .add(this.state, 'colliders')
      .name('Collider wireframes')
      .onChange((enabled) => this.setColliders(enabled)) as unknown as EditorLike;
  }

  private buildAnimationTab(): void {
    this.animationTab = this.tab('Animation');
    const world = this.animationTab.createGroup('World');
    this.animationRows = new RowTable(this.addon, world.paramList);
    const selected = this.animationTab.createGroup('Selected entity');
    this.selectedRows = new RowTable(this.addon, selected.paramList);
    const params = this.animationTab.createGroup('Parameters');
    this.paramRows = new RowTable(this.addon, params.paramList);
  }

  private buildVfxTab(): void {
    this.vfxTab = this.tab('VFX');
    const particles = this.vfxTab.createGroup('GPU particles');
    this.vfxRows = new RowTable(this.addon, particles.paramList);
  }

  private buildSceneTab(): void {
    this.sceneTab = this.tab('Scene');
    const summary = this.sceneTab.createGroup('Summary');
    this.sceneRows = new RowTable(this.addon, summary.paramList);
    const actions = { refresh: (): void => this.markHierarchyDirty() };
    summary.add(actions, 'refresh').name('Refresh hierarchy');
    this.hierarchyGroup = this.sceneTab.createGroup('Hierarchy');
  }

  // ---- refresh -------------------------------------------------------------------

  private isActive(tab: Parameters): boolean {
    return (tab as unknown as TabLike).isActive;
  }

  private refresh(snapshot: DebugSnapshot | null, all: boolean): void {
    if (all || this.isActive(this.engineTab)) this.refreshEngine(snapshot);
    if (all || this.isActive(this.postTab)) this.refreshPost();
    if (all || this.isActive(this.entitiesTab)) this.refreshEntities();
    if (all || this.isActive(this.physicsTab)) this.refreshPhysics();
    if (all || this.isActive(this.animationTab)) this.refreshAnimation();
    if (all || this.isActive(this.vfxTab)) this.refreshVfx();
    if (all || this.isActive(this.sceneTab)) this.refreshScene();
  }

  private refreshEngine(snapshot: DebugSnapshot | null): void {
    const engine = this.engine;
    const preset = engine.getQuality().preset;
    if (this.presetModel.preset !== preset) {
      this.presetModel.preset = preset;
      this.presetEditor.setValue(preset);
    }
    const pipeline = engine.renderer.pipeline;
    const current = pipeline.getDebugView() ?? 'none';
    if (this.viewModel.view !== current) {
      this.viewModel.view = current;
      this.viewEditor.setValue(current);
    }
    this.viewsRows.set('Available', pipeline.getAvailableDebugViews().join(' ') || 'none');
    const adapter = engine.renderer.capabilities.adapter;
    const rows = engineRows(snapshot, {
      state: engine.state,
      fixedStepHz: engine.config.fixedStepHz,
      adapter: adapter ? `${adapter.vendor} ${adapter.architecture} ${adapter.device}`.trim() : null,
    });
    for (const [label, value] of rows) this.engineRowsTable.set(label, value);
  }

  private refreshPost(): void {
    const renderer = this.engine.renderer;
    const pipeline = renderer.pipeline;
    for (const row of postRows(pipeline.getEffects())) {
      const name = row.name as PostEffectName;
      if (this.effectFlags[name] !== row.enabled) {
        this.effectFlags[name] = row.enabled;
        this.effectEditors.get(name)?.setValue(row.enabled);
      }
    }
    const scale = renderer.getRenderScale();
    if (Math.abs(this.scaleModel.renderScale - scale) > 1e-3) {
      this.scaleModel.renderScale = scale;
      this.scaleEditor.setValue(scale);
    }
    const dynamic = renderer.dynamicResolution.enabled;
    if (this.scaleModel.dynamicResolution !== dynamic) {
      this.scaleModel.dynamicResolution = dynamic;
      this.dynamicEditor.setValue(dynamic);
    }
    const focus = pipeline.getFocus();
    if (Math.abs(this.focusModel.distance - focus.distance) > 1e-3) {
      this.focusModel.distance = focus.distance;
      this.focusEditors[0]?.setValue(focus.distance);
    }
    if (Math.abs(this.focusModel.range - focus.range) > 1e-3) {
      this.focusModel.range = focus.range;
      this.focusEditors[1]?.setValue(focus.range);
    }
    const stats = pipeline.stats();
    this.postRowsTable.set('Active', stats.active.join(' ') || 'none');
    this.postRowsTable.set('Scene passes', String(stats.scenePasses));
    this.postRowsTable.set('Scene size', `${stats.sceneWidth}x${stats.sceneHeight}`);
    const unavailable = pipeline
      .getEffects()
      .filter((e) => !e.available)
      .map((e) => e.name);
    this.postRowsTable.set('Unavailable here', unavailable.join(' ') || 'none');
  }

  private refreshEntities(): void {
    const entities = this.engine.entities;
    this.entityRows.set('Entities', `${entities.count} / ${entities.capacity}`);
    this.entityRows.set('Systems', String(entities.systems.list().length));
    const counts = sortComponentCounts(entities.componentTypes().map((type) => ({ name: type.name, count: entities.query(type).length })));
    const keep = new Set<string>();
    for (const { name, count } of counts) {
      keep.add(name);
      this.componentRows.set(name, String(count));
    }
    this.componentRows.prune(keep);
    const top = topSystems(entities.systems.lastTimings(), TOP_SYSTEMS);
    const keepSystems = new Set<string>();
    for (const { name, ms } of top) {
      keepSystems.add(name);
      this.systemRows.set(name, formatMs(ms));
    }
    this.systemRows.prune(keepSystems);
  }

  private refreshPhysics(): void {
    const physics = this.engine.physics;
    const g = physics.gravity;
    this.physicsRows.set('Bodies', String(physics.bodyCount));
    this.physicsRows.set('Fixed steps', String(physics.steps));
    this.physicsRows.set('Gravity', `${g.x.toFixed(2)} ${g.y.toFixed(2)} ${g.z.toFixed(2)}`);
  }

  private refreshAnimation(): void {
    const animation = this.engine.animation;
    const stats = animation.stats();
    this.animationRows.set('Animators', String(stats.animators));
    this.animationRows.set('Prepared clips', String(stats.preparedClips));
    // Explicit selection wins; otherwise the first animated entity (the hero in every benchmark scene so far).
    let eid = this.state.selected;
    if (eid === null || !animation.has(eid)) eid = this.engine.entities.query(Animator)[0] ?? null;
    const keep = new Set<string>();
    const keepParams = new Set<string>();
    if (eid !== null && animation.has(eid)) {
      keep.add('Entity');
      this.selectedRows.set('Entity', String(eid));
      const graph = animation.graphOf(eid);
      const layers = graph?.layers ?? [];
      layers.forEach((layer, index) => {
        const snap = animation.snapshot(eid, index);
        const label = `Layer ${index} (${layer.name})`;
        keep.add(label);
        this.selectedRows.set(label, `${snap.state}${snap.transitioning ? ' ~' : ''}  t=${snap.normalizedTime.toFixed(2)} w=${snap.weight.toFixed(2)}`);
      });
      const last = animation.lastEvent(eid);
      keep.add('Last event');
      this.selectedRows.set('Last event', last ? `${last.name} @ ${last.time.toFixed(2)}s (${last.clip})` : '-');
      for (const name of Object.keys(graph?.params ?? {})) {
        keepParams.add(name);
        this.paramRows.set(name, animation.getParam(eid, name).toFixed(3));
      }
    } else {
      keep.add('Entity');
      this.selectedRows.set('Entity', 'none (no animators; scenes may call inspector.select(eid))');
    }
    this.selectedRows.prune(keep);
    this.paramRows.prune(keepParams);
  }

  private refreshVfx(): void {
    const stats = this.engine.vfx.stats();
    this.vfxRows.set('Available', stats.available ? 'yes' : 'no (WebGL2 tier)');
    this.vfxRows.set('Emitters', `${stats.enabled} / ${stats.emitters} enabled`);
    this.vfxRows.set('Capacity', formatCount(stats.capacity));
    this.vfxRows.set('Live (estimate)', formatCount(stats.live));
    this.vfxRows.set('Compute', formatMs(stats.computeMs));
    this.vfxRows.set('Dispatches', String(stats.dispatches));
  }

  private refreshScene(): void {
    const live = this.engine.world.scene;
    const scene = live?.scene ?? null;
    this.sceneRows.set('Scene', this.engine.world.sceneName ?? 'none');
    if (!scene) {
      this.sceneRows.set('Objects', '0');
      this.clearHierarchy();
      return;
    }
    const counts = countScene(scene as unknown as CountableObject);
    this.sceneRows.set('Objects', String(counts.objects));
    this.sceneRows.set('Meshes', String(counts.meshes));
    this.sceneRows.set('Lights', String(counts.lights));
    this.sceneRows.set('Triangles (geometry)', formatCount(counts.triangles));
    if (this.hierarchyDirty || this.hierarchyFor !== scene) this.buildHierarchy(scene);
  }

  // ---- hierarchy ------------------------------------------------------------------

  private markHierarchyDirty(): void {
    this.hierarchyDirty = true;
  }

  private clearHierarchy(): void {
    const parent = this.hierarchyGroup.paramList as unknown as ItemLike;
    for (const item of this.hierarchyItems) parent.remove(item);
    this.hierarchyItems = [];
    this.hierarchyFor = null;
  }

  private buildHierarchy(scene: THREE.Scene): void {
    this.clearHierarchy();
    this.hierarchyDirty = false;
    this.hierarchyFor = scene;
    let rows = 0;
    const describe = (o: THREE.Object3D): string => {
      const mesh = o as THREE.Mesh;
      let extra = '';
      if (mesh.isMesh && mesh.geometry) {
        const g = mesh.geometry;
        const vertices = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
        extra = ` ${formatCount(Math.floor(vertices / 3))} tris`;
        const inst = o as THREE.InstancedMesh;
        if (inst.isInstancedMesh) extra += ` x${inst.count}`;
      }
      const light = o as THREE.Light;
      if (light.isLight) extra = ` ${light.intensity}`;
      return `${o.type}${extra}${o.visible ? '' : ' (hidden)'}`;
    };
    const add = (parent: ItemLike, o: THREE.Object3D): void => {
      if (rows >= MAX_HIERARCHY_ROWS) return;
      rows++;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = describe(o);
      const item = new this.addon.Item(o.name || `(${o.type})`, value);
      parent.add(item);
      if (o.children.length > 0) {
        const itemLike = item as unknown as ItemLike;
        itemLike.setCollapsible(true);
        itemLike.close();
        for (const child of o.children) add(itemLike, child);
      }
    };
    const root = this.hierarchyGroup.paramList as unknown as ItemLike;
    for (const child of scene.children) {
      const before = this.hierarchyItemsCount(root);
      add(root, child);
      void before;
    }
    // Everything we added hangs off the group's item; remember the top-level ones for removal.
    const group = this.hierarchyGroup.paramList as unknown as { children: Item[] };
    this.hierarchyItems = [...group.children];
    if (rows >= MAX_HIERARCHY_ROWS) {
      const note = new this.addon.Item(`... truncated at ${MAX_HIERARCHY_ROWS} rows`, '');
      root.add(note);
      this.hierarchyItems.push(note);
    }
  }

  private hierarchyItemsCount(root: ItemLike): number {
    return (root as unknown as { children: Item[] }).children.length;
  }

  // ---- debug views ------------------------------------------------------------------

  private applyDebugView(view: string): void {
    const pipeline = this.engine.renderer.pipeline;
    const resolved = this.state.setDebugView(view, DEBUG_VIEW_NAMES);
    pipeline.setDebugView(resolved as DebugViewName | null);
  }

  private setColliders(enabled: boolean): void {
    this.state.colliders = enabled;
    const engine = this.engine;
    const renderer = engine.physics.debugRenderer;
    if (!engine.entities.systems.has(renderer.name)) engine.entities.addSystem(renderer);
    renderer.setEnabled(enabled);
    this.syncOverlayParents();
  }

  private setBounds(enabled: boolean): void {
    this.state.bounds = enabled;
    if (enabled && !this.removeBoundsSystem) this.removeBoundsSystem = this.engine.entities.addSystem(this.bounds);
    this.bounds.setEnabled(enabled);
    this.syncOverlayParents();
  }

  /** Keep the overlay objects in whichever scene is live. */
  private syncOverlayParents(): void {
    const live = this.engine.world.scene?.scene ?? null;
    if (!live) return;
    if (this.state.bounds && this.bounds.object.parent !== live) live.add(this.bounds.object);
    if (this.state.colliders) {
      const object = this.engine.physics.debugRenderer.object;
      if (object.parent !== live) live.add(object);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.setVisible(false);
    this.disposed = true;
    const engine = this.engine;
    try {
      engine.renderer.pipeline.setDebugView(null);
    } catch {
      // renderer already gone
    }
    if (this.state.colliders) {
      try {
        const renderer = engine.physics.debugRenderer;
        renderer.setEnabled(false);
        renderer.object.removeFromParent();
      } catch {
        // physics already gone
      }
    }
    this.removeBoundsSystem?.();
    this.removeBoundsSystem = null;
    this.bounds.dispose();
    for (const tab of this.tabs) this.three.removeTab(tab);
    this.tabs.length = 0;
    this.three.domElement.remove();
    // The addon routed three's warnings through its Console tab; null restores the default (typed non-null upstream).
    (THREE.setConsoleFunction as unknown as (fn: null) => void)(null);
    this.log.debug('disposed');
  }
}
