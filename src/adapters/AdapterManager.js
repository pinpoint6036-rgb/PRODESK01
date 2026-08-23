import { DhanAdapter } from './DhanAdapter.js';
import { AngelAdapter } from './AngelAdapter.js';
import { MockAdapter } from './MockAdapter.js';
import { config, hasDhanCredentials, hasAngelCredentials } from '../config/index.js';

/**
 * AdapterManager
 *
 * Owns provider selection and fallback. Downstream code (rolling
 * store, engines) never imports a concrete adapter — only this
 * manager, and only through onQuote/onDepth/onError + getStatus().
 *
 * Fallback rule (per spec):
 *   1. DHAN primary
 *   2. ANGEL fallback
 *   3. MOCK for development
 * If both live providers fail, preserve the last valid market state
 * and mark the frontend STALE — never silently fabricate data.
 */
export class AdapterManager {
  constructor() {
    this.active = null; // current adapter instance
    this.activeName = null; // 'DHAN' | 'ANGEL' | 'MOCK'
    this._quoteCallbacks = [];
    this._depthCallbacks = [];
    this._statusCallbacks = [];
    this._instruments = [];
    this._depthInstruments = [];
  }

  onQuote(cb) {
    this._quoteCallbacks.push(cb);
  }
  onDepth(cb) {
    this._depthCallbacks.push(cb);
  }
  onStatusChange(cb) {
    this._statusCallbacks.push(cb);
  }

  getStatus() {
    return {
      activeProvider: this.activeName,
      connectionStatus: this.active?.getConnectionStatus() || 'DISCONNECTED',
      dataMode: config.dataMode
    };
  }

  async start() {
    if (config.dataMode === 'MOCK') {
      await this._activate(new MockAdapter(), 'MOCK');
      return;
    }

    if (config.dataMode === 'REPLAY') {
      // Replay mode is wired up in src/replay — AdapterManager just
      // stays idle and lets the replay service push into the store.
      this.activeName = 'REPLAY';
      return;
    }

    // LIVE mode: try primary, then secondary, then mock as last resort
    // so the app never fully dies even if both brokers are down.
    if (config.primaryBroker === 'DHAN' && hasDhanCredentials()) {
      try {
        await this._activate(new DhanAdapter(config.dhan), 'DHAN');
        return;
      } catch (err) {
        this._notifyStatus({ event: 'PRIMARY_FAILED', provider: 'DHAN', error: err.message });
      }
    }

    if (config.secondaryBroker === 'ANGEL' && hasAngelCredentials()) {
      try {
        await this._activate(new AngelAdapter(config.angel), 'ANGEL');
        return;
      } catch (err) {
        this._notifyStatus({ event: 'SECONDARY_FAILED', provider: 'ANGEL', error: err.message });
      }
    }

    this._notifyStatus({ event: 'ALL_PROVIDERS_FAILED', fallback: 'MOCK' });
    await this._activate(new MockAdapter(), 'MOCK');
  }

  async subscribe(instruments) {
    this._instruments = instruments;
    if (!this.active) return;
    await this.active.subscribeMarketData(instruments);
  }

  async subscribeDepth(instruments, levels) {
    this._depthInstruments = instruments;
    if (!this.active) return;
    await this.active.subscribeDepth(instruments, levels);
  }

  async getOptionChain(underlying, expiry) {
    if (!this.active) return null;
    return this.active.getOptionChain(underlying, expiry);
  }

  async _activate(adapterInstance, name) {
    this.active = adapterInstance;
    this.activeName = name;

    adapterInstance.onQuote((q) => {
      for (const cb of this._quoteCallbacks) cb(q, name);
    });
    adapterInstance.onDepth((d) => {
      for (const cb of this._depthCallbacks) cb(d, name);
    });
    adapterInstance.onError((err) => this._handleAdapterError(err));

    await adapterInstance.connect();
    this._notifyStatus({ event: 'CONNECTED', provider: name });
  }

  async _handleAdapterError(err) {
    this._notifyStatus({ event: 'ADAPTER_ERROR', ...err });

    // If the primary (Dhan) drops, attempt automatic fallback to Angel.
    if (this.activeName === 'DHAN' && hasAngelCredentials()) {
      try {
        await this._activate(new AngelAdapter(config.angel), 'ANGEL');
        if (this._instruments.length) await this.active.subscribeMarketData(this._instruments);
        if (this._depthInstruments.length) await this.active.subscribeDepth(this._depthInstruments);
        return;
      } catch (fallbackErr) {
        this._notifyStatus({ event: 'FALLBACK_FAILED', provider: 'ANGEL', error: fallbackErr.message });
      }
    }

    // Both live providers unavailable — preserve last state, mark STALE.
    this._notifyStatus({ event: 'ALL_LIVE_PROVIDERS_DOWN', action: 'PRESERVE_LAST_STATE_MARK_STALE' });
  }

  _notifyStatus(payload) {
    for (const cb of this._statusCallbacks) cb(payload);
  }
}
