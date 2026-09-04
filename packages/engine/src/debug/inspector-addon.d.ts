// Typings @types/three does not ship for the parts of three's Inspector addon
// the engine inspector uses. Kept minimal: only what `Inspector.ts` touches.

declare module 'three/addons/inspector/ui/List.js' {
  import type { Item } from 'three/addons/inspector/ui/Item.js';

  export class List {
    constructor(...headers: string[]);
    readonly domElement: HTMLDivElement;
    setGridStyle(template: string): void;
    add(item: Item): void;
    remove(item: Item): this;
  }
}
