// Loads the built Worker as an ES module (the file is plain .js; copy it next to a .mjs name so Node parses it as ESM).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(here, '..', '..', 'edge-desk.worker.js');
if (!fs.existsSync(built)) throw new Error('edge-desk.worker.js not built; run build.sh first');
const tmp = path.join(os.tmpdir(), 'edge-desk-worker-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.mjs');
fs.copyFileSync(built, tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } });
export const mod = await import(pathToFileURL(tmp).href);
export const worker = mod.default;
export const Desk = mod.__desk._internal;
export const Eng = mod.__engine._internal;
export const EngineDO = mod.EngineDO;
export const Money = mod.__money;
