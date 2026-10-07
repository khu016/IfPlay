import { createServer } from 'node:http';
import path from 'node:path';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppError, errorBody } from './lib/errors.mjs';
import { generateGame } from './lib/generator.mjs';
import { analyzeFeedback } from './lib/feedback.mjs';
import { planGame } from './lib/planner.mjs';
import { TaskQueue } from './lib/queue.mjs';
import { ProjectStore } from './lib/store.mjs';
import { generateStyleBoard } from './lib/style-board.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/tokens.css', [path.join('..', 'tokens.css'), 'text/css; charset=utf-8']],
]);

function isLocalAsset(reference) {
  return !/^(?:[a-z]+:|\/\/|\/|#)/i.test(reference);
}

function resolveVersionAsset(versionRoot, reference) {
  const resolved = path.resolve(versionRoot, reference.split(/[?#]/, 1)[0]);
  if (resolved !== versionRoot && !resolved.startsWith(`${versionRoot}${path.sep}`)) {
    throw new AppError('PREVIEW_ASSET_INVALID', '试玩资源路径越出了当前版本目录。', 422);
  }
  return resolved;
}

async function replaceAsync(value, expression, replacer) {
  const matches = [...value.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacer(match)));
  let cursor = 0;
  let result = '';
  matches.forEach((match, index) => {
    result += value.slice(cursor, match.index) + replacements[index];
    cursor = match.index + match[0].length;
  });
  return result + value.slice(cursor);
}

const previewAssetTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

async function collectPreviewAssets(directory, versionRoot, assets = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectPreviewAssets(absolutePath, versionRoot, assets);
      continue;
    }
    const mimeType = previewAssetTypes.get(path.extname(entry.name).toLowerCase());
    if (!mimeType) continue;
    const body = await readFile(absolutePath);
    if (body.length > 5 * 1024 * 1024) {
      throw new AppError('PREVIEW_ASSET_TOO_LARGE', '单个试玩资源不能超过 5MB。', 422);
    }
    assets.push({
      reference: path.relative(versionRoot, absolutePath).split(path.sep).join('/'),
      dataUri: `data:${mimeType};base64,${body.toString('base64')}`,
      size: body.length,
    });
  }
  return assets;
}

async function inlinePreviewAssets(html, versionRoot) {
  const assets = await collectPreviewAssets(versionRoot, versionRoot);
  const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0);
  if (totalSize > 15 * 1024 * 1024) {
    throw new AppError('PREVIEW_ASSETS_TOO_LARGE', '试玩资源总大小不能超过 15MB。', 422);
  }
  const replacements = assets
    .flatMap((asset) => [
      { reference: `./${asset.reference}`, dataUri: asset.dataUri },
      { reference: asset.reference, dataUri: asset.dataUri },
    ])
    .sort((left, right) => right.reference.length - left.reference.length);
  return replacements.reduce(
    (result, asset) => result.replaceAll(asset.reference, asset.dataUri),
    html,
  );
}

