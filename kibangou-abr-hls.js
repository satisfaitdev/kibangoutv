/**
 * KibangouTV - Adaptive Bitrate (ABR) Engine & Network Monitor (100% Automatique)
 */

import OriginalHls from "https://vuma.mx/v/1.5.111/hls.mjs?orig=1";

export * from "https://vuma.mx/v/1.5.111/hls.mjs?orig=1";

const LEGACY_PREF_KEY = "kibangoutv_preferred_quality";

function clearLegacyManualQuality() {
  try {
    localStorage.removeItem(LEGACY_PREF_KEY);
  } catch {}
}

function getNavigatorConnection() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

export class KibangouHls extends OriginalHls {
  constructor(userConfig = {}) {
    clearLegacyManualQuality();

    const conn = getNavigatorConnection();
    const initialEstimate = KibangouHls.computeInitialBandwidthEstimate(conn);

    const abrConfig = {
      abrEwmaDefaultEstimate: initialEstimate,
      abrBandWidthFactor: 0.78,
      abrBandWidthUpFactor: 0.65,
      abrMaxWithRealBitrate: true,
      capLevelToPlayerSize: false,

      startLevel: -1,
      autoStartLoad: true,
      startFragPrefetch: true,

      maxBufferLength: 10,
      maxMaxBufferLength: 24,
      maxBufferSize: 24 * 1024 * 1024,
      backBufferLength: 6,
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 1.5,
      nudgeOffset: 0.15,
      nudgeMaxRetry: 5,

      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      initialLiveManifestSize: 1,

      fragLoadingTimeOut: 8000,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 250,
      manifestLoadingTimeOut: 7000,
      manifestLoadingMaxRetry: 2,
      manifestLoadingRetryDelay: 200,
      levelLoadingTimeOut: 7000,
      levelLoadingMaxRetry: 2,
      levelLoadingRetryDelay: 200,

      ...userConfig
    };

    super(abrConfig);

    window.__kibangouHls = this;
    window.Hls = KibangouHls;

    this._measuredKbps = 0;
    this._hasRealSample = false;
    this._cooldownUntil = 0;
    this._consecutiveFastSegments = 0;
    this._consecutiveSlowSegments = 0;
    this._lastResumeAt = 0;
    this._stallTimer = null;
    this._attachedMedia = null;
    this._waitingListener = null;
    this._playingListener = null;
    this._playListener = null;
    this._connChangeListener = null;

    this._bindNetworkMonitor();
    this._bindHlsEvents();

    window.dispatchEvent(new CustomEvent("kibangou-hls-attached", {
      detail: { hls: this }
    }));
  }

  static computeInitialBandwidthEstimate(conn) {
    if (!conn) return 4800000;
    if (conn.saveData || conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") {
      return 220000;
    }
    if (conn.effectiveType === "3g") {
      return 650000;
    }
    return 4800000;
  }

  loadSource(url) {
    let target = url;
    const hasCustomLoader = Boolean(
      this.config &&
      this.config.loader &&
      this.config.loader !== OriginalHls.DefaultConfig.loader
    );

    if (
      !hasCustomLoader &&
      typeof target === "string" &&
      target &&
      !target.startsWith("blob:") &&
      !target.startsWith("data:")
    ) {
      const streamPrefix = `${location.origin}/api/stream`;
      if (!target.startsWith(streamPrefix) && !target.startsWith("/api/stream")) {
        const snap = this.getNetworkSnapshot();
        const abrParam = (snap.tier === "2G" || snap.tier === "3G") ? "&abr=1" : "";
        target = `${streamPrefix}?u=${encodeURIComponent(target)}${abrParam}`;
      }
    }
    this._rawSourceUrl = url;
    return super.loadSource(target);
  }

