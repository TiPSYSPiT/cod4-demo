/* The map's sky as the game draws it (its sky shader: colour = texCUBE(skyMap, world direction), unlit):
 * maps3d/<map>/sky.webp holds the six faces of the sky cube (tools/export/export_maps.py export_sky)
 * side by side in the D3D order +X, -X, +Y, -Y, +Z, -Z; they are read with the D3D cube conventions
 * and the world direction (the same mapping as the reflection probes, lighting.js lgProbe). Drawn as a
 * box around the camera at the far plane, behind everything. */
import * as THREE from 'three';
import { dataUrl } from './data.js';

export class Sky {
  /** dir: maps3d/<map>/, meta: world.json "sky" -> Sky or null */
  static async load(dir, meta) {
    if (!meta) return null;
    const tex = await new THREE.TextureLoader().loadAsync(dataUrl(dir + meta.file));
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;                    // gamma-space colours, like the rest of the view
    tex.generateMipmaps = false;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return new Sky(tex, meta);
  }

  constructor(tex, meta) {
    this.texture = tex;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSky: { value: tex }, uFace: { value: meta.size } },
      vertexShader: `
varying vec3 vDir;
void main() {
  vDir = position;                                    // object space = world direction (no rotation)
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;                               // at the far plane
}`,
      fragmentShader: `
uniform sampler2D uSky;
uniform float uFace;
varying vec3 vDir;
void main() {
  vec3 c = vDir, a = abs(c);
  float ma, sc, tc, f;
  if (a.x >= a.y && a.x >= a.z) { ma = a.x; if (c.x > 0.0) { f = 0.0; sc = -c.z; tc = -c.y; } else { f = 1.0; sc = c.z; tc = -c.y; } }
  else if (a.y >= a.z) { ma = a.y; if (c.y > 0.0) { f = 2.0; sc = c.x; tc = c.z; } else { f = 3.0; sc = c.x; tc = -c.z; } }
  else { ma = a.z; if (c.z > 0.0) { f = 4.0; sc = c.x; tc = -c.y; } else { f = 5.0; sc = -c.x; tc = -c.y; } }
  float m = 0.5 / uFace;
  vec2 uv = clamp(vec2(sc, tc) / ma * 0.5 + 0.5, m, 1.0 - m);
  gl_FragColor = vec4(textureLod(uSky, vec2((f + uv.x) / 6.0, uv.y), 0.0).rgb, 1.0);
}`,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;                      // first, behind everything
  }

  dispose() { this.texture.dispose(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
