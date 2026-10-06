import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIfPlayApp } from '../src/app.mjs';
import { ProjectStore } from '../src/lib/store.mjs';

async function startApp() {
  process.env.IFPLAY_GENERATOR_MODE = 'demo';
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ifplay-test-'));
  const app = await createIfPlayApp({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitForTask(baseUrl, taskId, token) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      headers: { 'x-project-token': token },
    });
    const body = await response.json();
    if (body.task.status === 'succeeded' || body.task.status === 'failed') return body.task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('task timeout');
}

test('creates a project, generates a playable version, and modifies it', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const createdResponse = await fetch(`${app.baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea: '做一个点击得分小游戏' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.ok(created.token);

  const generateResponse = await fetch(
    `${app.baseUrl}/api/projects/${created.project.id}/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-project-token': created.token },
      body: JSON.stringify({ instruction: '先生成一个可玩的版本' }),
    },
  );
  assert.equal(generateResponse.status, 202);
  const generation = await generateResponse.json();
  assert.equal((await waitForTask(app.baseUrl, generation.task.id, created.token)).status, 'succeeded');

  const previewResponse = await fetch(
    `${app.baseUrl}/api/projects/${created.project.id}/preview`,
    { headers: { 'x-project-token': created.token } },
  );
  assert.equal(previewResponse.status, 200);
  assert.match(await previewResponse.text(), /开发模式演示，不是 AI 真实生成结果/);

  const modifyResponse = await fetch(
    `${app.baseUrl}/api/projects/${created.project.id}/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-project-token': created.token },
      body: JSON.stringify({ instruction: '把目标改成十秒内点击二十次' }),
    },
  );
  const modification = await modifyResponse.json();
  assert.equal((await waitForTask(app.baseUrl, modification.task.id, created.token)).status, 'succeeded');

  const versionsResponse = await fetch(
    `${app.baseUrl}/api/projects/${created.project.id}/versions`,
    { headers: { 'x-project-token': created.token } },
  );
  const versions = await versionsResponse.json();
  assert.equal(versions.versions.length, 2);
  assert.equal(versions.versions[1].parentVersionId, versions.versions[0].id);
});

test('returns typed errors and protects project access', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const invalidResponse = await fetch(`${app.baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea: '短' }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), {
    error: { code: 'IDEA_INVALID', message: '游戏想法需要 4 到 2000 个字符。' },
  });

  const createdResponse = await fetch(`${app.baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea: '做一个简单的躲避游戏' }),
  });
  const created = await createdResponse.json();
  const deniedResponse = await fetch(`${app.baseUrl}/api/projects/${created.project.id}`, {
    headers: { 'x-project-token': 'wrong-token' },
  });
  assert.equal(deniedResponse.status, 403);
  assert.equal((await deniedResponse.json()).error.code, 'PROJECT_ACCESS_DENIED');
});

test('keeps the last playable version when a later task fails', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ifplay-store-test-'));
  const store = new ProjectStore(dataDir);
  await store.init();
  const created = await store.createProject('做一个不会丢失版本的测试游戏');
  const firstTask = await store.createTask(created.project.id, 'initial', '生成第一版');
  const firstVersion = await store.completeTask(firstTask.id, {
    generatorMode: 'demo',
    outputPath: path.join(dataDir, 'first', 'index.html'),
  });
  const failedTask = await store.createTask(created.project.id, 'modify', '执行一个失败修改');
  await store.failTask(failedTask.id, new Error('模拟失败'));

  const project = store.getProject(created.project.id);
  assert.equal(project.status, 'playable');
  assert.equal(project.currentVersionId, firstVersion.id);
  assert.equal(store.getTask(failedTask.id).status, 'failed');
});