  attachMedia(media) {
    super.attachMedia(media);
    this._detachMediaWatchdog();

    if (!media) return;
    this._attachedMedia = media;

    this._waitingListener = () => {
      if (this._stallTimer) return;
      if (Date.now() - this._lastResumeAt < 4000) return;
      this._stallTimer = setTimeout(() => {
        this._stallTimer = null;
        if (Date.now() - this._lastResumeAt < 4000) return;
        if (!media.paused && !media.ended && media.readyState < 3) {
          this._handleBandwidthDrop("buffering_wait");
        }
      }, 3500);
    };

    this._playListener = () => {
      this._lastResumeAt = Date.now();
      try {
        const liveSync = typeof this.liveSyncPosition === "number" && isFinite(this.liveSyncPosition)
          ? this.liveSyncPosition
          : null;
        if (liveSync !== null && liveSync - media.currentTime > 6) {
          media.currentTime = Math.max(0, liveSync - 1);
          this.startLoad(-1);
        } else if (media.readyState < 3) {
          this.startLoad();
        }
      } catch {}
    };

    this._playingListener = () => {
      this._lastResumeAt = Date.now();
      if (this._stallTimer) {
        clearTimeout(this._stallTimer);
        this._stallTimer = null;
      }
    };

    this._seekingListener = () => {
      this._lastResumeAt = Date.now();
      if (this._stallTimer) {
        clearTimeout(this._stallTimer);
        this._stallTimer = null;
      }
    };

    media.addEventListener("waiting", this._waitingListener);
    media.addEventListener("play", this._playListener);
    media.addEventListener("playing", this._playingListener);
    media.addEventListener("seeking", this._seekingListener);
    media.addEventListener("seeked", this._seekingListener);
  }

  destroy() {
    this._detachMediaWatchdog();
    const conn = getNavigatorConnection();
    if (conn && this._connChangeListener) {
      conn.removeEventListener("change", this._connChangeListener);
      this._connChangeListener = null;
    }
    super.destroy();
  }

  _detachMediaWatchdog() {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
    if (this._attachedMedia) {
      if (this._waitingListener) this._attachedMedia.removeEventListener("waiting", this._waitingListener);
      if (this._playListener) this._attachedMedia.removeEventListener("play", this._playListener);
      if (this._playingListener) this._attachedMedia.removeEventListener("playing", this._playingListener);
      if (this._seekingListener) {
        this._attachedMedia.removeEventListener("seeking", this._seekingListener);
        this._attachedMedia.removeEventListener("seeked", this._seekingListener);
      }
      this._attachedMedia = null;
    }
  }

  _inferHeight(lvl) {
    if (lvl && lvl.height > 0) return lvl.height;
    const br = (lvl && lvl.bitrate) || 0;
    if (br <= 160000) return 240;
    if (br <= 360000) return 360;
    if (br <= 750000) return 480;
    if (br <= 1800000) return 720;
    return 1080;
  }

  _getSortedLevelIndices() {
    if (!this.levels || !this.levels.length) return [];
    return this.levels
      .map((lvl, idx) => ({ idx, height: this._inferHeight(lvl), bitrate: lvl.bitrate || 0 }))
      .sort((a, b) => a.height - b.height || a.bitrate - b.bitrate);
  }

