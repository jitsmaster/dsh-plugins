// Child process for the multi-process queue test: enqueue, wait for the lease,
// hold it ~50 ms, append "name start end" to the shared log, release.
// Usage: node queue-worker.mjs <dir> <log> <name>
import fs from 'node:fs';
import { createQueue } from '../lib/queue.js';
import { sleepSync } from '../lib/lock.js';

const [dir, log, name] = process.argv.slice(2);

const q = createQueue({ dir });
const { ticket } = q.enqueue({ holder: name, pid: process.pid });
fs.writeFileSync(`${log}.${name}.enq`, ''); // tells the test this worker is in the queue
let r = q.poll(ticket);
// Deadline is far above the lock timeout (5 s) so a loaded machine does not flake.
const deadline = Date.now() + 30000;
while (r.status === 'waiting' && Date.now() < deadline) {
  sleepSync(5);
  r = q.poll(ticket);
}
if (r.status !== 'granted') process.exit(2);
const start = Date.now();
sleepSync(50);
const end = Date.now();
fs.appendFileSync(log, `${name} ${start} ${end}\n`);
q.release(r.token);
