/**
 * NovaScale - WebGPU Compute Engine v1.0 (Tier 1 Zero-Copy + RGBA16F Pipeline)
 *
 * Uses GPUDevice.importExternalTexture(video) for zero-copy hardware-decoded YUV->Linear
 * sampling, WGSL compute shaders in rgba16float, ACES Filmic tone mapping, and
 * procedural film grain synthesis. Gracefully falls back to WebGL2 if unavailable.
 */

class NovaScaleWebGPUEngine {
  constructor(canvas, onFatalError = null, onReady = null) {
    this.canvas          = canvas;
    this.onFatalError    = onFatalError;
    this.onReady         = onReady;
    this.device          = null;
    this.context         = null;
    this.format          = 'bgra8unorm';
    this.ready           = false;
    this.failed          = false;
    this.isContextLost   = false;

    this.currentMode     = 'anime-dbl';
    this.sharpness       = 0.75;
    this.hdr             = false;
    this.multiLayer      = false;
    this.deepMode        = false;
    this.splitPos        = -1.0;
    this.temporalDenoise = 0.0;
    this.mirrorX         = false;

    this._srcW           = 0;
    this._srcH           = 0;
    this._dstW           = 0;
    this._dstH           = 0;
    this._histValid      = false;
    this._frameIndex     = 0;
    this._lastTime       = -1;

    this._linearSampler  = null;
    this._prepassPipe    = null;
    this._upscalePipe    = null;
    this._renderPipe     = null;

    this._prepassUniform = null;
    this._upscaleUniform = null;
    this._renderUniform  = null;

    this._linearTex      = null;
    this._prevLinearTex  = null;
    this._upscaledTex    = null;

    this._initPromise = this._initAsync();
  }

