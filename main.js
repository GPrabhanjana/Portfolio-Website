import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';

/* ============================================================
   TUNABLE CONSTANTS  — tweak these to taste
   ============================================================ */
const ASSEMBLE_SCROLL_PX = 600;   // scroll distance over which the bunny collapses & the brain grows (~5 wheel notches)
const BUNNY_MAX_EXPLODE  = 55;    // radial blow-out at the very top (large enough to sit off-screen)
const ROTATION_TURNS     = 3;     // full rotations by page end — SHARED by bunny + brain (kept in sync)
const FADE_HALF          = 0.5;   // fraction of the assemble window over which they fade from invisible to fully visible
const BUNNY_STIFFNESS    = 0.012; // spring toward target — lower = slower, gentler, more stable collapse
const BUNNY_DAMPING      = 0.955; // closer to 1 = momentum carries longer, so it settles over a slightly longer time

const REPEL_RADIUS       = 14;    // world reach of each piece's force field (slightly larger than the old 12)
const REPEL_PUSH         = 4.5;   // impulse strength added per frame while in range
const REPEL_RETURN       = 0.045; // home-spring stiffness (ALWAYS on — this is the anti-bop fix); lower = more momentum
const REPEL_DAMPING      = 0.88;  // velocity damping — closer to 1 = momentum lingers, settles over a longer time
const BRAIN_MAX_SCALE    = 3.5;   // final brain scale

const TIME_SCALE       = 0.75;
const BUNNY_DAMPING_T  = Math.pow(BUNNY_DAMPING, TIME_SCALE); // damping per scaled step
const REPEL_DAMPING_T  = Math.pow(REPEL_DAMPING, TIME_SCALE);

// Inward collapse limit — triangles may never sink past a shell at HALF the
// bunny's radius. This stops the "collapses too fast and inverts" glitch on a
// fast scroll. Instead of dead-stopping (which killed the bounce) the piece
// REBOUNDS off the shell, keeping the animation lively/dynamic.
const BUNNY_INNER_FRACTION = 0.5; // 0.5 = half the bunny size
const BUNNY_BOUNCE          = 0.6; // restitution when a piece hits the inner shell (0 = dead stop, 1 = perfect bounce)

// Brain neurons — fire around the pointer when the brain is exposed: much
// brighter right at the point of contact, then a quick fall-off with distance.
const BRAIN_NEURON_RADIUS  = 0.32; // hotspot radius in NDC/screen units (localised spot under the cursor)
const BRAIN_NEURON_FALLOFF = 3.5; // higher => quicker fall-off away from the contact point
const BRAIN_NEURON_BOOST   = 3.0; // peak brightness multiplier at the contact point (x3)

// Intro text (name + the two small lines). Grouped so it can be scaled to fit
// any viewport width (portrait included) and lifted/faded out on scroll.
const INTRO_LIFT         = 0.03;  // upward drift per scrolled pixel
const INTRO_FADE_VH      = 0.85;  // name is fully gone after this fraction of one viewport of scroll
const THANK_FADE_VH      = 0.9;   // thank-you fades in over this fraction of a viewport near the very bottom
const TEXT_FIT_FRACTION  = 0.92;  // how much of the visible width the widest text line may occupy

// Brain scale smoothing state
let targetBrainScale = 0;
let currentBrainScale = 0;
const brainScaleLerpFactor = 0.1;

// Scene / camera / renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#bg'),
    antialias: true,
    powerPreference: "high-performance"
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
camera.position.setZ(30);
scene.background = new THREE.Color(0x000000);

// Post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.23, 0.2, 0.25
);
composer.addPass(bloomPass);

