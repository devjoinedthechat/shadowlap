#!/usr/bin/env node
import { startCollector } from '../dist/index.js';

const port = Number(process.env.PORT ?? 8787);
const db = process.env.COLLECTOR_DB ?? './collector.db';
const collector = await startCollector({ port, host: process.env.HOST ?? '0.0.0.0', db, ...(process.env.PUBLIC_ORIGIN ? { publicOrigin: process.env.PUBLIC_ORIGIN } : {}) });
console.log(`shadowlap-collector listening on ${collector.url} (db: ${db})`);
const stop = () => void collector.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
