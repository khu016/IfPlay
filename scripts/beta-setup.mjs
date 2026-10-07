import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/lib/store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.IFPLAY_DATA_DIR ?? path.join(projectRoot, '.data'));
const count = Number(process.argv[2] ?? 20);
const maxProjects = Number(process.argv[3] ?? 3);
const store = new ProjectStore(dataDir);
await store.init();
const result = await store.setupBeta({ count, maxProjects });
const accessFile = path.join(dataDir, 'beta-access.json');
await mkdir(dataDir, { recursive: true });
await writeFile(accessFile, `${JSON.stringify({
  createdAt: new Date().toISOString(),
  adminUrl: `http://${process.env.IFPLAY_HOST ?? '127.0.0.1'}:${process.env.IFPLAY_PORT ?? '8787'}/beta`,
  adminToken: result.adminToken,
  inviteCodes: result.codes,
  maxProjects: result.maxProjects,
}, null, 2)}\n`, { mode: 0o600 });
console.log(`已生成 ${result.codes.length} 个邀请码，每个最多创建 ${result.maxProjects} 个项目。`);
console.log(`管理员凭证与邀请码已保存到：${accessFile}`);