async function buildPreviewHtml(outputPath) {
  const versionRoot = path.dirname(outputPath);
  let html = await readFile(outputPath, 'utf8');
  html = await replaceAsync(
    html,
    /<link\b([^>]*?)\bhref=["']([^"']+)["']([^>]*)>/gi,
    async (match) => {
      if (!/\brel=["']stylesheet["']/i.test(match[0]) || !isLocalAsset(match[2])) return match[0];
      const css = await readFile(resolveVersionAsset(versionRoot, match[2]), 'utf8');
      return `<style data-ifplay-src="${match[2]}">${css.replaceAll('</style', '<\\/style')}</style>`;
    },
  );
  html = await replaceAsync(
    html,
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    async (match) => {
      if (!isLocalAsset(match[2])) return match[0];
      const script = await readFile(resolveVersionAsset(versionRoot, match[2]), 'utf8');
      return `<script data-ifplay-src="${match[2]}">${script.replaceAll('</script', '<\\/script')}</script>`;
    },
  );
  return inlinePreviewAssets(html, versionRoot);
}

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

function gameContractInstruction(contract) {
  return [
    `严格按照已确认的玩法合同“${contract.title}”生成第一版。`,
    `玩家身份：${contract.playerRole}`,
    `目标：${contract.goal}`,
    `核心循环：${contract.coreLoop.join(' → ')}`,
    `操作：${contract.controls}`,
    `成功条件：${contract.successCondition}`,
    `失败条件：${contract.failureCondition}`,
    `单局时长：${contract.sessionLengthMinutes} 分钟。节奏：${contract.pace}。`,
    `视觉方向：${contract.visualDirection}`,
    `首版排除或简化：${contract.excludedFeatures.join('；')}`,
    `锁定项：${contract.lockedFields.join('、')}。不得擅自改变。`,
    `可调整项：${contract.flexibleFields.join('、')}。`,
    `验收标准：${contract.acceptanceCriteria.join('；')}`,
    `总图片预算最多 ${contract.imageBudget.maximum} 张，参考风格板已使用 ${contract.imageBudget.used} 张。`,
    '不得增加合同中未确认的系统。',
  ].join('\n');
}

function changePlanInstruction(plan) {
  return [
    `执行已经由用户确认的定向修改：“${plan.summary}”。`,
    plan.instruction,
    `只允许改变：${plan.changes.join('；')}`,
    `必须保持不变：${plan.preserved.join('；')}`,
    plan.touchesContract
      ? `用户已再次确认修改玩法合同字段：${plan.touchedFields.join('、')}。`
      : '本次不改变玩法合同中的核心循环、结束条件和整体视觉方向。',
    '基于当前可玩版本修改，不要重做整个项目。',
  ].join('\n');
}

export async function createIfPlayApp(options = {}) {
  const dataDir = options.dataDir ?? process.env.IFPLAY_DATA_DIR ?? '.data';
  const store = new ProjectStore(dataDir);
  await store.init();
  const planner = options.planner ?? planGame;
  const styleBoardGenerator = options.styleBoardGenerator ?? generateStyleBoard;
  const feedbackAnalyzer = options.feedbackAnalyzer ?? analyzeFeedback;
  const planningProjects = new Set();
  const styleBoardProjects = new Set();
  const feedbackProjects = new Set();
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

      const planningMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/planning$/);
      if (request.method === 'GET' && planningMatch) {
        const project = store.authorizeProject(planningMatch[1], token(request));
        return sendJson(response, 200, { planning: project.planning });
      }

      if (request.method === 'POST' && planningMatch) {
        const project = store.authorizeProject(planningMatch[1], token(request));
        if (planningProjects.has(project.id)) {
          throw new AppError('PLANNING_BUSY', 'AI 正在整理玩法，请稍后再试。', 409);
        }
        planningProjects.add(project.id);
        try {
          const body = await readJson(request);
          const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
          let planning = store.getPlanning(project.id);
          if (['proposal_ready', 'proposal_selected'].includes(planning.status)) {
            if (answer) throw new AppError('PLANNING_ALREADY_COMPLETE', '三个玩法提案已经生成。', 409);
            return sendJson(response, 200, { planning });
          }
          if (planning.pendingQuestion) {
            if (!answer) return sendJson(response, 200, { planning });
            if (answer.length > 1000) {
              throw new AppError('PLANNING_ANSWER_INVALID', '回答不能超过 1000 个字符。');
            }
            planning = await store.answerPlanningQuestion(project.id, answer);
          } else if (answer) {
            throw new AppError('PLANNING_ANSWER_UNEXPECTED', '当前没有等待回答的玩法问题。', 409);
          }

          const result = await planner({
            idea: project.idea,
            clarifications: planning.clarifications,
            questionCount: planning.clarifications.length,
            mustPropose: planning.clarifications.length >= 3,
          });
          planning = await store.savePlanningResult(project.id, result);
          return sendJson(response, 200, { planning });
        } finally {
          planningProjects.delete(project.id);
        }
      }

      const selectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/planning\/selection$/);
      if (request.method === 'POST' && selectionMatch) {
        const project = store.authorizeProject(selectionMatch[1], token(request));
        const body = await readJson(request);
        const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : '';
        if (!/^proposal-[a-c]$/.test(proposalId)) {
          throw new AppError('PROPOSAL_ID_INVALID', '请选择一个有效的玩法提案。');
        }
        const selected = await store.selectProposal(project.id, proposalId);
        return sendJson(response, 200, selected);
      }

      const styleBoardMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/planning\/style-board$/);
      if (request.method === 'POST' && styleBoardMatch) {
        const project = store.authorizeProject(styleBoardMatch[1], token(request));
        const planning = store.getPlanning(project.id);
        if (planning.styleBoard.status === 'ready') {
          return sendJson(response, 200, { planning });
        }
        if (styleBoardProjects.has(project.id)) {
          throw new AppError('STYLE_BOARD_BUSY', 'AI 正在生成参考图，请稍后再试。', 409);
        }
        styleBoardProjects.add(project.id);
        try {
          await store.startStyleBoard(project.id);
          const output = await styleBoardGenerator({ proposals: planning.proposals });
          const outputDir = path.join(store.dataDir, 'projects', project.id, 'planning');
          await mkdir(outputDir, { recursive: true });
          await writeFile(path.join(outputDir, 'style-board.image'), output.buffer);
          await store.completeStyleBoard(project.id, output.provider, output.contentType);
          return sendJson(response, 200, { planning: store.getPlanning(project.id) });
        } catch (error) {
          await store.failStyleBoard(project.id, error);
          throw error;
        } finally {
          styleBoardProjects.delete(project.id);
        }
      }

      const styleBoardImageMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/planning\/style-board\/image$/,
      );
      if (request.method === 'GET' && styleBoardImageMatch) {
        const project = store.authorizeProject(styleBoardImageMatch[1], token(request));
        if (project.planning.styleBoard.status !== 'ready') {
          throw new AppError('STYLE_BOARD_NOT_READY', '参考风格板尚未生成。', 409);
        }
        const body = await readFile(
          path.join(store.dataDir, 'projects', project.id, 'planning', 'style-board.image'),
        );
        response.writeHead(200, {
          'content-type': project.planning.styleBoard.mimeType ?? 'image/png',
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(body);
      }

      const styleSelectionMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/planning\/style-selection$/,
      );
      if (request.method === 'POST' && styleSelectionMatch) {
        const project = store.authorizeProject(styleSelectionMatch[1], token(request));
        const body = await readJson(request);
        const styleId = typeof body.styleId === 'string' ? body.styleId.trim() : '';
        if (!/^style-[a-c]$/.test(styleId)) {
          throw new AppError('STYLE_ID_INVALID', '请选择一个有效的画面方向。');
        }
        const planning = await store.selectStyle(project.id, styleId);
        return sendJson(response, 200, { planning });
      }

      const contractMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/planning\/contract\/confirm$/,
      );
      if (request.method === 'POST' && contractMatch) {
        const project = store.authorizeProject(contractMatch[1], token(request));
        const planning = await store.confirmGameContract(project.id);
        return sendJson(response, 200, { planning });
      }

      const feedbackPreviewMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/feedback\/preview$/,
      );
      if (request.method === 'POST' && feedbackPreviewMatch) {
        const project = store.authorizeProject(feedbackPreviewMatch[1], token(request));
        if (!project.currentVersionId) {
          throw new AppError('PLAYABLE_VERSION_REQUIRED', '项目还没有可以修改的试玩版本。', 409);
        }
        if (store.hasActiveTask(project.id)) {
          throw new AppError('PROJECT_BUSY', '当前项目正在生成，请完成后再整理修改。', 409);
        }
        if (feedbackProjects.has(project.id)) {
          throw new AppError('FEEDBACK_BUSY', 'AI 正在整理这次修改，请稍后再试。', 409);
        }
        const body = await readJson(request);
        const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
        const presetCategory = typeof body.category === 'string' ? body.category.trim() : 'custom';
        if (feedback.length < 2 || feedback.length > 1000) {
          throw new AppError('FEEDBACK_INVALID', '试玩反馈需要 2 到 1000 个字符。');
        }
        if (!['visual', 'pace', 'controls', 'rules', 'feedback', 'custom'].includes(presetCategory)) {
          throw new AppError('FEEDBACK_CATEGORY_INVALID', '试玩反馈分类无效。');
        }
        feedbackProjects.add(project.id);
        try {
          const analysis = await feedbackAnalyzer({
            feedback,
            presetCategory,
            project: store.publicProject(project),
            contract: project.planning?.gameContract ?? null,
          });
          const plan = await store.saveFeedbackPlan(project.id, feedback, presetCategory, analysis);
          return sendJson(response, 200, { plan });
        } finally {
          feedbackProjects.delete(project.id);
        }
      }

      const feedbackConfirmMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/feedback\/confirm$/,
      );
      if (request.method === 'POST' && feedbackConfirmMatch) {
        const project = store.authorizeProject(feedbackConfirmMatch[1], token(request));
        if (store.hasActiveTask(project.id)) {
          throw new AppError('PROJECT_BUSY', '当前项目已有生成任务，请等待完成后再修改。', 409);
        }
        const body = await readJson(request);
        const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
        if (!planId) throw new AppError('CHANGE_PLAN_ID_INVALID', '修改计划编号无效。');
        const plan = await store.confirmFeedbackPlan(project.id, planId);
        const task = await store.createTask(
          project.id,
          'modify',
          changePlanInstruction(plan),
          { changePlanId: plan.id, summary: plan.summary },
        );
        queue.add(task);
        return sendJson(response, 202, { task, plan });
      }

      const generationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generations$/);
      if (request.method === 'POST' && generationMatch) {
        const project = store.authorizeProject(generationMatch[1], token(request));
        if (store.hasActiveTask(project.id)) {
          throw new AppError('PROJECT_BUSY', '当前项目已有生成任务，请等待完成后再修改。', 409);
        }
        const body = await readJson(request);
        let instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
        if (!project.currentVersionId && project.planning?.proposals?.length > 0) {
          if (project.planning.gameContract?.status !== 'confirmed') {
            throw new AppError('GAME_CONTRACT_REQUIRED', '请先确认玩法合同，再生成游戏。', 409);
          }
          instruction = gameContractInstruction(project.planning.gameContract);
        }
        if (instruction.length < 2 || instruction.length > 2000) {
          throw new AppError('INSTRUCTION_INVALID', '生成要求需要 2 到 2000 个字符。');
        }
        const kind = project.currentVersionId ? 'modify' : 'initial';
        const task = await store.createTask(project.id, kind, instruction, {
          summary: kind === 'initial' ? '生成第一版' : instruction.slice(0, 120),
        });
        queue.add(task);
        return sendJson(response, 202, { task });
      }

      const versionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/versions$/);
      if (request.method === 'GET' && versionsMatch) {
        const project = store.authorizeProject(versionsMatch[1], token(request));
        const versions = store.listVersions(project.id).map((version) =>
          store.publicVersion(project, version),
        );
        return sendJson(response, 200, { versions });
      }

      const versionPreviewMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/versions\/([^/]+)\/preview$/,
      );
      if (request.method === 'GET' && versionPreviewMatch) {
        const project = store.authorizeProject(versionPreviewMatch[1], token(request));
        const version = store.getVersion(project.id, versionPreviewMatch[2]);
        const html = await buildPreviewHtml(version.outputPath);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
        });
        return response.end(html);
      }

      const versionRestoreMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/versions\/([^/]+)\/restore$/,
      );
      if (request.method === 'POST' && versionRestoreMatch) {
        const project = store.authorizeProject(versionRestoreMatch[1], token(request));
        if (store.hasActiveTask(project.id)) {
          throw new AppError('PROJECT_BUSY', '当前项目正在生成，完成后才能恢复版本。', 409);
        }
        const version = await store.restoreVersion(project.id, versionRestoreMatch[2]);
        return sendJson(response, 201, { version: store.publicVersion(project, version) });
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
        const version = project.currentVersionId
          ? store.getVersion(project.id, project.currentVersionId)
          : null;
        if (!version) throw new AppError('VERSION_NOT_READY', '项目还没有可试玩版本。', 409);
        const html = await buildPreviewHtml(version.outputPath);
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
