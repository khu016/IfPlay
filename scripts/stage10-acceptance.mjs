import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIfPlayApp } from '../src/app.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(projectRoot, '.data', 'stage10-acceptance');
const accessFile = path.join(dataDir, 'access.json');
const reportFile = path.join(dataDir, 'report.json');

const scenarios = [
  {
    id: 'management',
    category: '经营与资源管理',
    idea: '做一个深夜便利店经营游戏。玩家在两分钟内接待顾客，根据需求拖拽商品到柜台，兼顾库存和满意度；成功条件是达到目标营业额，失败条件是满意度归零。电脑鼠标和手机触控都能玩。',
  },
  {
    id: 'rhythm',
    category: '点击时机与节奏判定',
    idea: '做一个单键节奏游戏。玩家根据雨滴落到水面的一瞬点击打拍子，连续命中积累连击，漏拍过多失败，单局约一分钟；支持鼠标、空格键和触控。',
  },
  {
    id: 'dodge',
    category: '躲避、平台跳跃和轻量闯关',
    idea: '做一个纸飞机穿越雨夜城市的躲避闯关游戏。玩家按住上升、松开下降，收集星光并避开雨滴和招牌，两分钟内到达终点成功，碰撞三次失败；支持触控和键盘。',
  },
  {
    id: 'merge',
    category: '拖拽、合成和简单解谜',
    idea: '做一个拖拽合成小游戏。玩家把相同的梦境碎片拖到一起升级，在有限格子内合成指定目标；格子占满失败，完成目标成功，单局两到三分钟；手机和电脑都能玩。',
  },
  {
    id: 'narrative',
    category: '剧情选择、数值成长和随机事件',
    idea: '做一个太空电台剧情经营游戏。玩家每轮从三条回复中选择一条，同时管理电量和听众信任；三分钟内完成五次播报并保住电量成功，信任或电量归零失败；支持点击和触控。',
  },
];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function stamp(report, id, patch) {
  report.scenarios[id] = {
    ...report.scenarios[id],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

async function directoryStats(root) {
  let bytes = 0;
  let files = 0;
  let images = 0;
  const names = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else {
        const details = await stat(absolute);
        files += 1;
        bytes += details.size;
        const relative = path.relative(root, absolute);
        names.push(relative);
        if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(entry.name)) images += 1;
      }
    }
  }
  await visit(root);
  return { bytes, files, images, names: names.sort() };
}

function chooseProposal(proposals) {
  return proposals.find((proposal) => proposal.implementationRisk === 'low') ?? proposals[0];
}

