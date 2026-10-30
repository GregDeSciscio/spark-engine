import {
  Detour,
  NavMesh,
  NavMeshParams,
  NavMeshQuery,
  Raw,
  RecastBuildContext,
  RecastChunkyTriMesh,
  TrianglesArray,
  VerticesArray,
  exportNavMesh,
  importNavMesh,
  init as initRecastRaw,
  setRandomSeed,
  statusFailed,
  type OffMeshConnectionParams,
} from '@recast-navigation/core';
import { buildTiledNavMeshRcConfig, generateSoloNavMesh, generateTileNavMeshData, tiledNavMeshGeneratorConfigDefaults, type SoloNavMeshGeneratorConfig } from '@recast-navigation/generators';
import type { Disposable } from '../core/Disposable';
import type { Random } from '../core/Random';
import { TriangleSoup } from './TriangleSoup';

/**
 * Navigation (ADR-009): a Recast/Detour navmesh behind a small engine API.
 * Game code asks for nearest points, paths and mesh raycasts; it never sees
 * Detour objects. Meshes are baked from triangle soup with the same agent
 * shape the character controller uses, exported as bytes at authoring time,
 * and imported at runtime. Every query is a pure function of the mesh and
 * its inputs; the random-point queries are seeded from the engine `Random`
 * so they are deterministic too.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface NavAgentParams {
  /** Capsule radius, world units. */
  readonly radius: number;
  /** Standing height, world units. */
  readonly height: number;
  /** Highest ledge walked over without a link, world units. */
  readonly stepHeight: number;
  readonly maxSlopeDeg: number;
  /** Voxel size on the ground plane. Smaller is more precise and slower to bake. */
  readonly cellSize: number;
  /** Voxel size vertically. */
  readonly cellHeight: number;
}

/** The engine character controller's shape (ADR-009): a place the player can stand is a place an agent can walk. */
export const DEFAULT_NAV_AGENT: NavAgentParams = {
  radius: 0.4,
  height: 1.8,
  stepHeight: 0.4,
  maxSlopeDeg: 50,
  cellSize: 0.2,
  cellHeight: 0.15,
};

/** An authored traversal (mantle, ladder, drop) the mesh cannot express by itself. */
export interface NavLink {
  readonly start: Vec3Like;
  readonly end: Vec3Like;
  /** How close an agent must be to the endpoints to use the link. */
  readonly radius: number;
  readonly bidirectional: boolean;
}

export interface NavPathHit {
  /** Fraction along start→end where the mesh edge was hit; 1 when the way is clear. */
  readonly t: number;
  readonly blocked: boolean;
  readonly point: Vec3Like;
}

let initPromise: Promise<void> | null = null;

/** Load the Recast WASM once. Every `Navigation` factory awaits this. */
export function initNavigation(): Promise<void> {
  initPromise ??= initRecastRaw();
  return initPromise;
}

/** Recast wants its agent in voxels; convert from the world-unit agent. */
export function navMeshConfig(agent: NavAgentParams, links: readonly NavLink[] = []): Partial<SoloNavMeshGeneratorConfig> {
  const cs = agent.cellSize;
  const ch = agent.cellHeight;
  const offMeshConnections: OffMeshConnectionParams[] = links.map((l) => ({
    startPosition: { x: l.start.x, y: l.start.y, z: l.start.z },
    endPosition: { x: l.end.x, y: l.end.y, z: l.end.z },
    radius: l.radius,
    bidirectional: l.bidirectional,
  }));
  return {
    cs,
    ch,
    walkableSlopeAngle: agent.maxSlopeDeg,
    walkableRadius: Math.ceil(agent.radius / cs),
    walkableHeight: Math.ceil(agent.height / ch),
    walkableClimb: Math.floor(agent.stepHeight / ch),
    maxEdgeLen: Math.round(2.4 / cs),
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
    offMeshConnections,
  };
}

/**
 * Bake a navmesh from triangle soup (flat xyz positions, flat triangle
 * indices) and return it as portable bytes. Deterministic for the same
 * input. Call `initNavigation()` first.
 */
export function bakeNavMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, agent: NavAgentParams = DEFAULT_NAV_AGENT, links: readonly NavLink[] = []): Uint8Array {
  const result = generateSoloNavMesh(positions, indices, navMeshConfig(agent, links));
  if (!result.success) throw new Error(`bakeNavMesh: ${result.error}`);
  const bytes = exportNavMesh(result.navMesh);
  result.navMesh.destroy();
  return bytes;
}

