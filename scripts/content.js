/**
 * NovaScale - Content Script v4.0
 *
 * v4.0 Structural Enhancements:
 * 1. Sub-Bit Visibility (opacity: 0.0001): Prevents Blink from suspending
 *    requestVideoFrameCallback on YouTube and disables Windows 11 Hardware Overlay (MPO).
 * 2. DOM 'afterend' insertion with dynamic z-index sync: guarantees the canvas paints
 *    above <video> on JWPlayer, Video.js, Plyr, and YouTube without blocking player controls.
 * 3. Hot CORS auto-recovery: if gl.texImage2D throws SecurityError inside an iframe,
 *    reloads the stream with crossOrigin="anonymous" preserving exact playback timestamp.
 * 4. Recursive Shadow DOM discovery + global capture-phase media interception.
 */

(function () {
  'use strict';

  if (typeof window.__novascale_cleanup === 'function') {
    try { window.__novascale_cleanup(); } catch (_) {}
  }

  console.info('[NovaScale] Content Script v4.3 initialized at:', location.href);

  let config = {
    enabled:     true,
    mode:        'anime-dbl',
    sharpness:   0.75,
    hdr:         false,
    multiLayer:  false,
    deepMode:    false,
    splitScreen: false
  };

  function normalizeMode(m) {
    if (!m || m === 'anime' || m === 'anime-ultra' || m === 'anime-a') return 'anime-dbl';
    if (m === 'cinema') return 'cinema-fsr';
    return m;
  }

  function isProcessingActive() {
    return Boolean(config.enabled) && (
      Number(config.sharpness) > 0.001 ||
      Boolean(config.hdr) ||
      Boolean(config.deepMode) ||
      Boolean(config.splitScreen)
    );
  }

  // ── Engine B: Delegated DRM-Safe Compositor Pipeline (Zero-Read SVG GPU) ──
  function syncDrmCompositorPipeline() {
    const NS = 'http://www.w3.org/2000/svg';
    let svg = document.getElementById('novascale-drm-compositor');
    if (!svg && document.documentElement) {
      svg = document.createElementNS(NS, 'svg');
      svg.id = 'novascale-drm-compositor';
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      Object.assign(svg.style, {
        position: 'fixed',
        top: '-9999px',
        left: '-9999px',
        pointerEvents: 'none',
        width: '0px',
        height: '0px'
      });
      svg.innerHTML = `
        <defs>
          <filter id="novascale-drm-filter" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">
            <feConvolveMatrix id="ns-drm-conv" order="3 3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0" result="sharpened"/>
            <feComponentTransfer id="ns-drm-transfer" in="sharpened" result="tonemapped">
              <feFuncR id="ns-drm-r" type="table" tableValues="0 1"/>
              <feFuncG id="ns-drm-g" type="table" tableValues="0 1"/>
              <feFuncB id="ns-drm-b" type="table" tableValues="0 1"/>
            </feComponentTransfer>
            <feColorMatrix id="ns-drm-sat" in="tonemapped" type="saturate" values="1"/>
          </filter>
        </defs>
      `;
      document.documentElement.appendChild(svg);
    }
    if (!svg) return;

    const modeStr = String(config.mode || 'anime-dbl');
    const isAnime = !modeStr.startsWith('cinema');
    const sharp = Math.max(0, Math.min(1, Number(config.sharpness) || 0));
    const deepMul  = config.deepMode ? 1.15 : 1.0;
    const strength = sharp * (isAnime ? 0.50 : 0.38) * deepMul;
    const center = (1 + 4 * strength).toFixed(4);
    const neighbor = (-strength).toFixed(4);

    const conv = document.getElementById('ns-drm-conv');
    if (conv) {
      conv.setAttribute(
        'kernelMatrix',
        sharp > 0.001
          ? `0 ${neighbor} 0 ${neighbor} ${center} ${neighbor} 0 ${neighbor} 0`
          : '0 0 0 0 1 0 0 0 0'
      );
    }

    const rEl = document.getElementById('ns-drm-r');
    const gEl = document.getElementById('ns-drm-g');
    const bEl = document.getElementById('ns-drm-b');
    const satEl = document.getElementById('ns-drm-sat');

    if (config.hdr) {
      const curve = isAnime
        ? '0.0 0.082 0.208 0.355 0.505 0.672 0.830 0.932 1.0'
        : '0.0 0.085 0.214 0.358 0.502 0.662 0.820 0.924 1.0';
      if (rEl) rEl.setAttribute('tableValues', curve);
      if (gEl) gEl.setAttribute('tableValues', curve);
      if (bEl) bEl.setAttribute('tableValues', curve);
      if (satEl) satEl.setAttribute('values', isAnime ? '1.10' : '1.08');
    } else {
      if (rEl) rEl.setAttribute('tableValues', '0 1');
      if (gEl) gEl.setAttribute('tableValues', '0 1');
      if (bEl) bEl.setAttribute('tableValues', '0 1');
      if (satEl) satEl.setAttribute('values', '1');
    }
  }

  const activeInstances = new Map();
  let _updateTimer = null;

  // ── State synchronization with chrome.storage.local ──────────────────────
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(
      ['enabled', 'mode', 'sharpness', 'hdr', 'multiLayer', 'deepMode', 'splitScreen'],
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.enabled     !== undefined) config.enabled     = Boolean(res.enabled);
        if (res.mode)                      config.mode        = normalizeMode(res.mode);
        if (res.sharpness   !== undefined) config.sharpness   = Number(res.sharpness);
        if (res.hdr         !== undefined) config.hdr         = Boolean(res.hdr);
        if (res.multiLayer  !== undefined) config.multiLayer  = Boolean(res.multiLayer);
        if (res.deepMode    !== undefined) config.deepMode    = Boolean(res.deepMode);
        if (res.splitScreen !== undefined) config.splitScreen = Boolean(res.splitScreen);
        scheduleUpdateAll();
      }
    );

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('enabled'     in changes) config.enabled     = Boolean(changes.enabled.newValue);
      if ('mode'        in changes) config.mode        = normalizeMode(changes.mode.newValue);
      if ('sharpness'   in changes) config.sharpness   = Number(changes.sharpness.newValue);
      if ('hdr'         in changes) config.hdr         = Boolean(changes.hdr.newValue);
      if ('multiLayer'  in changes) config.multiLayer  = Boolean(changes.multiLayer.newValue);
      if ('deepMode'    in changes) config.deepMode    = Boolean(changes.deepMode.newValue);
      if ('splitScreen' in changes) config.splitScreen = Boolean(changes.splitScreen.newValue);
      scheduleUpdateAll();
    });
  }

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.action === 'UPDATE_CONFIG' && msg.payload) {
        if (msg.payload.mode) msg.payload.mode = normalizeMode(msg.payload.mode);
        Object.assign(config, msg.payload);
        scheduleUpdateAll();
        sendResponse({ status: 'ok' });
      }
      return false;
    });
  }

  function scheduleUpdateAll() {
    if (_updateTimer) return;
    _updateTimer = setTimeout(() => {
      _updateTimer = null;
      scanAllVideos();
      activeInstances.forEach((inst, video) => {
        if (!video || !video.isConnected) {
          inst.destroy();
          activeInstances.delete(video);
        } else {
          inst.applyConfig();
        }
      });
    }, 0);
  }

  function getVideoRect(video) {
    return video.getBoundingClientRect();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  VideoUpscalerInstance
  // ══════════════════════════════════════════════════════════════════════════
  class VideoUpscalerInstance {
    constructor(video) {
      this.video             = video;
      this.canvas            = null;
      this.renderer          = null;
      this.rafId             = null;
      this.vfcId             = null;
      this.watchdogTimer     = null;
      this.running           = false;
      this.corsRecoveryTried = false;
      this.permanentlyFailed = false;
      this.compositorMode    = Boolean(video.mediaKeys);
      this.splitPos          = 0.5;
      this._splitRafId       = null;
      this.resizeTimer       = null;
      this.rObs              = null;
      this._initRetry        = null;
      this.nativeBridge      = null;

      this._onMouseMove = (e) => {
        if (this.compositorMode || this.permanentlyFailed) return;
        if (!isProcessingActive() || !config.splitScreen || !this.renderer || !this.video) return;
        const rect = (this.canvas && this.canvas.style.display !== 'none')
          ? this.canvas.getBoundingClientRect()
          : getVideoRect(this.video);
        if (rect.width < 20 || rect.height < 20) return;
        if (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top  && e.clientY <= rect.bottom
        ) {
          this.splitPos = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
          this.renderer.setSplit(this.splitPos);
          if (this.video.paused && !this._splitRafId) {
            this._splitRafId = requestAnimationFrame(() => {
              this._splitRafId = null;
              if (this.video && this.video.paused) {
                this._renderStaticFrame(false);
              }
            });
          }
        }
      };

      this._onEncrypted  = () => this._activateCompositorFallback();
      this._onPlay       = () => this._onVideoPlay();
      this._onPlaying    = () => this._onVideoPlay();
      this._onPause      = () => { this.stopLoop(); this._renderStaticFrame(false); };
      this._onEnded      = () => this.stopLoop();
      this._onSeeked     = () => this._renderStaticFrame(true);
      this._onLoaded     = () => { this.syncSize(); this._onVideoPlay(); };
      this._onResize     = () => this._scheduleSync();
      this._onFullscreen = () => {
        this._scheduleSync();
        setTimeout(() => this._scheduleSync(), 180);
      };

      video.addEventListener('encrypted',      this._onEncrypted);
      video.addEventListener('play',           this._onPlay);
      video.addEventListener('playing',        this._onPlaying);
      video.addEventListener('pause',          this._onPause);
      video.addEventListener('ended',          this._onEnded);
      video.addEventListener('seeked',         this._onSeeked);
      video.addEventListener('loadeddata',     this._onLoaded);
      video.addEventListener('loadedmetadata', this._onLoaded);
      video.addEventListener('canplay',        this._onLoaded);
      video.addEventListener('resize',         this._onResize);
      window.addEventListener('resize',        this._onResize);
      window.addEventListener('mousemove',     this._onMouseMove, { passive: true });
      document.addEventListener('fullscreenchange', this._onFullscreen);

      if (window.ResizeObserver) {
        this.rObs = new ResizeObserver(() => this._scheduleSync());
        this.rObs.observe(video);
        if (video.parentElement) {
          this.rObs.observe(video.parentElement);
        }
      }

      this._tryInit();
    }

    _tryInit() {
      if (this.compositorMode) {
        this.applyConfig();
        return;
      }
      if (this.permanentlyFailed) return;
      if (this.renderer && this.canvas && this.canvas.isConnected) return;

      if (!window.NovaScaleRenderer) {
        if (!this._initRetry) {
          this._initRetry = setTimeout(() => {
            this._initRetry = null;
            this._tryInit();
          }, 80);
        }
        return;
      }

      const rect = getVideoRect(this.video);
      const w    = this.video.videoWidth  || rect.width;
      const h    = this.video.videoHeight || rect.height;

      if (w < 48 || h < 48) return;

      if (!this.canvas || !this.canvas.isConnected) {
        this._createCanvas();
        if (!this.canvas) return;
      }

      if (!this.renderer) {
        try {
          this.renderer = new window.NovaScaleRenderer(this.canvas);
          if (!this.renderer.gl) {
            this.renderer = null;
            return;
          }
        } catch (e) {
          this.renderer = null;
          return;
        }
      }

      this.applyConfig();
    }

    _createCanvas() {
      const parent = this.video.parentNode;
      if (!parent) return;

      if (this.canvas) {
        try { this.canvas.remove(); } catch (_) {}
      }
      // Remove any orphaned overlay canvas from a previous extension reload
      try {
        const nextEl = this.video.nextElementSibling;
        if (nextEl && nextEl.classList && nextEl.classList.contains('novascale-canvas-overlay')) {
          nextEl.remove();
        }
      } catch (_) {}

      const canvas = document.createElement('canvas');
      canvas.className = 'novascale-canvas-overlay';

      if (parent.nodeType === 1) {
        const ps = window.getComputedStyle(parent);
        if (ps.position === 'static') {
          parent.style.position = 'relative';
        }
      }

      // Sync z-index with underlying <video>; inserting AFTER <video> ('afterend')
      // with matching z-index covers video cleanly below player UI controls.
      const vs = window.getComputedStyle(this.video);
      const videoZ = (vs.zIndex && vs.zIndex !== 'auto') ? vs.zIndex : 'auto';

      Object.assign(canvas.style, {
        position:      'absolute',
        top:           '0px',
        left:          '0px',
        width:         '0px',
        height:        '0px',
        pointerEvents: 'none',
        zIndex:        videoZ,
        display:       'none'
      });

      this.video.insertAdjacentElement('afterend', canvas);
      this.canvas = canvas;
      this.syncSize();
    }

    syncSize() {
      if (!this.canvas || !this.video || !this.video.isConnected) return;

      // If the player moved <video> across containers (e.g. custom fullscreen),
      // immediately relocate <canvas> right after <video>.
      if (this.canvas.previousElementSibling !== this.video) {
        try {
          this.video.insertAdjacentElement('afterend', this.canvas);
        } catch (_) {}
      }

      const videoRect = getVideoRect(this.video);
      if (videoRect.width < 10 || videoRect.height < 10) return;

      const parent = this.video.offsetParent || this.canvas.offsetParent || this.canvas.parentElement;
      if (!parent) return;
      const parentRect = parent.getBoundingClientRect();

      const relL = videoRect.left - parentRect.left;
      const relT = videoRect.top  - parentRect.top;
      const boxW = videoRect.width;
      const boxH = videoRect.height;

      const vW = this.video.videoWidth  || boxW;
      const vH = this.video.videoHeight || boxH;
      const videoAR = vW / Math.max(1, vH);
      const boxAR   = boxW / Math.max(1, boxH);

      let renderW = boxW, renderH = boxH, offX = 0, offY = 0;

      const vs  = window.getComputedStyle(this.video);
      const fit = vs.objectFit || 'contain';

      if (fit === 'contain' || fit === 'scale-down') {
        if (boxAR > videoAR) {
          renderW = boxH * videoAR;
          offX    = (boxW - renderW) * 0.5;
        } else {
          renderH = boxW / videoAR;
          offY    = (boxH - renderH) * 0.5;
        }
      } else if (fit === 'cover') {
        if (boxAR > videoAR) {
          renderH = boxW / videoAR;
          offY    = (boxH - renderH) * 0.5;
        } else {
          renderW = boxH * videoAR;
          offX    = (boxW - renderW) * 0.5;
        }
      }

      const videoZ = (vs.zIndex && vs.zIndex !== 'auto') ? vs.zIndex : 'auto';
      this.canvas.style.zIndex = videoZ;
      this.canvas.style.left   = `${Math.round(relL + offX)}px`;
      this.canvas.style.top    = `${Math.round(relT + offY)}px`;
      this.canvas.style.width  = `${Math.round(renderW)}px`;
      this.canvas.style.height = `${Math.round(renderH)}px`;

      // 1.5x Supersampling Target Grid (never downscale below 1.35x native video resolution,
      // capped cleanly at 2560x1440 preserving exact aspect ratio).
      const dpr      = Math.min(window.devicePixelRatio || 1, 2.0);
      const aspect   = renderW / Math.max(1, renderH);
      const ssFactor = config.deepMode ? 2.0 : 1.5;
      const vidScale = config.deepMode ? 1.75 : 1.35;
      const dispW    = Math.round(renderW * dpr * ssFactor);
      const minUpW   = Math.round(vW * vidScale);
      let targW      = Math.max(dispW, minUpW);
      let targH      = Math.round(targW / aspect);
      if (targW > 2560) { targW = 2560; targH = Math.round(2560 / aspect); }
      if (targH > 1440) { targH = 1440; targW = Math.round(1440 * aspect); }
      targW = Math.max(1, targW);
      targH = Math.max(1, targH);

      if (
        Math.abs(this.canvas.width - targW) > 2 ||
        Math.abs(this.canvas.height - targH) > 2
      ) {
        this.canvas.width  = targW;
        this.canvas.height = targH;
        if (isProcessingActive() && this.video.readyState >= 2) {
          this._renderStaticFrame(false);
        }
      }
    }

    _scheduleSync() {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        this.syncSize();
      }, 48);
    }

    _hideNativeVideoSafely() {
      // CRITICAL: 0.0001 preserves Blink's PaintLayer & VideoFrameSubmitter (preventing
      // YouTube from pausing rVFC), disables Windows 11 Hardware Overlay (MPO),
      // and quantizes cleanly to 0 in 8-bit alpha blending.
      this.video.style.setProperty('opacity', '0.0001', 'important');
      if (this.canvas) {
        this.canvas.style.display = 'block';
      }
    }

    _showNativeVideo() {
      if (this.video) {
        this.video.style.removeProperty('opacity');
      }
      if (this.canvas) {
        this.canvas.style.display = 'none';
      }
    }

    _activateCompositorFallback() {
      this.compositorMode = true;
      this.stopLoop();
      this._showNativeVideo();
      this.applyConfig();
    }

    applyConfig() {
      if (this.video && this.video.mediaKeys && !this.compositorMode) {
        this.compositorMode = true;
      }

      // Engine B Path: DRM-Safe Compositor (Netflix, Disney+, Max, Prime Video, Apple TV+, etc.)
      if (this.compositorMode || this.permanentlyFailed) {
        this.stopLoop();
        this._showNativeVideo();
        if (this.video) {
          if (isProcessingActive()) {
            syncDrmCompositorPipeline();
            this.video.style.setProperty('filter', 'url(#novascale-drm-filter)', 'important');
          } else {
            this.video.style.removeProperty('filter');
          }
        }
        return;
      }

      if (this.video) {
        this.video.style.removeProperty('filter');
      }

      if (!this.renderer) {
        this._tryInit();
        if (!this.renderer) {
          if (!isProcessingActive()) this._showNativeVideo();
          return;
        }
      }

      const { mode, sharpness, hdr, multiLayer, deepMode, splitScreen } = config;

      if (deepMode && window.NovaScaleNativeBridge) {
        if (!this.nativeBridge) {
          this.nativeBridge = new window.NovaScaleNativeBridge();
        }
        this.nativeBridge.ensureConnected().then((ok) => {
          if (ok && this.nativeBridge) this.nativeBridge.sendConfig(mode, sharpness);
        });
      } else if (this.nativeBridge) {
        this.nativeBridge.disconnect();
      }

      if (isProcessingActive()) {
        this.renderer.setMode(mode);
        this.renderer.setSharpness(sharpness);
        this.renderer.setHdr(hdr);
        this.renderer.setMultiLayer(multiLayer);
        if (typeof this.renderer.setDeepMode === 'function') {
          this.renderer.setDeepMode(deepMode);
        }
        const isAnimeMode = !String(mode || 'anime-dbl').startsWith('cinema');
        this.renderer.setTemporalDenoise((multiLayer || deepMode) ? (isAnimeMode ? 0.32 : 0.20) : 0.0);
        this.renderer.setSplit(splitScreen ? (this.splitPos || 0.5) : -1.0);

        this.syncSize();

        if (this.video.readyState >= 2) {
          const wasHidden = !this.canvas || this.canvas.style.display === 'none';
          const ok = this.renderer.render(this.video, wasHidden);
          if (!ok) {
            this._attemptCorsRecovery();
            return;
          }
          this._hideNativeVideoSafely();
        }

        if (!this.video.paused && !this.video.ended) {
          this.startLoop();
        }
      } else {
        this.stopLoop();
        this._showNativeVideo();
      }
    }

    /**
     * If a media host began loading before crossOrigin="anonymous" was attached,
     * perform a one-shot hot recovery reload with CORS enabled.
     * If it is a DRM or unrecoverable stream, automatically switch to Engine B (Compositor).
     */
    _attemptCorsRecovery() {
      this.stopLoop();
      this._showNativeVideo();

      const src = this.video.currentSrc || this.video.getAttribute('src') || '';
      if (
        this.corsRecoveryTried ||
        this.video.mediaKeys ||
        !src ||
        src.startsWith('blob:') ||
        src.startsWith('data:') ||
        this.video.srcObject
      ) {
        console.info('[NovaScale] Switching to Engine B (DRM-Safe Compositor).');
        this._activateCompositorFallback();
        return;
      }

      this.corsRecoveryTried = true;
      console.info('[NovaScale] Running hot CORS recovery for:', src.substring(0, 60));

      try {
        const savedTime  = this.video.currentTime || 0;
        const wasPlaying = !this.video.paused;

        this.video.crossOrigin = 'anonymous';
        this.video.setAttribute('crossorigin', 'anonymous');
        this.video.load();

        this.video.addEventListener(
          'loadeddata',
          () => {
            try {
              if (savedTime > 0) this.video.currentTime = savedTime;
              if (wasPlaying) this.video.play().catch(() => {});
            } catch (_) {}
            this.applyConfig();
          },
          { once: true }
        );
      } catch (_) {
        this._activateCompositorFallback();
      }
    }

    _onVideoPlay() {
      if (this.compositorMode || this.permanentlyFailed) {
        this.applyConfig();
        return;
      }
      this._tryInit();
      if (isProcessingActive() && this.renderer && !this.compositorMode) {
        this.syncSize();
        this.startLoop();
      }
    }

    startLoop() {
      if (this.running || this.compositorMode || this.permanentlyFailed) return;
      if (!this.renderer || !this.video || !this.canvas) return;
      if (this.video.paused || this.video.ended) return;

      if (this.canvas.width <= 1) {
        this.syncSize();
      }

      this.running = true;

      const renderTick = (forceUpload) => {
        if (!this.running) return;
        if (!this.video || !this.video.isConnected || this.video.paused || this.video.ended) {
          this.stopLoop();
          return;
        }
        if (!isProcessingActive()) {
          this.stopLoop();
          this._showNativeVideo();
          return;
        }

        if (!document.hidden && this.video.readyState >= 2 && this.canvas.width > 0) {
          let sourceForRender = this.video;
          let usingSidecar = false;
          if (config.deepMode && this.nativeBridge && this.nativeBridge.connected) {
            const sidecarFrame = this.nativeBridge.submitVideoFrame(this.video);
            if (sidecarFrame) {
              sourceForRender = sidecarFrame;
              usingSidecar = true;
            }
          }
          this.renderer.setSharpness(usingSidecar ? (config.sharpness * 0.25) : config.sharpness);
          const ok = this.renderer.render(sourceForRender, forceUpload);
          if (!ok) {
            this._attemptCorsRecovery();
            return;
          }
          if (this.canvas.style.display === 'none') {
            this._hideNativeVideoSafely();
          }
        }

        this._scheduleNextFrame(renderTick);
      };

      this._scheduleNextFrame(renderTick);
    }

    _scheduleNextFrame(tickFn) {
      if (!this.running || !this.video) return;

      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
      if (this.rafId !== null) {
        try { cancelAnimationFrame(this.rafId); } catch (_) {}
        this.rafId = null;
      }
      if (this.vfcId !== null && 'cancelVideoFrameCallback' in this.video) {
        try { this.video.cancelVideoFrameCallback(this.vfcId); } catch (_) {}
        this.vfcId = null;
      }

      if ('requestVideoFrameCallback' in this.video) {
        try {
          this.vfcId = this.video.requestVideoFrameCallback(() => {
            this.vfcId = null;
            tickFn(true);
          });
          return;
        } catch (_) {}
      }

      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        tickFn(false);
      });
    }

    stopLoop() {
      this.running = false;
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
      if (this.vfcId !== null && this.video && 'cancelVideoFrameCallback' in this.video) {
        try { this.video.cancelVideoFrameCallback(this.vfcId); } catch (_) {}
        this.vfcId = null;
      }
      if (this.rafId !== null) {
        try { cancelAnimationFrame(this.rafId); } catch (_) {}
        this.rafId = null;
      }
    }

    _renderStaticFrame(forceUpload = false) {
      if (this.compositorMode || this.permanentlyFailed) return;
      if (!this.renderer || !this.canvas || !this.video) return;
      if (!isProcessingActive()) {
        this._showNativeVideo();
        return;
      }
      if (this.video.readyState < 2 || this.canvas.width === 0) return;
      const ok = this.renderer.render(this.video, forceUpload);
      if (!ok) {
        this._attemptCorsRecovery();
      } else {
        this._hideNativeVideoSafely();
      }
    }

    destroy() {
      this.stopLoop();

      if (this._initRetry)  { clearTimeout(this._initRetry);       this._initRetry  = null; }
      if (this._splitRafId) { cancelAnimationFrame(this._splitRafId); this._splitRafId = null; }
      if (this.resizeTimer) { clearTimeout(this.resizeTimer);      this.resizeTimer = null; }
      if (this.rObs)        { this.rObs.disconnect();              this.rObs        = null; }

      window.removeEventListener('resize',             this._onResize);
      window.removeEventListener('mousemove',          this._onMouseMove);
      document.removeEventListener('fullscreenchange', this._onFullscreen);

      if (this.video) {
        this.video.style.removeProperty('opacity');
        this.video.style.removeProperty('filter');
        this.video.removeEventListener('encrypted',      this._onEncrypted);
        this.video.removeEventListener('play',           this._onPlay);
        this.video.removeEventListener('playing',        this._onPlaying);
        this.video.removeEventListener('pause',          this._onPause);
        this.video.removeEventListener('ended',          this._onEnded);
        this.video.removeEventListener('seeked',         this._onSeeked);
        this.video.removeEventListener('loadeddata',     this._onLoaded);
        this.video.removeEventListener('loadedmetadata', this._onLoaded);
        this.video.removeEventListener('canplay',        this._onLoaded);
        this.video.removeEventListener('resize',         this._onResize);
        this.video = null;
      }

      if (this.canvas) {
        try { this.canvas.remove(); } catch (_) {}
        this.canvas.width  = 0;
        this.canvas.height = 0;
        this.canvas = null;
      }

      if (this.nativeBridge) {
        try { this.nativeBridge.disconnect(); } catch (_) {}
        this.nativeBridge = null;
      }

      if (this.renderer) {
        this.renderer.destroy();
        this.renderer = null;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Universal Media Discovery (Light DOM + Shadow DOM + Capture Interception)
  // ══════════════════════════════════════════════════════════════════════════

  function attachVideo(video) {
    if (!video || video.tagName !== 'VIDEO') return;
    if (!video.isConnected) return;

    if (activeInstances.has(video)) {
      const existing = activeInstances.get(video);
      if (existing && !existing.renderer) {
        existing._tryInit();
      }
      return;
    }

    const rect = getVideoRect(video);
    const w    = video.videoWidth  || rect.width;
    const h    = video.videoHeight || rect.height;
    if (w > 0 && w < 48 && h > 0 && h < 48) return;

    const inst = new VideoUpscalerInstance(video);
    activeInstances.set(video, inst);
  }

  function scanAllVideos(root = document) {
    if (!root || !root.querySelectorAll) return;

    const videos = root.querySelectorAll('video');
    for (let i = 0; i < videos.length; i++) {
      attachVideo(videos[i]);
    }

    // Deep Shadow DOM traversal (opened proactively via injector.js)
    const allElements = root.querySelectorAll('*');
    for (let i = 0; i < allElements.length; i++) {
      const sr = allElements[i].shadowRoot;
      if (sr) {
        scanAllVideos(sr);
      }
    }
  }

  // Instant capture-phase interception for dynamically injected <video> nodes
  // inside iframes or ShadowRoots.
  const MEDIA_CAPTURE_EVENTS = ['play', 'playing', 'loadedmetadata', 'loadeddata'];
  MEDIA_CAPTURE_EVENTS.forEach((evtName) => {
    document.addEventListener(
      evtName,
      (e) => {
        const target = e.composedPath ? e.composedPath()[0] : e.target;
        if (target && target.tagName === 'VIDEO') {
          attachVideo(target);
        }
      },
      true
    );
  });

  // Initial scan and MutationObserver with automatic cleanup for detached videos
  scanAllVideos();

  let _domTimer = null;
  const domObserver = new MutationObserver(() => {
    if (_domTimer) return;
    _domTimer = setTimeout(() => {
      _domTimer = null;
      scanAllVideos();
      activeInstances.forEach((inst, video) => {
        if (!video.isConnected) {
          inst.destroy();
          activeInstances.delete(video);
        }
      });
    }, 180);
  });

  if (document.documentElement) {
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.__novascale_cleanup = () => {
    try { domObserver.disconnect(); } catch (_) {}
    activeInstances.forEach((inst) => {
      try { inst.destroy(); } catch (_) {}
    });
    activeInstances.clear();
  };
})();
