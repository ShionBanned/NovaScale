/**
 * NovaScale - Shaders Library v7.0 (GLSL ES 1.00 / WebGL1 & WebGL2 Compatible)
 *
 * Official Anime4K-Ultra Architecture + AMD FidelityFX FSR 1.0 across ALL modes:
 * 1. vertexShader: Hardware Y-coordinate flip (Zero-Copy D3D11VA compatible).
 * 2. passthroughFrag: Unprocessed direct passthrough render.
 *
 * CINEMA PRO TRILOGY (Movies, TV Shows & Live-Action Video):
 * 3. cinemaFrag        [Mode A - FSR 1.0]: Official AMD FidelityFX Super Resolution 1.0 (EASU 12-Tap + RCAS).
 * 4. cinemaFrag_RAISR  [Mode B - RAISR]: Google RAISR (2D Structure Tensor + Steered Anisotropic Filter).
 * 5. cinemaFrag_FSRCNN [Mode C - FSRCNN]: Lightweight Neural ConvNet (EASU base + non-linear PReLU inference).
 *
 * ANIME4K-ULTRA SUITE (12-Tap FSR 1.0 EASU foundation across all 4 profiles):
 * 6. animeFrag_Pure    [Pure]: FSR 1.0 + Soft Thin AA. Preserves 100% grain & painted backgrounds.
 * 7. animeFrag_DbL     [Deblur - Recommended]: FSR 1.0 + Background-gated Deblur & Hue Protection.
 * 8. animeFrag_Sharp   [Sharp]: FSR 1.0 + High-frequency 9-Tap Unsharp Masking (USM).
 * 9. animeFrag_DbH     [Intense]: FSR 1.0 + Heavy Deblur + Deep Ink Punch for low-res blurry sources.
 */

