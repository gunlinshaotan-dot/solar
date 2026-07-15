import * as THREE from 'three';
    import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
    import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
    import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
    import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
    import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
    import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
    import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

    const TEX = (typeof window !== 'undefined' && window.__BASE__ ? window.__BASE__ : './') + 'textures/';
    const SND = (typeof window !== 'undefined' && window.__BASE__ ? window.__BASE__ : './') + 'sounds/';

    // Browser + Three.js memory cache — assets stay hot after first load
    THREE.Cache.enabled = true;
    const HTTP_CACHE = 'solar-nemesis-v48';
    const LOCAL_ASSETS = [
      'index.html',
      'css/style.css',
      'js/game.js',
      'manifest.webmanifest',
      'icon/calamity-logo.png',
      'icon/icon-192.png',
      'icon/icon-512.png',
      'icon/apple-touch-icon.png',
      'icon/favicon-32.png',
      'icon/favicon-16.png',
      'sounds/engine-ambient.mp3',
      'sounds/warp.flac',
      'textures/sun.jpg',
      'textures/mercury.jpg',
      'textures/venus.jpg',
      'textures/earth.jpg',
      'textures/earth_clouds.jpg',
      'textures/mars.jpg',
      'textures/jupiter.jpg',
      'textures/saturn.jpg',
      'textures/saturn_ring.png',
      'textures/uranus.jpg',
      'textures/neptune.jpg',
      'textures/moon.jpg',
    ];

    async function warmHttpCache() {
      if (!('caches' in window)) return;
      try {
        const cache = await caches.open(HTTP_CACHE);
        await Promise.all(LOCAL_ASSETS.map(async (path) => {
          try {
            const hit = await cache.match(path);
            if (hit) return;
            const res = await fetch(path, { credentials: 'same-origin' });
            if (res && res.ok) await cache.put(path, res.clone());
          } catch (_) { /* ignore single miss */ }
        }));
      } catch (_) { /* private mode / unsupported */ }
    }

    // ——— Engine ambient via Web Audio (seamless loop, quiet hum) ———
    const engineAudio = {
      ctx: null,
      gain: null,
      source: null,
      buffer: null,
      unlocked: false,
      targetVol: 0,
      curVol: 0,
    };

    async function loadEngineBuffer() {
      if (engineAudio.buffer) return engineAudio.buffer;
      const res = await fetch(`${SND}engine-ambient.mp3`, { credentials: 'same-origin' });
      const raw = await res.arrayBuffer();
      if (!engineAudio.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        engineAudio.ctx = new AC();
      }
      // copy — decodeAudioData may detach the buffer
      engineAudio.buffer = await engineAudio.ctx.decodeAudioData(raw.slice(0));
      return engineAudio.buffer;
    }

    async function prefetchEngineAudio() {
      try {
        await loadEngineBuffer();
        if (engineAudio.ctx?.state === 'running') await engineAudio.ctx.suspend();
      } catch (_) { /* ignore */ }
    }

    async function unlockEngineAudio() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!engineAudio.ctx) engineAudio.ctx = new AC();
        if (engineAudio.ctx.state === 'suspended') await engineAudio.ctx.resume();
        await loadEngineBuffer();

        if (!engineAudio.gain) {
          engineAudio.gain = engineAudio.ctx.createGain();
          engineAudio.gain.gain.value = 0;
          engineAudio.gain.connect(engineAudio.ctx.destination);
        }

        if (!engineAudio.source) {
          const src = engineAudio.ctx.createBufferSource();
          src.buffer = engineAudio.buffer;
          src.loop = true;
          // Slight trim removes click / gap at loop point on many ambient files
          const d = engineAudio.buffer.duration;
          src.loopStart = Math.min(0.08, d * 0.02);
          src.loopEnd = Math.max(src.loopStart + 0.25, d - 0.08);
          src.connect(engineAudio.gain);
          src.start(0);
          engineAudio.source = src;
        }

        engineAudio.unlocked = true;
      } catch (err) {
        console.warn('[Solar] audio unlock', err);
      }
    }

    function updateEngineAudio(dt) {
      if (!engineAudio.unlocked || !engineAudio.gain) return;

      let target = 0;
      // Keep it a quiet room-tone / engine drone
      if (wake && wake.active && !wake.gate) {
        const hum = THREE.MathUtils.smoothstep(wake.humAge || 0, 0.15, 2.5);
        const phase = wake.phase || '';
        let mul = 0.055;
        if (phase === 'walk' || phase === 'rise') mul = 0.04;
        else if (phase === 'power' || phase === 'boot') mul = 0.08;
        else if (phase === 'seatLook') mul = 0.05;
        target = hum * mul;
      } else if (isPlaying() && !landed && isShipPowered()) {
        // Duck engine under warp SFX so it doesn't stack loud
        if (document.body.classList.contains('hyper-prep')
          || document.body.classList.contains('hyper-travel')) {
          target = 0.012;
        } else {
          target = 0.045;
          if (isWalkingInCabin || seatAnim) target = 0.028;
          else {
            if (isThrusting) target = 0.09;
            target += Math.min(0.04, (typeof warpIntensity === 'number' ? warpIntensity : 0) * 0.06);
          }
        }
      }

      engineAudio.targetVol = THREE.MathUtils.clamp(target, 0, 0.16);
      const rate = (wake && wake.active && !wake.gate) ? 1.1 : 2.4;
      engineAudio.curVol = THREE.MathUtils.damp(engineAudio.curVol, engineAudio.targetVol, rate, dt);
      engineAudio.gain.gain.value = engineAudio.curVol < 0.002 ? 0 : engineAudio.curVol;

      // Tiny pitch lift on warp only
      if (engineAudio.source && typeof warpIntensity === 'number') {
        try {
          engineAudio.source.playbackRate.value = 1 + warpIntensity * 0.06 + (isThrusting ? 0.02 : 0);
        } catch (_) { /* ignore */ }
      }
    }

    // Solar system scale — continents under the ship on landing
    // (cockpit stays meter-scale; worlds are enormous)
    const EARTH_R = 900;
    const SUN_R = EARTH_R * 109.2;
    const AU = SUN_R * 6.2; // wide spacing so inflated giants don't overlap
    const EYE = 14;

    const wrap = document.getElementById('canvas-wrap');
    const hint = document.getElementById('hint');
    const modeEl = document.getElementById('mode');
    const atmoVeil = document.getElementById('atmo-veil');
    const warpVeil = document.getElementById('warp-veil');
    const altHud = document.getElementById('alt-hud');
    const altValueEl = document.getElementById('alt-value');
    const altSubEl = document.getElementById('alt-sub');
    const infoPanel = document.getElementById('planet-info');
    const infoName = document.getElementById('info-name');
    const infoDesc = document.getElementById('info-desc');
    const loadFill = document.getElementById('load-fill');
    const loadStatus = document.getElementById('load-status');
    const loading = document.getElementById('loading');
    const SPLASH_MIN_MS = 7000;
    const splashT0 = performance.now();
    let splashAssetP = 0;
    let splashDone = false;

    function setLoadProgress(p01, status) {
      const pct = Math.round(THREE.MathUtils.clamp(p01, 0, 1) * 100);
      if (loadFill) loadFill.style.width = `${pct}%`;
      if (loadStatus && status) loadStatus.textContent = status;
    }

    function tickSplashBar() {
      if (splashDone) return;
      const timeP = Math.min(0.92, (performance.now() - splashT0) / SPLASH_MIN_MS);
      setLoadProgress(Math.max(timeP, splashAssetP * 0.9));
    }
    const splashInterval = setInterval(tickSplashBar, 40);
    setLoadProgress(0.02, 'Добро пожаловать…');

    async function finishSplash(status = 'Готово') {
      if (splashDone) return;
      splashAssetP = 1;
      setLoadProgress(1, status);
      const left = SPLASH_MIN_MS - (performance.now() - splashT0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      splashDone = true;
      clearInterval(splashInterval);
      setLoadProgress(1, status);
      loading?.classList.add('done');
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000010);

    const BASE_FOV = 62;
    // near must be small so the 3D cockpit room is visible inside the ship
    const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, AU * 400);
    // Overview / R key — outside the corona; actual start is near Earth after planets load
    const SUN_OVERVIEW = new THREE.Vector3(0, AU * 0.55, AU * 2.8);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // Huge solar-system scale — without this, depth precision causes flicker when turning
      logarithmicDepthBuffer: true,
    });
    {
      // Keep phone sharpness — only lightly cap extreme 3x DPR panels
      const touchy = ('ontouchstart' in window) || navigator.maxTouchPoints > 0
        || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, touchy ? 1.6 : 1.25));
    }
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
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

          float rim = smoothstep(0.35, 1.05, dist) * w;
          col += vec3(0.35, 0.65, 1.0) * rim * 0.28;
          // Darker hollow centre — tunnel vanishing point
          float voidMask = smoothstep(0.0, 0.18, dist);
          col *= mix(0.55, 1.0, voidMask);
          float pulse = 0.5 + 0.5 * sin(time * 28.0 + dist * 22.0);
          col *= 1.0 + w * pulse * 0.06;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    };

    const warpPass = new ShaderPass(WarpShader);
    warpPass.enabled = false;
    composer.addPass(warpPass);

    const fxaaPass = new ShaderPass(FXAAShader);
    fxaaPass.enabled = false; // fullscreen AA costs a full pass — skip for FPS
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

    // Ship / cockpit forward is local −Z (same as Camera). Object3D.lookAt faces +Z —
    // that turns the stern toward the target. Use camera-style orientation instead.
    const shipOrientM = new THREE.Matrix4();
    function getShipForward(out) {
      return out.set(0, 0, -1).applyQuaternion(ship.quaternion);
    }
    function orientShipToward(worldTarget) {
      // Camera convention: local −Z faces target (ship nose / canopy forward)
      shipOrientM.lookAt(ship.position, worldTarget, THREE.Object3D.DEFAULT_UP);
      ship.quaternion.setFromRotationMatrix(shipOrientM);
    }
    function getOrientShipTowardQuat(worldTarget, outQ) {
      shipOrientM.lookAt(ship.position, worldTarget, THREE.Object3D.DEFAULT_UP);
      return outQ.setFromRotationMatrix(shipOrientM);
    }

    const head = new THREE.Object3D();
    head.name = 'head';
    ship.add(head);

    const controls = new PointerLockControls(camera, document.body);
    // Keep pointer-lock only — disable built-in FPS euler look (it kills roll / clamps pitch)
    controls.enabled = false;
    controls.pointerSpeed = 0;
    head.add(camera);
    // Resting eye offset (must match CAM_EYE below)
    camera.position.set(0, 0.16, 0.02);

    const lookDelta = { x: 0, y: 0 };
    const angVel = new THREE.Vector3(); // local pitch / yaw / roll rates (rad/s)
    let headPitch = 0;
    let headYaw = 0;
    const HEAD_PITCH_MAX = 0.9;
    const HEAD_YAW_MAX = 1.35;
    const WALK_PITCH_MAX = 1.35;
    // Free 360° yaw while walking — only pitch is limited
    const wrapAngle = (a) => {
      const t = Math.PI * 2;
      a = ((a + Math.PI) % t + t) % t;
      return a - Math.PI;
    };
    const CAM_EYE = new THREE.Vector3(0, 0.16, 0.02);
    const SEAT_HEAD = new THREE.Vector3(0, 0.02, 0.05);
    const STAND_HEAD = new THREE.Vector3(0, 0.08, 0.58);
    // Inner walkable box (inside walls / windshield) + player capsule radius
    const CABIN_LIMITS = { minX: -1.9, maxX: 1.9, minZ: -1.45, maxZ: 2.35 }; // cockpit only until hab loads
    const CABIN_LIMITS_FULL = { minX: -1.9, maxX: 1.9, minZ: -1.45, maxZ: 13.2 };
    const WALK_RADIUS = 0.18;
    // Solid interior props — cockpit set always; aft pushed in when habitation streams
    const CABIN_COLLIDERS = [
      { minX: -1.7, maxX: 1.7, minZ: -1.55, maxZ: -0.55 },   // dash
      { minX: -1.95, maxX: -1.15, minZ: -1.05, maxZ: 0.1 },
      { minX: 1.15, maxX: 1.95, minZ: -1.05, maxZ: 0.1 },
      // Seat only (can walk past sides and behind)
      { minX: -0.45, maxX: 0.45, minZ: 0.55, maxZ: 1.4 },
      // Cockpit door frames (wide opening)
      { minX: -2.1, maxX: -1.15, minZ: 1.95, maxZ: 2.4 },
      { minX: 1.15, maxX: 2.1, minZ: 1.95, maxZ: 2.4 },
      // Auto-door leaf (cockpit ↔ corridor) — inactive when open
      { minX: -1.05, maxX: 1.05, minZ: 2.0, maxZ: 2.3, doorId: 'cockpit' },
    ];
    const HAB_COLLIDERS = [
      // Sleep cabin — bed + locker (walk-in aisle open at ~x −1.2…−0.85)
      { minX: -2.05, maxX: -1.22, minZ: 3.95, maxZ: 5.85 }, // bunk mattress
      { minX: -2.05, maxX: -1.35, minZ: 6.55, maxZ: 7.55 }, // foot locker / panel
      { minX: -2.05, maxX: -1.55, minZ: 3.85, maxZ: 4.05 }, // headboard
      // Right engineering racks (fore / aft — middle open for observation window)
      { minX: 1.35, maxX: 2.0, minZ: 3.7, maxZ: 4.45 },
      { minX: 1.35, maxX: 2.0, minZ: 6.65, maxZ: 7.7 },
      // Door 05 frames
      { minX: -2.1, maxX: -1.05, minZ: 8.0, maxZ: 8.4 },
      { minX: 1.05, maxX: 2.1, minZ: 8.0, maxZ: 8.4 },
      // Auto-door leaf (corridor ↔ cargo)
      { minX: -1.05, maxX: 1.05, minZ: 8.05, maxZ: 8.35, doorId: 'cargo' },
      // Cargo crates (sides of bay, center aisle clear)
      { minX: -1.7, maxX: -0.7, minZ: 9.0, maxZ: 10.3 },
      { minX: -1.5, maxX: -0.65, minZ: 10.5, maxZ: 11.6 },
      { minX: 0.7, maxX: 1.7, minZ: 9.1, maxZ: 10.4 },
      { minX: 0.65, maxX: 1.6, minZ: 10.6, maxZ: 11.7 },
      { minX: -0.55, maxX: 0.55, minZ: 11.8, maxZ: 12.6 },
      { minX: -2.0, maxX: -1.55, minZ: 8.9, maxZ: 12.4 },
      { minX: 1.55, maxX: 2.0, minZ: 8.9, maxZ: 12.4 },
    ];
    /** @type {{ id: string, z: number, openAmt: number, trigger: number, left: THREE.Mesh, right: THREE.Mesh, xClosedL: number, xOpenL: number, xClosedR: number, xOpenR: number }[]} */
    const autoDoors = [];
    const doorOpenState = Object.create(null);
    const hudGlassVisPos = new THREE.Vector3();
    const hudGlassVisNorm = new THREE.Vector3();
    const hudGlassVisCam = new THREE.Vector3();
    const hudGlassVisDir = new THREE.Vector3();
    const hudGlassVisLook = new THREE.Vector3();

    /** Forward rubka — aft of this Z is corridor / berths / cargo (hab windows) */
    const COCKPIT_ZONE_MAX_Z = 2.08;

    function isInCaptainCockpit() {
      return head.position.z < COCKPIT_ZONE_MAX_Z;
    }

    /** Flight HUD is drawn on the windshield mesh — visible only when you look at the glass */
    function canSeeHudGlass() {
      const glass = cockpitRoot?.userData.hudGlass;
      if (!glass) return false;
      glass.updateWorldMatrix(true, false);
      glass.getWorldPosition(hudGlassVisPos);
      hudGlassVisNorm.set(0, 0, 1).transformDirection(glass.matrixWorld).normalize();
      camera.getWorldPosition(hudGlassVisCam);
      hudGlassVisDir.copy(hudGlassVisPos).sub(hudGlassVisCam);
      const dist = hudGlassVisDir.length();
      if (dist < 0.25 || dist > 14) return false;
      hudGlassVisDir.multiplyScalar(1 / dist);
      camera.getWorldDirection(hudGlassVisLook);
      if (hudGlassVisDir.dot(hudGlassVisLook) < 0.32) return false;
      if (hudGlassVisNorm.dot(hudGlassVisLook) > -0.1) return false;
      return true;
    }

    function shouldShowHudGlass() {
      if (!cockpitRoot?.visible || landed) return false;
      if (!isPlaying() || !isShipPowered()) return false;
      if (document.body.classList.contains('hud-hidden')) return false;
      return canSeeHudGlass();
    }

    function updateHudGlassVisibility() {
      if (!cockpitRoot) return;
      const glass = cockpitRoot.userData.hudGlass;
      if (!glass) return;
      const want = shouldShowHudGlass();
      if (glass.visible !== want) glass.visible = want;
    }
    const walkDir = new THREE.Vector3();
    const walkFwd = new THREE.Vector3();
    const walkRight = new THREE.Vector3();
    const walkPrev = new THREE.Vector3();
    // Figure-8 head bob (Lissajous ∞) while walking the cabin
    let walkBobPhase = 0;
    let walkBobAmt = 0;
    const walkBobOff = new THREE.Vector3();

    function applyCabinCameraEye() {
      camera.position.copy(CAM_EYE).add(walkBobOff);
    }

    function updateWalkBob(dt, moving) {
      const target = moving ? 1 : 0;
      walkBobAmt = THREE.MathUtils.damp(walkBobAmt, target, moving ? 6 : 9, dt);
      if (walkBobAmt > 0.008) {
        // Soft steps — quieter figure-8, less lean
        walkBobPhase += dt * (5.4 + walkBobAmt * 0.8);
        const s = Math.sin(walkBobPhase);
        const c = Math.cos(walkBobPhase);
        const a = walkBobAmt * 0.55;
        walkBobOff.set(
          s * 0.0028 * a,
          (s * c) * 0.0042 * a,
          c * 0.001 * a
        );
        camera.rotation.z = s * 0.004 * a;
        camera.rotation.x = (s * c) * 0.002 * a;
      } else {
        walkBobOff.set(0, 0, 0);
        camera.rotation.z = THREE.MathUtils.damp(camera.rotation.z, 0, 14, dt);
        camera.rotation.x = THREE.MathUtils.damp(camera.rotation.x, 0, 14, dt);
        if (walkBobAmt < 0.002) walkBobAmt = 0;
      }
      applyCabinCameraEye();
    }

    function resetWalkBob() {
      walkBobAmt = 0;
      walkBobPhase = 0;
      walkBobOff.set(0, 0, 0);
      camera.rotation.x = 0;
      camera.rotation.z = 0;
      camera.position.copy(CAM_EYE);
    }
    /** @type {null | { mode: 'stand'|'sit', age: number, dur: number, from: THREE.Vector3, to: THREE.Vector3, fromYaw: number, toYaw: number, fromPitch: number, toPitch: number }} */
    let seatAnim = null;

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
    }

    function resolveCabinWalk(pos) {
      pos.x = THREE.MathUtils.clamp(pos.x, CABIN_LIMITS.minX + WALK_RADIUS, CABIN_LIMITS.maxX - WALK_RADIUS);
      pos.z = THREE.MathUtils.clamp(pos.z, CABIN_LIMITS.minZ + WALK_RADIUS, CABIN_LIMITS.maxZ - WALK_RADIUS);

      for (const b of CABIN_COLLIDERS) {
        if (b.doorId && (doorOpenState[b.doorId] || 0) > 0.45) continue;
        const minX = b.minX - WALK_RADIUS;
        const maxX = b.maxX + WALK_RADIUS;
        const minZ = b.minZ - WALK_RADIUS;
        const maxZ = b.maxZ + WALK_RADIUS;
        if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;

        const penL = pos.x - minX;
        const penR = maxX - pos.x;
        const penB = pos.z - minZ;
        const penF = maxZ - pos.z;
        const minPen = Math.min(penL, penR, penB, penF);
        if (minPen === penL) pos.x = minX;
        else if (minPen === penR) pos.x = maxX;
        else if (minPen === penB) pos.z = minZ;
        else pos.z = maxZ;
      }
      pos.y = 0.08;
    }

    function updateCabinDoors(dt) {
      if (!autoDoors.length) return;
      const px = head.position.x;
      const pz = head.position.z;
      const nearX = Math.abs(px) < 1.35;
      for (const d of autoDoors) {
        const nearZ = Math.abs(pz - d.z) < d.trigger;
        const want = nearX && nearZ ? 1 : 0;
        d.openAmt = THREE.MathUtils.damp(d.openAmt, want, want ? 5.5 : 4.2, dt);
        if (d.openAmt < 0.002) d.openAmt = 0;
        if (d.openAmt > 0.998) d.openAmt = 1;
        const e = d.openAmt * d.openAmt * (3 - 2 * d.openAmt);
        d.left.position.x = THREE.MathUtils.lerp(d.xClosedL, d.xOpenL, e);
        d.right.position.x = THREE.MathUtils.lerp(d.xClosedR, d.xOpenR, e);
        doorOpenState[d.id] = d.openAmt;
      }
    }
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
        side: THREE.FrontSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        depthTest: true,
        // Slight local fill so bloom from stars doesn't bleed “through” dark panels
        emissive: new THREE.Color(hex).multiplyScalar(0.08),
        emissiveIntensity: 0.35,
      });
    }

    const CK_FONT_STACK = '"Consolas", "Lucida Console", "Courier New", monospace';
    const CK_HUD_DPI = 1.15;
    const CK_PANEL_DPI = 1.1;
    const CK_HUD_PAINT_HZ = 60;

    function ckFont(px, weight = 'bold') {
      return `${weight} ${px}px ${CK_FONT_STACK}`;
    }

    function prepCkCanvasCtx(ctx, dpi = 1) {
      if (!ctx) return;
      if (dpi > 1) ctx.scale(dpi, dpi);
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'medium';
    }

    function ckScreenSize(scr) {
      return {
        w: scr.ckW || scr.canvas.width,
        h: scr.ckH || scr.canvas.height,
      };
    }

    function buildCockpit() {
      const root = new THREE.Group();
      root.name = 'cockpit3d';

      // Reuse identical geometries/materials — cuts GC hitches from hundreds of unique buffers
      const boxGeoCache = new Map();
      const cylGeoCache = new Map();
      const ledMatCache = new Map();
      const boxGeo = (w, h, d) => {
        const k = `${w}|${h}|${d}`;
        let g = boxGeoCache.get(k);
        if (!g) { g = new THREE.BoxGeometry(w, h, d); boxGeoCache.set(k, g); }
        return g;
      };
      const cylGeo = (rTop, rBot, h, segs) => {
        const k = `${rTop}|${rBot}|${h}|${segs}`;
        let g = cylGeoCache.get(k);
        if (!g) { g = new THREE.CylinderGeometry(rTop, rBot, h, segs); cylGeoCache.set(k, g); }
        return g;
      };

      const matHull = makeHullMat(0x141a22, 0.78, 0.45);
      const matDark = makeHullMat(0x0a0d12, 0.85, 0.35);
      const matFrame = makeHullMat(0x2a3545, 0.45, 0.72);
      const matMetal = makeHullMat(0x3a4658, 0.35, 0.85);
      const matAccent = makeHullMat(0x4a5568, 0.4, 0.7);
      // Soft cockpit accents (always mildly lit — instruments)
      const matGlow = new THREE.MeshStandardMaterial({
        color: 0x121820, emissive: 0x1a3a58, emissiveIntensity: 0.18, roughness: 0.45, metalness: 0.35,
        transparent: false, depthWrite: true, side: THREE.FrontSide,
      });
      // Habitation fluoro fixtures — only glow when LIGHT is on
      const matHabLamp = new THREE.MeshStandardMaterial({
        color: 0x0e141c, emissive: 0x2a6aaa, emissiveIntensity: 0.015, roughness: 0.5, metalness: 0.35,
        transparent: false, depthWrite: true, side: THREE.FrontSide,
      });
      matHabLamp.userData.offEmissive = 0.015;
      matHabLamp.userData.onEmissive = 0.72;
      root.userData.habLampMat = matHabLamp;
      const matWarn = new THREE.MeshStandardMaterial({
        color: 0x201008, emissive: 0xff6622, emissiveIntensity: 0.35, roughness: 0.4,
        transparent: false, depthWrite: true, side: THREE.FrontSide,
      });
      const matOk = new THREE.MeshStandardMaterial({
        color: 0x081410, emissive: 0x33ff88, emissiveIntensity: 0.35, roughness: 0.4,
        transparent: false, depthWrite: true, side: THREE.FrontSide,
      });
      const matSeat = makeHullMat(0x10141a, 0.9, 0.15);
      const matCushion = makeHullMat(0x1a222e, 0.95, 0.05);
      const matGrip = makeHullMat(0x1c1410, 0.92, 0.08);

      const addBox = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = root) => {
        const m = new THREE.Mesh(boxGeo(w, h, d), mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        if (parent === root) {
          m.matrixAutoUpdate = false;
          m.updateMatrix();
        }
        parent.add(m);
        return m;
      };

      const addCyl = (rTop, rBot, h, mat, x, y, z, rx = 0, ry = 0, rz = 0, segs = 12, parent = root) => {
        const m = new THREE.Mesh(cylGeo(rTop, rBot, h, segs), mat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        if (parent === root) {
          m.matrixAutoUpdate = false;
          m.updateMatrix();
        }
        parent.add(m);
        return m;
      };

      const addScreen = (role, spec) => {
        const { w, h, x, y, z, sx, sy, rx = -0.42, ry = 0, rz = 0, glass = false } = spec;
        const dpi = glass ? CK_HUD_DPI : CK_PANEL_DPI;
        if (!glass) {
          addBox(sx + 0.04, sy + 0.04, 0.05, matFrame, x, y, z - 0.035, rx, ry, rz);
          addBox(sx + 0.04, 0.016, 0.07, matDark, x, y + sy * 0.5 + 0.012, z - 0.02, rx, ry, rz);
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * dpi);
        canvas.height = Math.round(h * dpi);
        const ctx = canvas.getContext('2d', { alpha: !!glass });
        prepCkCanvasCtx(ctx, dpi);
        if (!glass && ctx) {
          ctx.fillStyle = '#020814';
          ctx.fillRect(0, 0, w, h);
          ctx.strokeStyle = 'rgba(62,199,255,0.75)';
          ctx.strokeRect(4, 4, w - 8, h - 8);
          ctx.fillStyle = 'rgba(62,199,255,0.95)';
          ctx.font = ckFont(22);
          ctx.fillText('КАРТА СИСТЕМЫ', 18, 36);
          ctx.fillStyle = 'rgba(62,199,255,0.5)';
          ctx.font = ckFont(14, '600');
          ctx.fillText('INIT…', 18, 58);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 1;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(sx, sy),
          new THREE.MeshBasicMaterial({
            map: tex,
            color: 0xffffff,
            toneMapped: false,
            transparent: !!glass,
            depthWrite: !glass,
            depthTest: true,
            opacity: 1,
            side: THREE.FrontSide,
            alphaTest: glass ? 0.02 : 0,
          })
        );
        panel.position.set(x, y, z);
        panel.rotation.set(rx, ry, rz);
        panel.renderOrder = glass ? 3 : 2;
        if (glass) {
          root.userData.hudGlass = panel;
          root.userData.hudGlassSize = { sx, sy };
          panel.matrixAutoUpdate = false;
          panel.updateMatrix();
          panel.visible = false;
        } else {
          panel.matrixAutoUpdate = false;
          panel.updateMatrix();
          root.userData.mapScreen = panel;
        }
        root.add(panel);
        ckScreens.push({ canvas, ctx, tex, role, panel, ckW: w, ckH: h, dpi });
      };

      root.userData.powerEmissiveMats = [];

      const addLed = (x, y, z, col, size = 0.03) => {
        let mat = ledMatCache.get(col);
        if (!mat) {
          mat = new THREE.MeshStandardMaterial({
            color: 0x0a0a0a, emissive: col, emissiveIntensity: 1.15, roughness: 0.2,
            transparent: false, depthWrite: true, side: THREE.FrontSide,
          });
          mat.userData.baseEmissive = 1.15;
          ledMatCache.set(col, mat);
          root.userData.powerEmissiveMats.push(mat);
        }
        const led = new THREE.Mesh(boxGeo(size, size, 0.015), mat);
        led.position.set(x, y, z);
        led.matrixAutoUpdate = false;
        led.updateMatrix();
        root.add(led);
        return led;
      };

      const addLedPanel = (x, y, z, ry = 0) => {
        addBox(0.48, 0.62, 0.1, matDark, x, y, z, 0, ry, 0);
        const colors = [0xff3333, 0x33ff55, 0x3ec7ff, 0xffaa00, 0xaa55ff, 0xffffff];
        colors.forEach((col, i) => {
          const lx = x + ((i % 3) - 1) * 0.12;
          const ly = y + 0.16 - Math.floor(i / 3) * 0.14;
          const lz = z + 0.06;
          const led = addLed(lx, ly, lz, col, 0.045);
          led.rotation.y = ry;
          led.updateMatrix();
        });
        // Physical tumblers under the LED bank
        for (let i = 0; i < 4; i++) {
          const tx = x + (i - 1.5) * 0.1;
          const ty = y - 0.18;
          const tz = z + 0.05;
          addBox(0.015, 0.015, 0.05, matMetal, tx, ty, tz, 0.3, ry, 0);
          addCyl(0.006, 0.006, 0.04, matAccent, tx, ty + 0.01, tz + 0.02, 1.2, ry, 0, 6);
        }
      };

      // Structure — thicker opaque shell (no see-through star bleed)
      addBox(4.8, 0.22, 4.4, matDark, 0, -1.22, 0.15);
      addBox(4.8, 0.22, 4.4, matHull, 0, 1.38, 0.15);
      addBox(0.45, 2.8, 4.4, matHull, -2.25, 0.08, 0.15);
      addBox(0.45, 2.8, 4.4, matHull, 2.25, 0.08, 0.15);
      // Cockpit → habitation door frame (sliding leaves fill the opening)
      addBox(1.15, 2.8, 0.28, matDark, -1.8, 0.08, 2.15);
      addBox(1.15, 2.8, 0.28, matDark, 1.8, 0.08, 2.15);
      addBox(4.8, 0.55, 0.28, matDark, 0, 1.25, 2.15); // lintel
      addBox(2.2, 0.1, 0.18, matFrame, 0, 0.95, 2.02);
      addBox(0.08, 1.9, 0.1, matFrame, -1.15, -0.15, 2.02);
      addBox(0.08, 1.9, 0.1, matFrame, 1.15, -0.15, 2.02);
      addBox(2.2, 0.04, 0.06, matHabLamp, 0, 0.88, 2.0);
      addLed(-1.05, 0.7, 1.98, 0x33ff88, 0.04);
      addLed(1.05, 0.7, 1.98, 0x33ff88, 0.04);

      const matDoorLeaf = makeHullMat(0x0c121a, 0.9, 0.42);
      const matDoorStripe = new THREE.MeshStandardMaterial({
        color: 0x201808, emissive: 0xff6622, emissiveIntensity: 0.22, roughness: 0.5, metalness: 0.25,
      });
      const registerAutoDoor = (id, z, opts = {}) => {
        const leafW = opts.leafW ?? 1.08;
        const leafH = opts.leafH ?? 2.05;
        const leafD = opts.leafD ?? 0.1;
        const y = opts.y ?? -0.08;
        const openX = opts.openX ?? 1.78;
        const mkLeaf = (side) => {
          const g = new THREE.Group();
          const xClosed = side * (leafW * 0.5 + 0.012);
          g.position.set(xClosed, y, z);
          const panel = new THREE.Mesh(boxGeo(leafW, leafH, leafD), matDoorLeaf);
          g.add(panel);
          const stripe = new THREE.Mesh(boxGeo(leafW * 0.82, 0.04, 0.02), matDoorStripe);
          stripe.position.set(0, 0.52, leafD * 0.55);
          g.add(stripe);
          const slit = new THREE.Mesh(boxGeo(0.22, 0.42, 0.018), matGlow);
          slit.position.set(-side * 0.22, 0.12, leafD * 0.55);
          g.add(slit);
          root.add(g);
          return { group: g, xClosed, xOpen: side * openX };
        };
        const L = mkLeaf(-1);
        const R = mkLeaf(1);
        autoDoors.push({
          id,
          z,
          openAmt: 0,
          trigger: opts.trigger ?? 1.9,
          left: L.group,
          right: R.group,
          xClosedL: L.xClosed,
          xOpenL: L.xOpen,
          xClosedR: R.xClosed,
          xOpenR: R.xOpen,
        });
        doorOpenState[id] = 0;
      };
      registerAutoDoor('cockpit', 2.12, { trigger: 2.05 });
      root.userData.registerAutoDoor = registerAutoDoor;

      for (let i = -3; i <= 3; i++) addBox(4.2, 0.015, 0.03, matMetal, 0, -1.095, i * 0.45);
      // Center walk stripe — slightly ABOVE floor top (floor y=-1.22 h=0.22 → top≈-1.11)
      addBox(0.85, 0.02, 2.4, matAccent, 0, -1.09, 0.35);
      for (let i = 0; i < 6; i++) addBox(0.78, 0.012, 0.035, matMetal, 0, -1.088, -0.5 + i * 0.28);

      for (let i = 0; i < 6; i++) {
        const z = -1.4 + i * 0.55;
        addBox(0.04, 2.2, 0.06, matFrame, -2.02, 0.05, z);
        addBox(0.04, 2.2, 0.06, matFrame, 2.02, 0.05, z);
      }
      for (let i = 0; i < 5; i++) addBox(4.0, 0.05, 0.06, matFrame, 0, 1.28, -1.2 + i * 0.6);
      for (let i = 0; i < 10; i++) {
        addCyl(0.02, 0.02, 0.03, matMetal, -2.05, -0.7 + i * 0.22, -1.5, Math.PI / 2, 0, 0, 6);
        addCyl(0.02, 0.02, 0.03, matMetal, 2.05, -0.7 + i * 0.22, -1.5, Math.PI / 2, 0, 0, 6);
      }

      // Overhead conduit + glow — hug walls only (no floaty tubes across the cabin)
      addCyl(0.04, 0.04, 1.1, matMetal, -1.9, 0.95, -0.4, 0, 0, Math.PI / 2, 10);
      addCyl(0.04, 0.04, 1.1, matMetal, 1.9, 0.95, -0.4, 0, 0, Math.PI / 2, 10);
      addCyl(0.025, 0.025, 1.0, matGlow, -1.88, 0.9, -0.4, 0, 0, Math.PI / 2, 8);
      addCyl(0.025, 0.025, 1.0, matGlow, 1.88, 0.9, -0.4, 0, 0, Math.PI / 2, 8);
      for (let i = -1; i <= 1; i++) {
        addBox(0.08, 0.1, 0.08, matFrame, -2.0, 0.95, i * 0.55);
        addBox(0.08, 0.1, 0.08, matFrame, 2.0, 0.95, i * 0.55);
      }

      // Side wall pipes only — NOT across the aisle (those blocked the walk path)
      addCyl(0.03, 0.03, 0.9, matMetal, -1.85, 0.25, -0.5, 0, 0, Math.PI / 2, 8);
      addCyl(0.03, 0.03, 0.9, matMetal, 1.85, 0.25, -0.5, 0, 0, Math.PI / 2, 8);
      addCyl(0.025, 0.025, 0.45, matMetal, -1.85, 0.02, -0.9, 0, 0, 0, 8);
      addCyl(0.025, 0.025, 0.45, matMetal, 1.85, 0.02, -0.9, 0, 0, 0, 8);

      // Windshield — thin A-pillars + slim sill (wide view, no thick lattice)
      addBox(0.16, 2.5, 0.18, matFrame, -1.95, 0.15, -1.92);
      addBox(0.16, 2.5, 0.18, matFrame, 1.95, 0.15, -1.92);
      addBox(4.0, 0.12, 0.16, matFrame, 0, 1.32, -1.92);
      addBox(4.0, 0.14, 0.22, matFrame, 0, -0.95, -1.78);
      addBox(3.6, 0.05, 0.18, matAccent, 0, -0.82, -1.62, -0.28, 0, 0);
      // Edge accent only — thin lines, no mid-window cross
      addBox(3.9, 0.012, 0.04, matGlow, 0, 1.24, -1.98);
      addBox(3.7, 0.012, 0.04, matGlow, 0, -0.88, -1.9);
      addBox(0.022, 2.1, 0.04, matGlow, -1.95, 0.15, -1.98);
      addBox(0.022, 2.1, 0.04, matGlow, 1.95, 0.15, -1.98);

      // Dash console — lower slab; leave a recess so the map screen sits on top
      addBox(3.7, 0.42, 1.0, matHull, 0, -0.98, -1.12, -0.28, 0, 0);
      addBox(3.2, 0.08, 0.7, matDark, 0, -0.72, -1.35, -0.28, 0, 0);
      addBox(0.32, 0.5, 0.85, matFrame, -1.75, -0.88, -1.05, -0.15, 0.15, 0);
      addBox(0.32, 0.5, 0.85, matFrame, 1.75, -0.88, -1.05, -0.15, -0.15, 0);
      addBox(2.8, 0.1, 0.32, matDark, 0, -1.12, -0.82);
      for (let i = -4; i <= 4; i++) {
        addCyl(0.015, 0.015, 0.35, i % 2 ? matGlow : matMetal, i * 0.22, -1.08, -0.82, Math.PI / 2, 0, 0, 6);
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

      addBox(2.4, 0.18, 0.75, matFrame, 0, 1.18, -0.3, 0.5, 0, 0);
      addBox(2.5, 0.08, 0.2, matAccent, 0, 1.05, 0.15);
      for (let i = -3; i <= 3; i++) addBox(0.16, 0.05, 0.2, i === 0 ? matWarn : matGlow, i * 0.28, 1.1, -0.15);
      for (let i = -4; i <= 4; i++) addBox(0.04, 0.06, 0.03, matMetal, i * 0.12, 1.0, 0.05, 0.2, 0, 0);

      // Pilot seat — solid assembly, no floating roll-cage / stray bars
      addBox(0.92, 0.14, 0.82, matSeat, 0, -0.94, 0.9);
      addBox(0.86, 0.1, 0.76, matCushion, 0, -0.84, 0.9);
      // Continuous backrest + headrest (one stack, no gaps)
      addBox(0.86, 1.05, 0.14, matSeat, 0, -0.32, 1.3);
      addBox(0.78, 0.95, 0.08, matCushion, 0, -0.28, 1.24);
      addBox(0.5, 0.22, 0.1, matCushion, 0, 0.32, 1.28);
      // Armrests welded to seat sides
      addBox(0.12, 0.08, 0.55, matSeat, -0.52, -0.58, 0.9);
      addBox(0.12, 0.08, 0.55, matSeat, 0.52, -0.58, 0.9);
      addBox(0.1, 0.35, 0.1, matFrame, -0.52, -0.78, 1.05);
      addBox(0.1, 0.35, 0.1, matFrame, 0.52, -0.78, 1.05);
      // Pedestal rooted to deck
      addCyl(0.16, 0.22, 0.32, matFrame, 0, -1.05, 0.9, 0, 0, 0, 10);
      addBox(0.55, 0.06, 0.55, matMetal, 0, -1.16, 0.9);

      // Butterfly yoke — lower + slightly closer to pilot
      const yoke = new THREE.Group();
      yoke.name = 'yoke';
      yoke.position.set(0, -0.62, -0.55);
      yoke.rotation.x = -0.28;
      root.add(yoke);
      root.userData.yoke = yoke;

      const column = new THREE.Mesh(cylGeo(0.045, 0.07, 0.55, 12), matMetal);
      column.position.set(0, -0.15, 0.12);
      column.rotation.x = 0.55;
      yoke.add(column);
      const colJoint = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 10), matAccent);
      colJoint.position.set(0, 0.05, -0.05);
      yoke.add(colJoint);

      const hub = new THREE.Mesh(cylGeo(0.07, 0.07, 0.06, 12), matMetal);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(0, 0.12, -0.08);
      yoke.add(hub);

      const spokeL = new THREE.Mesh(boxGeo(0.2, 0.04, 0.025), matMetal);
      spokeL.position.set(-0.1, 0.12, -0.08);
      spokeL.rotation.z = 0.15;
      yoke.add(spokeL);
      const spokeR = spokeL.clone();
      spokeR.position.x = 0.1;
      spokeR.rotation.z = -0.15;
      yoke.add(spokeR);
      const spokeDown = new THREE.Mesh(boxGeo(0.04, 0.14, 0.025), matMetal);
      spokeDown.position.set(0, 0.04, -0.08);
      yoke.add(spokeDown);

      const leftGrip = new THREE.Mesh(cylGeo(0.03, 0.035, 0.22, 10), matGrip);
      leftGrip.position.set(-0.22, 0.12, -0.08);
      leftGrip.rotation.z = 0.1;
      yoke.add(leftGrip);
      const rightGrip = leftGrip.clone();
      rightGrip.position.x = 0.22;
      rightGrip.rotation.z = -0.1;
      yoke.add(rightGrip);

      addBox(0.03, 0.24, 0.035, matMetal, -0.22, 0.12, -0.08, 0, 0, 0, yoke);
      addBox(0.03, 0.24, 0.035, matMetal, 0.22, 0.12, -0.08, 0, 0, 0, yoke);

      const btnL = new THREE.Mesh(boxGeo(0.025, 0.025, 0.02), matOk);
      btnL.position.set(-0.18, 0.18, -0.06);
      yoke.add(btnL);
      const btnR = btnL.clone();
      btnR.material = matWarn;
      btnR.position.x = 0.18;
      yoke.add(btnR);

      const plate = new THREE.Mesh(boxGeo(0.09, 0.07, 0.02), matGlow);
      plate.position.set(0, 0.12, -0.05);
      yoke.add(plate);

      // Dual throttle sector
      addBox(0.35, 0.12, 0.55, matDark, 0.72, -0.78, -0.78, -0.25, 0, 0);
      const throttle = new THREE.Group();
      throttle.position.set(0.72, -0.68, -0.68);
      root.add(throttle);
      root.userData.throttle = throttle;
      for (let i = 0; i < 2; i++) {
        const lever = new THREE.Mesh(boxGeo(0.02, 0.28, 0.03), matMetal);
        lever.position.set((i - 0.5) * 0.08, 0.08, 0);
        lever.rotation.x = -0.4;
        throttle.add(lever);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), i === 0 ? matOk : matWarn);
        knob.position.set((i - 0.5) * 0.08, 0.22, -0.08);
        throttle.add(knob);
      }
      for (let i = 0; i < 5; i++) addBox(0.24, 0.015, 0.015, matMetal, 0.72, -0.74, -0.58 - i * 0.08, -0.25, 0, 0);

      // Side stick
      addBox(0.22, 0.1, 0.22, matDark, -0.7, -0.82, -0.62);
      addCyl(0.025, 0.03, 0.22, matMetal, -0.7, -0.69, -0.62, 0.3, 0, 0, 10);
      addCyl(0.04, 0.035, 0.12, matGrip, -0.7, -0.56, -0.7, 0.3, 0, 0, 10);

      // Animated pedals
      const pedalRoot = new THREE.Group();
      pedalRoot.name = 'pedals';
      root.add(pedalRoot);
      root.userData.pedals = pedalRoot;
      for (const side of [-1, 1]) {
        const pedal = new THREE.Group();
        pedal.position.set(side * 0.28, -1.08, -0.35);
        pedal.userData.baseZ = -0.35;
        addBox(0.04, 0.12, 0.35, matFrame, 0, -0.06, -0.05, 0.15, 0, 0, pedal);
        addBox(0.18, 0.03, 0.28, matMetal, 0, 0.04, 0.11, 0.4, 0, 0, pedal);
        addBox(0.16, 0.01, 0.06, matGrip, 0, 0.06, 0.13, 0.4, 0, 0, pedal);
        addCyl(0.025, 0.025, 0.25, matFrame, 0, -0.07, -0.1, Math.PI / 2, 0, 0, 6, pedal);
        pedalRoot.add(pedal);
      }
      root.userData.pedalL = pedalRoot.children[0];
      root.userData.pedalR = pedalRoot.children[1];

      // Deck edge accents (matMetal, not emissive — glow caused floor flicker)
      addBox(2.4, 0.015, 0.03, matMetal, 0, -1.09, -0.35);
      addBox(2.4, 0.015, 0.03, matMetal, 0, -1.09, 1.5);
      for (let i = -2; i <= 2; i++) {
        // Ceiling vents — keep clear of door lintel / overhead conduit
        if (Math.abs(i) === 0) continue;
        addBox(0.32, 0.04, 0.4, matDark, i * 0.75, 1.3, 0.35);
        for (let j = 0; j < 3; j++) addBox(0.28, 0.01, 0.035, matMetal, i * 0.75, 1.28, 0.22 + j * 0.09);
      }
      addLed(-1.95, 1.1, -1.7, 0x88ccff, 0.07);
      addLed(1.95, 1.1, -1.7, 0x88ccff, 0.07);
      addLed(-1.9, -0.85, 1.55, 0xff5500, 0.06);
      addLed(1.9, -0.85, 1.55, 0xff5500, 0.06);

      // Extinguisher — aside, not in the aisle / door path
      addCyl(0.07, 0.07, 0.4, matWarn, -1.88, -0.75, 1.45, 0, 0, 0, 10);
      addCyl(0.028, 0.028, 0.1, matMetal, -1.88, -0.5, 1.45, 0, 0, 0, 8);

      // Side racks — kept clear of the wide doorway
      addBox(0.7, 0.75, 0.16, matHull, -1.7, -0.15, 1.55);
      addBox(0.7, 0.75, 0.16, matHull, 1.7, -0.15, 1.55);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          addBox(0.5, 0.06, 0.04, matMetal, side * 1.7, -0.35 + i * 0.2, 1.46);
          addLed(side * 1.7, -0.35 + i * 0.2, 1.43, [0x33ff55, 0x3ec7ff, 0xffaa00][i], 0.035);
        }
      }

      // One lit map + planet briefing screen (low-res canvases — dash is small)
      const tilt = -0.32;
      addScreen('map', {
        w: 384, h: 288, x: 0.42, y: -0.42, z: -1.32, sx: 0.5, sy: 0.38, rx: tilt,
      });
      addScreen('briefing', {
        w: 320, h: 360, x: -0.55, y: -0.4, z: -1.3, sx: 0.42, sy: 0.48, rx: tilt,
      });
      // Accent light so panels read as active displays
      const mapLight = new THREE.PointLight(0x4ec8ff, 0.02, 2.2, 2);
      mapLight.position.set(0, -0.25, -1.15);
      root.add(mapLight);

      addScreen('hudGlass', {
        w: 640, h: 360,
        x: 0, y: 0.32, z: -1.96,
        sx: 3.4, sy: 1.75,
        rx: 0, ry: 0, rz: 0,
        glass: true,
      });

      // Interactive cockpit buttons (look+F or mouse in explore mode)
      const ckButtons = [];
      root.userData.ckButtons = ckButtons;
      const addCockpitBtn = (id, short, title, desc, x, y, z, color, action) => {
        const mat = new THREE.MeshStandardMaterial({
          color: 0x101820,
          emissive: color,
          emissiveIntensity: 0.55,
          roughness: 0.35,
          metalness: 0.4,
        });
        const mesh = new THREE.Mesh(boxGeo(0.1, 0.055, 0.045), mat);
        mesh.position.set(x, y, z);
        mesh.userData.ckBtn = { id, label: short, title, desc, action, mat, baseEmissive: 0.55 };
        root.add(mesh);
        ckButtons.push(mesh);

        // Readable label plate (canvas)
        const lc = document.createElement('canvas');
        lc.width = 256;
        lc.height = 96;
        const lctx = lc.getContext('2d');
        if (lctx) {
          lctx.fillStyle = '#050a12';
          lctx.fillRect(0, 0, 256, 96);
          lctx.strokeStyle = '#3ec7ff';
          lctx.lineWidth = 3;
          lctx.strokeRect(3, 3, 250, 90);
          lctx.fillStyle = '#7ad8ff';
          lctx.font = 'bold 22px monospace';
          lctx.fillText(short, 12, 28);
          lctx.fillStyle = '#d0e8ff';
          lctx.font = 'bold 16px monospace';
          lctx.fillText(title, 12, 52);
          lctx.fillStyle = 'rgba(160,200,230,0.85)';
          lctx.font = '13px monospace';
          lctx.fillText(desc, 12, 76);
        }
        const ltex = new THREE.CanvasTexture(lc);
        ltex.colorSpace = THREE.SRGBColorSpace;
        ltex.generateMipmaps = false;
        const plate = new THREE.Mesh(
          new THREE.PlaneGeometry(0.22, 0.082),
          new THREE.MeshBasicMaterial({ map: ltex, toneMapped: false })
        );
        plate.position.set(x, y + 0.09, z + 0.02);
        plate.matrixAutoUpdate = false;
        plate.updateMatrix();
        root.add(plate);
        return mesh;
      };

      root.userData.cabinLightsOn = false;
      root.userData.shipPowerOn = false;
      // Soft cockpit emissives that die with power
      for (const m of [matGlow, matWarn, matOk]) {
        m.userData.baseEmissive = m.emissiveIntensity;
        root.userData.powerEmissiveMats.push(m);
      }

      addCockpitBtn(
        'hud', 'HUD', 'Стекло HUD', 'показ / скрыть',
        -0.42, -0.72, -0.95, 0x3ec7ff,
        () => {
          toggleHud();
          if (modeEl) modeEl.textContent = 'HUD: стекло кабины вкл/выкл';
        }
      );
      addCockpitBtn(
        'nav', 'NAV', 'Навигация', 'карта · варп',
        -0.2, -0.72, -0.95, 0x44ff88,
        () => {
          openNavTablet();
        }
      );
      addCockpitBtn(
        'lamp', 'LIGHT', 'Свет корабля', 'коридор / трюм',
        0.02, -0.72, -0.95, 0xffaa44,
        () => {
          root.userData.cabinLightsOn = !root.userData.cabinLightsOn;
          if (modeEl) {
            modeEl.textContent = root.userData.cabinLightsOn
              ? 'СВЕТ КОРАБЛЯ: ВКЛ (коридоры и трюм)'
              : 'СВЕТ КОРАБЛЯ: ВЫКЛ';
          }
        }
      );
      addCockpitBtn(
        'hyper', 'HYPER', 'Гиперпривод', 'прыжок к цели',
        0.24, -0.72, -0.95, 0x66e0ff,
        () => {
          if (!isShipPowered()) {
            if (modeEl) modeEl.textContent = 'Нет питания · PWR';
            return;
          }
          if (isWalkingInCabin || seatAnim || landed) {
            if (modeEl) modeEl.textContent = 'Гиперпривод только из кресла в полёте';
            return;
          }
          if (hyper.phase === 'aim') {
            cancelHyper();
            return;
          }
          if (hyper.phase === 'prep' || hyper.phase === 'travel') {
            if (modeEl) modeEl.textContent = 'S — выйти из варпа';
            return;
          }
          enterHyperAim();
        }
      );
      addCockpitBtn(
        'pwr', 'PWR', 'Двигатель', 'питание корабля',
        0.46, -0.72, -0.95, 0xff3344,
        () => {
          root.userData.shipPowerOn = !root.userData.shipPowerOn;
          const on = !!root.userData.shipPowerOn;
          document.body.classList.toggle('ship-power-off', !on);
          if (!on) {
            root.userData.cabinLightsOn = false;
            if (hyper.phase) cancelHyper(true);
          }
          syncCockpitVisibility();
          if (modeEl) {
            modeEl.textContent = on
              ? 'ПИТАНИЕ / ДВИГАТЕЛЬ: ВКЛ'
              : 'ПИТАНИЕ ВЫКЛ · темнота · движки молчат · PWR — включить';
          }
        }
      );

      // Closed bulkhead until player stands (F) — aft ship streams in then
      const aftSealMesh = addBox(4.4, 2.8, 0.22, matDark, 0, 0.08, 2.55);
      root.userData.aftSeal = aftSealMesh;
      root.userData.walkLights = [];
      root.userData.habitationBuilt = false;

      // Cockpit-only lights (habitation PointLights spawn with aft)
      const cabinKey = new THREE.PointLight(0x6aa8ff, 0.05, 8, 1.5);
      cabinKey.position.set(0, 0.7, 0.15);
      cabinKey.userData.baseIntensity = 1.85;
      root.add(cabinKey);
      root.userData.keyLight = cabinKey;

      const dashFill = new THREE.PointLight(0x3ec7ff, 0.02, 5, 2.2);
      dashFill.position.set(0, -0.15, -1.0);
      dashFill.userData.baseIntensity = 1.1;
      root.add(dashFill);
      root.userData.dashFill = dashFill;

      const rimFill = new THREE.PointLight(0x88aacc, 0.02, 6, 2.0);
      rimFill.position.set(0, 0.35, 0.5);
      rimFill.userData.baseIntensity = 0.55;
      root.add(rimFill);
      root.userData.rimFill = rimFill;
      mapLight.userData.baseIntensity = 0.55;
      root.userData.mapLight = mapLight;

      const cabinAmbient = new THREE.AmbientLight(0x6a90b8, 0.0);
      cabinAmbient.userData.baseIntensity = 0.45;
      root.add(cabinAmbient);
      root.userData.cabinAmbient = cabinAmbient;

      root.userData._buildHabitation = function buildHabitationLazy() {
      // ——— Habitation: corridor / berths / cargo (streamed on first stand) ———
      const matFloorGrate = makeHullMat(0x1a222c, 0.92, 0.55);
      const matBunk = makeHullMat(0x2a3340, 0.88, 0.2);
      const matBunkPad = makeHullMat(0x3a4555, 0.95, 0.05);
      const matSleepShell = makeHullMat(0x161c26, 0.9, 0.28);
      const matMattress = makeHullMat(0x2c3544, 0.97, 0.04);
      const matSheet = makeHullMat(0x3a4860, 0.98, 0.02);
      const matBlanket = makeHullMat(0x243040, 0.96, 0.05);
      const matPillow = makeHullMat(0x4a5568, 0.98, 0.03);
      const matCurtain = makeHullMat(0x1a2432, 0.92, 0.08);
      const matPipe = makeHullMat(0x4a5566, 0.4, 0.75);
      const matCargo = makeHullMat(0x3a2e22, 0.85, 0.25);
      const matHazard = new THREE.MeshStandardMaterial({
        color: 0x201808, emissive: 0xff6622, emissiveIntensity: 0.35, roughness: 0.55, metalness: 0.2,
      });
      const matSleepLamp = new THREE.MeshStandardMaterial({
        color: 0x1a1208, emissive: 0xffaa55, emissiveIntensity: 0.02, roughness: 0.5, metalness: 0.2,
      });
      matSleepLamp.userData.offEmissive = 0.02;
      matSleepLamp.userData.onEmissive = 0.55;
      root.userData.sleepLampMat = matSleepLamp;

      const addDecoMonitor = (x, y, z, sx, sy, ry, title, lines, accent = '#3ec7ff') => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#02060e';
          ctx.fillRect(0, 0, 320, 200);
          ctx.strokeStyle = accent;
          ctx.lineWidth = 3;
          ctx.strokeRect(6, 6, 308, 188);
          ctx.fillStyle = accent;
          ctx.font = 'bold 22px monospace';
          ctx.fillText(title, 18, 36);
          ctx.fillStyle = 'rgba(180,220,255,0.75)';
          ctx.font = '16px monospace';
          (lines || []).forEach((ln, i) => ctx.fillText(ln, 18, 68 + i * 28));
          // fake waveform
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          for (let i = 0; i < 40; i++) {
            const px = 18 + i * 7;
            const py = 160 + Math.sin(i * 0.55) * 12 + (i % 5) * 1.5;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        const panelMat = new THREE.MeshBasicMaterial({
          map: tex, toneMapped: false, transparent: true, opacity: 0.22,
        });
        panelMat.userData.offOpacity = 0.18;
        panelMat.userData.onOpacity = 1;
        if (!root.userData.habPanelMats) root.userData.habPanelMats = [];
        root.userData.habPanelMats.push(panelMat);
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), panelMat);
        panel.position.set(x, y, z);
        panel.rotation.y = ry || 0;
        panel.matrixAutoUpdate = false;
        panel.updateMatrix();
        root.add(panel);
        // Frame sits on the wall side of the screen (ship-local offset by facing)
        const fx = x - Math.sin(ry || 0) * 0.025;
        const fz = z - Math.cos(ry || 0) * 0.025;
        addBox(sx + 0.05, sy + 0.05, 0.035, matFrame, fx, y, fz, 0, ry || 0, 0);
        return panel;
      };

      // Hab shell — longer hull (vestibule + berth + cargo)
      addBox(4.4, 0.2, 11.2, matFloorGrate, 0, -1.22, 7.8);
      addBox(4.4, 0.18, 11.2, matHull, 0, 1.38, 7.8);
      addBox(0.4, 2.8, 11.2, matHull, -2.2, 0.08, 7.8);
      // Right wall with cutout for the huge observation window
      {
        const wx = 2.2;
        const ww = 0.4;
        const winZ = 5.45;
        const winY = 0.2;
        const holeZ = 2.4;
        const holeY = 1.75;
        const zMin = 2.2;
        const zMax = 13.4;
        const yMin = -1.32;
        const yMax = 1.48;
        const zL = winZ - holeZ * 0.5;
        const zR = winZ + holeZ * 0.5;
        const yB = winY - holeY * 0.5;
        const yT = winY + holeY * 0.5;
        // Fore / aft full-height slabs
        addBox(ww, 2.8, zL - zMin, matHull, wx, 0.08, (zMin + zL) * 0.5);
        addBox(ww, 2.8, zMax - zR, matHull, wx, 0.08, (zR + zMax) * 0.5);
        // Below / above the window opening
        addBox(ww, yB - yMin, holeZ, matHull, wx, (yMin + yB) * 0.5, winZ);
        addBox(ww, yMax - yT, holeZ, matHull, wx, (yT + yMax) * 0.5, winZ);
      }
      for (let i = 0; i < 22; i++) {
        addBox(3.6, 0.012, 0.03, matMetal, 0, -1.095, 2.5 + i * 0.48);
      }
      for (let i = -2; i <= 2; i++) {
        addBox(0.03, 0.012, 10.8, matMetal, i * 0.75, -1.095, 7.6);
      }
      for (let i = 0; i < 12; i++) {
        addBox(3.8, 0.06, 0.1, matFrame, 0, 1.25, 2.9 + i * 0.85);
      }
      // Ceiling runs hug the side walls (not across aisle at head height)
      addCyl(0.04, 0.04, 10.5, matPipe, -1.85, 1.1, 7.6, 0, 0, Math.PI / 2, 8);
      addCyl(0.03, 0.03, 10.5, matPipe, 1.85, 1.05, 7.6, 0, 0, Math.PI / 2, 8);
      addCyl(0.025, 0.025, 10.2, matHabLamp, -1.8, 1.02, 7.6, 0, 0, Math.PI / 2, 8);

      const walkLights = [];
      const addWalkLight = (color, intensity, x, y, z, dist = 6, decay = 1.6) => {
        // Cap cabin point lights — too many cause hitch on first look-around
        if (walkLights.length >= 6) return null;
        const pl = new THREE.PointLight(color, intensity * 0.04, dist, decay);
        pl.position.set(x, y, z);
        pl.userData.baseIntensity = intensity;
        root.add(pl);
        walkLights.push(pl);
        return pl;
      };
      const addFluoro = (x, y, z, w, h, d, intensity = 1.2) => {
        addBox(w, h, d, matHabLamp, x, y, z);
        // Only a few fluoros cast real light (rest are props)
        if (walkLights.length < 4) {
          addWalkLight(0xd0ecff, intensity * 0.85, x, y - 0.12, z, 6.5, 1.55);
        }
      };
      // Ceiling fluoros (meshes always; few PointLights)
      addFluoro(0, 1.12, 2.9, 2.2, 0.05, 0.12, 3.2);
      addFluoro(1.5, 1.12, 4.2, 0.12, 0.06, 1.3, 2.6);
      addFluoro(1.5, 1.12, 5.8, 0.12, 0.06, 1.3, 2.4);
      addFluoro(1.5, 1.12, 7.2, 0.12, 0.06, 1.2, 2.2);
      addFluoro(0, 1.12, 9.6, 1.8, 0.05, 0.12, 2.8);
      addFluoro(0, 1.12, 11.5, 1.8, 0.05, 0.12, 2.5);
      addWalkLight(0xa8d0ff, 2.4, 0, 0.55, 5.5, 11, 1.35);
      addWalkLight(0xb0d4ea, 2.2, 0, 0.5, 10.0, 10, 1.4);

      // Vestibule markers — wall-mounted only (no free-floating blue pillars)
      addBox(0.06, 0.7, 0.05, matHabLamp, -1.95, -0.35, 2.55);
      addBox(0.06, 0.7, 0.05, matHabLamp, 1.95, -0.35, 2.55);

      // ——— SLEEP CABIN (left, walk-in berth) ———
      // Recess shell / privacy alcove along port wall
      addBox(0.9, 2.35, 0.12, matSleepShell, -1.55, -0.05, 3.9);   // forward bulkhead
      addBox(0.9, 2.35, 0.12, matSleepShell, -1.55, -0.05, 7.45);  // aft bulkhead
      addBox(0.08, 2.35, 3.55, matSleepShell, -2.05, -0.05, 5.67); // outer wall liner
      addBox(0.85, 0.08, 3.55, matSleepShell, -1.58, -1.1, 5.67);  // raised cabin floor
      addBox(0.85, 0.06, 3.55, matDark, -1.58, 1.22, 5.67);         // cabin ceiling niche

      // Hatch frame facing corridor (open doorway — walk in)
      addBox(0.08, 2.15, 0.1, matFrame, -1.05, -0.1, 3.95);
      addBox(0.08, 2.15, 0.1, matFrame, -1.05, -0.1, 7.4);
      addBox(0.08, 0.12, 3.55, matFrame, -1.05, 1.0, 5.67);
      addBox(0.06, 0.06, 3.4, matHabLamp, -1.04, 0.92, 5.67);
      // Sliding privacy panel (parked open against aft jamb)
      addBox(0.06, 1.85, 0.85, matCurtain, -1.08, -0.15, 6.95);
      addBox(0.04, 0.04, 0.9, matMetal, -1.08, 0.85, 6.95);
      addLed(-1.02, 0.55, 4.15, 0x66e0ff, 0.04);
      addLed(-1.02, 0.55, 7.2, 0x88ffaa, 0.035);

      // Full bunk: frame → mattress → sheet → folded blanket → pillow
      addBox(0.78, 0.42, 1.95, matBunk, -1.6, -0.92, 4.9);          // bed frame
      addBox(0.74, 0.12, 1.88, matMattress, -1.6, -0.68, 4.9);       // mattress
      addBox(0.7, 0.03, 1.2, matSheet, -1.6, -0.6, 4.55);            // sheet (feet half)
      addBox(0.68, 0.1, 0.72, matBlanket, -1.6, -0.55, 5.35);        // blanket fold
      addBox(0.42, 0.14, 0.28, matPillow, -1.55, -0.52, 4.05);       // pillow
      addBox(0.08, 0.55, 1.9, matFrame, -1.22, -0.85, 4.9);          // bed rail
      // Headboard + reading lamp
      addBox(0.72, 0.7, 0.08, matFrame, -1.6, -0.45, 3.98);
      addBox(0.18, 0.06, 0.1, matSleepLamp, -1.45, 0.05, 4.05);
      addCyl(0.04, 0.05, 0.08, matMetal, -1.45, 0.0, 4.05, Math.PI / 2, 0, 0, 8);
      addBox(0.55, 0.05, 1.4, matSleepLamp, -1.55, 1.08, 5.6); // warm cabin ceiling strip

      // Mini night lanterns — stay lit in cutscene / power-off so the berth is readable
      const nightLights = [];
      const matNightLens = new THREE.MeshStandardMaterial({
        color: 0x1a1008,
        emissive: 0xffaa66,
        emissiveIntensity: 0.85,
        roughness: 0.35,
        metalness: 0.15,
      });
      matNightLens.userData.offEmissive = 0.25;
      matNightLens.userData.onEmissive = 1.15;
      root.userData.nightLensMat = matNightLens;
      const addNightLantern = (x, y, z, intensity = 0.55, color = 0xffb070) => {
        addBox(0.07, 0.05, 0.05, matMetal, x, y, z);
        addBox(0.045, 0.035, 0.04, matNightLens, x + 0.02, y, z);
        addCyl(0.012, 0.012, 0.05, matMetal, x - 0.02, y + 0.04, z, 0, 0, 0, 6);
        const pl = new THREE.PointLight(color, intensity * 0.55, 3.4, 1.55);
        pl.position.set(x + 0.05, y - 0.05, z);
        pl.userData.baseIntensity = intensity;
        pl.userData.nightLight = true;
        root.add(pl);
        nightLights.push(pl);
        return pl;
      };
      // Reading / bunk / aisle / locker micro-lights
      addNightLantern(-1.42, 0.12, 4.12, 0.72, 0xffc080); // headboard reader
      addNightLantern(-1.78, 0.95, 5.15, 0.48, 0xffb070); // ceiling niche
      addNightLantern(-1.12, 0.35, 5.05, 0.4, 0xffd0a0);  // doorway sill
      addNightLantern(-1.55, -0.35, 6.75, 0.35, 0xffaa66); // foot locker
      root.userData.nightLights = nightLights;

      // Foot locker + personal shelf
      addBox(0.7, 0.55, 0.75, matBunk, -1.65, -0.95, 6.95);
      addBox(0.68, 0.04, 0.72, matMetal, -1.65, -0.66, 6.95);
      addBox(0.55, 0.35, 0.12, matFrame, -1.6, -0.2, 7.25);
      addLed(-1.35, -0.55, 6.7, 0xffaa66, 0.028);
      addLed(-1.35, -0.55, 7.15, 0x3ec7ff, 0.028);

      // Cabin nameplate
      {
        const sc = document.createElement('canvas');
        sc.width = 256; sc.height = 96;
        const sx = sc.getContext('2d');
        if (sx) {
          sx.fillStyle = '#060a12';
          sx.fillRect(0, 0, 256, 96);
          sx.strokeStyle = '#66e0ff';
          sx.lineWidth = 4;
          sx.strokeRect(4, 4, 248, 88);
          sx.fillStyle = '#66e0ff';
          sx.font = 'bold 28px monospace';
          sx.fillText('КАЮТА · SLEEP', 16, 42);
          sx.fillStyle = 'rgba(160,200,255,0.75)';
          sx.font = '18px monospace';
          sx.fillText('BERTH A-01  ·  CREW', 16, 72);
        }
        const st = new THREE.CanvasTexture(sc);
        st.colorSpace = THREE.SRGBColorSpace;
        st.generateMipmaps = false;
        const nameplate = new THREE.Mesh(
          new THREE.PlaneGeometry(0.55, 0.2),
          new THREE.MeshBasicMaterial({ map: st, toneMapped: false })
        );
        nameplate.position.set(-1.04, 0.75, 4.35);
        nameplate.rotation.y = Math.PI / 2;
        nameplate.matrixAutoUpdate = false;
        nameplate.updateMatrix();
        root.add(nameplate);
      }
      addDecoMonitor(-1.72, 0.35, 6.2, 0.32, 0.22, Math.PI / 2, 'SLEEP', ['HR 52', 'REST'], '#88ffaa');

      // Convex portholes — thin rim + barely-there lens (real space behind)
      const lensGlassMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.02,
        transparent: true,
        opacity: 0.04,
        depthWrite: false,
        side: THREE.FrontSide,
      });
      const portTorusGeo = new THREE.TorusGeometry(0.2, 0.026, 8, 20);
      const portLensGeo = new THREE.SphereGeometry(0.19, 16, 12);
      const addConvexPorthole = (x, y, z, faceRight) => {
        const into = faceRight ? -1 : 1;

        const rim = new THREE.Mesh(portTorusGeo, matFrame);
        rim.position.set(x - into * 0.01, y, z);
        rim.rotation.y = into > 0 ? Math.PI / 2 : -Math.PI / 2;
        rim.matrixAutoUpdate = false;
        rim.updateMatrix();
        root.add(rim);

        const lens = new THREE.Mesh(portLensGeo, lensGlassMat);
        lens.scale.set(0.4, 1, 1);
        lens.position.set(x + into * 0.06, y, z);
        lens.renderOrder = 2;
        lens.matrixAutoUpdate = false;
        lens.updateMatrix();
        root.add(lens);

        addBox(0.035, 0.46, 0.46, matMetal, x - into * 0.015, y, z);
      };
      for (let i = 0; i < 5; i++) {
        addConvexPorthole(-1.97, 0.55, 4.4 + i * 0.7, false);
      }

      // Observation windows — hollow frame only; open void to real space (no gray glass pane)
      const addHullWindow = (x, y, z, sizeY = 0.72, sizeZ = 0.72, faceRight = false) => {
        const into = faceRight ? -1 : 1;
        const halfY = sizeY * 0.5;
        const halfZ = sizeZ * 0.5;
        const frameW = 0.09;
        const frameFace = 0.07;
        const fx = x + into * 0.03;

        // Hollow metal frame (4 sides only)
        addBox(frameW, frameFace, sizeZ + frameFace * 2, matFrame, fx, y + halfY + frameFace * 0.5, z);
        addBox(frameW, frameFace, sizeZ + frameFace * 2, matFrame, fx, y - halfY - frameFace * 0.5, z);
        addBox(frameW, sizeY, frameFace, matFrame, fx, y, z - halfZ - frameFace * 0.5);
        addBox(frameW, sizeY, frameFace, matFrame, fx, y, z + halfZ + frameFace * 0.5);
        const bx = x + into * 0.055;
        addBox(0.04, 0.035, sizeZ + 0.04, matMetal, bx, y + halfY + 0.01, z);
        addBox(0.04, 0.035, sizeZ + 0.04, matMetal, bx, y - halfY - 0.01, z);
        addBox(0.04, sizeY, 0.035, matMetal, bx, y, z - halfZ - 0.01);
        addBox(0.04, sizeY, 0.035, matMetal, bx, y, z + halfZ + 0.01);

        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            addCyl(
              0.024, 0.024, 0.035, matMetal,
              x + into * 0.07, y + sy * (halfY + 0.045), z + sz * (halfZ + 0.045),
              Math.PI / 2, 0, 0, 8
            );
          }
        }
        addLed(x + into * 0.08, y + halfY + 0.055, z - halfZ * 0.35, 0x3ec7ff, 0.03);
        addLed(x + into * 0.08, y + halfY + 0.055, z + halfZ * 0.35, 0x33ff88, 0.03);
      };
      addHullWindow(-1.97, 0.28, 3.35, 0.78, 0.78, false);
      addHullWindow(1.98, 0.2, 5.45, 1.6, 2.25, true);

      addBox(0.04, 0.04, 3.5, matHabLamp, -1.97, 0.88, 5.8);
      addDecoMonitor(-1.7, 0.45, 3.55, 0.34, 0.22, Math.PI / 2, 'ENV', ['1.00 atm', 'OK'], '#ffcc66');

      // RIGHT engineering tucked to corners — keep window clear
      for (let i = 0; i < 2; i++) {
        const z = 3.7 + i * 0.28;
        addCyl(0.06, 0.06, 0.9, matPipe, 1.85, -0.55, z, 0, 0, 0, 10);
        addLed(1.7, 0.15, z, [0x33ff88, 0x3ec7ff][i % 2], 0.028);
      }
      for (let i = 0; i < 2; i++) {
        const z = 7.05 + i * 0.28;
        addCyl(0.06, 0.06, 0.9, matPipe, 1.85, -0.55, z, 0, 0, 0, 10);
        addLed(1.7, 0.15, z, [0xff6622, 0x3ec7ff][i % 2], 0.028);
      }
      addBox(0.32, 0.7, 0.55, matHull, 1.86, -0.6, 3.75);
      addBox(0.32, 0.7, 0.55, matHull, 1.86, -0.6, 7.2);
      addDecoMonitor(1.78, -0.15, 3.75, 0.26, 0.16, -Math.PI / 2, 'RX', ['OK'], '#ff8866');
      addDecoMonitor(1.78, -0.15, 7.2, 0.26, 0.16, -Math.PI / 2, 'HY', ['A82'], '#66ccff');

      // ——— Door 05 (wide) — frame + auto sliding leaves ———
      addBox(1.3, 2.6, 0.22, matDark, -1.6, 0.05, 8.2);
      addBox(1.3, 2.6, 0.22, matDark, 1.6, 0.05, 8.2);
      addBox(4.2, 0.45, 0.22, matDark, 0, 1.2, 8.2);
      addBox(0.1, 2.0, 0.12, matFrame, -1.05, -0.1, 8.1);
      addBox(0.1, 2.0, 0.12, matFrame, 1.05, -0.1, 8.1);
      addBox(2.0, 0.12, 0.12, matFrame, 0, 0.95, 8.1);
      addBox(1.9, 0.05, 0.04, matHazard, 0, 0.82, 8.05);
      if (typeof root.userData.registerAutoDoor === 'function') {
        root.userData.registerAutoDoor('cargo', 8.15, { leafW: 1.08, leafH: 2.0, trigger: 2.0 });
      }
      {
        const labelC = document.createElement('canvas');
        labelC.width = 128; labelC.height = 128;
        const lctx = labelC.getContext('2d');
        if (lctx) {
          lctx.fillStyle = '#0a1018';
          lctx.fillRect(0, 0, 128, 128);
          lctx.fillStyle = '#e8f0ff';
          lctx.font = 'bold 72px monospace';
          lctx.textAlign = 'center';
          lctx.fillText('05', 64, 88);
        }
        const badge = new THREE.Mesh(
          new THREE.PlaneGeometry(0.32, 0.32),
          new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(labelC), toneMapped: false })
        );
        badge.material.map.colorSpace = THREE.SRGBColorSpace;
        badge.position.set(0, 0.55, 8.05);
        badge.matrixAutoUpdate = false;
        badge.updateMatrix();
        root.add(badge);
      }
      addLed(-0.95, 0.85, 8.05, 0x3ec7ff, 0.05);
      addLed(0.95, 0.85, 8.05, 0xff5544, 0.05);

      // ——— CARGO BAY (aft) ———
      addBox(4.4, 2.8, 0.3, matDark, 0, 0.08, 13.0);
      addBox(2.0, 0.06, 0.08, matHabLamp, 0, 0.9, 12.85);
      addDecoMonitor(0, 0.35, 12.84, 0.7, 0.45, Math.PI, 'CARGO HOLD', ['MASS  4.2 t', 'BAY OPEN'], '#3ec7ff');
      const crates = [
        [-1.2, -0.75, 9.4, 0.85, 0.9, 0.95],
        [-1.1, -0.55, 10.8, 0.7, 1.15, 0.75],
        [1.15, -0.7, 9.5, 0.8, 1.0, 0.85],
        [1.05, -0.85, 10.9, 1.0, 0.7, 0.8],
        [0, -0.95, 12.0, 1.1, 0.5, 0.65],
      ];
      for (const [cx, cy, cz, cw, ch, cd] of crates) {
        addBox(cw, ch, cd, matCargo, cx, cy, cz);
        addBox(cw * 0.92, 0.04, cd * 0.92, matHazard, cx, cy + ch * 0.45, cz);
      }
      for (let i = 0; i < 4; i++) {
        addBox(0.32, 0.85, 0.65, matFrame, -1.85, -0.3, 9.3 + i * 0.8);
        addBox(0.32, 0.85, 0.65, matFrame, 1.85, -0.3, 9.3 + i * 0.8);
      }
      addDecoMonitor(-1.75, 0.3, 9.8, 0.3, 0.22, Math.PI / 2, 'INV-A', ['LOCKED'], '#aaddff');
      addDecoMonitor(1.75, 0.3, 11.0, 0.3, 0.22, -Math.PI / 2, 'INV-B', ['CELLS'], '#ffdd88');

      // Remove seat-time bulkhead only when revealing walk area
      if (!root.userData._habKeepSeal && root.userData.aftSeal) {
        root.remove(root.userData.aftSeal);
        root.userData.aftSeal = null;
      }
      root.userData.walkLights = walkLights;
      }; // end buildHabitationLazy

      return root;
    }

    function ensureHabitation(opts = {}) {
      if (!cockpitRoot) return;
      const keepSealed = !!opts.keepSealed;
      if (cockpitRoot.userData.habitationBuilt) {
        if (!keepSealed && cockpitRoot.userData.aftSeal) {
          cockpitRoot.remove(cockpitRoot.userData.aftSeal);
          cockpitRoot.userData.aftSeal = null;
        }
        return;
      }
      const build = cockpitRoot.userData._buildHabitation;
      if (typeof build !== 'function') {
        cockpitRoot.userData.habitationBuilt = true;
        return;
      }
      try {
        cockpitRoot.userData._habKeepSeal = keepSealed;
        build();
        for (const c of HAB_COLLIDERS) CABIN_COLLIDERS.push(c);
        // Limits stay cockpit-sized until seal opens (walk reveal)
        if (!keepSealed) {
          CABIN_LIMITS.maxZ = CABIN_LIMITS_FULL.maxZ;
        }
        cockpitRoot.userData.habitationBuilt = true;
        cockpitRoot.userData._buildHabitation = null;
        // Compile shaders now (behind seal) so first look-around doesn't hitch
        const wasVisible = cockpitRoot.visible;
        cockpitRoot.visible = true;
        try { renderer.compile(scene, camera); } catch (_) { /* ignore */ }
        cockpitRoot.visible = wasVisible;
      } catch (err) {
        console.warn('[Solar] habitation load failed', err);
        cockpitRoot.userData.habitationBuilt = false;
      }
    }

    function revealHabitation() {
      ensureHabitation({ keepSealed: false });
      if (cockpitRoot?.userData.aftSeal) {
        cockpitRoot.remove(cockpitRoot.userData.aftSeal);
        cockpitRoot.userData.aftSeal = null;
      }
      CABIN_LIMITS.maxZ = CABIN_LIMITS_FULL.maxZ;
    }

    /** Build aft ship idle while pilot sits — freezes move off the stand/look moment */
    function scheduleHabitationPrewarm() {
      const run = () => {
        if (!cockpitRoot || cockpitRoot.userData.habitationBuilt) return;
        ensureHabitation({ keepSealed: true });
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 5000 });
      } else {
        setTimeout(run, 2800);
      }
    }

    cockpitRoot = buildCockpit();
    cockpitRoot.visible = false;
    ship.add(cockpitRoot);
    document.body.classList.add('cockpit-3d');

    // Hyperspace streak tunnel — ship-local (outside the hull), NOT camera overlay
    const warpStreakCount = 560;
    const warpStreakPos = new Float32Array(warpStreakCount * 6);
    const warpStreakSeed = [];
    for (let i = 0; i < warpStreakCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      // Ahead of the nose (−Z). Hollow centre so porthole shows a tunnel void.
      const rad = 1.8 + Math.pow(Math.random(), 0.55) * 48;
      const z = -6 - Math.random() * 320;
      warpStreakSeed.push({
        ang,
        rad,
        z,
        len: 4 + Math.random() * 28,
        spd: 0.65 + Math.random() * 1.8,
        spin: (Math.random() - 0.5) * 0.28,
      });
    }
    const warpStreakGeo = new THREE.BufferGeometry();
    warpStreakGeo.setAttribute('position', new THREE.BufferAttribute(warpStreakPos, 3));
    const warpStreakMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true, // cabin / dash occlude — only visible through the canopy
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const warpStreaks = new THREE.LineSegments(warpStreakGeo, warpStreakMat);
    warpStreaks.frustumCulled = false;
    warpStreaks.renderOrder = -2; // draw before cockpit glass / HUD screens
    warpStreaks.visible = false;
    // Parent to ship so the tunnel is in world/ship space, not glued to the eye
    ship.add(warpStreaks);

    let warpIntensity = 0;
    let hyperCharge = 0; // 0..1 gentle cabin charge during prep only

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
    let cabinExplore = false;
    let flightSession = false;
    let hoveredBtn = null;
    let exploreRmbLook = false;
    let mobilePlaying = false;
    let isWalkingInCabin = false;
    const pointerNdc = new THREE.Vector2(0, 0);
    const btnRaycaster = new THREE.Raycaster();
    const exploreMouse = { x: 0.5, y: 0.5 };

    // Declared early so M / MAP button work as soon as key handlers bind
    const navTablet = {
      open: false,
      selected: null,
      hits: [],
      zoom: 1,
      el: null,
      canvas: null,
      ctx: null,
      listEl: null,
      selName: null,
      selMeta: null,
      selDesc: null,
      warpBtn: null,
      ready: false,
    };

    /** Hyperdrive jump state — early so NAV/MAP can open during/after load */
    const hyper = {
      phase: null, // null | 'aim' | 'align' | 'prep' | 'travel'
      age: 0,
      target: null,
      dest: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      look: new THREE.Vector3(),
    };

    function isAltLook() {
      return cabinExplore
        || mobileLookHeld
        || !!(keys.AltLeft || keys.AltRight);
    }

    function syncWorldLabels() {
      const hideWorld = !!(cockpitRoot?.visible);
      for (const b of bodies) {
        if (b.label) b.label.visible = !hideWorld;
        for (const m of b.moons) {
          if (m.userData?.label) m.userData.label.visible = !hideWorld;
        }
      }
    }

    function isShipPowered() {
      return !cockpitRoot || cockpitRoot.userData.shipPowerOn !== false;
    }

    let orbitGroup = null;

    function syncOrbitGuides() {
      if (!orbitGroup) return;
      const hudOn = !document.body.classList.contains('hud-hidden');
      const awake = !document.body.classList.contains('waking');
      if (!hudOn || !awake || !isShipPowered()) {
        orbitGroup.visible = false;
        return;
      }
      // Orbit rings: captain's rubka only (by position) — not hab side windows
      orbitGroup.visible = isInCaptainCockpit();
    }

    function syncCockpitVisibility() {
      if (!cockpitRoot) return;
      const show = isPlaying() && !landed;
      cockpitRoot.visible = show;
      updateHudGlassVisibility();
      const powered = isShipPowered();
      for (const scr of ckScreens) {
        if (!scr.panel || scr.role === 'hudGlass') continue;
        scr.panel.visible = show && powered;
      }
      syncWorldLabels();
      syncOrbitGuides();
    }

    function getFocusedCockpitButton() {
      const list = cockpitRoot?.userData.ckButtons;
      const aiming = !!(keys.AltLeft || keys.AltRight || mobileLookHeld);
      if (!list?.length || !aiming || !isPlaying() || landed) return null;
      // Reticle = screen center while Alt held (pointer-lock)
      pointerNdc.set(0, 0);
      btnRaycaster.setFromCamera(pointerNdc, camera);
      const hits = btnRaycaster.intersectObjects(list, false);
      return hits[0]?.object || null;
    }

    function highlightCockpitButton(mesh) {
      const list = cockpitRoot?.userData.ckButtons || [];
      const powered = isShipPowered();
      for (const b of list) {
        const ud = b.userData.ckBtn;
        if (!ud) continue;
        const isPwr = ud.id === 'pwr';
        const base = (!powered && !isPwr) ? 0.04 : ud.baseEmissive;
        ud.mat.emissiveIntensity = (b === mesh) ? (isPwr || powered ? 1.35 : 0.15) : base;
      }
      hoveredBtn = mesh;
    }

    function activateCockpitButton(mesh) {
      const ud = mesh?.userData?.ckBtn;
      if (!ud?.action) return false;
      // Only PWR works while systems are dead
      if (!isShipPowered() && ud.id !== 'pwr') {
        if (modeEl) modeEl.textContent = 'Системы мертвы · наведите на PWR и нажмите';
        return false;
      }
      ud.action();
      ud.mat.emissiveIntensity = 2.2;
      setTimeout(() => {
        if (ud) {
          const powered = isShipPowered();
          const isPwr = ud.id === 'pwr';
          const base = (!powered && !isPwr) ? 0.04 : ud.baseEmissive;
          ud.mat.emissiveIntensity = (hoveredBtn === mesh) ? 1.35 : base;
        }
      }, 120);
      return true;
    }

    function syncAltReticle() {
      const hyperAim = document.body.classList.contains('hyper-aim');
      const aiming = hyperAim
        || (isPlaying() && !landed && !!(keys.AltLeft || keys.AltRight || mobileLookHeld));
      document.body.classList.toggle('alt-aim', aiming);
      if (!aiming) {
        document.body.classList.remove('alt-aim-hot');
        if (hoveredBtn) highlightCockpitButton(null);
        return;
      }
      if (hyperAim) {
        document.body.classList.toggle(
          'alt-aim-hot',
          document.body.classList.contains('hyper-aim-hot')
        );
        return;
      }
      document.body.classList.toggle('alt-aim-hot', !!hoveredBtn);
    }

    function tryClickCockpitButton() {
      return activateCockpitButton(getFocusedCockpitButton() || hoveredBtn);
    }

    function toggleCabinExplore(force) {
      // Mobile helper only — desktop uses hold-Alt + reticle
      const next = typeof force === 'boolean' ? force : !cabinExplore;
      if (next === cabinExplore) return;
      cabinExplore = next;
      document.body.classList.toggle('cabin-explore', cabinExplore);
      if (cabinExplore) {
        flightSession = true;
        mobileLookHeld = true;
        if (modeEl) modeEl.textContent = 'Осмотр 👁 · прицел в центре · тап — кнопка';
      } else {
        mobileLookHeld = false;
        hoveredBtn = null;
        highlightCockpitButton(null);
        if (modeEl && modeEl.textContent.includes('Осмотр')) modeEl.textContent = '';
      }
      syncCockpitVisibility();
      syncAltReticle();
    }

    function sitInPilotSeat() {
      if (seatAnim || landed) return;
      seatAnim = {
        mode: 'sit',
        age: 0,
        dur: 0.95,
        from: head.position.clone(),
        to: SEAT_HEAD.clone(),
        fromYaw: headYaw,
        toYaw: 0,
        fromPitch: headPitch,
        toPitch: 0,
      };
      if (modeEl) modeEl.textContent = 'Садимся…';
    }

    function standFromSeat() {
      if (landed || seatAnim) return;
      revealHabitation();
      flightSession = true;
      // Freeze ship immediately so residual orbit cruise doesn't drift the hull
      velocity.set(0, 0, 0);
      angVel.set(0, 0, 0);
      verticalVel = 0;
      seatAnim = {
        mode: 'stand',
        age: 0,
        dur: 0.9,
        from: head.position.clone(),
        to: STAND_HEAD.clone(),
        fromYaw: headYaw,
        toYaw: headYaw,
        fromPitch: headPitch,
        toPitch: headPitch * 0.25,
      };
      document.body.classList.add('cabin-walk');
      if (modeEl) modeEl.textContent = 'Встаём…';
      syncMobileSeatBtn();
    }

    function finishSeatAnim() {
      if (!seatAnim) return;
      const mode = seatAnim.mode;
      seatAnim = null;
      camera.position.copy(CAM_EYE);
      if (mode === 'stand') {
        isWalkingInCabin = true;
        head.position.copy(STAND_HEAD);
        if (modeEl) modeEl.textContent = document.body.classList.contains('mobile-play')
          ? 'Ходьба · 👁 — кнопки · СЕСТЬ у кресла'
          : 'Ходьба · LIGHT — свет · Alt+ЛКМ — кнопки · F у кресла — сесть';
      } else {
        isWalkingInCabin = false;
        head.position.copy(SEAT_HEAD);
        headYaw = 0;
        headPitch = 0;
        head.rotation.set(0, 0, 0);
        resetWalkBob();
        document.body.classList.remove('cabin-walk');
        if (modeEl) modeEl.textContent = document.body.classList.contains('mobile-play')
          ? 'В кресле · ВСТАТЬ — ходьба'
          : 'В кресле пилота · F — встать';
        setTimeout(() => {
          if (!isWalkingInCabin && !seatAnim && modeEl && (
            modeEl.textContent.includes('кресле') || modeEl.textContent.includes('ВСТАТЬ')
          )) {
            modeEl.textContent = '';
          }
        }, 1800);
      }
      syncMobileSeatBtn();
    }

    function syncMobileSeatBtn() {
      const btn = document.getElementById('btn-seat');
      if (!btn) return;
      const walking = isWalkingInCabin || seatAnim?.mode === 'stand';
      btn.textContent = walking ? 'СЕСТЬ' : 'ВСТАТЬ';
      btn.classList.toggle('walking', !!walking);
      btn.setAttribute('aria-label', walking ? 'Сесть в кресло' : 'Встать из кресла');
    }

    /** @returns {boolean} true while a sit/stand tween is running */
    function updateSeatAnim(dt) {
      if (!seatAnim) return false;
      seatAnim.age += dt;
      const u = Math.min(1, seatAnim.age / seatAnim.dur);
      const e = easeInOutCubic(u);

      head.position.lerpVectors(seatAnim.from, seatAnim.to, e);
      // Stand: rise out of the chair then settle. Sit: slight crouch as we lower in.
      const bobAmp = seatAnim.mode === 'stand' ? 0.09 : 0.07;
      const bob = Math.sin(Math.PI * e) * bobAmp;
      if (seatAnim.mode === 'stand') {
        head.position.y = THREE.MathUtils.lerp(seatAnim.from.y, seatAnim.to.y, e) + bob;
      } else {
        head.position.y = THREE.MathUtils.lerp(seatAnim.from.y, seatAnim.to.y, e) + bob * (1 - e);
      }

      headYaw = THREE.MathUtils.lerp(seatAnim.fromYaw, seatAnim.toYaw, e);
      headPitch = THREE.MathUtils.lerp(seatAnim.fromPitch, seatAnim.toPitch, e);
      head.rotation.set(headPitch, headYaw, 0, 'YXZ');
      camera.position.copy(CAM_EYE);
      walkBobAmt = 0;
      walkBobOff.set(0, 0, 0);
      camera.rotation.x = 0;
      camera.rotation.z = 0;

      // Soft-freeze ship turn during the motion
      angVel.multiplyScalar(Math.exp(-6 * dt));
      lookDelta.x = 0;
      lookDelta.y = 0;

      if (u >= 1) finishSeatAnim();
      return true;
    }

    function cabinWalkBlend() {
      if (isWalkingInCabin && !seatAnim) return 1;
      if (!seatAnim) return 0;
      const u = Math.min(1, seatAnim.age / Math.max(1e-4, seatAnim.dur));
      const e = easeInOutCubic(u);
      return seatAnim.mode === 'stand' ? e : 1 - e;
    }

    function syncCabinLights(dt) {
      if (!cockpitRoot) return;
      const walk = cabinWalkBlend();
      const flight = 1 - walk;
      const powered = isShipPowered();
      const cinematic = typeof isIntroCinematic === 'function' && isIntroCinematic();
      const powerMul = powered ? 1 : (cinematic ? 0.12 : 0);
      const lightsOn = !!cockpitRoot.userData.cabinLightsOn && powered;
      // Habitation glow only with LIGHT button — ship starts dark
      const lit = walk * (lightsOn ? 1 : 0) + (cinematic ? 0.12 : 0);
      const lights = cockpitRoot.userData.walkLights || [];
      for (const L of lights) {
        const target = (L.userData.baseIntensity || 1) * (0.01 + 0.99 * Math.min(1, lit)) * Math.max(powerMul, cinematic ? 0.08 : 0);
        L.intensity = THREE.MathUtils.damp(L.intensity, target, 5.5, dt);
      }
      // Berth mini-lanterns: always soft; brighter in wake cutscene
      const nightLs = cockpitRoot.userData.nightLights || [];
      for (const L of nightLs) {
        const base = L.userData.baseIntensity || 0.5;
        let nightTarget;
        if (cinematic) nightTarget = base * 0.95;
        else if (lightsOn && powered) nightTarget = base * 0.28;
        else if (powered) nightTarget = base * 0.42;
        else nightTarget = base * 0.55; // emergency standby
        L.intensity = THREE.MathUtils.damp(L.intensity, nightTarget, 4.5, dt);
      }
      const nightLens = cockpitRoot.userData.nightLensMat;
      if (nightLens) {
        const onE = nightLens.userData.onEmissive ?? 1.15;
        const offE = nightLens.userData.offEmissive ?? 0.25;
        const lensTarget = cinematic ? onE : (lightsOn && powered ? offE * 1.2 : onE * 0.7);
        nightLens.emissiveIntensity = THREE.MathUtils.damp(nightLens.emissiveIntensity, lensTarget, 5, dt);
      }
      const keyL = cockpitRoot.userData.keyLight;
      if (keyL) {
        // Prep: soft cyan charge only — no warpIntensity bloom of the cabin
        const chargeGlow = hyper.phase === 'prep' ? hyperCharge * 1.35 : 0;
        const travelGlow = hyper.phase === 'travel' ? warpIntensity * 3.2 : 0;
        const flightPulse = 1.85
          + (flight > 0.2 ? travelGlow + (isThrusting ? 0.2 : 0) + chargeGlow : chargeGlow);
        const walkKey = lightsOn ? 0.7 : 0.06;
        const target = powered
          ? (flightPulse * flight + walkKey * walk)
          : (cinematic ? 0.08 + walk * 0.05 : 0.01);
        keyL.intensity = THREE.MathUtils.damp(keyL.intensity, target, 6, dt);
        if ((hyper.phase === 'prep' && hyperCharge > 0.08) || (warpIntensity > 0.12 && flight > 0.5 && powered)) {
          const t = hyper.phase === 'prep' ? hyperCharge : 1;
          keyL.color.setRGB(
            THREE.MathUtils.lerp(0.42, 0.2, t),
            THREE.MathUtils.lerp(0.66, 0.75, t),
            1.0
          );
        } else {
          keyL.color.setRGB(0.42, 0.66, 1.0);
        }
      }
      const dash = cockpitRoot.userData.dashFill;
      if (dash) {
        const prepDash = hyper.phase === 'prep' ? 0.35 + hyperCharge * 0.9 : 0;
        dash.intensity = THREE.MathUtils.damp(
          dash.intensity,
          powered
            ? (dash.userData.baseIntensity || 1.1) * (0.25 + 0.75 * flight) + prepDash
            : (cinematic ? 0.04 : 0),
          5, dt
        );
      }
      const rim = cockpitRoot.userData.rimFill;
      if (rim) {
        const prepRim = hyper.phase === 'prep' ? hyperCharge * 0.55 : 0;
        rim.intensity = THREE.MathUtils.damp(
          rim.intensity,
          powered
            ? (rim.userData.baseIntensity || 0.55) * (0.2 + 0.8 * flight) + 0.25 * lit + prepRim
            : (cinematic ? 0.05 : 0),
          5, dt
        );
      }
      const mapL = cockpitRoot.userData.mapLight;
      if (mapL) {
        mapL.intensity = THREE.MathUtils.damp(
          mapL.intensity,
          powered ? (mapL.userData.baseIntensity || 0.55) * (0.3 + 0.7 * flight) : (cinematic ? 0.02 : 0),
          5, dt
        );
      }
      const amb = cockpitRoot.userData.cabinAmbient;
      if (amb) {
        const prepAmb = hyper.phase === 'prep' ? 0.04 + hyperCharge * 0.35 : 0;
        amb.intensity = THREE.MathUtils.damp(
          amb.intensity,
          powered
            ? (amb.userData.baseIntensity || 0.45) * lit + 0.02 * flight + prepAmb
            : (cinematic ? 0.09 : 0),
          5, dt
        );
      }
      const habLamp = cockpitRoot.userData.habLampMat;
      if (habLamp) {
        const onE = habLamp.userData.onEmissive ?? 0.72;
        const offE = habLamp.userData.offEmissive ?? 0.015;
        habLamp.emissiveIntensity = THREE.MathUtils.damp(
          habLamp.emissiveIntensity,
          powered && lightsOn ? onE : offE * (powered ? 0.6 : 0.15),
          5.5, dt
        );
      }
      const sleepLamp = cockpitRoot.userData.sleepLampMat;
      if (sleepLamp) {
        const onE = sleepLamp.userData.onEmissive ?? 0.55;
        const offE = sleepLamp.userData.offEmissive ?? 0.02;
        // Bunk strip + reader glow strong in wake cutscene
        const sleepGlow = cinematic
          ? onE * 0.95
          : ((powered && lightsOn) ? onE : offE * (powered ? 0.8 : 0.35));
        sleepLamp.emissiveIntensity = THREE.MathUtils.damp(
          sleepLamp.emissiveIntensity,
          sleepGlow,
          5.5, dt
        );
      }
      for (const pm of cockpitRoot.userData.habPanelMats || []) {
        const onO = pm.userData.onOpacity ?? 1;
        const offO = pm.userData.offOpacity ?? 0.18;
        const target = powered ? (lightsOn ? onO : offO) : 0.02;
        pm.opacity = THREE.MathUtils.damp(pm.opacity, target, 5.5, dt);
      }
      // Cockpit trim / LED glow dies with power
      for (const mat of cockpitRoot.userData.powerEmissiveMats || []) {
        const base = mat.userData.baseEmissive ?? 0.2;
        mat.emissiveIntensity = THREE.MathUtils.damp(
          mat.emissiveIntensity,
          powered ? base : 0.004,
          6, dt
        );
      }
      // Keep PWR button faintly alive in the dark
      if (!powered) {
        for (const b of cockpitRoot.userData.ckButtons || []) {
          const ud = b.userData.ckBtn;
          if (ud?.id === 'pwr') {
            ud.mat.emissiveIntensity = THREE.MathUtils.damp(
              ud.mat.emissiveIntensity,
              hoveredBtn === b ? 1.2 : 0.45,
              8, dt
            );
          }
        }
      }
    }

    function toggleWalkInCabin() {
      if (!isPlaying() || landed || seatAnim) return;
      if (!isWalkingInCabin) {
        standFromSeat();
        return;
      }
      const distToSeat = head.position.distanceTo(SEAT_HEAD);
      if (distToSeat < 0.85) {
        sitInPilotSeat();
      } else if (modeEl) {
        modeEl.textContent = document.body.classList.contains('mobile-play')
          ? 'Подойдите ближе к креслу · СЕСТЬ'
          : 'Подойдите ближе к креслу пилота (F)';
      }
      syncMobileSeatBtn();
    }

    function isPlaying() {
      return mobilePlaying || controls.isLocked || flightSession;
    }

    function refreshWarpStreaks(amount, dt) {
      const pos = warpStreakGeo.attributes.position.array;
      // Ship-local −Z = forward. Streaks rush toward the hull (+Z).
      const rush = 70 + amount * 460;
      const noseZ = -2.4; // recycle once past the canopy
      for (let i = 0; i < warpStreakCount; i++) {
        const s = warpStreakSeed[i];
        s.z += rush * s.spd * dt;
        s.ang += s.spin * dt * (0.35 + amount * 1.1);
        if (s.z > noseZ) {
          s.z = -12 - Math.random() * 340;
          s.ang = Math.random() * Math.PI * 2;
          s.rad = 1.6 + Math.pow(Math.random(), 0.5) * 52;
          s.len = 8 + Math.random() * (22 + amount * 55);
          s.spd = 0.7 + Math.random() * 1.9;
        }
        const c = Math.cos(s.ang);
        const sn = Math.sin(s.ang);
        const depthT = THREE.MathUtils.clamp((-s.z) / 320, 0, 1);
        const stretch = s.len * (0.4 + amount * 5.2) * (0.4 + (1 - depthT) * 1.5);
        // Radial-out + flying into the nose
        const dx = c * (0.5 + amount * 0.95);
        const dy = sn * (0.5 + amount * 0.95);
        const dz = 1.15 + amount * 2.4;
        const inv = 1 / Math.hypot(dx, dy, dz);
        const hx = dx * inv * stretch;
        const hy = dy * inv * stretch;
        const hz = dz * inv * stretch;
        const x = c * s.rad;
        const y = sn * s.rad;
        const i6 = i * 6;
        pos[i6] = x - hx * 0.12;
        pos[i6 + 1] = y - hy * 0.12;
        pos[i6 + 2] = s.z;
        pos[i6 + 3] = x + hx;
        pos[i6 + 4] = y + hy;
        pos[i6 + 5] = s.z + hz;
      }
      warpStreakGeo.attributes.position.needsUpdate = true;
      warpStreakMat.opacity = 0.5 + amount * 0.48;
      warpStreakMat.color.setRGB(0.92 + amount * 0.08, 0.96, 1.0);
    }


    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0
      || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isMobileUA = isTouch;

    // Phone: sharper render + softer glow (prettier without going full-desktop cost)
    if (isMobileUA) {
      const pr = Math.min(window.devicePixelRatio || 1, 1.75);
      renderer.setPixelRatio(pr);
      composer.setPixelRatio(pr);
      renderer.toneMappingExposure = 1.14;
      bloomPass.strength = 0.32;
      bloomPass.threshold = 0.94;
      bloomPass.radius = 0.48;
      // Slimmer HUD glass so it doesn't fill the whole windshield
      const glass = cockpitRoot?.userData.hudGlass;
      if (glass) {
        glass.scale.set(0.62, 0.58, 1);
        glass.updateMatrix();
        const sz = cockpitRoot.userData.hudGlassSize;
        if (sz) {
          cockpitRoot.userData.hudGlassSize = { sx: sz.sx * 0.62, sy: sz.sy * 0.58 };
        }
      }
      // Compact dash screens a bit
      for (const scr of ckScreens) {
        if (scr.role === 'hudGlass' || !scr.panel) continue;
        scr.panel.scale.set(0.88, 0.88, 1);
        scr.panel.updateMatrix();
      }
    }

    const mobilePad = document.getElementById('mobile-pad');
    const hintText = document.getElementById('hint-text');
    const resumeTip = document.getElementById('resume-tip');
    const wakeVeil = document.getElementById('wake-veil');
    const introSkipEl = document.getElementById('intro-skip');
    const introSkipFill = document.getElementById('intro-skip-fill');
    const mobileMove = { x: 0, z: 0 };
    const mobileLookVel = { x: 0, y: 0 };
    let mobileLookDragging = false;

    /** Cinematic intro: bunk wake → walk to seat → power-on → control */
    let wake = null;
    const INTRO_SLEEP_HEAD = new THREE.Vector3(-1.52, -0.28, 4.22);
    // Lie on back: pitch ≈ +1.2 looks at cabin ceiling (not the side wall)
    const INTRO_CEIL_YAW = 0.0;
    const INTRO_CEIL_PITCH = 1.22;
    const INTRO_STAND_BUNK = new THREE.Vector3(-0.92, 0.08, 5.05);
    // Path goes RIGHT of the pilot seat (collider x±0.45, z 0.55–1.4) — never through it
    const INTRO_WALK_PATH = [
      new THREE.Vector3(-0.92, 0.08, 5.05),
      new THREE.Vector3(-0.2, 0.08, 4.1),
      new THREE.Vector3(0.15, 0.08, 3.15),
      new THREE.Vector3(0.72, 0.08, 2.15),
      new THREE.Vector3(0.78, 0.08, 1.45),
      new THREE.Vector3(0.72, 0.08, 0.85),
      new THREE.Vector3(0.35, 0.08, 0.58),
      new THREE.Vector3(0.08, 0.08, 0.55),
    ];
    const INTRO_SKIP_HOLD = 3.0;

    if (isTouch && hintText) {
      hintText.textContent = 'Джойстик — тяга/тормоз/крен · свайп — поворот · ВСТАТЬ — ходьба · ⚡ — ×3 · ✕ — тормоз · 👁 — осмотр.';
    }
    if (isTouch && wakeVeil) {
      const wh = wakeVeil.querySelector('.wake-hint');
      if (wh) wh.textContent = 'Коснитесь · поверните телефон горизонтально';
    }

    function startPlay() {
      flightSession = true;
      if (resumeTip) resumeTip.classList.add('hidden');
      unlockEngineAudio();
      if (isTouch) {
        mobilePlaying = true;
        document.body.classList.add('mobile-play');
        mobilePad.classList.add('active');
        hint.classList.add('hidden');
        ensureMobileImmersive();
        requestAppFullscreen();
        lockLandscape();
        hideBrowserChrome();
        scheduleFitViewport();
      } else {
        controls.lock();
      }
      syncCockpitVisibility();
    }

    function sampleLookKeys(keys, t) {
      const last = keys[keys.length - 1];
      let ty = last[1];
      let tp = last[2];
      if (t <= keys[0][0]) return { yaw: keys[0][1], pitch: keys[0][2], done: false };
      if (t >= last[0]) return { yaw: ty, pitch: tp, done: true };
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i];
        const b = keys[i + 1];
        if (t >= a[0] && t <= b[0]) {
          let u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
          u = u * u * u * (u * (u * 6 - 15) + 10);
          return {
            yaw: a[1] + (b[1] - a[1]) * u,
            pitch: a[2] + (b[2] - a[2]) * u,
            done: false,
          };
        }
      }
      return { yaw: ty, pitch: tp, done: true };
    }

    function samplePolyline(pts, u) {
      if (!pts.length) return new THREE.Vector3();
      if (u <= 0) return pts[0].clone();
      if (u >= 1) return pts[pts.length - 1].clone();
      let total = 0;
      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const len = pts[i].distanceTo(pts[i + 1]);
        segs.push(len);
        total += len;
      }
      let d = u * total;
      for (let i = 0; i < segs.length; i++) {
        if (d <= segs[i] || i === segs.length - 1) {
          const t = segs[i] < 1e-6 ? 1 : d / segs[i];
          const e = t * t * (3 - 2 * t);
          return pts[i].clone().lerp(pts[i + 1], e);
        }
        d -= segs[i];
      }
      return pts[pts.length - 1].clone();
    }

    function pathFacingYaw(pts, u) {
      const a = samplePolyline(pts, Math.max(0, u - 0.02));
      const b = samplePolyline(pts, Math.min(1, u + 0.02));
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      // Head −Z forward: yaw ≈ atan2(-dx, -dz)
      return Math.atan2(-dx, -dz);
    }

    function setIntroCaption(text) {
      // Silent cinematic — no action captions during intro
      if (!modeEl) return;
      if (wake && wake.active && !wake.canControl) {
        modeEl.textContent = '';
        return;
      }
      modeEl.textContent = text || '';
    }

    function setShipPower(on, opts = {}) {
      if (!cockpitRoot) return;
      cockpitRoot.userData.shipPowerOn = !!on;
      document.body.classList.toggle('ship-power-off', !on);
      if (on && opts.lights === true) cockpitRoot.userData.cabinLightsOn = true;
      if (!on && !opts.keepCabinLights) cockpitRoot.userData.cabinLightsOn = false;
      for (const scr of ckScreens) {
        if (!on) {
          scr._poweredOff = true;
          scr._sig = '';
        } else {
          scr._poweredOff = false;
          scr._sig = '';
          scr._bootFlash = opts.boot ? 1 : 0;
        }
      }
      syncCockpitVisibility();
    }

    function beginWakeSequence() {
      flightSession = true;
      hint.classList.add('hidden');
      if (resumeTip) resumeTip.classList.add('hidden');
      document.body.classList.add('waking', 'wake-await');
      document.body.classList.remove('intro-boot', 'cabin-walk');

      // Prefab habitation so bunk / corridor exist under closed lids
      try {
        if (typeof ensureHabitation === 'function') ensureHabitation({ keepSealed: false });
        if (typeof revealHabitation === 'function') revealHabitation();
      } catch (_) { /* ignore */ }

      setShipPower(false, { keepCabinLights: false });
      if (cockpitRoot) cockpitRoot.userData.cabinLightsOn = false;
      isWalkingInCabin = true;
      seatAnim = null;
      velocity.set(0, 0, 0);
      angVel.set(0, 0, 0);
      verticalVel = 0;

      head.position.copy(INTRO_SLEEP_HEAD);
      camera.position.copy(CAM_EYE);
      headYaw = INTRO_CEIL_YAW;
      headPitch = INTRO_CEIL_PITCH;
      head.rotation.set(headPitch, headYaw, 0, 'YXZ');
      resetWalkBob();

      wake = {
        active: true,
        gate: true,
        phase: 'gate',
        age: 0,
        totalAge: 0,
        humAge: 0,
        eyeAge: 0,
        skipHold: 0,
        pathU: 0,
        canControl: false,
        lookDone: false,
        finished: false,
        powered: false,
      };
      if (wakeVeil) {
        wakeVeil.classList.remove('done');
        wakeVeil.classList.add('await-click');
        wakeVeil.style.pointerEvents = '';
        wakeVeil.style.setProperty('--wake-open', '0');
      }
      if (introSkipFill) introSkipFill.style.width = '0%';
      syncCockpitVisibility();
      syncOrbitGuides();
      setIntroCaption('');
      scheduleHabitationPrewarm();
      prefetchEngineAudio();
    }

    async function releaseWakeGate() {
      if (!wake || !wake.gate) return;
      if (typeof ensureMobileImmersive === 'function') await ensureMobileImmersive();
      else if (isTouch) await requestAppFullscreen();
      await unlockEngineAudio();
      if (!wake || !wake.gate) return;
      wake.gate = false;
      wake.phase = 'hum';
      wake.age = 0;
      document.body.classList.remove('wake-await');
      if (wakeVeil) {
        wakeVeil.classList.remove('await-click');
        wakeVeil.style.pointerEvents = 'none';
      }
      setIntroCaption('');
      hideBrowserChrome?.();
      updateOrientGate?.();
    }

    function advanceIntroPhase(next, caption) {
      if (!wake) return;
      wake.phase = next;
      wake.age = 0;
      if (caption != null) setIntroCaption(caption);
    }

    function completeWakeIntro(skipped) {
      if (!wake || wake.finished) return;
      wake.finished = true;
      wake.active = false;
      wake.gate = false;
      wake.lookDone = true;
      wake.canControl = true;
      wake.phase = 'done';

      setShipPower(true, { lights: false, boot: false });
      if (cockpitRoot) cockpitRoot.userData.cabinLightsOn = false;
      try {
        if (typeof revealHabitation === 'function') revealHabitation();
      } catch (_) { /* ignore */ }

      isWalkingInCabin = false;
      seatAnim = null;
      head.position.copy(SEAT_HEAD);
      headYaw = 0;
      headPitch = 0;
      head.rotation.set(0, 0, 0, 'YXZ');
      resetWalkBob();
      document.body.classList.remove('waking', 'wake-await', 'cabin-walk', 'intro-boot');
      if (wakeVeil) {
        wakeVeil.classList.add('done');
        wakeVeil.style.setProperty('--wake-open', '1');
      }
      if (introSkipFill) introSkipFill.style.width = '0%';
      syncCockpitVisibility();
      syncOrbitGuides();
      setIntroCaption(skipped
        ? 'Вступление пропущено · системы онлайн'
        : 'Системы онлайн · управление ваше');
      setTimeout(() => {
        if (modeEl && (modeEl.textContent.includes('Системы онлайн') || modeEl.textContent.includes('пропущено'))) {
          modeEl.textContent = '';
        }
      }, 2200);

      if (isTouch) startPlay();
      else if (!controls.isLocked) setIntroCaption('Кликните — управление мышью');
    }

    function updateIntroSkip(dt) {
      if (!wake || !wake.active || wake.gate || wake.finished) {
        if (introSkipFill) introSkipFill.style.width = '0%';
        return;
      }
      const holding = !!(keys.Space);
      if (holding) wake.skipHold += dt;
      else wake.skipHold = Math.max(0, wake.skipHold - dt * 1.6);
      const p = THREE.MathUtils.clamp(wake.skipHold / INTRO_SKIP_HOLD, 0, 1);
      if (introSkipFill) introSkipFill.style.width = `${(p * 100).toFixed(1)}%`;
      if (p >= 1) completeWakeIntro(true);
    }

    function updateWake(dt) {
      if (!wake || !wake.active) return;

      updateIntroSkip(dt);

      if (wake.gate) {
        if (wakeVeil) wakeVeil.style.setProperty('--wake-open', '0');
        return;
      }

      wake.totalAge += dt;
      wake.age += dt;
      wake.humAge = wake.phase === 'hum' ? wake.age : Math.max(wake.humAge, 2.6);
      // Freeze ship during entire cinematic
      velocity.set(0, 0, 0);
      angVel.set(0, 0, 0);
      verticalVel = 0;
      lookDelta.x = 0;
      lookDelta.y = 0;

      const dampLook = (ty, tp, k = 1.05) => {
        // Soft follow — low lambda removes jerk from keyframe jumps
        headYaw = THREE.MathUtils.damp(headYaw, ty, k, dt);
        headPitch = THREE.MathUtils.damp(headPitch, tp, k, dt);
        head.rotation.set(headPitch, headYaw, 0, 'YXZ');
      };

      // ——— PHASE: hum (eyes shut) ———
      if (wake.phase === 'hum') {
        if (wakeVeil) wakeVeil.style.setProperty('--wake-open', '0');
        head.position.copy(INTRO_SLEEP_HEAD);
        dampLook(INTRO_CEIL_YAW, INTRO_CEIL_PITCH, 1.2);
        if (wake.age >= 2.4) advanceIntroPhase('eyes', '');
        return;
      }

      // ——— PHASE: open eyes ———
      if (wake.phase === 'eyes') {
        const open = THREE.MathUtils.clamp(wake.age / 3.4, 0, 1);
        const ease = open * open * open * (open * (open * 6 - 15) + 10);
        if (wakeVeil) wakeVeil.style.setProperty('--wake-open', String(ease));
        head.position.copy(INTRO_SLEEP_HEAD);
        // Stay on the ceiling while lids open
        dampLook(INTRO_CEIL_YAW, INTRO_CEIL_PITCH, 1.15);
        if (wake.age >= 3.6) advanceIntroPhase('bunkLook', '');
        return;
      }

      // ——— PHASE: look around from bunk ———
      if (wake.phase === 'bunkLook') {
        if (wakeVeil) wakeVeil.style.setProperty('--wake-open', '1');
        head.position.copy(INTRO_SLEEP_HEAD);
        const look = sampleLookKeys([
          [0.0, INTRO_CEIL_YAW, INTRO_CEIL_PITCH], // ceiling
          [2.2, 0.05, 1.05],                         // still mostly up
          [3.8, 0.85, 0.35],                        // left wall slowly
          [5.2, 0.55, 0.15],
          [6.6, -0.45, 0.08],                       // toward aisle
          [8.0, -0.95, 0.02],                       // right / window side
          [9.4, -1.15, 0.0],
        ], wake.age);
        dampLook(look.yaw, look.pitch, 0.9);
        if (wake.age >= 9.8) advanceIntroPhase('rise', '');
        return;
      }

      // ——— PHASE: sit up / rise from bunk ———
      if (wake.phase === 'rise') {
        const u = THREE.MathUtils.clamp(wake.age / 2.5, 0, 1);
        const e = easeInOutCubic(u);
        head.position.lerpVectors(INTRO_SLEEP_HEAD, INTRO_STAND_BUNK, e);
        head.position.y += Math.sin(Math.PI * e) * 0.12;
        // From ceiling → level → face the right observation window
        dampLook(
          THREE.MathUtils.lerp(INTRO_CEIL_YAW, -1.38, e),
          THREE.MathUtils.lerp(INTRO_CEIL_PITCH, 0.0, e),
          1.0
        );
        document.body.classList.add('cabin-walk');
        if (u >= 1) {
          isWalkingInCabin = true;
          advanceIntroPhase('windowLook', '');
        }
        return;
      }

      // ——— PHASE: gaze at right observation window ———
      if (wake.phase === 'windowLook') {
        head.position.copy(INTRO_STAND_BUNK);
        const look = sampleLookKeys([
          [0.0, -1.35, 0.02],
          [1.4, -1.42, -0.04],
          [2.8, -1.48, 0.06],
          [4.0, -1.38, 0.0],
          [5.2, -0.55, -0.04], // ease toward corridor / cockpit
          [6.2, pathFacingYaw(INTRO_WALK_PATH, 0), -0.06],
        ], wake.age);
        dampLook(look.yaw, look.pitch, 0.9);
        if (wake.age >= 6.5) advanceIntroPhase('walk', '');
        return;
      }

      // ——— PHASE: walk to cockpit ———
      if (wake.phase === 'walk') {
        const u = THREE.MathUtils.clamp(wake.age / 14.5, 0, 1);
        const e = u * u * u * (u * (u * 6 - 15) + 10);
        wake.pathU = e;
        head.position.copy(samplePolyline(INTRO_WALK_PATH, e));
        resolveCabinWalk(head.position); // keep clear of seat / walls
        const face = pathFacingYaw(INTRO_WALK_PATH, e);
        dampLook(face, -0.05, 1.15);
        updateWalkBob(dt, true);
        walkBobOff.multiplyScalar(0.35);
        camera.rotation.z *= 0.35;
        camera.rotation.x *= 0.35;
        camera.position.copy(CAM_EYE).add(walkBobOff);
        if (u >= 1) {
          resetWalkBob();
          advanceIntroPhase('sit', '');
        }
        return;
      }

      // ——— PHASE: sit in pilot seat (approach from the right side) ———
      if (wake.phase === 'sit') {
        const u = THREE.MathUtils.clamp(wake.age / 1.55, 0, 1);
        const e = easeInOutCubic(u);
        const from = INTRO_WALK_PATH[INTRO_WALK_PATH.length - 1];
        // Arc: side → over seat cushion → SEAT_HEAD (not through the backrest)
        const mid = new THREE.Vector3(0.28, 0.1, 0.35);
        const p = e < 0.55
          ? from.clone().lerp(mid, e / 0.55)
          : mid.clone().lerp(SEAT_HEAD, (e - 0.55) / 0.45);
        head.position.copy(p);
        head.position.y += Math.sin(Math.PI * e) * 0.05 * (1 - e);
        dampLook(
          THREE.MathUtils.lerp(pathFacingYaw(INTRO_WALK_PATH, 1), 0, e),
          THREE.MathUtils.lerp(-0.04, -0.08, e),
          3.2
        );
        if (u >= 1) {
          isWalkingInCabin = false;
          document.body.classList.remove('cabin-walk');
          head.position.copy(SEAT_HEAD);
          resetWalkBob();
          advanceIntroPhase('seatLook', '');
        }
        return;
      }

      // ——— PHASE: look over dash / panels ———
      if (wake.phase === 'seatLook') {
        head.position.copy(SEAT_HEAD);
        const look = sampleLookKeys([
          [0.0, 0.0, -0.08],
          [1.4, 0.55, -0.22],
          [2.6, 0.72, -0.35],
          [3.8, -0.55, -0.28],
          [5.0, -0.35, -0.45],
          [6.2, 0.15, -0.55], // down toward PWR bank
          [7.4, 0.42, -0.62],
          [8.4, 0.46, -0.58],
        ], wake.age);
        dampLook(look.yaw, look.pitch, 0.95);
        if (wake.age >= 8.8) {
          document.body.classList.add('intro-boot');
          advanceIntroPhase('power', '');
        }
        return;
      }

      // ——— PHASE: power on ———
      if (wake.phase === 'power') {
        head.position.copy(SEAT_HEAD);
        dampLook(0.46, -0.58, 1.1);
        // Flash PWR button
        const pwr = (cockpitRoot?.userData.ckButtons || []).find((b) => b.userData?.ckBtn?.id === 'pwr');
        if (pwr?.userData?.ckBtn) {
          pwr.userData.ckBtn.mat.emissiveIntensity = 0.55 + Math.sin(wake.age * 3.2) * 0.35;
        }
        if (wake.age >= 1.15 && !wake.powered) {
          wake.powered = true;
          setShipPower(true, { lights: false, boot: true });
          if (cockpitRoot) cockpitRoot.userData.cabinLightsOn = false;
          setIntroCaption('Загрузка систем…');
        }
        if (wake.age >= 1.8) advanceIntroPhase('boot', '');
        return;
      }

      // ——— PHASE: screens / HUD boot ———
      if (wake.phase === 'boot') {
        head.position.copy(SEAT_HEAD);
        const look = sampleLookKeys([
          [0.0, 0.4, -0.5],
          [1.2, 0.0, -0.2],
          [2.4, -0.2, -0.15],
          [3.4, 0.0, -0.05],
        ], wake.age);
        dampLook(look.yaw, look.pitch, 0.95);
        if (wakeVeil) {
          // Soft residual fade clears fully
          const fade = Math.max(0, 1 - wake.age * 0.35);
          wakeVeil.style.setProperty('--wake-open', String(1 - fade * 0.08));
        }
        if (wake.age >= 3.6) {
          wake.lookDone = true;
          completeWakeIntro(false);
        }
        return;
      }
    }

    function isWakeBlocking() {
      // Block ship control for entire cinematic until control handover
      return !!(wake && wake.active && (!wake.canControl || wake.gate));
    }

    function isIntroCinematic() {
      return !!(wake && wake.active && !wake.canControl);
    }

    // Black-screen click unlocks audio and starts quiet drone before eyelids open
    wakeVeil?.addEventListener('pointerdown', (e) => {
      if (!wake?.gate) return;
      e.preventDefault();
      e.stopPropagation();
      releaseWakeGate();
    }, true);

    // Touch hold on skip bar also skips
    introSkipEl?.addEventListener('pointerdown', (e) => {
      if (!wake || wake.gate || !wake.active) return;
      e.preventDefault();
      keys.Space = true;
    });
    introSkipEl?.addEventListener('pointerup', () => { keys.Space = false; });
    introSkipEl?.addEventListener('pointerleave', () => { keys.Space = false; });
    introSkipEl?.addEventListener('pointercancel', () => { keys.Space = false; });

    function fitAppViewport(force) {
      const vv = window.visualViewport;
      const fs = !!document.fullscreenElement;
      let w = Math.round(
        fs ? (window.innerWidth || screen.width)
          : (vv?.width || window.innerWidth || document.documentElement.clientWidth || 1)
      );
      let h = Math.round(
        fs ? (window.innerHeight || screen.height)
          : (vv?.height || window.innerHeight || document.documentElement.clientHeight || 1)
      );
      w = Math.max(1, w);
      h = Math.max(1, h);

      // Only auto-correct swapped dims on phones after rotate — never on desktop window resize
      if (isTouch && screen.orientation?.type) {
        const landscape = screen.orientation.type.startsWith('landscape');
        if (landscape && w < h * 0.85) { const t = w; w = h; h = t; }
        if (!landscape && h < w * 0.85) { const t = w; w = h; h = t; }
      }

      if (!force && w === fitAppViewport._w && h === fitAppViewport._h) return;
      fitAppViewport._w = w;
      fitAppViewport._h = h;
      document.documentElement.style.setProperty('--app-w', `${w}px`);
      document.documentElement.style.setProperty('--app-h', `${h}px`);

      if (camera && renderer && composer) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        // false = don't bake fixed px into canvas.style (CSS keeps 100% of wrap)
        renderer.setSize(w, h, false);
        const canvas = renderer.domElement;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        composer.setSize(w, h);
        const pr = renderer.getPixelRatio();
        fxaaPass.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        bloomPass.setSize(w, h);
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
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
          if (el.requestFullscreen) {
            await el.requestFullscreen({ navigationUI: 'hide' });
          } else if (el.webkitRequestFullscreen) {
            el.webkitRequestFullscreen();
          } else if (el.webkitEnterFullscreen) {
            el.webkitEnterFullscreen();
          }
        }
      } catch (_) { /* gesture / unsupported */ }
      await lockLandscape();
      hideBrowserChrome();
      scheduleFitViewport();
    }

    async function lockLandscape() {
      try {
        const o = screen.orientation;
        if (o?.lock) {
          await o.lock('landscape');
        }
      } catch (_) {
        try {
          // Some Android WebViews accept landscape-primary only
          await screen.orientation?.lock?.('landscape-primary');
        } catch (_) { /* ignore */ }
      }
    }

    function isLandscapeNow() {
      if (screen.orientation?.type) {
        return screen.orientation.type.startsWith('landscape');
      }
      const vv = window.visualViewport;
      const w = vv?.width || window.innerWidth || 1;
      const h = vv?.height || window.innerHeight || 1;
      return w >= h * 0.95;
    }

    function hideBrowserChrome() {
      if (!isTouch) return;
      try {
        // Nudge mobile browser chrome away
        window.scrollTo(0, 0);
        requestAnimationFrame(() => {
          try { window.scrollTo(0, 1); } catch (_) {}
          setTimeout(() => {
            try { window.scrollTo(0, 0); } catch (_) {}
            scheduleFitViewport();
          }, 80);
        });
      } catch (_) { /* ignore */ }
    }

    function updateOrientGate() {
      if (!isTouch) {
        document.body.classList.remove('need-landscape');
        const gate = document.getElementById('orient-gate');
        if (gate) gate.setAttribute('aria-hidden', 'true');
        return;
      }
      const need = !isLandscapeNow();
      document.body.classList.toggle('need-landscape', need);
      document.body.classList.toggle('is-landscape', !need);
      const gate = document.getElementById('orient-gate');
      if (gate) gate.setAttribute('aria-hidden', need ? 'false' : 'true');
      if (!need) {
        hideBrowserChrome();
        scheduleFitViewport();
      }
    }

    function toggleHud() {
      document.body.classList.toggle('hud-hidden');
      const hidden = document.body.classList.contains('hud-hidden');
      const btn = document.getElementById('hud-toggle');
      if (btn) {
        btn.textContent = hidden ? '▢' : '▣';
        btn.title = hidden ? 'Показать HUD (H)' : 'Скрыть HUD (H)';
      }
      syncCockpitVisibility();
      syncOrbitGuides();
    }

    document.getElementById('hud-toggle')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHud();
    });

    document.getElementById('nav-map-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof isNavTabletOpen === 'function' && isNavTabletOpen()) closeNavTablet();
        else if (typeof openNavTablet === 'function') openNavTablet();
        else if (modeEl) modeEl.textContent = 'Карта ещё загружается…';
      } catch (err) {
        console.error('[nav-map-btn]', err);
        if (modeEl) modeEl.textContent = 'Ошибка карты: ' + (err?.message || err);
      }
    });

    fitAppViewport(true);
    updateOrientGate();
    window.addEventListener('resize', () => {
      updateOrientGate();
      scheduleFitViewport();
    });
    window.addEventListener('orientationchange', () => {
      updateOrientGate();
      hideBrowserChrome();
      scheduleFitViewport();
      // Re-assert landscape + fullscreen after rotate
      setTimeout(() => {
        updateOrientGate();
        if (isTouch && isLandscapeNow()) {
          requestAppFullscreen();
        }
      }, 120);
      setTimeout(updateOrientGate, 400);
    });
    window.visualViewport?.addEventListener('resize', () => {
      updateOrientGate();
      scheduleFitViewport();
    });
    window.visualViewport?.addEventListener('scroll', () => fitAppViewport(true));
    screen.orientation?.addEventListener?.('change', () => {
      updateOrientGate();
      scheduleFitViewport();
      if (isTouch && isLandscapeNow()) requestAppFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
      updateOrientGate();
      scheduleFitViewport();
      if (document.fullscreenElement) hideBrowserChrome();
    });
    document.addEventListener('webkitfullscreenchange', () => {
      updateOrientGate();
      scheduleFitViewport();
    });
    window.addEventListener('pageshow', () => {
      updateOrientGate();
      scheduleFitViewport();
    });

    document.getElementById('orient-fs-btn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await requestAppFullscreen();
      updateOrientGate();
      hideBrowserChrome();
    });

    // First touch: fullscreen + landscape (also hides address bar chrome)
    let mobileImmersiveAsked = false;
    async function ensureMobileImmersive() {
      if (!isTouch) return;
      updateOrientGate();
      if (!isLandscapeNow()) return;
      if (mobileImmersiveAsked && (document.fullscreenElement || document.webkitFullscreenElement)) {
        hideBrowserChrome();
        return;
      }
      mobileImmersiveAsked = true;
      await requestAppFullscreen();
      hideBrowserChrome();
      updateOrientGate();
    }
    window.addEventListener('pointerdown', () => { ensureMobileImmersive(); }, { capture: true, passive: true });
    window.addEventListener('touchstart', () => { ensureMobileImmersive(); }, { capture: true, passive: true });

    // If chrome reappears, keep resizing to visual viewport
    setInterval(() => {
      if (!isTouch) return;
      updateOrientGate();
      if (isLandscapeNow()) fitAppViewport(true);
    }, 1500);

    hint.addEventListener('click', startPlay);
    hint.querySelector('.cta')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startPlay();
    });
    controls.addEventListener('lock', () => {
      flightSession = true;
      hint.classList.add('hidden');
      if (resumeTip) resumeTip.classList.add('hidden');
      if (modeEl && modeEl.textContent === 'Кликните — управление мышью') modeEl.textContent = '';
      unlockEngineAudio();
      syncCockpitVisibility();
    });
    controls.addEventListener('unlock', () => {
      if (cabinExplore) return;
      if (!isTouch && flightSession) {
        hint.classList.add('hidden');
        if (resumeTip) resumeTip.classList.remove('hidden');
      }
    });

    // After wake, first click / key grabs the stick (pointer lock needs a gesture)
    const grabControls = (e) => {
      if (typeof isNavTabletOpen === 'function' && isNavTabletOpen()) return;
      if (document.body.classList.contains('nav-tablet-open')) return;
      if (!flightSession || isTouch) return;
      if (wake && wake.active && (wake.gate || !wake.canControl)) return;
      if (controls.isLocked) return;
      if (e?.target?.closest?.('#hud-toggle, #hint, #wake-veil, #nav-tablet, a, button')) return;
      startPlay();
    };
    window.addEventListener('pointerdown', grabControls);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'F11' || e.code === 'F12') return;
      if (wake?.gate) {
        releaseWakeGate();
        return;
      }
      grabControls(e);
    }, true);

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
      splashAssetP = loaded / needed.length;
      tickSplashBar();
      if (loadStatus) {
        loadStatus.textContent = loaded < needed.length
          ? `Загрузка системы… ${loaded}/${needed.length}`
          : 'Сборка сцены…';
      }
    }

    async function loadAll() {
      const map = {};
      // Fill Cache Storage in parallel with GPU texture decode
      const httpWarm = warmHttpCache();
      await Promise.all(needed.map(async (name) => {
        map[name] = await loadTex(name, true);
        bump();
      }));
      await httpWarm;
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
      spr.userData.isPlanetLabel = true;
      return spr;
    }

    function makeOrbit(radius) {
      const segs = 256;
      const pts = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const dash = Math.max(radius * 0.012, AU * 0.004);
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
        color: 0x4ec8ff,
        transparent: true,
        opacity: 0.34,
        dashSize: dash,
        gapSize: dash * 1.7,
        depthWrite: false,
      }));
      line.computeLineDistances();

      const ghostPts = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        ghostPts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      }
      const ghost = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ghostPts),
        new THREE.LineBasicMaterial({
          color: 0x1a6a99,
          transparent: true,
          opacity: 0.11,
          depthWrite: false,
        })
      );
      const group = new THREE.Group();
      group.add(ghost);
      group.add(line);
      return group;
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

    // Sidereal orbital periods (years) & rotation periods (days, − = retrograde).
    // lon0 = approx. heliocentric ecliptic longitude on 2026-07-15 (J2000 mean elements).
    const PLANETS = [
      {
        name: 'Меркурий', desc: 'Маленькая каменистая планета. Спутников нет.', map: 'mercury.jpg',
        size: EARTH_R * 0.383, au: 0.387, year: 0.2408467, spinDay: 58.646, lon0: 5.4656,
        tilt: 0.034, rough: 0.95, metal: 0.12, landable: true, moons: [],
      },
      {
        name: 'Венера', desc: 'Плотная атмосфера. Спутников нет.', map: 'venus.jpg',
        size: EARTH_R * 0.949, au: 0.723, year: 0.61519726, spinDay: -243.0226, lon0: 3.9973,
        tilt: 3.096, rough: 0.55, metal: 0.02, landable: true, atmo: 0xffd090, moons: [],
      },
      {
        name: 'Земля', desc: 'Наш дом. Спуститесь на поверхность и прогуляйтесь.', map: 'earth.jpg',
        size: EARTH_R, au: 1.0, year: 1.000017, spinDay: 0.99726968, lon0: 5.1050,
        tilt: 0.4091, rough: 0.55, metal: 0.08, landable: true, earth: true, atmo: 0x6eb6ff,
        moons: [
          { name: 'Луна', desc: 'Единственный спутник Земли. Серый кратерированный мир.', size: 0.273, dist: 32, periodDay: 27.321661, color: 0xffffff },
        ],
      },
      {
        name: 'Марс', desc: 'Красные пустыни. Идеальное место для посадки.', map: 'mars.jpg',
        size: EARTH_R * 0.532, au: 1.524, year: 1.8808476, spinDay: 1.02595675, lon0: 0.5955,
        tilt: 0.4396, rough: 0.9, metal: 0.04, landable: true, atmo: 0xc8a090,
        moons: [
          { name: 'Фобос', desc: 'Ближний спутник Марса. Неправильная форма, много кратеров.', size: 0.08, dist: 5.5, periodDay: 0.31891, color: 0xc4a882 },
          { name: 'Деймос', desc: 'Дальний маленький спутник Марса.', size: 0.055, dist: 9.0, periodDay: 1.26244, color: 0xb09a7a },
        ],
      },
      {
        name: 'Юпитер', desc: 'Газовый гигант. Можно «сесть» в верхние слои атмосферы.', map: 'jupiter.jpg',
        size: EARTH_R * 11.21, au: 5.203, year: 11.862615, spinDay: 0.41354, lon0: 2.0881,
        tilt: 0.0546, rough: 0.7, metal: 0.0, landable: true,
        moons: [
          { name: 'Ио', desc: 'Вулканический спутник. Самое активное тело Солнечной системы.', size: 0.286, dist: 4.2, periodDay: 1.769138, color: 0xf0c060 },
          { name: 'Европа', desc: 'Ледяная кора и возможный океан под поверхностью.', size: 0.245, dist: 5.6, periodDay: 3.551181, color: 0xd8e8f0 },
          { name: 'Ганимед', desc: 'Крупнейший спутник в Солнечной системе.', size: 0.413, dist: 7.2, periodDay: 7.154553, color: 0xa89880 },
          { name: 'Каллисто', desc: 'Древняя изрытая кратерами поверхность.', size: 0.378, dist: 9.0, periodDay: 16.68902, color: 0x6a6058 },
        ],
      },
      {
        name: 'Сатурн', desc: 'Сядьте у колец или на облачный слой.', map: 'saturn.jpg',
        size: EARTH_R * 9.45, au: 9.537, year: 29.447498, spinDay: 0.44401, lon0: 0.2456,
        tilt: 0.4665, rough: 0.68, metal: 0.0, landable: true, rings: true,
        moons: [
          { name: 'Титан', desc: 'Самый крупный спутник Сатурна. Плотная атмосфера и озёра метана.', size: 0.404, dist: 6.5, periodDay: 15.945, color: 0xd4a060 },
          { name: 'Рея', desc: 'Ледяной спутник с яркой поверхностью.', size: 0.12, dist: 4.8, periodDay: 4.518212, color: 0xe8e4dc },
          { name: 'Энцелад', desc: 'Свежий лёд и гейзеры из-под коры.', size: 0.09, dist: 3.8, periodDay: 1.370218, color: 0xf2f6ff },
          { name: 'Япет', desc: 'Двухцветный спутник — светлая и тёмная половины.', size: 0.115, dist: 8.5, periodDay: 79.3215, color: 0x9a9080 },
        ],
      },
      {
        name: 'Уран', desc: 'Ледяной гигант. Посадка на верхнюю атмосферу.', map: 'uranus.jpg',
        size: EARTH_R * 4.01, au: 19.19, year: 84.016846, spinDay: -0.71833, lon0: 1.1768,
        tilt: 1.706, rough: 0.42, metal: 0.02, landable: true, atmo: 0xa8fff4,
        moons: [
          { name: 'Титания', desc: 'Крупнейший спутник Урана.', size: 0.124, dist: 5.0, periodDay: 8.706234, color: 0xc8d0d8 },
          { name: 'Оберон', desc: 'Дальний спутник Урана с тёмными кратерами.', size: 0.119, dist: 6.5, periodDay: 13.463234, color: 0x9aa0a8 },
          { name: 'Ариэль', desc: 'Яркий ледяной спутник с каньонами.', size: 0.09, dist: 3.8, periodDay: 2.520379, color: 0xdce4ea },
        ],
      },
      {
        name: 'Нептун', desc: 'Самая дальняя планета. Можно приземлиться на атмосферу.', map: 'neptune.jpg',
        size: EARTH_R * 3.88, au: 30.07, year: 164.79132, spinDay: 0.67125, lon0: 0.0378,
        tilt: 0.4943, rough: 0.45, metal: 0.03, landable: true, atmo: 0x5a8cff,
        moons: [
          { name: 'Тритон', desc: 'Крупный спутник Нептуна. Ретроградная орбита и гейзеры азота.', size: 0.212, dist: 5.5, periodDay: -5.876854, color: 0xc8d8e0 },
          { name: 'Протей', desc: 'Крупный внутренний спутник Нептуна неправильной формы.', size: 0.07, dist: 3.8, periodDay: 1.122315, color: 0x889098 },
        ],
      },
    ];

    PLANETS.forEach((p) => { p.dist = AU * p.au; });

    // Visual time base: Earth orbital & diurnal motion stay readable; ratios stay astronomical.
    // Accelerated vs real years, but kept slower so planets don't streak past the windshield.
    // At timeScale 0.25 → Earth orbit ≈ 18–20 мин на виток (was ~7 мин).
    const ORBIT_EARTH_OMEGA = 0.022;
    const SPIN_EARTH_OMEGA = 0.32;
    const MOON_REF_DAY = 27.321661;
    const MOON_OMEGA = 0.35; // Moon's angular rate when periodDay = MOON_REF_DAY

    const bodies = [];
    let asteroids;
    let sunMat;

    const maps = await loadAll();

    // Fix seams on all planet + sun maps
    maps['sun.jpg'] = fixSeam(maps['sun.jpg'], 40);
    for (const key of ['mercury.jpg', 'venus.jpg', 'earth.jpg', 'mars.jpg', 'jupiter.jpg', 'saturn.jpg', 'uranus.jpg', 'neptune.jpg', 'moon.jpg', 'earth_clouds.jpg']) {
      maps[key] = fixSeam(maps[key], 18);
    }

    // Upload textures to GPU once during loading screen (avoids hitch on first glance)
    for (const tex of Object.values(maps)) {
      try { if (tex && renderer.initTexture) renderer.initTexture(tex); } catch (_) {}
    }
    try { if (starMap && renderer.initTexture) renderer.initTexture(starMap); } catch (_) {}

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
    scene.add(addStars(18000, STAR_R, 2.0, 0xffffff, false, 0.08));
    scene.add(addStars(9000, STAR_R * 0.95, 2.4, 0xd0e4ff, false, 0.1));
    scene.add(addStars(4000, STAR_R * 0.9, 2.8, 0xffe8c0, false, 0.12));
    scene.add(addStars(3000, AU * 55, 2.2, 0xffffff, false, 0.35));
    scene.add(addStars(1500, AU * 75, 2.6, 0xe8f0ff, false, 0.3));

    // Sun
    const sunGroup = new THREE.Group();
    scene.add(sunGroup);
    sunMat = makeSunMaterial(maps['sun.jpg']);
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 48, 48), sunMat);
    sunGroup.add(sunMesh);

    sunGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R * 1.06, 32, 32),
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
      new THREE.SphereGeometry(SUN_R * 1.18, 24, 24),
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

    orbitGroup = new THREE.Group();
    orbitGroup.name = 'orbitGuides';
    scene.add(orbitGroup);
    // Start hidden until HUD is on (sync after intro / toggle)
    orbitGroup.visible = false;

    PLANETS.forEach((p, index) => {
      orbitGroup.add(makeOrbit(p.dist));
      const pivot = new THREE.Object3D();
      scene.add(pivot);

      const envI = p.rough < 0.5 ? 0.28 : (p.size > EARTH_R * 3 ? 0.18 : 0.1);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(p.size, 48, 48),
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
          new THREE.SphereGeometry(p.size * 1.015, 32, 32),
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
      // Sibling of planet mesh: planet "wow" scale must not shove moons outward
      const moonRoot = new THREE.Object3D();
      moonRoot.position.copy(mesh.position);
      moonRoot.rotation.z = p.tilt;
      pivot.add(moonRoot);

      (p.moons || []).forEach((mDef, mi) => {
        const mSize = EARTH_R * mDef.size;
        const orbitR = p.size * mDef.dist + mSize;
        const moonMesh = new THREE.Mesh(
          new THREE.SphereGeometry(mSize, 24, 24),
          new THREE.MeshStandardMaterial({
            map: maps['moon.jpg'],
            color: mDef.color,
            roughness: 0.92,
            metalness: 0.02,
            envMapIntensity: 0.18,
          })
        );
        const phase = (mi / Math.max(1, p.moons.length)) * Math.PI * 2;
        const periodDay = mDef.periodDay || 27.32;
        const orbitSpeed = MOON_OMEGA * (MOON_REF_DAY / periodDay);
        moonMesh.position.set(Math.cos(phase) * orbitR, mSize * 0.15, Math.sin(phase) * orbitR);
        moonMesh.userData = {
          name: mDef.name,
          desc: mDef.desc,
          landable: true,
          isMoon: true,
          size: mSize,
          orbitR,
          orbitSpeed,
          angle: phase,
          periodDay,
        };
        moonRoot.add(moonMesh);

        const mLabel = makeLabel(mDef.name);
        mLabel.scale.set(EARTH_R * 1.6, EARTH_R * 0.4, 1);
        mLabel.position.y = mSize + EARTH_R * 0.45;
        moonMesh.add(mLabel);
        moonMesh.userData.label = mLabel;

        moons.push(moonMesh);
      });

      const label = makeLabel(p.name);
      label.position.y = p.size + EARTH_R * 1.2;
      mesh.add(label);

      // Keplerian mean motion & sidereal day (ratios to Earth); lon0 = sky as of 2026-07-15
      const orbitRate = 1 / Math.max(1e-6, p.year);
      const spinRate = 1 / p.spinDay; // negative days → retrograde spin
      const angle0 = p.lon0 ?? 0;

      bodies.push({
        pivot, mesh, moons, moonRoot,
        speed: orbitRate,
        spin: spinRate,
        angle: angle0,
        data: p,
        scale: 1,
        targetScale: 1,
        atmoColor,
        inAtmo: false,
        label,
      });
      pivot.rotation.y = angle0;
    });

    // Start near Earth in open space (outside atmosphere entry bubble size*9)
    {
      const earth = bodies.find((b) => b.data.earth);
      if (earth) {
        earth.mesh.updateMatrixWorld(true);
        const wp = new THREE.Vector3();
        earth.mesh.getWorldPosition(wp);
        const approach = wp.clone().normalize().multiplyScalar(earth.data.size * 45);
        ship.position.copy(wp).add(approach);
        orientShipToward(wp);
        headPitch = 0;
        headYaw = 0;
        head.rotation.set(0, 0, 0);
        head.position.copy(SEAT_HEAD);
        camera.position.copy(CAM_EYE);
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
        size: EARTH_R * 0.045,
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
    // Space: no drag. W +50/s from 100 → max 50000; S/X brake −1000/s
    let baseSpeed = 100;
    const SPEED_START = 100;
    const SPEED_ACCEL = 50;
    const SPEED_BOOST_MULT = 3;
    const SPEED_MAX = 50000;
    const SPEED_BRAKE = 1000;
    const SPEED_CRUISE = 1800; // world/orbit layout reference (not a flight cap)
    const SPEED_BOOST = SPEED_MAX;
    const SPEED_NORMAL = SPEED_CRUISE;
    const timeScale = 0.25; // fixed orbit pace
    let nearestPlanet = null;
    let landed = null;
    let verticalVel = 0;
    let focusedBody = null; // planet currently enlarged / approach zone
    let takeoffCooldown = 0;
    let hudSpeed = 100;
    const takeoffNormal = new THREE.Vector3(0, 1, 0);
    const lastFocusedWorld = new THREE.Vector3();
    let hasLastFocusedWorld = false;

    const hyperTmp = new THREE.Vector3();
    const hyperLookQ = new THREE.Quaternion();
    const hyperFromQ = new THREE.Quaternion();
    const hyperLookM = new THREE.Matrix4();
    const HYPER_PREP = 10;   // spool + charge before jump
    const HYPER_TRAVEL = 5;  // in-warp flight duration
    const HYPER_ALIGN_DOT = 0.988; // ~9° — then auto-start prep

    const PLANET_MAP_COLORS = {
      'Меркурий': '#c4b09a',
      'Венера': '#e8c878',
      'Земля': '#4aa6ff',
      'Марс': '#e07050',
      'Юпитер': '#d4a878',
      'Сатурн': '#e8d4a0',
      'Уран': '#7ec8d8',
      'Нептун': '#4060e0',
    };

    function planetMapColor(name) {
      return PLANET_MAP_COLORS[name] || '#7ec8ff';
    }

    const warpSfx = {
      buffer: null,
      source: null,
      gain: null,
    };

    async function loadWarpBuffer() {
      if (warpSfx.buffer) return warpSfx.buffer;
      await unlockEngineAudio();
      const res = await fetch(`${SND}warp.flac`, { credentials: 'same-origin' });
      const raw = await res.arrayBuffer();
      warpSfx.buffer = await engineAudio.ctx.decodeAudioData(raw.slice(0));
      return warpSfx.buffer;
    }

    async function startWarpSfx() {
      try {
        await unlockEngineAudio();
        await loadWarpBuffer();
        stopWarpSfx(true);
        const g = engineAudio.ctx.createGain();
        g.gain.value = 0;
        g.connect(engineAudio.ctx.destination);
        const src = engineAudio.ctx.createBufferSource();
        src.buffer = warpSfx.buffer;
        src.loop = true;
        const d = warpSfx.buffer.duration;
        src.loopStart = Math.min(0.15, d * 0.02);
        src.loopEnd = Math.max(src.loopStart + 0.5, d - 0.12);
        src.connect(g);
        src.start(0);
        warpSfx.source = src;
        warpSfx.gain = g;
        // Quiet fade-in
        const now = engineAudio.ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.09, now + 1.6);
      } catch (err) {
        console.warn('[Solar] warp sfx', err);
      }
    }

    function stopWarpSfx(immediate) {
      try {
        if (warpSfx.gain && engineAudio.ctx && !immediate) {
          const now = engineAudio.ctx.currentTime;
          warpSfx.gain.gain.cancelScheduledValues(now);
          warpSfx.gain.gain.setValueAtTime(warpSfx.gain.gain.value, now);
          warpSfx.gain.gain.linearRampToValueAtTime(0, now + 0.55);
          const src = warpSfx.source;
          setTimeout(() => {
            try { src?.stop(); } catch (_) {}
          }, 600);
        } else {
          try { warpSfx.source?.stop(); } catch (_) {}
        }
      } catch (_) {}
      warpSfx.source = null;
      warpSfx.gain = null;
    }

    function enterHyperAim() {
      closeNavTablet();
      hyper.phase = 'aim';
      hyper.age = 0;
      hyper.target = null;
      document.body.classList.add('hyper-aim');
      document.body.classList.remove('hyper-aim-hot', 'hyper-align');
      syncAltReticle();
      if (modeEl) modeEl.textContent = 'ГИПЕРПРИВОД · наведите на планету · ЛКМ/F — прыжок · Esc — отмена · M — карта';
    }

    function getHyperAimTarget() {
      if (!bodies.length) return null;
      pointerNdc.set(0, 0);
      btnRaycaster.setFromCamera(pointerNdc, camera);
      const meshes = bodies.map((b) => b.mesh);
      const hits = btnRaycaster.intersectObjects(meshes, false);
      if (hits[0]) {
        const hit = hits[0].object;
        return bodies.find((b) => b.mesh === hit) || null;
      }
      // Cone fallback: most aligned planet ahead of camera
      camera.getWorldDirection(hyper.look);
      let best = null;
      let bestDot = 0.72;
      for (const b of bodies) {
        b.mesh.getWorldPosition(tmpWorld);
        hyperTmp.copy(tmpWorld).sub(ship.position).normalize();
        const d = hyper.look.dot(hyperTmp);
        if (d > bestDot) {
          bestDot = d;
          best = b;
        }
      }
      return best;
    }

    function setHyperDestination(body) {
      body.mesh.getWorldPosition(tmpWorld);
      // Park farther out — high approach, not kissing the surface
      const stopR = Math.max(body.data.size * 40, effectiveRadius(body) * 4.5);
      hyperTmp.copy(ship.position).sub(tmpWorld);
      if (hyperTmp.lengthSq() < 1e-6) hyperTmp.set(0, 0, 1);
      hyperTmp.normalize();
      hyper.dest.copy(tmpWorld).addScaledVector(hyperTmp, stopR);
      hyper.target = body;
    }

    /** Auto-turn toward planet, then spool warp */
    function beginHyperAlign(body) {
      if (!body || !isShipPowered() || landed) return false;
      if (isWalkingInCabin || seatAnim) {
        if (modeEl) modeEl.textContent = 'Гиперпривод только из кресла в полёте';
        return false;
      }
      if (hyper.phase === 'prep' || hyper.phase === 'travel' || hyper.phase === 'align') return false;
      closeNavTablet();
      setHyperDestination(body);
      hyper.phase = 'align';
      hyper.age = 0;
      document.body.classList.remove('hyper-aim', 'hyper-aim-hot', 'hyper-prep', 'hyper-travel', 'warping');
      document.body.classList.add('hyper-align');
      syncAltReticle();
      velocity.set(0, 0, 0);
      angVel.set(0, 0, 0);
      if (modeEl) {
        modeEl.textContent = `НАВЕДЕНИЕ → ${body.data.name} · корабль поворачивается…`;
      }
      return true;
    }

    function beginHyperPrep(body) {
      if (!body || !isShipPowered() || landed) return;
      setHyperDestination(body);
      hyper.phase = 'prep';
      hyper.age = 0;
      document.body.classList.remove('hyper-aim', 'hyper-aim-hot', 'hyper-align');
      document.body.classList.add('hyper-prep');
      syncAltReticle();
      velocity.set(0, 0, 0);
      startWarpSfx();
      if (modeEl) {
        modeEl.textContent = `ПОДГОТОВКА ВАРПА → ${body.data.name} · 10с · S — отмена`;
      }
    }

    function beginHyperTravel() {
      hyper.phase = 'travel';
      hyper.age = 0;
      hyperCharge = 0;
      hyper.origin.copy(ship.position);
      // Refresh dest in case planet moved during the long prep
      if (hyper.target) setHyperDestination(hyper.target);
      // Face destination with the nose (−Z), not Object3D.lookAt (+Z = stern)
      orientShipToward(hyper.dest);
      document.body.classList.remove('hyper-prep');
      document.body.classList.add('hyper-travel', 'warping');
      if (modeEl) {
        modeEl.textContent = `ВАРП → ${hyper.target?.data?.name || '…'} · 5с · S — выйти`;
      }
    }

    function finishHyperArrive() {
      const body = hyper.target;
      ship.position.copy(hyper.dest);
      if (body) {
        body.mesh.getWorldPosition(tmpWorld);
        orientShipToward(tmpWorld);
        focusedBody = body;
        body.inAtmo = true;
        if (typeof prepareOrbitWorld === 'function') prepareOrbitWorld(body, { parkFar: true });
      }
      velocity.set(0, 0, 0);
      angVel.set(0, 0, 0);
      cancelHyper(false);
      if (modeEl) {
        modeEl.textContent = body
          ? `Выход из варпа · орбита ${body.data.name}`
          : 'Выход из варпа';
      }
      setTimeout(() => {
        if (modeEl && modeEl.textContent.includes('Выход из варпа')) modeEl.textContent = '';
      }, 1600);
    }

    function cancelHyper(silent) {
      const wasTravel = hyper.phase === 'travel' || hyper.phase === 'prep' || hyper.phase === 'align';
      hyper.phase = null;
      hyper.age = 0;
      hyper.target = null;
      hyperCharge = 0;
      document.body.classList.remove(
        'hyper-aim', 'hyper-aim-hot', 'hyper-align', 'hyper-prep', 'hyper-travel', 'warping'
      );
      syncAltReticle();
      stopWarpSfx(false);
      if (!silent && wasTravel && modeEl && !modeEl.textContent.includes('Выход')) {
        modeEl.textContent = 'Варп отменён';
        setTimeout(() => {
          if (modeEl && modeEl.textContent === 'Варп отменён') modeEl.textContent = '';
        }, 1200);
      }
    }

    function tryConfirmHyperJump() {
      if (hyper.phase !== 'aim') return false;
      const body = getHyperAimTarget() || hyper.target;
      if (!body) {
        if (modeEl) modeEl.textContent = 'Нет цели · наведите прицел на планету';
        return true;
      }
      beginHyperAlign(body);
      return true;
    }

    function updateHyperDrive(dt) {
      if (!hyper.phase) return;

      if (hyper.phase === 'aim') {
        const body = getHyperAimTarget();
        hyper.target = body;
        if (body && modeEl) {
          modeEl.textContent = `ГИПЕР · цель: ${body.data.name} · ЛКМ/F — прыжок · Esc — отмена`;
        } else if (modeEl && !modeEl.textContent.includes('Нет цели')) {
          modeEl.textContent = 'ГИПЕРПРИВОД · наведите на планету · ЛКМ/F — прыжок · Esc — отмена · M — карта';
        }
        document.body.classList.toggle('hyper-aim-hot', !!body);
        syncAltReticle();
        return;
      }

      if (keys.KeyS) {
        cancelHyper(false);
        keys.KeyS = false;
        return;
      }

      if (hyper.phase === 'align') {
        const body = hyper.target;
        if (!body) {
          cancelHyper(true);
          return;
        }
        body.mesh.getWorldPosition(tmpWorld);
        // Slerp nose (−Z) toward the planet
        hyperFromQ.copy(ship.quaternion);
        getOrientShipTowardQuat(tmpWorld, hyperLookQ);
        ship.quaternion.copy(hyperFromQ).slerp(hyperLookQ, 1 - Math.exp(-3.6 * dt));
        getShipForward(hyper.look);
        hyperTmp.copy(tmpWorld).sub(ship.position).normalize();
        const aligned = hyper.look.dot(hyperTmp);
        hyper.age += dt;
        if (modeEl) {
          const pct = Math.round(THREE.MathUtils.clamp((aligned - 0.5) / 0.5, 0, 1) * 100);
          modeEl.textContent = `НАВЕДЕНИЕ → ${body.data.name} · ${pct}% · S — отмена`;
        }
        velocity.multiplyScalar(Math.exp(-4 * dt));
        angVel.multiplyScalar(Math.exp(-5 * dt));
        // Failsafe timeout or good lock
        if (aligned >= HYPER_ALIGN_DOT || hyper.age > 4.5) {
          beginHyperPrep(body);
        }
        return;
      }

      if (hyper.phase === 'prep') {
        hyper.age += dt;
        const u = THREE.MathUtils.clamp(hyper.age / HYPER_PREP, 0, 1);
        hyperCharge = u * u * (3 - 2 * u);
        const left = Math.max(0, Math.ceil(HYPER_PREP - hyper.age));
        if (modeEl && hyper.target) {
          modeEl.textContent = `ПОДГОТОВКА ВАРПА → ${hyper.target.data.name} · ${left}с · S — отмена`;
        }
        velocity.multiplyScalar(Math.exp(-3 * dt));
        if (u >= 1) beginHyperTravel();
        return;
      }

      if (hyper.phase === 'travel') {
        hyperCharge = 0;
        hyper.age += dt;
        const u = THREE.MathUtils.clamp(hyper.age / HYPER_TRAVEL, 0, 1);
        const ease = u * u * (3 - 2 * u);
        ship.position.lerpVectors(hyper.origin, hyper.dest, ease);
        orientShipToward(hyper.dest);
        const jumpSpd = hyper.origin.distanceTo(hyper.dest) / Math.max(0.001, HYPER_TRAVEL);
        velocity.copy(hyper.dest).sub(hyper.origin).normalize().multiplyScalar(jumpSpd * 0.2);
        hudSpeed = Math.round(jumpSpd);
        const left = Math.max(0, Math.ceil(HYPER_TRAVEL - hyper.age));
        if (modeEl) {
          modeEl.textContent = `ВАРП → ${hyper.target?.data?.name || '…'} · ${left}с · S — выйти`;
        }
        if (u >= 1) finishHyperArrive();
      }
    }

    // ——— Nav tablet: full system map + warp pick ———
    function initNavTablet() {
      navTablet.el = document.getElementById('nav-tablet');
      navTablet.canvas = document.getElementById('nav-map-canvas');
      navTablet.listEl = document.getElementById('nav-planet-list');
      navTablet.selName = document.querySelector('#nav-selection .nav-sel-name');
      navTablet.selMeta = document.querySelector('#nav-selection .nav-sel-meta');
      navTablet.selDesc = document.querySelector('#nav-selection .nav-sel-desc');
      navTablet.warpBtn = document.getElementById('nav-warp-btn');
      const closeBtn = document.getElementById('nav-tablet-close');
      if (!navTablet.el || !navTablet.canvas) return;
      navTablet.ctx = navTablet.canvas.getContext('2d');
      navTablet.ready = true;

      closeBtn?.addEventListener('click', () => closeNavTablet());
      navTablet.warpBtn?.addEventListener('click', () => {
        if (!navTablet.selected) return;
        beginHyperAlign(navTablet.selected);
      });

      navTablet.canvas.addEventListener('click', (e) => {
        const rect = navTablet.canvas.getBoundingClientRect();
        const sx = navTablet.canvas.width / rect.width;
        const sy = navTablet.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;
        let best = null;
        let bestD = 28;
        for (const h of navTablet.hits) {
          const d = Math.hypot(h.x - x, h.y - y);
          if (d < bestD) {
            bestD = d;
            best = h.body;
          }
        }
        if (best) selectNavPlanet(best);
      });
    }

    function rebuildNavPlanetList() {
      if (!navTablet.listEl || !bodies.length) return;
      navTablet.listEl.innerHTML = '';
      const wp = new THREE.Vector3();
      for (const b of bodies) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-planet-item';
        btn.dataset.name = b.data.name;
        b.mesh.getWorldPosition(wp);
        const dist = formatNavDist(ship.position.distanceTo(wp));
        btn.innerHTML = `<span class="nav-planet-dot" style="background:${planetMapColor(b.data.name)}"></span>`
          + `<span>${b.data.name}</span><span class="nav-planet-dist">${dist}</span>`;
        btn.addEventListener('click', () => selectNavPlanet(b));
        navTablet.listEl.appendChild(btn);
      }
    }

    function selectNavPlanet(body) {
      navTablet.selected = body;
      if (navTablet.selName) navTablet.selName.textContent = body.data.name;
      body.mesh.getWorldPosition(tmpWorld);
      const dist = ship.position.distanceTo(tmpWorld);
      if (navTablet.selMeta) {
        navTablet.selMeta.textContent = `${formatNavDist(dist)} · ${body.data.au.toFixed(2)} AU от Солнца`
          + (body.data.landable ? ' · высадка' : '');
      }
      if (navTablet.selDesc) navTablet.selDesc.textContent = body.data.desc || '';
      if (navTablet.warpBtn) navTablet.warpBtn.disabled = false;
      navTablet.listEl?.querySelectorAll('.nav-planet-item').forEach((el) => {
        el.classList.toggle('selected', el.dataset.name === body.data.name);
      });
      paintNavTablet();
    }

    function openNavTablet() {
      if (!navTablet.el) initNavTablet();
      if (!navTablet.el) {
        if (modeEl) modeEl.textContent = 'Планшет не найден в DOM';
        console.warn('[nav-tablet] #nav-tablet missing');
        return;
      }
      // Allow as soon as the session started (no need for pointer lock)
      if (landed) {
        if (modeEl) modeEl.textContent = 'Планшет недоступен на поверхности';
        return;
      }
      if (!flightSession && !mobilePlaying && !controls.isLocked) {
        if (modeEl) modeEl.textContent = 'Сначала возьмите штурвал';
        return;
      }
      if (!navTablet.ready) initNavTablet();
      if (!navTablet.ready) {
        if (modeEl) modeEl.textContent = 'Карта ещё загружается…';
        return;
      }
      if (!isShipPowered()) {
        if (modeEl) modeEl.textContent = 'Нет питания · PWR';
        return;
      }
      if (hyper.phase === 'prep' || hyper.phase === 'travel' || hyper.phase === 'align') {
        if (modeEl) modeEl.textContent = 'Сначала завершите или отмените варп (S)';
        return;
      }
      if (hyper.phase === 'aim') cancelHyper(true);

      navTablet.open = true;
      document.body.classList.add('nav-tablet-open');
      navTablet.el.classList.remove('hidden');
      navTablet.el.setAttribute('aria-hidden', 'false');
      // Show UI first, then release mouse so the tablet is clickable
      requestAnimationFrame(() => {
        try { if (controls.isLocked) controls.unlock(); } catch (_) {}
      });

      try {
        rebuildNavPlanetList();
        if (navTablet.selected) selectNavPlanet(navTablet.selected);
        else {
          let prefer = bodies.find((b) => b.data.earth) || bodies[0];
          let bestD = Infinity;
          const wp = new THREE.Vector3();
          for (const b of bodies) {
            b.mesh.getWorldPosition(wp);
            const d = ship.position.distanceTo(wp);
            if (d < bestD) { bestD = d; prefer = b; }
          }
          if (prefer) selectNavPlanet(prefer);
        }
        paintNavTablet();
      } catch (err) {
        console.error('[nav-tablet] paint', err);
      }
      if (modeEl) modeEl.textContent = 'ПЛАНШЕТ · выберите планету · ВАРП К ОРБИТЕ';
    }

    function closeNavTablet() {
      if (!navTablet.open && !document.body.classList.contains('nav-tablet-open')) return;
      navTablet.open = false;
      document.body.classList.remove('nav-tablet-open');
      navTablet.el?.classList.add('hidden');
      navTablet.el?.setAttribute('aria-hidden', 'true');
      if (modeEl && modeEl.textContent.includes('ПЛАНШЕТ')) modeEl.textContent = '';
    }

    function isNavTabletOpen() {
      return !!navTablet.open;
    }

    /**
     * Shared solar-system map painter (cockpit screen + tablet).
     * opts: { interactive, selected, showLabels, fillHits }
     */
    function drawSolarSystemMap(ctx, w, h, opts = {}) {
      const interactive = !!opts.interactive;
      const selected = opts.selected || null;
      const showLabels = opts.showLabels !== false;
      const fillHits = opts.fillHits !== false && interactive;

      ctx.fillStyle = '#02060e';
      ctx.fillRect(0, 0, w, h);

      // Atmosphere vignette
      const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.1, w * 0.5, h * 0.5, h * 0.72);
      vg.addColorStop(0, 'rgba(20, 50, 90, 0.25)');
      vg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      // Star dust
      ctx.fillStyle = 'rgba(180,210,255,0.35)';
      for (let i = 0; i < 48; i++) {
        const sx = ((i * 97) % w);
        const sy = ((i * 53 + 17) % h);
        ctx.fillRect(sx, sy, (i % 5 === 0) ? 2 : 1, 1);
      }

      const cx = w * 0.5;
      const cy = h * 0.52;
      const shipX = ship.position.x;
      const shipZ = ship.position.z;

      let maxR = AU * 0.55;
      const positions = [];
      for (const b of bodies) {
        b.mesh.getWorldPosition(tmpWorld);
        positions.push({ body: b, x: tmpWorld.x, z: tmpWorld.z });
        maxR = Math.max(maxR, Math.hypot(tmpWorld.x, tmpWorld.z));
      }
      maxR = Math.max(maxR, Math.hypot(shipX, shipZ) * 1.12, AU * 0.4);
      const pad = interactive ? 0.42 : 0.38;
      const scale = (Math.min(w, h) * pad) / maxR;

      // AU rings
      ctx.strokeStyle = 'rgba(80, 140, 220, 0.14)';
      ctx.lineWidth = 1;
      for (let au = 1; au <= 30; au *= 2) {
        const r = au * AU * scale;
        if (r > Math.min(w, h) * 0.48) break;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Real planet orbits
      for (const p of positions) {
        const r = Math.hypot(p.x, p.z) * scale;
        if (r < 4 || r > Math.min(w, h) * 0.48) continue;
        const isSel = selected === p.body;
        ctx.strokeStyle = isSel ? 'rgba(255, 210, 100, 0.45)' : 'rgba(90, 160, 220, 0.22)';
        ctx.lineWidth = isSel ? 1.6 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Sun
      const sunGlow = ctx.createRadialGradient(cx, cy, 2, cx, cy, interactive ? 22 : 14);
      sunGlow.addColorStop(0, '#fff0c0');
      sunGlow.addColorStop(0.35, '#ffaa33');
      sunGlow.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = sunGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, interactive ? 22 : 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffcc55';
      ctx.beginPath();
      ctx.arc(cx, cy, interactive ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();

      if (fillHits) navTablet.hits.length = 0;

      // Planets
      for (const p of positions) {
        const px = cx + p.x * scale;
        const py = cy + p.z * scale;
        if (px < 4 || px > w - 4 || py < 4 || py > h - 4) continue;
        const isSel = selected === p.body;
        const isNear = focusedBody === p.body || nearestPlanet === p.body;
        const col = planetMapColor(p.body.data.name);
        const rad = isSel ? (interactive ? 9 : 6) : (interactive ? 6 : 3.5);

        if (isSel) {
          ctx.strokeStyle = 'rgba(255,224,138,0.55)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, rad + 8, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
        if (isNear && !isSel) {
          ctx.strokeStyle = 'rgba(100,255,180,0.55)';
          ctx.stroke();
        }

        if (showLabels && (isSel || interactive || isNear)) {
          ctx.fillStyle = isSel ? '#ffe8b0' : 'rgba(180,220,255,0.88)';
          ctx.font = `${isSel || interactive ? 'bold 12' : '9'}px monospace`;
          ctx.fillText(p.body.data.name, px + rad + 5, py + 4);
        }

        if (fillHits) {
          navTablet.hits.push({ body: p.body, x: px, y: py, r: rad + 14 });
        }
      }

      // Ship marker (nose = local −Z)
      const sx = cx + shipX * scale;
      const sy = cy + shipZ * scale;
      getShipForward(hyper.look);
      const ang = Math.atan2(hyper.look.x, hyper.look.z);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      ctx.fillStyle = '#33ff88';
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(6, 8);
      ctx.lineTo(-6, 8);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(51,255,136,0.35)';
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(0, -20);
      ctx.stroke();
      ctx.restore();

      // Frame + title
      ctx.strokeStyle = 'rgba(80, 180, 255, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = 'rgba(120, 200, 255, 0.92)';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(interactive ? 'КАРТА СОЛНЕЧНОЙ СИСТЕМЫ' : 'КАРТА СИСТЕМЫ', 12, 18);
      ctx.fillStyle = 'rgba(140, 190, 230, 0.7)';
      ctx.font = '9px monospace';
      ctx.fillText(`SUN ${formatNavDist(ship.position.length())}`, 12, h - 12);
      if (selected) {
        ctx.fillStyle = 'rgba(255, 220, 120, 0.9)';
        ctx.fillText(`ЦЕЛЬ: ${selected.data.name}`, w - 12 - ctx.measureText(`ЦЕЛЬ: ${selected.data.name}`).width, h - 12);
      }
    }

    function paintNavTablet() {
      if (!navTablet.open || !navTablet.ctx || !navTablet.canvas) return;
      const c = navTablet.canvas;
      // Fit canvas to CSS size for sharpness
      const rect = c.getBoundingClientRect();
      const dpr = Math.min(1.25, window.devicePixelRatio || 1);
      const tw = Math.max(320, Math.floor(rect.width * dpr));
      const th = Math.max(240, Math.floor(rect.height * dpr));
      if (c.width !== tw || c.height !== th) {
        c.width = tw;
        c.height = th;
      }
      drawSolarSystemMap(navTablet.ctx, c.width, c.height, {
        interactive: true,
        selected: navTablet.selected,
        showLabels: true,
        fillHits: true,
      });
    }

    // Wire tablet DOM once hyper/nav helpers exist
    initNavTablet();

    const tmpWorld = new THREE.Vector3();
    const tmpNormal = new THREE.Vector3();
    const tmpRight = new THREE.Vector3();
    const tmpForward = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const fogColor = new THREE.Color();

    /** Cruise units/sec — reference for planet orbit/landing world scales */
    function cruiseSpeed() {
      return SPEED_CRUISE;
    }

    /** Scale so orbit / landing are continent-sized worlds */
    function orbitScaleFor(baseRadius) {
      const pathR = (cruiseSpeed() * 18) / (Math.PI * 2);
      return Math.max(80, (pathR / (baseRadius * 1.05)) * 4.5);
    }

    /** Full landing scale — moons are moved out, never block world size */
    function maxPlanetScale(b, _dist) {
      const rocky = b?.data?.landable && b.data.size <= EARTH_R * 2.2;
      return rocky
        ? Math.max(orbitScaleFor(b.data.size), 950)
        : Math.max(orbitScaleFor(b.data.size), 140);
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
            radius: moonMesh.userData.size,
            name: moonMesh.userData.name,
            desc: moonMesh.userData.desc,
            isMoon: true,
          });
        }
      }
      return list;
    }

    // ---- Local procedural terrain (near-surface streaming) ----
    // Space: light sphere. Low altitude: detailed height patch under the ship.
    const terrainTmp = new THREE.Vector3();
    const terrainUp = new THREE.Vector3();
    const terrainRight = new THREE.Vector3();
    const terrainFwd = new THREE.Vector3();
    const terrainHit = new THREE.Vector3();
    const localTerrain = {
      active: false,
      body: null,
      mesh: null,
      geo: null,
      mat: null,
      clouds: null,
      cloudMat: null,
      shell: null,
      shellMat: null,
      anchor: new THREE.Vector3(),
      half: 80,
      segs: 96,
      entryHeat: 0,
    };
    const atmoFogColor = new THREE.Color();
    const atmoFogNeutral = new THREE.Color(0xb8b0a8);
    // Atmosphere FX on canopy glass only — never fullscreen camera overlay
    const atmoFx = {
      active: false,
      depth: 0,
      heat: 0,
      r: 110,
      g: 182,
      b: 255,
    };

    function bodyHasAtmosphere(b) {
      if (!b) return false;
      if (b.data.atmo || b.data.earth) return true;
      const n = b.data.name;
      return n === 'Венера' || n === 'Марс';
    }

    function makeCloudTexture() {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 256;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 256, 256);
      for (let i = 0; i < 48; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        const r = 20 + Math.random() * 55;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.45, 'rgba(230,240,255,0.22)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }

    function hash2(x, y) {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return s - Math.floor(s);
    }
    function smoothNoise2(x, y) {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const ux = fx * fx * (3 - 2 * fx);
      const uy = fy * fy * (3 - 2 * fy);
      const a = hash2(x0, y0);
      const b = hash2(x0 + 1, y0);
      const c = hash2(x0, y0 + 1);
      const d = hash2(x0 + 1, y0 + 1);
      return THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(a, b, ux),
        THREE.MathUtils.lerp(c, d, ux),
        uy
      );
    }
    function fbm2(x, y, oct = 5) {
      let v = 0;
      let a = 0.5;
      let f = 1;
      for (let i = 0; i < oct; i++) {
        v += a * smoothNoise2(x * f, y * f);
        f *= 2;
        a *= 0.5;
      }
      return v;
    }

    function bodySupportsTerrain(b) {
      if (!b?.data?.landable) return false;
      // Gas giants: keep smooth sphere / cloud “surface”
      if (b.data.size > EARTH_R * 2.2) return false;
      return true;
    }

    /** Dramatic height field — mountains / valleys / basins */
    function terrainProfile(body, lon, lat) {
      const seed = (body.data.au || 1) * 19.7 + (body.data.lon0 || 0);
      const name = body.data.name;
      let n = fbm2(lon * 1.35 + seed, lat * 1.35) * 2.4 - 1.05;
      n += (fbm2(lon * 4.2 + 3.1, lat * 4.2) - 0.5) * 0.85;
      n += (fbm2(lon * 14 + 7, lat * 14) - 0.5) * 0.22;

      if (body.data.earth) {
        if (n < 0.05) n = n * 0.35 - 0.08;
        else n = n * 1.15 + 0.12;
        n += Math.max(0, fbm2(lon * 9 + 1, lat * 9) - 0.62) * 0.9;
      } else if (name === 'Марс') {
        n *= 1.35;
        const c = fbm2(lon * 16 + 4, lat * 16);
        if (c > 0.62) n -= (c - 0.62) * 3.8;
        n += Math.max(0, fbm2(lon * 2.2 + seed, lat * 2.2) - 0.55) * 1.4;
      } else if (name === 'Меркурий' || name === 'Венера') {
        n *= 1.1;
        const c = fbm2(lon * 22 + 8, lat * 22);
        if (c > 0.68) n -= (c - 0.68) * 4.5;
      } else {
        const c = fbm2(lon * 18 + 6, lat * 18);
        if (c > 0.66) n -= (c - 0.66) * 3.5;
      }
      // Relief scales with inflated world so mountains stay visible near surface
      const amp = body.data.size * Math.max(1, body.scale) * 0.022;
      return n * amp;
    }

    /** Radial surface distance from planet center (R + height). Fills outNormal. */
    function sampleSurfaceRadius(body, worldPos, outNormal) {
      body.mesh.getWorldPosition(terrainTmp);
      const R = effectiveRadius(body);
      outNormal.copy(worldPos).sub(terrainTmp);
      if (outNormal.lengthSq() < 1e-12) outNormal.set(0, 1, 0);
      else outNormal.normalize();
      if (!bodySupportsTerrain(body)) return R;
      const lon = Math.atan2(outNormal.z, outNormal.x);
      const lat = Math.asin(THREE.MathUtils.clamp(outNormal.y, -1, 1));
      return R + terrainProfile(body, lon, lat);
    }

    function ensureLocalTerrain(body) {
      if (!localTerrain.mesh) {
        localTerrain.geo = new THREE.BufferGeometry();
        localTerrain.mat = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.88,
          metalness: 0.03,
          flatShading: false,
          envMapIntensity: 0.35,
        });
        localTerrain.mesh = new THREE.Mesh(localTerrain.geo, localTerrain.mat);
        localTerrain.mesh.name = 'localTerrain';
        localTerrain.mesh.frustumCulled = false;
        scene.add(localTerrain.mesh);

        localTerrain.cloudMat = new THREE.MeshBasicMaterial({
          map: makeCloudTexture(),
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        localTerrain.clouds = new THREE.Mesh(
          new THREE.SphereGeometry(1, 48, 32),
          localTerrain.cloudMat
        );
        localTerrain.clouds.name = 'localClouds';
        localTerrain.clouds.frustumCulled = false;
        localTerrain.clouds.renderOrder = 1;
        localTerrain.clouds.visible = false;
        scene.add(localTerrain.clouds);

        localTerrain.shellMat = new THREE.MeshBasicMaterial({
          color: 0x6eb6ff,
          transparent: true,
          opacity: 0.14,
          side: THREE.BackSide,
          depthWrite: false,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
        });
        localTerrain.shell = new THREE.Mesh(
          new THREE.SphereGeometry(1, 40, 28),
          localTerrain.shellMat
        );
        localTerrain.shell.name = 'atmoShell';
        localTerrain.shell.frustumCulled = false;
        localTerrain.shell.visible = false;
        scene.add(localTerrain.shell);
      }
      if (localTerrain.body !== body) {
        const tex = maps[body.data.map];
        if (tex) {
          localTerrain.mat.map = tex;
          localTerrain.mat.needsUpdate = true;
        }
        const ac = body.data.atmo || (body.data.earth ? 0x6eb6ff : 0x88aadd);
        localTerrain.shellMat.color.setHex(ac);
        localTerrain.body = body;
      }
      localTerrain.mesh.visible = true;
      localTerrain.active = true;
    }

    function syncAtmoLayers(body, R) {
      if (!localTerrain.shell) return;
      body.mesh.getWorldPosition(terrainTmp);
      const hasAtmo = bodyHasAtmosphere(body);
      localTerrain.shell.visible = hasAtmo;
      localTerrain.clouds.visible = hasAtmo;
      if (!hasAtmo) return;
      localTerrain.shell.position.copy(terrainTmp);
      localTerrain.shell.scale.setScalar(R * 1.09);
      localTerrain.clouds.position.copy(terrainTmp);
      localTerrain.clouds.scale.setScalar(R * 1.038);
      localTerrain.clouds.rotation.y += 0.0004;
      const dens = THREE.MathUtils.clamp(
        1 - (ship.position.distanceTo(terrainTmp) - R) / Math.max(1, R * 0.6),
        0, 1
      );
      localTerrain.cloudMat.opacity = 0.08 + dens * 0.18;
      localTerrain.shellMat.opacity = 0.03 + dens * 0.07;
    }

    function rebuildLocalTerrain(body, anchorWorld) {
      ensureLocalTerrain(body);
      const segs = localTerrain.segs;
      const R = effectiveRadius(body);
      // Patch sized for near-surface flight (not a giant flat slab from orbit)
      const half = THREE.MathUtils.clamp(Math.min(R * 0.12, 14000), 900, 14000);
      localTerrain.half = half;

      body.mesh.getWorldPosition(terrainTmp);
      terrainUp.copy(anchorWorld).sub(terrainTmp);
      if (terrainUp.lengthSq() < 1e-10) terrainUp.set(0, 1, 0);
      else terrainUp.normalize();

      terrainRight.set(-terrainUp.z, 0, terrainUp.x);
      if (terrainRight.lengthSq() < 1e-8) terrainRight.set(1, 0, 0);
      terrainRight.normalize();
      terrainFwd.crossVectors(terrainRight, terrainUp).normalize();
      terrainRight.crossVectors(terrainUp, terrainFwd).normalize();

      const nVert = (segs + 1) * (segs + 1);
      const pos = new Float32Array(nVert * 3);
      const uvs = new Float32Array(nVert * 2);
      const idx = new Uint32Array(segs * segs * 6);
      let vi = 0;
      let ui = 0;
      for (let iz = 0; iz <= segs; iz++) {
        for (let ix = 0; ix <= segs; ix++) {
          const u = ix / segs;
          const v = iz / segs;
          const lx = (u - 0.5) * 2 * half;
          const lz = (v - 0.5) * 2 * half;
          terrainHit
            .copy(terrainUp).multiplyScalar(R)
            .addScaledVector(terrainRight, lx)
            .addScaledVector(terrainFwd, lz)
            .normalize();
          const lon = Math.atan2(terrainHit.z, terrainHit.x);
          const lat = Math.asin(THREE.MathUtils.clamp(terrainHit.y, -1, 1));
          const h = terrainProfile(body, lon, lat);
          const rr = R + h;
          pos[vi++] = terrainTmp.x + terrainHit.x * rr;
          pos[vi++] = terrainTmp.y + terrainHit.y * rr;
          pos[vi++] = terrainTmp.z + terrainHit.z * rr;
          uvs[ui++] = lon / Math.PI * 2 + 0.5;
          uvs[ui++] = lat / Math.PI + 0.5;
        }
      }
      let ii = 0;
      for (let iz = 0; iz < segs; iz++) {
        for (let ix = 0; ix < segs; ix++) {
          const a = iz * (segs + 1) + ix;
          const b = a + 1;
          const c = a + (segs + 1);
          const d = c + 1;
          idx[ii++] = a; idx[ii++] = c; idx[ii++] = b;
          idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
        }
      }
      localTerrain.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      localTerrain.geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      localTerrain.geo.setIndex(new THREE.BufferAttribute(idx, 1));
      localTerrain.geo.computeVertexNormals();
      localTerrain.geo.computeBoundingSphere();
      localTerrain.anchor.copy(anchorWorld);
      localTerrain._lastR = R;
      syncAtmoLayers(body, R);
    }

    function destroyLocalTerrain() {
      if (!localTerrain.active && !localTerrain.mesh) return;
      if (localTerrain.body?.mesh) {
        localTerrain.body.mesh.visible = true;
      }
      if (localTerrain.mesh) localTerrain.mesh.visible = false;
      if (localTerrain.clouds) localTerrain.clouds.visible = false;
      if (localTerrain.shell) localTerrain.shell.visible = false;
      localTerrain.active = false;
      localTerrain.body = null;
      localTerrain.entryHeat = 0;
      document.body.classList.remove('atmo-entry');
    }

    function updateLocalTerrain(dt) {
      const body = focusedBody;
      if (!bodySupportsTerrain(body) || hyper.phase === 'prep' || hyper.phase === 'travel') {
        if (localTerrain.active) destroyLocalTerrain();
        return;
      }

      body.mesh.getWorldPosition(terrainTmp);
      const R = effectiveRadius(body);
      const dist = ship.position.distanceTo(terrainTmp);
      const alt = dist - R;
      // ONLY near the surface — early terrain (high orbit) looks like a floating cube
      const enterAlt = THREE.MathUtils.clamp(R * 0.02, 1800, 9000);
      const exitAlt = enterAlt * 1.9;

      const heatZone = alt < enterAlt * 2.2 && alt > R * 0.01;
      const heatT = heatZone
        ? THREE.MathUtils.clamp(1 - Math.abs(alt / Math.max(enterAlt, 1) - 0.55) / 0.55, 0, 1)
        : 0;
      localTerrain.entryHeat = THREE.MathUtils.damp(localTerrain.entryHeat, heatT, 2.2, dt);
      document.body.classList.toggle('atmo-entry', localTerrain.entryHeat > 0.25);

      if (!localTerrain.active) {
        if (alt < enterAlt || (landed && !landed.isMoon)) {
          rebuildLocalTerrain(body, ship.position);
          // Hide globe only when the patch can cover the view near surface
          body.mesh.visible = false;
          if (modeEl && !landed) {
            modeEl.textContent = `Спуск · ${body.data.name} · рельеф`;
          }
        }
        return;
      }

      if (localTerrain.body !== body) {
        destroyLocalTerrain();
        return;
      }

      if (alt > exitAlt && !landed) {
        destroyLocalTerrain();
        return;
      }

      syncAtmoLayers(body, R);

      const Rnow = effectiveRadius(body);
      if (
        ship.position.distanceToSquared(localTerrain.anchor) > (localTerrain.half * 0.28) ** 2
        || Math.abs(Rnow - (localTerrain._lastR || Rnow)) > Rnow * 0.035
      ) {
        localTerrain._lastR = Rnow;
        rebuildLocalTerrain(body, ship.position);
      }
    }

    function moonOrbitRadius(b, moonMesh) {
      const ud = moonMesh.userData;
      const minR = b.data.size * b.scale * 1.28 + (ud.size || 0) * 2;
      return Math.max(ud.orbitR, minR);
    }

    function placeMoonOnOrbit(b, moonMesh) {
      const ud = moonMesh.userData;
      const r = moonOrbitRadius(b, moonMesh);
      moonMesh.position.x = Math.cos(ud.angle) * r;
      moonMesh.position.z = Math.sin(ud.angle) * r;
    }

    /** Scale mesh only — never move the ship (no “planet push”) */
    function applyPlanetScale(b, newScale) {
      if (Math.abs(newScale - b.scale) < 1e-5) return;
      b.scale = newScale;
      b.mesh.scale.setScalar(newScale);
      for (const moonMesh of b.moons || []) placeMoonOnOrbit(b, moonMesh);
    }

    /**
     * Orbit entry: snap world to full landing size, park ship above surface,
     * prebuild terrain so landing is ready. parkFar = after warp (higher orbit).
     */
    function prepareOrbitWorld(b, opts = {}) {
      const maxOrb = maxPlanetScale(b);
      applyPlanetScale(b, maxOrb);
      b.targetScale = maxOrb;
      b.inAtmo = true;

      b.mesh.getWorldPosition(tmpWorld);
      const R = effectiveRadius(b);
      tmpNormal.copy(ship.position).sub(tmpWorld);
      if (tmpNormal.lengthSq() < 1e-10) tmpNormal.set(0, 1, 0);
      else tmpNormal.normalize();

      // Warp exit sits higher; manual entry parks lower for landing approach
      const approachAlt = opts.parkFar
        ? THREE.MathUtils.clamp(Math.max(b.data.size * 22, R * 0.28), 20000, 140000)
        : THREE.MathUtils.clamp(Math.max(b.data.size * 8, R * 0.08), 6000, 35000);
      ship.position.copy(tmpWorld).addScaledVector(tmpNormal, R + approachAlt);
      const into = velocity.dot(tmpNormal);
      if (into < 0) velocity.addScaledVector(tmpNormal, -into);
      velocity.multiplyScalar(0.55);

      // Keep the spherical planet on orbit — terrain only when low (avoids “cube” silhouette)
      b.mesh.visible = true;
      if (localTerrain.active) destroyLocalTerrain();

      modeEl.textContent = opts.parkFar
        ? `Орбита: ${b.data.name} · выход из варпа · снижайтесь`
        : `Орбита: ${b.data.name} · мир готов · ×${maxOrb.toFixed(0)}`;
      infoName.textContent = b.data.name;
      infoDesc.textContent = b.data.desc + (opts.parkFar
        ? ' Вы на высокой орбите — снижайтесь к атмосфере.'
        : ' Планета круглая на орбите · рельеф появится у поверхности.');
      infoPanel.classList.add('visible');
    }

    function setAtmoVisuals(b, depth01) {
      // Always kill fullscreen camera veil (FX belongs on the ship canopy / HUD glass)
      if (atmoVeil) {
        atmoVeil.classList.remove('active', 'hot');
        atmoVeil.style.opacity = '0';
      }

      if (!b || depth01 < 0.015) {
        scene.fog = null;
        document.body.classList.remove('in-atmosphere', 'atmo-entry');
        atmoFx.active = false;
        atmoFx.depth = 0;
        atmoFx.heat = 0;
        return;
      }
      document.body.classList.add('in-atmosphere');
      const R = effectiveRadius(b);
      const colHex = b.data.atmo || (b.data.earth ? 0x6eb6ff : 0x8899bb);
      atmoFogColor.setHex(colHex);
      atmoFogColor.lerp(atmoFogNeutral, 0.55);
      atmoFx.active = true;
      atmoFx.depth = depth01;
      atmoFx.heat = localTerrain.entryHeat || 0;
      atmoFx.r = (atmoFogColor.r * 255) | 0;
      atmoFx.g = (atmoFogColor.g * 255) | 0;
      atmoFx.b = (atmoFogColor.b * 255) | 0;

      // Barely-there haze (HUD-off look): visible depth cue, not a color filter
      const dens = (0.02 + depth01 * depth01 * 0.18) / Math.max(500, R);
      if (!scene.fog || !scene.fog.isFogExp2) {
        scene.fog = new THREE.FogExp2(atmoFogColor.getHex(), dens);
      } else {
        scene.fog.color.copy(atmoFogColor);
        scene.fog.density = dens;
      }
    }

    function updateAtmosphere(dt) {
      const obj = ship;
      let best = null;
      let bestDist = Infinity;

      for (const b of bodies) {
        b.mesh.getWorldPosition(tmpWorld);
        const dist = obj.position.distanceTo(tmpWorld);
        const entryR = b.data.size * 14;
        // Exit farther than entry to avoid spawn/approach hysteresis flicker
        const exitR = Math.max(effectiveRadius(b) * 2.4, b.data.size * 22);

        if (focusedBody === b) {
          if (dist > exitR && !landed) {
            b.inAtmo = false;
            b.targetScale = 1;
            if (focusedBody === b) focusedBody = null;
          } else {
            b.inAtmo = true;
            // Keep full landing world while in orbit / atmosphere
            b.targetScale = maxPlanetScale(b);
          }
        } else if (dist < entryR && dist < bestDist) {
          best = b;
          bestDist = dist;
        }
      }

      // Enter orbit → instantly build the landable world
      if (!focusedBody && best && !landed) {
        focusedBody = best;
        prepareOrbitWorld(best);
      }

      // Animate scales; only one planet enlarged at a time
      for (const b of bodies) {
        if (b !== focusedBody && b.targetScale !== 1) b.targetScale = 1;
        // Snap up to target (orbit prep); ease down on leave
        const rate = b.targetScale >= b.scale ? 8 : 2.2;
        const next = THREE.MathUtils.damp(b.scale, b.targetScale, rate, dt);
        applyPlanetScale(b, next);
      }

      if (focusedBody) {
        focusedBody.mesh.getWorldPosition(tmpWorld);
        const dist = obj.position.distanceTo(tmpWorld);
        const R = effectiveRadius(focusedBody);
        const depth = THREE.MathUtils.clamp(
          1 - (dist - R) / Math.max(R * 0.35, focusedBody.data.size * 4.5),
          0, 1
        );
        setAtmoVisuals(focusedBody, depth);
        if (!landed) {
          const alt = getSurfaceAltitude(focusedBody, obj.position);
          const phase = localTerrain.active
            ? 'ЛАНДШАФТ'
            : (depth > 0.4 ? 'АТМОСФЕРА' : 'ОРБИТА');
          updateAltitudeHud(focusedBody, alt, phase);
          modeEl.textContent = `${phase}: ${focusedBody.data.name} · ВЫСОТА ${formatAltitude(alt)}`;
        } else {
          updateAltitudeHud(null);
        }
      } else {
        setAtmoVisuals(null, 0);
        updateAltitudeHud(null);
        if (modeEl.textContent.includes('Атмосфер')
          || modeEl.textContent.includes('Вход')
          || modeEl.textContent.includes('ОРБИТА')
          || modeEl.textContent.includes('ЛАНДШАФТ')
          || modeEl.textContent.includes('Спуск')
          || modeEl.textContent.includes('Орбита')
          || modeEl.textContent.includes('ВЫСОТА')) {
          modeEl.textContent = '';
        }
        if (localTerrain.active) destroyLocalTerrain();
      }

      updateLocalTerrain(dt);
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
      velocity.copy(takeoffNormal).multiplyScalar(SPEED_START);

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
      let landR = target.radius;
      if (!target.isMoon && bodySupportsTerrain(target.body)) {
        landR = sampleSurfaceRadius(target.body, obj.position, tmpNormal);
      } else {
        tmpNormal.copy(obj.position).sub(tmpWorld).normalize();
      }
      target.radius = landR;
      obj.position.copy(tmpWorld).addScaledVector(tmpNormal, landR + EYE);
      landed = target;
      focusedBody = target.body;
      verticalVel = 0;
      angVel.set(0, 0, 0);
      lookDelta.x = 0;
      lookDelta.y = 0;
      headPitch = 0;
      headYaw = 0;
      head.rotation.set(0, 0, 0);
      isWalkingInCabin = false;
      seatAnim = null;
      head.position.copy(SEAT_HEAD);
      camera.position.copy(CAM_EYE);
      document.body.classList.remove('cabin-walk');
      document.body.classList.add('landed');
      if (!target.isMoon && bodySupportsTerrain(target.body) && !localTerrain.active) {
        rebuildLocalTerrain(target.body, obj.position);
        target.body.mesh.visible = false;
      }
      syncCockpitVisibility();
      modeEl.textContent = `На поверхности: ${target.name} · F или Пробел — взлёт`;
      infoName.textContent = target.name;
      infoDesc.textContent = target.desc + ' Вы на поверхности!';
      infoPanel.classList.add('visible');
    }

    // While flying: block browser shortcuts (Alt menu, Ctrl+R/S/P/F, Tab, etc.)
    // Keep F11 (fullscreen) and F12 (devtools / console)
    function blockBrowserShortcut(e) {
      if (!isPlaying()) return;
      if (e.code === 'F11' || e.key === 'F11') return;
      if (e.code === 'F12' || e.key === 'F12') return;
      // Keep map / tablet keys usable (and don't stopPropagation — that killed other handlers)
      if (e.code === 'KeyM' || e.code === 'KeyH' || e.code === 'Escape') {
        e.preventDefault();
        return;
      }
      e.preventDefault();
    }

    addEventListener('keydown', (e) => {
      keys[e.code] = true;

      // Map / tablet first — before anything else can swallow the key
      const mapKey = e.code === 'KeyM'
        || e.key === 'm' || e.key === 'M'
        || e.key === 'ь' || e.key === 'Ь';
      if (mapKey) {
        e.preventDefault();
        try {
          if (typeof isNavTabletOpen === 'function' && isNavTabletOpen()) closeNavTablet();
          else if (typeof openNavTablet === 'function') openNavTablet();
        } catch (err) {
          console.error('[nav-tablet]', err);
          if (modeEl) modeEl.textContent = 'Ошибка планшета: ' + (err?.message || err);
        }
        return;
      }

      blockBrowserShortcut(e);

      if ((e.code === 'AltLeft' || e.code === 'AltRight') && isPlaying() && !landed) {
        syncAltReticle();
        return;
      }

      if (e.code === 'KeyF' || e.code === 'Space') {
        if (landed) {
          detachFromPlanet();
          angVel.set(0, 0, 0);
          return;
        }
        // Hyper aim: F confirms jump (do not start cabin walk)
        if (e.code === 'KeyF' && hyper.phase === 'aim') {
          tryConfirmHyperJump();
          return;
        }
        // Alt aim + F = press cockpit button
        if (e.code === 'KeyF' && (keys.AltLeft || keys.AltRight || mobileLookHeld)) {
          if (tryClickCockpitButton()) return;
        }
        if (e.code === 'KeyF' && isPlaying() && !landed) {
          if (typeof isIntroCinematic === 'function' && isIntroCinematic()) return;
          toggleWalkInCabin();
          return;
        }
      }

      if (e.code === 'KeyH') {
        toggleHud();
        return;
      }

      if (e.code === 'Escape' && typeof isNavTabletOpen === 'function' && isNavTabletOpen()) {
        closeNavTablet();
        return;
      }

      if (e.code === 'Escape' && hyper.phase === 'aim') {
        cancelHyper(true);
        if (modeEl) modeEl.textContent = '';
        return;
      }

      if (e.code === 'Escape' && (hyper.phase === 'align')) {
        cancelHyper(true);
        return;
      }

      if (typeof isNavTabletOpen === 'function' && isNavTabletOpen()) {
        // Undo sticky flight keys while tablet owns input
        keys[e.code] = false;
        return;
      }

      if (e.code === 'Escape' && cabinExplore) {
        toggleCabinExplore(false);
      }
    }, true);

    addEventListener('keyup', (e) => {
      keys[e.code] = false;
      blockBrowserShortcut(e);
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        syncAltReticle();
      }
    }, true);

    addEventListener('keypress', blockBrowserShortcut, true);
    addEventListener('help', (e) => { e.preventDefault(); }, true);
    addEventListener('contextmenu', (e) => {
      if (isPlaying()) e.preventDefault();
    }, true);

    // Alt reticle: LMB presses the aimed cockpit button
    // Hyper aim: LMB confirms planet jump
    document.addEventListener('mousedown', (e) => {
      if (landed || !isPlaying()) return;
      if (e.button !== 0) return;
      if (hyper.phase === 'aim') {
        if (tryConfirmHyperJump()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (!(keys.AltLeft || keys.AltRight || mobileLookHeld)) return;
      if (tryClickCockpitButton()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) exploreRmbLook = false;
    });

    // ---- Mobile controls (after game state exists) ----
    {
      const lookState = { id: null, x: 0, y: 0, lastT: 0 };
      const joyKnob = document.getElementById('joy-knob');
      const joyZone = document.getElementById('joy-zone');
      const lookZone = document.getElementById('look-zone');
      const JOY_MAX = 44;
      const JOY_DEAD = 0.1;
      let joyId = null;
      let joyOriginX = 0;
      let joyOriginY = 0;

      function curveAxis(v) {
        const s = Math.sign(v);
        const a = Math.abs(v);
        if (a < JOY_DEAD) return 0;
        const t = (a - JOY_DEAD) / (1 - JOY_DEAD);
        return s * (t * t * (3 - 2 * t));
      }

      function joyUpdate(clientX, clientY) {
        let dx = clientX - joyOriginX;
        let dy = clientY - joyOriginY;
        const len = Math.hypot(dx, dy) || 1;
        const capped = Math.min(len, JOY_MAX);
        dx = (dx / len) * capped;
        dy = (dy / len) * capped;
        if (joyKnob) joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
        mobileMove.x = curveAxis(dx / JOY_MAX);
        mobileMove.z = curveAxis(dy / JOY_MAX);
      // When walking: joy = move, not thrust/brake paint
      if (typeof isWalkingInCabin !== 'undefined' && isWalkingInCabin) {
        joyZone?.classList.toggle('thrust', Math.hypot(mobileMove.x, mobileMove.z) > 0.2);
        joyZone?.classList.remove('brake');
      } else {
        joyZone?.classList.toggle('thrust', mobileMove.z < -0.15);
        joyZone?.classList.toggle('brake', mobileMove.z > 0.15);
      }
      }

      function joyEnd() {
        joyId = null;
        mobileMove.x = 0;
        mobileMove.z = 0;
        if (joyKnob) joyKnob.style.transform = 'translate(0, 0)';
        const base = joyZone?.querySelector('.joy-base');
        if (base) base.style.transform = '';
        joyZone?.classList.remove('thrust', 'brake', 'active');
      }

      joyZone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        joyId = e.pointerId;
        const rect = joyZone.getBoundingClientRect();
        const pad = 28;
        joyOriginX = THREE.MathUtils.clamp(e.clientX, rect.left + pad, rect.right - pad);
        joyOriginY = THREE.MathUtils.clamp(e.clientY, rect.top + pad, rect.bottom - pad);
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const base = joyZone.querySelector('.joy-base');
        if (base) base.style.transform = `translate(${joyOriginX - cx}px, ${joyOriginY - cy}px)`;
        joyZone.classList.add('active');
        try { joyZone.setPointerCapture(e.pointerId); } catch (_) {}
        joyUpdate(e.clientX, e.clientY);
        if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {}
      });
      joyZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== joyId) return;
        e.preventDefault();
        joyUpdate(e.clientX, e.clientY);
      });
      joyZone.addEventListener('pointerup', joyEnd);
      joyZone.addEventListener('pointercancel', joyEnd);

      const LOOK_SENS = 3.6;
      lookZone.addEventListener('pointerdown', (e) => {
        if (!mobilePlaying) return;
        if (e.target.closest?.('.joy-zone, .mob-btns, .mob-btn')) return;
        lookState.id = e.pointerId;
        lookState.x = e.clientX;
        lookState.y = e.clientY;
        lookState.lastT = performance.now();
        mobileLookDragging = true;
        mobileLookVel.x = 0;
        mobileLookVel.y = 0;
        try { lookZone.setPointerCapture(e.pointerId); } catch (_) {}
      });
      lookZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== lookState.id) return;
        const now = performance.now();
        const dtMs = Math.max(8, now - lookState.lastT);
        const dx = e.clientX - lookState.x;
        const dy = e.clientY - lookState.y;
        lookState.x = e.clientX;
        lookState.y = e.clientY;
        lookState.lastT = now;
        lookDelta.x += dx * LOOK_SENS;
        lookDelta.y += dy * LOOK_SENS;
        mobileLookVel.x = THREE.MathUtils.clamp((dx / dtMs) * 16 * LOOK_SENS, -80, 80);
        mobileLookVel.y = THREE.MathUtils.clamp((dy / dtMs) * 16 * LOOK_SENS, -80, 80);
      });
      const lookEnd = () => {
        lookState.id = null;
        mobileLookDragging = false;
        mobileLookVel.x *= 0.55;
        mobileLookVel.y *= 0.55;
      };
      lookZone.addEventListener('pointerup', lookEnd);
      lookZone.addEventListener('pointercancel', lookEnd);

      function bindHold(btn, code) {
        if (!btn) return;
        const on = (e) => {
          e.preventDefault();
          e.stopPropagation();
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
          btn.classList.add('pressed');
          keys[code] = true;
          if (code === 'ShiftLeft') keys.ShiftRight = true;
          if (navigator.vibrate) try { navigator.vibrate(12); } catch (_) {}
        };
        const off = (e) => {
          e.preventDefault();
          e.stopPropagation();
          try { if (btn.hasPointerCapture?.(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch (_) {}
          btn.classList.remove('pressed');
          keys[code] = false;
          if (code === 'ShiftLeft') keys.ShiftRight = false;
        };
        btn.addEventListener('pointerdown', on);
        btn.addEventListener('pointerup', off);
        btn.addEventListener('pointercancel', off);
        btn.addEventListener('lostpointercapture', off);
      }

      bindHold(document.getElementById('btn-up'), 'Space');
      bindHold(document.getElementById('btn-down'), 'ControlLeft');
      bindHold(document.getElementById('btn-boost'), 'ShiftLeft');
      bindHold(document.getElementById('btn-slow'), 'KeyX');
      bindHold(document.getElementById('btn-brake'), 'KeyX');

      {
        const btnLook = document.getElementById('btn-look');
        if (btnLook) {
          let lastLookTap = 0;
          btnLook.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const now = performance.now();
            if (now - lastLookTap < 400) {
              toggleCabinExplore();
              lastLookTap = 0;
              btnLook.classList.toggle('pressed', cabinExplore);
              mobileLookHeld = cabinExplore;
              if (navigator.vibrate) try { navigator.vibrate([10, 40, 10]); } catch (_) {}
              return;
            }
            lastLookTap = now;
            if (!cabinExplore) {
              mobileLookHeld = true;
              btnLook.classList.add('pressed');
              if (modeEl) modeEl.textContent = 'Осмотр · 👁×2 закрепить · F — кнопка';
              if (navigator.vibrate) try { navigator.vibrate(10); } catch (_) {}
            }
          });
          const off = () => {
            if (cabinExplore) return;
            mobileLookHeld = false;
            btnLook.classList.remove('pressed');
            if (modeEl && modeEl.textContent.includes('Осмотр')) modeEl.textContent = '';
          };
          btnLook.addEventListener('pointerup', off);
          btnLook.addEventListener('pointercancel', off);
        }
      }

      document.getElementById('btn-launch').addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (landed) detachFromPlanet();
        else if (focusedBody) {
          focusedBody.mesh.getWorldPosition(tmpWorld);
          takeoffNormal.copy(ship.position).sub(tmpWorld).normalize();
          verticalVel = Math.max(verticalVel, SPEED_NORMAL * 0.5);
        }
        if (navigator.vibrate) try { navigator.vibrate(18); } catch (_) {}
      });

      const btnSeat = document.getElementById('btn-seat');
      if (btnSeat) {
        btnSeat.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof isIntroCinematic === 'function' && isIntroCinematic()) return;
          if (mobileLookHeld && tryClickCockpitButton()) return;
          toggleWalkInCabin();
          if (navigator.vibrate) try { navigator.vibrate(14); } catch (_) {}
        });
        syncMobileSeatBtn();
      }

      document.getElementById('btn-fs').addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        requestAppFullscreen();
      });

      document.addEventListener('gesturestart', (e) => e.preventDefault());
      document.body.addEventListener('touchmove', (e) => {
        if (mobilePlaying) e.preventDefault();
      }, { passive: false });
    }

    const velocity = new THREE.Vector3();

    /** S / X / stick-back — kill speed by rate units per second (no reverse) */
    function applySpaceBrake(dt, rate = SPEED_BRAKE) {
      const spd = velocity.length();
      if (spd < 1e-4) {
        velocity.set(0, 0, 0);
        return;
      }
      const next = Math.max(0, spd - rate * dt);
      if (next < 1e-4) velocity.set(0, 0, 0);
      else velocity.multiplyScalar(next / spd);
    }
    const wishDir = new THREE.Vector3();
    const camRight = new THREE.Vector3();
    const camQuat = new THREE.Quaternion();
    const direction = new THREE.Vector3();
    const clock = new THREE.Clock();

    function updateLanded(dt) {
      const target = landed;
      const obj = ship;
      target.mesh.getWorldPosition(tmpWorld);
      // Follow hills / craters while on the surface
      if (!target.isMoon && bodySupportsTerrain(target.body)) {
        target.radius = sampleSurfaceRadius(target.body, obj.position, tmpNormal);
      } else {
        tmpNormal.copy(obj.position).sub(tmpWorld);
        if (tmpNormal.lengthSq() < 1e-6) tmpNormal.set(0, 1, 0);
        else tmpNormal.normalize();
      }

      // Soft look on surface (yaw around gravity, pitch around local right)
      if (lookDelta.x || lookDelta.y) {
        const lookMul = (isTouch && mobilePlaying) ? 1.55 : 1;
        obj.rotateOnWorldAxis(tmpNormal, -lookDelta.x * 0.0032 * lookMul);
        obj.getWorldDirection(camDir);
        tmpRight.crossVectors(camDir, tmpNormal).normalize();
        if (tmpRight.lengthSq() > 0.2) {
          obj.rotateOnWorldAxis(tmpRight, -lookDelta.y * 0.0028 * lookMul);
        }
        lookDelta.x = 0;
        lookDelta.y = 0;
      }

      obj.position.copy(tmpWorld).addScaledVector(tmpNormal, target.radius + EYE);

      // On surface: no cockpit room, head look reset
      headPitch = THREE.MathUtils.damp(headPitch, 0, 8, dt);
      headYaw = THREE.MathUtils.damp(headYaw, 0, 8, dt);
      head.position.copy(SEAT_HEAD);
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
      // Don't snap to surface while walking / leaving the seat
      if (!landed && takeoffCooldown <= 0 && !isWalkingInCabin && !seatAnim) {
        for (const t of getLandables()) {
          t.mesh.getWorldPosition(tmpWorld);
          let landR = t.radius;
          if (!t.isMoon && bodySupportsTerrain(t.body)) {
            landR = sampleSurfaceRadius(t.body, obj.position, tmpNormal);
            t.radius = landR;
          }
          const dist = obj.position.distanceTo(tmpWorld);
          const surfaceDist = dist - landR;
          if (surfaceDist < EYE + 2 && surfaceDist > -landR * 0.1) {
            tryLand(t);
            break;
          }
        }
      }

      if (landed) {
        landed.radius = landed.isMoon
          ? landed.mesh.userData.size
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

      // During early eye-open: no flight input yet
      if (isWakeBlocking()) {
        lookDelta.x = 0;
        lookDelta.y = 0;
        isThrusting = false;
      }

      let speedCap = SPEED_MAX;
      baseSpeed = SPEED_MAX;

      // Near planet: soft safety cap only when close to surface (landing)
      if (focusedBody && takeoffCooldown <= 0 && hyper.phase !== 'travel' && hyper.phase !== 'prep') {
        focusedBody.mesh.getWorldPosition(tmpWorld);
        const R = effectiveRadius(focusedBody);
        const base = focusedBody.data.size;
        const dist = obj.position.distanceTo(tmpWorld);
        const entryR = Math.max(R * 5.5, base * 10);
        if (dist < entryR) {
          const alt = Math.max(0, dist - R);
          // 0 = high orbit (full space speed), 1 = kissing the ground
          const prox = THREE.MathUtils.clamp(1 - alt / Math.max(18000, R * 0.12), 0, 1);
          const outer = SPEED_MAX;
          const mid = 4000;
          const inner = 900;
          let atmoSpeed = THREE.MathUtils.lerp(outer, mid, prox * prox);
          if (prox > 0.75 || localTerrain.active) {
            atmoSpeed = THREE.MathUtils.lerp(mid, inner, THREE.MathUtils.clamp((prox - 0.75) / 0.25, 0, 1));
          }
          if (localTerrain.entryHeat > 0.4) {
            atmoSpeed *= 1 - localTerrain.entryHeat * 0.08;
          }
          const blend = THREE.MathUtils.smoothstep(prox, 0.15, 0.95);
          speedCap = THREE.MathUtils.lerp(SPEED_MAX, atmoSpeed, blend);
          if (velocity.lengthSq() > speedCap * speedCap) {
            velocity.setLength(speedCap);
          }
        }
      }

      // Hyperdrive overrides normal flight translation
      const hyperLocked = hyper.phase === 'prep' || hyper.phase === 'travel' || hyper.phase === 'align';
      const controlsLocked = hyperLocked || isNavTabletOpen();
      if (hyper.phase) updateHyperDrive(dt);
      if (controlsLocked) {
        lookDelta.x = 0;
        lookDelta.y = 0;
        isThrusting = false;
      }

      // ——— Attitude: seat pilot / hold Alt look + reticle / walk cabin ———
      const onPhone = !!(isTouch && mobilePlaying);
      // Mobile: snappier turn response + slightly higher roll
      const MOUSE_IMPULSE = onPhone ? 0.0072 : 0.0035;
      const ROLL_ACC = onPhone ? 3.4 : 2.6;
      const ANG_DRAG = onPhone ? 3.2 : 2.4;
      const ANG_MAX = onPhone ? 2.6 : 2.0;

      // Swipe coast after finger lift
      if (onPhone && !mobileLookDragging && (Math.abs(mobileLookVel.x) > 0.2 || Math.abs(mobileLookVel.y) > 0.2)) {
        lookDelta.x += mobileLookVel.x;
        lookDelta.y += mobileLookVel.y;
        const damp = Math.exp(-7.5 * dt);
        mobileLookVel.x *= damp;
        mobileLookVel.y *= damp;
        if (Math.abs(mobileLookVel.x) < 0.15) mobileLookVel.x = 0;
        if (Math.abs(mobileLookVel.y) < 0.15) mobileLookVel.y = 0;
      }

      const seatBusy = updateSeatAnim(dt);
      const altLook = isAltLook();
      const altHeld = !!(keys.AltLeft || keys.AltRight || mobileLookHeld);
      const wakeLooking = typeof isIntroCinematic === 'function' && isIntroCinematic();

      if (wakeLooking) {
        // Scripted cinematic head / path from updateWake — skip pilot attitude
        angVel.multiplyScalar(Math.exp(-6 * dt));
        syncCockpitVisibility();
        syncAltReticle();
      } else if (seatBusy) {
        syncCockpitVisibility();
        syncAltReticle();
      } else if (isWalkingInCabin) {
        // Free head look while walking
        if (controls.isLocked || (isTouch && mobilePlaying)) {
          const hs = (isTouch && mobilePlaying) ? 0.0036 : 0.0025;
          const ps = (isTouch && mobilePlaying) ? 0.0032 : 0.0022;
          headYaw -= lookDelta.x * hs;
          headPitch -= lookDelta.y * ps;
          lookDelta.x = 0;
          lookDelta.y = 0;
        }
        headYaw = wrapAngle(headYaw);
        headPitch = THREE.MathUtils.clamp(headPitch, -WALK_PITCH_MAX, WALK_PITCH_MAX);
        angVel.multiplyScalar(Math.exp(-4 * dt));
        if (altHeld) {
          const btn = getFocusedCockpitButton();
          highlightCockpitButton(btn);
        } else if (hoveredBtn) {
          highlightCockpitButton(null);
        }
        head.rotation.set(headPitch, headYaw, 0, 'YXZ');
        syncCockpitVisibility();
        syncAltReticle();
      } else if (altLook) {
        if (controls.isLocked || (isTouch && mobilePlaying)) {
          const hs = (isTouch && mobilePlaying) ? 0.0035 : 0.0024;
          const ps = (isTouch && mobilePlaying) ? 0.0032 : 0.0022;
          headYaw -= lookDelta.x * hs;
          headPitch -= lookDelta.y * ps;
          headYaw = THREE.MathUtils.clamp(headYaw, -HEAD_YAW_MAX, HEAD_YAW_MAX);
          headPitch = THREE.MathUtils.clamp(headPitch, -HEAD_PITCH_MAX, HEAD_PITCH_MAX);
          lookDelta.x = 0;
          lookDelta.y = 0;
        }
        angVel.multiplyScalar(Math.exp(-5 * dt));
        {
          const btn = getFocusedCockpitButton();
          highlightCockpitButton(btn);
        }
        if (altHeld && modeEl
          && !modeEl.textContent.includes('Солнц')
          && !modeEl.textContent.includes('Атмосфер')
          && !modeEl.textContent.includes('СВЕТ')
          && !modeEl.textContent.includes('HUD')
          && !modeEl.textContent.includes('NAV')
          && !modeEl.textContent.includes('ГИПЕР')
          && !modeEl.textContent.includes('ВАРП')
          && !modeEl.textContent.includes('ПОДГОТОВКА')
          && !modeEl.textContent.includes('SCAN')
          && !modeEl.textContent.includes('Alt —')
          && !modeEl.textContent.includes('Ходьба')
          && !modeEl.textContent.includes('кресле')) {
          modeEl.textContent = 'Alt · прицел · ЛКМ — кнопка';
        }
        head.rotation.set(headPitch, headYaw, 0, 'YXZ');
        syncCockpitVisibility();
        syncAltReticle();
      } else {
        if (controls.isLocked || (isTouch && mobilePlaying)) {
          angVel.x += -lookDelta.y * MOUSE_IMPULSE;
          angVel.y += -lookDelta.x * MOUSE_IMPULSE;
        }
        lookDelta.x = 0;
        lookDelta.y = 0;
        headYaw = THREE.MathUtils.damp(headYaw, 0, 5.5, dt);
        headPitch = THREE.MathUtils.damp(headPitch, 0, 5.5, dt);
        if (hoveredBtn) highlightCockpitButton(null);
        if (modeEl && (modeEl.textContent === 'Осмотр кабины · Alt'
          || modeEl.textContent === 'Alt · прицел · ЛКМ — кнопка')) {
          modeEl.textContent = '';
        }
        head.rotation.set(headPitch, headYaw, 0, 'YXZ');
        syncCockpitVisibility();
        syncAltReticle();
      }

      // Animate yoke / throttle / pedals + warp cabin light
      if (cockpitRoot?.userData.yoke) {
        const yoke = cockpitRoot.userData.yoke;
        const targetRoll = THREE.MathUtils.clamp(angVel.z * 0.45, -0.6, 0.6);
        const targetPitch = THREE.MathUtils.clamp(-angVel.x * 0.35, -0.4, 0.4);
        yoke.rotation.z = THREE.MathUtils.damp(yoke.rotation.z, targetRoll, 8, dt);
        yoke.rotation.x = THREE.MathUtils.damp(yoke.rotation.x, -0.28 + targetPitch, 8, dt);
      }
      if (cockpitRoot?.userData.throttle) {
        const thr = cockpitRoot.userData.throttle;
        const braking = !!(keys.KeyS || keys.KeyX);
        const targetThrust = braking
          ? 0.25
          : (isThrusting ? -0.55 : -0.15);
        thr.rotation.x = THREE.MathUtils.damp(thr.rotation.x, targetThrust, 7, dt);
      }
      if (cockpitRoot?.userData.pedalL && cockpitRoot?.userData.pedalR) {
        const yawInput = THREE.MathUtils.clamp(angVel.y * 0.3, -0.35, 0.35);
        const pL = cockpitRoot.userData.pedalL;
        const pR = cockpitRoot.userData.pedalR;
        pL.position.z = THREE.MathUtils.damp(pL.position.z, pL.userData.baseZ + yawInput * 0.14, 8, dt);
        pR.position.z = THREE.MathUtils.damp(pR.position.z, pR.userData.baseZ - yawInput * 0.14, 8, dt);
      }
      syncCabinLights(dt);
      updateCabinDoors(dt);
      updateHudGlassVisibility();
      syncOrbitGuides();

      const stickRoll = onPhone ? -mobileMove.x : mobileMove.x;
      const rollIn = (isWalkingInCabin || seatBusy || isWakeBlocking() || controlsLocked)
        ? 0
        : ((keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0) + stickRoll
          + (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0));
      angVel.z += rollIn * ROLL_ACC * dt;

      const angDamp = Math.exp(-ANG_DRAG * dt);
      angVel.multiplyScalar(angDamp);
      angVel.x = THREE.MathUtils.clamp(angVel.x, -ANG_MAX, ANG_MAX);
      angVel.y = THREE.MathUtils.clamp(angVel.y, -ANG_MAX, ANG_MAX);
      angVel.z = THREE.MathUtils.clamp(angVel.z, -ANG_MAX, ANG_MAX);

      // Local-axis rotation (full freedom — can fly inverted, bank, tumble)
      // Cabin walk / sit-stand: freeze hull attitude — only head moves
      if (!controlsLocked && !isWalkingInCabin && !seatBusy) {
        obj.rotateX(angVel.x * dt);
        obj.rotateY(angVel.y * dt);
        obj.rotateZ(angVel.z * dt);
      } else if (isWalkingInCabin || seatBusy || isNavTabletOpen()) {
        angVel.set(0, 0, 0);
      }

      // ——— Heavy ship translation / cabin walk ———
      ship.getWorldQuaternion(camQuat);
      camDir.set(0, 0, -1).applyQuaternion(camQuat);
      camRight.set(1, 0, 0).applyQuaternion(camQuat);
      tmpForward.set(0, 1, 0).applyQuaternion(camQuat); // ship "up"

      if (hyperLocked || isNavTabletOpen()) {
        isThrusting = false;
        if (isNavTabletOpen()) {
          velocity.multiplyScalar(Math.exp(-2.5 * dt));
          hudSpeed = Math.round(velocity.length());
        } else {
          // Position / look handled by updateHyperDrive
          hudSpeed = Math.round(Math.max(hudSpeed, velocity.length()));
        }
      } else if (seatBusy || (typeof isIntroCinematic === 'function' && isIntroCinematic())) {
        // Sit/stand tween OR scripted intro: hold ship still
        isThrusting = false;
        velocity.set(0, 0, 0);
        verticalVel = 0;
        hudSpeed = 0;
      } else if (isWalkingInCabin) {
        const walkSpeed = (isTouch && mobilePlaying) ? 2.05 : 1.65;
        // W/S/A/D + phone stick (stick was missing — couldn't walk on mobile)
        const moveX = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + mobileMove.x;
        // Stick up (negative z) = forward, same as W
        const moveZ = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) - mobileMove.z;
        // Head looks down local −Z; match walk vectors to headYaw (YXZ)
        walkFwd.set(-Math.sin(headYaw), 0, -Math.cos(headYaw));
        walkRight.set(Math.cos(headYaw), 0, -Math.sin(headYaw));
        walkDir.set(0, 0, 0);
        if (moveZ) walkDir.addScaledVector(walkFwd, moveZ);
        if (moveX) walkDir.addScaledVector(walkRight, moveX);

        // Slide along walls: try full move, then X-only, then Z-only
        walkPrev.copy(head.position);
        let moving = false;
        if (walkDir.lengthSq() > 1e-8) {
          walkDir.normalize();
          moving = true;
          const step = walkSpeed * dt;
          head.position.addScaledVector(walkDir, step);
          resolveCabinWalk(head.position);
          if (head.position.distanceToSquared(walkPrev) < step * step * 0.05) {
            head.position.copy(walkPrev);
            head.position.x += walkDir.x * step;
            resolveCabinWalk(head.position);
            const slidX = head.position.x;
            const slidZfromX = head.position.z;
            head.position.copy(walkPrev);
            head.position.z += walkDir.z * step;
            resolveCabinWalk(head.position);
            const distX = (slidX - walkPrev.x) ** 2 + (slidZfromX - walkPrev.z) ** 2;
            const distZ = (head.position.x - walkPrev.x) ** 2 + (head.position.z - walkPrev.z) ** 2;
            if (distX >= distZ) {
              head.position.x = slidX;
              head.position.z = slidZfromX;
            }
          }
        }
        updateWalkBob(dt, moving);

        // Hold hull still while walking — residual cruise was drifting the ship in orbit
        isThrusting = false;
        velocity.set(0, 0, 0);
        verticalVel = 0;
        hudSpeed = 0;
      } else {
        head.position.copy(SEAT_HEAD);
        if (walkBobAmt > 0 || walkBobOff.lengthSq() > 0) resetWalkBob();

        if (isWakeBlocking() || !isShipPowered()) {
          isThrusting = false;
          // Engines off: coast forever (no drag). S/X still kill speed.
          applySpaceBrake(dt);
          hudSpeed = Math.round(velocity.length());
          obj.position.addScaledVector(velocity, dt);
        } else {
          const inputY = (keys.Space ? 1 : 0) - ((keys.ControlLeft || keys.ControlRight || keys.KeyC) ? 1 : 0);
          const boosting = !!(keys.ShiftLeft || keys.ShiftRight);
          const stickFwd = THREE.MathUtils.clamp(-mobileMove.z, 0, 1);
          const stickBack = THREE.MathUtils.clamp(mobileMove.z, 0, 1);
          const thrusting = !!(keys.KeyW || boosting) || stickFwd > 0.08;
          const hardBrake = !!(keys.KeyS || keys.KeyX);
          const braking = hardBrake || stickBack > 0.08;
          const thrustAmt = thrusting
            ? Math.max(keys.KeyW || boosting ? 1 : 0, stickFwd)
            : 0;
          const accel = SPEED_ACCEL * (boosting ? SPEED_BOOST_MULT : 1) * Math.max(0.35, thrustAmt || 1);

          isThrusting = thrusting && !braking;

          // On W/Shift/stick-fwd: velocity snaps to aim (nose) — no sideways coast slide
          if (braking) {
            const brakeRate = hardBrake
              ? SPEED_BRAKE
              : SPEED_BRAKE * Math.max(0.35, stickBack);
            applySpaceBrake(dt, brakeRate);
          } else if (thrusting) {
            let spd = velocity.length();
            if (spd < SPEED_START) spd = SPEED_START;
            else spd = Math.min(speedCap, spd + accel * dt);
            // Ship nose = flight aim (not Alt head-look — that would push sideways)
            camDir.set(0, 0, -1).applyQuaternion(camQuat);
            velocity.copy(camDir).multiplyScalar(spd);
          } else if (inputY) {
            // Vertical nudge only while coasting (A/D = roll)
            velocity.addScaledVector(tmpForward, SPEED_ACCEL * inputY * dt);
          }

          const maxCruise = speedCap;
          if (velocity.lengthSq() > maxCruise * maxCruise) {
            velocity.setLength(maxCruise);
          }

          hudSpeed = Math.round(velocity.length());
          obj.position.addScaledVector(velocity, dt);
        }
      }

      // Optional residual lift (e.g. mobile launch boost) — cooldown alone must not eject
      if (verticalVel > 0) {
        if (keys.KeyW || keys.Space || keys.ShiftLeft || keys.ShiftRight) {
          verticalVel = Math.max(verticalVel, SPEED_NORMAL * 0.6);
        }
        obj.position.addScaledVector(takeoffNormal, verticalVel * dt);
        verticalVel *= Math.exp(-2.2 * dt);
        if (verticalVel < 4) verticalVel = 0;
      }

      // Ship hull collision vs all nearby worlds (not only the focused one)
      if (takeoffCooldown <= 0
        && hyper.phase !== 'prep'
        && hyper.phase !== 'travel'
        && !isWalkingInCabin
        && !seatBusy) {
        for (const t of getLandables()) {
          t.mesh.getWorldPosition(tmpWorld);
          let R = t.radius;
          if (!t.isMoon && bodySupportsTerrain(t.body)) {
            R = sampleSurfaceRadius(t.body, obj.position, tmpNormal);
          } else {
            tmpNormal.copy(obj.position).sub(tmpWorld);
            if (tmpNormal.lengthSq() < 1e-10) tmpNormal.set(0, 1, 0);
            else tmpNormal.normalize();
          }
          const d = obj.position.distanceTo(tmpWorld);
          if (d < R + EYE) {
            // Soft depenetration only — no bounce / rocket shove
            obj.position.copy(tmpWorld).addScaledVector(tmpNormal, R + EYE);
            const into = velocity.dot(tmpNormal);
            if (into < 0) velocity.addScaledVector(tmpNormal, -into * 0.85);
          }
        }
      }

      const sunDist = obj.position.length();
      if (sunDist < SUN_R * 1.15) {
        obj.position.setLength(SUN_R * 1.2);
        // Stop diving into the sun
        tmpNormal.copy(obj.position).normalize();
        const intoSun = velocity.dot(tmpNormal);
        if (intoSun < 0) velocity.addScaledVector(tmpNormal, -intoSun);
        modeEl.textContent = 'Слишком близко к Солнцу!';
      }
    }

    function updateWarpFx(dt) {
      const flying = isPlaying() && !landed;
      const inTravel = hyper.phase === 'travel';
      const inPrep = hyper.phase === 'prep';

      // Streaks / warp pass ONLY during the 5s jump — prep is sound + cabin charge light
      let target = 0;
      if (inTravel) target = 1;

      warpIntensity = THREE.MathUtils.damp(
        warpIntensity,
        target,
        inTravel ? 8 : 10,
        dt
      );
      if (warpIntensity < 0.004) warpIntensity = 0;

      // Soft cruise buzz — quieter overall, especially near planets
      let buzzTarget = 0;
      if (flying && !inTravel && !inPrep) {
        const spdF = THREE.MathUtils.clamp(velocity.length() / Math.max(500, SPEED_MAX * 0.15), 0, 1.2);
        const turnF = THREE.MathUtils.clamp(angVel.length() / 1.2, 0, 1);
        buzzTarget = 0.04 + spdF * 0.08 + turnF * 0.05 + (isThrusting ? 0.06 : 0);
        if (focusedBody) buzzTarget *= 0.28; // orbit: gentle hum, not a vibration mill
      }
      flightBuzz = THREE.MathUtils.damp(flightBuzz, buzzTarget, 5, dt);
      if (flightBuzz < 0.008) flightBuzz = 0;

      const wantFlying = flying && flightBuzz > 0.04;
      const wantWarping = inTravel || warpIntensity > 0.15;
      if (document.body.classList.contains('flying') !== wantFlying) {
        document.body.classList.toggle('flying', wantFlying);
      }
      if (document.body.classList.contains('warping') !== wantWarping) {
        document.body.classList.toggle('warping', wantWarping);
      }

      warpPass.enabled = warpIntensity > 0.05;
      // Keep post mild — tunnel lives on the ship; avoid full-screen “lens” smear
      warpPass.uniforms.warp.value = warpIntensity * 0.35;
      warpPass.uniforms.time.value = clock.elapsedTime;

      const cruiseFovKick = flying && !inTravel ? flightBuzz * 0.45 + (isThrusting ? 0.25 : 0) : 0;
      const targetFov = BASE_FOV + cruiseFovKick + warpIntensity * 6;
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 6, dt);
        camera.updateProjectionMatrix();
      }

      if (warpIntensity > 0.04) {
        warpStreaks.visible = true;
        refreshWarpStreaks(warpIntensity, dt);
      } else if (warpStreaks.visible || warpStreakMat.opacity > 0.001) {
        warpStreakMat.opacity = 0;
        warpStreaks.visible = false;
      }

      // Near planet: damp ALL shakes further
      const orbitMul = focusedBody && !inTravel ? 0.22 : 1;

      // Light cruise rattle — softer cabin feel
      const shakeMix = Math.max(flightBuzz * 0.28, warpIntensity) * orbitMul;
      if (shakeMix > 0.035 && flying) {
        const t = clock.elapsedTime;
        const w = warpIntensity * orbitMul;
        const b = flightBuzz * orbitMul;
        const posAmp = 0.0016 + b * 0.005 + w * 0.035;
        warpShake.set(
          (Math.sin(t * 39.0) * 0.5 + Math.sin(t * 15.0) * 0.3 + (Math.random() - 0.5) * 0.2) * posAmp * (0.2 + w * 0.5),
          (Math.cos(t * 35.0) * 0.5 + Math.sin(t * 19.0) * 0.3 + (Math.random() - 0.5) * 0.2) * posAmp * (0.2 + w * 0.5),
          (Math.sin(t * 27.0) * 0.35 + (Math.random() - 0.5) * 0.15) * posAmp * 0.25
        );
        camera.position.add(warpShake);
        warpShakeActive = true;

        const pitchAmp = 0.0006 * b + 0.012 * w;
        const yawAmp = 0.0005 * b + 0.014 * w;
        const rollAmp = 0.0008 * b + 0.02 * w;
        warpShakeEuler.set(
          (Math.sin(t * 45.0) * 0.65 + Math.sin(t * 14.0) * 0.3 + (Math.random() - 0.5) * 0.2) * pitchAmp,
          (Math.cos(t * 41.0) * 0.65 + Math.sin(t * 17.0) * 0.3 + (Math.random() - 0.5) * 0.2) * yawAmp,
          (Math.sin(t * 52.0) * 0.55 + Math.cos(t * 24.0) * 0.3 + (Math.random() - 0.5) * 0.25) * rollAmp,
          'YXZ'
        );
        warpShakeQuat.setFromEuler(warpShakeEuler);
        camera.quaternion.multiply(warpShakeQuat);
        warpShakeQuatActive = true;
      } else {
        // Resting eye (+ walk bob if still damping out); clear warp micro-tilt
        if (!warpShakeActive) {
          if (isWalkingInCabin || walkBobAmt > 0.002) applyCabinCameraEye();
          else camera.position.copy(CAM_EYE);
        }
      }

      if (warpVeil) {
        // Only during hyper prep/travel — never a blue cruise vignette
        const prepVeil = inPrep ? hyperCharge * 0.08 : 0;
        const veil = Math.max(warpIntensity * 0.42, prepVeil);
        const veilStr = veil.toFixed(3);
        if (warpVeil.dataset.op !== veilStr) {
          warpVeil.dataset.op = veilStr;
          warpVeil.style.opacity = veilStr;
        }
        const wantHot = inTravel && warpIntensity > 0.35;
        if (warpVeil.classList.contains('hot') !== wantHot) {
          warpVeil.classList.toggle('hot', wantHot);
        }
      }
    }

    function updateLocalLighting() {
      const sunDist = ship.position.length();
      const nearTarget = THREE.MathUtils.clamp(1 - (sunDist - SUN_R * 2) / (AU * 2.5), 0, 1);
      warpNearSun += (nearTarget - warpNearSun) * 0.08;
      const outer = THREE.MathUtils.clamp(sunDist / (AU * 35), 0, 1);
      renderer.toneMappingExposure = (isMobileUA ? 1.06 : 1.0)
        + warpNearSun * (isMobileUA ? 0.1 : 0.08) - outer * 0.03;
      // Bloom / FXAA / warp — keep phone pretty but light in the seat
      const inSeatCockpit = !!(cockpitRoot?.visible) && !isWalkingInCabin && !seatAnim && warpIntensity < 0.1;
      const wantBloom = isMobileUA
        ? (!inSeatCockpit || warpNearSun > 0.35 || warpIntensity > 0.05)
        : (!inSeatCockpit || warpNearSun > 0.7 || warpIntensity > 0.08);
      bloomPass.enabled = wantBloom;
      bloomPass.strength = wantBloom
        ? ((isMobileUA ? (inSeatCockpit ? 0.16 : 0.34) : (inSeatCockpit ? 0.1 : 0.22))
          + warpNearSun * 0.12 + warpIntensity * 0.4
          + (hyper.phase === 'prep' ? hyperCharge * 0.08 : 0))
        : 0;
      bloomPass.threshold = inSeatCockpit ? (isMobileUA ? 0.965 : 0.995) : (isMobileUA ? 0.93 : 0.97);
      bloomPass.radius = isMobileUA ? 0.5 : bloomPass.radius;
      warpPass.enabled = warpIntensity > 0.01 || hyper.phase === 'travel';
      fxaaPass.enabled = isMobileUA && warpIntensity < 0.12;
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
        // HTML panel only when world labels are on (landed/no cockpit)
        if (!cockpitRoot?.visible) infoPanel.classList.add('visible');
        else infoPanel.classList.remove('visible');
      } else if (!best && nearestPlanet) {
        nearestPlanet = null;
        infoPanel.classList.remove('visible');
      } else if (cockpitRoot?.visible) {
        infoPanel.classList.remove('visible');
      }
    }

    // ---- Cockpit dashboard screens ----
    let ckRound = 0;
    let ckDataCache = null;
    let ckDataAge = 0;
    const ckMapScratch = [];
    const hudSmooth = {
      heading: 0,
      spd: 0,
      lock: 0,
      warp: 0,
      bracketX: 0,
      bracketY: 0,
      bracketValid: false,
      bracketOnGlass: false,
      inited: false,
    };
    const ckLook = new THREE.Vector3();
    const ckTo = new THREE.Vector3();
    const ckFlatA = new THREE.Vector3();
    const ckFlatB = new THREE.Vector3();
    const ckMapPos = new THREE.Vector3();

    function formatAltitude(alt) {
      const a = Math.max(0, alt);
      if (a < EYE * 1.5) return 'ПОСАДКА';
      if (a < 80) return `${a.toFixed(0)} u · у поверхности`;
      if (a < EARTH_R) return `${a.toFixed(0)} u · ${(a / EARTH_R).toFixed(2)} R⊕`;
      if (a < EARTH_R * 40) return `${(a / EARTH_R).toFixed(1)} R⊕ (${a.toFixed(0)} u)`;
      return `${(a / EARTH_R).toFixed(0)} R⊕ (${Math.round(a).toLocaleString('ru-RU')} u)`;
    }

    /** Height above true surface (sphere or terrain) */
    function getSurfaceAltitude(body, worldPos) {
      if (!body?.mesh) return Infinity;
      body.mesh.getWorldPosition(tmpWorld);
      let surfaceR = effectiveRadius(body);
      if (bodySupportsTerrain(body) || localTerrain.active) {
        surfaceR = sampleSurfaceRadius(body, worldPos, tmpNormal);
      }
      return Math.max(0, worldPos.distanceTo(tmpWorld) - surfaceR);
    }

    function updateAltitudeHud(body, alt, phase) {
      if (!altHud || !altValueEl) return;
      if (!body || landed || alt == null || !Number.isFinite(alt)) {
        altHud.classList.add('hidden');
        return;
      }
      altHud.classList.remove('hidden');
      altHud.classList.toggle('low', alt < EARTH_R * 2 && alt >= EYE * 3);
      altHud.classList.toggle('land', alt < EYE * 3);
      altValueEl.textContent = formatAltitude(alt);
      if (altSubEl) {
        const tip = alt < EYE * 3
          ? 'Можно садиться'
          : (alt < EARTH_R
            ? 'Снижайтесь к поверхности'
            : 'Высокая орбита — снижайтесь');
        altSubEl.textContent = `${body.data.name} · ${phase || 'ОРБИТА'} · ${tip}`;
      }
    }

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
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        b.mesh.getWorldPosition(ckMapPos);
        let row = ckMapScratch[i];
        if (!row) {
          row = {};
          ckMapScratch[i] = row;
        }
        row.body = b;
        row.name = b.data.name;
        row.x = ckMapPos.x;
        row.z = ckMapPos.z;
        row.au = b.data.au;
        row.dist = pos.distanceTo(ckMapPos);
        row.moons = b.data.moons?.length || 0;
        row.isTarget = nav.target === b;
      }
      ckMapScratch.length = bodies.length;
      ckMapScratch.sort((a, b) => a.dist - b.dist);

      if (!ckDataCache) ckDataCache = {};
      ckDataCache.nav = nav;
      ckDataCache.mapPlanets = ckMapScratch;
      ckDataCache.nearest = ckMapScratch;
      ckDataCache.shipX = pos.x;
      ckDataCache.shipZ = pos.z;
      ckDataCache.sunDist = pos.length();
      ckDataCache.warp = warpIntensity;
      ckDataCache.thrust = isThrusting;
      return ckDataCache;
    }

    function ckFillGrid(ctx, w, h, hue = 195) {
      ctx.fillStyle = '#010408';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.85)`;
      ctx.lineWidth = 1.0;
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      for (let x = 8; x < w; x += 16) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 8; y < h; y += 16) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.45)`;
      ctx.strokeRect(3, 3, w - 6, h - 6);
    }

    function ckDrawLines(ctx, lines, x0, y0, step, size, hue = 195) {
      ctx.font = `bold ${size}px monospace`;
      ctx.fillStyle = `hsla(${hue}, 90%, 72%, 0.98)`;
      lines.forEach((line, li) => {
        if (line) ctx.fillText(String(line).slice(0, 28), x0, y0 + li * step);
      });
    }

    function ckScanline(ctx, w, h, t, seed = 0) {
      const y = ((t * 22 + seed * 17) % h);
      ctx.fillStyle = 'rgba(180,220,255,0.07)';
      ctx.fillRect(4, y - 1, w - 8, 3);
    }

    function paintCkMap(ctx, w, h, data, t, compact = false) {
      drawSolarSystemMap(ctx, w, h, {
        interactive: false,
        selected: navTablet.selected || data.nav?.target || null,
        showLabels: !compact,
        fillHits: false,
      });
      // Compact status overlay for dash screen
      const nav = data.nav;
      ctx.fillStyle = 'hsla(195, 90%, 72%, 0.95)';
      ctx.font = 'bold 10px monospace';
      if (!compact) {
        ctx.fillText(`КУРС ${nav.heading.toFixed(0)}° · ${nav.spd} u/s`, 12, h - 12);
      }
      ckScanline(ctx, w, h, t, 2);
    }

    function paintCkCompass(ctx, w, h, nav, t) {
      ckFillGrid(ctx, w, h, 195);
      const cx = w * 0.5;
      const cy = h * 0.54;
      const r = Math.min(w, h) * 0.35;

      ctx.strokeStyle = 'hsla(195, 90%, 65%, 0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      const offsetRad = (nav.heading * Math.PI) / 180;
      for (let d = 0; d < 360; d += 30) {
        const a = (d - 90) * Math.PI / 180 - offsetRad;
        const inner = d % 90 === 0 ? r - 12 : r - 7;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        ctx.stroke();
        if (d % 90 === 0) {
          const tag = ['N', 'E', 'S', 'W'][d / 90];
          ctx.fillStyle = d === 0 ? '#ff5555' : 'hsla(195, 90%, 72%, 0.9)';
          ctx.font = 'bold 9px monospace';
          ctx.fillText(tag, cx + Math.cos(a) * (r - 20) - 3, cy + Math.sin(a) * (r - 20) + 3);
        }
      }

      if (nav.target) {
        const bRad = (-nav.bearing - 90) * Math.PI / 180;
        ctx.strokeStyle = '#33ff77';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(bRad) * (r - 12), cy + Math.sin(bRad) * (r - 12));
        ctx.stroke();
      }

      ctx.strokeStyle = '#ff3333';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
      ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
      ctx.stroke();

      ckDrawLines(ctx, [
        'ГИРО-КОМПАС',
        nav.target ? nav.name.toUpperCase() : 'СКАНИРОВАНИЕ',
        `КУРС ${nav.heading.toFixed(0)}°`,
      ], 8, 18, 14, 10);
      ckScanline(ctx, w, h, t, 5);
    }

    function paintCkPlanetInfo(ctx, w, h, nav, data) {
      ckFillGrid(ctx, w, h, 200);
      const name = (nav.name || 'ОТКРЫТЫЙ КОСМОС').toUpperCase();
      ckDrawLines(ctx, ['ОБЪЕКТ', name], 10, 20, 18, 13, 200);

      ctx.font = '10px monospace';
      ctx.fillStyle = 'hsla(200, 80%, 68%, 0.85)';
      const words = nav.desc.split(' ');
      let line = '';
      let y = 52;
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > w - 20) {
          ctx.fillText(line, 10, y);
          line = word;
          y += 14;
          if (y > h - 45) break;
        } else {
          line = test;
        }
      }
      if (line && y <= h - 45) ctx.fillText(line, 10, y);

      if (nav.target) {
        y = Math.min(y + 18, h - 38);
        ctx.fillStyle = 'hsla(45, 90%, 72%, 0.95)';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`ДИСТ:  ${formatNavDist(nav.dist)}`, 10, y);
        ctx.fillText(`ВЫС:   ${formatNavDist(nav.alt)}`, 10, y + 12);
        if (nav.moons.length) {
          ctx.fillStyle = 'hsla(195, 85%, 72%, 0.9)';
          ctx.fillText(`СПУТН: ${nav.moons.map((m) => m.name).join(', ').slice(0, 22)}`, 10, y + 24);
        }
      }

      if (nav.inAtmo) {
        ctx.fillStyle = 'hsla(35, 100%, 65%, 0.95)';
        ctx.fillText('▲ ВХОД В АТМОСФЕРУ', 10, h - 12);
      }
      ckScanline(ctx, w, h, 0, 1);
    }

    function paintCkTarget(ctx, w, h, nav, data) {
      ckFillGrid(ctx, w, h, 45);
      const name = (nav.name || 'НЕТ').toUpperCase();
      const dirStr = nav.target ? bearingLabel(nav.bearing) : 'ПОИСК...';
      const elevStr = nav.target
        ? (nav.elev > 5 ? `▲ ${nav.elev.toFixed(0)}°` : nav.elev < -5 ? `▼ ${Math.abs(nav.elev).toFixed(0)}°` : '═ ЭКЛИПТИКА')
        : '—';

      ckDrawLines(ctx, [
        'ЗАХВАТ ЦЕЛИ',
        name,
        nav.target ? `ДИСТ ${formatNavDist(nav.dist)}` : '—',
        dirStr,
        elevStr,
        nav.target && nav.aligned > 0.88 ? '● ЗАХВАЧЕНО' : '○ НАВЕДЕНИЕ',
      ], 10, 22, 17, 12, 45);

      if (nav.target) {
        const barW = w - 24;
        const lock = THREE.MathUtils.clamp((nav.aligned + 1) * 0.5, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(12, h - 22, barW, 6);
        ctx.fillStyle = lock > 0.88 ? '#33ff77' : '#3ec7ff';
        ctx.fillRect(12, h - 22, barW * lock, 6);
        // lock reticle
        const cx = w * 0.72;
        const cy = h * 0.42;
        const s = 10 + (1 - lock) * 8;
        ctx.strokeStyle = lock > 0.88 ? '#33ff77' : 'hsla(45, 90%, 60%, 0.7)';
        ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
      }
      ckScanline(ctx, w, h, 0, 3);
    }

    function paintCkFlight(ctx, w, h, nav, data) {
      ckFillGrid(ctx, w, h, 160);
      ckDrawLines(ctx, [
        'ТЕЛЕМЕТРИЯ',
        `СКОРОСТЬ: ${nav.spd} u/s`,
        `КУРС:     ${nav.heading.toFixed(0)}°`,
        data.thrust ? 'МАРШЕВЫЙ: ТЯГА' : 'МАРШЕВЫЙ: ИНЕРЦИЯ',
        data.warp > 0.12 ? `ГИПЕР:   ${(data.warp * 100).toFixed(0)}%` : 'ДВИГ:    АКТИВЕН',
        nav.inAtmo ? 'РЕЖИМ:    АТМОСФЕРА' : 'РЕЖИМ:    ВАКУУМ',
      ], 8, 22, 16, 11, 160);
      // artificial horizon stub
      const hx = w * 0.72;
      const hy = h * 0.55;
      ctx.strokeStyle = 'hsla(160, 80%, 60%, 0.55)';
      ctx.beginPath();
      ctx.arc(hx, hy, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx - 18, hy);
      ctx.lineTo(hx + 18, hy);
      ctx.stroke();
      ctx.fillStyle = '#ff5555';
      ctx.fillRect(hx - 2, hy - 2, 4, 4);
      ckScanline(ctx, w, h, 0, 4);
    }

    function paintCkRadar(ctx, w, h, nav, data, t) {
      ckFillGrid(ctx, w, h, 280);
      const cx = w * 0.5;
      const cy = h * 0.55;
      const r = Math.min(w, h) * 0.38;

      ctx.strokeStyle = 'hsla(280, 70%, 60%, 0.3)';
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (r / 3) * i, 0, Math.PI * 2);
        ctx.stroke();
      }

      const sweep = (t * 2.2) % (Math.PI * 2);
      ctx.strokeStyle = 'hsla(280, 90%, 65%, 0.4)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r);
      ctx.stroke();
      // sweep wedge
      ctx.fillStyle = 'hsla(280, 90%, 65%, 0.06)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, sweep - 0.35, sweep);
      ctx.closePath();
      ctx.fill();

      for (let i = 0, n = Math.min(5, data.nearest.length); i < n; i++) {
        const p = data.nearest[i];
        const rel = Math.min(p.dist / (AU * 3.5), 1);
        const ang = Math.atan2(p.z - data.shipZ, p.x - data.shipX);
        const pr = rel * r * 0.95;
        const px = cx + Math.cos(ang) * pr;
        const py = cy + Math.sin(ang) * pr;
        // height tick (ecliptic projection cue)
        ctx.strokeStyle = 'hsla(280, 60%, 55%, 0.35)';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py - 7);
        ctx.stroke();
        ctx.fillStyle = p.isTarget ? '#ffe08a' : 'hsla(280, 80%, 70%, 0.85)';
        ctx.beginPath();
        ctx.arc(px, py, p.isTarget ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (p.isTarget) {
          ctx.strokeStyle = 'rgba(255,224,138,0.35)';
          ctx.strokeRect(px - 6, py - 6, 12, 12);
        }
      }

      ckDrawLines(ctx, ['АКТИВНЫЙ РЛС', `ОБЪЕКТОВ: ${data.nearest.length}`], 8, 14, 14, 9, 280);
      ckScanline(ctx, w, h, t, 6);
    }

    function paintCkSideList(ctx, w, h, data) {
      ckFillGrid(ctx, w, h, 120);
      ckDrawLines(ctx, ['СЕНСОРНЫЙ СПИСОК'], 10, 18, 16, 11, 120);
      ctx.font = '9px monospace';
      ctx.fillStyle = 'hsla(120, 70%, 72%, 0.9)';
      for (let i = 0, n = Math.min(7, data.nearest.length); i < n; i++) {
        const p = data.nearest[i];
        const y = 36 + i * 16;
        const mark = p.isTarget ? '▶' : '·';
        const moonTag = p.moons ? ` (${p.moons}m)` : '';
        ctx.fillText(`${mark} ${p.name.slice(0, 8)}${moonTag} - ${formatNavDist(p.dist)}`, 10, y);
      }
      ckScanline(ctx, w, h, 0, 7);
    }

    function paintCkBriefing(ctx, w, h, data, t) {
      ckFillGrid(ctx, w, h, 195);
      const nav = data.nav;
      const body = nav.target || nearestPlanet;
      ckDrawLines(ctx, ['СВОДКА ПОДЛЁТА'], 12, 22, 16, 12, 195);

      if (!body) {
        ckDrawLines(ctx, ['НЕТ ЦЕЛИ', 'Подойдите ближе', 'к планете'], 12, 56, 18, 12, 195);
        ckScanline(ctx, w, h, t, 1);
        return;
      }

      const name = (body.data?.name || body.name || nav.name || '—').toUpperCase();
      const desc = body.data?.desc || nav.desc || '';
      body.mesh.getWorldPosition(ckMapPos);
      const dist = ship.position.distanceTo(ckMapPos);

      // Planet portrait
      const picR = Math.min(w * 0.22, 70);
      const picX = w * 0.5;
      const picY = 88;
      ctx.save();
      ctx.beginPath();
      ctx.arc(picX, picY, picR, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const mapTex = body.mesh?.material?.map;
      const img = mapTex?.image;
      if (img && img.width) {
        ctx.drawImage(img, picX - picR, picY - picR, picR * 2, picR * 2);
      } else {
        const g = ctx.createRadialGradient(picX - picR * 0.3, picY - picR * 0.3, 4, picX, picY, picR);
        g.addColorStop(0, '#6ec8ff');
        g.addColorStop(1, '#0a2030');
        ctx.fillStyle = g;
        ctx.fillRect(picX - picR, picY - picR, picR * 2, picR * 2);
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(80,220,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(picX, picY, picR + 2, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(80,220,255,0.95)';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(name, picX, picY + picR + 24);

      ctx.textAlign = 'left';
      ctx.font = '11px monospace';
      ctx.fillStyle = 'hsla(195, 80%, 72%, 0.9)';
      const words = String(desc).split(' ');
      let line = '';
      let y = picY + picR + 48;
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > w - 24) {
          ctx.fillText(line, 12, y);
          line = word;
          y += 14;
          if (y > h - 70) break;
        } else line = test;
      }
      if (line && y <= h - 70) ctx.fillText(line, 12, y);

      y = Math.max(y + 18, h - 56);
      ctx.fillStyle = 'hsla(45, 90%, 72%, 0.95)';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(`ДИСТ ${formatNavDist(dist)}`, 12, y);
      if (nav.target) {
        ctx.fillText(`ВЫС  ${formatNavDist(nav.alt)}`, 12, y + 14);
        ctx.fillText(bearingLabel(nav.bearing), 12, y + 28);
      }
      if (nav.inAtmo || focusedBody === body) {
        ctx.fillStyle = 'hsla(35, 100%, 65%, 0.95)';
        ctx.fillText('▲ АТМОСФЕРА / ОБЛЁТ', 12, h - 14);
      } else {
        ctx.fillStyle = 'hsla(160, 90%, 60%, 0.9)';
        ctx.font = 'bold 10px monospace';
        ctx.fillText('M — планшет · варп к орбите', 12, h - 14);
      }
      ckScanline(ctx, w, h, t, 2);
    }

    const ckHudWorld = new THREE.Vector3();
    const ckHudCam = new THREE.Vector3();
    const ckHudDir = new THREE.Vector3();
    const ckHudHit = new THREE.Vector3();
    const ckHudLocal = new THREE.Vector3();
    const ckHudNormal = new THREE.Vector3();
    const ckHudPlanePt = new THREE.Vector3();
    const ckHudPlane = new THREE.Plane();
    const ckHudRay = new THREE.Ray();

    /** Project planet onto windshield HUD canvas (true glass intersection) */
    function projectPlanetOnHudGlass(body) {
      const glass = cockpitRoot?.userData.hudGlass;
      const size = cockpitRoot?.userData.hudGlassSize;
      if (!glass || !size || !body?.mesh) return null;

      body.mesh.getWorldPosition(ckHudWorld);
      camera.getWorldPosition(ckHudCam);
      ckHudDir.copy(ckHudWorld).sub(ckHudCam);
      const dist = ckHudDir.length();
      if (dist < 1e-4) return null;
      ckHudDir.multiplyScalar(1 / dist);

      // Must be roughly ahead of the camera
      camera.getWorldDirection(ckHudLocal); // reuse
      if (ckHudDir.dot(ckHudLocal) < 0.05) return null;

      glass.updateWorldMatrix(true, false);
      ckHudNormal.set(0, 0, 1).transformDirection(glass.matrixWorld).normalize();
      glass.getWorldPosition(ckHudPlanePt);
      ckHudPlane.setFromNormalAndCoplanarPoint(ckHudNormal, ckHudPlanePt);
      ckHudRay.set(ckHudCam, ckHudDir);
      if (!ckHudRay.intersectPlane(ckHudPlane, ckHudHit)) return null;

      // Hit must be in front of camera along ray
      ckHudWorld.copy(ckHudHit).sub(ckHudCam);
      if (ckHudWorld.dot(ckHudDir) < 0) return null;

      glass.worldToLocal(ckHudLocal.copy(ckHudHit));
      const hx = size.sx * 0.5;
      const hy = size.sy * 0.5;
      const onGlass = Math.abs(ckHudLocal.x) <= hx * 1.02 && Math.abs(ckHudLocal.y) <= hy * 1.02;
      const u = THREE.MathUtils.clamp(ckHudLocal.x / hx, -1.35, 1.35);
      const v = THREE.MathUtils.clamp(ckHudLocal.y / hy, -1.35, 1.35);
      return { u, v, onGlass, dist };
    }

    function smoothHudAngle(current, target, dt, rate = 16) {
      let diff = target - current;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      return current + diff * (1 - Math.exp(-rate * dt));
    }

    function updateHudSmooth(nav, data, dt, w, h) {
      if (!hudSmooth.inited) {
        hudSmooth.heading = nav.heading;
        hudSmooth.spd = nav.spd;
        hudSmooth.lock = THREE.MathUtils.clamp((nav.aligned + 1) * 0.5, 0, 1);
        hudSmooth.warp = data.warp || 0;
        hudSmooth.inited = true;
      }
      hudSmooth.heading = smoothHudAngle(hudSmooth.heading, nav.heading, dt, 18);
      hudSmooth.spd = THREE.MathUtils.damp(hudSmooth.spd, nav.spd, 14, dt);
      hudSmooth.lock = THREE.MathUtils.damp(
        hudSmooth.lock,
        THREE.MathUtils.clamp((nav.aligned + 1) * 0.5, 0, 1),
        16,
        dt
      );
      hudSmooth.warp = THREE.MathUtils.damp(hudSmooth.warp, data.warp || 0, 10, dt);

      if (nav.target) {
        const proj = projectPlanetOnHudGlass(nav.target);
        if (proj) {
          const bx = (proj.u * 0.5 + 0.5) * w;
          const by = (-proj.v * 0.5 + 0.5) * h;
          if (!hudSmooth.bracketValid) {
            hudSmooth.bracketX = bx;
            hudSmooth.bracketY = by;
            hudSmooth.bracketValid = true;
          } else {
            hudSmooth.bracketX = THREE.MathUtils.damp(hudSmooth.bracketX, bx, 24, dt);
            hudSmooth.bracketY = THREE.MathUtils.damp(hudSmooth.bracketY, by, 24, dt);
          }
          hudSmooth.bracketOnGlass = proj.onGlass;
        } else {
          hudSmooth.bracketValid = false;
        }
      } else {
        hudSmooth.bracketValid = false;
      }
    }

    function paintCkHudGlass(ctx, w, h, data, t) {
      ctx.clearRect(0, 0, w, h);
      const nav = data.nav;
      const slim = !!(typeof isMobileUA !== 'undefined' && isMobileUA);
      const k = (w / 640) * (slim ? 0.92 : 1);
      const cx = w * 0.5;
      const cy = h * 0.48;
      const cyan = 'rgba(80, 220, 255, 0.92)';
      const soft = 'rgba(80, 220, 255, 0.42)';
      const warn = 'rgba(255, 170, 70, 0.95)';
      const ok = 'rgba(70, 255, 140, 0.95)';
      const lw = Math.max(0.5, (slim ? 0.55 : 0.7) * k);
      ctx.lineWidth = lw;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.globalAlpha = slim ? 0.88 : 1;

      // No vignette / canopy rim — clear glass except HUD marks
      // (entry heat streaks only as thin top wash, no edge oval)
      if (atmoFx.active && atmoFx.heat > 0.4) {
        const heat = atmoFx.heat;
        const hg = ctx.createLinearGradient(0, 0, 0, h * 0.14);
        hg.addColorStop(0, `rgba(255,140,70,${(heat * 0.06).toFixed(3)})`);
        hg.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = hg;
        ctx.fillRect(0, 0, w, h * 0.14);
      }

      // Heading tape — smooth scroll (sub-degree)
      const hdg = hudSmooth.heading;
      const hdgScroll = (hdg - Math.round(hdg)) * 2.0 * k;
      ctx.strokeStyle = soft;
      ctx.beginPath();
      ctx.moveTo(cx - 120 * k, 44 * k);
      ctx.lineTo(cx + 120 * k, 44 * k);
      ctx.stroke();
      ctx.fillStyle = cyan;
      ctx.font = ckFont(Math.round(15 * k), '600');
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(hdg).toString().padStart(3, '0')}°`, cx, 34 * k);
      ctx.font = ckFont(Math.round(11 * k), '500');
      for (let d = -45; d <= 45; d += 15) {
        const tickHdg = (Math.round(hdg) + d + 360) % 360;
        const x = cx + d * 2.0 * k - hdgScroll;
        ctx.globalAlpha = d === 0 ? 1 : 0.45;
        ctx.beginPath();
        ctx.moveTo(x, 44 * k);
        ctx.lineTo(x, (d % 30 === 0 ? 54 : 50) * k);
        ctx.stroke();
        if (d % 30 === 0) ctx.fillText(`${Math.round(tickHdg)}`, x, 66 * k);
      }
      ctx.globalAlpha = 1;

      ctx.strokeStyle = cyan;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(cx, cy, 16 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 30 * k, cy); ctx.lineTo(cx - 18 * k, cy);
      ctx.moveTo(cx + 18 * k, cy); ctx.lineTo(cx + 30 * k, cy);
      ctx.moveTo(cx, cy - 30 * k); ctx.lineTo(cx, cy - 18 * k);
      ctx.moveTo(cx, cy + 18 * k); ctx.lineTo(cx, cy + 30 * k);
      ctx.stroke();
      ctx.fillStyle = cyan;
      ctx.fillRect(cx - 0.9 * k, cy - 0.9 * k, 1.8 * k, 1.8 * k);

      // Target bracket — smoothed projection on windshield glass
      if (nav.target && hudSmooth.bracketValid) {
        const lock = hudSmooth.lock;
        const col = lock > 0.88 ? ok : warn;
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = Math.max(0.5, 0.65 * k);

        let bx = hudSmooth.bracketX;
        let by = hudSmooth.bracketY;
        const margin = 36 * k;
        const clamped = !hudSmooth.bracketOnGlass
          || bx < margin || bx > w - margin || by < margin || by > h - margin;
        bx = THREE.MathUtils.clamp(bx, margin, w - margin);
        by = THREE.MathUtils.clamp(by, margin, h - margin);

        if (clamped && !hudSmooth.bracketOnGlass) {
          const ang = Math.atan2(by - cy, bx - cx);
          const ex = cx + Math.cos(ang) * Math.min(w, h) * 0.38;
          const ey = cy + Math.sin(ang) * Math.min(w, h) * 0.32;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - Math.cos(ang) * 10 + Math.sin(ang) * 5, ey - Math.sin(ang) * 10 - Math.cos(ang) * 5);
          ctx.lineTo(ex - Math.cos(ang) * 10 - Math.sin(ang) * 5, ey - Math.sin(ang) * 10 + Math.cos(ang) * 5);
          ctx.closePath();
          ctx.stroke();
          ctx.font = ckFont(Math.round(11 * k), '600');
          ctx.textAlign = 'center';
          ctx.fillText(nav.name.toUpperCase(), ex, ey + 14 * k);
          ctx.font = ckFont(Math.round(10 * k), '500');
          ctx.fillText(formatNavDist(nav.dist), ex, ey + 24 * k);
        } else {
          const s = (7 + (1 - lock) * 5) * k;
          const c = 3.2 * k; // corner length — open bracket, not a fat box
          const tick = 4 * k;
          // Four L-corners (thinner read than full strokeRect)
          ctx.beginPath();
          ctx.moveTo(bx - s, by - s + c); ctx.lineTo(bx - s, by - s); ctx.lineTo(bx - s + c, by - s);
          ctx.moveTo(bx + s - c, by - s); ctx.lineTo(bx + s, by - s); ctx.lineTo(bx + s, by - s + c);
          ctx.moveTo(bx - s, by + s - c); ctx.lineTo(bx - s, by + s); ctx.lineTo(bx - s + c, by + s);
          ctx.moveTo(bx + s - c, by + s); ctx.lineTo(bx + s, by + s); ctx.lineTo(bx + s, by + s - c);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(bx - s - tick, by); ctx.lineTo(bx - s, by);
          ctx.moveTo(bx + s, by); ctx.lineTo(bx + s + tick, by);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(bx - 2.2 * k, by); ctx.lineTo(bx + 2.2 * k, by);
          ctx.moveTo(bx, by - 2.2 * k); ctx.lineTo(bx, by + 2.2 * k);
          ctx.stroke();

          const labelX = bx + s + 6 * k;
          const labelY = by - 2 * k;
          ctx.textAlign = 'left';
          ctx.font = ckFont(Math.round(11 * k), '600');
          ctx.fillText(nav.name.toUpperCase(), labelX, labelY);
          ctx.font = ckFont(Math.round(10 * k), '500');
          ctx.fillText(formatNavDist(nav.dist), labelX, labelY + 10 * k);
          ctx.fillText(bearingLabel(nav.bearing), labelX, labelY + 20 * k);
        }
      }

      // Planet nicknames — nearest only (skip heavy loop when many bodies)
      ctx.textAlign = 'center';
      let labelCount = 0;
      for (const b of bodies) {
        if (nav.target === b) continue;
        if (labelCount >= 2) break;
        b.mesh.getWorldPosition(ckMapPos);
        const dist = ship.position.distanceTo(ckMapPos);
        if (dist > AU * 6) continue;
        const proj = projectPlanetOnHudGlass(b);
        if (!proj?.onGlass) continue;
        const lx = (proj.u * 0.5 + 0.5) * w;
        const ly = (-proj.v * 0.5 + 0.5) * h - 10;
        if (lx < 40 * k || lx > w - 40 * k || ly < 50 * k || ly > h - 80 * k) continue;
        const alpha = THREE.MathUtils.clamp(1.15 - dist / (AU * 5), 0.25, 0.85);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = cyan;
        ctx.font = ckFont(Math.round(11 * k), '600');
        ctx.fillText(b.data.name.toUpperCase(), lx, ly);
        ctx.font = ckFont(Math.round(10 * k), '500');
        ctx.fillStyle = soft;
        ctx.fillText(formatNavDist(dist), lx, ly + 10 * k);
        labelCount += 1;
      }
      ctx.globalAlpha = 1;

      // Left telemetry
      ctx.textAlign = 'left';
      ctx.fillStyle = cyan;
      ctx.font = ckFont(Math.round(13 * k), '600');
      ctx.fillText('СКОР', 28 * k, h - 118 * k);
      ctx.font = ckFont(Math.round(24 * k), '600');
      ctx.fillText(String(Math.round(hudSmooth.spd)), 28 * k, h - 92 * k);
      ctx.font = ckFont(Math.round(13 * k), '600');
      ctx.fillStyle = (nav.inAtmo || focusedBody) ? '#9cffc0' : cyan;
      ctx.fillText('ВЫСОТА', 28 * k, h - 68 * k);
      ctx.font = ckFont(Math.round(17 * k), '600');
      if (nav.target || focusedBody) {
        const altBody = focusedBody || nav.target;
        const altNow = (focusedBody || nav.inAtmo)
          ? getSurfaceAltitude(altBody, ship.position)
          : nav.alt;
        ctx.fillText(formatAltitude(altNow), 28 * k, h - 48 * k);
      } else {
        ctx.fillText('—', 28 * k, h - 48 * k);
      }
      ctx.font = ckFont(Math.round(12 * k), '500');
      ctx.fillStyle = cyan;
      ctx.fillText(data.thrust ? 'ТЯГА ●' : 'ДРЕЙФ ○', 28 * k, h - 28 * k);
      if (data.warp > 0.05 || hudSmooth.warp > 0.05) {
        ctx.fillStyle = 'rgba(120,190,255,0.95)';
        ctx.fillText(`ГИПЕР ${(hudSmooth.warp * 100).toFixed(0)}%`, 28 * k, h - 12 * k);
      }

      // Right targeting block
      ctx.textAlign = 'right';
      ctx.fillStyle = cyan;
      ctx.font = ckFont(Math.round(13 * k), '600');
      ctx.fillText('ЦЕЛЬ', w - 28 * k, h - 96 * k);
      ctx.font = ckFont(Math.round(16 * k), '600');
      ctx.fillText(nav.target ? nav.name.toUpperCase() : '—', w - 28 * k, h - 72 * k);
      ctx.font = ckFont(Math.round(12 * k), '500');
      if (nav.target) {
        ctx.fillText(`ДИСТ ${formatNavDist(nav.dist)}`, w - 28 * k, h - 52 * k);
        ctx.fillText(`ВЫС  ${formatAltitude(nav.alt)}`, w - 28 * k, h - 36 * k);
        ctx.fillStyle = hudSmooth.lock > 0.88 ? ok : soft;
        ctx.fillText(hudSmooth.lock > 0.88 ? '● ЗАХВАТ' : '○ НАВЕДЕНИЕ', w - 28 * k, h - 18 * k);
      } else {
        ctx.fillText('ПОИСК…', w - 28 * k, h - 52 * k);
      }

      // Mini radar bottom-center (skip on phone — less clutter)
      if (!slim) {
        const rx = cx;
        const ry = h - 58 * k;
        const rr = 36 * k;
        ctx.strokeStyle = soft;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(rx, ry, rr, 0, Math.PI * 2);
        ctx.stroke();
        const sweep = (t * 2.1) % (Math.PI * 2);
        ctx.strokeStyle = 'rgba(80,220,255,0.55)';
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + Math.cos(sweep) * rr, ry + Math.sin(sweep) * rr);
        ctx.stroke();
        for (let i = 0, n = Math.min(5, data.nearest.length); i < n; i++) {
          const p = data.nearest[i];
          const rel = Math.min(p.dist / (AU * 3.5), 1);
          const ang = Math.atan2(p.z - data.shipZ, p.x - data.shipX);
          const pr = rel * rr * 0.9;
          ctx.fillStyle = p.isTarget ? warn : cyan;
          ctx.beginPath();
          ctx.arc(rx + Math.cos(ang) * pr, ry + Math.sin(ang) * pr, (p.isTarget ? 2.5 : 1.6) * k, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = soft;
        ctx.font = ckFont(Math.round(11 * k), '600');
        ctx.textAlign = 'center';
        ctx.fillText('РЛС', rx, ry + rr + 12 * k);
      }

      // Top status
      ctx.textAlign = 'left';
      ctx.fillStyle = soft;
      ctx.font = ckFont(Math.round(12 * k), '600');
      ctx.fillText(`SUN ${formatNavDist(data.sunDist)}`, 28 * k, 22 * k);
      ctx.textAlign = 'right';
      let rightTag = hudSmooth.warp > 0.12 ? 'WARP' : 'CRUISE';
      if (hyper.phase === 'align') rightTag = 'ALIGN';
      else if (hyper.phase === 'prep') rightTag = 'PREP';
      else if (navTablet.selected) rightTag = `NAV · ${navTablet.selected.data.name.slice(0, 8)}`;
      ctx.fillText(rightTag, w - 28 * k, 22 * k);

      // Bottom cue
      if (!slim) {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(120, 200, 255, 0.65)';
        ctx.font = ckFont(Math.round(12 * k), '600');
        ctx.fillText('M / NAV — карта и варп к орбите', cx, h - 18 * k);
      }
      ctx.globalAlpha = 1;
    }

    function paintOneCockpitScreen(scr, data, t) {
      const ctx = scr.ctx;
      if (!ctx) return;
      const { w, h } = ckScreenSize(scr);
      const nav = data.nav;

      switch (scr.role) {
        case 'hudGlass':
          paintCkHudGlass(ctx, w, h, data, t);
          break;
        case 'map':
          paintCkMap(ctx, w, h, data, t, false);
          break;
        case 'briefing':
          paintCkBriefing(ctx, w, h, data, t);
          break;
        default:
          ckFillGrid(ctx, w, h);
          ckDrawLines(ctx, [scr.role, nav.name], 8, 20, 16, 10);
      }

      // Intro power-on: CRT scan / boot flash over panels + HUD
      const boot = (wake && wake.active && (wake.phase === 'boot' || wake.phase === 'power'))
        ? THREE.MathUtils.clamp(wake.age / 2.2, 0, 1)
        : (scr._bootFlash || 0);
      if (boot > 0 && boot < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - boot;
        ctx.fillStyle = '#031018';
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = Math.min(1, (1 - boot) * 1.4);
        ctx.fillStyle = '#5ad0ff';
        ctx.font = `bold ${Math.max(12, h * 0.08)}px monospace`;
        ctx.fillText('SYS BOOT…', 12, h * 0.45);
        ctx.fillStyle = 'rgba(90,208,255,0.55)';
        ctx.fillRect(12, h * 0.55, w * boot * 0.7, 3);
        // scanline
        ctx.globalAlpha = 0.15 * (1 - boot);
        ctx.fillStyle = '#fff';
        const sy = ((t * 90) % h);
        ctx.fillRect(0, sy, w, 2);
        ctx.restore();
        scr._bootFlash = 1 - boot;
      } else {
        scr._bootFlash = 0;
      }

      scr.tex.needsUpdate = true;
      scr._sig = scr._pendingSig;
    }

    /** HUD fingerprint — uses smoothed values; avoids full-GPU upload every frame */
    function hudGlassSig(data, t) {
      const nav = data.nav;
      const atmoSig = atmoFx.active
        ? `${Math.round(atmoFx.depth * 12)}|${Math.round(atmoFx.heat * 12)}`
        : '0';
      return [
        nav.name,
        Math.round(hudSmooth.heading * 20) / 20,
        Math.round(hudSmooth.spd),
        Math.round(hudSmooth.bracketX),
        Math.round(hudSmooth.bracketY),
        hudSmooth.bracketValid ? 1 : 0,
        Math.round(hudSmooth.lock * 40) / 40,
        Math.round(hudSmooth.warp * 60) / 60,
        Math.floor(t * 30),
        data.thrust ? 1 : 0,
        Math.round(data.shipX / (AU * 0.03)),
        Math.round(data.shipZ / (AU * 0.03)),
        hyper.phase || '',
        atmoSig,
        wake?.phase || '',
      ].join('|');
    }

    /** Stable fingerprint — only reupload GPU when nav/map state actually moves */
    function cockpitScreenSig(role, data, t) {
      const nav = data.nav;
      const pulse = Math.floor(t * 1.5); // soft scanline blink ~1.5 Hz
      if (role === 'map') {
        const sx = Math.round(data.shipX / (AU * 0.04));
        const sz = Math.round(data.shipZ / (AU * 0.04));
        const sel = navTablet.selected?.data?.name || nav.name;
        return `m|${sel}|${sx}|${sz}|${data.warp > 0.12 ? 1 : 0}|${Math.round(data.sunDist / AU * 8)}|${pulse}`;
      }
      if (role === 'briefing') {
        return `b|${nav.name}|${Math.round(nav.dist / Math.max(1, EARTH_R))}|${nav.bearing.toFixed(0)}|${nav.spd}|${nav.inAtmo ? 1 : 0}|${data.thrust ? 1 : 0}|${pulse}`;
      }
      return hudGlassSig(data, t);
    }

    /** Paint cockpit screens — HUD: smooth every frame, upload ~28 Hz max */
    function paintCockpitScreens(t, dt = 1 / 60) {
      if (!ckScreens.length || document.body.classList.contains('landed') || !cockpitRoot?.visible) return;

      // Power dead → blank glass / hide consoles (no further canvas work)
      if (!isShipPowered()) {
        hudSmooth.inited = false;
        hudSmooth.bracketValid = false;
        const glass = cockpitRoot.userData.hudGlass;
        if (glass) glass.visible = false;
        for (const scr of ckScreens) {
          if (scr.role === 'hudGlass') continue;
          if (scr.panel) scr.panel.visible = false;
          if (scr.ctx && !scr._poweredOff) {
            scr.ctx.save();
            scr.ctx.setTransform(1, 0, 0, 1, 0, 0);
            scr.ctx.fillStyle = '#000006';
            scr.ctx.fillRect(0, 0, scr.canvas.width, scr.canvas.height);
            scr.ctx.restore();
            scr.tex.needsUpdate = true;
            scr._poweredOff = true;
            scr._sig = '';
          }
        }
        return;
      }

      const hudActive = shouldShowHudGlass();
      ckRound += 1;
      if (hudActive || !ckDataCache || (ckRound & 3) === 0) {
        getCockpitData();
      }
      const data = ckDataCache;
      if (!data) return;

      for (const scr of ckScreens) {
        scr._poweredOff = false;
        if (scr.role === 'hudGlass') {
          if (!hudActive) {
            hudSmooth.bracketValid = false;
            continue;
          }
          const { w: ckW, h: ckH } = ckScreenSize(scr);
          updateHudSmooth(data.nav, data, dt, ckW, ckH);
          // Full-rate HUD paint (smooth). Quality is low-DPI — not Hz.
          const sig = hudGlassSig(data, t);
          if (sig === scr._sig) continue;
          scr._pendingSig = sig;
          paintOneCockpitScreen(scr, data, t);
          continue;
        }
        if (scr.panel) scr.panel.visible = true;
        const sig = cockpitScreenSig(scr.role, data, t);
        if (sig === scr._sig) continue;
        scr._pendingSig = sig;
        paintOneCockpitScreen(scr, data, t);
      }
    }

    beginWakeSequence();

    // Finish progress behind the wake lids: aft cabin + shader compile (no first-F frezes)
    // Splash stays at least 7s with Calamity Space logo
    (async () => {
      try {
        if (loadStatus) loadStatus.textContent = 'Подготовка корабля…';
        if (typeof ensureHabitation === 'function') {
          ensureHabitation({ keepSealed: true });
        }
        prefetchEngineAudio();
        try {
          await fetch(`${SND}engine-ambient.mp3`, { credentials: 'same-origin' });
        } catch (_) {}

        const wasVis = cockpitRoot.visible;
        cockpitRoot.visible = true;
        flightSession = true;
        if (typeof getCockpitData === 'function') getCockpitData();
        if (typeof ckScreens !== 'undefined' && ckDataCache) {
          for (const scr of ckScreens) {
            try {
              scr._pendingSig = 'warm';
              paintOneCockpitScreen(scr, ckDataCache, 0);
            } catch (_) {}
          }
        }
        if (loadStatus) loadStatus.textContent = 'Компиляция шейдеров…';
        if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
        else renderer.compile(scene, camera);
        composer.render();
        cockpitRoot.visible = wasVis;
        syncCockpitVisibility();
      } catch (err) {
        console.warn('[Solar] GPU warm failed', err);
      } finally {
        await finishSplash('Приятного полёта');
      }
    })();

    renderer.setAnimationLoop(() => {
      try {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      if (sunMat) sunMat.uniforms.time.value = t;
      const simDt = dt * timeScale;

      paintCockpitScreens(t, dt);
      if (navTablet.open) paintNavTablet();

      sunMesh.rotation.y += simDt * 0.04;
      sunGlow.material.opacity = 0.88 + Math.sin(t * 1.1) * 0.1;

      // Freeze solar orbits while in atmosphere / on surface
      const pauseOrbits = !!landed || !!focusedBody;
      if (!pauseOrbits && simDt > 0) {
        for (const b of bodies) {
          b.angle += simDt * b.speed * ORBIT_EARTH_OMEGA;
          b.pivot.rotation.y = b.angle;
          b.mesh.rotation.y += simDt * b.spin * SPIN_EARTH_OMEGA;
          if (b.mesh.userData.clouds) {
            // Clouds drift slightly faster than planetary surface
            b.mesh.userData.clouds.rotation.y += simDt * b.spin * SPIN_EARTH_OMEGA * 1.08;
          }
          for (const moonMesh of b.moons) {
            const ud = moonMesh.userData;
            ud.angle += simDt * ud.orbitSpeed;
            placeMoonOnOrbit(b, moonMesh);
            moonMesh.rotation.y += simDt * Math.sign(ud.periodDay || 1) * SPIN_EARTH_OMEGA * 0.35;
          }
        }
        asteroids.rotation.y += simDt * ORBIT_EARTH_OMEGA * (1 / 4.5);
      } else if (focusedBody) {
        // Still spin the focused planet at its real relative day rate
        const spinDt = dt * Math.max(timeScale, 0.15);
        focusedBody.mesh.rotation.y += spinDt * focusedBody.spin * SPIN_EARTH_OMEGA;
        if (focusedBody.mesh.userData.clouds) {
          focusedBody.mesh.userData.clouds.rotation.y += spinDt * focusedBody.spin * SPIN_EARTH_OMEGA * 1.05;
        }
        for (const moonMesh of focusedBody.moons) {
          placeMoonOnOrbit(focusedBody, moonMesh);
          moonMesh.rotation.y += spinDt * SPIN_EARTH_OMEGA * 0.35;
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
      updateWake(dt);
      updateFlight(dt);
      updateWarpFx(dt);
      updateEngineAudio(dt);
      updateLocalLighting();
      updateInfo();
      // Skip bloom pass when disabled (EffectComposer still runs other passes)
      composer.render();
      } catch (err) {
        console.error('[solar-frame]', err);
        if (modeEl) modeEl.textContent = 'Ошибка: ' + (err && err.message ? err.message : err);
      }
    });
