import express from 'express';
import cors from 'cors';
import { createServer } from 'http';

import { config } from './src/config/index.js';
import { AdapterManager } from './src/adapters/AdapterManager.js';
import { RollingMarketStore } from './src/stores/RollingMarketStore.js';
import { runEngineChain } from './src/engines/pipeline.js';
import { attachSocket } from './src/socket/index.js';
import { healthRouter } from './src/routes/health.js';
import { resolveMicrostructureInstrument, listUnderlyings } from './src/data/instrumentResolver.js';

/**
 * SIGNAL-ONLY APPLICATION.
 * This server does not, and must never, place, modify, or cancel
 * orders. There is no order-placement route, no broker order API
 * call, and no code path that executes a trade. All output is
 * read-only market intelligence for a human to act on manually.
 */

const app = express();
app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json());

const rollingStore = new RollingMarketStore();
const adapterManager = new AdapterManager();

app.use('/api', healthRouter({ adapterManager, rollingStore }));

// Explicit guard: reject anything that looks like an order-placement
// request, in case a future contributor adds one by mistake.
app.all('/api/order*', (req, res) => {
  res.status(403).json({
    error: 'FORBIDDEN',
    message: 'This is a signal-only application. Order placement is not implemented and will not be added to this API.'
  });
});

const httpServer = createServer(app);
attachSocket(httpServer, { adapterManager, rollingStore, runEngineChain });

async function start() {
  await adapterManager.start();

  const trackedSymbols = listUnderlyings();
  const instruments = trackedSymbols.map((sym) => resolveMicrostructureInstrument(sym));

  adapterManager.onQuote((quote, provider) => {
    rollingStore.forSymbol(quote.symbol.replace('-FUT', '')).pushQuote(quote);
  });
  adapterManager.onDepth((depth, provider) => {
    rollingStore.forSymbol(depth.symbol.replace('-FUT', '')).pushDepth(depth);
  });

  await adapterManager.subscribe(instruments);
  await adapterManager.subscribeDepth(instruments, 20);

  // Option chain poller — Engines 12-14 need periodic snapshots.
  // REST-based (not streamed) since option chain updates far less
  // frequently than the underlying tick stream.
  const OPTION_CHAIN_POLL_MS = 5000;
  setInterval(async () => {
    for (const symbol of trackedSymbols) {
      try {
        const chain = await adapterManager.getOptionChain(symbol, 'NEAREST_WEEKLY');
        if (chain) rollingStore.forSymbol(symbol).pushOptionSnapshot(chain);
      } catch (err) {
        // Option chain is best-effort; engines correctly report
        // UNAVAILABLE when no snapshot has landed yet.
      }
    }
  }, OPTION_CHAIN_POLL_MS);

  httpServer.listen(config.port, () => {
    console.log(`PRO DESK MICROSTRUCTURE backend listening on :${config.port}`);
    console.log(`DATA_MODE=${config.dataMode}  PRIMARY_BROKER=${config.primaryBroker}  SECONDARY_BROKER=${config.secondaryBroker}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
