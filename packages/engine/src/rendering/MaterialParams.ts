import * as THREE from 'three/webgpu';
import { nodeObject } from 'three/tsl';

/**
 * Per-material shader parameters (docs/performance/cold-start.md, "vary by
 * parameter, not by graph").
 *
 * three keys a compiled program on the node *instances* of a material's graph,
 * so materials only share a pipeline when they share the graph and differ
 * through values that are bound per material: the standard properties
 * (`materialColor`, `materialRoughness`, ...) or, for anything else, a value
 * on `material.userData` read through a material reference. A constant baked
 * into a fresh graph per material is one more shader compile per pass.
 *
 * Three's own `materialReference('userData.x', ...)` is not enough on its own:
 * a shadow caster's `colorNode` is folded into the shadow pass (its alpha
 * drives alpha-tested shadows), where the current material is the
 * `ShadowMaterial` and the property does not exist. This node falls back to a
 * default there instead of throwing, so a shared graph can be used on any
 * material in any pass.
 */
export type MaterialParamType = 'float' | 'vec2' | 'vec3' | 'color';

interface Path {
  readonly path: readonly string[];
  readonly fallback: unknown;
}

const DEFAULTS: Record<MaterialParamType, () => unknown> = {
  float: () => 0,
  vec2: () => new THREE.Vector2(),
  vec3: () => new THREE.Vector3(),
  color: () => new THREE.Color(),
};

class MaterialParamNode extends THREE.MaterialReferenceNode implements Path {
  readonly path: readonly string[];
  readonly fallback: unknown;

  constructor(name: string, type: MaterialParamType, fallback: unknown) {
    super(`userData.${name}`, type);
    this.path = ['userData', ...name.split('.')];
    this.fallback = fallback;
  }

  /** `ReferenceNode` reads the property through this; missing links resolve to the fallback rather than `undefined`. */
  getValueFromReference(object: unknown = (this as unknown as { reference: unknown }).reference): unknown {
    return readPath(object, this);
  }
}

/** Pure: walk `path` on `object`, returning `fallback` when any link is missing. */
export function readPath(object: unknown, { path, fallback }: Path): unknown {
  let value: unknown = object;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return fallback;
    value = (value as Record<string, unknown>)[key];
  }
  return value === undefined ? fallback : value;
}

/**
 * A node reading `material.userData[name]` of whichever material is being
 * rendered: a float, `Vector2`, `Vector3` or `Color`. Build the graph once,
 * assign it to every material of the family, and set the value per material.
 */
export function materialParam(name: string, type: 'float', fallback?: number): THREE.Node<'float'>;
export function materialParam(name: string, type: 'vec2', fallback?: THREE.Vector2): THREE.Node<'vec2'>;
export function materialParam(name: string, type: 'vec3', fallback?: THREE.Vector3): THREE.Node<'vec3'>;
export function materialParam(name: string, type: 'color', fallback?: THREE.Color): THREE.Node<'vec3'>;
export function materialParam(name: string, type: MaterialParamType, fallback?: unknown): THREE.Node {
  return nodeObject(new MaterialParamNode(name, type, fallback ?? DEFAULTS[type]())) as unknown as THREE.Node;
}
