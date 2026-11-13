/**
 * NovaScale - WebGPU WGSL Compute & Render Shader Suite (Tier 1 Engine)
 *
 * Pipeline:
 * 1. prepassCompute : Zero-copy texture_external -> Linear BT.709 -> Directional Debanding -> Temporal Gate -> rgba16float
 * 2. upscaleCompute : Linear FP16 Anisotropic Reconstruction + RCAS / Anime Line-Art Thinning -> rgba16float
 * 3. finalRender    : Uniform-safe textureSample -> ACES Filmic -> Procedural Film Grain -> Split-Screen -> 10-bit Dither
 */

window.NovaWebGPUShaders = {
  prepassCompute: /* wgsl */ `
    struct PrepassParams {
      srcSize: vec2<f32>,
      temporalStrength: f32,
      isAnime: f32,
      mirrorX: f32,
      histValid: f32,
      _pad0: f32,
      _pad1: f32,
    };

    @group(0) @binding(0) var videoTex: texture_external;
    @group(0) @binding(1) var linearSampler: sampler;
    @group(0) @binding(2) var prevLinearTex: texture_2d<f32>;
    @group(0) @binding(3) var outLinearFP16: texture_storage_2d<rgba16float, write>;
    @group(0) @binding(4) var<uniform> params: PrepassParams;

    fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
      let s = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
      return s * s * (0.72 + 0.28 * s);
    }

    fn lumaBT709(lin: vec3<f32>) -> f32 {
      return dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722));
    }

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let dims = textureDimensions(outLinearFP16);
      if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
      }

      var uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims);
      if (params.mirrorX > 0.5) {
        uv.x = 1.0 - uv.x;
      }

      let texel = 1.0 / max(params.srcSize, vec2<f32>(1.0));
      let centerSrgb = textureSampleBaseClampToEdge(videoTex, linearSampler, uv).rgb;
      let centerLin = srgbToLinear(centerSrgb);

      // 1. Directional Debanding in Linear FP16 (4-tap spiral at native grid)
      let r1 = texel * select(3.0, 5.0, params.isAnime > 0.5);
      let s1 = srgbToLinear(textureSampleBaseClampToEdge(videoTex, linearSampler, uv + vec2<f32>( r1.x,  r1.y)).rgb);
      let s2 = srgbToLinear(textureSampleBaseClampToEdge(videoTex, linearSampler, uv + vec2(-r1.x,  r1.y)).rgb);
      let s3 = srgbToLinear(textureSampleBaseClampToEdge(videoTex, linearSampler, uv + vec2( r1.x, -r1.y)).rgb);
      let s4 = srgbToLinear(textureSampleBaseClampToEdge(videoTex, linearSampler, uv + vec2(-r1.x, -r1.y)).rgb);

      let avgSpiral = (s1 + s2 + s3 + s4) * 0.25;
      let maxDiff = max(
        max(length(centerLin - s1), length(centerLin - s2)),
        max(length(centerLin - s3), length(centerLin - s4))
      );
      let bandThreshold = select(0.010, 0.018, params.isAnime > 0.5);
      let debandMask = 1.0 - smoothstep(0.002, bandThreshold, maxDiff);
      var cleanLin = mix(centerLin, avgSpiral, debandMask * 0.55);

      // 2. Temporal Accumulation with 12fps Duplicate-Frame Gate
      var motionConf: f32 = 1.0;
      if (params.temporalStrength > 0.01 && params.histValid > 0.5) {
        let prevLin = textureLoad(prevLinearTex, vec2<i32>(gid.xy), 0).rgb;
        let diff = length(cleanLin - prevLin) + abs(lumaBT709(cleanLin) - lumaBT709(prevLin)) * 1.5;
        let isDuplicate = 1.0 - smoothstep(0.004, 0.012, diff);
        let motionGate  = 1.0 - smoothstep(0.012, 0.065, diff);
        let blendFactor = clamp(params.temporalStrength * mix(0.68, 0.88, isDuplicate) * motionGate, 0.0, 0.88);
        cleanLin = mix(cleanLin, prevLin, blendFactor);
        motionConf = 1.0 - motionGate;
      }

      textureStore(outLinearFP16, vec2<i32>(gid.xy), vec4<f32>(cleanLin, motionConf));
    }
  `,

  upscaleCompute: /* wgsl */ `
    struct UpscaleParams {
      srcSize: vec2<f32>,
      dstSize: vec2<f32>,
      sharpness: f32,
      isAnime: f32,
      multiLayer: f32,
      _pad0: f32,
    };

    @group(0) @binding(0) var inLinearFP16: texture_2d<f32>;
    @group(0) @binding(1) var linearSampler: sampler;
    @group(0) @binding(2) var outUpscaledFP16: texture_storage_2d<rgba16float, write>;
    @group(0) @binding(3) var<uniform> params: UpscaleParams;

    fn lumaBT709(lin: vec3<f32>) -> f32 {
      return dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722));
    }

    fn fetchSrc(coord: vec2<i32>, maxC: vec2<i32>) -> vec3<f32> {
      let c = clamp(coord, vec2<i32>(0), maxC);
      return textureLoad(inLinearFP16, c, 0).rgb;
    }

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let dims = textureDimensions(outUpscaledFP16);
      if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
      }

      let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims);
      let srcTexSize = vec2<i32>(textureDimensions(inLinearFP16));
      let maxCoord = max(srcTexSize - vec2<i32>(1), vec2<i32>(0));

      let pos = uv * vec2<f32>(srcTexSize) - 0.5;
      let fp = fract(pos);
      let base = vec2<i32>(floor(pos));

      // 12-tap neighborhood in Linear FP16
      let b = fetchSrc(base + vec2<i32>( 0, -1), maxCoord);
      let c = fetchSrc(base + vec2<i32>( 1, -1), maxCoord);
      let e = fetchSrc(base + vec2<i32>(-1,  0), maxCoord);
      let f = fetchSrc(base + vec2<i32>( 0,  0), maxCoord);
      let g = fetchSrc(base + vec2<i32>( 1,  0), maxCoord);
      let h = fetchSrc(base + vec2<i32>( 2,  0), maxCoord);
      let i = fetchSrc(base + vec2<i32>(-1,  1), maxCoord);
      let j = fetchSrc(base + vec2<i32>( 0,  1), maxCoord);
      let k = fetchSrc(base + vec2<i32>( 1,  1), maxCoord);
      let l = fetchSrc(base + vec2<i32>( 2,  1), maxCoord);
      let n = fetchSrc(base + vec2<i32>( 0,  2), maxCoord);
      let o = fetchSrc(base + vec2<i32>( 1,  2), maxCoord);

      let bL = lumaBT709(b); let cL = lumaBT709(c);
      let eL = lumaBT709(e); let fL = lumaBT709(f);
      let gL = lumaBT709(g); let hL = lumaBT709(h);
      let iL = lumaBT709(i); let jL = lumaBT709(j);
      let kL = lumaBT709(k); let lL = lumaBT709(l);
      let nL = lumaBT709(n); let oL = lumaBT709(o);

      // Continuous Structure Tensor (Linear Space)
      let grad_f = vec2<f32>(gL - eL, jL - bL) * 0.5;
      let grad_g = vec2<f32>(hL - fL, kL - cL) * 0.5;
      let grad_j = vec2<f32>(kL - iL, nL - fL) * 0.5;
      let grad_k = vec2<f32>(lL - jL, oL - gL) * 0.5;

      let wf = (1.0 - fp.x) * (1.0 - fp.y);
      let wg = fp.x * (1.0 - fp.y);
      let wj = (1.0 - fp.x) * fp.y;
      let wk = fp.x * fp.y;

      let jxx = wf*grad_f.x*grad_f.x + wg*grad_g.x*grad_g.x + wj*grad_j.x*grad_j.x + wk*grad_k.x*grad_k.x;
      let jyy = wf*grad_f.y*grad_f.y + wg*grad_g.y*grad_g.y + wj*grad_j.y*grad_j.y + wk*grad_k.y*grad_k.y;
      let jxy = wf*grad_f.x*grad_f.y + wg*grad_g.x*grad_g.y + wj*grad_j.x*grad_j.y + wk*grad_k.x*grad_k.y;

      let tr = jxx + jyy;
      let det = max(jxx * jyy - jxy * jxy, 0.0);
      let disc = sqrt(max(tr * tr - 4.0 * det, 0.0));
      let lambda1 = max((tr + disc) * 0.5, 0.0);
      let lambda2 = max((tr - disc) * 0.5, 0.0);

      let rawN = select(vec2<f32>(2.0 * jxy, jyy - jxx + disc), vec2<f32>(jxx - jyy + disc, 2.0 * jxy), jxx >= jyy);
      let rawLen = length(rawN);
      let nDir = select(vec2<f32>(1.0, 0.0), rawN / rawLen, rawLen > 1e-6);
      let tDir = vec2<f32>(-nDir.y, nDir.x);

      let strength = sqrt(lambda1);
      let coherence = clamp((lambda1 - lambda2) / max(lambda1 + lambda2, 0.0001), 0.0, 1.0);
      let edgeFactor = smoothstep(0.005, 0.065, strength) * coherence;

      let scaleT = mix(1.0, 0.65, edgeFactor);
      let scaleN = mix(1.0, 1.62, edgeFactor);
      let lob = mix(0.12, 0.38, edgeFactor);

      var aC = vec3<f32>(0.0);
      var aW: f32 = 0.0;

      let offs = array<vec2<f32>, 12>(
        vec2<f32>( 0.0, -1.0), vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  0.0), vec2<f32>( 0.0,  0.0), vec2<f32>( 1.0,  0.0), vec2<f32>( 2.0,  0.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 0.0,  1.0), vec2<f32>( 1.0,  1.0), vec2<f32>( 2.0,  1.0),
        vec2<f32>( 0.0,  2.0), vec2<f32>( 1.0,  2.0)
      );
      let cols = array<vec3<f32>, 12>(b, c, e, f, g, h, i, j, k, l, n, o);

      for (var idx: u32 = 0u; idx < 12u; idx = idx + 1u) {
        let off = offs[idx] - fp;
        let dn = dot(off, nDir) * scaleN;
        let dt = dot(off, tDir) * scaleT;
        let d2 = min(dn * dn + dt * dt, 3.0);
        let t = max(1.0 - d2 * 0.3333, 0.0);
        let w = (1.0 - lob * d2) * (t * t * t);
        aC += cols[idx] * w;
        aW += w;
      }

      let mn4 = min(min(f, g), min(j, k));
      let mx4 = max(max(f, g), max(j, k));
      var recon = clamp(aC / max(aW, 0.0001), mn4, mx4);

      let sharp = clamp(params.sharpness, 0.0, 1.0) * (1.0 + 0.28 * params.multiLayer);

      // Anime Line-Art Consolidation (Normal-axis directional warp) vs Cinema RCAS
      if (params.isAnime > 0.5 && rawLen > 1e-5) {
        let pBright = textureSampleLevel(inLinearFP16, linearSampler, clamp((vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims) + nDir * (1.0 / params.srcSize) * 0.72, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
        let pDark   = textureSampleLevel(inLinearFP16, linearSampler, clamp((vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims) - nDir * (1.0 / params.srcSize) * 0.72, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
        let lMid = (lumaBT709(pBright) + lumaBT709(pDark)) * 0.5;
        let tPinch = smoothstep(-0.025, 0.025, (lumaBT709(recon) - lMid) + 0.020 * sharp);
        let pinched = mix(pDark, pBright, tPinch);
        recon = mix(recon, pinched, edgeFactor * (0.45 + 0.40 * sharp));
      }

      // Linear-Space Contrast Adaptive Sharpening (RCAS-inspired)
      let ringAvg = (e + g + b + j) * 0.25;
      let detail = recon - ringAvg;
      let mnLocal = min(min(f, g), min(min(j, k), min(min(b, e), min(h, n))));
      let mxLocal = max(max(f, g), max(max(j, k), max(max(b, e), max(h, n))));
      let gain = select(1.35, 1.85, params.isAnime > 0.5) * sharp * (0.35 + 0.65 * edgeFactor);
      let enhanced = clamp(
        recon + detail * gain,
        max(mnLocal - 0.04 * sharp, vec3<f32>(0.0)),
        min(mxLocal + 0.04 * sharp, vec3<f32>(1.0))
      );

      textureStore(outUpscaledFP16, vec2<i32>(gid.xy), vec4<f32>(enhanced, edgeFactor));
    }
  `,

  finalRender: /* wgsl */ `
    struct RenderParams {
      sharpness: f32,
      hdr: f32,
      isAnime: f32,
      splitPos: f32,
      frameIndex: f32,
      mirrorX: f32,
      _pad0: f32,
      _pad1: f32,
    };

    struct VertexOutput {
      @builtin(position) pos: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @group(0) @binding(0) var upscaledTex: texture_2d<f32>;
    @group(0) @binding(1) var origLinearTex: texture_2d<f32>;
    @group(0) @binding(2) var linearSampler: sampler;
    @group(0) @binding(3) var<uniform> params: RenderParams;

    @vertex
    fn vsMain(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
      var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
      );
      let p = positions[vIdx];
      var out: VertexOutput;
      out.pos = vec4<f32>(p, 0.0, 1.0);
      out.uv = vec2<f32>((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
      return out;
    }

    fn linearToSrgb(lin: vec3<f32>) -> vec3<f32> {
      let c = clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0));
      return pow(max(c, vec3<f32>(1e-5)), vec3<f32>(1.0 / 2.2));
    }

    fn acesFilmic(x: vec3<f32>) -> vec3<f32> {
      let a = 2.51;
      let b = 0.03;
      let c = 2.43;
      let d = 0.59;
      let e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
    }

    fn hash13(p3: vec3<f32>) -> f32 {
      var p = fract(p3 * 0.1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }

    fn ignDither10Bit(fragCoord: vec2<f32>) -> f32 {
      let n = fract(52.9829189 * fract(dot(fragCoord, vec2<f32>(0.06711056, 0.00583715))));
      return (n - 0.5) / 512.0;
    }

    @fragment
    fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
      // Sample BOTH textures unconditionally in uniform control flow (WGSL uniformity rule)
      let upLinSample   = textureSample(upscaledTex, linearSampler, in.uv).rgb;
      let origLinSample = textureSample(origLinearTex, linearSampler, in.uv).rgb;

      if (params.splitPos >= 0.0) {
        let dist = abs(in.uv.x - params.splitPos);
        if (dist < 0.0022) {
          let glow = 1.0 - (dist / 0.0022);
          return vec4<f32>(mix(vec3<f32>(0.0, 0.9, 1.0), vec3<f32>(1.0), glow * 0.75), 1.0);
        }
        if (in.uv.x < params.splitPos) {
          return vec4<f32>(linearToSrgb(origLinSample), 1.0);
        }
      }

      var lin = upLinSample;
      if (params.sharpness < 0.08) {
        lin = mix(origLinSample, lin, smoothstep(0.0, 0.08, params.sharpness));
      }

      if (params.hdr > 0.5) {
        let exposure = select(1.18, 1.12, params.isAnime > 0.5);
        lin = acesFilmic(lin * exposure);
        let luma = dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722));
        let vib = select(0.14, 0.18, params.isAnime > 0.5);
        lin = mix(vec3<f32>(luma), lin, 1.0 + vib * (1.0 - smoothstep(0.65, 0.95, luma)));
      }

      if (params.isAnime < 0.5 && params.sharpness > 0.05) {
        let luma = dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722));
        let grainBell = smoothstep(0.03, 0.25, luma) * (1.0 - smoothstep(0.65, 0.95, luma));
        let n1 = hash13(vec3<f32>(floor(in.pos.xy), params.frameIndex * 1.37));
        let n2 = hash13(vec3<f32>(floor(in.pos.xy) + 17.0, params.frameIndex * 2.13));
        let gaussian = (n1 + n2 - 1.0);
        let grainAmp = 0.012 * grainBell * clamp(params.sharpness, 0.2, 1.0);
        lin = max(lin + vec3<f32>(gaussian * grainAmp), vec3<f32>(0.0));
      }

      let srgb = linearToSrgb(lin) + vec3<f32>(ignDither10Bit(in.pos.xy));
      return vec4<f32>(clamp(srgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
    }
  `
};
