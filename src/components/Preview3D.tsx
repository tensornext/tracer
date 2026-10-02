import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Loader2 } from "lucide-react";
import { useStore } from "../state/store";
import { nextPreviewId, supersedeCadPreviews, withCad } from "../state/session";
import { foamParams, gridfinityParams, planFor } from "../state/geometry";
import type { MeshData } from "../lib/cad/kernel";
import type { BuildRequest } from "../workers/cad.worker";

const COLORS: Record<string, number> = { tray: 0x8a8f98, contrast: 0xf26a1b, foamCut: 0x3a4044, foamBacker: 0x5b6166 };

export function Preview3D() {
  const tools = useStore((s) => s.tools);
  const settings = useStore((s) => s.settings);
  const plan = useMemo(() => planFor(tools, settings), [tools, settings]);
  const mountRef = useRef<HTMLDivElement>(null);
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group } | null>(null);
  const [state, setState] = useState<{ status: "idle" | "building" | "ready" | "error"; message?: string }>({ status: "idle" });

  useEffect(() => {
    const el = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4a45, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-1, 2, 1.5);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2; // CAD Z-up → three Y-up
    scene.add(group);
    three.current = { renderer, scene, camera, controls, group };
    const resize = () => {
      const r = el.getBoundingClientRect();
      renderer.setSize(r.width, r.height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); three.current = null; };
  }, []);

  useEffect(() => {
    if (plan.kind === "error" || plan.cutouts.length === 0) {
      setState(plan.kind === "error" ? { status: "error", message: plan.message } : { status: "idle" });
      return;
    }
    const req: BuildRequest = plan.kind === "gridfinity"
      ? { mode: "gridfinity", cutouts: plan.cutouts, params: { ...gridfinityParams(settings), center: plan.plan.layout.center } }
      : { mode: "foam", cutouts: plan.cutouts, params: foamParams(settings) };
    let cancelled = false, pending = false;
    const timer = setTimeout(async () => {
      setState({ status: "building" });
      pending = true;
      try {
        const id = nextPreviewId();
        const meshes = await withCad((w) => w.preview(id, req));
        // null: superseded by a newer request before the worker got to it.
        if (cancelled || !meshes || !three.current) return;
        show(meshes);
        setState({ status: "ready" });
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        pending = false;
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Still queued in the worker (say the view closed and no newer build follows): let it skip.
      if (pending) supersedeCadPreviews();
    };
  }, [plan, settings]);

  function show(meshes: MeshData[]) {
    const { group, camera, controls } = three.current!;
    for (const child of [...group.children]) {
      group.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose?.();
    }
    const bounds = new THREE.Box3();
    // Spread split tiles apart a little so the seams read.
    const tiles = new Set(meshes.map((m) => m.tile));
    for (const m of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      g.setIndex(new THREE.BufferAttribute(m.triangles, 1));
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COLORS[m.kind] ?? 0x999999, roughness: 0.75, metalness: 0.02 }));
      if (tiles.size > 1) mesh.position.x = m.tile * 6;
      group.add(mesh);
    }
    group.updateMatrixWorld(true);
    bounds.setFromObject(group);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z);
    controls.target.copy(center);
    camera.position.set(center.x + r * 0.75, center.y + r * 1.45, center.z + r * 1.6);
    camera.near = r / 100;
    camera.far = r * 20;
    camera.updateProjectionMatrix();
  }

  return (
    <div className="relative h-full w-full mat">
      <div ref={mountRef} className="absolute inset-0" />
      {state.status === "building" && (
        <div className="absolute right-4 top-4 flex items-center gap-2 rounded-full bg-ink/85 px-3.5 py-1.5 text-[13px] font-semibold text-white">
          <Loader2 size={14} className="animate-spin" /> Building the model…
        </div>
      )}
      {state.status === "error" && (
        <div className="absolute left-4 top-4 max-w-md rounded-lg bg-white px-4 py-3 shadow-lg">
          <div className="font-bold text-error">Couldn't build this design</div>
          <div className="hint mt-1">{state.message}</div>
        </div>
      )}
      {plan.cutouts.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-mat-ink pointer-events-none">Trace a tool to see the 3D model.</div>
      )}
    </div>
  );
}
