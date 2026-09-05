import { describe, expect, it } from 'vitest';
import { Document } from '@gltf-transform/core';
import { DEFAULT_NAV_AGENT, Navigation, initNavigation, navMeshConfig } from '../src/ai/Navigation';
import { NAV_AGENT, bakeNavMesh, collectCollision, navMeshConfig as pipelineConfig } from '../../../tools/asset-pipeline/navmesh.mjs';

/** A level the way street.py authors it: unit-cube COL_ boxes sized by node scale. */
function level(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 7, 6, 4, 6, 5, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const pos = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
  const idx = doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx);
  const mesh = doc.createMesh('COL_unit_cube').addPrimitive(prim);
  const scene = doc.createScene('street');
  const ground = doc.createNode('COL_ground').setMesh(mesh).setTranslation([0, -0.5, 0]).setScale([30, 1, 30]).setExtras({ 'spark.collider': 'box' });
  const wall = doc.createNode('COL_wall').setMesh(mesh).setTranslation([-3.5, 1.5, 0]).setScale([23, 3, 0.6]).setExtras({ 'spark.collider': 'box' });
  const render = doc.createNode('ground').setMesh(mesh).setScale([30, 1, 30]);
  scene.addChild(ground).addChild(wall).addChild(render);
  return doc;
}

describe('asset pipeline navmesh', () => {
  it('uses the same agent shape and voxel config as the engine', () => {
    expect(NAV_AGENT).toEqual(DEFAULT_NAV_AGENT);
    const engine = navMeshConfig(DEFAULT_NAV_AGENT);
    const pipeline = pipelineConfig();
    for (const key of Object.keys(engine) as (keyof typeof engine)[]) {
      if (key === 'offMeshConnections') continue;
      expect(pipeline[key]).toBe(engine[key]);
    }
  });

  it('collects only COL_ nodes, as world-space boxes', () => {
    const soup = collectCollision(level());
    expect(soup.boxes).toBe(2);
    expect(soup.trimeshes).toBe(0);
    expect(soup.indices.length / 3).toBe(24);
    // The ground box spans x in [-15, 15] after the node scale.
    const xs = soup.positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-15);
    expect(Math.max(...xs)).toBeCloseTo(15);
  });

  it('bakes bytes the engine can load and path over', async () => {
    await initNavigation();
    const baked = await bakeNavMesh(level());
    expect(baked).not.toBeNull();
    if (!baked) return;
    expect(baked.polys).toBeGreaterThan(2);
    const nav = Navigation.fromBytes(baked.bytes);
    const out: { x: number; y: number; z: number }[] = [];
    expect(nav.findPath({ x: -8, y: 0, z: -8 }, { x: -8, y: 0, z: 8 }, out)).toBe(true);
    expect(Math.max(...out.map((p) => p.x))).toBeGreaterThan(7.5);
    nav.dispose();
  });

  it('returns null for a document without collision', async () => {
    const doc = new Document();
    doc.createScene('empty').addChild(doc.createNode('prop'));
    expect(await bakeNavMesh(doc)).toBeNull();
  });
});
