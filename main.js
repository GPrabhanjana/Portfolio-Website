import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';


let targetBrainScale = 0;
let currentBrainScale = 0;
const brainScaleLerpFactor = 0.1;

// Initialize scene, camera, and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#bg'),
    antialias: true,
    powerPreference: "high-performance"
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit pixel ratio for better performance
renderer.setSize(window.innerWidth, window.innerHeight);
camera.position.setZ(30);
scene.background = new THREE.Color(0x000000);

// Post-processing setup
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

// Bloom effect
const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    .23,  // strength
    .2,   // radius
    0.25  // threshold
);
composer.addPass(bloomPass);

// Chromatic aberration shader
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

const chromaticAberrationPass = new ShaderPass(chromaticAberrationShader);
composer.addPass(chromaticAberrationPass);

// Custom brain shader
const brainVertexShader = `
varying vec3 vPosition;
varying float vFiring;
uniform float uTime;

// Better random function for more chaotic firing
float random(vec3 pos) {
    return fract(sin(dot(pos.xyz, vec3(12.9898,78.233,45.164))) * 43758.5453123);
}

// Additional random function for timing variation
float random2(vec3 pos) {
    return fract(sin(dot(pos.zyx, vec3(45.164,78.233,12.9898))) * 43758.5453123);
}

void main() {
    vPosition = position;

    // Generate multiple random values for more chaotic firing
    float rand1 = random(position);
    float rand2 = random2(position);

    // Create more random firing patterns
    float randomFrequency = mix(2.0, 4.0, rand1);
    float randomPhase = rand2 * 10.0;

    // Firing logic with multiple random components
    float firingTime = mod(uTime * randomFrequency + randomPhase, 5.0);
    vFiring = step(4.7, firingTime) * rand1;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = vFiring * 5.0; // Increase size of points (from 2.0 to 5.0)
}
`;

const brainFragmentShader = `
varying vec3 vPosition;
varying float vFiring;
uniform float uTime;

void main() {
    vec3 baseColor = vec3(0.0, 0.0, 0.0); // Navy blue color
    vec3 firingColor = vec3(0.0, 1.0, 1.0); // Bright cyan color

    // Increase brightness by adjusting the mix factor
    vec3 finalColor = mix(baseColor, firingColor, vFiring * 15.0); // Increase intensity by multiplying vFiring

    // Metallic reflection
    float fresnel = pow(1.0 - dot(normalize(vPosition), vec3(0.0, 0.0, 1.0)), 1.4) * 0.6;
    float roughness = 0.4;

    finalColor += vec3(0.1) * fresnel;

    // Set the final color with alpha based on firing
    gl_FragColor = vec4(finalColor, vFiring);
}
`;


// Initialize arrays for mesh management
const meshes = [];
const velocities = [];
let brainMesh;
let pulseTime = 0;
let scrollY = 0;
let scrollEffect = 2;

// Scroll event listener
window.addEventListener('scroll', () => {
    scrollY = window.scrollY;
    
    if (scrollY <= 2) {
        scrollEffect = 2 - (scrollY / 1);
    }
    else if (scrollY <= 10) {
        scrollEffect = 1;
    }
    else {
        scrollEffect = 0;
    }
});

// Load the bunny model
const objLoader = new OBJLoader();
objLoader.load(
    './bunn(1).obj',
    (object) => {
        const bunnyGeometry = object.children[0].geometry;
        const positions = bunnyGeometry.getAttribute('position').array;

        const bunnyMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: .4,
            metalness: .7
        });
        
        const DESIRED_SCALE = 2.8;
        
        for (let i = 0; i < positions.length; i += 9) {
            const geometry = new THREE.BufferGeometry();
            const vertices = new Float32Array(9);
            
            for (let j = 0; j < 9; j += 3) {
                vertices[j] = positions[i + j] * DESIRED_SCALE;
                vertices[j + 1] = positions[i + j + 1] * DESIRED_SCALE;
                vertices[j + 2] = positions[i + j + 2] * DESIRED_SCALE;
            }
            
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            geometry.computeVertexNormals();

            const mesh = new THREE.Mesh(geometry, bunnyMaterial);
            mesh.position.set(0, -6, 0);
            mesh.userData.originalPosition = mesh.position.clone();
            meshes.push(mesh);
            velocities.push(new THREE.Vector3(0, 0, 0));
            scene.add(mesh);
        }
    }
);

