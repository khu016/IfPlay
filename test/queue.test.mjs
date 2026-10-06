import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskQueue } from '../src/lib/queue.mjs';

test('never runs more than two tasks concurrently', async () => {
  let running = 0;
  let maximum = 0;
  let completed = 0;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const queue = new TaskQueue({
    concurrency: 2,
    worker: async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      completed += 1;
      if (completed === 5) finish();
    },
  });

  for (let id = 0; id < 5; id += 1) queue.add({ id });
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.deepEqual(queue.snapshot(), { running: 0, queued: 0, concurrency: 2 });
});
