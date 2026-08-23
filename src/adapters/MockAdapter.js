import { BaseMarketDataAdapter } from './BaseMarketDataAdapter.js';
import { normalizeQuote, normalizeDepth } from '../normalizers/normalize.js';

const SEED_PRICES = {
  NIFTY: 24800,
  BANKNIFTY: 51200,
  SENSEX: 81200
};

/**
 * MockAdapter
 * Generates plausible synthetic quote + 20-level depth ticks so the
 * entire application (engines, frontend, PWA) is fully exercisable
 * with zero broker credentials.
 */
export class MockAdapter extends BaseMarketDataAdapter {
  constructor() {
    super('MOCK');
    this._subs = new Map(); // symbol -> { price, timer }
    this._depthSubs = new Set();
  }

  async connect() {
    this._connectionStatus = 'CONNECTED';
    return true;
  }

  async disconnect() {
    for (const [, sub] of this._subs) clearInterval(sub.timer);
    this._subs.clear();
    this._connectionStatus = 'DISCONNECTED';
  }

  async getQuote(instrument) {
    const symbol = instrument.symbol || instrument;
    const price = SEED_PRICES[symbol] ?? 20000;
    return normalizeQuote(this._buildQuote(symbol, price));
  }

  async getHistoricalCandles(instrument, timeframe) {
    const symbol = instrument.symbol || instrument;
    const base = SEED_PRICES[symbol] ?? 20000;
    const candles = [];
    let price = base;
    const now = Date.now();
    const stepMs = timeframeToMs(timeframe);
    for (let i = 100; i >= 0; i--) {
      const drift = (Math.random() - 0.5) * base * 0.0015;
      const open = price;
      const close = open + drift;
      const high = Math.max(open, close) + Math.random() * base * 0.0005;
      const low = Math.min(open, close) - Math.random() * base * 0.0005;
      candles.push({
        timestamp: now - i * stepMs,
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: Math.floor(Math.random() * 500000)
      });
      price = close;
    }
    return candles;
  }

  async getOptionChain(underlying, expiry) {
    const spot = SEED_PRICES[underlying] ?? 20000;
    const strikeStep = underlying === 'BANKNIFTY' ? 100 : 50;
    const atm = Math.round(spot / strikeStep) * strikeStep;
    const strikes = [];
    for (let i = -5; i <= 5; i++) strikes.push(atm + i * strikeStep);

    return {
      provider: 'MOCK',
      underlying,
      expiry: expiry || 'MOCK-WEEKLY',
      spot,
      strikes: strikes.map((strike) => ({
        strike,
        CE: mockOptionLeg(spot, strike, 'CE'),
        PE: mockOptionLeg(spot, strike, 'PE')
      })),
      dataQuality: 'MOCK'
    };
  }

  async subscribeMarketData(instruments) {
    for (const inst of instruments) {
      const symbol = inst.symbol || inst;
      if (this._subs.has(symbol)) continue;
      const state = { price: SEED_PRICES[symbol] ?? 20000, volume: 0 };
      const timer = setInterval(() => {
        state.price = walkPrice(state.price);
        state.volume += Math.floor(Math.random() * 5000);
        this._emitQuote(normalizeQuote(this._buildQuote(symbol, state.price, state.volume)));
        if (this._depthSubs.has(symbol)) {
          this._emitDepth(normalizeDepth(mockDepth('MOCK', symbol, state.price)));
        }
      }, 500);
      this._subs.set(symbol, { ...state, timer });
    }
    return true;
  }

  async unsubscribeMarketData(instruments) {
    for (const inst of instruments) {
      const symbol = inst.symbol || inst;
      const sub = this._subs.get(symbol);
      if (sub) {
        clearInterval(sub.timer);
        this._subs.delete(symbol);
      }
    }
    return true;
  }

  async subscribeDepth(instruments, levels = 20) {
    for (const inst of instruments) this._depthSubs.add(inst.symbol || inst);
    return true;
  }

  async unsubscribeDepth(instruments) {
    for (const inst of instruments) this._depthSubs.delete(inst.symbol || inst);
    return true;
  }

  _buildQuote(symbol, price, volume = 0) {
    return {
      provider: 'MOCK',
      symbol,
      exchange: 'NSE',
      segment: 'INDEX',
      securityId: `MOCK-${symbol}`,
      timestamp: Date.now(),
      ltp: round(price),
      ltq: Math.floor(Math.random() * 75) + 25,
      ltt: new Date().toISOString(),
      open: round(price * 0.999),
      high: round(price * 1.003),
      low: round(price * 0.997),
      close: round(price * 0.999),
      volume,
      totalBuyQuantity: Math.floor(Math.random() * 2000000),
      totalSellQuantity: Math.floor(Math.random() * 2000000),
      oi: null,
      oiDayHigh: null,
      oiDayLow: null,
      dataQuality: 'MOCK'
    };
  }
}

function walkPrice(price) {
  const drift = (Math.random() - 0.5) * price * 0.0008;
  return price + drift;
}

function mockDepth(provider, symbol, midPrice) {
  const tick = symbol === 'BANKNIFTY' ? 0.05 : 0.05;
  const bids = [];
  const asks = [];
  for (let i = 0; i < 20; i++) {
    bids.push({
      price: round(midPrice - tick * (i + 1)),
      quantity: Math.floor(Math.random() * 1500) + 50,
      orderCount: Math.floor(Math.random() * 20) + 1,
      level: i + 1
    });
    asks.push({
      price: round(midPrice + tick * (i + 1)),
      quantity: Math.floor(Math.random() * 1500) + 50,
      orderCount: Math.floor(Math.random() * 20) + 1,
      level: i + 1
    });
  }
  return {
    provider,
    symbol,
    securityId: `MOCK-${symbol}`,
    timestamp: Date.now(),
    levelsAvailable: 20,
    bids,
    asks,
    dataQuality: 'MOCK'
  };
}

function mockOptionLeg(spot, strike, type) {
  const intrinsic = type === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(20 - Math.abs(spot - strike) * 0.02, 2) + Math.random() * 5;
  const ltp = round(intrinsic + timeValue);
  return {
    ltp,
    bid: round(ltp - 0.5),
    ask: round(ltp + 0.5),
    bidQty: Math.floor(Math.random() * 4000) + 100,
    askQty: Math.floor(Math.random() * 4000) + 100,
    oi: Math.floor(Math.random() * 500000),
    oiChange: Math.floor((Math.random() - 0.5) * 50000),
    volume: Math.floor(Math.random() * 200000),
    iv: round(11 + Math.random() * 8),
    dataQuality: 'MOCK'
  };
}

function timeframeToMs(tf) {
  const map = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 };
  return map[tf] || 60000;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
