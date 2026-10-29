# Strain solver benchmark

Node v22.20.0, AMD Ryzen 7 3700X 8-Core Processor, 2026-10-29. Warm timings are medians of repeated runs; cascades run the solver and an always-refactor reference side by side in one process. Solves and downdate rotations run in the WebAssembly kernels (2849 bytes); defaults: nested ordering, at most 16 breaks a step.

## Orderings

How big the dense top of the elimination tree is (the chain of columns from the root down to its first branching), and what a rank-6 downdate of one contact costs, for minimum degree and geometric nested dissection.

| building | chunks | contacts | ordering | order | L blocks | factor | dense top: columns / widest column / share of factor | downdate per contact: mean / max |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| 3 storeys 12×8 m | 652 | 1591 | mindegree | 7 ms | 6240 | 15.8M | 42 / 49 / 18% | 1.1M / 1.5M |
| 3 storeys 12×8 m | 652 | 1591 | nested | 23 ms | 6990 | 16.0M | 28 / 38 / 5% | 0.8M / 1.1M |
| 5 storeys 20×12 m | 2028 | 4990 | mindegree | 19 ms | 30175 | 157.8M | 56 / 100 / 4% | 5.6M / 7.8M |
| 5 storeys 20×12 m | 2028 | 4990 | nested | 22 ms | 35324 | 168.1M | 52 / 96 / 3% | 4.0M / 5.7M |
| 8 storeys 24×16 m | 4230 | 10382 | mindegree | 109 ms | 86836 | 742.5M | 143 / 164 / 14% | 15.7M / 22.6M |
| 8 storeys 24×16 m | 4230 | 10382 | nested | 88 ms | 95270 | 673.9M | 68 / 143 / 2% | 9.8M / 13.0M |
| 12 storeys 24×16 m | 6346 | 15588 | mindegree | 164 ms | 140980 | 1346.7M | 111 / 191 / 4% | 23.8M / 34.9M |
| 12 storeys 24×16 m | 6346 | 15588 | nested | 169 ms | 166607 | 1495.3M | 67 / 194 / 1% | 15.2M / 22.3M |

Counts are multiply-adds (a rotation entry counts 3).

## Warm costs

| building | chunks | idle refactor | full solve | loads-only step | evaluate | island detection | downdate: 1 / 2 / 16 contacts |
|---|---:|---:|---:|---:|---:|---:|---:|
| 3 storeys 12×8 m | 652 | 6 ms | 0.15 ms | 0.63 ms | 0.11 ms | 0.11 ms | 0.6 / 1.1 / 3.1 ms |
| 5 storeys 20×12 m | 2028 | 53 ms | 0.75 ms | 1.06 ms | 0.38 ms | 0.13 ms | 1.3 / 3.2 / 11.9 ms |
| 8 storeys 24×16 m | 4230 | 197 ms | 3.61 ms | 4.30 ms | 1.24 ms | 1.12 ms | 3.5 / 6.0 / 33.5 ms |
| 12 storeys 24×16 m | 6346 | 425 ms | 5.02 ms | 5.53 ms | 1.26 ms | 0.53 ms | 3.7 / 7.2 / 46.8 ms |

A loads-only step (a standing load changed, nothing broken) re-solves with the kept factor: a forward pass over the changed nodes' elimination-tree paths and one backward pass. A downdate is timed on its own; a cascade step adds a loads-only step's worth of solve and evaluate.

## Cascades against an always-refactor reference

**wall**: most of one long wall's ground storey. **rocket**: a 1.6 m hole in a third-storey wall. **half**: the ground-storey supports under 45% of the building (it tears away from the rest, step by step). **heavy**: every ground-storey support but one corner (the building comes down).

