import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIfPlayApp } from '../src/app.mjs';
import { normalizePlannerResult } from '../src/lib/planner.mjs';
import { ProjectStore } from '../src/lib/store.mjs';

async function startApp(options = {}) {
  process.env.IFPLAY_GENERATOR_MODE = 'demo';
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ifplay-test-'));
  const app = await createIfPlayApp({ dataDir, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${address.port}` };
}

function proposal(name, action, pace = 'balanced') {
  return {
    name,
    oneLiner: `${action}，完成一局短小但完整的游戏。`,
    playerRole: '纸飞机驾驶者',
    goal: `通过${action}获得足够星光`,
    coreLoop: [`观察${action}目标`, `执行${action}`, '获得反馈并继续'],
    controls: '方向键或触控拖动',
    successCondition: `两分钟内完成${action}目标`,
    failureCondition: `连续三次错过${action}目标`,
    sessionLengthMinutes: 2,
    pace,
    visualDirection: '蓝紫色雨夜城市、清晰剪影和柔和霓虹光',
    highlightMoment: `完成连续${action}时触发满屏星光`,
    simplifications: ['首版只做一个场景'],
    implementationRisk: 'low',
  };
}

test('enforces the three-question limit and rejects duplicate gameplay proposals', () => {
  assert.throws(
    () => normalizePlannerResult({
      kind: 'question',
      question: { text: '还要继续问吗？', options: ['继续', '停止'] },
    }, 3),
    (error) => error.code === 'PLANNER_QUESTION_LIMIT',
  );
  const repeated = proposal('同一种玩法', '收集星光');
  assert.throws(
    () => normalizePlannerResult({ kind: 'proposals', proposals: [repeated, repeated, repeated] }, 0),
    (error) => error.code === 'PLANNER_RESPONSE_INVALID',
  );
});

test('asks one useful question and persists three structured gameplay proposals', async (t) => {
  const plannerCalls = [];
  const planner = async (input) => {
    plannerCalls.push(input);
    if (input.questionCount === 0) {
      return {
        kind: 'question',
        question: {
          id: 'question-1',
          text: '你更想要放松探索，还是紧张挑战？',
          options: ['放松探索', '紧张挑战', '两者平衡'],
          allowFreeText: true,
        },
        provider: { model: 'test-planner', usage: null },
      };
    }
    return {
      kind: 'proposals',
      proposals: [
        { id: 'proposal-a', ...proposal('雨夜拾光', '自由收集', 'relaxed') },
        { id: 'proposal-b', ...proposal('霓虹穿环', '节奏穿环', 'intense') },
        { id: 'proposal-c', ...proposal('记忆航线', '路线选择', 'balanced') },
      ],
      provider: { model: 'test-planner', usage: { total_tokens: 123 } },
    };
  };
  const app = await startApp({ planner });
  t.after(() => app.server.close());
  const created = await app.store.createProject('做一个雨夜收集星光的纸飞机游戏');
  const headers = { 'content-type': 'application/json', 'x-project-token': created.token };

  const firstResponse = await fetch(`${app.baseUrl}/api/projects/${created.project.id}/planning`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.planning.pendingQuestion.options.length, 3);
  assert.equal(plannerCalls.length, 1);

  const repeatedResponse = await fetch(`${app.baseUrl}/api/projects/${created.project.id}/planning`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(repeatedResponse.status, 200);
  assert.equal(plannerCalls.length, 1);

  const proposalsResponse = await fetch(`${app.baseUrl}/api/projects/${created.project.id}/planning`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ answer: '两者平衡' }),
  });
  const proposals = await proposalsResponse.json();
  assert.equal(proposalsResponse.status, 200);
  assert.equal(proposals.planning.status, 'proposal_ready');
  assert.equal(proposals.planning.clarifications.length, 1);
  assert.equal(proposals.planning.proposals.length, 3);
  assert.equal(plannerCalls.length, 2);

  const restoredResponse = await fetch(`${app.baseUrl}/api/projects/${created.project.id}/planning`, {
    headers: { 'x-project-token': created.token },
  });
  const restored = await restoredResponse.json();
  assert.equal(restored.planning.proposals[1].name, '霓虹穿环');
  assert.equal(restored.planning.provider.model, 'test-planner');
});

test('protects planning access and prevents concurrent planning calls', async (t) => {
  let releasePlanner;
  const planner = () => new Promise((resolve) => {
    releasePlanner = () => resolve({
      kind: 'question',
      question: {
        id: 'question-1',
        text: '你希望游戏更偏向什么节奏？',
        options: ['舒缓', '均衡', '紧张'],
        allowFreeText: true,
      },
      provider: { model: 'test-planner', usage: null },
    });
  });
  const app = await startApp({ planner });
  t.after(() => app.server.close());
  const created = await app.store.createProject('测试玩法策划并发保护');
  const url = `${app.baseUrl}/api/projects/${created.project.id}/planning`;
  const firstRequest = fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-project-token': created.token },
    body: '{}',
  });
  while (!releasePlanner) await new Promise((resolve) => setTimeout(resolve, 1));
  const busyResponse = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-project-token': created.token },
    body: '{}',
  });
  assert.equal(busyResponse.status, 409);
  assert.equal((await busyResponse.json()).error.code, 'PLANNING_BUSY');
  releasePlanner();
  assert.equal((await firstRequest).status, 200);

  const deniedResponse = await fetch(url, {
    headers: { 'x-project-token': 'wrong-token' },
  });
  assert.equal(deniedResponse.status, 403);
});

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

  const pageResponse = await fetch(`${app.baseUrl}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /IfPlay · 游戏创作台/);

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

test('inlines local scripts and styles for sandboxed previews', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  const created = await app.store.createProject('测试多文件游戏预览');
  const task = await app.store.createTask(created.project.id, 'initial', '生成多文件版本');
  const outputDir = path.join(app.store.dataDir, 'projects', created.project.id, 'versions', 'v1');
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, 'index.html'),
    '<link rel="stylesheet" href="style.css"><button id="play">开始</button><script src="game.js"></script>',
  );
  await writeFile(path.join(outputDir, 'style.css'), '#play{color:red}');
  await mkdir(path.join(outputDir, 'public', 'assets'), { recursive: true });
  await writeFile(path.join(outputDir, 'public', 'assets', 'bg.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(
    path.join(outputDir, 'game.js'),
    'document.querySelector("#play").dataset.ready="true";const bg="./public/assets/bg.png";',
  );
  await app.store.completeTask(task.id, {
    generatorMode: 'opengame',
    outputPath: path.join(outputDir, 'index.html'),
  });

  const response = await fetch(`${app.baseUrl}/api/projects/${created.project.id}/preview`, {
    headers: { 'x-project-token': created.token },
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<style data-ifplay-src="style\.css">#play\{color:red\}<\/style>/);
  assert.match(html, /<script data-ifplay-src="game\.js">document\.querySelector/);
  assert.match(html, /data:image\/png;base64,iVBORw==/);
  assert.doesNotMatch(html, /public\/assets\/bg\.png/);
  assert.doesNotMatch(html, /<script\s+src="game\.js"/);
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
