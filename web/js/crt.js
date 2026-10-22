// WEBGL CRT POST-PROCESS (single pass; falls back to a 2D blit on failure).
// The MiNERVA-FM tube: curvature, scanlines, aperture mask, RGB shift, bloom,
// flicker, noise, a moving sync band, vignette, an amber-phosphor option and
// the dot -> line -> fill power-on, all applied to the terminal canvas.

/* ---- CRT effect parameters (lifted from cool-retro-term defaults) -------- */
export const CRT = {
  curvature: 0.10,     // barrel distortion
  scanline:  0.30,     // scanline darkening
  mask:      0.22,     // aperture-grille triad
  rgbShift:  0.0011,   // chroma separation (uv units)
  bloom:     0.55,     // glow of bright pixels
  flicker:   0.05,
  noise:     0.07,
  glowLine:  0.04,     // moving horizontal sync band
  vignette:  0.32,
  brightness:1.18,
  mono:      false,    // colour CRT by default; [M] toggles amber phosphor
  monoTint:  [1.0, 0.55, 0.12],   // amber #ff8100-ish
  power:     0,        // tube turn-on progress (0..1), animated on POWER ON
};

export const POWER_MS = 666;   // ignition duration

// Scanline/bloom density of the virtual tube, independent of the text grid.
const TUBE_W = 640, TUBE_H = 480;

const VERT = `attribute vec2 p; varying vec2 vUv;
void main(){ vUv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2  uRes;     // virtual resolution (for scanlines)
uniform float uTime;
uniform float uCurv, uScan, uMask, uRgb, uBloom, uFlicker, uNoise, uGlow, uVig, uBright, uMono;
uniform vec3  uTint;
uniform float uPower;

float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233)))*43758.5453); }

vec2 curve(vec2 uv){
  uv = uv*2.0 - 1.0;
  vec2 o = abs(uv.yx) * (0.45*uCurv);
  uv = uv + uv*o*o;
  return uv*0.5 + 0.5;
}

void main(){
  vec2 uv = curve(vUv);
  if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; }

  // chroma / rgb shift
  vec3 col;
  col.r = texture2D(uTex, vec2(uv.x + uRgb, uv.y)).r;
  col.g = texture2D(uTex, uv).g;
  col.b = texture2D(uTex, vec2(uv.x - uRgb, uv.y)).b;

  // cheap bloom: 8-tap blur of bright areas
  vec3 bloom = vec3(0.0);
  float bs = 1.6/uRes.x;
  bloom += texture2D(uTex, uv + vec2( bs, 0)).rgb;
  bloom += texture2D(uTex, uv + vec2(-bs, 0)).rgb;
  bloom += texture2D(uTex, uv + vec2(0,  bs*1.3)).rgb;
  bloom += texture2D(uTex, uv + vec2(0, -bs*1.3)).rgb;
  bloom += texture2D(uTex, uv + vec2( bs, bs)).rgb;
  bloom += texture2D(uTex, uv + vec2(-bs,-bs)).rgb;
  bloom += texture2D(uTex, uv + vec2( bs*2.0, 0)).rgb;
  bloom += texture2D(uTex, uv + vec2(-bs*2.0, 0)).rgb;
  bloom *= 0.125;
  col += bloom*bloom * uBloom;

  // monochrome amber phosphor option
  if(uMono > 0.5){
    float lum = dot(col, vec3(0.299,0.587,0.114));
    col = uTint * lum;
  }

  // scanlines
  float sl = sin(uv.y * uRes.y * 3.14159265);
  col *= 1.0 - uScan*(0.5 + 0.5*sl)*0.6;

  // aperture-grille triad mask
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 mask = vec3(1.0 - uMask);
  if(m < 1.0) mask.r = 1.0; else if(m < 2.0) mask.g = 1.0; else mask.b = 1.0;
  col *= mask;

  // moving horizontal sync glow band
  float band = fract(uv.y*0.7 - uTime*0.08);
  col += uGlow * smoothstep(0.96, 1.0, band) * vec3(0.6,0.8,0.6);

  // flicker + static noise
  col *= 1.0 - uFlicker*(rand(vec2(uTime,1.0))-0.5);
  col += (rand(uv*uRes + uTime) - 0.5) * uNoise;

  // vignette
  vec2 vc = uv - 0.5;
  col *= 1.0 - uVig*dot(vc,vc)*2.2;

  col *= uBright;

  // ---- CRT power-on: white dot -> horizontal line -> open vertically ----
  if(uPower < 1.0){
    vec2 pp = uv*2.0 - 1.0;                            // -1..1 across the tube
    float ox = smoothstep(0.0, 0.40, uPower);          // width opens first (dot -> line)
    float oy = smoothstep(0.42, 1.0, uPower);          // height opens after (line -> fill)
    float effOy = max(oy, 0.0045);                     // hold one bright scanline in phase 1
    float mx = 1.0 - smoothstep(ox,    ox + 0.012,    abs(pp.x));
    float my = 1.0 - smoothstep(effOy, effOy + 0.010, abs(pp.y));
    float lit = mx * my;
    float hot = 1.0 - smoothstep(0.0, 0.55, oy);       // overexposed white early, settles to image
    vec3 beam = mix(col, vec3(1.15), hot * 0.9);
    col = beam * lit;
    col += lit * smoothstep(effOy, effOy * 0.25, abs(pp.y)) * hot * vec3(0.45, 0.6, 0.45);
  }

  gl_FragColor = vec4(col, 1.0);
}`;

