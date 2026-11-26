/**
 * KibangouTV - Convertisseur de Qualité Réel & Moniteur Réseau 2G/3G/4G
 * =====================================================================
 * - Route les flux HLS via le transcodeur adaptatif (/api/stream)
 * - Surveille en temps réel la connexion (Network Information API + débit réel des segments)
 * - Rétrograde automatiquement (1080p -> 720p -> 480p -> 360p -> 240p) en cas de chute réseau
 * - Empêche les saccades avec période de stabilisation anti-yoyo
 */

import OriginalHls from "https://vuma.mx/v/1.5.111/hls.mjs?orig=1";

export * from "https://vuma.mx/v/1.5.111/hls.mjs?orig=1";

const DEFAULT_PREF_KEY = "kibangoutv_preferred_quality";

function getNavigatorConnection() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

export class KibangouHls extends OriginalHls {
  constructor(userConfig = {}) {
    const conn = getNavigatorConnection();
    const initialEstimate = KibangouHls.computeInitialBandwidthEstimate(conn);

    const abrConfig = {
      abrEwmaDefaultEstimate: initialEstimate,
      abrBandWidthFactor: 0.75,
      abrBandWidthUpFactor: 0.60,
      abrMaxWithRealBitrate: true,
      capLevelToPlayerSize: false,

      startLevel: -1,
      autoStartLoad: true,

      maxBufferLength: 24,
      maxMaxBufferLength: 45,
      maxBufferSize: 40 * 1024 * 1024,
      backBufferLength: 10,
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 2,
      nudgeOffset: 0.2,
      nudgeMaxRetry: 6,

      fragLoadingTimeOut: 45000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 500,
      manifestLoadingTimeOut: 25000,
      manifestLoadingMaxRetry: 3,
      levelLoadingTimeOut: 25000,
      levelLoadingMaxRetry: 3,

      ...userConfig
    };

    super(abrConfig);

    window.__kibangouHls = this;
    window.Hls = KibangouHls;

    this._measuredKbps = Math.round(initialEstimate / 1000);
    this._cooldownUntil = 0;
    this._consecutiveFastSegments = 0;
    this._stallTimer = null;
    this._attachedMedia = null;
    this._waitingListener = null;
    this._playingListener = null;
    this._connChangeListener = null;

    this._bindNetworkMonitor();
    this._bindHlsEvents();

    window.dispatchEvent(new CustomEvent("kibangou-hls-attached", {
      detail: { hls: this }
    }));
  }

  static computeInitialBandwidthEstimate(conn) {
    if (!conn) return 650000;
    if (conn.saveData || conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") {
      return 140000;
    }
    if (conn.effectiveType === "3g") {
      return 320000;
    }
    const dlMbps = typeof conn.downlink === "number" && conn.downlink > 0 ? conn.downlink : 2.5;
    if (dlMbps <= 0.4) return 150000;
    if (dlMbps <= 1.2) return 350000;
    if (dlMbps <= 3.0) return 650000;
    return 1400000; // Démarrage prudent en 720p pour éviter les gels initiaux en 4K/1080p
  }

  loadSource(url) {
    let target = url;
    if (typeof target === "string" && target && !target.startsWith("blob:") && !target.startsWith("data:")) {
      const streamPrefix = `${location.origin}/api/stream`;
      if (!target.startsWith(streamPrefix) && !target.startsWith("/api/stream")) {
        target = `${streamPrefix}?u=${encodeURIComponent(target)}`;
      }
    }
    return super.loadSource(target);
  }

