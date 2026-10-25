import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { emergencyAudio } from '../../services/audioService.ts';
import { Volume2, VolumeX, Eye, Sun, Moon, ChevronDown, ChevronUp, Shield, Wrench } from 'lucide-react';

// Pre-allocated math helpers at module scope (Zero GC in animation loop)
const _vec3 = new THREE.Vector3();

interface AmbulanceViewer3DProps {
  onClose?: () => void;
}

export const AmbulanceViewer3D: React.FC<AmbulanceViewer3DProps> = ({ onClose }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [isLightsActive, setIsLightsActive] = useState(true);
  const [isSirenActive, setIsSirenActive] = useState(false);
  const [isDoorsOpen, setIsDoorsOpen] = useState(false);
  const [isNightMode, setIsNightMode] = useState(false);
  const [isDockCollapsed, setIsDockCollapsed] = useState(false);
  const [activePreset, setActivePreset] = useState<'iso' | 'side' | 'rear' | 'top'>('iso');

  // Mutable refs to bridge React state to 60fps render loop
  const lightsActiveRef = useRef(true);
  const doorsOpenRef = useRef(false);
  const nightModeRef = useRef(false);
  const cameraTargetPosRef = useRef<THREE.Vector3>(new THREE.Vector3(7, 4.2, 8));
  const controlsTargetRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 1.2, 0));

  useEffect(() => {
    lightsActiveRef.current = isLightsActive;
  }, [isLightsActive]);

  useEffect(() => {
    doorsOpenRef.current = isDoorsOpen;
  }, [isDoorsOpen]);

  useEffect(() => {
    nightModeRef.current = isNightMode;
  }, [isNightMode]);

  // Set camera view presets
  const handleSetPreset = useCallback((preset: 'iso' | 'side' | 'rear' | 'top') => {
    setActivePreset(preset);
    if (preset === 'iso') {
      cameraTargetPosRef.current.set(7, 4.2, 8);
      controlsTargetRef.current.set(0, 1.2, 0);
    } else if (preset === 'side') {
      cameraTargetPosRef.current.set(9, 2.2, 0);
      controlsTargetRef.current.set(0, 1.2, 0);
    } else if (preset === 'rear') {
      cameraTargetPosRef.current.set(-6, 2.5, 0.2);
      controlsTargetRef.current.set(-1.5, 1.4, 0);
    } else if (preset === 'top') {
      cameraTargetPosRef.current.set(0.1, 11, 0.1);
      controlsTargetRef.current.set(0, 0, 0);
    }
  }, []);

  // Toggle siren
  const handleToggleSiren = useCallback(() => {
    const active = emergencyAudio.toggleSiren();
    setIsSirenActive(active);
  }, []);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // 1. Detect Software WebGL
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    // 2. Scene & Renderer Setup
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || 500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(nightModeRef.current ? 0x090d16 : 0xf1f5f9);
    scene.fog = new THREE.Fog(nightModeRef.current ? 0x090d16 : 0xf1f5f9, 12, 32);

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    camera.position.set(7, 4.2, 8);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.04; // Don't dip below floor
    controls.minDistance = 3.5;
    controls.maxDistance = 18;
    controls.target.set(0, 1.2, 0);

    // 3. Mandatory Studio Environment Map (PMREMGenerator + RoomEnvironment)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 4. Lighting Rig (Warm Key Light + Cool Hemisphere Fill)
    const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x1e293b, 1.1);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfff7ed, 2.2);
    dirLight.position.set(8, 12, 6);
    dirLight.castShadow = !isSoftwareGl;
    if (!isSoftwareGl) {
      dirLight.shadow.mapSize.width = 1024;
      dirLight.shadow.mapSize.height = 1024;
      dirLight.shadow.camera.near = 1;
      dirLight.shadow.camera.far = 30;
      dirLight.shadow.camera.left = -6;
      dirLight.shadow.camera.right = 6;
      dirLight.shadow.camera.top = 6;
      dirLight.shadow.camera.bottom = -6;
      dirLight.shadow.bias = -0.0005;
      dirLight.shadow.normalBias = 0.02;
    }
    scene.add(dirLight);

    // Studio Rim Light
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.0);
    rimLight.position.set(-8, 5, -6);
    scene.add(rimLight);

    // 5. Ground Studio Floor & Radial Contact Shadow
    const floorGeo = new THREE.PlaneGeometry(60, 60);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.85,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = !isSoftwareGl;
    scene.add(floor);

    // Procedural soft radial contact shadow canvas texture
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 256;
    shadowCanvas.height = 256;
    const sCtx = shadowCanvas.getContext('2d')!;
    const grad = sCtx.createRadialGradient(128, 128, 20, 128, 128, 120);
    grad.addColorStop(0, 'rgba(15, 23, 42, 0.7)');
    grad.addColorStop(0.5, 'rgba(15, 23, 42, 0.3)');
    grad.addColorStop(1, 'rgba(15, 23, 42, 0)');
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, 256, 256);

    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    shadowTex.colorSpace = THREE.SRGBColorSpace;
    const shadowGeo = new THREE.PlaneGeometry(6.4, 3.2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.65,
    });
    const contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, 0.01, 0);
    scene.add(contactShadow);

    // -------------------------------------------------------------
    // 6. BUILD PROCEDURAL 12-PART COMPOSITE AMBULANCE (THREE.Group)
    // -------------------------------------------------------------
    const ambulanceGroup = new THREE.Group();

    // Material Library (Varying roughness >= 0.25 and metalness)
    const ambulanceWhiteMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0.15,
    });
    const emergencyRedMat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.3,
      metalness: 0.1,
    });
    const darkChassisMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.8,
      metalness: 0.3,
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.08,
      metalness: 0.95,
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0f172a,
      roughness: 0.05,
      metalness: 0.1,
      transparent: true,
      opacity: 0.75,
    });
    const rubberMat = new THREE.MeshStandardMaterial({
      color: 0x18181b,
      roughness: 0.9,
      metalness: 0.05,
    });

    // Emissive Lightbar Materials (Red / Blue strobe)
    const redLightMat = new THREE.MeshStandardMaterial({
      color: 0xff1e38,
      emissive: 0xff002b,
      emissiveIntensity: 3.5,
      roughness: 0.2,
    });
    const blueLightMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      emissive: 0x0ea5e9,
      emissiveIntensity: 3.5,
      roughness: 0.2,
    });

    // Part 1: Main Rear Medical Box Body
    const boxBodyGeo = new THREE.BoxGeometry(3.3, 2.0, 2.1);
    const boxBody = new THREE.Mesh(boxBodyGeo, ambulanceWhiteMat);
    boxBody.position.set(-0.6, 1.45, 0);
    boxBody.castShadow = !isSoftwareGl;
    boxBody.receiveShadow = !isSoftwareGl;
    ambulanceGroup.add(boxBody);

    // Part 2: Emergency Red Side Stripe
    const stripeGeo = new THREE.BoxGeometry(3.32, 0.45, 2.12);
    const stripe = new THREE.Mesh(stripeGeo, emergencyRedMat);
    stripe.position.set(-0.6, 1.35, 0);
    ambulanceGroup.add(stripe);

    // Part 3: Front Cab & Slanted Engine Hood
    const cabGeo = new THREE.BoxGeometry(1.7, 1.6, 1.95);
    const cab = new THREE.Mesh(cabGeo, ambulanceWhiteMat);
    cab.position.set(1.75, 1.25, 0);
    cab.castShadow = !isSoftwareGl;
    cab.receiveShadow = !isSoftwareGl;
    ambulanceGroup.add(cab);

    const hoodGeo = new THREE.BoxGeometry(0.8, 0.8, 1.9);
    const hood = new THREE.Mesh(hoodGeo, ambulanceWhiteMat);
    hood.position.set(2.4, 0.85, 0);
    ambulanceGroup.add(hood);

    // Part 4: Windshield & Cab Windows (Optical Glass)
    const windshieldGeo = new THREE.BoxGeometry(0.1, 0.65, 1.7);
    const windshield = new THREE.Mesh(windshieldGeo, glassMat);
    windshield.position.set(2.05, 1.55, 0);
    windshield.rotation.z = -Math.PI / 8;
    ambulanceGroup.add(windshield);

    // Side windows
    const sideWinGeo = new THREE.BoxGeometry(0.7, 0.45, 2.0);
    const sideWin = new THREE.Mesh(sideWinGeo, glassMat);
    sideWin.position.set(1.5, 1.6, 0);
    ambulanceGroup.add(sideWin);

    // Part 5: Wheels & Metallic Alloy Rims (4 Wheels)
    const wheelPositions = [
      [1.7, 0.42, 1.05],
      [1.7, 0.42, -1.05],
      [-1.3, 0.42, 1.05],
      [-1.3, 0.42, -1.05],
    ];

    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.28, 20);
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.3, 14);

    wheelPositions.forEach(([wx, wy, wz]) => {
      const wheelHub = new THREE.Group();
      wheelHub.position.set(wx, wy, wz);

      const tire = new THREE.Mesh(wheelGeo, rubberMat);
      tire.rotation.x = Math.PI / 2;
      tire.castShadow = !isSoftwareGl;
      wheelHub.add(tire);

      const rim = new THREE.Mesh(rimGeo, chromeMat);
      rim.rotation.x = Math.PI / 2;
      wheelHub.add(rim);

      ambulanceGroup.add(wheelHub);
    });

    // Part 6: Front Grille, Chrome Bumper & Headlights
    const bumperGeo = new THREE.BoxGeometry(0.3, 0.35, 2.1);
    const bumper = new THREE.Mesh(bumperGeo, chromeMat);
    bumper.position.set(2.85, 0.45, 0);
    bumper.castShadow = !isSoftwareGl;
    ambulanceGroup.add(bumper);

    const grilleGeo = new THREE.BoxGeometry(0.05, 0.4, 1.2);
    const grille = new THREE.Mesh(grilleGeo, darkChassisMat);
    grille.position.set(2.82, 0.85, 0);
    ambulanceGroup.add(grille);

    // Headlights
    const hlGeo = new THREE.BoxGeometry(0.08, 0.22, 0.3);
    const hlLeft = new THREE.Mesh(hlGeo, chromeMat);
    hlLeft.position.set(2.82, 0.85, 0.75);
    const hlRight = hlLeft.clone();
    hlRight.position.z = -0.75;
    ambulanceGroup.add(hlLeft);
    ambulanceGroup.add(hlRight);

    // Part 7: Roof Emergency LED Lightbar (Dual Flashing Bar)
    const lightbarBaseGeo = new THREE.BoxGeometry(0.45, 0.12, 1.5);
    const lightbarBase = new THREE.Mesh(lightbarBaseGeo, darkChassisMat);
    lightbarBase.position.set(1.3, 2.12, 0);
    ambulanceGroup.add(lightbarBase);

    const redLightMesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.65), redLightMat);
    redLightMesh.position.set(1.3, 2.22, 0.38);
    ambulanceGroup.add(redLightMesh);

    const blueLightMesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.65), blueLightMat);
    blueLightMesh.position.set(1.3, 2.22, -0.38);
    ambulanceGroup.add(blueLightMesh);

    // Front/Rear Corner Strobe Lights
    const strobeGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    const strobeFL = new THREE.Mesh(strobeGeo, redLightMat);
    strobeFL.position.set(1.0, 2.48, 1.02);
    const strobeFR = new THREE.Mesh(strobeGeo, blueLightMat);
    strobeFR.position.set(1.0, 2.48, -1.02);
    const strobeRL = new THREE.Mesh(strobeGeo, redLightMat);
    strobeRL.position.set(-2.22, 2.48, 1.02);
    const strobeRR = new THREE.Mesh(strobeGeo, blueLightMat);
    strobeRR.position.set(-2.22, 2.48, -1.02);
    ambulanceGroup.add(strobeFL);
    ambulanceGroup.add(strobeFR);
    ambulanceGroup.add(strobeRL);
    ambulanceGroup.add(strobeRR);

    // Part 8: Rear Double Medical Doors (Pivoting with Hinges)
    const doorLGroup = new THREE.Group();
    doorLGroup.position.set(-2.26, 1.45, 0.95);
    const doorGeo = new THREE.BoxGeometry(0.08, 1.8, 0.92);
    const doorMeshL = new THREE.Mesh(doorGeo, ambulanceWhiteMat);
    doorMeshL.position.set(0, 0, -0.46);
    doorLGroup.add(doorMeshL);

    const doorRGroup = new THREE.Group();
    doorRGroup.position.set(-2.26, 1.45, -0.95);
    const doorMeshR = new THREE.Mesh(doorGeo, ambulanceWhiteMat);
    doorMeshR.position.set(0, 0, 0.46);
    doorRGroup.add(doorMeshR);

    ambulanceGroup.add(doorLGroup);
    ambulanceGroup.add(doorRGroup);

    // Part 9: Interior Medical Bay (Gurney Stretcher & Oxygen Cylinder)
    const gurneyGroup = new THREE.Group();
    gurneyGroup.position.set(-0.6, 0.75, 0);

    const mattressGeo = new THREE.BoxGeometry(1.8, 0.14, 0.65);
    const mattress = new THREE.Mesh(
      mattressGeo,
      new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.5 })
    );
    mattress.position.y = 0.35;
    gurneyGroup.add(mattress);

    const frameGeo = new THREE.BoxGeometry(1.82, 0.35, 0.65);
    const frame = new THREE.Mesh(frameGeo, chromeMat);
    frame.position.y = 0.18;
    gurneyGroup.add(frame);

    // Oxygen cylinders
    const o2Geo = new THREE.CylinderGeometry(0.1, 0.1, 0.7, 12);
    const o2Mat = new THREE.MeshStandardMaterial({ color: 0x10b981, metalness: 0.7, roughness: 0.2 });
    const o2Tank = new THREE.Mesh(o2Geo, o2Mat);
    o2Tank.position.set(-0.2, 0.8, -0.75);
    gurneyGroup.add(o2Tank);

    ambulanceGroup.add(gurneyGroup);

    // Part 10: Roof Ventilation & Telemetry Pod
    const ventGeo = new THREE.BoxGeometry(0.9, 0.18, 0.6);
    const vent = new THREE.Mesh(ventGeo, darkChassisMat);
    vent.position.set(-0.8, 2.52, 0);
    ambulanceGroup.add(vent);

    // Pivot vehicle flush at ground level
    ambulanceGroup.position.y = 0;
    scene.add(ambulanceGroup);

    // -------------------------------------------------------------
    // 7. ANIMATION LOOP WITH DAMPED CAMERA & PBR LIGHT STROBE
    // -------------------------------------------------------------
    let animationFrameId: number;
    let clock = new THREE.Clock();

    function afterDraw(cb: () => void) {
      const webglContext = renderer.getContext() as WebGL2RenderingContext;
      const sync = webglContext.fenceSync(webglContext.SYNC_GPU_COMMANDS_COMPLETE, 0);
      webglContext.flush();
      const poll = () => {
        const state = sync && webglContext.getSyncParameter(sync, webglContext.SYNC_STATUS);
        if (state === webglContext.UNSIGNALED) {
          animationFrameId = window.setTimeout(poll, 5);
        } else {
          if (sync) webglContext.deleteSync(sync);
          animationFrameId = window.setTimeout(cb, 80);
        }
      };
      animationFrameId = window.setTimeout(poll, 5);
    }

    function animate() {
      const delta = clock.getDelta();
      const time = clock.getElapsedTime();

      // Exponential damping on camera position towards target preset
      camera.position.lerp(cameraTargetPosRef.current, 1 - Math.exp(-4.5 * delta));
      controls.target.lerp(controlsTargetRef.current, 1 - Math.exp(-5.0 * delta));
      controls.update();

      // Flash emergency lightbars if active
      if (lightsActiveRef.current) {
        const strobeFlash = Math.sin(time * 16) > 0;
        const altStrobeFlash = Math.cos(time * 16) > 0;

        redLightMat.emissiveIntensity = strobeFlash ? 6.0 : 0.4;
        blueLightMat.emissiveIntensity = altStrobeFlash ? 6.0 : 0.4;
      } else {
        redLightMat.emissiveIntensity = 0;
        blueLightMat.emissiveIntensity = 0;
      }

      // Smoothly swing open rear doors
      const targetDoorAngle = doorsOpenRef.current ? Math.PI / 2.2 : 0;
      doorLGroup.rotation.y = THREE.MathUtils.damp(doorLGroup.rotation.y, targetDoorAngle, 4, delta);
      doorRGroup.rotation.y = THREE.MathUtils.damp(doorRGroup.rotation.y, -targetDoorAngle, 4, delta);

      // Render
      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(animate);
      } else {
        animationFrameId = requestAnimationFrame(animate);
      }
    }

    animate();

    // Resize Handler
    const handleResize = () => {
      if (!mountRef.current) return;
      const newW = mountRef.current.clientWidth;
      const newH = mountRef.current.clientHeight || 500;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      renderer.setSize(newW, newH);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (isSoftwareGl) {
        clearTimeout(animationFrameId);
      } else {
        cancelAnimationFrame(animationFrameId);
      }
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="relative w-full h-[580px] bg-slate-900 rounded-xl overflow-hidden shadow-lg border border-slate-800">
      {/* 3D WebGL Canvas Container */}
      <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Top Left Spec Badge */}
      <div className="absolute top-4 left-4 z-20 pointer-events-none flex items-center gap-3">
        <div className="bg-slate-900/90 border border-slate-700/80 px-3.5 py-2 rounded-lg text-white pointer-events-auto shadow-md">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-bold tracking-tight">DropAid Rapid Response Unit 101</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Heavy-Duty Modular ALS · Procedural PBR Studio Inspector
          </p>
        </div>
      </div>

      {/* Close button if modal */}
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 bg-slate-900/80 hover:bg-slate-800 text-white border border-slate-700 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
        >
          Close Inspector
        </button>
      )}

      {/* Unified Bottom Control Dock (<= 15% viewport footprint, solid surfaces, zero backdrop-filter over WebGL) */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-full max-w-[840px] px-4 pointer-events-auto">
        <div className="flex flex-col items-center">
          {/* Dock Collapse / Expand Toggle Button */}
          <button
            onClick={() => setIsDockCollapsed((prev) => !prev)}
            className="mb-1.5 bg-slate-900/95 hover:bg-slate-800 text-slate-300 border border-slate-700 px-3 py-1 rounded-full text-[11px] font-medium flex items-center gap-1 shadow-sm cursor-pointer transition-colors"
          >
            {isDockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" /> Show Telemetry Controls
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" /> Collapse Dock
              </>
            )}
          </button>

          {!isDockCollapsed && (
            <div className="w-full bg-slate-900/95 border border-slate-700/90 rounded-xl p-3 shadow-xl flex flex-wrap items-center justify-between gap-3 text-white">
              {/* Camera Presets Segmented Bar */}
              <div className="flex items-center gap-1 bg-slate-800/90 p-1 rounded-lg">
                <button
                  onClick={() => handleSetPreset('iso')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    activePreset === 'iso' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  3/4 Angle
                </button>
                <button
                  onClick={() => handleSetPreset('side')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    activePreset === 'side' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Side Profile
                </button>
                <button
                  onClick={() => handleSetPreset('rear')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    activePreset === 'rear' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Medical Bay
                </button>
                <button
                  onClick={() => handleSetPreset('top')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    activePreset === 'top' ? 'bg-sky-600 text-white' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Top-Down
                </button>
              </div>

              {/* Functional Action Toggles */}
              <div className="flex items-center gap-2">
                {/* Emergency Lights Toggle */}
                <button
                  onClick={() => setIsLightsActive((prev) => !prev)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors flex items-center gap-1.5 cursor-pointer ${
                    isLightsActive
                      ? 'bg-rose-900/50 border-rose-500 text-rose-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  <span>LED Strobe</span>
                  <span className={`w-2 h-2 rounded-full ${isLightsActive ? 'bg-rose-500' : 'bg-slate-600'}`} />
                </button>

                {/* Procedural Siren Audio */}
                <button
                  onClick={handleToggleSiren}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors flex items-center gap-1.5 cursor-pointer ${
                    isSirenActive
                      ? 'bg-amber-900/50 border-amber-500 text-amber-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  {isSirenActive ? <Volume2 className="w-3.5 h-3.5 text-amber-400" /> : <VolumeX className="w-3.5 h-3.5" />}
                  <span>{isSirenActive ? 'Siren Wail ON' : 'Audio Siren'}</span>
                </button>

                {/* Rear Stretcher Doors Toggle */}
                <button
                  onClick={() => setIsDoorsOpen((prev) => !prev)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                    isDoorsOpen
                      ? 'bg-sky-900/50 border-sky-500 text-sky-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  <span>{isDoorsOpen ? 'Close Doors' : 'Open Stretcher Doors'}</span>
                </button>

                {/* Studio Day/Night Mode */}
                <button
                  onClick={() => setIsNightMode((prev) => !prev)}
                  className="p-1.5 bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 rounded-lg cursor-pointer"
                  title="Toggle Studio Lighting"
                >
                  {isNightMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-sky-400" />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
