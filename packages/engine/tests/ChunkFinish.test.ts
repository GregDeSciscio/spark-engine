import type * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { ChunkMesh } from '../src/destruction/ChunkMesh';
import { authoredStructure, type PieceBox } from '../src/destruction/core/authored';
import { buildBuilding } from '../src/destruction/core/building';
import { surfaceShading } from '../src/rendering/Surfaces';
import { parseLevelNodes, type LevelNode } from '../src/world/LevelLoader';

/**
 * Chunks finished in their building's surface: a brick facade breaks into
 * brick, painted concrete into painted concrete, and the broken faces stay
 * raw concrete (docs/design/destruction-in-missions.md).
 */

const Q: [number, number, number, number] = [0, 0, 0, 1];
const wall = (x: number, finish?: string): PieceBox => ({ center: [x, 1.5, 0], quaternion: Q, halfExtents: [2, 1.5, 0.15], kind: 'wall', finish });

describe('chunks finished in their building surfaces', () => {
  it('leaves a structure with no finish exactly as it was: one material, the same colours', () => {
    const pieces = buildBuilding().pieces;
    const a = new ChunkMesh(pieces, 3);
    expect(Array.isArray(a.mesh.material)).toBe(false);
    expect(a.mesh.geometry.groups).toHaveLength(0);
    const b = new ChunkMesh(pieces, 3);
    expect(Array.from(b.mesh.geometry.getAttribute('color').array)).toEqual(Array.from(a.mesh.geometry.getAttribute('color').array));
    a.dispose();
    b.dispose();
  });

  it('groups painted faces by surface, keeps broken faces in the paint, and draws each group once', () => {
    const { pieces } = authoredStructure([wall(0, 'brick.facade'), wall(5, 'concrete'), wall(10), wall(15, 'neon')]);
    const mesh = new ChunkMesh(pieces, 3);
    const materials = mesh.mesh.material as THREE.MeshStandardNodeMaterial[];
    // The paint (unfinished, unknown finishes, every broken face), brick and concrete.
    expect(Array.isArray(materials)).toBe(true);
    expect(materials.map((m) => m.name)).toEqual(['', 'chunks:brick', 'chunks:concrete']);
    const groups = mesh.mesh.geometry.groups;
    expect(groups.map((g) => g.materialIndex)).toEqual([0, 1, 2]);
    // Every vertex in exactly one group, the groups back to back.
    const total = mesh.mesh.geometry.getAttribute('position').count;
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(total);
    expect(groups[1]!.start).toBe(groups[0]!.count);
    // Only painted faces are finished: the brick group's vertices are no break faces.
    const rough = mesh.mesh.geometry.getAttribute('rough');
    for (let v = groups[1]!.start; v < groups[1]!.start + groups[1]!.count; v++) expect(rough.getX(v)).toBe(0);
    // ...and every chunk of the brick wall still draws its broken faces with the paint.
    const chunk = mesh.mesh.geometry.getAttribute('chunk');
    const brickChunks = new Set<number>();
    for (let v = groups[1]!.start; v < groups[1]!.start + groups[1]!.count; v++) brickChunks.add(chunk.getX(v));
    expect([...brickChunks].every((c) => pieces[c]!.finish === 'brick.facade')).toBe(true);
    mesh.dispose();
  });

  it('carries the finish from a level: spark.surface first, then the material name', () => {
    const node = (spark: Record<string, unknown>, material?: string): LevelNode => ({
      name: 'w',
      path: 'w',
      type: 'Mesh',
      spark,
      collision: false,
      hasMesh: true,
      isLight: false,
      position: [0, 1.5, 0],
      quaternion: Q,
      scale: [4, 3, 0.3],
      halfExtents: [0.5, 0.5, 0.5],
      material,
    });
    const out = parseLevelNodes([node({ type: 'destructible' }, 'brick.facade'), node({ type: 'destructible', surface: 'concrete' }, 'brick'), node({ type: 'destructible' })]);
    expect(out.map((d) => (d.kind === 'destructible' ? d.box.finish : null))).toEqual(['brick.facade', 'concrete', undefined]);
    const { pieces } = authoredStructure(out.flatMap((d) => (d.kind === 'destructible' ? [d.box] : [])));
    expect(new Set(pieces.map((p) => p.finish))).toEqual(new Set(['brick.facade', 'concrete', undefined]));
  });

  it("keeps a metal finish's paint, from the level's material: two paints of metal are two materials", () => {
    const red = { color: 0x8a2a22, metalness: 0.3 };
    const blue = { color: 0x22408a, metalness: 0.3 };
    const out = parseLevelNodes([
      {
        name: 'w',
        path: 'w',
        type: 'Mesh',
        spark: { type: 'destructible' },
        collision: false,
        hasMesh: true,
        isLight: false,
        position: [0, 1.5, 0],
        quaternion: Q,
        scale: [4, 3, 0.3],
        halfExtents: [0.5, 0.5, 0.5],
        material: 'metal.shutter',
        paint: red,
      },
    ]);
    expect(out[0]!.kind === 'destructible' && out[0]!.box.paint).toEqual(red);
    const { pieces } = authoredStructure([
      { ...wall(0, 'metal.shutter'), paint: red },
      { ...wall(5, 'metal.door'), paint: blue },
      { ...wall(10, 'metal.shutter'), paint: red },
    ]);
    const mesh = new ChunkMesh(pieces, 3);
    const materials = mesh.mesh.material as THREE.MeshStandardNodeMaterial[];
    expect(materials.map((m) => m.name)).toEqual(['', 'chunks:metal', 'chunks:metal']);
    expect(mesh.mesh.geometry.groups).toHaveLength(3);
    mesh.dispose();
  });

  it('shades the surfaces chunks can wear, and no others', () => {
    const space = { position: vec3(0, 1, 0) as never, normal: vec3(0, 0, 1) as never };
    for (const name of ['brick', 'concrete', 'metal', 'brick.facade']) expect(surfaceShading(name, space)).not.toBeNull();
    for (const name of ['asphalt', 'window', 'skyline', 'neon']) expect(surfaceShading(name, space)).toBeNull();
  });
});
