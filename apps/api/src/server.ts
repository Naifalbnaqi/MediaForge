import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { loadServerEnvironment } from '@media/config';
import { buildApp } from './app.js';

dotenv.config({ path: resolve(process.cwd(), '../../.env') });

const environment = loadServerEnvironment();
const app = await buildApp(environment);

// Long enough for in-flight requests to finish, short enough to beat an orchestrator's
// stop timeout — a wedged close (a stuck keep-alive, a hung dependency) must not hang.
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Graceful shutdown started');
  setTimeout(() => {
    app.log.error('Graceful shutdown timed out — exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  await app.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'API failed to start');
  process.exit(1);
}
