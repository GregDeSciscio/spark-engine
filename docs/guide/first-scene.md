# Your first scene

Fifteen minutes from a clone to a scene of your own. You need Node 22 or newer, pnpm (`npm i -g pnpm`), and Chrome or Edge for WebGPU. Nothing else.

## 1. Run it

```bash
pnpm install
pnpm doctor
pnpm dev:starter
```

`pnpm doctor` lists what the machine has and what each missing optional tool would unlock. Open http://localhost:5175. You are a blue capsule on a grey floor with a pyramid of crates. WASD walks, Space jumps, and there is a thump when you land. Walk into the crates.

That whole app is two files: `apps/starter/src/main.ts` boots the engine, `apps/starter/src/scene.ts` is the scene. Everything below happens in the scene file.

## 2. Make it yours

```bash
pnpm create-app my-game
pnpm install
pnpm --filter @spark/my-game dev
```

`create-app` copies the starter into `apps/my-game`, renames the package, picks a port and wires it into the workspace. The starter stays as a clean reference. Open `apps/my-game/src/scene.ts`.

## 3. Read the scene, top to bottom

A scene is an object with a `name` and a `create(ctx)` function. `ctx` is the engine, handed over once: `entities`, `physics`, `input`, `audio`, `assets`, `animation`, `vfx`, `lighting`, `ui`, `random`, `logger`, `quality`, `renderer`. `create` returns the live scene: a three `scene`, a `camera`, the update hooks you want, and `dispose`.

The starter's `create` does five things, and every scene does some subset of them.

**Lights.** A shadowed directional light and a hemisphere fill. The shadow flags come from `ctx.quality`, which is the preset the user picked; scenes read it and never force it.

**Physics and rendering, joined by entities.** Every physical thing is an entity with a `Transform`. Physics writes the transform each fixed step; a `RenderSync` system copies it onto a three mesh each frame. The `box` helper in the starter makes one of each and binds them:

```ts
const eid = entities.create([Transform, { x, y, z }]);
physics.addBody(eid, { type: 'dynamic', shape: { kind: 'box', hx, hy, hz }, layer: 'debris' });
renderSync.attach(entities, eid, mesh);
```

Layers are named strings, defined the first time you use one.

**A player.** A kinematic capsule driven by `CharacterController`, which slides along walls, steps over ledges and snaps to the ground. Input is read in `fixedUpdate` and turned into a displacement for `controller.move`.

**A sound.** `audio.defineSound` with a synthesised placeholder buffer, played at the player entity when the controller reports it has landed. When you have a file, the definition takes `url` instead of `buffer`.

**Cleanup.** `dispose()` destroys the entities the scene made (that drops their bodies and render bindings) and empties a `DisposeBag` of three geometries, materials and subscriptions. Everything a scene creates, it releases.

## 4. Change three things

Each of these is one edit. Save, and Vite reloads.

- **More crates.** In the pyramid loop, change `row < 4` to `row < 8`. Physics scales; the fixed step stays deterministic.
- **Faster.** `PLAYER_SPEED = 5` to `9`. Movement lives in `fixedUpdate`, so it is frame-rate independent.
- **A different camera.** `CAMERA_OFFSET` is where the camera sits relative to the player. Try `(0, 12, 0.01)` for a top-down view.

## 5. Add something from outside

Drop a glTF into `apps/my-game/public/models/` (the CC0 props in `assets/source/props/` are ready to use: run `pnpm props:build` and copy one from `apps/showcase/public/models/`). Then, in `create`:

```ts
const model = await ctx.assets.loadModel('/models/barrel_03.glb');
bag.add(() => ctx.assets.release('/models/barrel_03.glb'));
const barrel = model.instantiate({ castShadow: true, receiveShadow: true });
barrel.position.set(3, 0, 0);
scene.add(barrel);
```

The asset manager caches by URL and counts references; `release` in the bag gives yours back.

## 6. See what is happening

The stats readout in the corner is always on (`?overlay=0` hides it). F2 opens the inspector: systems and their timings, entity counts, post-processing toggles. `?preset=low` runs without shadows and post on a slow machine. `?seed=7` and `?fixedclock=60` make a run reproducible.

In the console, `window.__spark.engine` is the engine and `window.__spark.stepFrames(30)` advances thirty fixed frames while paused. That is how the repo's own tests and captures drive it.

## Where next

- [concepts.md](concepts.md) explains the pieces you just used and the ones you have not.
- [recipes.md](recipes.md) shows how the showcase does levels, characters, weapons and sound, with the files to read.
- The showcase itself (`pnpm dev:showcase`) is the same scene contract at full size: `apps/showcase/src/scenes/mission.ts` is the `create` of a whole game.