/**
 * The walkable world's triangles, asked for one tile at a time (`Navigation.tiled`): add to `soup`
 * whatever reaches into the box `min`..`max` (more is harmless, only slower). A level's static
 * geometry, and each destructible structure's standing chunks and rubble as they are now.
 */
export type NavGeometry = (soup: TriangleSoup, min: Vec3Like, max: Vec3Like) => void;

export interface NavBounds {
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

/** A tiled mesh's layout and its source, for rebuilding tiles. */
interface Tiling {
  readonly rc: ReturnType<typeof buildTiledNavMeshRcConfig>['config'];
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  /** Tile edge (m). */
  readonly size: number;
  readonly across: number;
  readonly down: number;
  /** How far past its edge a tile's build reads geometry (m): its border. */
  readonly border: number;
  readonly geometry: NavGeometry;
  readonly offMeshConnections: OffMeshConnectionParams[];
  readonly context: RecastBuildContext;
  /** Tiles waiting to be rebuilt, oldest first, as y * across + x. */
  readonly queue: number[];
  readonly queued: Set<number>;
}

export interface NavigationStats {
  readonly tiles: number;
  readonly polys: number;
  readonly vertices: number;
}

export class Navigation implements Disposable {
  private readonly navMesh: NavMesh;
  private readonly query: NavMeshQuery;
  private readonly halfExtents = { x: 1, y: 2, z: 1 };
  private tiling: Tiling | null = null;
  private disposed = false;
  /** Tiles rebuilt since the mesh was made (`update`). */
  rebuilt = 0;

  private constructor(navMesh: NavMesh) {
    this.navMesh = navMesh;
    this.query = new NavMeshQuery(navMesh);
  }

  /** Load a mesh baked by `bakeNavMesh`. Call `initNavigation()` first. */
  static fromBytes(bytes: Uint8Array): Navigation {
    const { navMesh } = importNavMesh(bytes);
    return new Navigation(navMesh);
  }

  /** Bake and load in one go, for procedural scenes and development. Call `initNavigation()` first. */
  static bake(positions: ArrayLike<number>, indices: ArrayLike<number>, agent: NavAgentParams = DEFAULT_NAV_AGENT, links: readonly NavLink[] = []): Navigation {
    const result = generateSoloNavMesh(positions, indices, navMeshConfig(agent, links));
    if (!result.success) throw new Error(`Navigation.bake: ${result.error}`);
    return new Navigation(result.navMesh);
  }

  /**
   * A tiled mesh over `bounds` whose tiles can be rebuilt where the world changes (`invalidate`,
   * `update`): a building blown open, a floor gone, a heap of rubble where there was street.
   * `geometry` is asked for each tile's triangles as the world is when the tile is built. Tiles
   * are `tileSize` cells across (cells of `agent.cellSize`; 32 is 6.4 m, which rebuilt in 5-7 ms
   * beside a five-storey building in Node, nearly all of it Recast). Call `initNavigation()` first.
   */
  static tiled(geometry: NavGeometry, bounds: NavBounds, agent: NavAgentParams = DEFAULT_NAV_AGENT, links: readonly NavLink[] = [], tileSize = 32): Navigation {
    const config = { ...tiledNavMeshGeneratorConfigDefaults, ...navMeshConfig(agent, links), tileSize };
    const min: [number, number, number] = [bounds.min.x, bounds.min.y, bounds.min.z];
    const max: [number, number, number] = [bounds.max.x, bounds.max.y, bounds.max.z];
    const layout = buildTiledNavMeshRcConfig({ recastConfig: config, navMeshBounds: [min, max] });
    const navMesh = new NavMesh();
    const params = NavMeshParams.create({ orig: layout.orig, tileWidth: layout.tcs, tileHeight: layout.tcs, maxTiles: layout.maxTiles, maxPolys: layout.maxPolysPerTile });
    if (!navMesh.initTiled(params)) throw new Error('Navigation.tiled: could not init a tiled nav mesh');
    const nav = new Navigation(navMesh);
    nav.tiling = {
      rc: layout.config,
      min,
      max,
      size: layout.tcs,
      across: layout.tileWidth,
      down: layout.tileHeight,
      border: layout.config.borderSize * layout.config.cs,
      geometry,
      offMeshConnections: config.offMeshConnections ?? [],
      context: new RecastBuildContext(),
      queue: [],
      queued: new Set(),
    };
    for (let y = 0; y < layout.tileHeight; y++) for (let x = 0; x < layout.tileWidth; x++) nav.buildTile(x, y);
    nav.rebuilt = 0;
    return nav;
  }

