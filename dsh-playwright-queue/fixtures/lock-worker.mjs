// Child process for the multi-process lock tests.
// Usage: node lock-worker.mjs <mode> <lockPath> <file> <iterations>
//   counter: increment the number in <file> <iterations> times, one transaction each.
//   marker:  enter the critical section <iterations> times; append "V" to <file> whenever
//            another process is already inside (detected via an exclusive marker file).
//   hold:    take the lock, write "ready" to <file>, then sleep until killed.
import fs from 'node:fs';
import { withLockSync, sleepSync } from '../lib/lock.js';

const [mode, lockPath, file, iters] = process.argv.slice(2);
const n = Number(iters);
const opts = { timeoutMs: 30000, retryMs: 2 };

if (mode === 'counter') {
  for (let i = 0; i < n; i++) {
    withLockSync(lockPath, () => {
      const v = Number(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, String(v + 1));
    }, opts);
  }
} else if (mode === 'marker') {
  const marker = `${file}.inside`;
  for (let i = 0; i < n; i++) {
    withLockSync(lockPath, () => {
      try {
        fs.writeFileSync(marker, String(process.pid), { flag: 'wx' });
      } catch {
        fs.appendFileSync(file, 'V');
        return;
      }
      sleepSync(1);
      fs.rmSync(marker, { force: true });
    }, opts);
  }
} else if (mode === 'hold') {
  withLockSync(lockPath, () => {
    fs.writeFileSync(file, 'ready');
    sleepSync(60000);
  }, opts);
}