// Load the brain model
objLoader.load(
    './brain.obj',
    (object) => {
        object.traverse((child) => {
            if (child.isMesh) {
                const geometry = child.geometry;
                geometry.computeVertexNormals();
                
                // Create the solid mesh with metallic material
                const meshMaterial = new THREE.MeshStandardMaterial({
                    color: 0x555555,
                    metalness: 0.6,
                    roughness: .4,
                    transparent: true, // Enable transparency
                    opacity: 0.9       // Set opacity to 0.7
                });
                
                // Create the base mesh slightly smaller
                const brainMeshBase = new THREE.Mesh(geometry, meshMaterial);
                const MESH_SCALE = 7; // Slightly smaller than points
                brainMeshBase.scale.set(0, 0, 0); // Start at 0 for animation
                brainMeshBase.position.set(0, -8, 0);
                scene.add(brainMeshBase);
                
                // Create the points with shader material
                const pointsMaterial = new THREE.ShaderMaterial({
                    uniforms: {
                        uTime: { value: 0 }
                    },
                    vertexShader: brainVertexShader,
                    fragmentShader: brainFragmentShader,
                    transparent: true,
                    depthWrite: false,
                    points: true
                    
                });
                
                const brainPoints = new THREE.Points(geometry, pointsMaterial);
                const POINTS_SCALE = 7;
                brainPoints.scale.set(0, 0, 0); // Start at 0 for animation
                brainPoints.position.set(0, -8, 0);
                scene.add(brainPoints);
                
                // Store both meshes for animation
                brainMesh = {
                    base: brainMeshBase,
                    points: brainPoints
                };
            }
        });
    }
);

// Text setup
let textMesh;
let smallTextMesh;
let smallTextMesh2;
let thankYouMesh;

// Load and setup text
const fontLoader = new FontLoader();
fontLoader.load('https://threejs.org/examples/fonts/helvetiker_bold.typeface.json', (font) => {
    const textGeometry1 = new TextGeometry("G PRABHANJANA", {
        font: font,
        size: 11,
        height: 0.2,
        curveSegments: 25,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.02,
        bevelSegments: 5
    });
    
    const textMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.8,
        metalness: 1,
        roughness: 0.2
    });

    textMesh = new THREE.Mesh(textGeometry1, textMaterial);
    textGeometry1.center();
    textMesh.position.z = -14;
    scene.add(textMesh);

    // Add new THANK YOU text
    const thankYouGeometry = new TextGeometry("THANKS FOR\nSTOPPING BY!", {
        font: font,
        size: 10,
        height: 0.2,
        curveSegments: 25,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.02,
        bevelSegments: 5
    });

    thankYouMesh = new THREE.Mesh(thankYouGeometry, textMaterial); // Store in variable
    thankYouGeometry.center();
    thankYouMesh.position.z = -14;
    thankYouMesh.position.y = -20;
    scene.add(thankYouMesh);

    // Rest of the existing text meshes...
    const smallTextGeometry = new TextGeometry("Hello, I am", {
        font: font,
        size: 5.5,
        height: 0.1,
        curveSegments: 25,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.01,
        bevelSegments: 5
    });

    const smallTextGeometry2 = new TextGeometry("Welcome to my portfolio website!", {
        font: font,
        size: 4.5,
        height: 0.1,
        curveSegments: 25,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.01,
        bevelSegments: 5
    });

    const smallTextMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.6,
        metalness: 1,
        roughness: 0.2
    });

    smallTextMesh2 = new THREE.Mesh(smallTextGeometry2, smallTextMaterial);
    smallTextGeometry2.center();
    smallTextMesh2.position.z = -17;
    smallTextMesh2.position.y = 2;
    scene.add(smallTextMesh2);

    smallTextMesh = new THREE.Mesh(smallTextGeometry, smallTextMaterial);
    smallTextGeometry.center();
    smallTextMesh.position.z = -17;
    smallTextMesh.position.y = 2;
    scene.add(smallTextMesh);
});

// Lighting setup
const ambientLight = new THREE.AmbientLight(0x8f8d78, 12);
scene.add(ambientLight);

const directionalLight1 = new THREE.DirectionalLight(0x0044ff, 3);
directionalLight1.position.set(-100, 40, -10);
scene.add(directionalLight1);

const directionalLight2 = new THREE.DirectionalLight(0xff7700, 3);
directionalLight2.position.set(100, -40, -10);
scene.add(directionalLight2);

// Mouse interaction setup
const mouse = new THREE.Vector2();
const mouseSphere = new THREE.Sphere(new THREE.Vector3(), 3);

function onMouseMove(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
    vector.unproject(camera);
    const dir = vector.sub(camera.position).normalize();
    const distance = -camera.position.z / dir.z;
    mouseSphere.center.copy(camera.position).add(dir.multiplyScalar(distance));
}

