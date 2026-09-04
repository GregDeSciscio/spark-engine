import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DisposeBag, type SceneDefinition, type SceneInstance } from '@spark/engine';

/**
 * Milestone 0 test scene: neutral environment, one shadowed directional light,
 * a ground plane, a grid of PBR spheres sweeping roughness × metalness, and a
 * rotating torus knot so motion is visible.
 */
export const bootstrapScene: SceneDefinition = {
  name: 'bootstrap',
  create(ctx): SceneInstance {
    const bag = new DisposeBag();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d12);

    const camera = new THREE.PerspectiveCamera(45, ctx.renderer.aspect, 0.1, 100);
    camera.position.set(7, 4.5, 9);
    camera.lookAt(0, 0.8, 0);

    // Environment lighting.
    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const room = new RoomEnvironment();
    const envTarget = pmrem.fromScene(room, 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.35;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    // Key light with shadows.
    const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
    sun.position.set(5, 8, 4);
    sun.castShadow = ctx.quality.shadows;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 30;
    sun.shadow.camera.left = -10;
    sun.shadow.camera.right = 10;
    sun.shadow.camera.top = 10;
    sun.shadow.camera.bottom = -10;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    const fill = new THREE.HemisphereLight(0x8fa9ff, 0x2a1d14, 0.4);
    scene.add(fill);

    // Ground.
    const groundGeo = new THREE.PlaneGeometry(24, 24);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.85, metalness: 0.0 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
    });

    // Roughness × metalness sweep.
    const sphereGeo = new THREE.SphereGeometry(0.45, 48, 32);
    bag.add(() => sphereGeo.dispose());
    const columns = 6;
    const rows = 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const mat = new THREE.MeshStandardMaterial({
          color: r === 0 ? 0xc94d3a : 0xd9d9de,
          roughness: c / (columns - 1),
          metalness: r === 0 ? 0 : 1,
        });
        const mesh = new THREE.Mesh(sphereGeo, mat);
        mesh.position.set((c - (columns - 1) / 2) * 1.2, 0.45, r === 0 ? 2.2 : 3.6);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        bag.add(() => mat.dispose());
      }
    }

    // Static props.
    const boxGeo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x3f7cb8, roughness: 0.35, metalness: 0.1 });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.set(-3.2, 0.7, -1.5);
    box.rotation.y = 0.5;
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);
    bag.add(() => {
      boxGeo.dispose();
      boxMat.dispose();
    });

    // Animated hero object.
    const knotGeo = new THREE.TorusKnotGeometry(0.75, 0.26, 200, 32);
    const knotMat = new THREE.MeshStandardMaterial({
      color: 0xe0b34a,
      roughness: 0.25,
      metalness: 0.9,
      emissive: 0x2a1600,
      emissiveIntensity: 0.6,
    });
    const knot = new THREE.Mesh(knotGeo, knotMat);
    knot.position.set(0.6, 1.6, -0.6);
    knot.castShadow = true;
    knot.receiveShadow = true;
    scene.add(knot);
    bag.add(() => {
      knotGeo.dispose();
      knotMat.dispose();
    });

    let elapsed = 0;

    return {
      scene,
      camera,
      update(dt): void {
        elapsed += dt;
        knot.rotation.y += dt * 0.6;
        knot.rotation.x += dt * 0.25;
        knot.position.y = 1.6 + Math.sin(elapsed * 1.3) * 0.15;
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