const chromaticAberrationShader = {
    uniforms: {
        tDiffuse: { value: null },
        uOffset: { value: new THREE.Vector2(0.0015, 0.0015) }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uOffset;
        varying vec2 vUv;
        void main() {
            vec4 cr = texture2D(tDiffuse, vUv + uOffset);
            vec4 cg = texture2D(tDiffuse, vUv);
            vec4 cb = texture2D(tDiffuse, vUv - uOffset);
            gl_FragColor = vec4(cr.r, cg.g, cb.b, cg.a);
        }
    `
};
composer.addPass(new ShaderPass(chromaticAberrationShader));

// Brain point-cloud shader — neurons fire around the pointer. A neuron only
// lights up when its own random blink window is open AND it sits near the
// pointer, brightest at the pointer and dimming slowly outward. No pointer =>
// no firing (it is not always-on).
//
// Which hemisphere fires is decided ENTIRELY by the facing gate below
// (view-space normal vs. view direction), NOT by depth/render order. That is
// the whole point: the point cloud's material has depthTest:false /
// depthWrite:false, so nothing can occlude a point out of firing based on the
// order it happens to be drawn. Combined with the facing gate this makes the
// effect fully rotation-correct — no 180° flip.
const brainVertexShader = `
varying vec3 vPosition;
varying float vFire;
varying float vBoost;
uniform float uTime;
uniform vec2  uCursor;
uniform float uAspect;
uniform float uPointerActive;
uniform float uRadius;
uniform float uFalloff;
float random(vec3 pos)  { return fract(sin(dot(pos.xyz, vec3(12.9898,78.233,45.164))) * 43758.5453123); }
float random2(vec3 pos) { return fract(sin(dot(pos.zyx, vec3(45.164,78.233,12.9898))) * 43758.5453123); }
void main() {
    vPosition = position;
    float rand1 = random(position);
    float rand2 = random2(position);
    float randomFrequency = mix(2.0, 4.0, rand1);
    float randomPhase = rand2 * 10.0;
    float firingTime = mod(uTime * randomFrequency + randomPhase, 5.0);
    float blink = step(4.6, firingTime) * rand1;

    vec4 mv   = modelViewMatrix * vec4(position, 1.0);
    vec4 clip = projectionMatrix * mv;
    gl_Position = clip;

    // --- screen-space proximity to the cursor ---
    vec2 ndc = clip.xy / clip.w;
    vec2 diff = ndc - uCursor;
    diff.x *= uAspect;
    float d = length(diff);
    float prox = clamp(1.0 - d / uRadius, 0.0, 1.0);

    // --- facing gate: only points whose surface faces the camera may fire ---
    // Everything is in VIEW space: the camera sits at the origin, so the
    // direction to the camera from a point is just -normalize(viewPos). The
    // normal is rotated into view space by normalMatrix. dot > 0 => faces us.
    //
    // NOTE: if you ever see ONLY the back firing at EVERY rotation (a constant
    // wrong side, no flip), this mesh's normals are wound inward — flip the
    // gate by negating the dot: smoothstep(-0.05, 0.25, -dot(n, toCam)).
    vec3 n     = normalize(normalMatrix * normal);
    vec3 toCam = normalize(-mv.xyz);
    float facing = smoothstep(-0.05, 0.25, dot(n, toCam)); // 1 = faces camera, 0 = away

    vFire  = blink * prox * uPointerActive * facing;
    vBoost = pow(prox, uFalloff) * uPointerActive * facing;

    gl_PointSize = vFire * 6.0 * (1.0 + vBoost);
}
`;

const brainFragmentShader = `
varying vec3 vPosition;
varying float vFire;
varying float vBoost;
uniform float uOpacity;
uniform float uBoost;   // peak brightness multiplier at the contact point (x3)
void main() {
    vec3 firingColor = vec3(0.0, 1.0, 1.0);
    float lit = clamp(vFire * 15.0, 0.0, 1.0);     // a firing neuron reads as full cyan (like before)
    float m = 1.0 + (uBoost - 1.0) * vBoost;        // 1 normally, up to x3 right at the contact point
    vec3 finalColor = firingColor * lit * m;
    float fresnel = pow(1.0 - dot(normalize(vPosition), vec3(0.0, 0.0, 1.0)), 1.4) * 0.6;
    finalColor += vec3(0.1) * fresnel;
    gl_FragColor = vec4(finalColor, clamp(lit * m, 0.0, 1.0) * uOpacity);
}
`;

/* ============================================================
   STATE
   ============================================================ */
let brainMesh;            // { base, points }
let scrollY = 0;

// Single-mesh bunny + its per-triangle buffers
let bunny = null;
let bunnyData = null;     // { numTri, basePos, livePos, centroids, dirs, offsets, lowerBounds }
let lastScrollExplode = -1;
let bunnySettled = false;

// Intro text (name + two small lines), grouped for responsive scaling + fade
let introGroup = null;
let introMaxWidth = 1;    // widest natural line width, for fit-to-width scaling
let nameMat, helloMat, welcomeMat, thankMat;
let thankMaxWidth = 1;

// Pointer (shared by mouse + touch). pointerActive is false when the cursor
// leaves or a touch lifts, so influences always relax back to the rest state.
const mouse = new THREE.Vector2();
const pointerWorld = new THREE.Vector3();
const tmpNDC = new THREE.Vector3();
const invBunnyMat = new THREE.Matrix4(); // bunny world->local, for cursor-repel
const cursorLocal = new THREE.Vector3();
let pointerActive = false;

window.addEventListener('scroll', () => { scrollY = window.scrollY; }, { passive: true });

/* ============================================================
   BUNNY — one mesh, one geometry, one material.
   Each triangle is rigidly translated outward along its own radial
   direction by `offsets[t]`. Because the translation is rigid, the
   normals computed once stay valid (no per-frame recompute).
   ============================================================ */
const objLoader = new OBJLoader();
objLoader.load('./bunn(1).obj', (object) => {
    const src = object.children[0].geometry.getAttribute('position').array;
    const SCALE = 2.8;
    const numTri = Math.floor(src.length / 9);

    const basePos   = new Float32Array(numTri * 9);
    const centroids = new Float32Array(numTri * 3);
    const dirs      = new Float32Array(numTri * 3);
    const offsets   = new Float32Array(numTri);
    const vels      = new Float32Array(numTri); // per-triangle spring velocity

    // scaled vertices + per-triangle centroid
    let bx = 0, by = 0, bz = 0;
    for (let t = 0; t < numTri; t++) {
        const i9 = t * 9;
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 9; k++) basePos[i9 + k] = src[i9 + k] * SCALE;
        for (let v = 0; v < 3; v++) {
            cx += basePos[i9 + v * 3];
            cy += basePos[i9 + v * 3 + 1];
            cz += basePos[i9 + v * 3 + 2];
        }
        cx /= 3; cy /= 3; cz /= 3;
        const i3 = t * 3;
        centroids[i3] = cx; centroids[i3 + 1] = cy; centroids[i3 + 2] = cz;
        bx += cx; by += cy; bz += cz;
    }
    bx /= numTri; by /= numTri; bz /= numTri; // bunny center

    // radial explosion direction per triangle (from bunny center outward),
    // plus each triangle's resting distance from the centre (rBase).
    const rBase = new Float32Array(numTri);
    let maxRadius = 0;
    for (let t = 0; t < numTri; t++) {
        const i3 = t * 3;
        let dx = centroids[i3] - bx, dy = centroids[i3 + 1] - by, dz = centroids[i3 + 2] - bz;
        let len = Math.hypot(dx, dy, dz);
        rBase[t] = len;
        if (len > maxRadius) maxRadius = len;
        if (len < 1e-4) { dx = 0; dy = 1; dz = 0; len = 1; } // center triangles get a default up-direction
        dirs[i3] = dx / len; dirs[i3 + 1] = dy / len; dirs[i3 + 2] = dz / len;
    }

    // Inward limit: a piece's distance from the centre may never drop below a
    // shell at HALF the bunny's radius. Since a piece's radius after offset is
    // (rBase + off), that means off >= minRadius - rBase. We cap with min(0, …)
    // so the limit only catches inward overshoot and never disturbs the solid
    // resting shape (where every off settles at 0).
    const minRadius = maxRadius * BUNNY_INNER_FRACTION;
    const lowerBounds = new Float32Array(numTri);
    for (let t = 0; t < numTri; t++) {
        lowerBounds[t] = Math.min(0, minRadius - rBase[t]);
    }

    // Per-triangle cursor-repel displacement (local space) + its spring velocity.
    const repel    = new Float32Array(numTri * 3);
    const repelVel = new Float32Array(numTri * 3);

    // start fully blown out so the page opens with the bunny off-screen
    offsets.fill(BUNNY_MAX_EXPLODE);

    const livePos = basePos.slice();
    for (let t = 0; t < numTri; t++) {
        const i9 = t * 9, i3 = t * 3, o = offsets[t];
        const ox = dirs[i3] * o, oy = dirs[i3 + 1] * o, oz = dirs[i3 + 2] * o;
        for (let v = 0; v < 3; v++) {
            livePos[i9 + v * 3]     = basePos[i9 + v * 3]     + ox;
            livePos[i9 + v * 3 + 1] = basePos[i9 + v * 3 + 1] + oy;
            livePos[i9 + v * 3 + 2] = basePos[i9 + v * 3 + 2] + oz;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(livePos, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.7, transparent: true, opacity: 0 });
    bunny = new THREE.Mesh(geometry, material);
    bunny.position.set(0, -6, 0);
    scene.add(bunny);

    bunnyData = { numTri, basePos, livePos, centroids, dirs, offsets, vels, lowerBounds, repel, repelVel };
});

/* ============================================================
   BRAIN — base mesh + animated point cloud (two meshes total)
   ============================================================ */
objLoader.load('./brain.obj', (object) => {
    object.traverse((child) => {
        if (!child.isMesh) return;
        const geometry = child.geometry;
        geometry.computeVertexNormals(); // needed by the point cloud's facing gate

        const meshMaterial = new THREE.MeshStandardMaterial({
            color: 0x555555, metalness: 0.6, roughness: 0.4, transparent: true, opacity: 0, depthWrite: false
        });
        const brainMeshBase = new THREE.Mesh(geometry, meshMaterial);
        brainMeshBase.scale.set(0, 0, 0);
        brainMeshBase.position.set(0, -8, 0);
        brainMeshBase.renderOrder = 0;
        scene.add(brainMeshBase);

        // Which hemisphere fires is decided by the facing gate in the shader,
        // NOT by depth. So the points must NOT depth-test or depth-write —
        // otherwise draw/render order can occlude firing points inconsistently
        // as the mesh rotates, which is what caused the sharp flip at 180°.
        const pointsMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTime:          { value: 0 },
                uOpacity:       { value: 0 },
                uCursor:        { value: new THREE.Vector2(0, 0) },
                uAspect:        { value: window.innerWidth / window.innerHeight },
                uPointerActive: { value: 0 },
                uRadius:        { value: BRAIN_NEURON_RADIUS },
                uFalloff:       { value: BRAIN_NEURON_FALLOFF },
                uBoost:         { value: BRAIN_NEURON_BOOST }
            },
            vertexShader: brainVertexShader,
            fragmentShader: brainFragmentShader,
            transparent: true,
            depthWrite: false,  // never write depth — no order-dependent self-occlusion
            depthTest: false    // never test depth — firing is decided by the facing gate alone
        });
        const brainPoints = new THREE.Points(geometry, pointsMaterial);
        brainPoints.scale.set(0, 0, 0);
        brainPoints.position.set(0, -8, 0);
        brainPoints.renderOrder = 1;
        scene.add(brainPoints);

        brainMesh = { base: brainMeshBase, points: brainPoints };
    });
});

/* ============================================================
   TEXT — curveSegments/bevelSegments trimmed to cut triangle count
   ============================================================ */
let textMesh, smallTextMesh, smallTextMesh2, thankYouMesh;

const fontLoader = new FontLoader();
fontLoader.load('https://threejs.org/examples/fonts/helvetiker_bold.typeface.json', (font) => {
    const heavy = { font, curveSegments: 12, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.02, bevelSegments: 3 };
    const light = { font, curveSegments: 10, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.01, bevelSegments: 3 };

    const textMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, metalness: 1, roughness: 0.2
    });
    const smallTextMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6, metalness: 1, roughness: 0.2
    });

    // Independent material clones so the intro can fade out without touching
    // the (separate) thank-you text that reuses textMaterial.
    nameMat = textMaterial.clone();    nameMat.transparent = true;
    helloMat = smallTextMaterial.clone();   helloMat.transparent = true;
    welcomeMat = smallTextMaterial.clone(); welcomeMat.transparent = true;

    const widthOf = (g) => { g.computeBoundingBox(); return g.boundingBox.max.x - g.boundingBox.min.x; };

    // ---- Intro group (name + the two small lines), centred at origin ----
    introGroup = new THREE.Group();
    introGroup.position.z = -14;

    const g1 = new TextGeometry("G PRABHANJANA", { ...heavy, size: 11, depth: 0.2 });
    g1.center();
    textMesh = new THREE.Mesh(g1, nameMat);
    textMesh.position.set(0, 0, 0);
    introGroup.add(textMesh);

    const g2 = new TextGeometry("Hello, I am", { ...light, size: 5.5, depth: 0.1 });
    g2.center();
    smallTextMesh = new THREE.Mesh(g2, helloMat);
    smallTextMesh.position.set(0, 10, -3);     // above the name
    introGroup.add(smallTextMesh);

    const g3 = new TextGeometry("Welcome to my portfolio website!", { ...light, size: 4.5, depth: 0.1 });
    g3.center();
    smallTextMesh2 = new THREE.Mesh(g3, welcomeMat);
    smallTextMesh2.position.set(0, -10, -3);   // below the name
    introGroup.add(smallTextMesh2);

    scene.add(introGroup);

    // widest line drives the fit-to-width scale so nothing clips in portrait
    introMaxWidth = Math.max(widthOf(g1), widthOf(g2), widthOf(g3), 1);

    // ---- Thank-you text (separate, rises from below at the very end) ----
    thankMat = textMaterial.clone(); thankMat.transparent = true; thankMat.opacity = 0;
    const gThanks = new TextGeometry("THANKS FOR\nSTOPPING BY!", { ...heavy, size: 10, depth: 0.2 });
    gThanks.center();
    thankYouMesh = new THREE.Mesh(gThanks, thankMat);
    thankYouMesh.position.z = -14;
    thankYouMesh.position.y = -20;
    scene.add(thankYouMesh);
    thankMaxWidth = Math.max(widthOf(gThanks), 1);

    applyResponsiveText();
});

/* ============================================================
   RESPONSIVE TEXT — scales the intro group and thank-you text so the
   widest line fits the visible width. Capped at 1 so landscape keeps its
   original design size; in portrait it shrinks to sit edge-to-edge.
   ============================================================ */
function visibleWidthAt(zPlane) {
    const fov = camera.fov * Math.PI / 180;
    const dist = camera.position.z - zPlane;
    const visH = 2 * Math.tan(fov / 2) * dist;
    return visH * camera.aspect;
}

function applyResponsiveText() {
    if (introGroup) {
        const target = visibleWidthAt(introGroup.position.z) * TEXT_FIT_FRACTION;
        const s = Math.min(target / introMaxWidth, 1);
        introGroup.scale.setScalar(s);
    }
    if (thankYouMesh) {
        const target = visibleWidthAt(thankYouMesh.position.z) * TEXT_FIT_FRACTION;
        const s = Math.min(target / thankMaxWidth, 1);
        thankYouMesh.scale.setScalar(s);
    }
}

function setIntroOpacity(o) {
    if (nameMat)    nameMat.opacity = o;
    if (helloMat)   helloMat.opacity = o;
    if (welcomeMat) welcomeMat.opacity = o;
}

/* ============================================================
   LIGHTS
   ============================================================ */
scene.add(new THREE.AmbientLight(0x8f8d78, 12));

const dirLight1 = new THREE.DirectionalLight(0x0044ff, 3);
dirLight1.position.set(-100, 40, -10);
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0xff7700, 3);
dirLight2.position.set(100, -40, -10);
scene.add(dirLight2);

/* ============================================================
   POINTER (mouse + touch, unified)
   ============================================================ */
function setPointer(clientX, clientY) {
    mouse.x =  (clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;
    tmpNDC.set(mouse.x, mouse.y, 0.5).unproject(camera);
    const dir = tmpNDC.sub(camera.position).normalize();
    const dist = -camera.position.z / dir.z;
    pointerWorld.copy(camera.position).add(dir.multiplyScalar(dist));
}

// Mouse
window.addEventListener('mousemove', (e) => { pointerActive = true; setPointer(e.clientX, e.clientY); });
window.addEventListener('mouseleave', () => { pointerActive = false; });
// Touch — crucially, lifting the finger clears the influence (no stuck hover)
window.addEventListener('touchstart', (e) => { pointerActive = true; const t = e.touches[0]; setPointer(t.clientX, t.clientY); }, { passive: true });
window.addEventListener('touchmove',  (e) => { pointerActive = true; const t = e.touches[0]; setPointer(t.clientX, t.clientY); }, { passive: true });
window.addEventListener('touchend',    () => { pointerActive = false; }, { passive: true });
window.addEventListener('touchcancel', () => { pointerActive = false; }, { passive: true });

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    applyResponsiveText();
});

/* ============================================================
   ANIMATION
   ============================================================ */
function animate() {
    requestAnimationFrame(animate);

    const scrollableHeight = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const scrollFraction = scrollY / scrollableHeight;          // 0 top → 1 bottom
    const assemble = Math.min(scrollY / ASSEMBLE_SCROLL_PX, 1); // 0 top → 1 once collapsed

    // Fade-in: invisible at the top, fully visible by the halfway point of the assemble window
    const appear = Math.min(assemble / FADE_HALF, 1);

    // Shared rotation: stays 0 until fully solidified (assemble === 1), then turns
    // ROTATION_TURNS times by the bottom of the page. Bunny + brain use this same value.
    const rotateProgress = (scrollableHeight > ASSEMBLE_SCROLL_PX)
        ? Math.min(Math.max((scrollY - ASSEMBLE_SCROLL_PX) / (scrollableHeight - ASSEMBLE_SCROLL_PX), 0), 1)
        : 0;
    const rotation = rotateProgress * Math.PI * 2 * ROTATION_TURNS;

    // When the pointer is gone, ease the mouse-driven tilt back to neutral
    if (!pointerActive) { mouse.x += (0 - mouse.x) * 0.1; mouse.y += (0 - mouse.y) * 0.1; }

    // ---- Intro text: lifts and fades out on scroll, so the name is gone
    //      before any section/info text scrolls into view (portrait included) ----
    if (introGroup) {
        introGroup.position.y = scrollY * INTRO_LIFT;
        introGroup.position.x = -mouse.x;
        introGroup.rotation.x = mouse.y * 0.05;
        introGroup.rotation.y = mouse.x * 0.05;

        const fadeRange = Math.max(window.innerHeight * INTRO_FADE_VH, 1);
        const introFade = 1 - Math.min(scrollY / fadeRange, 1);
        setIntroOpacity(introFade);
        introGroup.visible = introFade > 0.001;
    }
    if (thankYouMesh) {
        thankYouMesh.position.y = -220 + scrollFraction * 220;
        thankYouMesh.position.x = -mouse.x;
        thankYouMesh.rotation.x = mouse.y * 0.05;
        thankYouMesh.rotation.y = mouse.x * 0.05;

        // Same idea as the name: fade based on scroll so it never overlaps the
        // section text. Here it fades IN only in the last stretch near the very
        // bottom, so it stays clear of the Contact section (which sits above it).
        const distFromBottom = scrollableHeight - scrollY;
        const thankRange = Math.max(window.innerHeight * THANK_FADE_VH, 1);
        const thankFade = 1 - Math.min(distFromBottom / thankRange, 1);
        if (thankMat) thankMat.opacity = thankFade;
        thankYouMesh.visible = thankFade > 0.001;
    }

    // ---- Brain: grows + fades over the assemble window, rotates in sync with the bunny ----
    if (brainMesh) {
        targetBrainScale = assemble * BRAIN_MAX_SCALE;
        currentBrainScale += (targetBrainScale - currentBrainScale) * brainScaleLerpFactor;
        const s = currentBrainScale * 1.1;
        brainMesh.base.scale.setScalar(s * 0.99);
        brainMesh.points.scale.setScalar(s);

        brainMesh.base.rotation.y = rotation;       // synced with bunny
        brainMesh.points.rotation.y = rotation;

        brainMesh.base.material.opacity = 0.9 * appear;            // fade base in (0.9 is its design opacity)
        const bu = brainMesh.points.material.uniforms;
        bu.uOpacity.value = appear;                 // fade point cloud in
        bu.uTime.value += 0.1;
        // Hover firing tracks the cursor in SCREEN space. Eased presence so it fades in/out.
        const brainTargetActive = pointerActive ? 1 : 0;
        bu.uPointerActive.value += (brainTargetActive - bu.uPointerActive.value) * 0.15;
        bu.uCursor.value.set(mouse.x, mouse.y);
        bu.uAspect.value = window.innerWidth / window.innerHeight;
    }

    // ---- Bunny: scroll collapses it; the cursor shoves nearby pieces AWAY ----
    if (bunnyData) {
        bunny.rotation.y = rotation;            // 0 until solid, then 3 turns — in sync with the brain
        bunny.material.opacity = appear;        // invisible at top, fully visible by half the assemble window

        const scrollExplode = (1 - assemble) * BUNNY_MAX_EXPLODE; // rest target — the snap-back state
        const scrollChanged = Math.abs(scrollExplode - lastScrollExplode) > 1e-4;

        // Skip the whole loop when nothing can change (idle + settled)
        if (pointerActive || scrollChanged || !bunnySettled) {
            bunny.updateMatrixWorld();
            // Cursor into the bunny's LOCAL frame, so the repel is computed
            // entirely in local space (cheap, and rotation-correct).
            invBunnyMat.copy(bunny.matrixWorld).invert();
            cursorLocal.copy(pointerWorld).applyMatrix4(invBunnyMat);

            const { numTri, basePos, livePos, centroids, dirs, offsets, vels, lowerBounds, repel, repelVel } = bunnyData;

            bunnySettled = true;
            for (let t = 0; t < numTri; t++) {
                const i3 = t * 3;

                // --- Collapse spring (radial): assemble on scroll, rebound off
                //     the inner shell so a fast scroll can't invert the mesh ---
                let off = offsets[t];
                let vel = vels[t];
                vel += (scrollExplode - off) * BUNNY_STIFFNESS * TIME_SCALE;
                vel *= BUNNY_DAMPING_T;
                off += vel * TIME_SCALE;
                const lb = lowerBounds[t];
                if (off < lb) { off = lb; if (vel < 0) vel = -vel * BUNNY_BOUNCE; }
                offsets[t] = off;
                vels[t] = vel;
                if (Math.abs(scrollExplode - off) > 0.01 || Math.abs(vel) > 0.01) bunnySettled = false;

                // --- Cursor force field (impulse based, like the old code):
                //     each piece is KICKED away from the cursor and carries
                //     momentum. The home spring is applied every frame (not just
                //     outside the radius), so a still cursor reaches equilibrium
                //     and settles instead of bopping forever. Distance uses the
                //     piece's CURRENT position, so the motion stays lively ---
                let rx = repel[i3],    ry = repel[i3 + 1],    rz = repel[i3 + 2];
                let vx = repelVel[i3], vy = repelVel[i3 + 1], vz = repelVel[i3 + 2];

                if (pointerActive) {
                    const cxL = centroids[i3]     + dirs[i3]     * off + rx;
                    const cyL = centroids[i3 + 1] + dirs[i3 + 1] * off + ry;
                    const czL = centroids[i3 + 2] + dirs[i3 + 2] * off + rz;
                    const ax = cxL - cursorLocal.x, ay = cyL - cursorLocal.y, az = czL - cursorLocal.z;
                    const dist = Math.sqrt(ax*ax + ay*ay + az*az);
                    if (dist < REPEL_RADIUS && dist > 1e-4) {
                        const infl = 1 - dist / REPEL_RADIUS;
                        const impulse = REPEL_PUSH * infl * infl / dist; // quadratic falloff, like the old code
                        vx += ax * impulse * TIME_SCALE; vy += ay * impulse * TIME_SCALE; vz += az * impulse * TIME_SCALE;
                    }
                }

                // home spring (ALWAYS) + damping + integrate
                vx += -rx * REPEL_RETURN * TIME_SCALE; vy += -ry * REPEL_RETURN * TIME_SCALE; vz += -rz * REPEL_RETURN * TIME_SCALE;
                vx *= REPEL_DAMPING_T; vy *= REPEL_DAMPING_T; vz *= REPEL_DAMPING_T;
                rx += vx * TIME_SCALE; ry += vy * TIME_SCALE; rz += vz * TIME_SCALE;

                repel[i3] = rx; repel[i3 + 1] = ry; repel[i3 + 2] = rz;
                repelVel[i3] = vx; repelVel[i3 + 1] = vy; repelVel[i3 + 2] = vz;
                if (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01 || Math.abs(vz) > 0.01 ||
                    Math.abs(rx) > 0.01 || Math.abs(ry) > 0.01 || Math.abs(rz) > 0.01) bunnySettled = false;

                // --- Total local displacement = radial collapse + cursor repel ---
                const ox = dirs[i3]     * off + rx;
                const oy = dirs[i3 + 1] * off + ry;
                const oz = dirs[i3 + 2] * off + rz;
                const i9 = t * 9;
                for (let v = 0; v < 3; v++) {
                    livePos[i9 + v*3]     = basePos[i9 + v*3]     + ox;
                    livePos[i9 + v*3 + 1] = basePos[i9 + v*3 + 1] + oy;
                    livePos[i9 + v*3 + 2] = basePos[i9 + v*3 + 2] + oz;
                }
            }
            bunny.geometry.attributes.position.needsUpdate = true;
        }
        lastScrollExplode = scrollExplode;
    }

    composer.render();
}

animate();