// Window resize handler
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    pulseTime += 0.015;

    // Update text positions and rotations
    if (textMesh) {
        textMesh.position.y = Math.max(scrollY * 0.035, -15);
        textMesh.position.x = -mouse.x * 1.0;
        textMesh.rotation.x = mouse.y * 0.05;
        textMesh.rotation.y = mouse.x * 0.05;
    }

    if (thankYouMesh) {
        // Get the total scrollable height of the page
        const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
    
        // Calculate the scroll fraction (0 at top, 1 at the bottom)
        const scrollFraction = scrollY / scrollableHeight;
    
        // Define the base and target Y positions for thankYouMesh
        const baseYPosition = -220; // Position off-screen (below the view)
        const targetYPosition = 0; // Final position when scrolled to the bottom
    
        // Interpolate position based on scroll
        thankYouMesh.position.y = baseYPosition + scrollFraction * (targetYPosition - baseYPosition);
    
        // Adjust X position and rotation based on mouse movement
        thankYouMesh.position.x = -mouse.x * 1.0; // Adjust X position based on mouse
        thankYouMesh.rotation.x = mouse.y * 0.05; // Rotation based on mouse Y
        thankYouMesh.rotation.y = mouse.x * 0.05; // Rotation based on mouse X
    }
    
    

    if (smallTextMesh) {
        smallTextMesh.position.y = textMesh.position.y + 10;
        smallTextMesh.position.x = textMesh.position.x;
        smallTextMesh.rotation.x = mouse.y * 0.05;
        smallTextMesh.rotation.y = mouse.x * 0.05;
    }

    if (smallTextMesh2) {
        smallTextMesh2.position.y = textMesh.position.y - 10;
        smallTextMesh2.position.x = textMesh.position.x;
        smallTextMesh2.rotation.x = mouse.y * 0.05;
        smallTextMesh2.rotation.y = mouse.x * 0.05;
    }

    // Update brain animation
    if (brainMesh) {
        const maxScale = 3.5;
        const scrollThreshold = 5;
        targetBrainScale = Math.min(scrollY / scrollThreshold, 1) * maxScale;
        
        currentBrainScale += (targetBrainScale - currentBrainScale) * brainScaleLerpFactor;
        
        // Scale both meshes
        brainMesh.base.scale.set(
            currentBrainScale * 1.1 * 0.99, // Increase size by 20%
            currentBrainScale * 1.1 * 0.99,
            currentBrainScale * 1.1 * 0.99
        );
        brainMesh.points.scale.set(
            currentBrainScale * 1.1, // Increase size by 20%
            currentBrainScale * 1.1,
            currentBrainScale * 1.1
        );
        
        // Get the total scrollable height of the page
        const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
        
        // Calculate the scroll fraction (0 at top, 1 at the bottom)
        const scrollFraction = scrollY / scrollableHeight;
    
        // Rotate both meshes for a 720-degree rotation based on scroll fraction
        const rotationAmount = scrollFraction * Math.PI * 4; // 720 degrees in radians
        brainMesh.base.rotation.y = rotationAmount;
        brainMesh.points.rotation.y = rotationAmount;
        
        // Update points shader time
        brainMesh.points.material.uniforms.uTime.value += 0.1;
    }
    
    // Update bunny fragments
    const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
    const scrollFraction = scrollY / scrollableHeight;
    
    // Calculate scroll rotation speed based on scroll fraction
    const scrollRotationSpeed = scrollFraction * 0.01; // Adjust the multiplier as needed for desired effect
    
    meshes.forEach((mesh, index) => {
        const rotationAmount = scrollFraction * Math.PI * 4; // 720 degrees in radians
        mesh.rotation.y = rotationAmount;
    
        const centerPoint = new THREE.Vector3();
        const positions = mesh.geometry.attributes.position.array;
        
        for (let i = 0; i < positions.length; i += 3) {
            centerPoint.add(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
        }
        centerPoint.divideScalar(3);
        centerPoint.applyMatrix4(mesh.matrixWorld);
    
        const distance = mouseSphere.center.distanceTo(centerPoint);
        let maxDistance = 12 * (1 + scrollEffect);
        let force = Math.pow(1 - distance / maxDistance, 2) * 4 * (1 + scrollEffect);
    
        if (distance < maxDistance) {
            const direction = centerPoint.sub(mouseSphere.center).normalize();
            velocities[index].add(direction.multiplyScalar(force));
        } else {
            const returnForce = 0.05;
            const originalPosition = mesh.userData.originalPosition.clone();
            const directionToOrigin = originalPosition.sub(mesh.position);
            velocities[index].add(directionToOrigin.multiplyScalar(returnForce));
        }
    
        mesh.position.add(velocities[index]);
        velocities[index].multiplyScalar(0.85);
    });

    composer.render();
}

// Event listeners
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('resize', onWindowResize);

// Start animation
animate();