  async _initAsync() {
    try {
      if (!navigator.gpu || !window.NovaWebGPUShaders) {
        this._markFailed('WebGPU API or shaders unavailable');
        return;
      }

      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        this._markFailed('No WebGPU adapter found');
        return;
      }

      this.device = await adapter.requestDevice();
      this.device.lost.then((info) => {
        this.isContextLost = true;
        this.ready = false;
        if (info.reason !== 'destroyed') {
          this._markFailed(`WebGPU device lost: ${info.message}`);
        }
      });

      this.context = this.canvas.getContext('webgpu');
      if (!this.context) {
        this._markFailed('Failed to acquire webgpu canvas context');
        return;
      }

      this.format = navigator.gpu.getPreferredCanvasFormat
        ? navigator.gpu.getPreferredCanvasFormat()
        : 'bgra8unorm';

      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque'
      });

      this._linearSampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      });

      const sh = window.NovaWebGPUShaders;

      this.device.pushErrorScope('validation');
      this._prepassPipe = this.device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: this.device.createShaderModule({ code: sh.prepassCompute }),
          entryPoint: 'main'
        }
      });

      this._upscalePipe = this.device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: this.device.createShaderModule({ code: sh.upscaleCompute }),
          entryPoint: 'main'
        }
      });

      const renderMod = this.device.createShaderModule({ code: sh.finalRender });
      this._renderPipe = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: renderMod, entryPoint: 'vsMain' },
        fragment: {
          module: renderMod,
          entryPoint: 'fsMain',
          targets: [{ format: this.format }]
        },
        primitive: { topology: 'triangle-list' }
      });

      this._prepassUniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this._upscaleUniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this._renderUniform  = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

      const valErr = await this.device.popErrorScope();
      if (valErr) {
        this._markFailed(`WGSL/Pipeline validation error: ${valErr.message}`);
        return;
      }

      this.ready = true;
      console.info('[NovaScale] Tier-1 WebGPU Compute Engine initialized (rgba16float + zero-copy).');
      if (typeof this.onReady === 'function') {
        this.onReady();
      }
    } catch (err) {
      this._markFailed(err && err.message ? err.message : 'WebGPU init error');
    }
  }

  _markFailed(reason) {
    this.failed = true;
    this.ready  = false;
    console.warn('[NovaScale] WebGPU unavailable, falling back to WebGL2:', reason);
    if (typeof this.onFatalError === 'function') {
      this.onFatalError(reason);
    }
  }

  _ensureTextures(srcW, srcH, dstW, dstH) {
    const dev = this.device;
    if (this._srcW !== srcW || this._srcH !== srcH) {
      if (this._linearTex) this._linearTex.destroy();
      if (this._prevLinearTex) this._prevLinearTex.destroy();

      this._linearTex = dev.createTexture({
        size: [srcW, srcH],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      });
      this._prevLinearTex = dev.createTexture({
        size: [srcW, srcH],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      this._srcW = srcW;
      this._srcH = srcH;
      this._histValid = false;
    }

    if (this._dstW !== dstW || this._dstH !== dstH) {
      if (this._upscaledTex) this._upscaledTex.destroy();
      this._upscaledTex = dev.createTexture({
        size: [dstW, dstH],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
      });
      this._dstW = dstW;
      this._dstH = dstH;
    }
  }

  setMode(mode) { this.currentMode = mode || 'anime-dbl'; }
  setSharpness(v) { const n = parseFloat(v); if (!isNaN(n)) this.sharpness = Math.min(1, Math.max(0, n)); }
  setHdr(v) { this.hdr = Boolean(v); }
  setMultiLayer(v) { this.multiLayer = Boolean(v); }
  setDeepMode(v) { this.deepMode = Boolean(v); }
  setDeepIntensity(v) { const n = parseFloat(v); if (!isNaN(n)) this.deepIntensity = Math.min(1, Math.max(0, n)); }
  setSplit(v) { this.splitPos = typeof v === 'number' ? Math.min(1, Math.max(-1, v)) : (v ? 0.5 : -1); }
  setTemporalDenoise(v) {
    const n = parseFloat(v);
    if (!isNaN(n)) {
      this.temporalDenoise = Math.min(1, Math.max(0, n));
      if (this.temporalDenoise <= 0.01) this._histValid = false;
    }
  }
  setMirror(v) {
    const m = Boolean(v);
    if (m !== this.mirrorX) { this.mirrorX = m; this._histValid = false; }
  }
  resetTemporalHistory() { this._histValid = false; }

  render(video, _forceUpload = false) {
    if (this.failed || this.isContextLost) return false;
    if (!this.ready || !this.device || !this.context) return true;
    if (!video || video.readyState < 2) return true;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const dstW = this.canvas.width;
    const dstH = this.canvas.height;
    if (!srcW || !srcH || !dstW || !dstH) return true;

    let externalTex;
    try {
      externalTex = this.device.importExternalTexture({ source: video });
    } catch (e) {
      if (e && (e.name === 'SecurityError' || (e.message && e.message.includes('tainted')))) {
        return false;
      }
      return true;
    }

    this._ensureTextures(srcW, srcH, dstW, dstH);

    const isAnime = !String(this.currentMode).startsWith('cinema') ? 1.0 : 0.0;
    const curTime = video.currentTime;
    const isNewFrame = Math.abs(curTime - this._lastTime) > 0.0001;
    if (isNewFrame) {
      this._lastTime = curTime;
      this._frameIndex = (this._frameIndex + 1) % 10000;
    }

    // Update Uniforms
    this.device.queue.writeBuffer(this._prepassUniform, 0, new Float32Array([
      srcW, srcH,
      this.temporalDenoise,
      isAnime,
      this.mirrorX ? 1.0 : 0.0,
      this._histValid ? 1.0 : 0.0,
      0.0, 0.0
    ]));

    this.device.queue.writeBuffer(this._upscaleUniform, 0, new Float32Array([
      srcW, srcH,
      dstW, dstH,
      this.sharpness,
      isAnime,
      this.multiLayer ? 1.0 : 0.0,
      this.deepMode ? 1.0 : 0.0
    ]));

    this.device.queue.writeBuffer(this._renderUniform, 0, new Float32Array([
      this.sharpness,
      this.hdr ? 1.0 : 0.0,
      isAnime,
      this.splitPos,
      this._frameIndex,
      this.mirrorX ? 1.0 : 0.0,
      0.0, 0.0
    ]));

    const encoder = this.device.createCommandEncoder();

    // Pass 1: Zero-Copy ExternalTexture -> Linear FP16 + Deband + Temporal Gate
    const prepassBG = this.device.createBindGroup({
      layout: this._prepassPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: externalTex },
        { binding: 1, resource: this._linearSampler },
        { binding: 2, resource: this._prevLinearTex.createView() },
        { binding: 3, resource: this._linearTex.createView() },
        { binding: 4, resource: { buffer: this._prepassUniform } }
      ]
    });
    const cPass1 = encoder.beginComputePass();
    cPass1.setPipeline(this._prepassPipe);
    cPass1.setBindGroup(0, prepassBG);
    cPass1.dispatchWorkgroups(Math.ceil(srcW / 16), Math.ceil(srcH / 16));
    cPass1.end();

    // Update temporal history buffer on new video frames
    if (isNewFrame && this.temporalDenoise > 0.01) {
      encoder.copyTextureToTexture(
        { texture: this._linearTex },
        { texture: this._prevLinearTex },
        [srcW, srcH]
      );
      this._histValid = true;
    }

    // Pass 2: Anisotropic Structure-Tensor Upscaling in Linear FP16
    const upscaleBG = this.device.createBindGroup({
      layout: this._upscalePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this._linearTex.createView() },
        { binding: 1, resource: this._linearSampler },
        { binding: 2, resource: this._upscaledTex.createView() },
        { binding: 3, resource: { buffer: this._upscaleUniform } }
      ]
    });
    const cPass2 = encoder.beginComputePass();
    cPass2.setPipeline(this._upscalePipe);
    cPass2.setBindGroup(0, upscaleBG);
    cPass2.dispatchWorkgroups(Math.ceil(dstW / 16), Math.ceil(dstH / 16));
    cPass2.end();

    // Pass 3: ACES Filmic + Film Grain Synthesis + Split-Screen -> Swapchain
    const renderBG = this.device.createBindGroup({
      layout: this._renderPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this._upscaledTex.createView() },
        { binding: 1, resource: this._linearTex.createView() },
        { binding: 2, resource: this._linearSampler },
        { binding: 3, resource: { buffer: this._renderUniform } }
      ]
    });
    const rPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    rPass.setPipeline(this._renderPipe);
    rPass.setBindGroup(0, renderBG);
    rPass.draw(6);
    rPass.end();

    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  destroy() {
    this.isContextLost = true;
    this.ready = false;
    try {
      if (this._linearTex) this._linearTex.destroy();
      if (this._prevLinearTex) this._prevLinearTex.destroy();
      if (this._upscaledTex) this._upscaledTex.destroy();
      if (this._prepassUniform) this._prepassUniform.destroy();
      if (this._upscaleUniform) this._upscaleUniform.destroy();
      if (this._renderUniform) this._renderUniform.destroy();
      if (this.device) this.device.destroy();
    } catch (_) {}
    this.device = null;
    this.context = null;
    this.canvas = null;
  }
}

window.NovaScaleWebGPUEngine = NovaScaleWebGPUEngine;
