import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/lib/store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.IFPLAY_DATA_DIR ?? path.join(projectRoot, '.data'));
const store = new ProjectStore(dataDir);
await store.init();
const beta = store.getBetaSummary();
const completed = beta.playtests.filter((item) => item.outcome === 'completed').length;
const blocked = beta.playtests.filter((item) => item.outcome === 'blocked').length;
console.log(JSON.stringify({
  invites: beta.invites,
  testers: beta.testers.length,
  projects: beta.projects,
  moderationPending: beta.moderation.filter((item) => item.status === 'pending').length,
  playtests: beta.playtests.length,
  completed,
  blocked,
}, null, 2));

