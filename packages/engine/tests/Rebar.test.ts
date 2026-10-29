import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { findConnections } from '../src/destruction/core/connections';
import type { P2, V3 } from '../src/destruction/core/math';
import { prism, type Piece } from '../src/destruction/core/pieces';
import { Rebar } from '../src/destruction/Rebar';

function box(id: number, min: V3, max: V3): Piece {
  const w = max[0] - min[0];
  const h = max[1] - min[1];
  const poly: P2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  return prism({ id, element: id, kind: 'wall', poly, frame: { origin: min, u: [1, 0, 0], v: [0, 1, 0] }, thickness: max[2] - min[2], width: w, height: h, minus: 'outer', plus: 'inner', density: 2400 });
}

/** Where a stub starts and ends, from its instance matrix (a unit bar along +y). */
function ends(mesh: THREE.InstancedMesh, i: number): [THREE.Vector3, THREE.Vector3] {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return [new THREE.Vector3(0, 0, 0).applyMatrix4(m), new THREE.Vector3(0, 1, 0).applyMatrix4(m)];
}

describe('rebar', () => {
  // Two 1 m wall chunks side by side along x, glued at x = 1, 0.25 m thick.
  const pieces = [box(0, [0, 0, 0], [1, 1, 0.25]), box(1, [1, 0, 0], [2, 1, 0.25])];
  const connections = findConnections(pieces);
  const glue = connections.find((c) => c.a === 0 && c.b === 1)!;

  it('a broken contact grows stubs out of its patch, both ways along its normal, inside the wall', () => {
    const rebar = new Rebar(connections);
    rebar.broke([glue.id]);
    expect(rebar.stubs.count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < rebar.stubs.count; i++) {
      const [a, b] = ends(rebar.stubs, i);
      // From the patch (x = 1, give or take the bit inside the chunk), out along x.
      expect(Math.abs(a.x - 1)).toBeLessThan(0.1);
      expect(Math.abs(b.x - 1)).toBeGreaterThan(0.1);
      // Within the wall's thickness the whole way: nothing pokes out of its faces.
      for (const p of [a, b]) {
        expect(p.z).toBeGreaterThan(0);
        expect(p.z).toBeLessThan(0.25);
      }
    }
    // Once per contact.
    const n = rebar.stubs.count;
    rebar.broke([glue.id]);
    expect(rebar.stubs.count).toBe(n);
  });

  it('stubs ride on their chunk, and go with it', () => {
    const rebar = new Rebar(connections);
    rebar.broke([glue.id]);
    const before = Array.from({ length: rebar.stubs.count }, (_, i) => ends(rebar.stubs, i)[0]);
    rebar.follow(1, new THREE.Matrix4().makeTranslation(0, 3, 0));
    const after = Array.from({ length: rebar.stubs.count }, (_, i) => ends(rebar.stubs, i)[0]);
    const moved = after.filter((p, i) => p.y - before[i]!.y > 2.9).length;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(after.length); // chunk 0's stubs stay put
    rebar.follow(0, null);
    const gone = Array.from({ length: rebar.stubs.count }, (_, i) => {
      const m = new THREE.Matrix4();
      rebar.stubs.getMatrixAt(i, m);
      return m.determinant() === 0;
    }).filter(Boolean).length;
    expect(gone).toBe(after.length - moved);
  });
});
