/**
 * Navmesh bake for the asset pipeline (ADR-009). A level's COL_ nodes become
 * world-space triangle soup (box colliders from their scaled unit bounds,
 * trimesh colliders from their vertices), Recast builds the mesh with the
 * engine's agent shape, and the bytes land beside the level as
 * <name>.navmesh.bin for `Navigation.fromBytes` at runtime.
 *
 * NAV_AGENT mirrors `DEFAULT_NAV_AGENT` in packages/engine/src/ai/Navigation.ts;
 * a unit test keeps the two identical.
 */
import { init as initRecast, exportNavMesh } from '@recast-navigation/core';
import { generateSoloNavMesh } from '@recast-navigation/generators';

export const NAV_AGENT = { radius: 0.4, height: 1.8, stepHeight: 0.4, maxSlopeDeg: 50, cellSize: 0.2, cellHeight: 0.15 };

/** Same conversion as the engine's `navMeshConfig`: world units in, voxels out. */
export function navMeshConfig(agent = NAV_AGENT) {
  const cs = agent.cellSize;
  const ch = agent.cellHeight;
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
    offMeshConnections: [],
  };
}

const UNIT_CORNERS = [
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
  [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
];
/** Outward-wound faces of a unit box; same order as the engine's TriangleSoup. */
const BOX_INDICES = [
  0, 1, 2, 0, 2, 3,
  4, 7, 6, 4, 6, 5,
  0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2,
  2, 6, 7, 2, 7, 3,
  3, 7, 4, 3, 4, 0,
];

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Collect the collision triangle soup of a gltf-transform Document. */
export function collectCollision(doc) {
  const positions = [];
  const indices = [];
  let boxes = 0;
  let trimeshes = 0;
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getName().startsWith('COL_')) continue;
    const m = node.getWorldMatrix();
    const extras = node.getExtras() ?? {};
    const mesh = node.getMesh();
    const base = positions.length / 3;
    if (extras['spark.collider'] === 'box' || !mesh) {
      // Bounds of the collision mesh in local space (a unit cube when authored per ADR-008).
      let min = [-0.5, -0.5, -0.5];
      let max = [0.5, 0.5, 0.5];
      if (mesh) {
        const bounds = meshBounds(mesh);
        if (bounds) ({ min, max } = bounds);
      }
      for (const [cx, cy, cz] of UNIT_CORNERS) {
        const x = cx < 0 ? min[0] : max[0];
        const y = cy < 0 ? min[1] : max[1];
        const z = cz < 0 ? min[2] : max[2];
        positions.push(...transformPoint(m, x, y, z));
      }
      for (const i of BOX_INDICES) indices.push(base + i);
      boxes += 1;
      continue;
    }
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const start = positions.length / 3;
      const arr = pos.getArray();
      for (let i = 0; i < arr.length; i += 3) positions.push(...transformPoint(m, arr[i], arr[i + 1], arr[i + 2]));
      const idx = prim.getIndices();
      if (idx) {
        const ia = idx.getArray();
        for (let i = 0; i < ia.length; i++) indices.push(start + ia[i]);
      } else {
        for (let i = 0; i < arr.length / 3; i++) indices.push(start + i);
      }
    }
    trimeshes += 1;
  }
  return { positions, indices, boxes, trimeshes };
}

function meshBounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const arr = pos.getArray();
    for (let i = 0; i < arr.length; i += 3) {
      any = true;
      for (let k = 0; k < 3; k++) {
        const v = arr[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return any ? { min, max } : null;
}

let initPromise = null;

/**
 * Bake a navmesh for a document with COL_ nodes. Returns null when it has
 * none; otherwise the exported bytes plus a summary.
 */
export async function bakeNavMesh(doc, agent = NAV_AGENT) {
  const soup = collectCollision(doc);
  if (soup.indices.length === 0) return null;
  initPromise ??= initRecast();
  await initPromise;
  const result = generateSoloNavMesh(soup.positions, soup.indices, navMeshConfig(agent));
  if (!result.success) throw new Error(`navmesh bake failed: ${result.error}`);
  const bytes = exportNavMesh(result.navMesh);
  let polys = 0;
  const max = result.navMesh.getMaxTiles();
  for (let i = 0; i < max; i++) {
    const header = result.navMesh.getTile(i).header();
    if (header) polys += header.polyCount();
  }
  result.navMesh.destroy();
  return { bytes, polys, triangles: soup.indices.length / 3, boxes: soup.boxes, trimeshes: soup.trimeshes };
}
