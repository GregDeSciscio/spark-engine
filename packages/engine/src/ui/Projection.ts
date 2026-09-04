/**
 * World → overlay-pixel projection. Pure and allocation-free: the caller owns
 * `out`, the matrix is a column-major 16-float array (three's
 * `Matrix4.elements` layout, `projection × view`).
 */
export interface ProjectedPoint {
  /** Overlay CSS pixels from the top-left of the viewport. */
  x: number;
  y: number;
  /** In front of the camera and inside the viewport. */
  visible: boolean;
  /** Distance along the view axis (clip-space w); ≤ 0 means behind the camera. */
  depth: number;
}

export function createProjectedPoint(): ProjectedPoint {
  return { x: 0, y: 0, visible: false, depth: 0 };
}

export function projectPoint(viewProj: ArrayLike<number>, width: number, height: number, x: number, y: number, z: number, out: ProjectedPoint): ProjectedPoint {
  const e = viewProj;
  const cx = (e[0] ?? 0) * x + (e[4] ?? 0) * y + (e[8] ?? 0) * z + (e[12] ?? 0);
  const cy = (e[1] ?? 0) * x + (e[5] ?? 0) * y + (e[9] ?? 0) * z + (e[13] ?? 0);
  const cz = (e[2] ?? 0) * x + (e[6] ?? 0) * y + (e[10] ?? 0) * z + (e[14] ?? 0);
  const cw = (e[3] ?? 0) * x + (e[7] ?? 0) * y + (e[11] ?? 0) * z + (e[15] ?? 1);
  out.depth = cw;
  if (!(cw > 1e-6)) {
    out.visible = false;
    out.x = 0;
    out.y = 0;
    return out;
  }
  const nx = cx / cw;
  const ny = cy / cw;
  const nz = cz / cw;
  out.x = (nx * 0.5 + 0.5) * width;
  out.y = (0.5 - ny * 0.5) * height;
  out.visible = nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1 && nz >= -1 && nz <= 1;
  return out;
}

/** `out = a × b` for column-major 4×4 arrays. Allocation-free. */
export function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>, out: Float32Array | number[]): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
}

/** Screen-space scale for a label at `depth`, 1 at `reference`, clamped. */
export function distanceScale(depth: number, reference: number, min = 0.4, max = 1.5): number {
  if (!(depth > 0)) return max;
  const s = reference / depth;
  return s < min ? min : s > max ? max : s;
}