  /**
   * The world changed inside `min`..`max`: the tiles it reaches (and those whose border it
   * reaches) are queued for rebuilding. Only a tiled mesh can (`Navigation.tiled`); others ignore it.
   */
  invalidate(min: Vec3Like, max: Vec3Like): void {
    this.assertLive();
    const t = this.tiling;
    if (!t) return;
    const x0 = Math.max(0, Math.floor((min.x - t.border - t.min[0]) / t.size));
    const x1 = Math.min(t.across - 1, Math.floor((max.x + t.border - t.min[0]) / t.size));
    const y0 = Math.max(0, Math.floor((min.z - t.border - t.min[2]) / t.size));
    const y1 = Math.min(t.down - 1, Math.floor((max.z + t.border - t.min[2]) / t.size));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const key = y * t.across + x;
        if (t.queued.has(key)) continue;
        t.queued.add(key);
        t.queue.push(key);
      }
  }

  /** Tiles waiting to be rebuilt. */
  get pendingTiles(): number {
    return this.tiling?.queue.length ?? 0;
  }

  /**
   * Rebuild up to `maxTiles` queued tiles, oldest first, from the world as it is now; returns how
   * many. A tile costs a few milliseconds, so a game spends one or two a frame: paths stay valid
   * meanwhile (agents repath on their cadence), they just don't know the change yet.
   */
  update(maxTiles = 1): number {
    this.assertLive();
    const t = this.tiling;
    if (!t) return 0;
    let n = 0;
    while (n < maxTiles && t.queue.length > 0) {
      const key = t.queue.shift()!;
      t.queued.delete(key);
      this.buildTile(key % t.across, Math.floor(key / t.across));
      n++;
    }
    return n;
  }

  /** Build (or rebuild) one tile from its geometry as it is now. */
  private buildTile(x: number, y: number): void {
    const t = this.tiling!;
    const bmin: [number, number, number] = [t.min[0] + x * t.size, t.min[1], t.min[2] + y * t.size];
    const bmax: [number, number, number] = [t.min[0] + (x + 1) * t.size, t.max[1], t.min[2] + (y + 1) * t.size];
    const soup = new TriangleSoup();
    t.geometry(soup, { x: bmin[0] - t.border, y: bmin[1], z: bmin[2] - t.border }, { x: bmax[0] + t.border, y: bmax[1], z: bmax[2] + t.border });
    this.navMesh.removeTile(this.navMesh.getTileRefAt(x, y, 0));
    this.rebuilt++;
    if (soup.triangleCount === 0) return;
    const verts = new VerticesArray();
    verts.copy(soup.positions);
    const tris = new TrianglesArray();
    tris.copy(soup.indices);
    const chunky = new RecastChunkyTriMesh();
    try {
      if (!chunky.init(verts, tris, soup.triangleCount, 256)) throw new Error('Navigation: could not index a tile\'s triangles');
      const result = generateTileNavMeshData(verts, tris, t.rc, chunky, { x, y, bmin, bmax }, { offMeshConnections: t.offMeshConnections, buildBvTree: true }, false, t.context);
      if (result.success && result.data) {
        const added = this.navMesh.addTile(result.data, Detour.DT_TILE_FREE_DATA, 0);
        if (statusFailed(added.status)) result.data.destroy();
      }
    } finally {
      verts.destroy();
      tris.destroy();
      Raw.destroy(chunky.raw);
    }
  }

  /** The mesh as bytes, for writing beside a level. */
  export(): Uint8Array {
    this.assertLive();
    return exportNavMesh(this.navMesh);
  }

  stats(): NavigationStats {
    this.assertLive();
    let tiles = 0;
    let polys = 0;
    let vertices = 0;
    const max = this.navMesh.getMaxTiles();
    for (let i = 0; i < max; i++) {
      const tile = this.navMesh.getTile(i);
      const header = tile.header();
      if (!header) continue;
      tiles += 1;
      polys += header.polyCount();
      vertices += header.vertCount();
    }
    return { tiles, polys, vertices };
  }