  attachMedia(media) {
    super.attachMedia(media);
    this._detachMediaWatchdog();

    if (!media) return;
    this._attachedMedia = media;

    this._waitingListener = () => {
      if (this._stallTimer) return;
      this._stallTimer = setTimeout(() => {
        this._stallTimer = null;
        if (!media.paused && !media.ended && media.readyState < 3) {
          this._handleBandwidthDrop("buffering_wait");
        }
      }, 1600);
    };

    this._playingListener = () => {
      if (this._stallTimer) {
        clearTimeout(this._stallTimer);
        this._stallTimer = null;
      }
    };

    media.addEventListener("waiting", this._waitingListener);
    media.addEventListener("playing", this._playingListener);
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
      if (this._playingListener) this._attachedMedia.removeEventListener("playing", this._playingListener);
      this._attachedMedia = null;
    }
  }

  _isAutoMode() {
    const pref = localStorage.getItem(DEFAULT_PREF_KEY) || "auto";
    return pref === "auto";
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
    if (!this.levels || !this.levels.length || !this._isAutoMode()) return;

    const snap = this.getNetworkSnapshot();
    let startH = 720;
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

    const capIdx = this._pickLevelForTargetHeight(capH, true);
    this.autoLevelCapping = capIdx >= 0 ? capIdx : -1;

    const currentLvlObj = this.levels[this.currentLevel];
    const currentH = currentLvlObj ? (currentLvlObj.height || 0) : 0;

    if (this.currentLevel < 0 || (currentH > capH && capIdx >= 0)) {
      const startIdx = this._pickLevelForTargetHeight(startH, true);
      if (startIdx >= 0) {
        this.nextLevel = startIdx;
        this.loadLevel = startIdx;
        if (reason !== "manifest_init" && currentH > capH) {
          this._emitAutoDowngrade(this.levels[startIdx]?.height || startH, snap, reason);
        }
      }
    }

    this._emitNetworkStats(snap);
  }

  _handleBandwidthDrop(reason) {
    if (!this.levels || !this.levels.length || !this._isAutoMode()) return;

    const sorted = this._getSortedLevelIndices();
    if (sorted.length <= 1) return;

    const curIdx = this.currentLevel >= 0 ? this.currentLevel : this.loadLevel;
    const pos = sorted.findIndex((e) => e.idx === curIdx);
    const nextPos = pos > 0 ? pos - 1 : 0;
    const targetEntry = sorted[nextPos];

    if (!targetEntry || targetEntry.idx === curIdx) return;

    this._consecutiveFastSegments = 0;
    this._cooldownUntil = Date.now() + 45000;
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
        activeHeight: activeLvl ? activeLvl.height : null,
        activeBitrateKbps: activeLvl && activeLvl.bitrate ? Math.round(activeLvl.bitrate / 1000) : null
      }
    }));
  }

  getNetworkSnapshot() {
    const conn = getNavigatorConnection();
    const eff = conn && conn.effectiveType ? conn.effectiveType : "";
    const dlMbps = conn && typeof conn.downlink === "number" && conn.downlink > 0 ? conn.downlink : null;
    const saveData = Boolean(conn && conn.saveData);

    const effectiveKbps = this._measuredKbps > 0
      ? this._measuredKbps
      : (dlMbps ? Math.round(dlMbps * 1000) : 1200);

    let tier = "4G";
    if (saveData || eff === "slow-2g" || eff === "2g" || effectiveKbps < 240 || (dlMbps !== null && dlMbps <= 0.35)) {
      tier = "2G";
    } else if (eff === "3g" || effectiveKbps < 600 || (dlMbps !== null && dlMbps <= 1.2)) {
      tier = "3G";
    } else if (effectiveKbps < 1500 || (dlMbps !== null && dlMbps <= 3.0)) {
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

      const savedPref = localStorage.getItem(DEFAULT_PREF_KEY) || "auto";
      if (savedPref === "auto") {
        this._applyNetworkPolicy("manifest_init");
      } else {
        this.setQualityLevel(savedPref);
      }
    });

    this.on(OriginalHls.Events.FRAG_LOADED, (_event, data) => {
      const stats = data?.frag?.stats;
      const durSec = data?.frag?.duration || 6;
      if (!stats || !stats.loaded || !stats.loading) return;

      const loadMs = Math.max(1, (stats.loading.end || performance.now()) - (stats.loading.start || 0));
      const instantKbps = Math.round((stats.loaded * 8) / loadMs);
      this._measuredKbps = this._measuredKbps > 0
        ? Math.round(this._measuredKbps * 0.65 + instantKbps * 0.35)
        : instantKbps;

      const snap = this.getNetworkSnapshot();
      const loadRatio = loadMs / (durSec * 1000);
      const curLvl = this.levels && this.levels[this.currentLevel];
      const curLvlKbps = curLvl && curLvl.bitrate ? Math.round(curLvl.bitrate / 1000) : 800;

      if (this._isAutoMode() && (loadRatio > 0.78 || this._measuredKbps < curLvlKbps * 0.95)) {
        this._handleBandwidthDrop("slow_download");
        return;
      }

      if (this._isAutoMode() && Date.now() > this._cooldownUntil) {
        if (loadRatio < 0.35 && this._measuredKbps > curLvlKbps * 1.6) {
          this._consecutiveFastSegments++;
          if (this._consecutiveFastSegments >= 2) {
            this._consecutiveFastSegments = 0;
            const sorted = this._getSortedLevelIndices();
            const pos = sorted.findIndex((e) => e.idx === this.autoLevelCapping);
            if (pos >= 0 && pos + 1 < sorted.length) {
              this.autoLevelCapping = sorted[pos + 1].idx;
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

  /**
   * Applique une qualité cible ("auto", "1080p", "720p", "480p", "360p", "240p").
   */
  setQualityLevel(targetQuality) {
    if (targetQuality === "auto" || targetQuality === -1) {
      this._cooldownUntil = 0;
      this.autoLevelCapping = -1;
      this.currentLevel = -1;
      this.loadLevel = -1;
      this.nextLevel = -1;
      this._applyNetworkPolicy("manual_auto");
      return -1;
    }

    if (!this.levels || !this.levels.length) return -1;

    const targetHeight = parseInt(targetQuality, 10);
    if (isNaN(targetHeight)) return -1;

    this.autoLevelCapping = -1;
    const bestIdx = this._pickLevelForTargetHeight(targetHeight, false);
    this.currentLevel = bestIdx;
    this.loadLevel = bestIdx;
    this.nextLevel = bestIdx;
    this._emitNetworkStats(this.getNetworkSnapshot());
    return bestIdx;
  }
}

export default KibangouHls;
export { KibangouHls as Hls };