const UNIFORMS = ["uTex","uRes","uTime","uCurv","uScan","uMask","uRgb","uBloom","uFlicker",
                  "uNoise","uGlow","uVig","uBright","uMono","uTint","uPower"];

/**
 * Bind the CRT pass to an output canvas, reading from `content` each frame.
 * Returns draw(timeMs); uses WebGL when it can, otherwise a flat blit.
 */
export function createCRT(out, content) {
  let gl = null, locs, tex;

  function compile(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function initGL(){
    gl = out.getContext("webgl", { antialias:false, preserveDrawingBuffer:false })
      || out.getContext("experimental-webgl");
    if(!gl) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    locs = {};
    UNIFORMS.forEach(n => locs[n] = gl.getUniformLocation(prog, n));
    return true;
  }
  function drawGL(time){
    gl.viewport(0,0,out.width,out.height);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, content);
    gl.uniform1i(locs.uTex, 0);
    gl.uniform2f(locs.uRes, TUBE_W, TUBE_H);
    gl.uniform1f(locs.uTime, time/1000);
    gl.uniform1f(locs.uCurv, CRT.curvature);
    gl.uniform1f(locs.uScan, CRT.scanline);
    gl.uniform1f(locs.uMask, CRT.mask);
    gl.uniform1f(locs.uRgb,  CRT.rgbShift);
    gl.uniform1f(locs.uBloom,CRT.bloom);
    gl.uniform1f(locs.uFlicker,CRT.flicker);
    gl.uniform1f(locs.uNoise,CRT.noise);
    gl.uniform1f(locs.uGlow, CRT.glowLine);
    gl.uniform1f(locs.uVig,  CRT.vignette);
    gl.uniform1f(locs.uBright,CRT.brightness);
    gl.uniform1f(locs.uMono, CRT.mono ? 1.0 : 0.0);
    gl.uniform3fv(locs.uTint, CRT.monoTint);
    gl.uniform1f(locs.uPower, CRT.power);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  let g2 = null;
  function drawFallback(){
    g2 = g2 || out.getContext("2d");
    if(!g2) return;
    g2.imageSmoothingEnabled = false;
    g2.drawImage(content, 0, 0, out.width, out.height);
  }

  let glOK = false;
  try { glOK = initGL(); } catch(e){ console.warn("WebGL init failed, using 2D fallback:", e); glOK = false; }
  return { webgl: glOK, draw: glOK ? drawGL : drawFallback };
}
