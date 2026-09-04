import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DisposeBag, type ModelAsset, type SceneDefinition, type SceneInstance } from '@spark/engine';

const CRATE_URL = '/models/crate.glb';
const PIPES_URL = '/models/prop-pipe.glb';
const HERO_URL = '/models/hero-placeholder.glb';

const CRATE_COLUMNS = 20;
const CRATE_ROWS = 10;
const CRATE_SPACING = 1.35;

/**
 * Milestone 3 demonstration: three pipeline-processed GLBs (Meshopt-compressed,
 * KTX2-ready) loaded through `ctx.assets`, the crate instantiated 200 times from
 * one cached template, a loading-progress line in the DOM, and a second
 * `loadModel()` of the crate that must be a cache hit.
 */
export const assetsScene: SceneDefinition = {
  name: 'assets',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { assets, logger, random } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c11);

    const camera = new THREE.PerspectiveCamera(42, ctx.renderer.aspect, 0.1, 200);
    camera.position.set(11, 9.5, 21);
    camera.lookAt(0, 0.6, 0.5);

    // Environment + key light, same recipe as bootstrap.
    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.35;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
    sun.position.set(10, 16, 8);
    sun.castShadow = ctx.quality.shadows;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x8fa9ff, 0x2a1d14, 0.4));

    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.9 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
    });

    // Loading progress line. The capture screenshots only the canvas, so this
    // is for humans in the browser; it is removed on dispose.
    const progressEl = document.createElement('div');
    progressEl.setAttribute('data-spark-loading', '');
    Object.assign(progressEl.style, {
      position: 'absolute',
      left: '12px',
      bottom: '12px',
      padding: '6px 10px',
      font: '12px/1.4 ui-monospace, Consolas, monospace',
      color: '#d8e0ff',
      background: 'rgba(8, 10, 16, 0.75)',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    progressEl.textContent = 'loading assets…';
    ctx.config.container.appendChild(progressEl);
    bag.add(() => progressEl.remove());
    bag.add(
      assets.progress.events.on('progress', (s) => {
        const bytes = s.bytesKnown ? ` ${(s.bytesLoaded / 1024).toFixed(0)}/${(s.bytesTotal / 1024).toFixed(0)} KiB` : '';
        progressEl.textContent = `loading ${s.itemsLoaded}/${s.itemsTotal} (${Math.round(s.ratio * 100)}%)${bytes}`;
      }),
    );

    // Every load takes one reference; give them all back on dispose.
    const held: string[] = [];
    const load = (url: string): Promise<ModelAsset> => {
      held.push(url);
      return assets.loadModel(url);
    };
    bag.add(() => {
      for (const url of held) assets.release(url);
    });

    const [crate, pipes, hero] = await Promise.all([load(CRATE_URL), load(PIPES_URL), load(HERO_URL)]);

    // 200 crates from one template: each instantiate() shares geometry and textures.
    const crates = new THREE.Group();
    crates.name = 'crates';
    for (let i = 0; i < CRATE_COLUMNS * CRATE_ROWS; i++) {
      const col = i % CRATE_COLUMNS;
      const row = Math.floor(i / CRATE_COLUMNS);
      const instance = crate.instantiate({ castShadow: true, receiveShadow: true, name: `crate_${i}` });
      instance.position.set((col - (CRATE_COLUMNS - 1) / 2) * CRATE_SPACING, 0.5, (row - (CRATE_ROWS - 1) / 2) * CRATE_SPACING - 3);
      instance.rotation.y = random.range(-0.25, 0.25);
      crates.add(instance);
    }
    scene.add(crates);

    const pipeInstance = pipes.instantiate({ castShadow: true, receiveShadow: true });
    pipeInstance.position.set(-5, 0, 6.5);
    pipeInstance.rotation.y = 0.4;
    scene.add(pipeInstance);

    const heroInstance = hero.instantiate({ castShadow: true, receiveShadow: true });
    heroInstance.position.set(2.5, 0, 6.5);
    scene.add(heroInstance);

    // Animation clips survive the pipeline; drive the hero's clip on its instance.
    const mixer = new THREE.AnimationMixer(heroInstance);
    for (const clip of hero.animations) mixer.clipAction(clip).play();
    bag.add(() => mixer.stopAllAction());

    // Prove caching: a second request for the crate must be served from the
    // cache (same ModelAsset instance, hit counter +1, no new load).
    const before = assets.stats();
    const crateAgain = await load(CRATE_URL);
    const after = assets.stats();
    const hit = crateAgain === crate && after.hits === before.hits + 1 && after.misses === before.misses;
    if (hit) {
      logger.info(`cache hit confirmed for ${CRATE_URL}: same ModelAsset, refs=${assets.refCount(CRATE_URL)}, hits=${after.hits}, misses=${after.misses}`);
    } else {
      logger.error(`cache MISS for ${CRATE_URL}: same=${crateAgain === crate} hits ${before.hits}->${after.hits} misses ${before.misses}->${after.misses}`);
    }

    // Final line once every asset is resident (the `complete` event fires before
    // the last ModelAsset is stored, so cache stats are read here instead).
    const done = assets.stats();
    progressEl.textContent = `loaded ${done.progress.itemsLoaded}/${done.progress.itemsTotal} assets (${(done.progress.bytesTotal / 1024).toFixed(0)} KiB) · cache ${done.items} items, refs ${done.refs}, geo ${(done.geometryBytes / 1024).toFixed(0)} KiB, tex ${(done.textureBytes / 1024).toFixed(0)} KiB · ${hit ? 'cache hit OK' : 'CACHE MISS'}`;

    logger.info(
      `crate: ${crate.info.triangles} tris x${crate.instanceCount} instances, ${crate.info.textures} textures (${(crate.textureBytes / 1024).toFixed(0)} KiB); pipes: ${pipes.info.triangles} tris; hero: ${hero.info.triangles} tris, ${hero.animations.length} clip(s), spark nodes [${hero.sparkNodes.map((n) => `${n.name}:${String(n.spark.type ?? '-')}`).join(', ')}], collision [${hero.collisionNodes.map((n) => n.name).join(', ')}]`,
    );

    return {
      scene,
      camera,
      update(dt): void {
        mixer.update(dt);
        heroInstance.rotation.y += dt * 0.5;
      },
      resize(width, height): void {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },
      dispose(): void {
        bag.dispose();
        scene.clear();
      },
    };
  },
};
