/**
 * NovaScale - Sprint 3 Native Sidecar Bridge (TensorRT / DirectML Out-of-Process Client)
 *
 * Connects to ws://127.0.0.1:19480/novascale-stream when Deep AI Mode is enabled.
 * Uses strict single-frame inFlight backpressure and automatic fallback to WebGL2 if offline.
 */

class NovaScaleNativeBridge {
  constructor() {
    this.connected   = false;
    this.connecting  = false;
    this.socket      = null;
    this.endpoint    = 'ws://127.0.0.1:19480/novascale-stream';
    this.inFlight    = false;
    this.lastProbeAt = 0;

    this._srcCanvas  = null;
    this._srcCtx     = null;
    this._outCanvas  = null;
    this._outCtx     = null;
    this._hasOutFrame = false;
  }

  async ensureConnected() {
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return true;
    }
    if (this.connecting) return false;

    const now = Date.now();
    if (now - this.lastProbeAt < 3000) return false;
    this.lastProbeAt = now;
    this.connecting = true;

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        this.connecting = false;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try { if (this.socket) this.socket.close(); } catch (_) {}
        done(false);
      }, 450);

      try {
        const ws = new WebSocket(this.endpoint);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          clearTimeout(timer);
          this.socket = ws;
          this.connected = true;
          this.inFlight = false;
          try { ws.send(JSON.stringify({ type: 'hello', version: '3.4.0' })); } catch (_) {}
          console.info('[NovaScale] Deep AI Mode connected to RTX Sidecar.');
          done(true);
        };
        ws.onmessage = (evt) => {
          if (evt.data instanceof ArrayBuffer) {
            this._handleBinaryFrame(evt.data);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          this.connected = false;
          this.inFlight = false;
          done(false);
        };
        ws.onclose = () => {
          clearTimeout(timer);
          this.connected = false;
          this.inFlight = false;
          this.socket = null;
          done(false);
        };
      } catch (_) {
        clearTimeout(timer);
        done(false);
      }
    });
  }

  sendConfig(mode, sharpness) {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({
        type: 'config',
        mode: String(mode || 'anime-dbl'),
        sharpness: Number(sharpness) || 0.75
      }));
    } catch (_) {}
  }

  _handleBinaryFrame(buf) {
    this.inFlight = false;
    if (!buf || buf.byteLength < 8) return;
    const view = new DataView(buf);
    const outW = view.getUint32(0, true);
    const outH = view.getUint32(4, true);
    const expected = 8 + outW * outH * 4;
    if (!outW || !outH || buf.byteLength < expected) return;

    if (!this._outCanvas) {
      this._outCanvas = document.createElement('canvas');
      this._outCtx = this._outCanvas.getContext('2d');
    }
    if (this._outCanvas.width !== outW || this._outCanvas.height !== outH) {
      this._outCanvas.width = outW;
      this._outCanvas.height = outH;
    }
    const rgba = new Uint8ClampedArray(buf, 8, outW * outH * 4);
    const imgData = new ImageData(rgba, outW, outH);
    this._outCtx.putImageData(imgData, 0, 0);
    this._hasOutFrame = true;
  }

  submitVideoFrame(video) {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return null;
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) return null;

    if (this.inFlight && this._inFlightSentAt && (performance.now() - this._inFlightSentAt) > 600) {
      this.inFlight = false;
    }
    if (!this.inFlight) {
      if (!this._srcCanvas) {
        this._srcCanvas = document.createElement('canvas');
        this._srcCtx = this._srcCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (this._srcCanvas.width !== srcW || this._srcCanvas.height !== srcH) {
        this._srcCanvas.width = srcW;
        this._srcCanvas.height = srcH;
      }
      try {
        this._srcCtx.drawImage(video, 0, 0, srcW, srcH);
        const img = this._srcCtx.getImageData(0, 0, srcW, srcH);
        const packet = new Uint8Array(8 + img.data.byteLength);
        const dv = new DataView(packet.buffer);
        dv.setUint32(0, srcW, true);
        dv.setUint32(4, srcH, true);
        packet.set(img.data, 8);
        this.inFlight = true;
        this._inFlightSentAt = performance.now();
        this.socket.send(packet.buffer);
      } catch (_) {
        this.inFlight = false;
      }
    }

    if (this._hasOutFrame && this._outCanvas) {
      this._outCanvas.videoWidth  = this._outCanvas.width;
      this._outCanvas.videoHeight = this._outCanvas.height;
      this._outCanvas.readyState  = 4;
      this._outCanvas.currentTime = video.currentTime;
      return this._outCanvas;
    }
    return null;
  }

  disconnect() {
    this.inFlight = false;
    this._hasOutFrame = false;
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
  }
}

window.NovaScaleNativeBridge = NovaScaleNativeBridge;