  /** Closest point on the mesh within the search box, or null when nothing is near. */
  nearestPoint(position: Vec3Like, out: Vec3Like): Vec3Like | null {
    this.assertLive();
    const r = this.query.findClosestPoint(position, { halfExtents: this.halfExtents });
    if (!r.success || !r.isPointOverPoly) {
      const near = this.query.findNearestPoly(position, { halfExtents: this.halfExtents });
      if (!near.success || near.nearestRef === 0) return null;
      out.x = near.nearestPoint.x;
      out.y = near.nearestPoint.y;
      out.z = near.nearestPoint.z;
      return out;
    }
    out.x = r.point.x;
    out.y = r.point.y;
    out.z = r.point.z;
    return out;
  }

  /**
   * Straight-line (string-pulled) path from start to end. Fills `out` with
   * corner points, start excluded and end included, and returns true when a
   * path reached the end. A partial path (nearest reachable point) still
   * fills `out` but returns false.
   */
  findPath(start: Vec3Like, end: Vec3Like, out: Vec3Like[]): boolean {
    this.assertLive();
    out.length = 0;
    const r = this.query.computePath(start, end, { halfExtents: this.halfExtents, maxPathPolys: 256, maxStraightPathPoints: 256 });
    if (!r.success || r.path.length === 0) return false;
    for (let i = 1; i < r.path.length; i++) {
      const p = r.path[i];
      if (p) out.push({ x: p.x, y: p.y, z: p.z });
    }
    if (out.length === 0) {
      const p = r.path[0];
      if (p) out.push({ x: p.x, y: p.y, z: p.z });
    }
    const last = out[out.length - 1];
    if (!last) return false;
    const dx = last.x - end.x;
    const dz = last.z - end.z;
    return dx * dx + dz * dz < 0.25;
  }

  /** Walk the mesh surface from start toward end; returns where the mesh edge stops you. */
  raycast(start: Vec3Like, end: Vec3Like): NavPathHit {
    this.assertLive();
    const near = this.query.findNearestPoly(start, { halfExtents: this.halfExtents });
    if (!near.success || near.nearestRef === 0) return { t: 0, blocked: true, point: { x: start.x, y: start.y, z: start.z } };
    const r = this.query.raycast(near.nearestRef, near.nearestPoint, end);
    const t = r.success ? Math.min(1, r.t) : 0;
    const blocked = !r.success || r.t < 1;
    return {
      t,
      blocked,
      point: { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, z: start.z + (end.z - start.z) * t },
    };
  }

  /**
   * A random reachable point near `center`, drawn from the engine's seeded
   * stream. Detour samples the polygons the circle touches, so the point can
   * fall somewhat outside `radius`; treat the radius as a search size, not a
   * hard bound.
   */
  randomPointAround(center: Vec3Like, radius: number, random: Random, out: Vec3Like): Vec3Like | null {
    this.assertLive();
    setRandomSeed(Math.floor(random.next() * 0x7fffffff));
    const r = this.query.findRandomPointAroundCircle(center, radius, { halfExtents: this.halfExtents });
    if (!r.success) return null;
    out.x = r.randomPoint.x;
    out.y = r.randomPoint.y;
    out.z = r.randomPoint.z;
    return out;
  }

  /**
   * Polygon outlines as line-segment pairs (x0 y0 z0 x1 y1 z1 ...) for a
   * debug overlay. Detail-mesh height is ignored; the lines sit on the poly
   * plane, which is what you want to see anyway.
   */
  debugLines(): Float32Array {
    this.assertLive();
    const out: number[] = [];
    const max = this.navMesh.getMaxTiles();
    for (let i = 0; i < max; i++) {
      const tile = this.navMesh.getTile(i);
      const header = tile.header();
      if (!header) continue;
      const polyCount = header.polyCount();
      for (let p = 0; p < polyCount; p++) {
        const poly = tile.polys(p);
        const n = poly.vertCount();
        for (let k = 0; k < n; k++) {
          const a = poly.verts(k);
          const b = poly.verts((k + 1) % n);
          out.push(tile.verts(a * 3), tile.verts(a * 3 + 1), tile.verts(a * 3 + 2));
          out.push(tile.verts(b * 3), tile.verts(b * 3 + 1), tile.verts(b * 3 + 2));
        }
      }
    }
    return new Float32Array(out);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Navigation: disposed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.query.destroy();
    this.navMesh.destroy();
  }
}
