// Light trail: each frame keeps a fading copy of the last one and takes the
// brighter of the two, so moving light leaves a ribbon behind it (a long
// exposure) without anything piling up into a white-out. HDR in, HDR out.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export class TrailPass extends Pass {
  constructor(decay = 0.9) {
    super();
    this.decay = decay; // per 1/60 s
    this.dt = 1 / 60;
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.history = [rt(), rt()];
    this.cur = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tNew: { value: null }, tOld: { value: null }, uDamp: { value: decay } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tNew; uniform sampler2D tOld; uniform float uDamp; varying vec2 vUv;
        void main() {
          vec4 n = texture2D(tNew, vUv);
          vec4 o = max(texture2D(tOld, vUv) * uDamp - 0.003, 0.0);
          gl_FragColor = vec4(max(n.rgb, o.rgb), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(w, h) {
    for (const t of this.history) t.setSize(w, h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const next = 1 - this.cur;
    const u = this.material.uniforms;
    u.tNew.value = readBuffer.texture;
    u.tOld.value = this.history[this.cur].texture;
    u.uDamp.value = Math.pow(this.decay, this.dt * 60);
    renderer.setRenderTarget(this.history[next]);
    this.quad.render(renderer);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    this.cur = next;
  }
}
