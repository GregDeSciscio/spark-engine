// `pnpm bench:solver`: the strain solver's costs by building size, and cascades against an
// always-refactor reference, written to tools/benchmarks/solver-results.md. Not part of `pnpm test`.
export default {
  test: {
    include: ['tools/benchmarks/solver.bench.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
};
