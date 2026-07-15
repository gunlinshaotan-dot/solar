import * as THREE from 'three';
    import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
    import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
    import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
    import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
    import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
    import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
    import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

    const TEX = (typeof window !== 'undefined' && window.__BASE__ ? window.__BASE__ : './') + 'textures/';

    // Realistic size ratios (Earth = 1). Distances compressed for flight, but keep AU order.
    const EARTH_R = 52;
    const SUN_R = EARTH_R * 109.2;
    const AU = SUN_R * 3.35;
    const EYE = 3.5;

    const wrap = document.getElementById('canvas-wrap');
    const hint = document.getElementById('hint');
    const modeEl = document.getElementById('mode');
    const atmoVeil = document.getElementById('atmo-veil');
    const warpVeil = document.getElementById('warp-veil');
    const infoPanel = document.getElementById('planet-info');
    const infoName = document.getElementById('info-name');
    const infoDesc = document.getElementById('info-desc');
    const loadFill = document.getElementById('load-fill');
    const loading = document.getElementById('loading');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000010);

    const BASE_FOV = 62;
    // near must be small so the 3D cockpit room is visible inside the ship
    const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, AU * 400);
    // Overview / R key — outside the corona; actual start is near Earth after planets load
    const SUN_OVERVIEW = new THREE.Vector3(0, AU * 0.55, AU * 2.8);

    const renderer = new THREE.WebGLRenderer({
      antialias: !(/Android/i.test(navigator.userAgent)),
      powerPreference: 'high-performance',
      stencil: false,
      // Huge solar-system scale — without this, depth precision causes flicker when turning
      logarithmicDepthBuffer: true,
    });
    {
      const touchy = ('ontouchstart' in window) || navigator.maxTouchPoints > 0
        || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      const android = /Android/i.test(navigator.userAgent);
      renderer.setPixelRatio(Math.min(devicePixelRatio, touchy ? (android ? 1.25 : 1.5) : 2));
    }
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000008, 1);
    wrap.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(scene, camera));

    // Bloom mostly on the sun; keep stars from blooming into square halos
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.22, 0.35, 0.99);
    composer.addPass(bloomPass);

    const WarpShader = {
      uniforms: {
        tDiffuse: { value: null },
        warp: { value: 0 },
        time: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float warp;
        uniform float time;
        varying vec2 vUv;

        void main() {
          float w = clamp(warp, 0.0, 1.0);
          if (w < 0.008) {
            gl_FragColor = texture2D(tDiffuse, vUv);
            return;
          }

          vec2 center = vec2(0.5);
          vec2 dir = vUv - center;
          float dist = length(dir);
          // Keep the scene readable — light streaks, not a white-out
          float pull = w * 0.045 * dist;
          vec2 uv = center + dir * (1.0 - pull);

          vec3 base = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
          vec3 accum = vec3(0.0);
          const float MAX_S = 6.0;
          float samples = 1.0 + w * (MAX_S - 1.0);
          for (float i = 0.0; i < MAX_S; i++) {
            if (i >= samples) break;
            float t = i / max(samples - 1.0, 1.0);
            vec2 suv = center + dir * (1.0 - w * t * 0.12 * (0.4 + dist));
            accum += texture2D(tDiffuse, clamp(suv, 0.001, 0.999)).rgb;
          }
          accum /= samples;
          vec3 col = mix(base, accum, w * 0.45);

          float ca = w * 0.008 * (0.25 + dist);
          vec2 n = dist > 1e-5 ? dir / dist : vec2(0.0);
          float r = texture2D(tDiffuse, clamp(uv + n * ca, 0.0, 1.0)).r;
          float b = texture2D(tDiffuse, clamp(uv - n * ca, 0.0, 1.0)).b;
          col = mix(col, vec3(r, col.g, b), w * 0.35);

          float rim = smoothstep(0.45, 1.1, dist) * w;
          col += vec3(0.12, 0.35, 0.85) * rim * 0.18;
          float pulse = 0.5 + 0.5 * sin(time * 22.0 + dist * 18.0);
          col *= 1.0 + w * pulse * 0.04;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    };

    const warpPass = new ShaderPass(WarpShader);
    composer.addPass(warpPass);

    const fxaaPass = new ShaderPass(FXAAShader);
    {
      const pr = renderer.getPixelRatio();
      fxaaPass.material.uniforms.resolution.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
    }
    composer.addPass(fxaaPass);
    composer.addPass(new OutputPass());

    // Ship root = flight body. Head = Alt free-look. Camera sits in the seat.
    const ship = new THREE.Object3D();
    ship.name = 'ship';
    scene.add(ship);
    ship.position.copy(SUN_OVERVIEW);

    const head = new THREE.Object3D();
    head.name = 'head';
    ship.add(head);

    const controls = new PointerLockControls(camera, document.body);
    // Keep pointer-lock only — disable built-in FPS euler look (it kills roll / clamps pitch)
    controls.enabled = false;
    controls.pointerSpeed = 0;
    head.add(camera);
    camera.position.set(0, 0.12, 0.08);

    const lookDelta = { x: 0, y: 0 };
    const angVel = new THREE.Vector3(); // local pitch / yaw / roll rates (rad/s)
    let headPitch = 0;
    let headYaw = 0;
    const HEAD_PITCH_MAX = 0.9;
    const HEAD_YAW_MAX = 1.35;
    document.addEventListener('mousemove', (e) => {
      if (!controls.isLocked) return;
      lookDelta.x += e.movementX;
      lookDelta.y += e.movementY;
    }, { passive: true });

    // ---- 3D cockpit room (look around with Alt) ----
    /** @type {{ canvas: HTMLCanvasElement, tex: THREE.CanvasTexture, role: string }[]} */
    const ckScreens = [];
    let cockpitRoot = null;

    function makeHullMat(hex, rough = 0.7, metal = 0.55) {
      return new THREE.MeshStandardMaterial({
        color: hex,
        roughness: rough,
        metalness: metal,
        side: THREE.DoubleSide,
      });
    }

    function buildCockpit() {
      const root = new THREE.Group();
      root.name = 'cockpit3d';

      const matHull = makeHullMat(0x141a22, 0.78, 0.45);
      const matDark = makeHullMat(0x0a0d12, 0.85, 0.35);
      const matFrame = makeHullMat(0x2a3545, 0.45, 0.72);
      const matMetal = makeHullMat(0x3a4658, 0.35, 0.85);
      const matAccent = makeHullMat(0x4a5568, 0.4, 0.7);
      const matGlow = new THREE.MeshStandardMaterial({
        color: 0x1a3048, emissive: 0x2a6aaa, emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.3,
      });
      const matWarn = new THREE.MeshStandardMaterial({
        color: 0x201008, emissive: 0xff6622, emissiveIntensity: 0.45, roughness: 0.4,
      });
      const matOk = new THREE.MeshStandardMaterial({
        color: 0x081410, emissive: 0x33ff88, emissiveIntensity: 0.4, roughness: 0.4,
      });
      const matSeat = makeHullMat(0x10141a, 0.9, 0.15);
      const matCushion = makeHullMat(0x1a222e, 0.95, 0.05);
      const matGrip = makeHullMat(0x1c1410, 0.92, 0.08);

      const addBox = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        root.add(m);
        return m;
      };

      const addCyl = (rTop, rBot, h, mat, x, y, z, rx = 0, ry = 0, rz = 0, segs = 12) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        root.add(m);
        return m;
      };

      const addScreen = (role, spec) => {
        const { w, h, x, y, z, sx, sy, rx = -0.42, ry = 0, rz = 0 } = spec;
        addBox(sx + 0.05, sy + 0.05, 0.04, matFrame, x, y, z - 0.025, rx, ry, rz);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(sx, sy),
          new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
        );
        panel.position.set(x, y, z);
        panel.rotation.set(rx, ry, rz);
        root.add(panel);
        ckScreens.push({ canvas, tex, role });
      };

      const addLed = (x, y, z, col, size = 0.05) => {
        const led = new THREE.Mesh(
          new THREE.BoxGeometry(size, size, 0.02),
          new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: col, emissiveIntensity: 0.7, roughness: 0.25 })
        );
        led.position.set(x, y, z);
        root.add(led);
        return led;
      };

      const addLedPanel = (x, y, z, ry = 0) => {
        addBox(0.48, 0.62, 0.1, matDark, x, y, z, 0, ry, 0);
        const colors = [0xff4444, 0x44ff88, 0x3ec7ff, 0xffaa44, 0xaa66ff, 0xffffff];
        colors.forEach((col, i) => {
          const lx = x + ((i % 3) - 1) * 0.12;
          const ly = y + 0.16 - Math.floor(i / 3) * 0.14;
          const lz = z + 0.06;
          const led = addLed(lx, ly, lz, col, 0.055);
          led.rotation.y = ry;
        });
        for (let i = 0; i < 4; i++) {
          addBox(0.045, 0.03, 0.06, matMetal, x + (i - 1.5) * 0.09, y - 0.2, z + 0.04, 0, ry, 0);
        }
      };

      // Structure
      addBox(4.6, 0.16, 4.2, matDark, 0, -1.22, 0.15);
      addBox(4.6, 0.12, 4.2, matHull, 0, 1.38, 0.15);
      addBox(0.28, 2.7, 4.2, matHull, -2.2, 0.08, 0.15);
      addBox(0.28, 2.7, 4.2, matHull, 2.2, 0.08, 0.15);
      addBox(4.6, 2.7, 0.22, matDark, 0, 0.08, 2.1);

      for (let i = -3; i <= 3; i++) addBox(4.2, 0.02, 0.03, matMetal, 0, -1.13, i * 0.45);
      addBox(0.9, 0.03, 2.8, matAccent, 0, -1.12, 0.4);
      for (let i = 0; i < 8; i++) addBox(0.82, 0.015, 0.04, matMetal, 0, -1.105, -0.6 + i * 0.28);

      for (let i = 0; i < 6; i++) {
        const z = -1.4 + i * 0.55;
        addBox(0.06, 2.2, 0.1, matFrame, -2.02, 0.05, z);
        addBox(0.06, 2.2, 0.1, matFrame, 2.02, 0.05, z);
      }
      for (let i = 0; i < 5; i++) addBox(4.0, 0.08, 0.1, matFrame, 0, 1.28, -1.2 + i * 0.6);
      for (let i = 0; i < 10; i++) {
        addCyl(0.02, 0.02, 0.03, matMetal, -2.05, -0.7 + i * 0.22, -1.5, Math.PI / 2, 0, 0, 6);
        addCyl(0.02, 0.02, 0.03, matMetal, 2.05, -0.7 + i * 0.22, -1.5, Math.PI / 2, 0, 0, 6);
      }

      addCyl(0.05, 0.05, 3.2, matMetal, -2.0, 0.9, 0.1, 0, 0, Math.PI / 2, 10);
      addCyl(0.05, 0.05, 3.2, matMetal, 2.0, 0.9, 0.1, 0, 0, Math.PI / 2, 10);
      addCyl(0.035, 0.035, 3.0, matAccent, -1.95, 0.7, 0.2, 0, 0, Math.PI / 2, 8);
      addCyl(0.035, 0.035, 3.0, matAccent, 1.95, 0.7, 0.2, 0, 0, Math.PI / 2, 8);
      for (let i = -2; i <= 2; i++) {
        addBox(0.08, 0.12, 0.08, matFrame, -2.0, 0.9, i * 0.7);
        addBox(0.08, 0.12, 0.08, matFrame, 2.0, 0.9, i * 0.7);
      }

      addCyl(0.03, 0.03, 2.4, matMetal, -1.7, 0.25, 0.3, 0, 0, Math.PI / 2, 8);
      addCyl(0.03, 0.03, 2.4, matMetal, 1.7, 0.25, 0.3, 0, 0, Math.PI / 2, 8);
      addCyl(0.025, 0.025, 0.45, matMetal, -1.7, 0.02, -0.7, 0, 0, 0, 8);
      addCyl(0.025, 0.025, 0.45, matMetal, 1.7, 0.02, -0.7, 0, 0, 0, 8);

      addBox(0.45, 2.5, 0.4, matFrame, -1.88, 0.15, -1.88);
      addBox(0.45, 2.5, 0.4, matFrame, 1.88, 0.15, -1.88);
      addBox(4.2, 0.38, 0.4, matFrame, 0, 1.22, -1.88);
      addBox(4.2, 0.32, 0.45, matFrame, 0, -0.88, -1.72);
      addBox(3.8, 0.08, 0.25, matAccent, 0, -0.72, -1.55, -0.3, 0, 0);
      addBox(3.7, 0.07, 0.1, matGlow, 0, 1.0, -1.98);
      addBox(3.5, 0.05, 0.08, matGlow, 0, 0.55, -2.0);
      addBox(0.08, 1.8, 0.1, matGlow, -0.95, 0.2, -1.98);
      addBox(0.08, 1.8, 0.1, matGlow, 0.95, 0.2, -1.98);

      addBox(3.7, 0.55, 1.15, matHull, 0, -0.75, -1.22, -0.38, 0, 0);
      addBox(3.4, 0.14, 0.8, matDark, 0, -0.5, -1.42, -0.38, 0, 0);
      addBox(0.35, 0.7, 1.0, matFrame, -1.75, -0.65, -1.15, -0.2, 0.15, 0);
      addBox(0.35, 0.7, 1.0, matFrame, 1.75, -0.65, -1.15, -0.2, -0.15, 0);
      addBox(2.8, 0.12, 0.35, matDark, 0, -1.05, -0.85);
      for (let i = -4; i <= 4; i++) {
        addCyl(0.02, 0.02, 0.4, i % 2 ? matGlow : matMetal, i * 0.22, -1.0, -0.85, Math.PI / 2, 0, 0, 6);
      }

      addBox(0.62, 1.2, 0.95, matHull, -1.58, -0.12, -0.5, 0, 0.22, 0);
      addBox(0.62, 1.2, 0.95, matHull, 1.58, -0.12, -0.5, 0, -0.22, 0);
      addLedPanel(-1.55, 0.38, -0.85, 0.22);
      addLedPanel(1.55, 0.38, -0.85, -0.22);
      for (const side of [-1, 1]) {
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 4; c++) {
            addBox(0.05, 0.04, 0.04, matMetal, side * 1.55 + side * 0.08, -0.35 + r * 0.1, -0.35 - c * 0.08, 0, side * -0.22, 0);
          }
        }
      }

      addBox(2.4, 0.22, 0.85, matFrame, 0, 1.18, -0.3, 0.5, 0, 0);
      addBox(2.5, 0.08, 0.2, matAccent, 0, 1.05, 0.15);
      for (let i = -3; i <= 3; i++) addBox(0.16, 0.05, 0.2, i === 0 ? matWarn : matGlow, i * 0.28, 1.1, -0.15);
      addScreen('overheadL', { w: 160, h: 72, x: -0.58, y: 1.05, z: -0.35, sx: 0.4, sy: 0.18, rx: 0.5, ry: 0, rz: 0 });
      addScreen('overheadR', { w: 160, h: 72, x: 0.58, y: 1.05, z: -0.35, sx: 0.4, sy: 0.18, rx: 0.5, ry: 0, rz: 0 });
      for (let i = -4; i <= 4; i++) addBox(0.04, 0.06, 0.03, matMetal, i * 0.12, 1.0, 0.05, 0.2, 0, 0);

      // Seat
      addBox(1.05, 0.18, 0.95, matSeat, 0, -0.98, 0.95);
      addBox(1.0, 0.12, 0.9, matCushion, 0, -0.88, 0.95);
      addBox(0.95, 1.15, 0.2, matSeat, 0, -0.3, 1.3, -0.12, 0, 0);
      addBox(0.85, 0.7, 0.1, matCushion, 0, -0.2, 1.22, -0.12, 0, 0);
      addBox(0.55, 0.28, 0.16, matCushion, 0, 0.35, 1.35, -0.2, 0, 0);
      addBox(0.14, 0.1, 0.65, matSeat, -0.58, -0.55, 1.05);
      addBox(0.14, 0.1, 0.65, matSeat, 0.58, -0.55, 1.05);
      addBox(0.12, 0.45, 0.12, matFrame, -0.58, -0.75, 1.25);
      addBox(0.12, 0.45, 0.12, matFrame, 0.58, -0.75, 1.25);
      addCyl(0.18, 0.28, 0.35, matFrame, 0, -1.1, 1.0, 0, 0, 0, 10);
      addBox(0.7, 0.08, 0.7, matMetal, 0, -1.22, 1.0);

      // Yoke / steering wheel
      const yoke = new THREE.Group();
      yoke.name = 'yoke';
      yoke.position.set(0, -0.42, -0.72);
      yoke.rotation.x = -0.35;
      root.add(yoke);
      root.userData.yoke = yoke;

      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.55, 12), matMetal);
      column.position.set(0, -0.15, 0.12);
      column.rotation.x = 0.55;
      yoke.add(column);
      const colJoint = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), matAccent);
      colJoint.position.set(0, 0.05, -0.05);
      yoke.add(colJoint);

      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 10, 28), matGrip);
      rim.position.set(0, 0.12, -0.08);
      yoke.add(rim);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 12), matMetal);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(0, 0.12, -0.08);
      yoke.add(hub);
      for (let a = 0; a < 3; a++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.025), matMetal);
        spoke.position.set(0, 0.12, -0.08);
        spoke.rotation.z = (a * Math.PI) / 3;
        yoke.add(spoke);
      }
      const leftGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.16, 10), matGrip);
      leftGrip.position.set(-0.28, 0.12, -0.08);
      leftGrip.rotation.z = Math.PI / 2;
      yoke.add(leftGrip);
      const rightGrip = leftGrip.clone();
      rightGrip.position.x = 0.28;
      yoke.add(rightGrip);
      const btnL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.02), matOk);
      btnL.position.set(-0.28, 0.18, -0.02);
      yoke.add(btnL);
      const btnR = btnL.clone();
      btnR.material = matWarn;
      btnR.position.x = 0.28;
      yoke.add(btnR);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.02), matGlow);
      plate.position.set(0, 0.12, 0.0);
      yoke.add(plate);

      // Throttle
      addBox(0.35, 0.12, 0.55, matDark, 0.72, -0.62, -0.85, -0.25, 0, 0);
      const throttle = new THREE.Group();
      throttle.position.set(0.72, -0.52, -0.75);
      root.add(throttle);
      root.userData.throttle = throttle;
      for (let i = 0; i < 2; i++) {
        const lever = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 0.04), matMetal);
        lever.position.set((i - 0.5) * 0.12, 0.08, 0);
        lever.rotation.x = -0.4;
        throttle.add(lever);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), i === 0 ? matOk : matWarn);
        knob.position.set((i - 0.5) * 0.12, 0.22, -0.08);
        throttle.add(knob);
      }
      for (let i = 0; i < 5; i++) addBox(0.28, 0.015, 0.015, matMetal, 0.72, -0.58, -0.65 - i * 0.08, -0.25, 0, 0);

      // Side stick
      addBox(0.22, 0.1, 0.22, matDark, -0.7, -0.68, -0.7);
      addCyl(0.035, 0.04, 0.22, matMetal, -0.7, -0.55, -0.7, 0.3, 0, 0, 10);
      addCyl(0.05, 0.04, 0.12, matGrip, -0.7, -0.42, -0.78, 0.3, 0, 0, 10);

      // Pedals
      for (const side of [-1, 1]) {
        addBox(0.22, 0.04, 0.35, matMetal, side * 0.28, -1.08, -0.35, 0.15, 0, 0);
        addBox(0.18, 0.03, 0.12, matGrip, side * 0.28, -1.04, -0.22, 0.4, 0, 0);
        addCyl(0.02, 0.02, 0.25, matFrame, side * 0.28, -1.15, -0.45, Math.PI / 2, 0, 0, 6);
      }

      addBox(2.6, 0.02, 0.06, matGlow, 0, -1.12, -0.35);
      addBox(2.6, 0.02, 0.06, matGlow, 0, -1.12, 1.5);
      for (let i = -2; i <= 2; i++) {
        addBox(0.35, 0.04, 0.5, matDark, i * 0.7, 1.3, 0.6);
        for (let j = 0; j < 4; j++) addBox(0.3, 0.01, 0.04, matMetal, i * 0.7, 1.28, 0.42 + j * 0.1);
      }
      addLed(-1.95, 1.1, -1.7, 0x88ccff, 0.07);
      addLed(1.95, 1.1, -1.7, 0x88ccff, 0.07);
      addLed(-1.95, -0.9, 1.8, 0xff8844, 0.06);
      addLed(1.95, -0.9, 1.8, 0xff8844, 0.06);

      addCyl(0.08, 0.08, 0.45, matWarn, -1.85, -0.7, 1.7, 0, 0, 0, 10);
      addCyl(0.03, 0.03, 0.12, matMetal, -1.85, -0.42, 1.7, 0, 0, 0, 8);

      addBox(1.4, 1.0, 0.25, matHull, -1.2, 0.0, 1.95);
      addBox(1.4, 1.0, 0.25, matHull, 1.2, 0.0, 1.95);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          addBox(0.9, 0.08, 0.06, matMetal, side * 1.2, -0.3 + i * 0.25, 1.82);
          addLed(side * 1.2, -0.3 + i * 0.25, 1.78, [0x44ff88, 0x3ec7ff, 0xffaa44][i], 0.04);
        }
      }

      const tilt = -0.42;
      addScreen('radar', { w: 150, h: 120, x: -1.38, y: -0.36, z: -1.56, sx: 0.30, sy: 0.24, rx: tilt });
      addScreen('planetInfo', { w: 220, h: 160, x: -0.88, y: -0.33, z: -1.58, sx: 0.36, sy: 0.26, rx: tilt });
      addScreen('map', { w: 300, h: 220, x: 0, y: -0.26, z: -1.64, sx: 0.54, sy: 0.40, rx: tilt });
      addScreen('target', { w: 220, h: 150, x: 0.88, y: -0.33, z: -1.58, sx: 0.36, sy: 0.25, rx: tilt });
      addScreen('flight', { w: 150, h: 120, x: 1.38, y: -0.36, z: -1.56, sx: 0.30, sy: 0.24, rx: tilt });
      addScreen('sideL', { w: 200, h: 140, x: -1.5, y: -0.05, z: -0.68, sx: 0.34, sy: 0.24, rx: -0.08, ry: 0.28, rz: 0 });
      addScreen('compass', { w: 180, h: 180, x: 1.5, y: 0.05, z: -0.68, sx: 0.32, sy: 0.32, rx: -0.08, ry: -0.28, rz: 0 });
      addScreen('sysMap', { w: 340, h: 190, x: 0, y: 0.45, z: 1.96, sx: 1.05, sy: 0.58, rx: 0, ry: Math.PI, rz: 0 });

      const cabinKey = new THREE.PointLight(0x6aa8ff, 1.25, 8, 1.5);
      cabinKey.position.set(0, 0.7, 0.15);
      root.add(cabinKey);
      const dashFill = new THREE.PointLight(0x3ec7ff, 0.7, 5, 2);
      dashFill.position.set(0, -0.15, -1.0);
      root.add(dashFill);
      const yokeLight = new THREE.PointLight(0xaaccff, 0.35, 2.5, 2);
      yokeLight.position.set(0, -0.2, -0.5);
      root.add(yokeLight);
      const rimL = new THREE.PointLight(0x88aacc, 0.3, 5, 2);
      rimL.position.set(-1.7, 0.35, 0.5);
      root.add(rimL);
      const rimR = new THREE.PointLight(0x88aacc, 0.3, 5, 2);
      rimR.position.set(1.7, 0.35, 0.5);
      root.add(rimR);

      return root;
    }

    cockpitRoot = buildCockpit();
    cockpitRoot.visible = false;
    ship.add(cockpitRoot);
    document.body.classList.add('cockpit-3d');

    // Hyperspace streak field (camera-local light lines)
    const warpStreakCount = 280;
    const warpStreakPos = new Float32Array(warpStreakCount * 6);
    const warpStreakSeed = [];
    for (let i = 0; i < warpStreakCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 8 + Math.random() * 85;
      const z = -20 - Math.random() * 220;
      warpStreakSeed.push({ ang, rad, z, len: 4 + Math.random() * 28, spin: 0.4 + Math.random() * 1.6 });
    }
    const warpStreakGeo = new THREE.BufferGeometry();
    warpStreakGeo.setAttribute('position', new THREE.BufferAttribute(warpStreakPos, 3));
    const warpStreakMat = new THREE.LineBasicMaterial({
      color: 0xa8d8ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const warpStreaks = new THREE.LineSegments(warpStreakGeo, warpStreakMat);
    warpStreaks.frustumCulled = false;
    camera.add(warpStreaks);

    let warpIntensity = 0;
    let warpNearSun = 0;
    let flightBuzz = 0; // 0..1 cruise turbulence
    let isThrusting = false;
    const warpShake = new THREE.Vector3();
    let warpShakeActive = false;
    const warpShakeQuat = new THREE.Quaternion();
    const warpShakeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    let warpShakeQuatActive = false;
    const portholeEl = document.getElementById('porthole');
    let mobileLookHeld = false;
    const keys = {};

    function isAltLook() {
      return !!(keys.AltLeft || keys.AltRight || mobileLookHeld);
    }

    function syncCockpitVisibility() {
      if (!cockpitRoot) return;
      cockpitRoot.visible = isPlaying() && !landed;
    }

    function refreshWarpStreaks(amount, dt) {
      const pos = warpStreakGeo.attributes.position.array;
      const speed = 120 + amount * 900;
      for (let i = 0; i < warpStreakCount; i++) {
        const s = warpStreakSeed[i];
        s.z += speed * dt;
        if (s.z > 20) {
          s.z = -30 - Math.random() * 260;
          s.ang = Math.random() * Math.PI * 2;
          s.rad = 6 + Math.random() * 70;
          s.len = 8 + Math.random() * (18 + amount * 55);
        }
        s.ang += s.spin * dt * amount * 1.4;
        const x = Math.cos(s.ang) * s.rad;
        const y = Math.sin(s.ang) * s.rad;
        const stretch = s.len * (0.5 + amount * 3.6);
        const i6 = i * 6;
        pos[i6] = x; pos[i6 + 1] = y; pos[i6 + 2] = s.z;
        pos[i6 + 3] = x; pos[i6 + 4] = y; pos[i6 + 5] = s.z + stretch;
      }
      warpStreakGeo.attributes.position.needsUpdate = true;
      warpStreakMat.opacity = 0.25 + amount * 0.55;
      warpStreakMat.color.setRGB(0.65 + amount * 0.25, 0.85, 1.0);
    }


    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isMobileUA = isTouch || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    // Refresh PR (already set earlier) and lighten post on phones
    if (isMobileUA) {
      bloomPass.strength = isAndroid ? 0.12 : 0.16;
      bloomPass.threshold = 0.995;
    }

    const mobilePad = document.getElementById('mobile-pad');
    const hintText = document.getElementById('hint-text');
    let mobilePlaying = false;
    const mobileMove = { x: 0, z: 0 };

    if (isTouch && hintText) {
      hintText.textContent = 'Нажмите «Начать полёт». Джойстик — тяга · свайп — поворот · 👁 — осмотр кабины · ⚡ — варп · ВЗЛЁТ — с поверхности.';
    }

    function startPlay() {
      if (isTouch) {
        mobilePlaying = true;
        mobilePad.classList.add('active');
        hint.classList.add('hidden');
        requestAppFullscreen();
        fitAppViewport();
      } else {
        controls.lock();
      }
    }

    function isPlaying() {
      return mobilePlaying || controls.isLocked;
    }

    function fitAppViewport(force) {
      const vv = window.visualViewport;
      // Prefer visualViewport; on Android rotate, briefly falls back to screen dims
      let w = Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 1);
      let h = Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 1);
      // After orientation flip some Android Chrome builds report swapped/stale values once
      if (screen.orientation?.type) {
        const landscape = screen.orientation.type.startsWith('landscape');
        if (landscape && w < h) { const t = w; w = h; h = t; }
        if (!landscape && h < w) { const t = w; w = h; h = t; }
      }
      if (!force && w === fitAppViewport._w && h === fitAppViewport._h) return;
      fitAppViewport._w = w;
      fitAppViewport._h = h;
      document.documentElement.style.setProperty('--app-w', `${w}px`);
      document.documentElement.style.setProperty('--app-h', `${h}px`);
      if (typeof camera !== 'undefined' && camera && renderer) {
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        composer.setSize(w, h);
        const pr = renderer.getPixelRatio();
        fxaaPass.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        bloomPass.resolution.set(w, h);
      }
    }
    fitAppViewport._w = 0;
    fitAppViewport._h = 0;

    function scheduleFitViewport() {
      fitAppViewport(true);
      // Android: layout settles after rotate — refit a few times
      clearTimeout(scheduleFitViewport._t1);
      clearTimeout(scheduleFitViewport._t2);
      clearTimeout(scheduleFitViewport._t3);
      scheduleFitViewport._t1 = setTimeout(() => fitAppViewport(true), 50);
      scheduleFitViewport._t2 = setTimeout(() => fitAppViewport(true), 180);
      scheduleFitViewport._t3 = setTimeout(() => fitAppViewport(true), 400);
    }

    async function requestAppFullscreen() {
      const el = document.documentElement;
      try {
        if (document.fullscreenElement) return;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      } catch (_) { /* user gesture / unsupported */ }
    }

    function toggleHud() {
      document.body.classList.toggle('hud-hidden');
      const hidden = document.body.classList.contains('hud-hidden');
      const btn = document.getElementById('hud-toggle');
      if (btn) {
        btn.textContent = hidden ? '▢' : '▣';
        btn.title = hidden ? 'Показать HUD (H)' : 'Скрыть HUD (H)';
      }
    }

    document.getElementById('hud-toggle').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHud();
    });

    fitAppViewport(true);
    window.addEventListener('resize', scheduleFitViewport);
    window.addEventListener('orientationchange', scheduleFitViewport);
    window.visualViewport?.addEventListener('resize', scheduleFitViewport);
    window.visualViewport?.addEventListener('scroll', () => fitAppViewport(true));
    screen.orientation?.addEventListener?.('change', scheduleFitViewport);
    document.addEventListener('fullscreenchange', scheduleFitViewport);
    window.addEventListener('pageshow', scheduleFitViewport);

    hint.addEventListener('click', startPlay);
    hint.querySelector('.cta')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startPlay();
    });
    controls.addEventListener('lock', () => hint.classList.add('hidden'));
    controls.addEventListener('unlock', () => {
      if (!isTouch) hint.classList.remove('hidden');
    });

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const loader = new THREE.TextureLoader();

    function prepTex(tex, color = true) {
      if (color) tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      return tex;
    }

    /** Soften left/right equator join so sphere maps don't show a vertical seam */
    function fixSeam(texture, blendPx = 24) {
      const img = texture.image;
      if (!img || !img.width) return texture;
      // Skip full pixel bake on huge 8K maps (too heavy) — Wrap + shader handles it
      if (img.width > 4096) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        return texture;
      }
      const w = img.width, h = img.height;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h);
      const d = data.data;
      const b = Math.min(blendPx, (w / 2) | 0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < b; x++) {
          const t = x / b;
          const iL = (y * w + x) * 4;
          const iR = (y * w + (w - 1 - x)) * 4;
          for (let k = 0; k < 3; k++) {
            const left = d[iL + k];
            const right = d[iR + k];
            const mid = left * (1 - t) + right * t;
            d[iL + k] = left * t + mid * (1 - t);
            d[iR + k] = right * t + mid * (1 - t);
          }
        }
      }
      ctx.putImageData(data, 0, 0);
      const out = new THREE.CanvasTexture(c);
      return prepTex(out, true);
    }

    function loadTex(name, color = true) {
      return new Promise((resolve, reject) => {
        loader.load(TEX + name, (t) => resolve(prepTex(t, color)), undefined, reject);
      });
    }

    const needed = [
      'sun.jpg', 'mercury.jpg', 'venus.jpg', 'earth.jpg', 'earth_clouds.jpg',
      'moon.jpg', 'mars.jpg', 'jupiter.jpg', 'saturn.jpg', 'saturn_ring.png',
      'uranus.jpg', 'neptune.jpg',
    ];

    let loaded = 0;
    function bump() {
      loaded++;
      loadFill.style.width = `${Math.round((loaded / needed.length) * 100)}%`;
    }

    async function loadAll() {
      const map = {};
      await Promise.all(needed.map(async (name) => {
        map[name] = await loadTex(name, true);
        bump();
      }));
      scene.background = new THREE.Color(0x000008);
      return map;
    }

    function starSpriteTex() {
      // Hard round disc — corners fully transparent so Points never look like cubes
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.clearRect(0, 0, 64, 64);
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 28);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,1)');
      grad.addColorStop(0.7, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(32, 32, 28, 0, Math.PI * 2);
      g.fill();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    const starMap = starSpriteTex();

    function addStars(count, radius, pixelSize, colorHex, attenuate = false, shell = 0.12) {
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      const c = new THREE.Color(colorHex);
      for (let i = 0; i < count; i++) {
        // Thin outer shell — looks like a sky from anywhere inside the system
        const r = radius * (1 - shell + Math.random() * shell);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        pos[i * 3 + 2] = r * Math.cos(phi);
        const b = 0.55 + Math.random() * 0.45;
        col[i * 3] = Math.min(1, c.r * b);
        col[i * 3 + 1] = Math.min(1, c.g * b);
        col[i * 3 + 2] = Math.min(1, c.b * b);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return new THREE.Points(geo, new THREE.PointsMaterial({
        size: pixelSize,
        sizeAttenuation: attenuate,
        map: starMap,
        alphaMap: starMap,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: true,
        vertexColors: true,
        blending: THREE.NormalBlending,
        // No alphaTest — hard cutoffs cause star flicker when rotating
        toneMapped: true,
      }));
    }

    function makeLabel(text) {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(40, 24, 432, 80, 16);
      ctx.fill();
      ctx.font = '600 52px Space Grotesk, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f0f6ff';
      ctx.fillText(text, 256, 68);
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        depthTest: false,
        opacity: 0.75,
        toneMapped: true,
      }));
      spr.scale.set(EARTH_R * 3.2, EARTH_R * 0.8, 1);
      return spr;
    }

    function makeOrbit(radius) {
      const pts = [];
      for (let i = 0; i <= 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      }
      return new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.12 })
      );
    }

    function makeRings(inner, outer, ringTex) {
      const geo = new THREE.RingGeometry(inner, outer, 192, 16);
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const r = Math.sqrt(x * x + y * y);
        uv.setXY(i, (r - inner) / (outer - inner), 0.5);
      }
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: ringTex,
        alphaMap: ringTex,
        transparent: true,
        side: THREE.DoubleSide,
        roughness: 0.82,
        metalness: 0.12,
        envMapIntensity: 0.45,
        depthWrite: false,
        opacity: 0.95,
      }));
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    }

    // Seamless glowing sun shader (blends U wrap to kill the seam)
    function makeSunMaterial(map) {
      return new THREE.ShaderMaterial({
        uniforms: {
          map: { value: map },
          time: { value: 0 },
          brightness: { value: 2.15 },
        },
        vertexShader: /* glsl */`
          #include <common>
          #include <logdepthbuf_pars_vertex>
          varying vec2 vUv;
          varying vec3 vNormalW;
          varying vec3 vWorldPos;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            #include <logdepthbuf_vertex>
          }
        `,
        fragmentShader: /* glsl */`
          #include <logdepthbuf_pars_fragment>
          uniform sampler2D map;
          uniform float time;
          uniform float brightness;
          varying vec2 vUv;
          varying vec3 vNormalW;
          varying vec3 vWorldPos;

          vec3 sampleSeamless(vec2 uv) {
            vec3 a = texture2D(map, uv).rgb;
            float edge = min(uv.x, 1.0 - uv.x);
            float mixEdge = 1.0 - smoothstep(0.0, 0.04, edge);
            vec3 wrapped = texture2D(map, vec2(fract(uv.x + (uv.x < 0.5 ? 0.003 : -0.003)), uv.y)).rgb;
            return mix(a, wrapped, mixEdge * 0.9);
          }

          void main() {
            #include <logdepthbuf_fragment>
            vec2 uv = vUv;
            uv.x += sin(uv.y * 40.0 + time * 0.4) * 0.0012;
            vec3 col = sampleSeamless(uv);
            col = pow(col, vec3(0.88)) * brightness;
            float limb = pow(1.0 - max(0.0, dot(normalize(vNormalW), normalize(cameraPosition - vWorldPos))), 1.6);
            col += vec3(1.0, 0.62, 0.22) * limb * 0.35;
            col += vec3(1.0, 0.85, 0.55) * 0.08;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        toneMapped: false,
      });
    }

    const PLANETS = [
      { name: 'Меркурий', desc: 'Маленькая каменистая планета. Спутников нет.', map: 'mercury.jpg', size: EARTH_R * 0.383, au: 0.39, speed: 1.6, tilt: 0.03, rough: 0.95, metal: 0.12, landable: true, moons: [] },
      { name: 'Венера', desc: 'Плотная атмосфера. Спутников нет.', map: 'venus.jpg', size: EARTH_R * 0.949, au: 0.72, speed: 1.18, tilt: 3.09, rough: 0.55, metal: 0.02, landable: true, atmo: 0xffd090, moons: [] },
      {
        name: 'Земля', desc: 'Наш дом. Спуститесь на поверхность и прогуляйтесь.', map: 'earth.jpg', size: EARTH_R, au: 1.0, speed: 1.0, tilt: 0.41, rough: 0.55, metal: 0.08, landable: true, earth: true, atmo: 0x6eb6ff,
        moons: [
          { name: 'Луна', desc: 'Единственный спутник Земли. Серый кратерированный мир.', size: 0.273, dist: 18, speed: 0.35, color: 0xffffff },
        ],
      },
      {
        name: 'Марс', desc: 'Красные пустыни. Идеальное место для посадки.', map: 'mars.jpg', size: EARTH_R * 0.532, au: 1.52, speed: 0.8, tilt: 0.44, rough: 0.9, metal: 0.04, landable: true, atmo: 0xff8866,
        moons: [
          { name: 'Фобос', desc: 'Ближний спутник Марса. Неправильная форма, много кратеров.', size: 0.08, dist: 3.2, speed: 1.1, color: 0xc4a882 },
          { name: 'Деймос', desc: 'Дальний маленький спутник Марса.', size: 0.055, dist: 5.5, speed: 0.55, color: 0xb09a7a },
        ],
      },
      {
        name: 'Юпитер', desc: 'Газовый гигант. Можно «сесть» в верхние слои атмосферы.', map: 'jupiter.jpg', size: EARTH_R * 11.21, au: 5.2, speed: 0.43, tilt: 0.05, rough: 0.7, metal: 0.0, landable: true,
        moons: [
          { name: 'Ио', desc: 'Вулканический спутник. Самое активное тело Солнечной системы.', size: 0.286, dist: 2.4, speed: 0.85, color: 0xf0c060 },
          { name: 'Европа', desc: 'Ледяная кора и возможный океан под поверхностью.', size: 0.245, dist: 3.2, speed: 0.62, color: 0xd8e8f0 },
          { name: 'Ганимед', desc: 'Крупнейший спутник в Солнечной системе.', size: 0.413, dist: 4.2, speed: 0.42, color: 0xa89880 },
          { name: 'Каллисто', desc: 'Древняя изрытая кратерами поверхность.', size: 0.378, dist: 5.4, speed: 0.28, color: 0x6a6058 },
        ],
      },
      {
        name: 'Сатурн', desc: 'Сядьте у колец или на облачный слой.', map: 'saturn.jpg', size: EARTH_R * 9.45, au: 9.58, speed: 0.32, tilt: 0.47, rough: 0.68, metal: 0.0, landable: true, rings: true,
        moons: [
          { name: 'Титан', desc: 'Самый крупный спутник Сатурна. Плотная атмосфера и озёра метана.', size: 0.404, dist: 3.6, speed: 0.38, color: 0xd4a060 },
          { name: 'Рея', desc: 'Ледяной спутник с яркой поверхностью.', size: 0.12, dist: 2.8, speed: 0.55, color: 0xe8e4dc },
          { name: 'Энцелад', desc: 'Свежий лёд и гейзеры из-под коры.', size: 0.09, dist: 2.3, speed: 0.72, color: 0xf2f6ff },
          { name: 'Япет', desc: 'Двухцветный спутник — светлая и тёмная половины.', size: 0.115, dist: 5.0, speed: 0.25, color: 0x9a9080 },
        ],
      },
      {
        name: 'Уран', desc: 'Ледяной гигант. Посадка на верхнюю атмосферу.', map: 'uranus.jpg', size: EARTH_R * 4.01, au: 19.2, speed: 0.23, tilt: 1.71, rough: 0.42, metal: 0.02, landable: true, atmo: 0xa8fff4,
        moons: [
          { name: 'Титания', desc: 'Крупнейший спутник Урана.', size: 0.124, dist: 3.0, speed: 0.4, color: 0xc8d0d8 },
          { name: 'Оберон', desc: 'Дальний спутник Урана с тёмными кратерами.', size: 0.119, dist: 3.8, speed: 0.3, color: 0x9aa0a8 },
          { name: 'Ариэль', desc: 'Яркий ледяной спутник с каньонами.', size: 0.09, dist: 2.4, speed: 0.55, color: 0xdce4ea },
        ],
      },
      {
        name: 'Нептун', desc: 'Самая дальняя планета. Можно приземлиться на атмосферу.', map: 'neptune.jpg', size: EARTH_R * 3.88, au: 30.05, speed: 0.18, tilt: 0.49, rough: 0.45, metal: 0.03, landable: true, atmo: 0x5a8cff,
        moons: [
          { name: 'Тритон', desc: 'Крупный спутник Нептуна. Ретроградная орбита и гейзеры азота.', size: 0.212, dist: 3.4, speed: 0.33, color: 0xc8d8e0 },
          { name: 'Протей', desc: 'Крупный внутренний спутник Нептуна неправильной формы.', size: 0.07, dist: 2.5, speed: 0.6, color: 0x889098 },
        ],
      },
    ];

    PLANETS.forEach((p) => { p.dist = AU * p.au; });

    const bodies = [];
    let asteroids;
    let sunMat;

    const maps = await loadAll();
    loading.classList.add('done');

    // Fix seams on all planet + sun maps
    maps['sun.jpg'] = fixSeam(maps['sun.jpg'], 40);
    for (const key of ['mercury.jpg', 'venus.jpg', 'earth.jpg', 'mars.jpg', 'jupiter.jpg', 'saturn.jpg', 'uranus.jpg', 'neptune.jpg', 'moon.jpg', 'earth_clouds.jpg']) {
      maps[key] = fixSeam(maps[key], 18);
    }

    // ---- Space lighting: neutral white sun, cool star fill ----
    function buildSpaceEnvironment() {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 256;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#04060e');
      g.addColorStop(0.5, '#020308');
      g.addColorStop(1, '#010205');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 256);
      // Tiny cool spotlight for specular only — no warm orange cast
      const sunG = ctx.createRadialGradient(256, 128, 1, 256, 128, 28);
      sunG.addColorStop(0, 'rgba(240, 248, 255, 0.55)');
      sunG.addColorStop(0.35, 'rgba(180, 210, 255, 0.12)');
      sunG.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = sunG;
      ctx.beginPath();
      ctx.arc(256, 128, 28, 0, Math.PI * 2);
      ctx.fill();
      const equirect = new THREE.CanvasTexture(c);
      equirect.mapping = THREE.EquirectangularReflectionMapping;
      equirect.colorSpace = THREE.SRGBColorSpace;
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromEquirectangular(equirect).texture;
      equirect.dispose();
      pmrem.dispose();
      return env;
    }

    scene.environment = buildSpaceEnvironment();
    scene.environmentIntensity = 0.04;

    scene.add(new THREE.AmbientLight(0x6a7a9a, 0.06));
    scene.add(new THREE.HemisphereLight(0x8aa0c8, 0x02040a, 0.08));

    // Neutral daylight — avoid orange tint on every planet
    const sunLight = new THREE.PointLight(0xfff8f2, 1900, AU * 90, 0.85);
    scene.add(sunLight);
    const sunFar = new THREE.PointLight(0xe8f0ff, 55, AU * 120, 0.7);
    scene.add(sunFar);

    // Tiny almost-point stars, FAR beyond Neptune
    // Round pinpoint stars (need ~2px+ so the circle texture can resolve)
    const STAR_R = AU * 140;
    scene.add(addStars(32000, STAR_R, 2.0, 0xffffff, false, 0.08));
    scene.add(addStars(16000, STAR_R * 0.95, 2.4, 0xd0e4ff, false, 0.1));
    scene.add(addStars(7000, STAR_R * 0.9, 2.8, 0xffe8c0, false, 0.12));
    scene.add(addStars(5000, AU * 55, 2.2, 0xffffff, false, 0.35));
    scene.add(addStars(2500, AU * 75, 2.6, 0xe8f0ff, false, 0.3));

    // Sun
    const sunGroup = new THREE.Group();
    scene.add(sunGroup);
    sunMat = makeSunMaterial(maps['sun.jpg']);
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 160, 160), sunMat);
    sunGroup.add(sunMesh);

    sunGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R * 1.06, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffc878,
        transparent: true,
        opacity: 0.14,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    ));
    sunGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R * 1.18, 48, 48),
      new THREE.MeshBasicMaterial({
        color: 0xff8a3a,
        transparent: true,
        opacity: 0.05,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    ));

    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    {
      const g = glowCanvas.getContext('2d');
      const grad = g.createRadialGradient(128, 128, 4, 128, 128, 128);
      grad.addColorStop(0, 'rgba(255,248,230,0.9)');
      grad.addColorStop(0.15, 'rgba(255,210,140,0.45)');
      grad.addColorStop(0.4, 'rgba(255,140,50,0.12)');
      grad.addColorStop(0.7, 'rgba(255,80,20,0.03)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
    }
    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(glowCanvas),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.75,
    }));
    // Keep glow inside ~0.7 AU so Earth/spawn aren't inside the corona
    sunGlow.scale.set(SUN_R * 2.15, SUN_R * 2.15, 1);
    sunGroup.add(sunGlow);

    const orbitGroup = new THREE.Group();
    scene.add(orbitGroup);

    PLANETS.forEach((p, index) => {
      orbitGroup.add(makeOrbit(p.dist));
      const pivot = new THREE.Object3D();
      scene.add(pivot);

      const envI = p.rough < 0.5 ? 0.28 : (p.size > EARTH_R * 3 ? 0.18 : 0.1);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(p.size, 192, 192),
        new THREE.MeshStandardMaterial({
          map: maps[p.map],
          roughness: p.rough,
          metalness: p.metal,
          envMapIntensity: envI,
          flatShading: false,
        })
      );
      mesh.rotation.z = p.tilt;
      mesh.position.x = p.dist;
      mesh.userData = { name: p.name, desc: p.desc, index, landable: p.landable };
      pivot.add(mesh);

      const atmoColor = p.atmo || 0x88aadd;

      if (p.rings) {
        const rings = makeRings(p.size * 1.35, p.size * 2.45, maps['saturn_ring.png']);
        rings.rotation.x = Math.PI / 2.15;
        mesh.add(rings);
      }

      if (p.earth) {
        const clouds = new THREE.Mesh(
          new THREE.SphereGeometry(p.size * 1.015, 128, 128),
          new THREE.MeshStandardMaterial({
            map: maps['earth_clouds.jpg'],
            transparent: true,
            opacity: 0.48,
            depthWrite: false,
            roughness: 1,
            metalness: 0,
            envMapIntensity: 0.1,
          })
        );
        mesh.add(clouds);
        mesh.userData.clouds = clouds;
      }

      const moons = [];
      (p.moons || []).forEach((mDef, mi) => {
        const mSize = EARTH_R * mDef.size;
        const orbitR = p.size * mDef.dist + mSize;
        const moonMesh = new THREE.Mesh(
          new THREE.SphereGeometry(mSize, mSize > EARTH_R * 0.15 ? 96 : 64, mSize > EARTH_R * 0.15 ? 96 : 64),
          new THREE.MeshStandardMaterial({
            map: maps['moon.jpg'],
            color: mDef.color,
            roughness: 0.92,
            metalness: 0.02,
            envMapIntensity: 0.18,
          })
        );
        const phase = (mi / Math.max(1, p.moons.length)) * Math.PI * 2 + Math.random();
        moonMesh.position.set(Math.cos(phase) * orbitR, mSize * 0.15, Math.sin(phase) * orbitR);
        moonMesh.userData = {
          name: mDef.name,
          desc: mDef.desc,
          landable: true,
          isMoon: true,
          size: mSize,
          orbitR,
          orbitSpeed: mDef.speed,
          angle: phase,
        };
        mesh.add(moonMesh);

        const mLabel = makeLabel(mDef.name);
        mLabel.scale.set(EARTH_R * 1.6, EARTH_R * 0.4, 1);
        mLabel.position.y = mSize + EARTH_R * 0.45;
        moonMesh.add(mLabel);

        moons.push(moonMesh);
      });

      const label = makeLabel(p.name);
      label.position.y = p.size + EARTH_R * 1.2;
      mesh.add(label);

      bodies.push({
        pivot, mesh, moons,
        speed: p.speed,
        spin: 0.25 + Math.random() * 0.4,
        angle: p.earth ? 0 : Math.random() * Math.PI * 2,
        data: p,
        scale: 1,
        targetScale: 1,
        atmoColor,
        inAtmo: false,
      });
      if (p.earth) pivot.rotation.y = 0;
    });

    // Start near Earth in open space (outside atmosphere entry bubble size*9)
    {
      const earth = bodies.find((b) => b.data.earth);
      if (earth) {
        earth.mesh.updateMatrixWorld(true);
        const wp = new THREE.Vector3();
        earth.mesh.getWorldPosition(wp);
        const approach = wp.clone().normalize().multiplyScalar(earth.data.size * 12);
        ship.position.copy(wp).add(approach);
        ship.lookAt(wp);
        headPitch = 0;
        headYaw = 0;
        head.rotation.set(0, 0, 0);
      }
    }

    {
      const n = 5000;
      const pos = new Float32Array(n * 3);
      const inner = AU * 2.2, outer = AU * 3.2;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = inner + Math.random() * (outer - inner);
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = (Math.random() - 0.5) * EARTH_R * 3;
        pos[i * 3 + 2] = Math.sin(a) * r;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      asteroids = new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0xc8b8a0,
        size: EARTH_R * 0.12,
        map: starMap,
        alphaMap: starMap,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        sizeAttenuation: true,
        toneMapped: true,
      }));
      scene.add(asteroids);
    }

    // ---- Flight + atmosphere encounter + landing ----
    let baseSpeed = 200; // fixed cruise; Shift uses SPEED_WARP
    const SPEED_NORMAL = 200;
    const SPEED_WARP = 1100;
    const timeScale = 0.25; // fixed orbit pace
    let nearestPlanet = null;
    let landed = null;
    let verticalVel = 0;
    let focusedBody = null; // planet currently enlarged / approach zone
    let takeoffCooldown = 0;
    let hudSpeed = 200;
    const takeoffNormal = new THREE.Vector3(0, 1, 0);
    const lastFocusedWorld = new THREE.Vector3();
    let hasLastFocusedWorld = false;

    const tmpWorld = new THREE.Vector3();
    const tmpNormal = new THREE.Vector3();
    const tmpRight = new THREE.Vector3();
    const tmpForward = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const fogColor = new THREE.Color();

    /** Cruise units/sec ≈ baseSpeed * 16/6 from flight damping equilibrium */
    function cruiseSpeed() {
      return baseSpeed * (16 / 6);
    }

    /** Scale so near-orbit feels huge (~7s full loop at cruise, then +40% wow factor) */
    function orbitScaleFor(baseRadius) {
      const pathR = (cruiseSpeed() * 7) / (Math.PI * 2);
      return Math.max(3, (pathR / (baseRadius * 1.05)) * 1.4);
    }

    function effectiveRadius(b) {
      return b.data.size * b.scale;
    }

    function getLandables() {
      const list = [];
      for (const b of bodies) {
        list.push({
          body: b,
          mesh: b.mesh,
          radius: effectiveRadius(b),
          name: b.data.name,
          desc: b.data.desc,
        });
        for (const moonMesh of b.moons) {
          list.push({
            body: b,
            mesh: moonMesh,
            radius: moonMesh.userData.size * b.scale,
            name: moonMesh.userData.name,
            desc: moonMesh.userData.desc,
            isMoon: true,
          });
        }
      }
      return list;
    }

    function applyPlanetScale(b, newScale) {
      if (Math.abs(newScale - b.scale) < 1e-5) return;
      b.scale = newScale;
      b.mesh.scale.setScalar(newScale);
      // Never teleport the camera — player approaches on their own
    }

    function setAtmoVisuals(_b, _depth01) {
      // No planet-colored camera tint / fog / FOV (Earth blue, Mars red, etc.)
      if (atmoVeil) atmoVeil.classList.remove('active');
      scene.fog = null;
    }

    function updateAtmosphere(dt) {
      const obj = ship;
      let best = null;
      let bestDist = Infinity;

      for (const b of bodies) {
        b.mesh.getWorldPosition(tmpWorld);
        const dist = obj.position.distanceTo(tmpWorld);
        const entryR = b.data.size * 9; // approach bubble in space scale
        // Exit farther than entry to avoid spawn/approach hysteresis flicker
        const exitR = Math.max(effectiveRadius(b) * 5.5, b.data.size * 11);

        if (focusedBody === b) {
          if (dist > exitR && !landed) {
            b.inAtmo = false;
            b.targetScale = 1;
            if (focusedBody === b) focusedBody = null;
          } else {
            b.inAtmo = true;
            // Grow only as YOU close in — no instant inflate / camera yank on entry
            const base = b.data.size;
            const maxOrb = orbitScaleFor(base);
            const near = base * 2.2;
            const t = 1 - THREE.MathUtils.clamp((dist - near) / Math.max(1e-3, entryR - near), 0, 1);
            let want = THREE.MathUtils.lerp(1, maxOrb, t * t);
            const maxFit = Math.max(1, (dist - EYE * 3) / base);
            want = Math.min(want, maxFit);
            b.targetScale = landed ? Math.min(maxOrb, maxFit) : want;
          }
        } else if (dist < entryR && dist < bestDist) {
          best = b;
          bestDist = dist;
        }
      }

      // Enter the nearest approach bubble
      if (!focusedBody && best && !landed) {
        focusedBody = best;
        best.inAtmo = true;
        best.targetScale = 1;
        modeEl.textContent = `Вход в атмосферу: ${best.data.name}`;
        infoName.textContent = best.data.name;
        infoDesc.textContent = best.data.desc + ' Подлетите ближе для детального облёта.';
        infoPanel.classList.add('visible');
      }

      // Animate scales; only one planet enlarged at a time
      for (const b of bodies) {
        if (b !== focusedBody && b.targetScale !== 1) b.targetScale = 1;
        const next = THREE.MathUtils.damp(b.scale, b.targetScale, 1.6, dt);
        applyPlanetScale(b, next);
      }

      if (focusedBody) {
        focusedBody.mesh.getWorldPosition(tmpWorld);
        const dist = obj.position.distanceTo(tmpWorld);
        const R = effectiveRadius(focusedBody);
        const depth = THREE.MathUtils.clamp(1 - (dist - R) / (R * 2.5), 0, 1);
        setAtmoVisuals(focusedBody, depth);
        if (!landed) {
          const orbitSec = ((2 * Math.PI * Math.max(dist, R * 1.05)) / cruiseSpeed()).toFixed(1);
          modeEl.textContent = `Атмосфера: ${focusedBody.data.name} · облёт ~${orbitSec}с · масштаб ×${focusedBody.scale.toFixed(1)}`;
        }
      } else {
        setAtmoVisuals(null, 0);
        if (modeEl.textContent.includes('Атмосфер') || modeEl.textContent.includes('Вход в атмосфер')) {
          modeEl.textContent = '';
        }
      }
    }

    function detachFromPlanet() {
      if (!landed) return;
      const target = landed;
      const body = target.body;
      target.mesh.getWorldPosition(tmpWorld);
      const obj = ship;

      // Soft hop into free flight — stay near the surface so you can return
      takeoffNormal.copy(obj.position).sub(tmpWorld).normalize();
      obj.position.copy(tmpWorld).addScaledVector(takeoffNormal, target.radius + EYE + 12);
      velocity.copy(takeoffNormal).multiplyScalar(SPEED_NORMAL * 0.4);

      landed = null;
      takeoffCooldown = 0.4; // brief — only to avoid instantly snapping back to land
      verticalVel = 0;
      document.body.classList.remove('landed');

      modeEl.textContent = isTouch
        ? 'Взлёт! Летайте над поверхностью'
        : 'Взлёт! Летайте свободно (W/мышь)';
      if (body) {
        focusedBody = body;
        body.inAtmo = true;
        // Keep current scale — proximity logic will drive it
      }
      setTimeout(() => {
        if (!landed && takeoffCooldown <= 0) modeEl.textContent = focusedBody
          ? `Атмосфера: ${focusedBody.data.name}`
          : '';
      }, 1200);
    }

    function tryLand(target) {
      if (takeoffCooldown > 0) return;
      target.mesh.getWorldPosition(tmpWorld);
      const obj = ship;
      tmpNormal.copy(obj.position).sub(tmpWorld).normalize();
      obj.position.copy(tmpWorld).addScaledVector(tmpNormal, target.radius + EYE);
      landed = target;
      focusedBody = target.body;
      verticalVel = 0;
      angVel.set(0, 0, 0);
      lookDelta.x = 0;
      lookDelta.y = 0;
      headPitch = 0;
      headYaw = 0;
      head.rotation.set(0, 0, 0);
      document.body.classList.add('landed');
      syncCockpitVisibility();
      modeEl.textContent = `На поверхности: ${target.name} · F или Пробел — взлёт`;
      infoName.textContent = target.name;
      infoDesc.textContent = target.desc + ' Вы на поверхности!';
      infoPanel.classList.add('visible');
    }

    addEventListener('keydown', (e) => {
      keys[e.code] = true;

      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        if (isPlaying()) e.preventDefault();
      }

      if (e.code === 'KeyF' || e.code === 'Space') {
        if (landed) {
          e.preventDefault();
          detachFromPlanet();
          angVel.set(0, 0, 0);
          return;
        }
      }
      if (e.code === 'Space' && controls.isLocked) e.preventDefault();

      if (e.code === 'KeyH') {
        e.preventDefault();
        toggleHud();
        return;
      }
    });
    addEventListener('keyup', (e) => {
      keys[e.code] = false;
      if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
    });

    // ---- Mobile controls (after game state exists) ----
    {
      const lookState = { id: null, x: 0, y: 0 };
      const joyKnob = document.getElementById('joy-knob');
      const joyZone = document.getElementById('joy-zone');
      const lookZone = document.getElementById('look-zone');
      const JOY_MAX = 52;
      let joyId = null;

      function joyUpdate(clientX, clientY) {
        const rect = joyZone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = clientX - cx;
        let dy = clientY - cy;
        const len = Math.hypot(dx, dy) || 1;
        const capped = Math.min(len, JOY_MAX);
        dx = (dx / len) * capped;
        dy = (dy / len) * capped;
        joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
        mobileMove.x = dx / JOY_MAX;
        mobileMove.z = dy / JOY_MAX;
      }
      function joyEnd() {
        joyId = null;
        mobileMove.x = 0;
        mobileMove.z = 0;
        joyKnob.style.transform = 'translate(0, 0)';
      }

      joyZone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        joyId = e.pointerId;
        joyZone.setPointerCapture(e.pointerId);
        joyUpdate(e.clientX, e.clientY);
      });
      joyZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== joyId) return;
        e.preventDefault();
        joyUpdate(e.clientX, e.clientY);
      });
      joyZone.addEventListener('pointerup', joyEnd);
      joyZone.addEventListener('pointercancel', joyEnd);

      lookZone.addEventListener('pointerdown', (e) => {
        if (!mobilePlaying) return;
        lookState.id = e.pointerId;
        lookState.x = e.clientX;
        lookState.y = e.clientY;
        try { lookZone.setPointerCapture(e.pointerId); } catch (_) {}
      });
      lookZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== lookState.id) return;
        const dx = e.clientX - lookState.x;
        const dy = e.clientY - lookState.y;
        lookState.x = e.clientX;
        lookState.y = e.clientY;
        lookDelta.x += dx * 2.2;
        lookDelta.y += dy * 2.2;
      });
      lookZone.addEventListener('pointerup', (e) => {
        if (e.pointerId === lookState.id) lookState.id = null;
      });
      lookZone.addEventListener('pointercancel', () => { lookState.id = null; });

      function bindHold(btn, code) {
        const on = (e) => { e.preventDefault(); e.stopPropagation(); btn.classList.add('pressed'); keys[code] = true; };
        const off = (e) => { e.preventDefault(); e.stopPropagation(); btn.classList.remove('pressed'); keys[code] = false; };
        btn.addEventListener('pointerdown', on);
        btn.addEventListener('pointerup', off);
        btn.addEventListener('pointerleave', off);
        btn.addEventListener('pointercancel', off);
      }

      bindHold(document.getElementById('btn-up'), 'Space');
      bindHold(document.getElementById('btn-down'), 'ControlLeft');
      bindHold(document.getElementById('btn-boost'), 'ShiftLeft');
      bindHold(document.getElementById('btn-slow'), 'KeyX');
      const btnBrake = document.getElementById('btn-brake');
      if (btnBrake) bindHold(btnBrake, 'KeyX');

      {
        const btnLook = document.getElementById('btn-look');
        if (btnLook) {
          const on = (e) => {
            e.preventDefault();
            e.stopPropagation();
            mobileLookHeld = true;
            btnLook.classList.add('pressed');
            if (modeEl) modeEl.textContent = 'Осмотр кабины · 👁';
          };
          const off = (e) => {
            e.preventDefault();
            e.stopPropagation();
            mobileLookHeld = false;
            btnLook.classList.remove('pressed');
            if (modeEl && modeEl.textContent.includes('Осмотр')) modeEl.textContent = '';
          };
          btnLook.addEventListener('pointerdown', on);
          btnLook.addEventListener('pointerup', off);
          btnLook.addEventListener('pointerleave', off);
          btnLook.addEventListener('pointercancel', off);
        }
      }

      document.getElementById('btn-launch').addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (landed) detachFromPlanet();
        else if (focusedBody) {
          // Soft upward nudge while already flying near a planet
          focusedBody.mesh.getWorldPosition(tmpWorld);
          takeoffNormal.copy(ship.position).sub(tmpWorld).normalize();
          verticalVel = Math.max(verticalVel, SPEED_NORMAL * 0.5);
        }
      });

      document.getElementById('btn-fs').addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        requestAppFullscreen();
        fitAppViewport();
      });

      document.addEventListener('gesturestart', (e) => e.preventDefault());
      document.body.addEventListener('touchmove', (e) => {
        if (mobilePlaying) e.preventDefault();
      }, { passive: false });
    }

    const velocity = new THREE.Vector3();
    const wishDir = new THREE.Vector3();
    const camRight = new THREE.Vector3();
    const camQuat = new THREE.Quaternion();
    const direction = new THREE.Vector3();
    const clock = new THREE.Clock();

    function updateLanded(dt) {
      const target = landed;
      const obj = ship;
      target.mesh.getWorldPosition(tmpWorld);
      tmpNormal.copy(obj.position).sub(tmpWorld);
      if (tmpNormal.lengthSq() < 1e-6) tmpNormal.set(0, 1, 0);
      tmpNormal.normalize();

      // Soft look on surface (yaw around gravity, pitch around local right)
      if (lookDelta.x || lookDelta.y) {
        obj.rotateOnWorldAxis(tmpNormal, -lookDelta.x * 0.0032);
        obj.getWorldDirection(camDir);
        tmpRight.crossVectors(camDir, tmpNormal).normalize();
        if (tmpRight.lengthSq() > 0.2) {
          obj.rotateOnWorldAxis(tmpRight, -lookDelta.y * 0.0028);
        }
        lookDelta.x = 0;
        lookDelta.y = 0;
      }

      obj.position.copy(tmpWorld).addScaledVector(tmpNormal, target.radius + EYE);

      // On surface: no cockpit room, head look reset
      headPitch = THREE.MathUtils.damp(headPitch, 0, 8, dt);
      headYaw = THREE.MathUtils.damp(headYaw, 0, 8, dt);
      head.rotation.set(headPitch, headYaw, 0, 'YXZ');
      syncCockpitVisibility();

      camera.getWorldDirection(camDir);
      tmpForward.copy(camDir).projectOnPlane(tmpNormal).normalize();
      tmpRight.crossVectors(tmpForward, tmpNormal).normalize();

      const move = new THREE.Vector3();
      const walk = (keys.ShiftLeft || keys.ShiftRight ? 80 : 35) * dt * Math.max(1, target.body.scale * 0.15);
      const mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + mobileMove.x;
      const mz = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0) + mobileMove.z;
      if (mz < 0) move.addScaledVector(tmpForward, walk * Math.abs(mz));
      if (mz > 0) move.addScaledVector(tmpForward, -walk * Math.abs(mz));
      if (mx < 0) move.addScaledVector(tmpRight, -walk * Math.abs(mx));
      if (mx > 0) move.addScaledVector(tmpRight, walk * Math.abs(mx));

      if (move.lengthSq() > 0) {
        obj.position.add(move);
        tmpNormal.copy(obj.position).sub(tmpWorld).normalize();
        obj.position.copy(tmpWorld).addScaledVector(tmpNormal, target.radius + EYE);
      }
    }

    function updateFlight(dt) {
      const obj = ship;
      updateAtmosphere(dt);

      if (takeoffCooldown > 0) takeoffCooldown -= dt;

      // Stick to focused planet frame (move with it while nearby)
      if (focusedBody && !landed) {
        focusedBody.mesh.getWorldPosition(tmpWorld);
        if (hasLastFocusedWorld) {
          obj.position.x += tmpWorld.x - lastFocusedWorld.x;
          obj.position.y += tmpWorld.y - lastFocusedWorld.y;
          obj.position.z += tmpWorld.z - lastFocusedWorld.z;
        }
        lastFocusedWorld.copy(tmpWorld);
        hasLastFocusedWorld = true;
      } else {
        hasLastFocusedWorld = false;
      }

      // Auto-land only when almost touching — no gravity pull
      if (!landed && takeoffCooldown <= 0) {
        for (const t of getLandables()) {
          t.mesh.getWorldPosition(tmpWorld);
          const dist = obj.position.distanceTo(tmpWorld);
          const surfaceDist = dist - t.radius;
          if (surfaceDist < EYE + 2 && surfaceDist > -t.radius * 0.1) {
            tryLand(t);
            break;
          }
        }
      }

      if (landed) {
        landed.radius = landed.isMoon
          ? landed.mesh.userData.size * landed.body.scale
          : effectiveRadius(landed.body);
        isThrusting = false;
        updateLanded(dt);
        return;
      }

      if (!isPlaying()) {
        lookDelta.x = 0;
        lookDelta.y = 0;
        isThrusting = false;
        return;
      }

      let speed = SPEED_NORMAL;
      if (keys.ShiftLeft || keys.ShiftRight) speed = SPEED_WARP;
      baseSpeed = SPEED_NORMAL;

      // Atmosphere: cruise slows to ~50 at entry, ~30 near the surface
      if (focusedBody && takeoffCooldown <= 0) {
        focusedBody.mesh.getWorldPosition(tmpWorld);
        const R = effectiveRadius(focusedBody);
        const base = focusedBody.data.size;
        const entryR = base * 9;
        const dist = obj.position.distanceTo(tmpWorld);
        const depth = THREE.MathUtils.clamp(1 - (dist - R) / Math.max(1e-3, entryR - base), 0, 1);
        const atmoSpeed = THREE.MathUtils.lerp(50, 30, depth * depth);
        const blend = THREE.MathUtils.clamp(0.35 + depth * 0.65, 0, 1);
        speed = THREE.MathUtils.lerp(speed, atmoSpeed, blend);
        const maxV = atmoSpeed * 2.8;
        if (velocity.lengthSq() > maxV * maxV) {
          velocity.setLength(maxV);
        }
      }

      // ——— Attitude: mouse turns the SHIP; Alt+mouse looks inside the cockpit ———
      const MOUSE_IMPULSE = 0.0035;
      const ROLL_ACC = 2.6;
      const ANG_DRAG = 2.4;
      const ANG_MAX = 2.0;
      const altLook = isAltLook();

      if (altLook) {
        headYaw -= lookDelta.x * 0.0024;
        headPitch -= lookDelta.y * 0.0022;
        headYaw = THREE.MathUtils.clamp(headYaw, -HEAD_YAW_MAX, HEAD_YAW_MAX);
        headPitch = THREE.MathUtils.clamp(headPitch, -HEAD_PITCH_MAX, HEAD_PITCH_MAX);
        lookDelta.x = 0;
        lookDelta.y = 0;
        // Soft-freeze ship turn while inspecting cabin
        angVel.multiplyScalar(Math.exp(-5 * dt));
        if (modeEl && !modeEl.textContent.includes('Солнц') && !modeEl.textContent.includes('Атмосфер')) {
          modeEl.textContent = 'Осмотр кабины · Alt';
        }
      } else {
        angVel.x += -lookDelta.y * MOUSE_IMPULSE;
        angVel.y += -lookDelta.x * MOUSE_IMPULSE;
        lookDelta.x = 0;
        lookDelta.y = 0;
        // Ease head back to nose when Alt released
        headYaw = THREE.MathUtils.damp(headYaw, 0, 5.5, dt);
        headPitch = THREE.MathUtils.damp(headPitch, 0, 5.5, dt);
        if (modeEl && modeEl.textContent.includes('Осмотр кабины')) modeEl.textContent = '';
      }
      head.rotation.set(headPitch, headYaw, 0, 'YXZ');
      syncCockpitVisibility();

      // Animate yoke + throttle with ship attitude / thrust
      if (cockpitRoot?.userData.yoke) {
        const yoke = cockpitRoot.userData.yoke;
        const targetRoll = THREE.MathUtils.clamp(angVel.z * 0.35, -0.45, 0.45);
        const targetPitch = THREE.MathUtils.clamp(-angVel.x * 0.28, -0.35, 0.35);
        yoke.rotation.z = THREE.MathUtils.damp(yoke.rotation.z, targetRoll, 8, dt);
        yoke.rotation.x = THREE.MathUtils.damp(yoke.rotation.x, -0.35 + targetPitch, 8, dt);
      }
      if (cockpitRoot?.userData.throttle) {
        const thr = cockpitRoot.userData.throttle;
        const push = isThrusting ? -0.55 : (keys.KeyX ? 0.15 : -0.4);
        thr.rotation.x = THREE.MathUtils.damp(thr.rotation.x, push, 6, dt);
      }

      const rollIn = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
      angVel.z += rollIn * ROLL_ACC * dt;

      const angDamp = Math.exp(-ANG_DRAG * dt);
      angVel.multiplyScalar(angDamp);
      angVel.x = THREE.MathUtils.clamp(angVel.x, -ANG_MAX, ANG_MAX);
      angVel.y = THREE.MathUtils.clamp(angVel.y, -ANG_MAX, ANG_MAX);
      angVel.z = THREE.MathUtils.clamp(angVel.z, -ANG_MAX, ANG_MAX);

      // Local-axis rotation (full freedom — can fly inverted, bank, tumble)
      obj.rotateX(angVel.x * dt);
      obj.rotateY(angVel.y * dt);
      obj.rotateZ(angVel.z * dt);

      // ——— Heavy ship translation: thrust along SHIP axes (not look offset) ———
      ship.getWorldQuaternion(camQuat);
      camDir.set(0, 0, -1).applyQuaternion(camQuat);
      camRight.set(1, 0, 0).applyQuaternion(camQuat);
      tmpForward.set(0, 1, 0).applyQuaternion(camQuat); // ship "up"

      const inputX = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + mobileMove.x;
      const inputZ = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) - mobileMove.z;
      const inputY = (keys.Space ? 1 : 0) - ((keys.ControlLeft || keys.ControlRight || keys.KeyC) ? 1 : 0);

      wishDir.set(0, 0, 0);
      if (inputZ) wishDir.addScaledVector(camDir, inputZ);
      if (inputX) wishDir.addScaledVector(camRight, inputX);
      if (inputY) wishDir.addScaledVector(tmpForward, inputY);
      if (wishDir.lengthSq() > 1e-8) wishDir.normalize();
      isThrusting = wishDir.lengthSq() > 0;

      // Mass: slow to accelerate, long coast without input
      const braking = !!(keys.KeyX);
      const linDrag = braking ? 4.5 : 1.05;
      const thrustAcc = speed * (braking ? 2.0 : 5.2);
      velocity.multiplyScalar(Math.exp(-linDrag * dt));
      if (wishDir.lengthSq() > 0) {
        velocity.addScaledVector(wishDir, thrustAcc * dt);
      }
      // Soft speed limit relative to throttle class
      const maxCruise = speed * 1.35;
      if (velocity.lengthSq() > maxCruise * maxCruise) {
        velocity.multiplyScalar(Math.exp(-1.8 * dt));
        if (velocity.length() > maxCruise * 1.15) velocity.setLength(maxCruise * 1.15);
      }

      hudSpeed = Math.round(velocity.length());

      obj.position.addScaledVector(velocity, dt);

      // Optional residual lift (e.g. mobile launch boost) — cooldown alone must not eject
      if (verticalVel > 0) {
        if (keys.KeyW || keys.Space || keys.ShiftLeft || keys.ShiftRight) {
          verticalVel = Math.max(verticalVel, SPEED_NORMAL * 0.6);
        }
        obj.position.addScaledVector(takeoffNormal, verticalVel * dt);
        verticalVel *= Math.exp(-2.2 * dt);
        if (verticalVel < 4) verticalVel = 0;
      }

      // Soft surface collision — allow getting right up to EYE height
      if (focusedBody && takeoffCooldown <= 0) {
        focusedBody.mesh.getWorldPosition(tmpWorld);
        const R = effectiveRadius(focusedBody);
        const d = obj.position.distanceTo(tmpWorld);
        if (d < R + EYE) {
          tmpNormal.copy(obj.position).sub(tmpWorld).normalize();
          obj.position.copy(tmpWorld).addScaledVector(tmpNormal, R + EYE);
          // Kill into-surface velocity component
          const into = velocity.dot(tmpNormal);
          if (into < 0) velocity.addScaledVector(tmpNormal, -into);
        }
      }

      const sunDist = obj.position.length();
      if (sunDist < SUN_R * 1.15) {
        obj.position.setLength(SUN_R * 1.2);
        modeEl.textContent = 'Слишком близко к Солнцу!';
      }
    }

    function updateWarpFx(dt) {
      const shiftHeld = !!(keys.ShiftLeft || keys.ShiftRight);
      const canWarp = shiftHeld && !landed && isPlaying();
      const flying = isPlaying() && !landed;

      // Effects ONLY while Shift is held — no warp from speed alone
      let target = 0;
      if (canWarp) {
        const moving = velocity.length() > 40
          || keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD
          || Math.abs(mobileMove.x) + Math.abs(mobileMove.z) > 0.1;
        target = moving ? 1 : 0.85;
      }

      warpIntensity = THREE.MathUtils.damp(
        warpIntensity,
        target,
        canWarp ? 8 : 10,
        dt
      );
      if (warpIntensity < 0.004) warpIntensity = 0;

      // Soft cruise buzz — quieter overall, especially near planets
      let buzzTarget = 0;
      if (flying) {
        const spdF = THREE.MathUtils.clamp(velocity.length() / Math.max(80, SPEED_NORMAL), 0, 1.2);
        const turnF = THREE.MathUtils.clamp(angVel.length() / 1.8, 0, 1);
        buzzTarget = 0.08 + spdF * 0.14 + turnF * 0.1 + (isThrusting ? 0.08 : 0);
        if (focusedBody) buzzTarget *= 0.35; // orbit: gentle hum, not a vibration mill
      }
      flightBuzz = THREE.MathUtils.damp(flightBuzz, buzzTarget, 5, dt);
      if (flightBuzz < 0.008) flightBuzz = 0;

      document.body.classList.toggle('flying', flying && flightBuzz > 0.04);
      document.body.classList.toggle('warping', warpIntensity > 0.12);

      warpPass.enabled = warpIntensity > 0.008;
      warpPass.uniforms.warp.value = warpIntensity;
      warpPass.uniforms.time.value = clock.elapsedTime;

      const cruiseFovKick = flying ? flightBuzz * 0.9 + (isThrusting ? 0.5 : 0) : 0;
      const targetFov = BASE_FOV + cruiseFovKick + warpIntensity * 10;
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 6, dt);
        camera.updateProjectionMatrix();
      }

      if (warpIntensity > 0) refreshWarpStreaks(warpIntensity, dt);
      else if (warpStreakMat.opacity > 0) warpStreakMat.opacity = 0;

      // Near planet: damp ALL shakes further
      const orbitMul = focusedBody ? 0.28 : 1;

      // Light cruise rattle — local units (camera is inside meter-scale cabin)
      const shakeMix = Math.max(flightBuzz * 0.45, warpIntensity) * orbitMul;
      if (shakeMix > 0.03 && flying) {
        const t = clock.elapsedTime;
        const w = warpIntensity * orbitMul;
        const b = flightBuzz * orbitMul;
        const posAmp = 0.003 + b * 0.01 + w * 0.045;
        warpShake.set(
          (Math.sin(t * 39.0) * 0.5 + Math.sin(t * 15.0) * 0.3 + (Math.random() - 0.5) * 0.25) * posAmp * (0.25 + w * 0.55),
          (Math.cos(t * 35.0) * 0.5 + Math.sin(t * 19.0) * 0.3 + (Math.random() - 0.5) * 0.25) * posAmp * (0.25 + w * 0.55),
          (Math.sin(t * 27.0) * 0.35 + (Math.random() - 0.5) * 0.2) * posAmp * 0.3
        );
        camera.position.add(warpShake);
        warpShakeActive = true;

        const pitchAmp = 0.0012 * b + 0.018 * w;
        const yawAmp = 0.001 * b + 0.02 * w;
        const rollAmp = 0.0016 * b + 0.03 * w;
        warpShakeEuler.set(
          (Math.sin(t * 45.0) * 0.65 + Math.sin(t * 14.0) * 0.3 + (Math.random() - 0.5) * 0.25) * pitchAmp,
          (Math.cos(t * 41.0) * 0.65 + Math.sin(t * 17.0) * 0.3 + (Math.random() - 0.5) * 0.25) * yawAmp,
          (Math.sin(t * 52.0) * 0.55 + Math.cos(t * 24.0) * 0.3 + (Math.random() - 0.5) * 0.3) * rollAmp,
          'YXZ'
        );
        warpShakeQuat.setFromEuler(warpShakeEuler);
        camera.quaternion.multiply(warpShakeQuat);
        warpShakeQuatActive = true;
      } else {
        // Keep resting eye offset (set at init); clear micro-tilt from prior frame
        if (!warpShakeActive) {
          camera.position.set(0, 0.12, 0.08);
        }
      }

      if (warpVeil) {
        const veil = Math.max(flightBuzz * 0.035, warpIntensity * 0.28);
        warpVeil.style.opacity = String(veil);
        warpVeil.classList.toggle('hot', warpIntensity > 0.5);
      }

      if (warpIntensity > 0.4 && !landed) {
        if (!modeEl.textContent.includes('Солнц') && !modeEl.textContent.includes('Атмосфер') && !modeEl.textContent.includes('поверхност') && !modeEl.textContent.includes('Взлёт')) {
          modeEl.textContent = 'ГИПЕРПРОСТРАНСТВО · 1100';
        }
      } else if (modeEl.textContent.includes('ГИПЕРПРОСТРАНСТВО') && !shiftHeld) {
        modeEl.textContent = '';
      }
    }

    function updateLocalLighting() {
      const sunDist = ship.position.length();
      const nearTarget = THREE.MathUtils.clamp(1 - (sunDist - SUN_R * 2) / (AU * 2.5), 0, 1);
      warpNearSun += (nearTarget - warpNearSun) * 0.08;
      const outer = THREE.MathUtils.clamp(sunDist / (AU * 35), 0, 1);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(1.0, 1.08, warpNearSun) - outer * 0.03;
      bloomPass.strength = 0.24 + warpNearSun * 0.12 + warpIntensity * 0.16;
      bloomPass.threshold = 0.97;
    }


    function updateInfo() {
      if (landed || focusedBody) return;
      const camPos = ship.position;
      let best = null, bestDist = EARTH_R * 12;
      for (const b of bodies) {
        b.mesh.getWorldPosition(tmpWorld);
        const d = camPos.distanceTo(tmpWorld) - effectiveRadius(b);
        if (d < bestDist) { bestDist = d; best = b; }
      }
      if (best && best !== nearestPlanet) {
        nearestPlanet = best;
        infoName.textContent = best.data.name;
        infoDesc.textContent = best.data.desc;
        infoPanel.classList.add('visible');
      } else if (!best && nearestPlanet) {
        nearestPlanet = null;
        infoPanel.classList.remove('visible');
      }
    }

    // ---- Cockpit dashboard screens ----
    let ckAcc = 0;
    const ckLook = new THREE.Vector3();
    const ckTo = new THREE.Vector3();
    const ckFlatA = new THREE.Vector3();
    const ckFlatB = new THREE.Vector3();
    const ckMapPos = new THREE.Vector3();

    function formatNavDist(d) {
      const au = d / AU;
      if (au >= 0.05) return `${au.toFixed(2)} AU`;
      if (d >= EARTH_R) return `${(d / EARTH_R).toFixed(1)} R⊕`;
      return `${Math.max(0, d).toFixed(0)} u`;
    }

    function bearingLabel(deg) {
      const a = Math.abs(deg);
      if (a < 8) return 'ПРЯМО';
      if (deg > 0) return `ВПРАВО ${a.toFixed(0)}°`;
      return `ВЛЕВО ${a.toFixed(0)}°`;
    }

    function getCockpitNav() {
      const obj = ship;
      ship.getWorldDirection(ckLook);
      let best = focusedBody;
      let bestDist = Infinity;
      if (best) {
        best.mesh.getWorldPosition(tmpWorld);
        bestDist = obj.position.distanceTo(tmpWorld);
      } else {
        for (const b of bodies) {
          b.mesh.getWorldPosition(tmpWorld);
          const d = obj.position.distanceTo(tmpWorld);
          if (d < bestDist) {
            bestDist = d;
            best = b;
          }
        }
        if (best) best.mesh.getWorldPosition(tmpWorld);
      }

      let bearing = 0;
      let elev = 0;
      let aligned = 0;
      if (best) {
        ckTo.copy(tmpWorld).sub(obj.position).normalize();
        ckFlatA.copy(ckLook).setY(0);
        ckFlatB.copy(ckTo).setY(0);
        if (ckFlatA.lengthSq() > 1e-6 && ckFlatB.lengthSq() > 1e-6) {
          ckFlatA.normalize();
          ckFlatB.normalize();
          bearing = Math.atan2(
            ckFlatA.x * ckFlatB.z - ckFlatA.z * ckFlatB.x,
            ckFlatA.dot(ckFlatB)
          ) * (180 / Math.PI);
        }
        elev = Math.asin(THREE.MathUtils.clamp(ckTo.y, -1, 1)) * (180 / Math.PI);
        aligned = ckLook.dot(ckTo);
      }

      const heading = ((Math.atan2(ckLook.x, -ckLook.z) * 180 / Math.PI) + 360) % 360;
      const alt = best ? Math.max(0, bestDist - effectiveRadius(best)) : 0;
      const spd = hudSpeed;

      return {
        target: best,
        name: best ? best.data.name : '—',
        desc: best ? best.data.desc : 'Открытый космос',
        moons: best?.data.moons || [],
        dist: best ? bestDist : 0,
        alt,
        bearing,
        elev,
        aligned,
        heading,
        spd,
        inAtmo: !!focusedBody,
      };
    }

    function getCockpitData() {
      const nav = getCockpitNav();
      const pos = ship.position;
      const mapPlanets = bodies.map((b) => {
        b.mesh.getWorldPosition(ckMapPos);
        return {
          body: b,
          name: b.data.name,
          x: ckMapPos.x,
          z: ckMapPos.z,
          au: b.data.au,
          dist: pos.distanceTo(ckMapPos),
          moons: b.data.moons?.length || 0,
          isTarget: nav.target === b,
        };
      }).sort((a, b) => a.dist - b.dist);

      return {
        nav,
        mapPlanets,
        nearest: mapPlanets.slice(0, 6),
        shipX: pos.x,
        shipZ: pos.z,
        sunDist: pos.length(),
        warp: warpIntensity,
        thrust: isThrusting,
      };
    }

    function ckFillGrid(ctx, w, h, hue = 195) {
      ctx.fillStyle = '#02050a';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.85)`;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      for (let x = 6; x < w; x += 14) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 6; y < h; y += 14) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.55)`;
      ctx.strokeRect(4, 4, w - 8, h - 8);
    }

    function ckDrawLines(ctx, lines, x0, y0, step, size, hue = 195) {
      ctx.font = `bold ${size}px monospace`;
      ctx.fillStyle = `hsla(${hue}, 90%, 72%, 0.98)`;
      lines.forEach((line, li) => {
        if (line) ctx.fillText(String(line).slice(0, 28), x0, y0 + li * step);
      });
    }

    function ckScanline(ctx, w, h, t, seed = 0) {
      ctx.fillStyle = 'rgba(180,220,255,0.06)';
      ctx.fillRect(0, ((t * 36 + seed * 13) % h), w, 2);
    }

    function paintCkMap(ctx, w, h, data, t, compact = false) {
      ckFillGrid(ctx, w, h);
      const cx = w * 0.5;
      const cy = h * 0.52;
      const { nav, mapPlanets, shipX, shipZ } = data;

      // Auto-scale: fit visible planets + ship
      let maxR = AU * 0.5;
      for (const p of mapPlanets) {
        maxR = Math.max(maxR, Math.hypot(p.x, p.z));
      }
      maxR = Math.max(maxR, Math.hypot(shipX, shipZ) * 1.15, AU * 0.35);
      const scale = (Math.min(w, h) * 0.38) / maxR;

      // Sun
      ctx.fillStyle = '#ffcc44';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(cx, cy, compact ? 5 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'hsla(45, 100%, 70%, 0.9)';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('СОЛНЦЕ', cx - 18, cy - 10);

      // Orbit rings (AU markers)
      ctx.strokeStyle = 'rgba(80,140,220,0.12)';
      ctx.lineWidth = 1;
      for (let au = 1; au <= 32; au *= 2) {
        const r = au * AU * scale;
        if (r > Math.min(w, h) * 0.46) break;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Planets
      for (const p of mapPlanets) {
        const px = cx + p.x * scale;
        const py = cy + p.z * scale;
        if (px < 8 || px > w - 8 || py < 8 || py > h - 8) continue;
        const r = p.isTarget ? 5 : 3.5;
        ctx.fillStyle = p.isTarget ? '#ffe08a' : 'hsla(195, 85%, 65%, 0.95)';
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        if (p.isTarget || !compact) {
          ctx.fillStyle = p.isTarget ? '#ffe8b0' : 'hsla(195, 70%, 75%, 0.85)';
          ctx.font = `${p.isTarget ? 10 : 8}px monospace`;
          ctx.fillText(p.name.slice(0, compact ? 6 : 10), px + 6, py + 3);
        }
      }

      // Ship marker
      const sx = cx + shipX * scale;
      const sy = cy + shipZ * scale;
      const ang = (-nav.heading * Math.PI) / 180;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      ctx.fillStyle = '#4dff88';
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5, 6);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = 'hsla(195, 90%, 72%, 0.95)';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(compact ? 'КАРТА' : 'КАРТА СИСТЕМЫ', 10, 16);
      if (!compact) {
        ctx.font = '9px monospace';
        ctx.fillText(`HDG ${nav.heading.toFixed(0)}° · V ${nav.spd}`, 10, h - 10);
      }
      ckScanline(ctx, w, h, t, 2);
    }

    function paintCkCompass(ctx, w, h, nav, t) {
      ckFillGrid(ctx, w, h);
      const cx = w * 0.5;
      const cy = h * 0.54;
      const r = Math.min(w, h) * 0.34;
      ctx.strokeStyle = 'hsla(195, 90%, 65%, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      for (let d = 0; d < 360; d += 30) {
        const a = (d - 90) * Math.PI / 180;
        const inner = d % 90 === 0 ? r - 14 : r - 8;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        ctx.stroke();
      }
      ctx.fillStyle = 'hsla(195, 90%, 72%, 0.9)';
      ctx.font = '9px monospace';
      ctx.fillText('N', cx - 3, cy - r + 14);
      ctx.fillText('S', cx - 3, cy + r - 6);
      ctx.fillText('W', cx - r + 4, cy + 3);
      ctx.fillText('E', cx + r - 12, cy + 3);

      const bearing = nav.target ? -nav.bearing : 0;
      const ang = (bearing - 90) * Math.PI / 180;
      ctx.strokeStyle = '#4dff88';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * (r - 18), cy + Math.sin(ang) * (r - 18));
      ctx.stroke();
      ctx.fillStyle = '#4dff88';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * (r - 22), cy + Math.sin(ang) * (r - 22), 4, 0, Math.PI * 2);
      ctx.fill();

      ckDrawLines(ctx, [
        'КОМПАС',
        nav.target ? nav.name.slice(0, 12) : 'НЕТ ЦЕЛИ',
        nav.target ? bearingLabel(nav.bearing) : '—',
        `КУРС ${nav.heading.toFixed(0)}°`,
      ], 8, 16, 15, 10);
      ckScanline(ctx, w, h, t, 5);
    }

    function paintCkPlanetInfo(ctx, w, h, nav, data) {
      ckFillGrid(ctx, w, h, 200);
      const name = (nav.name || 'КОСМОС').toUpperCase();
      ckDrawLines(ctx, ['ОБЪЕКТ', name], 10, 20, 18, 13, 200);

      ctx.font = '10px monospace';
      ctx.fillStyle = 'hsla(200, 80%, 68%, 0.88)';
      const words = nav.desc.split(' ');
      let line = '';
      let y = 52;
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > w - 20) {
          ctx.fillText(line, 10, y);
          line = word;
          y += 14;
          if (y > h - 50) break;
        } else {
          line = test;
        }
      }
      if (line && y <= h - 50) ctx.fillText(line, 10, y);

      if (nav.target) {
        y = Math.min(y + 20, h - 42);
        ctx.fillStyle = 'hsla(45, 90%, 72%, 0.95)';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(`ДИСТ ${formatNavDist(nav.dist)}`, 10, y);
        ctx.fillText(`ВЫС  ${formatNavDist(nav.alt)}`, 10, y + 14);
        if (nav.moons.length) {
          ctx.fillStyle = 'hsla(195, 85%, 72%, 0.9)';
          ctx.fillText(`СПУТН: ${nav.moons.map((m) => m.name).join(', ').slice(0, 24)}`, 10, y + 28);
        }
      }

      if (nav.inAtmo) {
        ctx.fillStyle = 'hsla(35, 100%, 65%, 0.95)';
        ctx.fillText('▲ АТМОСФЕРА', 10, h - 12);
      }
      ckScanline(ctx, w, h, 0, 1);
    }

    function paintCkTarget(ctx, w, h, nav, data) {
      ckFillGrid(ctx, w, h, 45);
      const name = (nav.name || '—').toUpperCase();
      const dirStr = nav.target ? bearingLabel(nav.bearing) : 'НЕТ ЦЕЛИ';
      const elevStr = nav.target
        ? (nav.elev > 5 ? `▲ ${nav.elev.toFixed(0)}°` : nav.elev < -5 ? `▼ ${Math.abs(nav.elev).toFixed(0)}°` : '═ УРОВЕНЬ')
        : '—';
      ckDrawLines(ctx, [
        'ЦЕЛЬ',
        name,
        nav.target ? formatNavDist(nav.dist) : '—',
        dirStr,
        elevStr,
        nav.inAtmo ? 'АТМОСФЕРА' : 'ВАКУУМ',
        nav.target && nav.aligned > 0.85 ? '● ЗАХВАТ' : '○ ПОИСК',
      ], 10, 22, 17, 12, 45);

      if (nav.target) {
        const barW = w - 24;
        const lock = THREE.MathUtils.clamp((nav.aligned + 1) * 0.5, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(12, h - 22, barW, 8);
        ctx.fillStyle = lock > 0.85 ? '#4dff88' : '#3ec7ff';
        ctx.fillRect(12, h - 22, barW * lock, 8);
      }
      ckScanline(ctx, w, h, 0, 3);
    }

    function paintCkFlight(ctx, w, h, nav, data) {
      ckFillGrid(ctx, w, h, 160);
      ckDrawLines(ctx, [
        'ПОЛЁТ',
        `СКОР ${nav.spd}`,
        `КУРС ${nav.heading.toFixed(0)}°`,
        data.thrust ? 'ТЯГА ●' : 'ДРЕЙФ ○',
        data.warp > 0.12 ? `WARP ${(data.warp * 100).toFixed(0)}%` : 'КРУИЗ',
        nav.inAtmo ? 'РЕЖ: АТМО' : 'РЕЖ: КОСМОС',
      ], 8, 20, 16, 11, 160);
      ckScanline(ctx, w, h, 0, 4);
    }

    function paintCkRadar(ctx, w, h, nav, data, t) {
      ckFillGrid(ctx, w, h, 280);
      const cx = w * 0.5;
      const cy = h * 0.55;
      const r = Math.min(w, h) * 0.38;
      ctx.strokeStyle = 'hsla(280, 70%, 60%, 0.35)';
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (r / 3) * i, 0, Math.PI * 2);
        ctx.stroke();
      }
      const sweep = (t * 1.8) % (Math.PI * 2);
      ctx.strokeStyle = 'hsla(280, 90%, 65%, 0.5)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r);
      ctx.stroke();

      for (const p of data.nearest.slice(0, 4)) {
        const rel = Math.min(p.dist / (AU * 4), 1);
        const ang = Math.atan2(p.z - data.shipZ, p.x - data.shipX);
        const pr = rel * r * 0.9;
        const px = cx + Math.cos(ang) * pr;
        const py = cy + Math.sin(ang) * pr;
        ctx.fillStyle = p.isTarget ? '#ffe08a' : 'hsla(280, 80%, 70%, 0.9)';
        ctx.beginPath();
        ctx.arc(px, py, p.isTarget ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ckDrawLines(ctx, ['РЛС', `ЦЕЛ ${data.nearest.length}`], 8, 14, 14, 9, 280);
      ckScanline(ctx, w, h, t, 6);
    }

    function paintCkSideList(ctx, w, h, data) {
      ckFillGrid(ctx, w, h, 120);
      ckDrawLines(ctx, ['БЛИЖАЙШИЕ'], 10, 18, 16, 11, 120);
      ctx.font = '9px monospace';
      ctx.fillStyle = 'hsla(120, 70%, 72%, 0.92)';
      data.nearest.forEach((p, i) => {
        const y = 38 + i * 16;
        const mark = p.isTarget ? '▶' : '·';
        const moonTag = p.moons ? ` · ${p.moons}л` : '';
        ctx.fillText(`${mark} ${p.name.slice(0, 8)}${moonTag} ${formatNavDist(p.dist)}`, 10, y);
      });
      ckScanline(ctx, w, h, 0, 7);
    }

    function paintCkOverhead(ctx, w, h, data, left) {
      ckFillGrid(ctx, w, h);
      const nav = data.nav;
      if (left) {
        ckDrawLines(ctx, [
          'SYS',
          `SUN ${formatNavDist(data.sunDist)}`,
          data.warp > 0.12 ? 'WARP ON' : 'NOMINAL',
        ], 8, 18, 16, 9);
      } else {
        ckDrawLines(ctx, [
          'ALT',
          nav.target ? nav.name.slice(0, 10) : '—',
          nav.target ? formatNavDist(nav.alt) : '—',
        ], 8, 18, 16, 9);
      }
    }

    function paintCockpitScreens(t) {
      if (!ckScreens.length || document.body.classList.contains('landed') || !cockpitRoot?.visible) return;
      const data = getCockpitData();
      const nav = data.nav;

      for (const scr of ckScreens) {
        const ctx = scr.canvas.getContext('2d');
        if (!ctx) continue;
        const w = scr.canvas.width;
        const h = scr.canvas.height;

        switch (scr.role) {
          case 'map':
          case 'sysMap':
            paintCkMap(ctx, w, h, data, t, scr.role === 'sysMap');
            break;
          case 'compass':
            paintCkCompass(ctx, w, h, nav, t);
            break;
          case 'planetInfo':
            paintCkPlanetInfo(ctx, w, h, nav, data);
            break;
          case 'target':
            paintCkTarget(ctx, w, h, nav, data);
            break;
          case 'flight':
            paintCkFlight(ctx, w, h, nav, data);
            break;
          case 'radar':
            paintCkRadar(ctx, w, h, nav, data, t);
            break;
          case 'sideL':
            paintCkSideList(ctx, w, h, data);
            break;
          case 'overheadL':
            paintCkOverhead(ctx, w, h, data, true);
            break;
          case 'overheadR':
            paintCkOverhead(ctx, w, h, data, false);
            break;
          default:
            ckFillGrid(ctx, w, h);
            ckDrawLines(ctx, [scr.role, nav.name], 8, 20, 16, 10);
        }
        scr.tex.needsUpdate = true;
      }
    }

    renderer.setAnimationLoop(() => {
      try {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      if (sunMat) sunMat.uniforms.time.value = t;
      const simDt = dt * timeScale;

      ckAcc += dt;
      if (ckAcc > 0.08) {
        ckAcc = 0;
        paintCockpitScreens(t);
      }

      sunMesh.rotation.y += simDt * 0.04;
      sunGlow.material.opacity = 0.88 + Math.sin(t * 1.1) * 0.1;

      // Freeze solar orbits while in atmosphere / on surface
      const pauseOrbits = !!landed || !!focusedBody;
      if (!pauseOrbits && simDt > 0) {
        for (const b of bodies) {
          b.angle += simDt * b.speed * 0.06;
          b.pivot.rotation.y = b.angle;
          b.mesh.rotation.y += simDt * b.spin * 0.5;
          if (b.mesh.userData.clouds) b.mesh.userData.clouds.rotation.y += simDt * 0.08;
          for (const moonMesh of b.moons) {
            const ud = moonMesh.userData;
            ud.angle += simDt * ud.orbitSpeed;
            moonMesh.position.x = Math.cos(ud.angle) * ud.orbitR;
            moonMesh.position.z = Math.sin(ud.angle) * ud.orbitR;
            moonMesh.rotation.y += simDt * 0.25;
          }
        }
        asteroids.rotation.y += simDt * 0.008;
      } else if (focusedBody) {
        // Still spin the focused planet slowly for life
        const spinDt = dt * Math.max(timeScale, 0.15);
        focusedBody.mesh.rotation.y += spinDt * 0.08;
        if (focusedBody.mesh.userData.clouds) {
          focusedBody.mesh.userData.clouds.rotation.y += spinDt * 0.05;
        }
        for (const moonMesh of focusedBody.moons) {
          moonMesh.rotation.y += spinDt * 0.2;
        }
      }

      // Clear previous visual shake so physics uses real world position
      if (warpShakeActive) {
        camera.position.sub(warpShake);
        warpShakeActive = false;
        warpShake.set(0, 0, 0);
      }
      if (warpShakeQuatActive) {
        camera.quaternion.multiply(warpShakeQuat.invert());
        warpShakeQuatActive = false;
        warpShakeQuat.identity();
      }
      updateFlight(dt);
      updateWarpFx(dt);
      updateLocalLighting();
      updateInfo();
      composer.render();
      } catch (err) {
        console.error('[solar-frame]', err);
        if (modeEl) modeEl.textContent = 'Ошибка: ' + (err && err.message ? err.message : err);
      }
    });
