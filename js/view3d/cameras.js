/* Camera modes of the 3D view (world Z up):
 *   orbit   - rotate / pan / zoom around a point (mouse: left rotate, right pan, wheel zoom)
 *   free    - fly: drag to look, W A S D move, R / F (or Q / E) up / down, Shift fast, wheel = speed
 *   follow  - orbit camera that travels with the selected player (drag to turn around them)
 *   fp      - first person: the selected player's eye with their view angles */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { forward } from './actors.js';

export const MODES = [['orbit', 'Orbit'], ['free', 'Free fly'], ['follow', 'Follow player'], ['fp', 'First person']];
/** the first-person camera's vertical field of view (deg; about the game's cg_fov 80 with cg_fovscale 1.2) -
 *  aiming down the sights zooms from it (viewmodel.js fov) */
// cg_fov is the horizontal fov of the 4:3 screen (CG_UpdateFov: tanHalfFovY = tan(fov / 2) x 0.75, a wider screen sees
// more at the sides); three's camera.fov is the vertical one
const PINCH_FLY = 0.004;                // seconds of flight per pixel of a two-finger spread
export const CG_FOV = 80;
export const vFov43 = h => 2 * Math.atan(Math.tan(h * Math.PI / 360) * 0.75) * 180 / Math.PI;
export const hFov43 = v => 2 * Math.atan(Math.tan(v * Math.PI / 360) / 0.75) * 180 / Math.PI;
export const FP_FOV = vFov43(CG_FOV);
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'ShiftLeft', 'ShiftRight']);

export class Cameras {
  constructor(camera, dom, onChange) {
    this.camera = camera;
    this.dom = dom;
    this.onChange = onChange;
    this.mode = 'orbit';
    camera.up.set(0, 0, 1);
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = false;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.addEventListener('change', () => onChange());
    // free fly state
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0;      // radians; pitch > 0 looks up
    this.speed = 500;                  // units per second
    this.drag = null;
    this.followLast = null;
    this.bindFree();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit' || mode === 'follow';
    if (mode === 'free') {
      // keep the current view
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.yaw = Math.atan2(d.y, d.x);
      this.pitch = Math.asin(Math.max(-1, Math.min(1, d.z)));
    }
    if (mode === 'orbit' && prev !== 'follow') {
      // orbit around the point in front of the camera
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.orbit.target.copy(this.camera.position).addScaledVector(d, 600);
    }
    if (mode === 'follow') this.followLast = null;
    this.camera.fov = mode === 'fp' ? FP_FOV : 60;
    this.camera.updateProjectionMatrix();
    this.onChange();
  }

  /** free camera at (x, y, z) looking along yaw / pitch (degrees, pitch > 0 up) - the ?cam= deep link */
  place(x, y, z, yawDeg, pitchDeg) {
    this.setMode('free');
    this.yaw = yawDeg * Math.PI / 180;
    this.pitch = pitchDeg * Math.PI / 180;
    this.camera.position.set(x, y, z);
    this.tick(0, null);
    this.onChange();
  }

  /** fit the orbit camera to a world box {mins, maxs} */
  frame(box) {
    const c = new THREE.Vector3((box.mins[0] + box.maxs[0]) / 2, (box.mins[1] + box.maxs[1]) / 2, box.mins[2]);
    const size = Math.max(box.maxs[0] - box.mins[0], box.maxs[1] - box.mins[1]);
    this.orbit.target.copy(c);
    this.camera.position.set(c.x - size * 0.15, c.y - size * 0.65, c.z + size * 0.75);
    this.camera.lookAt(c);
    this.orbit.update();
    this.onChange();
  }

  bindFree() {
    const el = this.dom, fingers = new Map();
    const spread = () => { const [a, b] = [...fingers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
    el.addEventListener('pointerdown', e => {
      if (this.mode !== 'free') return;
      el.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') { fingers.set(e.pointerId, [e.clientX, e.clientY]); if (fingers.size > 1) { this.drag = null; return; } }
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
    });
    el.addEventListener('pointermove', e => {
      if (this.mode === 'free' && fingers.size === 2 && fingers.has(e.pointerId)) {
        // two fingers: spreading them flies forward, pinching back
        const d0 = spread();
        fingers.set(e.pointerId, [e.clientX, e.clientY]);
        this.camera.translateZ((d0 - spread()) * this.speed * PINCH_FLY);
        this.onChange();
        return;
      }
      if (this.mode !== 'free' || !this.drag) return;
      this.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.004;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.drag.pitch - (e.clientY - this.drag.y) * 0.004));
      this.onChange();
    });
    const lift = e => { fingers.delete(e.pointerId); this.drag = null; };
    el.addEventListener('pointerup', lift);
    el.addEventListener('pointercancel', lift);
    el.addEventListener('wheel', e => {
      if (this.mode !== 'free') return;
      e.preventDefault();
      this.speed = Math.min(4000, Math.max(60, this.speed * Math.exp(-e.deltaY * 0.001)));
    }, { passive: false });
    // (removed in dispose: the window's listeners would keep the cameras - and through onChange the view - alive)
    this.onKeyUp = e => this.keys.delete(e.code);
    this.onBlur = () => this.keys.clear();
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** key handling of the free camera; true = the key was used (the app ignores it) */
  captureKey(e) {
    if (this.mode !== 'free' || !MOVE_KEYS.has(e.code)) return false;
    this.keys.add(e.code);
    return true;
  }

  /** per animation frame; dt in seconds. target: {pos: Vector3 (feet), eye: Vector3, yaw, pitch} of the
   *  selected player or null. Returns true while the camera moves. */
  tick(dt, target) {
    const cam = this.camera;
    if (this.mode === 'orbit') return this.orbit.update();
    if (this.mode === 'free') {
      const k = this.keys;
      const f = new THREE.Vector3(Math.cos(this.pitch) * Math.cos(this.yaw), Math.cos(this.pitch) * Math.sin(this.yaw), Math.sin(this.pitch));
      const r = new THREE.Vector3(Math.sin(this.yaw), -Math.cos(this.yaw), 0);
      const v = new THREE.Vector3();
      if (k.has('KeyW')) v.add(f);
      if (k.has('KeyS')) v.sub(f);
      if (k.has('KeyD')) v.add(r);
      if (k.has('KeyA')) v.sub(r);
      if (k.has('KeyR') || k.has('KeyE')) v.z += 1;
      if (k.has('KeyF') || k.has('KeyQ')) v.z -= 1;
      const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
      if (v.lengthSq()) cam.position.addScaledVector(v.normalize(), this.speed * fast * dt);
      cam.lookAt(cam.position.clone().add(f));
      return v.lengthSq() > 0 || !!this.drag;
    }
    if (!target) return false;
    if (this.mode === 'follow') {
      const look = new THREE.Vector3(target.pos.x, target.pos.y, target.pos.z + 50);
      if (!this.followLast) {
        // start behind the player, looking where they look
        const back = forward(target.yaw, 0).multiplyScalar(-220);
        cam.position.set(look.x + back.x, look.y + back.y, look.z + 110);
      } else {
        cam.position.add(look.clone().sub(this.followLast));        // travel with the player
      }
      this.orbit.target.copy(look);
      this.followLast = look.clone();
      this.orbit.update();
      return true;
    }
    if (this.mode === 'fp') {
      cam.position.copy(target.eye);
      cam.lookAt(target.eye.clone().add(forward(target.yaw, target.pitch)));
      return true;
    }
    return false;
  }

  dispose() {
    this.orbit.dispose();
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
