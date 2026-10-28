/* Camera modes of the 3D view (world Z up):
 *   orbit   - rotate / pan / zoom around a point (mouse: left rotate, right pan, wheel zoom)
 *   free    - fly: drag to look, W A S D move, R / F (or Q / E) up / down, Shift fast, wheel = speed
 *   follow  - orbit camera that travels with the selected player (drag to turn around them)
 *   fp      - first person: the selected player's eye with their view angles */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { forward } from './actors.js';

export const MODES = [['orbit', 'Orbit'], ['free', 'Free fly'], ['follow', 'Follow player'], ['fp', 'First person']];
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
    this.camera.fov = mode === 'fp' ? 80 : 60;
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
    const el = this.dom;
    el.addEventListener('pointerdown', e => {
      if (this.mode !== 'free') return;
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (this.mode !== 'free' || !this.drag) return;
      this.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.004;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.drag.pitch - (e.clientY - this.drag.y) * 0.004));
      this.onChange();
    });
    el.addEventListener('pointerup', () => { this.drag = null; });
    el.addEventListener('wheel', e => {
      if (this.mode !== 'free') return;
      e.preventDefault();
      this.speed = Math.min(4000, Math.max(60, this.speed * Math.exp(-e.deltaY * 0.001)));
    }, { passive: false });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
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

  dispose() { this.orbit.dispose(); }
}
