/**
 * Component definitions. A component is a structure-of-arrays store: one typed
 * array per field, indexed by entity id. Components hold numbers only (ADR-003);
 * anything else lives in a `SideTable`.
 */
export type FieldType = 'f32' | 'f64' | 'i32' | 'u32' | 'i16' | 'u16' | 'i8' | 'u8';

export type ComponentSchema = Record<string, FieldType>;

type ArrayFor<T extends FieldType> = T extends 'f32'
  ? Float32Array
  : T extends 'f64'
    ? Float64Array
    : T extends 'i32'
      ? Int32Array
      : T extends 'u32'
        ? Uint32Array
        : T extends 'i16'
          ? Int16Array
          : T extends 'u16'
            ? Uint16Array
            : T extends 'i8'
              ? Int8Array
              : Uint8Array;

/** The live store for a component inside one EntityWorld. Field arrays are indexed by entity id. */
export type ComponentStore<S extends ComponentSchema = ComponentSchema> = {
  readonly [K in keyof S]: ArrayFor<S[K]>;
} & {
  readonly __name: string;
  readonly __schema: S;
  readonly __capacity: number;
};

/** Initial values for a component's fields, all optional. */
export type ComponentData<S extends ComponentSchema> = Partial<{ [K in keyof S]: number }>;

/**
 * A component *type* is world-independent: define it once at module level,
 * resolve the world-specific store with `type.of(world)` (or let the world do
 * it). Stores are created lazily per world and cached by name.
 */
export interface ComponentType<S extends ComponentSchema = ComponentSchema> {
  readonly name: string;
  readonly schema: S;
  readonly defaults: ComponentData<S>;
}

export function defineComponentType<S extends ComponentSchema>(
  name: string,
  schema: S,
  defaults: ComponentData<S> = {},
): ComponentType<S> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Component name "${name}" must be an identifier`);
  return { name, schema, defaults };
}

function allocate(type: FieldType, capacity: number): ArrayFor<FieldType> {
  switch (type) {
    case 'f32':
      return new Float32Array(capacity);
    case 'f64':
      return new Float64Array(capacity);
    case 'i32':
      return new Int32Array(capacity);
    case 'u32':
      return new Uint32Array(capacity);
    case 'i16':
      return new Int16Array(capacity);
    case 'u16':
      return new Uint16Array(capacity);
    case 'i8':
      return new Int8Array(capacity);
    case 'u8':
      return new Uint8Array(capacity);
  }
}

export function createStore<S extends ComponentSchema>(type: ComponentType<S>, capacity: number): ComponentStore<S> {
  const store: Record<string, unknown> = {
    __name: type.name,
    __schema: type.schema,
    __capacity: capacity,
  };
  for (const [field, fieldType] of Object.entries(type.schema)) {
    if (field.startsWith('__')) throw new Error(`Component "${type.name}": field names may not start with "__"`);
    store[field] = allocate(fieldType, capacity);
  }
  return store as ComponentStore<S>;
}

/** Write `defaults` then `data` into the store row for `eid`. */
export function writeRow<S extends ComponentSchema>(
  store: ComponentStore<S>,
  eid: number,
  defaults: ComponentData<S>,
  data: ComponentData<S> | undefined,
): void {
  for (const field of Object.keys(store.__schema) as Array<keyof S & string>) {
    const value = data?.[field] ?? defaults[field] ?? 0;
    (store[field] as unknown as { [i: number]: number })[eid] = value;
  }
}
