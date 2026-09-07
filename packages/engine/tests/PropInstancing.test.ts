import { describe, expect, it } from 'vitest';
import { parseLevelNodes, propsWorthInstancing, type LevelNode } from '../src/world/LevelLoader';

/**
 * Which props a level repeats often enough to draw as instances. The rule is
 * pulled out of the loader precisely so it can be checked here: the loader
 * itself needs a renderer and a model library to run at all.
 */

function propNode(name: string, prop: string): LevelNode {
  return {
    name,
    path: `root/${name}`,
    type: 'Object3D',
    spark: { type: 'prop', prop },
    collision: false,
    hasMesh: false,
    isLight: false,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function level(counts: Record<string, number>): ReturnType<typeof parseLevelNodes> {
  const nodes: LevelNode[] = [];
  for (const [prop, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) nodes.push(propNode(`${prop}_${i}`, prop));
  }
  return parseLevelNodes(nodes);
}

const LIBRARY = { lamp: '/models/lamp.glb', crate: '/models/crate.glb', hydrant: '/models/hydrant.glb' };

describe('propsWorthInstancing', () => {
  it('takes the props at or above the threshold and leaves the rest alone', () => {
    const worth = propsWorthInstancing(level({ lamp: 9, crate: 4, hydrant: 3 }), LIBRARY, 4);
    expect([...worth].sort()).toEqual(['/models/crate.glb', '/models/lamp.glb']);
  });

  it('counts placements, not prop kinds', () => {
    expect(propsWorthInstancing(level({ lamp: 1, crate: 1, hydrant: 1 }), LIBRARY, 2).size).toBe(0);
    expect(propsWorthInstancing(level({ lamp: 2 }), LIBRARY, 2)).toEqual(new Set(['/models/lamp.glb']));
  });

  it('defaults to four placements', () => {
    expect(propsWorthInstancing(level({ lamp: 3 }), LIBRARY).size).toBe(0);
    expect(propsWorthInstancing(level({ lamp: 4 }), LIBRARY).size).toBe(1);
  });

  it('never batches a single placement, whatever threshold is asked for', () => {
    // One instance in a batch costs a draw and saves none, and a threshold of
    // zero or one would put every prop in the level into its own batch.
    expect(propsWorthInstancing(level({ lamp: 1 }), LIBRARY, 0).size).toBe(0);
    expect(propsWorthInstancing(level({ lamp: 1 }), LIBRARY, 1).size).toBe(0);
    expect(propsWorthInstancing(level({ lamp: 2 }), LIBRARY, 1).size).toBe(1);
  });

  it('ignores props the library does not have', () => {
    // A level may name a prop the game did not load; those are placed as
    // empties and must not be counted toward a batch.
    const worth = propsWorthInstancing(level({ lamp: 5, ghost: 9 }), LIBRARY, 4);
    expect(worth).toEqual(new Set(['/models/lamp.glb']));
  });

  it('is empty for a level with no props at all', () => {
    expect(propsWorthInstancing([], LIBRARY, 4).size).toBe(0);
    expect(propsWorthInstancing(level({}), LIBRARY, 4).size).toBe(0);
  });

  it('handles two prop names that resolve to the same model', () => {
    // Aliases in the library are the same GPU geometry, so their placements
    // belong to one batch and should count together.
    const library = { lamp: '/models/lamp.glb', lamp_alt: '/models/lamp.glb' };
    const worth = propsWorthInstancing(level({ lamp: 2, lamp_alt: 2 }), library, 4);
    expect(worth).toEqual(new Set(['/models/lamp.glb']));
  });

  it('returns nothing without a library', () => {
    expect(propsWorthInstancing(level({ lamp: 9 }), undefined, 2).size).toBe(0);
  });
});