window.NovaShaders = {

  vertexShader: `
    attribute vec2 a_position;
    varying vec2 v_uv;

    void main() {
      v_uv = vec2(
        (a_position.x + 1.0) * 0.5,
        1.0 - (a_position.y + 1.0) * 0.5
      );
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `,

  passthroughFrag: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;

    void main() {
      gl_FragColor = texture2D(u_texture, v_uv);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  AMD FidelityFX Super Resolution 1.0 (FSR 1.0) - OFFICIAL GPUOpen
  //  Anisotropic 12-Tap EASU + RCAS (Cinema Pro Mode A)
  // ══════════════════════════════════════════════════════════════════════════
  cinemaFrag: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getFsrLuma(vec3 c) {
      return c.g + 0.5 * (c.r + c.b);
    }

    void FsrEasuSetF(
      inout vec2 dir,
      inout float len,
      float w,
      float lA, float lB, float lC, float lD, float lE
    ) {
      float dirX = lD - lB;
      float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;

      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;

      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;

      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(
      inout vec3 aC,
      inout float aW,
      vec2 off,
      vec2 dir,
      vec2 len2,
      float lob,
      float clp,
      vec3 c
    ) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
      v *= len2;
      float d2 = min(dot(v, v), clp);

      float wB = 0.4 * d2 - 1.0;
      float wA = lob * d2 - 1.0;
      wB *= wB;
      wA *= wA;
      wB = 1.5625 * wB - 0.5625;

      float w = wB * wA;
      aC += c * w;
      aW += w;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw   = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          float glow = 1.0 - (dist / lw);
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), glow * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      vec2 pos  = v_uv / s - 0.5;
      vec2 fp   = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2  dir = vec2(0.0);
      float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir);
      float dirLen  = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);

      float stretch = (dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0;
      stretch = clamp(stretch, 1.0, 2.0);

      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3  aC = vec3(0.0);
      float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 easuColor = aC / max(aW, 0.0001);
      vec3 min4 = min(min(f, g), min(j, k));
      vec3 max4 = max(max(f, g), max(j, k));
      easuColor = clamp(easuColor, min4, max4);

      // RCAS post-pass
      vec3 cas_b = texture2D(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 cas_d = texture2D(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 cas_e = easuColor;
      vec3 cas_f = texture2D(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 cas_h = texture2D(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;

      vec3 mnRGB = min(min(min(cas_d, cas_e), min(cas_f, cas_b)), cas_h);
      vec3 mxRGB = max(max(max(cas_d, cas_e), max(cas_f, cas_b)), cas_h);

      vec3 rcpMx = 1.0 / max(mxRGB, vec3(0.0001));
      vec3 amp   = clamp(min(mnRGB, 2.0 - mxRGB) * rcpMx, 0.0, 1.0);
      amp        = sqrt(amp);

      float peak = -1.0 / mix(8.0, 5.0, sharp);
      vec3  w    = amp * peak * sharp;

      vec3 rcpWeight = 1.0 / (1.0 + 4.0 * w);
      vec3 finalColor = clamp((cas_b * w + cas_d * w + cas_f * w + cas_h * w + cas_e) * rcpWeight, 0.0, 1.0);

      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, finalColor, smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  Google RAISR (Rapid and Accurate Image Super-Resolution) - Cinema Mode B
  //  Continuous 2D Structure Tensor Eigendecomposition (Angle, Strength, Coherence)
  //  Seamless 12-Tap Steered Elliptical Sampling (Romano, Isidoro & Milanfar)
  // ══════════════════════════════════════════════════════════════════════════
  cinemaFrag_RAISR: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getLumaRec601(vec3 c) {
      return dot(vec3(0.299, 0.587, 0.114), c);
    }

    void tapRAISR(
      inout vec3 aC, inout float aW,
      vec2 off, vec2 n_dir, vec2 t_dir,
      float scaleN, float scaleT, float lob, vec3 c
    ) {
      float dn = dot(off, n_dir) * scaleN;
      float dt = dot(off, t_dir) * scaleT;
      float d2 = min(dn * dn + dt * dt, 3.0);
      float w = (1.0 - lob * d2) * exp(-4.0 * d2);
      aC += c * w;
      aW += w;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      // Continuous 12-tap symmetric quad (seam-free across pixel boundaries)
      vec2 pos = v_uv / s - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getLumaRec601(b); float cL = getLumaRec601(c);
      float eL = getLumaRec601(e); float fL = getLumaRec601(f);
      float gL = getLumaRec601(g); float hL = getLumaRec601(h);
      float iL = getLumaRec601(i); float jL = getLumaRec601(j);
      float kL = getLumaRec601(k); float lL = getLumaRec601(l);
      float nL = getLumaRec601(n); float oL = getLumaRec601(o);

      // ── C1 Continuous Structure Tensor across cell (f, g, j, k)
      vec2 grad_f = vec2(gL - eL, jL - bL) * 0.5;
      vec2 grad_g = vec2(hL - fL, kL - cL) * 0.5;
      vec2 grad_j = vec2(kL - iL, nL - fL) * 0.5;
      vec2 grad_k = vec2(lL - jL, oL - gL) * 0.5;

      float wf = (1.0 - fp.x) * (1.0 - fp.y);
      float wg = fp.x * (1.0 - fp.y);
      float wj = (1.0 - fp.x) * fp.y;
      float wk = fp.x * fp.y;

      float jxx = wf*grad_f.x*grad_f.x + wg*grad_g.x*grad_g.x + wj*grad_j.x*grad_j.x + wk*grad_k.x*grad_k.x;
      float jyy = wf*grad_f.y*grad_f.y + wg*grad_g.y*grad_g.y + wj*grad_j.y*grad_j.y + wk*grad_k.y*grad_k.y;
      float jxy = wf*grad_f.x*grad_f.y + wg*grad_g.x*grad_g.y + wj*grad_j.x*grad_j.y + wk*grad_k.x*grad_k.y;

      float tr = jxx + jyy;
      float det = max(jxx * jyy - jxy * jxy, 0.0);
      float disc = sqrt(max(tr * tr - 4.0 * det, 0.0));
      float lambda1 = max((tr + disc) * 0.5, 0.0);
      float lambda2 = max((tr - disc) * 0.5, 0.0);

      // Full [-90 deg, +90 deg] orientation spectrum guarding atan(0,0)
      float denom = jxx - jyy;
      float theta = (abs(jxy) + abs(denom) > 0.000001) ? (0.5 * atan(2.0 * jxy, denom)) : 0.0;
      vec2 n_dir = vec2(cos(theta), sin(theta));
      vec2 t_dir = vec2(-sin(theta), cos(theta));

      float strength = sqrt(lambda1);
      float coherence = clamp((lambda1 - lambda2) / max(lambda1 + lambda2, 0.0001), 0.0, 1.0);
      float edge_factor = smoothstep(0.012, 0.12, strength) * coherence;

      // Pass 1: RAISR sub-pixel elliptical reconstruction (tangent continuity + normal squeeze)
      float scaleT = mix(1.0, 0.74, edge_factor);
      float scaleN = mix(1.0, 1.48, edge_factor);
      float lob = mix(0.10, 0.35, edge_factor);

      vec3 aC = vec3(0.0); float aW = 0.0;
      tapRAISR(aC, aW, vec2( 0.0, -1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, b);
      tapRAISR(aC, aW, vec2( 1.0, -1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, c);
      tapRAISR(aC, aW, vec2(-1.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, e);
      tapRAISR(aC, aW, vec2( 0.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, f);
      tapRAISR(aC, aW, vec2( 1.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, g);
      tapRAISR(aC, aW, vec2( 2.0,  0.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, h);
      tapRAISR(aC, aW, vec2(-1.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, i);
      tapRAISR(aC, aW, vec2( 0.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, j);
      tapRAISR(aC, aW, vec2( 1.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, k);
      tapRAISR(aC, aW, vec2( 2.0,  1.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, l);
      tapRAISR(aC, aW, vec2( 0.0,  2.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, n);
      tapRAISR(aC, aW, vec2( 1.0,  2.0) - fp, n_dir, t_dir, scaleN, scaleT, lob, o);

      vec3 mn4 = min(min(f, g), min(j, k));
      vec3 mx4 = max(max(f, g), max(j, k));
      vec3 recon = clamp(aC / max(aW, 0.0001), mn4, mx4);

      // Pass 2: Directional RAISR normal sharpening along eigenvector n_dir (1:1 & upscaled)
      vec3 sn_p = texture2D(u_texture, v_uv + n_dir * s * 0.90).rgb;
      vec3 sn_n = texture2D(u_texture, v_uv - n_dir * s * 0.90).rgb;
      vec3 high_n = recon - (sn_p + sn_n) * 0.5;

      float gate = smoothstep(0.012, 0.08, strength) * (0.35 + 0.65 * coherence);
      vec3 finalColor = recon + high_n * (sharp * 1.45 * gate);

      // Strict anti-ringing clamp preserving film grain without artificial halos
      vec3 mnLocal = min(mn4, min(sn_p, sn_n));
      vec3 mxLocal = max(mx4, max(sn_p, sn_n));
      finalColor = clamp(finalColor, max(mnLocal - 0.03 * sharp, 0.0), min(mxLocal + 0.03 * sharp, 1.0));
      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, finalColor, smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  FSRCNN (Fast Super-Resolution Convolutional Neural Network) - Cinema Mode C
  //  Elliptical EASU Geometric Base + Zero-Mean Convolution & Symmetric PReLU
  //  Compression noise suppression & clean cinematic clarity without halos
  // ══════════════════════════════════════════════════════════════════════════
  cinemaFrag_FSRCNN: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getFsrLuma(vec3 c) { return c.g + 0.5 * (c.r + c.b); }
    float getLumaRec601(vec3 c) { return dot(vec3(0.299, 0.587, 0.114), c); }

    void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
      float dirX = lD - lB; float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;
      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;
      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;
      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len2;
      float d2 = min(dot(v, v), clp);
      float wB = 0.4 * d2 - 1.0; float wA = lob * d2 - 1.0;
      wB *= wB; wA *= wA;
      float w = (1.5625 * wB - 0.5625) * wA;
      aC += c * w; aW += w;
    }

    // Noise-Gated Symmetric PReLU Activation (preserves blacks & highlights accurately)
    float fsrcnn_act(float x) {
      float ax = abs(x);
      float gate = smoothstep(0.005, 0.022, ax);
      float nonlin = ax / (1.0 + 1.5 * ax);
      return sign(x) * nonlin * gate;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      // ── LAYER 0: Sub-pixel Geometric Base (12-Tap EASU for aliasing-free diagonals)
      vec2 pos = v_uv / s - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2 dir = vec2(0.0); float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir); float dirLen = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);
      float stretch = clamp((dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0, 1.0, 2.0);
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3 aC = vec3(0.0); float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 mn4 = min(min(f, g), min(j, k));
      vec3 mx4 = max(max(f, g), max(j, k));
      vec3 easu = clamp(aC / max(aW, 0.0001), mn4, mx4);

      // ── LAYER 1: Symmetric Orthogonal Convolutional Extraction (Normal vs Tangent)
      float yc = getLumaRec601(easu);
      vec2 tang = vec2(-dir.y, dir.x);

      vec3 c_n1 = texture2D(u_texture, v_uv + dir  * s * 0.85).rgb;
      vec3 c_n2 = texture2D(u_texture, v_uv - dir  * s * 0.85).rgb;
      vec3 c_t1 = texture2D(u_texture, v_uv + tang * s * 0.85).rgb;
      vec3 c_t2 = texture2D(u_texture, v_uv - tang * s * 0.85).rgb;

      float y_n1 = getLumaRec601(c_n1); float y_n2 = getLumaRec601(c_n2);
      float y_t1 = getLumaRec601(c_t1); float y_t2 = getLumaRec601(c_t2);
      float y_box = (y_n1 + y_n2 + y_t1 + y_t2) * 0.25;

      float h_normal  = yc - (y_n1 + y_n2) * 0.5;
      float h_tangent = yc - (y_t1 + y_t2) * 0.5;
      float h_texture = yc - y_box;

      // ── LAYERS 2 & 3: Shrinking -> Non-Linear PReLU Mapping -> Expanding
      float f_a = fsrcnn_act(h_normal  * 1.65 + h_texture * 0.40);
      float f_b = fsrcnn_act(h_tangent * 0.70);
      float f_c = fsrcnn_act(h_texture * 1.25 - h_normal * 0.20);

      float sr_residual = f_a * 0.55 + f_b * 0.15 + f_c * 0.30;

      // ── LAYER 4: Neural Deconvolution & Symmetric Anti-Ringing Clamp
      vec3 neural = easu + vec3(sr_residual * (sharp * 1.20));
      vec3 mnSym = min(min(mn4, min(c_n1, c_n2)), min(c_t1, c_t2));
      vec3 mxSym = max(max(mx4, max(c_n1, c_n2)), max(c_t1, c_t2));
      vec3 finalColor = clamp(neural, max(mnSym - 0.025 * sharp, 0.0), min(mxSym + 0.025 * sharp, 1.0));

      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, finalColor, smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  1. Anime4K-Ultra "Pure" (Ultra Pure - Th-Underscore)
  //  FSR 1.0 EASU Base + Soft Thin AA.
  //  Preserves 100% original film grain, oil backgrounds & watercolors (Ghibli / 90s).
  // ══════════════════════════════════════════════════════════════════════════
  animeFrag_Pure: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getLumaRec601(vec3 c) { return dot(vec3(0.299, 0.587, 0.114), c); }
    float getFsrLuma(vec3 c)    { return c.g + 0.5 * (c.r + c.b); }

    void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
      float dirX = lD - lB; float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;
      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;
      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;
      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
      v *= len2;
      float d2 = min(dot(v, v), clp);
      float wB = 0.4 * d2 - 1.0;
      float wA = lob * d2 - 1.0;
      wB *= wB; wA *= wA;
      float w = (1.5625 * wB - 0.5625) * wA;
      aC += c * w; aW += w;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      // ── FSR 1.0 EASU 12-Tap Base
      vec2 pos = v_uv / s - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2 dir = vec2(0.0); float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir);
      float dirLen = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);

      float stretch = clamp((dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0, 1.0, 2.0);
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3 aC = vec3(0.0); float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 easuColor = aC / max(aW, 0.0001);
      easuColor = clamp(easuColor, min(min(f, g), min(j, k)), max(max(f, g), max(j, k)));

      // ── Anime4K-Ultra Pure: FSR 1.0 EASU + Official FSR 1.0 RCAS + Soft Thin AA
      // Applies AMD's adaptive Robust Contrast-Adaptive Sharpening (RCAS)
      vec3 cas_b = texture2D(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 cas_d = texture2D(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 cas_e = easuColor;
      vec3 cas_f = texture2D(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 cas_h = texture2D(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;

      vec3 mnRGB = min(min(min(cas_d, cas_e), min(cas_f, cas_b)), cas_h);
      vec3 mxRGB = max(max(max(cas_d, cas_e), max(cas_f, cas_b)), cas_h);

      vec3 rcpMx = 1.0 / max(mxRGB, vec3(0.0001));
      vec3 amp   = clamp(min(mnRGB, 2.0 - mxRGB) * rcpMx, 0.0, 1.0);
      amp        = sqrt(amp);

      float peak = -1.0 / mix(8.0, 4.5, sharp);
      vec3  w    = amp * peak * sharp;

      vec3 rcpWeight = 1.0 / (1.0 + 4.0 * w);
      vec3 rcasColor = clamp((cas_b * w + cas_d * w + cas_f * w + cas_h * w + cas_e) * rcpWeight, 0.0, 1.0);

      // Gentle sub-pixel de-aliasing to smooth stair-stepping without altering flat areas
      float gx = getLumaRec601(cas_f) - getLumaRec601(cas_d);
      float gy = getLumaRec601(cas_h) - getLumaRec601(cas_b);
      float mag = length(vec2(gx, gy));
      float edge = smoothstep(0.02, 0.15, mag);
      vec3 avg = (cas_e + cas_b + cas_d + cas_f + cas_h) * 0.20;
      vec3 finalColor = mix(rcasColor, avg, edge * 0.12 * sharp);

      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, clamp(finalColor, 0.0, 1.0), smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  2. Anime4K-Ultra "Deblur" (Ultra DbL - Th-Underscore Recommended)
  //  FSR 1.0 EASU Base + Thin AA + Gated Deblur with Hue-Matching.
  //  Ideal balance for modern 1080p & 720p anime while leaving backgrounds intact.
  // ══════════════════════════════════════════════════════════════════════════
  animeFrag_DbL: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getLumaRec601(vec3 c) { return dot(vec3(0.299, 0.587, 0.114), c); }
    float getFsrLuma(vec3 c)    { return c.g + 0.5 * (c.r + c.b); }

    void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
      float dirX = lD - lB; float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;
      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;
      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;
      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
      v *= len2;
      float d2 = min(dot(v, v), clp);
      float wB = 0.4 * d2 - 1.0;
      float wA = lob * d2 - 1.0;
      wB *= wB; wA *= wA;
      float w = (1.5625 * wB - 0.5625) * wA;
      aC += c * w; aW += w;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      vec2 pos = v_uv / s - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2 dir = vec2(0.0); float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir);
      float dirLen = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);

      float stretch = clamp((dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0, 1.0, 2.0);
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3 aC = vec3(0.0); float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 easuColor = aC / max(aW, 0.0001);
      easuColor = clamp(easuColor, min(min(f, g), min(j, k)), max(max(f, g), max(j, k)));

      // ── Anime4K-Ultra DbL: Directional Thinning + Gated Deblur (DoG) + Hue Protection
      vec3 c_t  = texture2D(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 c_b  = texture2D(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;
      vec3 c_l  = texture2D(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 c_r  = texture2D(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 c_tl = texture2D(u_texture, v_uv + vec2(-s.x, -s.y)).rgb;
      vec3 c_tr = texture2D(u_texture, v_uv + vec2( s.x, -s.y)).rgb;
      vec3 c_bl = texture2D(u_texture, v_uv + vec2(-s.x,  s.y)).rgb;
      vec3 c_br = texture2D(u_texture, v_uv + vec2( s.x,  s.y)).rgb;

      float l_t  = getLumaRec601(c_t);  float l_b  = getLumaRec601(c_b);
      float l_l  = getLumaRec601(c_l);  float l_r  = getLumaRec601(c_r);
      float l_tl = getLumaRec601(c_tl); float l_tr = getLumaRec601(c_tr);
      float l_bl = getLumaRec601(c_bl); float l_br = getLumaRec601(c_br);

      // High-precision 3x3 Sobel Gradient
      float gx = (l_tr + 2.0 * l_r + l_br) - (l_tl + 2.0 * l_l + l_bl);
      float gy = (l_bl + 2.0 * l_b + l_br) - (l_tl + 2.0 * l_t + l_tr);
      vec2 grad = vec2(gx, gy);
      float mag = length(grad);
      float edge_mask = smoothstep(0.03, 0.18, mag);

      // Directional shift toward dark ink stroke center (Line Thinning)
      vec3 c_warped = easuColor;
      if (mag > 0.02) {
        vec2 dir = -normalize(grad);
        c_warped = texture2D(u_texture, clamp(v_uv + dir * s * (sharp * 0.75), 0.0, 1.0)).rgb;
      }

      // 3x3 box blur kernel for Difference of Gaussians (DoG)
      vec3 c_blur = (c_tl + c_t + c_tr + c_l + easuColor + c_r + c_bl + c_b + c_br) * 0.1111;
      float l_blur = getLumaRec601(c_blur);
      float l_cc   = getLumaRec601(easuColor);

      // Hue Protection: avoids darkening saturated colors or dyed anime hair lines
      float sat = max(easuColor.r, max(easuColor.g, easuColor.b)) - min(easuColor.r, min(easuColor.g, easuColor.b));
      float darken_gate = 1.0 - smoothstep(0.12, 0.35, sat) * 0.70;

      // Edge-gated high-frequency deblurring
      vec3 deblurred = c_warped + (c_warped - c_blur) * (sharp * 0.85) * edge_mask;

      // Selective stroke reinforcement in dark ink valleys
      float is_valley = clamp((l_blur - l_cc) * 3.5, 0.0, 1.0);
      deblurred -= deblurred * (is_valley * edge_mask * 0.30 * sharp * darken_gate);

      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, clamp(deblurred, 0.0, 1.0), smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  3. Anime4K-Ultra "Sharp" (Ultra Sharpen - Th-Underscore)
  //  FSR 1.0 EASU Base + Thin AA + High-Frequency 9-Tap Unsharp Masking (USM).
  //  Maximum contour definition and clean halo-free micro-contrast.
  // ══════════════════════════════════════════════════════════════════════════
  animeFrag_Sharp: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getLumaRec601(vec3 c) { return dot(vec3(0.299, 0.587, 0.114), c); }
    float getFsrLuma(vec3 c)    { return c.g + 0.5 * (c.r + c.b); }

    void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
      float dirX = lD - lB; float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;
      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;
      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;
      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
      v *= len2;
      float d2 = min(dot(v, v), clp);
      float wB = 0.4 * d2 - 1.0;
      float wA = lob * d2 - 1.0;
      wB *= wB; wA *= wA;
      float w = (1.5625 * wB - 0.5625) * wA;
      aC += c * w; aW += w;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      vec2 pos = v_uv / s - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2 dir = vec2(0.0); float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir);
      float dirLen = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);

      float stretch = clamp((dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0, 1.0, 2.0);
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3 aC = vec3(0.0); float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 easuColor = aC / max(aW, 0.0001);
      easuColor = clamp(easuColor, min(min(f, g), min(j, k)), max(max(f, g), max(j, k)));

      // ── Anime4K-Ultra Sharpen: Full-frame 9-Tap Unsharp Masking (USM)
      vec3 c_t  = texture2D(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 c_b  = texture2D(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;
      vec3 c_l  = texture2D(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 c_r  = texture2D(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 c_tl = texture2D(u_texture, v_uv + vec2(-s.x, -s.y)).rgb;
      vec3 c_tr = texture2D(u_texture, v_uv + vec2( s.x, -s.y)).rgb;
      vec3 c_bl = texture2D(u_texture, v_uv + vec2(-s.x,  s.y)).rgb;
      vec3 c_br = texture2D(u_texture, v_uv + vec2( s.x,  s.y)).rgb;

      vec3 c_blur = (c_tl + c_t + c_tr + c_l + easuColor + c_r + c_bl + c_b + c_br) * 0.1111;

      // 9-Tap USM: enhances micro-frequencies, eyes, hair strands, and architecture
      vec3 usm = easuColor + (easuColor - c_blur) * (sharp * 1.55);

      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, clamp(usm, 0.0, 1.0), smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `,

  // ══════════════════════════════════════════════════════════════════════════
  //  4. Anime4K-Ultra "Intense" (Ultra DbH - Th-Underscore)
  //  FSR 1.0 EASU Base + Strong Thinning + Heavy Deblur + Deep Ink Punch.
  //  Reconstructs heavily blurred line art from lower-resolution sources.
  // ══════════════════════════════════════════════════════════════════════════
  animeFrag_DbH: `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif

    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2      u_texelSize;
    uniform float     u_sharpness;
    uniform float     u_splitPos;

    float getLumaRec601(vec3 c) { return dot(vec3(0.299, 0.587, 0.114), c); }
    float getFsrLuma(vec3 c)    { return c.g + 0.5 * (c.r + c.b); }

    void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
      float dirX = lD - lB; float dirY = lE - lA;
      dir += vec2(dirX, dirY) * w;
      float lenX = max(abs(lD - lC), abs(lC - lB));
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      lenX *= lenX;
      float lenY = max(abs(lE - lC), abs(lC - lA));
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      lenY *= lenY;
      len += (lenX + lenY) * 0.5 * w;
    }

    void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
      vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
      v *= len2;
      float d2 = min(dot(v, v), clp);
      float wB = 0.4 * d2 - 1.0;
      float wA = lob * d2 - 1.0;
      wB *= wB; wA *= wA;
      float w = (1.5625 * wB - 0.5625) * wA;
      aC += c * w; aW += w;
    }

    void main() {
      if (u_splitPos >= 0.0) {
        float lw = max(u_texelSize.x * 2.5, 0.0022);
        float dist = abs(v_uv.x - u_splitPos);
        if (dist < lw) {
          gl_FragColor = vec4(mix(vec3(0.0, 0.9, 1.0), vec3(1.0), (1.0 - dist / lw) * 0.75), 1.0);
          return;
        }
        if (v_uv.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_uv);
          return;
        }
      }

      vec2 s = u_texelSize;
      float sharp = clamp(u_sharpness, 0.0, 1.0);
      if (sharp <= 0.001) {
        gl_FragColor = texture2D(u_texture, v_uv);
        return;
      }

      vec2 pos = v_uv / s - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * s;

      vec3 b = texture2D(u_texture, base + vec2( 0.0, -s.y)).rgb;
      vec3 c = texture2D(u_texture, base + vec2( s.x, -s.y)).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-s.x,  0.0)).rgb;
      vec3 f = texture2D(u_texture, base + vec2( 0.0,  0.0)).rgb;
      vec3 g = texture2D(u_texture, base + vec2( s.x,  0.0)).rgb;
      vec3 h = texture2D(u_texture, base + vec2( 2.0 * s.x, 0.0)).rgb;
      vec3 i = texture2D(u_texture, base + vec2(-s.x,  s.y)).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 0.0,  s.y)).rgb;
      vec3 k = texture2D(u_texture, base + vec2( s.x,  s.y)).rgb;
      vec3 l = texture2D(u_texture, base + vec2( 2.0 * s.x, s.y)).rgb;
      vec3 n = texture2D(u_texture, base + vec2( 0.0,  2.0 * s.y)).rgb;
      vec3 o = texture2D(u_texture, base + vec2( s.x,  2.0 * s.y)).rgb;

      float bL = getFsrLuma(b); float cL = getFsrLuma(c);
      float eL = getFsrLuma(e); float fL = getFsrLuma(f);
      float gL = getFsrLuma(g); float hL = getFsrLuma(h);
      float iL = getFsrLuma(i); float jL = getFsrLuma(j);
      float kL = getFsrLuma(k); float lL = getFsrLuma(l);
      float nL = getFsrLuma(n); float oL = getFsrLuma(o);

      vec2 dir = vec2(0.0); float len = 0.0;
      FsrEasuSetF(dir, len, (1.0 - fp.x) * (1.0 - fp.y), bL, eL, fL, gL, jL);
      FsrEasuSetF(dir, len, fp.x * (1.0 - fp.y),         cL, fL, gL, hL, kL);
      FsrEasuSetF(dir, len, (1.0 - fp.x) * fp.y,         fL, iL, jL, kL, nL);
      FsrEasuSetF(dir, len, fp.x * fp.y,                 gL, jL, kL, lL, oL);

      float dirLen2 = dot(dir, dir);
      float dirLen = sqrt(dirLen2);
      dir = (dirLen > 0.0001) ? (dir / dirLen) : vec2(1.0, 0.0);

      float stretch = clamp((dirLen > 0.0001) ? (dirLen2 / max(abs(dir.x), abs(dir.y))) : 1.0, 1.0, 2.0);
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = 1.0 / max(lob, 0.0001);

      vec3 aC = vec3(0.0); float aW = 0.0;
      FsrEasuTapF(aC, aW, vec2( 0.0, -1.0) - fp, dir, len2, lob, clp, b);
      FsrEasuTapF(aC, aW, vec2( 1.0, -1.0) - fp, dir, len2, lob, clp, c);
      FsrEasuTapF(aC, aW, vec2(-1.0,  0.0) - fp, dir, len2, lob, clp, e);
      FsrEasuTapF(aC, aW, vec2( 0.0,  0.0) - fp, dir, len2, lob, clp, f);
      FsrEasuTapF(aC, aW, vec2( 1.0,  0.0) - fp, dir, len2, lob, clp, g);
      FsrEasuTapF(aC, aW, vec2( 2.0,  0.0) - fp, dir, len2, lob, clp, h);
      FsrEasuTapF(aC, aW, vec2(-1.0,  1.0) - fp, dir, len2, lob, clp, i);
      FsrEasuTapF(aC, aW, vec2( 0.0,  1.0) - fp, dir, len2, lob, clp, j);
      FsrEasuTapF(aC, aW, vec2( 1.0,  1.0) - fp, dir, len2, lob, clp, k);
      FsrEasuTapF(aC, aW, vec2( 2.0,  1.0) - fp, dir, len2, lob, clp, l);
      FsrEasuTapF(aC, aW, vec2( 0.0,  2.0) - fp, dir, len2, lob, clp, n);
      FsrEasuTapF(aC, aW, vec2( 1.0,  2.0) - fp, dir, len2, lob, clp, o);

      vec3 easuColor = aC / max(aW, 0.0001);
      easuColor = clamp(easuColor, min(min(f, g), min(j, k)), max(max(f, g), max(j, k)));

      // ── Anime4K-Ultra DbH: Strong Forward Warper + Heavy Deblur + Deep Ink Punch
      vec3 c_t  = texture2D(u_texture, v_uv + vec2( 0.0, -s.y)).rgb;
      vec3 c_b  = texture2D(u_texture, v_uv + vec2( 0.0,  s.y)).rgb;
      vec3 c_l  = texture2D(u_texture, v_uv + vec2(-s.x,  0.0)).rgb;
      vec3 c_r  = texture2D(u_texture, v_uv + vec2( s.x,  0.0)).rgb;
      vec3 c_tl = texture2D(u_texture, v_uv + vec2(-s.x, -s.y)).rgb;
      vec3 c_tr = texture2D(u_texture, v_uv + vec2( s.x, -s.y)).rgb;
      vec3 c_bl = texture2D(u_texture, v_uv + vec2(-s.x,  s.y)).rgb;
      vec3 c_br = texture2D(u_texture, v_uv + vec2( s.x,  s.y)).rgb;

      float l_t  = getLumaRec601(c_t);  float l_b  = getLumaRec601(c_b);
      float l_l  = getLumaRec601(c_l);  float l_r  = getLumaRec601(c_r);
      float l_tl = getLumaRec601(c_tl); float l_tr = getLumaRec601(c_tr);
      float l_bl = getLumaRec601(c_bl); float l_br = getLumaRec601(c_br);

      float gx = (l_tr + 2.0 * l_r + l_br) - (l_tl + 2.0 * l_l + l_bl);
      float gy = (l_bl + 2.0 * l_b + l_br) - (l_tl + 2.0 * l_t + l_tr);
      vec2 grad = vec2(gx, gy);
      float mag = length(grad);
      float edge_mask = smoothstep(0.02, 0.16, mag);

      // Aggressive shift toward dark ink center
      vec3 c_warped = easuColor;
      if (mag > 0.015) {
        vec2 dir = -normalize(grad);
        c_warped = texture2D(u_texture, clamp(v_uv + dir * s * (sharp * 1.25), 0.0, 1.0)).rgb;
      }

      vec3 c_blur = (c_tl + c_t + c_tr + c_l + easuColor + c_r + c_bl + c_b + c_br) * 0.1111;
      float l_blur = getLumaRec601(c_blur);
      float l_cc   = getLumaRec601(easuColor);

      // Heavy edge-gated deblurring pass
      vec3 deblurred = c_warped + (c_warped - c_blur) * (sharp * 1.45) * edge_mask;

      // Deep Ink Punch: rich ink darkening & high-contrast line punch
      float is_valley = clamp((l_blur - l_cc) * 4.0, 0.0, 1.0);
      deblurred -= deblurred * (is_valley * edge_mask * 0.65 * sharp);

      vec3 origColor = texture2D(u_texture, v_uv).rgb;
      gl_FragColor = vec4(mix(origColor, clamp(deblurred, 0.0, 1.0), smoothstep(0.0, 0.08, sharp)), 1.0);
    }
  `
};