function styleIdForProposal(proposal) {
  return `style-${proposal.id.slice(-1)}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  process.env.IFPLAY_GENERATOR_MODE = 'opengame';
  process.env.IFPLAY_MAX_CONCURRENT_TASKS = '2';
  await mkdir(dataDir, { recursive: true });
  const access = await readJson(accessFile, {});
  const report = await readJson(reportFile, {
    stage: 10,
    startedAt: new Date().toISOString(),
    concurrency: 2,
    target: '至少 4/5 通过完整主链路和浏览器试玩验收',
    scenarios: {},
  });
  const app = await createIfPlayApp({ dataDir, concurrency: 2 });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(route, token, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { 'x-project-token': token } : {}),
        ...options.headers,
      },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const message = typeof payload === 'string' ? payload : payload.error?.message;
      const error = new Error(`${response.status} ${message || '请求失败'}`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function runScenario(scenario) {
    console.log(`[${scenario.id}] 开始：${scenario.category}`);
    try {
      if (!access[scenario.id]) {
        const created = await request('/api/projects', null, {
          method: 'POST',
          body: JSON.stringify({ idea: scenario.idea }),
        });
        access[scenario.id] = { projectId: created.project.id, token: created.token };
        await saveJson(accessFile, access);
      }
      const credentials = access[scenario.id];
      let { project } = await request(`/api/projects/${credentials.projectId}`, credentials.token);
      stamp(report, scenario.id, {
        category: scenario.category,
        idea: scenario.idea,
        projectId: credentials.projectId,
        status: 'planning',
        error: null,
      });
      await saveJson(reportFile, report);

      let planning = project.planning;
      for (let index = 0; !['proposal_ready', 'proposal_selected'].includes(planning.status); index += 1) {
        if (index >= 5) throw new Error('玩法策划超过允许轮数');
        const answer = planning.pendingQuestion ? planning.pendingQuestion.options[0] : undefined;
        ({ planning } = await request(
          `/api/projects/${credentials.projectId}/planning`,
          credentials.token,
          { method: 'POST', body: JSON.stringify(answer ? { answer } : {}) },
        ));
      }

      let proposal = planning.proposals.find((item) => item.id === planning.selectedProposalId);
      if (!proposal) {
        proposal = chooseProposal(planning.proposals);
        ({ planning } = await request(
          `/api/projects/${credentials.projectId}/planning/selection`,
          credentials.token,
          { method: 'POST', body: JSON.stringify({ proposalId: proposal.id }) },
        ));
      }
      stamp(report, scenario.id, {
        status: 'style_board',
        clarificationCount: planning.clarifications.length,
        selectedProposal: { id: proposal.id, name: proposal.name, risk: proposal.implementationRisk },
      });
      await saveJson(reportFile, report);

      if (planning.styleBoard.status !== 'ready') {
        ({ planning } = await request(
          `/api/projects/${credentials.projectId}/planning/style-board`,
          credentials.token,
          { method: 'POST', body: '{}' },
        ));
      }
      if (!planning.selectedStyleId) {
        ({ planning } = await request(
          `/api/projects/${credentials.projectId}/planning/style-selection`,
          credentials.token,
          { method: 'POST', body: JSON.stringify({ styleId: styleIdForProposal(proposal) }) },
        ));
      }
      if (planning.gameContract?.status !== 'confirmed') {
        ({ planning } = await request(
          `/api/projects/${credentials.projectId}/planning/contract/confirm`,
          credentials.token,
          { method: 'POST', body: '{}' },
        ));
      }
      stamp(report, scenario.id, {
        status: 'generating',
        styleBoard: {
          status: planning.styleBoard.status,
          provider: planning.styleBoard.provider,
          selectedStyleId: planning.selectedStyleId,
        },
        contract: {
          status: planning.gameContract.status,
          title: planning.gameContract.title,
          imageBudget: planning.gameContract.imageBudget,
        },
      });
      await saveJson(reportFile, report);

      ({ project } = await request(`/api/projects/${credentials.projectId}`, credentials.token));
      let taskId = access[scenario.id].taskId;
      if (!project.currentVersionId && !taskId) {
        const result = await request(
          `/api/projects/${credentials.projectId}/generations`,
          credentials.token,
          { method: 'POST', body: JSON.stringify({ instruction: '按已确认的玩法合同生成首版。' }) },
        );
        taskId = result.task.id;
        access[scenario.id].taskId = taskId;
        await saveJson(accessFile, access);
      }

      if (!project.currentVersionId) {
        const deadline = Date.now() + 11 * 60 * 1000;
        while (Date.now() < deadline) {
          const result = await request(`/api/tasks/${taskId}`, credentials.token);
          stamp(report, scenario.id, { taskId, taskStatus: result.task.status, taskStage: result.task.stage });
          await saveJson(reportFile, report);
          if (result.task.status === 'failed') {
            throw new Error(`${result.task.error?.code}: ${result.task.error?.message}`);
          }
          if (result.task.status === 'succeeded') break;
          await wait(5000);
        }
      }

      ({ project } = await request(`/api/projects/${credentials.projectId}`, credentials.token));
      if (!project.currentVersionId) throw new Error('游戏生成超时或没有产生版本');
      const versionsResult = await request(`/api/projects/${credentials.projectId}/versions`, credentials.token);
      const current = versionsResult.versions.find((item) => item.id === project.currentVersionId);
      const internalVersion = app.store.getVersion(credentials.projectId, project.currentVersionId);
      const preview = await request(`/api/projects/${credentials.projectId}/preview`, credentials.token);
      const outputRoot = path.dirname(internalVersion.outputPath);
      const output = await directoryStats(outputRoot);
      const rawHtml = await readFile(internalVersion.outputPath, 'utf8');
      const sourceFiles = output.names.filter((name) => /\.(?:css|html?|js|mjs)$/i.test(name));
      const source = (await Promise.all(
        sourceFiles.map((name) => readFile(path.join(outputRoot, name), 'utf8')),
      )).join('\n');
      const checks = {
        previewHttpOk: typeof preview === 'string' && preview.length >= 500,
        hasViewport: /name=["']viewport["']/i.test(rawHtml),
        hasInteractionCode: /(?:addEventListener|onclick|ontouch|pointer)/i.test(source),
        hasRestartOrStart: /(?:开始|重新|再来|start|restart|play)/i.test(source),
        noRemoteAssets: !/(?:src|href)=["']https?:\/\//i.test(source),
        outputUnder15Mb: output.bytes <= 15 * 1024 * 1024,
      };
      const automatedPassed = Object.values(checks).every(Boolean);
      const previousBrowserPlaytest = report.scenarios[scenario.id]?.browserPlaytest;
      const browserPassed = previousBrowserPlaytest?.status === 'passed';
      stamp(report, scenario.id, {
        status: automatedPassed
          ? (browserPassed ? 'passed' : 'awaiting_browser_playtest')
          : 'automated_checks_failed',
        taskStatus: 'succeeded',
        version: current,
        outputPath: internalVersion.outputPath,
        output,
        checks,
        automatedPassed,
        browserPlaytest: browserPassed ? previousBrowserPlaytest : { status: 'pending' },
      });
      await saveJson(reportFile, report);
      console.log(`[${scenario.id}] ${automatedPassed ? '自动检查通过' : '自动检查未通过'}：${internalVersion.outputPath}`);
    } catch (error) {
      stamp(report, scenario.id, {
        status: 'failed',
        error: error.message,
        automatedPassed: false,
        browserPlaytest: { status: 'not_run' },
      });
      await saveJson(reportFile, report);
      console.error(`[${scenario.id}] 失败：${error.message}`);
    }
  }

  try {
    for (let index = 0; index < scenarios.length; index += 2) {
      await Promise.all(scenarios.slice(index, index + 2).map(runScenario));
    }
    report.automatedCompletedAt = new Date().toISOString();
    report.automatedPassed = scenarios.filter((scenario) => report.scenarios[scenario.id]?.automatedPassed).length;
    await saveJson(reportFile, report);
    console.log(`Stage 10 自动检查完成：${report.automatedPassed}/5，通过后还需浏览器试玩。`);
    console.log(`报告：${reportFile}`);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}

await main();