| building | scenario | steps | same breaks and islands every step | max Δutilization | max residual (reference) | step median / p95 / max | reference step median | whole cascade (reference) | refactors | idle refactor after |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 3 storeys 12×8 m | wall | 1 | yes | 3.8e-14 | 2.8e-13 (2.3e-13) | 3.3 / 3.3 / 3 ms | 6 ms | 3 ms (6 ms) | 0 | 6 ms |
| 3 storeys 12×8 m | rocket | 1 | yes | 1.9e-14 | 1.1e-13 (1.0e-13) | 2.4 / 2.4 / 2 ms | 6 ms | 2 ms (6 ms) | 0 | 6 ms |
| 3 storeys 12×8 m | half | 10 | yes | 1.5e-8 | 3.7e-9 (2.3e-9) | 3.1 / 6.6 / 7 ms | 6 ms | 31 ms (63 ms) | 1 | 2 ms |
| 3 storeys 12×8 m | heavy | 2 | yes | 0.0e+0 | 1.2e-9 (1.2e-9) | 7.7 / 7.7 / 8 ms | 7 ms | 8 ms (7 ms) | 1 | 0 ms |
| 5 storeys 20×12 m | wall | 21 | yes | 9.6e-7 | 1.1e-7 (5.6e-8) | 8.9 / 17.3 / 32 ms | 54 ms | 197 ms (1103 ms) | 0 | 9 ms |
| 5 storeys 20×12 m | rocket | 1 | yes | 5.6e-14 | 2.9e-13 (2.8e-13) | 24.4 / 24.4 / 24 ms | 53 ms | 24 ms (53 ms) | 0 | 52 ms |
| 5 storeys 20×12 m | half | 15 | yes | 1.4e-7 | 1.2e-8 (9.0e-9) | 6.6 / 13.3 / 30 ms | 54 ms | 128 ms (773 ms) | 0 | 10 ms |
| 5 storeys 20×12 m | heavy | 2 | yes | 0.0e+0 | 1.4e-8 (1.4e-8) | 56.5 / 56.5 / 56 ms | 59 ms | 56 ms (59 ms) | 1 | 0 ms |
| 8 storeys 24×16 m | wall | 23 | yes | 1.0e-5 | 4.9e-7 (5.2e-7) | 21.7 / 41.5 / 57 ms | 201 ms | 536 ms (4488 ms) | 0 | 25 ms |
| 8 storeys 24×16 m | rocket | 1 | yes | 4.7e-14 | 6.3e-13 (6.6e-13) | 23.9 / 23.9 / 24 ms | 200 ms | 24 ms (200 ms) | 0 | 197 ms |
| 8 storeys 24×16 m | half | 18 | yes | 2.5e-6 | 1.5e-7 (1.1e-7) | 21.9 / 42.2 / 116 ms | 202 ms | 512 ms (3485 ms) | 0 | 24 ms |
| 8 storeys 24×16 m | heavy | 2 | yes | 0.0e+0 | 4.0e-8 (4.0e-8) | 204.9 / 204.9 / 205 ms | 203 ms | 205 ms (203 ms) | 1 | 0 ms |
| 12 storeys 24×16 m | wall | 21 | yes | 7.1e-7 | 5.6e-8 (5.8e-8) | 23.4 / 34.9 / 59 ms | 442 ms | 526 ms (9008 ms) | 0 | 42 ms |
| 12 storeys 24×16 m | rocket | 2 | yes | 1.4e-13 | 1.5e-12 (1.5e-12) | 52.8 / 52.8 / 53 ms | 449 ms | 63 ms (874 ms) | 0 | 418 ms |
| 12 storeys 24×16 m | half | 17 | yes | 8.6e-5 | 3.7e-7 (4.6e-7) | 23.4 / 36.9 / 111 ms | 431 ms | 501 ms (6972 ms) | 0 | 43 ms |
| 12 storeys 24×16 m | heavy | 2 | yes | 0.0e+0 | 8.8e-8 (7.7e-8) | 220.4 / 220.4 / 220 ms | 433 ms | 220 ms (433 ms) | 0 | 42 ms |

Δutilization is the largest difference from the reference over the live contacts, after any step (the break offset is 1). The residual is ‖f − K u‖ / ‖f‖; the reference's is in brackets, since a structure about to fail is badly conditioned for any factor.

### What each cascade did

