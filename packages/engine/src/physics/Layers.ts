/**
 * Named collision layers mapped onto Rapier interaction groups.
 *
 * Rapier filters pairs with a 32-bit value: the high 16 bits are the layers a
 * collider *belongs to*, the low 16 bits are the layers it *collides with*.
 * Two colliders interact only if each one's membership overlaps the other's
 * filter. This helper hides the bit packing behind layer names.
 *
 * Up to 16 layers. `define` is idempotent, so scenes can re-declare the layers
 * they use without worrying about who defined them first. Bit assignment
 * follows definition order, which is deterministic for a given scene.
 */
export type LayerSpec = string | readonly string[] | 'all' | 'none';

export const MAX_LAYERS = 16;
export const ALL_LAYERS_MASK = 0xffff;

export class Layers {
  private readonly bits = new Map<string, number>();

  constructor(initial: readonly string[] = ['default']) {
    this.define(...initial);
  }

  /** Register layer names. Existing names keep their bit; new ones take the next free bit. */
  define(...names: string[]): void {
    for (const name of names) {
      if (this.bits.has(name)) continue;
      if (this.bits.size >= MAX_LAYERS) {
        throw new Error(`Layers: at most ${MAX_LAYERS} layers are supported (adding "${name}")`);
      }
      this.bits.set(name, 1 << this.bits.size);
    }
  }

  has(name: string): boolean {
    return this.bits.has(name);
  }

  /** Every defined layer name in bit order. */
  names(): readonly string[] {
    return [...this.bits.keys()];
  }

  /** The single bit for one layer. Throws on an unknown name so typos surface early. */
  /** The bit for a layer name, defining the layer on first use so declaration order never matters. */
  bit(name: string): number {
    let bit = this.bits.get(name);
    if (bit === undefined) {
      this.define(name);
      bit = this.bits.get(name) as number;
    }
    return bit;
  }

  /** 16-bit mask for a layer spec: a name, a list of names, `'all'` or `'none'`. */
  mask(spec: LayerSpec): number {
    if (spec === 'all') return ALL_LAYERS_MASK;
    if (spec === 'none') return 0;
    if (typeof spec === 'string') return this.bit(spec);
    let mask = 0;
    for (const name of spec) mask |= this.bit(name);
    return mask;
  }

  /**
   * Rapier interaction-groups value for a collider that belongs to
   * `memberLayers` and collides with `collidesWith`.
   */
  groups(memberLayers: LayerSpec, collidesWith: LayerSpec = 'all'): number {
    return ((this.mask(memberLayers) << 16) | this.mask(collidesWith)) >>> 0;
  }

  /**
   * Interaction groups for a scene query (ray, overlap): the query belongs to
   * every layer so it is never filtered out by the collider side, and only
   * hits colliders whose membership overlaps `hitLayers`.
   */
  queryGroups(hitLayers: LayerSpec = 'all'): number {
    return ((ALL_LAYERS_MASK << 16) | this.mask(hitLayers)) >>> 0;
  }
}