  _pickLevelForTargetHeight(targetHeight, maxOnly = false) {
    const sorted = this._getSortedLevelIndices();
    if (!sorted.length) return -1;

    if (maxOnly) {
      let chosen = sorted[0].idx;
      for (const entry of sorted) {
        if (entry.height > 0 && entry.height <= targetHeight) {
          chosen = entry.idx;
        }
      }
      return chosen;
    }

    let bestIdx = sorted[0].idx;
    let minDiff = Infinity;
    for (const entry of sorted) {
      const diff = Math.abs(entry.height - targetHeight);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = entry.idx;
      }
    }
    return bestIdx;
  }

  _applyNetworkPolicy(reason = "network_change") {
    if (!this.levels || !this.levels.length) return;

    const snap = this.getNetworkSnapshot();
    let startH = 1080;
    let capH = 1080;

    if (snap.tier === "2G") {
      startH = 240;
      capH = 360;
    } else if (snap.tier === "3G") {
      startH = 360;
      capH = 480;
    } else if (snap.tier === "3G+") {
      startH = 480;
      capH = 720;
    }

    if (capH >= 1080) {
      this.autoLevelCapping = -1;
      if (reason === "manifest_init") {
        const origIdx = this._pickLevelForTargetHeight(1080, true);
        if (origIdx >= 0) {
          this.startLevel = origIdx;
          this.loadLevel = origIdx;
        }
      }
      this._emitNetworkStats(snap);
      return;
    }

    const capIdx = this._pickLevelForTargetHeight(capH, true);
    this.autoLevelCapping = capIdx >= 0 ? capIdx : -1;

    const currentLvlObj = this.levels[this.currentLevel];
    const currentH = currentLvlObj ? this._inferHeight(currentLvlObj) : 0;

    if (this.currentLevel < 0 || (currentH > capH && capIdx >= 0)) {
      const startIdx = this._pickLevelForTargetHeight(startH, true);
      if (startIdx >= 0) {
        if (reason === "manifest_init") {
          this.startLevel = startIdx;
        }
        this.nextLevel = startIdx;
        this.loadLevel = startIdx;
        if (reason !== "manifest_init" && currentH > capH) {
          this._emitAutoDowngrade(this._inferHeight(this.levels[startIdx]) || startH, snap, reason);
        }
      }
    }

    this._emitNetworkStats(snap);
  }

  _handleBandwidthDrop(reason) {
    if (!this.levels || !this.levels.length) return;

    const sorted = this._getSortedLevelIndices();
    if (sorted.length <= 1) {
      // Si le flux est en passthrough (1 seul niveau) et que la connexion chute vraiment en 2G/3G, activer &abr=1
      if (
        !this._abrFallbackTriggered &&
        this._hasRealSample &&
        this._measuredKbps > 0 &&
        this._measuredKbps < 550 &&
        typeof this._rawSourceUrl === "string" &&
        this._rawSourceUrl &&
        !this._rawSourceUrl.includes("abr=1")
      ) {
        this._abrFallbackTriggered = true;
        const streamPrefix = `${location.origin}/api/stream`;
        const nextUrl = this._rawSourceUrl.startsWith("/api/stream") || this._rawSourceUrl.startsWith(streamPrefix)
          ? `${this._rawSourceUrl}${this._rawSourceUrl.includes("?") ? "&" : "?"}abr=1`
          : `${streamPrefix}?u=${encodeURIComponent(this._rawSourceUrl)}&abr=1`;
        this._emitAutoDowngrade(360, this.getNetworkSnapshot(), reason);
        super.loadSource(nextUrl);
      }
      return;
    }

    const curIdx = this.currentLevel >= 0 ? this.currentLevel : this.loadLevel;
    const pos = sorted.findIndex((e) => e.idx === curIdx);
    const nextPos = pos > 0 ? pos - 1 : 0;
    const targetEntry = sorted[nextPos];

    if (!targetEntry || targetEntry.idx === curIdx) return;

    this._consecutiveFastSegments = 0;
    this._cooldownUntil = Date.now() + 35000;
    this.autoLevelCapping = targetEntry.idx;
    this.nextLevel = targetEntry.idx;
    this.loadLevel = targetEntry.idx;

    const snap = this.getNetworkSnapshot();
    this._emitAutoDowngrade(targetEntry.height, snap, reason);
    this._emitNetworkStats(snap);
  }

  _emitAutoDowngrade(newHeight, snap, reason) {
    window.dispatchEvent(new CustomEvent("kibangou-auto-downgrade", {
      detail: { height: newHeight, snapshot: snap, reason }
    }));
  }

  _emitNetworkStats(snap) {
    const activeLvl = this.levels && this.levels[this.currentLevel >= 0 ? this.currentLevel : this.loadLevel];
    window.dispatchEvent(new CustomEvent("kibangou-network-stats", {
      detail: {
        ...snap,
        activeHeight: activeLvl ? this._inferHeight(activeLvl) : null,
        activeBitrateKbps: activeLvl && activeLvl.bitrate ? Math.round(activeLvl.bitrate / 1000) : null
      }
    }));
  }

  getNetworkSnapshot() {
    const conn = getNavigatorConnection();
    const eff = conn && conn.effectiveType ? conn.effectiveType : "";
    const dlMbps = conn && typeof conn.downlink === "number" && conn.downlink > 0 ? conn.downlink : null;
    const saveData = Boolean(conn && conn.saveData);

    const effectiveKbps = this._hasRealSample && this._measuredKbps > 0
      ? this._measuredKbps
      : (dlMbps ? Math.round(dlMbps * 1000) : 4800);

    let tier = "4G";
    if (saveData || eff === "slow-2g" || eff === "2g" || (this._hasRealSample && effectiveKbps < 240)) {
      tier = "2G";
    } else if (eff === "3g" || (this._hasRealSample && effectiveKbps < 550)) {
      tier = "3G";
    } else if (this._hasRealSample && effectiveKbps < 1100) {
      tier = "3G+";
    }

    return {
      tier,
      effectiveType: eff || tier,
      measuredKbps: effectiveKbps,
      saveData
    };
  }

  _bindNetworkMonitor() {
    const conn = getNavigatorConnection();
    if (!conn) return;

    this._connChangeListener = () => {
      this._applyNetworkPolicy("network_change");
    };
    conn.addEventListener("change", this._connChangeListener);
  }

  _bindHlsEvents() {
    this.on(OriginalHls.Events.MANIFEST_PARSED, () => {
      window.dispatchEvent(new CustomEvent("kibangou-levels-updated", {
        detail: { levels: this.levels, hls: this }
      }));
      this._applyNetworkPolicy("manifest_init");
    });

    this.on(OriginalHls.Events.LEVEL_LOADED, (_event, data) => {
      if (data?.details && data.details.live === false) {
        this.config.maxBufferLength = 90;
        this.config.maxMaxBufferLength = 150;
        this.config.maxBufferSize = 80 * 1024 * 1024;
      }
    });

    this.on(OriginalHls.Events.FRAG_LOADED, (_event, data) => {
      const stats = data?.frag?.stats;
      const durSec = data?.frag?.duration || 6;
      if (!stats || !stats.loaded || !stats.loading) return;

      const loadMs = Math.max(1, (stats.loading.end || performance.now()) - (stats.loading.start || 0));
      const instantKbps = Math.round((stats.loaded * 8) / loadMs);
      this._measuredKbps = this._hasRealSample && this._measuredKbps > 0
        ? Math.round(this._measuredKbps * 0.6 + instantKbps * 0.4)
        : instantKbps;
      this._hasRealSample = true;

      const snap = this.getNetworkSnapshot();
      const loadRatio = loadMs / (durSec * 1000);
      const curLvl = this.levels && this.levels[this.currentLevel];
      const curLvlKbps = curLvl && curLvl.bitrate ? Math.round(curLvl.bitrate / 1000) : 800;

      if (loadRatio > 0.92 || this._measuredKbps < curLvlKbps * 0.45) {
        this._consecutiveSlowSegments++;
        this._consecutiveFastSegments = 0;
        if (this._consecutiveSlowSegments >= 2) {
          this._consecutiveSlowSegments = 0;
          this._cooldownUntil = Date.now() + 12000;
          this._handleBandwidthDrop("slow_download");
          return;
        }
      } else {
        this._consecutiveSlowSegments = 0;
      }

      if (Date.now() > this._cooldownUntil) {
        if (loadRatio < 0.65 && this._measuredKbps > curLvlKbps * 1.15) {
          this._consecutiveFastSegments++;
          if (this._consecutiveFastSegments >= 2) {
            this._consecutiveFastSegments = 0;
            const sorted = this._getSortedLevelIndices();
            const curPos = sorted.findIndex((e) => e.idx === (this.currentLevel >= 0 ? this.currentLevel : this.loadLevel));
            if (curPos >= 0 && curPos + 1 < sorted.length) {
              const nextEntry = sorted[curPos + 1];
              const capPos = sorted.findIndex((e) => e.idx === this.autoLevelCapping);
              if (this.autoLevelCapping >= 0 && capPos < curPos + 1) {
                this.autoLevelCapping = (curPos + 1 === sorted.length - 1) ? -1 : nextEntry.idx;
              }
              this.nextLevel = nextEntry.idx;
            } else if (this.autoLevelCapping >= 0) {
              this.autoLevelCapping = -1;
              this.nextLevel = -1;
            }
          }
        } else {
          this._consecutiveFastSegments = 0;
        }
      }

      this._emitNetworkStats(snap);
    });

    this.on(OriginalHls.Events.LEVEL_SWITCHED, (_event, data) => {
      window.dispatchEvent(new CustomEvent("kibangou-quality-switched", {
        detail: { level: data.level, hls: this }
      }));
      this._emitNetworkStats(this.getNetworkSnapshot());
    });

    this.on(OriginalHls.Events.ERROR, (_event, data) => {
      if (!data) return;

      if (data.fatal) {
        if (data.type === OriginalHls.ErrorTypes.NETWORK_ERROR) {
          this._handleBandwidthDrop("network_error");
          this.startLoad();
        } else if (data.type === OriginalHls.ErrorTypes.MEDIA_ERROR) {
          this.recoverMediaError();
        }
      } else if (
        data.details === OriginalHls.ErrorDetails.BUFFER_STALLED_ERROR ||
        data.details === OriginalHls.ErrorDetails.FRAG_LOAD_TIMEOUT
      ) {
        this._handleBandwidthDrop(data.details);
      }
    });
  }

  setQualityLevel() {
    clearLegacyManualQuality();
    this._cooldownUntil = 0;
    this.autoLevelCapping = -1;
    this.currentLevel = -1;
    this.loadLevel = -1;
    this.nextLevel = -1;
    this._applyNetworkPolicy("auto_reset");
    return -1;
  }
}

export default KibangouHls;
export { KibangouHls as Hls };