- **3 storeys 12×8 m, wall** (1 steps). Breaks a step: 0: 1; most spared by the cap in one step: 0. Downdates a step: 9–16: 1. Chunks cut loose a step: 0: 1. Island sizes: –.
- **3 storeys 12×8 m, rocket** (1 steps). Breaks a step: 0: 1; most spared by the cap in one step: 0. Downdates a step: 9–16: 1. Chunks cut loose a step: 0: 1. Island sizes: –.
- **3 storeys 12×8 m, half** (10 steps). Breaks a step: 0: 1, 1–2: 1, 3–8: 3, 9–15: 4, 16: 1; most spared by the cap in one step: 11. Downdates a step: 0: 1, 1–2: 1, 3–8: 3, 9–16: 5. Chunks cut loose a step: 0: 8, 1–9: 1, 100–999: 1. Island sizes: 1: 3, 100–999: 1 (largest 572).
- **3 storeys 12×8 m, heavy** (2 steps). Breaks a step: 0: 1, 3–8: 1; most spared by the cap in one step: 0. Downdates a step: 0: 2. Chunks cut loose a step: 0: 1, 100–999: 1. Island sizes: 2–9: 1, 100–999: 1 (largest 601).
- **5 storeys 20×12 m, wall** (21 steps). Breaks a step: 0: 1, 3–8: 11, 9–15: 3, 16: 6; most spared by the cap in one step: 30. Downdates a step: 1–2: 1, 3–8: 10, 9–16: 9, 17–40: 1. Chunks cut loose a step: 0: 13, 1–9: 7, ≥1000: 1. Island sizes: 1: 8, 2–9: 1, ≥1000: 1 (largest 1790).
- **5 storeys 20×12 m, rocket** (1 steps). Breaks a step: 0: 1; most spared by the cap in one step: 0. Downdates a step: 17–40: 1. Chunks cut loose a step: 0: 1. Island sizes: –.
- **5 storeys 20×12 m, half** (15 steps). Breaks a step: 0: 1, 1–2: 2, 3–8: 6, 9–15: 5, 16: 1; most spared by the cap in one step: 9. Downdates a step: 1–2: 2, 3–8: 7, 9–16: 5, ≥41: 1. Chunks cut loose a step: 0: 10, 1–9: 4, ≥1000: 1. Island sizes: 1: 4, 2–9: 1, ≥1000: 1 (largest 1803).
- **5 storeys 20×12 m, heavy** (2 steps). Breaks a step: 0: 1, 3–8: 1; most spared by the cap in one step: 0. Downdates a step: 0: 2. Chunks cut loose a step: 0: 1, ≥1000: 1. Island sizes: 2–9: 2, ≥1000: 1 (largest 1932).
- **8 storeys 24×16 m, wall** (23 steps). Breaks a step: 0: 1, 1–2: 4, 3–8: 7, 9–15: 6, 16: 5; most spared by the cap in one step: 53. Downdates a step: 0: 1, 1–2: 3, 3–8: 7, 9–16: 11, 17–40: 1. Chunks cut loose a step: 0: 13, 1–9: 9, ≥1000: 1. Island sizes: 1: 10, 2–9: 4, ≥1000: 1 (largest 4019).
- **8 storeys 24×16 m, rocket** (1 steps). Breaks a step: 0: 1; most spared by the cap in one step: 0. Downdates a step: 9–16: 1. Chunks cut loose a step: 0: 1. Island sizes: –.
- **8 storeys 24×16 m, half** (18 steps). Breaks a step: 0: 1, 1–2: 1, 3–8: 6, 9–15: 5, 16: 5; most spared by the cap in one step: 17. Downdates a step: 1–2: 1, 3–8: 7, 9–16: 9, ≥41: 1. Chunks cut loose a step: 0: 9, 1–9: 8, ≥1000: 1. Island sizes: 1: 6, 2–9: 5, ≥1000: 1 (largest 4046).
- **8 storeys 24×16 m, heavy** (2 steps). Breaks a step: 0: 1, 3–8: 1; most spared by the cap in one step: 0. Downdates a step: 0: 2. Chunks cut loose a step: 0: 1, ≥1000: 1. Island sizes: ≥1000: 1 (largest 4115).
- **12 storeys 24×16 m, wall** (21 steps). Breaks a step: 0: 1, 1–2: 1, 3–8: 6, 9–15: 10, 16: 3; most spared by the cap in one step: 48. Downdates a step: 1–2: 1, 3–8: 8, 9–16: 11, 17–40: 1. Chunks cut loose a step: 0: 10, 1–9: 10, ≥1000: 1. Island sizes: 1: 13, 2–9: 3, ≥1000: 1 (largest 6135).
- **12 storeys 24×16 m, rocket** (2 steps). Breaks a step: 0: 1, 1–2: 1; most spared by the cap in one step: 0. Downdates a step: 1–2: 1, 9–16: 1. Chunks cut loose a step: 0: 2. Island sizes: –.
- **12 storeys 24×16 m, half** (17 steps). Breaks a step: 0: 1, 1–2: 2, 3–8: 5, 9–15: 5, 16: 4; most spared by the cap in one step: 21. Downdates a step: 1–2: 3, 3–8: 5, 9–16: 8, ≥41: 1. Chunks cut loose a step: 0: 10, 1–9: 6, ≥1000: 1. Island sizes: 1: 7, 2–9: 4, ≥1000: 1 (largest 6166).
- **12 storeys 24×16 m, heavy** (2 steps). Breaks a step: 0: 1, 3–8: 1; most spared by the cap in one step: 0. Downdates a step: 0: 1, ≥41: 1. Chunks cut loose a step: 0: 1, ≥1000: 1. Island sizes: ≥1000: 1 (largest 6231).

### Step time by downdates in the step

Steps from all the cascades above, refactors left out. Median / max (steps).

| building | 0 (loads only) | 1–2 | 3–8 | 9–16 | over 16 (removals) |
|---|---:|---:|---:|---:|---:|
| 3 storeys 12×8 m | 0.0 / 0 ms (1) | 0.5 / 1 ms (1) | 2.2 / 3 ms (3) | 3.3 / 6 ms (7) | – |
| 5 storeys 20×12 m | 0.0 / 0 ms (1) | 2.4 / 5 ms (3) | 5.2 / 32 ms (17) | 11.7 / 13 ms (14) | 24.4 / 30 ms (3) |
| 8 storeys 24×16 m | 7.0 / 7 ms (2) | 8.2 / 21 ms (4) | 16.2 / 22 ms (14) | 28.8 / 42 ms (21) | 116.2 / 116 ms (2) |
| 12 storeys 24×16 m | 0.0 / 0 ms (1) | 10.3 / 20 ms (5) | 17.8 / 22 ms (13) | 30.5 / 53 ms (20) | 110.7 / 220 ms (3) |
