export class TaskQueue {
  constructor({ concurrency, worker }) {
    this.concurrency = concurrency;
    this.worker = worker;
    this.running = 0;
    this.pending = [];
  }

  add(task) {
    this.pending.push(task);
    queueMicrotask(() => this.drain());
  }

  drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      this.running += 1;
      Promise.resolve(this.worker(task))
        .catch(() => {})
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  snapshot() {
    return { running: this.running, queued: this.pending.length, concurrency: this.concurrency };
  }
}
