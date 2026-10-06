import { createServer } from 'node:http';
import path from 'node:path';
import { cp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppError, errorBody } from './lib/errors.mjs';
import { generateGame } from './lib/generator.mjs';
import { TaskQueue } from './lib/queue.mjs';
import { ProjectStore } from './lib/store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/tokens.css', [path.join('..', 'tokens.css'), 'text/css; charset=utf-8']],
]);

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AppError('BODY_TOO_LARGE', '请求内容过大。', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', '请求内容不是有效 JSON。');
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function token(request) {
  const value = request.headers['x-project-token'];
  return Array.isArray(value) ? value[0] : value;
}

export async function createIfPlayApp(options = {}) {
  const dataDir = options.dataDir ?? process.env.IFPLAY_DATA_DIR ?? '.data';
  const store = new ProjectStore(dataDir);
  await store.init();
  const concurrency = Number(options.concurrency ?? process.env.IFPLAY_MAX_CONCURRENT_TASKS ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new Error('IFPLAY_MAX_CONCURRENT_TASKS 必须是 1 或 2');
  }

  const worker = options.worker ?? (async (task) => {
    await store.updateTask(task.id, { status: 'running', stage: 'generating', startedAt: new Date().toISOString() });
    const project = store.getProject(task.projectId);
    const versions = store.listVersions(project.id);
    const nextVersion = project.nextVersionNumber ?? versions.length + 1;
    const outputDir = path.join(store.dataDir, 'projects', project.id, 'versions', `v${nextVersion}`);
    try {
      if (project.currentVersionId) {
        const previous = versions.find((item) => item.id === project.currentVersionId);
        if (previous) await cp(path.dirname(previous.outputPath), outputDir, { recursive: true });
      }
      const output = await generateGame({ project, task, outputDir });
      await store.completeTask(task.id, output);
    } catch (error) {
      await store.failTask(task.id, error);
    }
  });
  const queue = new TaskQueue({ concurrency, worker });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [relativePath, contentType] = staticFiles.get(url.pathname);
        const body = await readFile(path.resolve(publicRoot, relativePath));
        response.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        return response.end(body);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, {
          status: 'ok',
          generatorMode: process.env.IFPLAY_GENERATOR_MODE ?? 'demo',
          queue: queue.snapshot(),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const body = await readJson(request);
        const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
        if (idea.length < 4 || idea.length > 2000) {
          throw new AppError('IDEA_INVALID', '游戏想法需要 4 到 2000 个字符。');
        }
        const created = await store.createProject(idea);
        return sendJson(response, 201, created);
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (request.method === 'GET' && projectMatch) {
        const project = store.authorizeProject(projectMatch[1], token(request));
        return sendJson(response, 200, { project: store.publicProject(project) });
      }

      const generationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generations$/);
      if (request.method === 'POST' && generationMatch) {
        const project = store.authorizeProject(generationMatch[1], token(request));
        if (store.hasActiveTask(project.id)) {
          throw new AppError('PROJECT_BUSY', '当前项目已有生成任务，请等待完成后再修改。', 409);
        }
        const body = await readJson(request);
        const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
        if (instruction.length < 2 || instruction.length > 2000) {
          throw new AppError('INSTRUCTION_INVALID', '生成要求需要 2 到 2000 个字符。');
        }
        const kind = project.currentVersionId ? 'modify' : 'initial';
        const task = await store.createTask(project.id, kind, instruction);
        queue.add(task);
        return sendJson(response, 202, { task });
      }

      const versionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/versions$/);
      if (request.method === 'GET' && versionsMatch) {
        store.authorizeProject(versionsMatch[1], token(request));
        return sendJson(response, 200, { versions: store.listVersions(versionsMatch[1]) });
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === 'GET' && taskMatch) {
        const task = store.getTask(taskMatch[1]);
        store.authorizeProject(task.projectId, token(request));
        return sendJson(response, 200, { task });
      }

      const previewMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (request.method === 'GET' && previewMatch) {
        const project = store.authorizeProject(previewMatch[1], token(request));
        const version = store.listVersions(project.id).find((item) => item.id === project.currentVersionId);
        if (!version) throw new AppError('VERSION_NOT_READY', '项目还没有可试玩版本。', 409);
        const html = await readFile(version.outputPath, 'utf8');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(html);
      }

      throw new AppError('ROUTE_NOT_FOUND', '接口不存在。', 404);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      sendJson(response, status, errorBody(error));
    }
  });

  return { server, store, queue };
}
