import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

function now() {
  return new Date().toISOString();
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function emptyStyleBoard() {
  return {
    status: 'not_started',
    imageUrl: null,
    provider: null,
    error: null,
    generatedAt: null,
  };
}

function createGameContract(proposal, styleProposal, styleId) {
  return {
    status: 'draft',
    proposalId: proposal.id,
    styleId,
    title: proposal.name,
    playerRole: proposal.playerRole,
    goal: proposal.goal,
    coreLoop: proposal.coreLoop,
    controls: proposal.controls,
    successCondition: proposal.successCondition,
    failureCondition: proposal.failureCondition,
    sessionLengthMinutes: proposal.sessionLengthMinutes,
    pace: proposal.pace,
    visualDirection: styleProposal.visualDirection,
    imageBudget: { used: 1, remaining: 2, maximum: 3 },
    excludedFeatures: proposal.simplifications,
    lockedFields: ['核心循环', '成功条件', '失败条件', '视觉方向'],
    flexibleFields: ['数值难度', '按钮尺寸', '反馈强度'],
    acceptanceCriteria: [
      '电脑和手机浏览器都能完成一轮核心玩法',
      '开始、成功、失败和重新开始状态清楚可见',
      '首版优先保证可玩，不增加未确认的系统',
    ],
    estimatedGenerationMinutes: 10,
    confirmedAt: null,
  };
}

export class ProjectStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.state = { projects: {}, tasks: {}, versions: {}, beta: this.emptyBetaState() };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    if (!this.state.beta) this.state.beta = this.emptyBetaState();
    this.state.beta.invites ??= {};
    this.state.beta.testers ??= {};
    this.state.beta.moderation ??= {};
    this.state.beta.playtests ??= [];
    this.state.beta.adminTokenHash ??= null;
  }

  emptyBetaState() {
    return { invites: {}, testers: {}, moderation: {}, playtests: [], adminTokenHash: null };
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      const temporaryFile = `${this.stateFile}.tmp`;
      await writeFile(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`);
      await rename(temporaryFile, this.stateFile);
    });
    return this.writeChain;
  }

  async createProject(idea, { testerId = null } = {}) {
    let tester = null;
    if (testerId) {
      tester = this.state.beta.testers[testerId];
      if (!tester || tester.status !== 'active') {
        throw new AppError('BETA_ACCESS_DENIED', '测试资格无效。', 403);
      }
      if (tester.projectCount >= tester.maxProjects) {
        throw new AppError('BETA_QUOTA_EXHAUSTED', '这个邀请码的项目额度已经用完。', 409);
      }
    }
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const createdAt = now();
    const project = {
      id,
      idea,
      tokenHash: tokenHash(token),
      betaTesterId: testerId,
      status: 'draft',
      currentVersionId: null,
      nextVersionNumber: 1,
      planning: {
        status: 'not_started',
        clarifications: [],
        pendingQuestion: null,
        proposals: [],
        selectedProposalId: null,
        styleBoard: emptyStyleBoard(),
        selectedStyleId: null,
        gameContract: null,
        provider: null,
        usageRecords: [],
        updatedAt: createdAt,
      },
      pendingChangePlan: null,
      feedbackUsageRecords: [],
      createdAt,
      updatedAt: createdAt,
    };
    this.state.projects[id] = project;
    this.state.versions[id] = [];
    if (tester) {
      tester.projectCount += 1;
      tester.updatedAt = createdAt;
    }
    await this.persist();
    return { project: this.publicProject(project), token };
  }

  getProject(id) {
    const project = this.state.projects[id];
    if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    if (!project.planning) {
      project.planning = {
        status: 'not_started',
        clarifications: [],
        pendingQuestion: null,
        proposals: [],
        selectedProposalId: null,
        provider: null,
        usageRecords: [],
        updatedAt: project.updatedAt ?? now(),
      };
    }
    if (!Object.hasOwn(project.planning, 'selectedProposalId')) {
      project.planning.selectedProposalId = null;
    }
    if (!project.planning.styleBoard) project.planning.styleBoard = emptyStyleBoard();
    if (!Object.hasOwn(project.planning, 'selectedStyleId')) {
      project.planning.selectedStyleId = null;
    }
    if (!Object.hasOwn(project.planning, 'gameContract')) {
      project.planning.gameContract = null;
    }
    if (!Array.isArray(project.planning.usageRecords)) {
      project.planning.usageRecords = project.planning.provider
        ? [{ ...project.planning.provider, kind: project.planning.status, recordedAt: project.planning.updatedAt }]
        : [];
    }
    if (!Object.hasOwn(project, 'pendingChangePlan')) project.pendingChangePlan = null;
    if (!Array.isArray(project.feedbackUsageRecords)) project.feedbackUsageRecords = [];
    return project;
  }

  authorizeProject(id, token) {
    const project = this.getProject(id);
    const expected = Buffer.from(project.tokenHash, 'hex');
    const actual = Buffer.from(token ? tokenHash(token) : '', 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AppError('PROJECT_ACCESS_DENIED', '项目凭证无效。', 403);
    }
    return project;
  }

  publicProject(project) {
    const { tokenHash: ignored, betaTesterId: ignoredTester, ...safeProject } = project;
    return safeProject;
  }

  async setupBeta({ count = 20, maxProjects = 3 } = {}) {
    if (Object.keys(this.state.beta.invites).length > 0 || Object.keys(this.state.beta.testers).length > 0) {
      throw new AppError('BETA_ALREADY_CONFIGURED', '邀请测试已经初始化，请从测试后台查看现有进度。', 409);
    }
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new AppError('INVITE_COUNT_INVALID', '邀请码数量必须是 1 到 20。');
    }
    if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 10) {
      throw new AppError('INVITE_QUOTA_INVALID', '每个邀请码的项目额度必须是 1 到 10。');
    }
    const adminToken = randomBytes(24).toString('base64url');
    this.state.beta.adminTokenHash = tokenHash(adminToken);
    const codes = [];
    for (let index = 0; index < count; index += 1) {
      const raw = randomBytes(6).toString('hex').toUpperCase();
      const code = `IFP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
      const id = randomUUID();
      this.state.beta.invites[id] = {
        id,
        codeHash: tokenHash(code),
        status: 'active',
        maxProjects,
        redeemedBy: null,
        createdAt: now(),
        redeemedAt: null,
      };
      codes.push(code);
    }
    await this.persist();
    return { adminToken, codes, maxProjects };
  }

  async createInvites(count, maxProjects) {
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new AppError('INVITE_COUNT_INVALID', '邀请码数量必须是 1 到 20。');
    }
    if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 10) {
      throw new AppError('INVITE_QUOTA_INVALID', '每个邀请码的项目额度必须是 1 到 10。');
    }
    const occupiedSeats = Object.values(this.state.beta.invites)
      .filter((item) => ['active', 'redeemed'].includes(item.status)).length;
    if (occupiedSeats + count > 20) {
      throw new AppError('BETA_CAPACITY_EXCEEDED', `本轮最多 20 位测试者，目前还可新增 ${Math.max(0, 20 - occupiedSeats)} 个邀请码。`, 409);
    }
    const codes = [];
    for (let index = 0; index < count; index += 1) {
      const raw = randomBytes(6).toString('hex').toUpperCase();
      const code = `IFP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
      const id = randomUUID();
      this.state.beta.invites[id] = {
        id,
        codeHash: tokenHash(code),
        status: 'active',
        maxProjects,
        redeemedBy: null,
        createdAt: now(),
        redeemedAt: null,
      };
      codes.push(code);
    }
    await this.persist();
    return { codes, maxProjects };
  }

  async redeemInvite(code) {
    const codeDigest = tokenHash(code.trim().toUpperCase());
    const invite = Object.values(this.state.beta.invites).find((item) => item.codeHash === codeDigest);
    if (!invite || invite.status !== 'active') {
      throw new AppError('INVITE_INVALID', '邀请码无效或已经使用。', 403);
    }
    const token = randomBytes(24).toString('base64url');
    const createdAt = now();
    const tester = {
      id: randomUUID(),
      inviteId: invite.id,
      tokenHash: tokenHash(token),
      status: 'active',
      projectCount: 0,
      maxProjects: invite.maxProjects,
      createdAt,
      updatedAt: createdAt,
    };
    this.state.beta.testers[tester.id] = tester;
    invite.status = 'redeemed';
    invite.redeemedBy = tester.id;
    invite.redeemedAt = createdAt;
    await this.persist();
    return { tester: this.publicTester(tester), token };
  }

  authorizeBeta(token) {
    const digest = token ? tokenHash(token) : '';
    const tester = Object.values(this.state.beta.testers).find((item) => item.tokenHash === digest);
    if (!tester || tester.status !== 'active') {
      throw new AppError('BETA_ACCESS_DENIED', '请先输入有效邀请码。', 403);
    }
    return tester;
  }

  authorizeAdmin(token) {
    const expectedHex = this.state.beta.adminTokenHash;
    const actualHex = token ? tokenHash(token) : '';
    if (!expectedHex) throw new AppError('BETA_ADMIN_NOT_CONFIGURED', '测试后台尚未初始化。', 503);
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AppError('BETA_ADMIN_ACCESS_DENIED', '测试后台凭证无效。', 403);
    }
  }

  publicTester(tester) {
    return {
      id: tester.id,
      status: tester.status,
      projectCount: tester.projectCount,
      maxProjects: tester.maxProjects,
      remainingProjects: Math.max(0, tester.maxProjects - tester.projectCount),
      createdAt: tester.createdAt,
    };
  }

  getBetaSummary() {
    const invites = Object.values(this.state.beta.invites);
    const testers = Object.values(this.state.beta.testers);
    const moderation = Object.values(this.state.beta.moderation);
    return {
      invites: {
        total: invites.length,
        active: invites.filter((item) => item.status === 'active').length,
        redeemed: invites.filter((item) => item.status === 'redeemed').length,
      },
      testers: testers.map((item) => this.publicTester(item)),
      projects: Object.values(this.state.projects).filter((project) => project.betaTesterId).length,
      moderation: moderation.map(({ text, ...item }) => ({ ...item, text })),
      playtests: this.state.beta.playtests,
    };
  }

  findApprovedModeration({ digest, kind, testerId = null, projectId = null }) {
    return Object.values(this.state.beta.moderation).some((item) =>
      item.digest === digest
      && item.kind === kind
      && item.status === 'approved'
      && item.testerId === testerId
      && item.projectId === projectId);
  }

  async recordModeration({ kind, text, result, testerId = null, projectId = null }) {
    const id = randomUUID();
    const createdAt = now();
    const item = {
      id,
      kind,
      text,
      digest: result.digest,
      decision: result.decision,
      reasons: result.reasons,
      status: result.decision === 'review' ? 'pending' : result.decision,
      testerId,
      projectId,
      createdAt,
      resolvedAt: null,
    };
    this.state.beta.moderation[id] = item;
    await this.persist();
    return item;
  }

  async resolveModeration(id, decision) {
    const item = this.state.beta.moderation[id];
    if (!item) throw new AppError('MODERATION_NOT_FOUND', '审核记录不存在。', 404);
    if (item.status !== 'pending') throw new AppError('MODERATION_ALREADY_RESOLVED', '审核记录已经处理。', 409);
    if (!['approved', 'rejected'].includes(decision)) {
      throw new AppError('MODERATION_DECISION_INVALID', '审核决定无效。');
    }
    item.status = decision;
    item.resolvedAt = now();
    await this.persist();
    return item;
  }

  async savePlaytest(projectId, input, testerId = null) {
    const project = this.getProject(projectId);
    const createdAt = now();
    const item = {
      id: randomUUID(),
      projectId,
      testerId: project.betaTesterId ?? testerId,
      outcome: input.outcome,
      rating: input.rating,
      notes: input.notes,
      device: input.device,
      createdAt,
    };
    this.state.beta.playtests.push(item);
    this.state.beta.playtests = this.state.beta.playtests.slice(-200);
    await this.persist();
    return item;
  }

  publicVersion(project, version) {
    return {
      id: version.id,
      projectId: version.projectId,
      number: version.number,
      parentVersionId: version.parentVersionId,
      summary: version.summary ?? (version.number === 1 ? '生成第一版' : '生成新版本'),
      generatorMode: version.generatorMode,
      restoredFromVersionId: version.restoredFromVersionId ?? null,
      testStatus: version.testStatus ?? 'not_recorded',
      costStatus: version.costStatus ?? 'unverified',
      costCny: Number.isFinite(version.costCny) ? version.costCny : null,
      isCurrent: project.currentVersionId === version.id,
      createdAt: version.createdAt,
    };
  }

  getPlanning(projectId) {
    return this.getProject(projectId).planning;
  }

  async answerPlanningQuestion(projectId, answer) {
    const project = this.getProject(projectId);
    const planning = project.planning;
    if (!planning.pendingQuestion) {
      throw new AppError('PLANNING_ANSWER_UNEXPECTED', '当前没有等待回答的玩法问题。', 409);
    }
    const answeredAt = now();
    planning.clarifications.push({
      questionId: planning.pendingQuestion.id,
      question: planning.pendingQuestion.text,
      answer,
      answeredAt,
    });
    planning.pendingQuestion = null;
    planning.status = 'clarifying';
    planning.updatedAt = answeredAt;
    project.status = 'clarifying';
    project.updatedAt = answeredAt;
    await this.persist();
    return planning;
  }

  async savePlanningResult(projectId, result) {
    const project = this.getProject(projectId);
    const planning = project.planning;
    const updatedAt = now();
    if (result.kind === 'question') {
      planning.status = 'clarifying';
      planning.pendingQuestion = result.question;
      planning.proposals = [];
      planning.selectedProposalId = null;
      planning.styleBoard = emptyStyleBoard();
      planning.selectedStyleId = null;
      planning.gameContract = null;
      project.status = 'clarifying';
    } else {
      planning.status = 'proposal_ready';
      planning.pendingQuestion = null;
      planning.proposals = result.proposals;
      planning.selectedProposalId = null;
      planning.styleBoard = emptyStyleBoard();
      planning.selectedStyleId = null;
      planning.gameContract = null;
      project.status = 'proposal_ready';
    }
    planning.provider = result.provider ?? null;
    if (result.provider) {
      planning.usageRecords.push({
        ...result.provider,
        kind: result.kind,
        recordedAt: updatedAt,
      });
      planning.usageRecords = planning.usageRecords.slice(-10);
    }
    planning.updatedAt = updatedAt;
    project.updatedAt = updatedAt;
    await this.persist();
    return planning;
  }

  async selectProposal(projectId, proposalId) {
    const project = this.getProject(projectId);
    const planning = project.planning;
    if (!['proposal_ready', 'proposal_selected'].includes(planning.status)) {
      throw new AppError('PROPOSALS_NOT_READY', '玩法提案尚未生成。', 409);
    }
    const proposal = planning.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new AppError('PROPOSAL_NOT_FOUND', '选择的玩法提案不存在。', 404);
    const updatedAt = now();
    if (planning.selectedProposalId !== proposal.id) {
      planning.selectedStyleId = null;
      planning.gameContract = null;
    }
    planning.status = 'proposal_selected';
    planning.selectedProposalId = proposal.id;
    planning.updatedAt = updatedAt;
    project.status = 'proposal_selected';
    project.updatedAt = updatedAt;
    await this.persist();
    return { planning, proposal };
  }

  async startStyleBoard(projectId) {
    const project = this.getProject(projectId);
    const planning = project.planning;
    if (!planning.selectedProposalId) {
      throw new AppError('PROPOSAL_REQUIRED', '请先确认一个玩法方向。', 409);
    }
    planning.styleBoard = {
      ...emptyStyleBoard(),
      status: 'generating',
    };
    planning.updatedAt = now();
    project.status = 'style_generating';
    project.updatedAt = planning.updatedAt;
    await this.persist();
    return planning.styleBoard;
  }

  async completeStyleBoard(projectId, provider, mimeType = 'image/png') {
    const project = this.getProject(projectId);
    const updatedAt = now();
    project.planning.styleBoard = {
      status: 'ready',
      imageUrl: `/api/projects/${projectId}/planning/style-board/image`,
      mimeType,
      provider,
      error: null,
      generatedAt: updatedAt,
    };
    project.planning.updatedAt = updatedAt;
    project.status = 'style_ready';
    project.updatedAt = updatedAt;
    await this.persist();
    return project.planning.styleBoard;
  }

  async failStyleBoard(projectId, error) {
    const project = this.getProject(projectId);
    const updatedAt = now();
    project.planning.styleBoard = {
      ...emptyStyleBoard(),
      status: 'failed',
      error: { code: error.code ?? 'STYLE_BOARD_FAILED', message: error.message },
    };
    project.planning.updatedAt = updatedAt;
    project.status = 'proposal_selected';
    project.updatedAt = updatedAt;
    await this.persist();
  }

  async selectStyle(projectId, styleId) {
    const project = this.getProject(projectId);
    const planning = project.planning;
    if (planning.styleBoard.status !== 'ready') {
      throw new AppError('STYLE_BOARD_NOT_READY', '参考风格板尚未生成。', 409);
    }
    const styleIndex = { 'style-a': 0, 'style-b': 1, 'style-c': 2 }[styleId];
    const proposal = planning.proposals.find((item) => item.id === planning.selectedProposalId);
    const styleProposal = planning.proposals[styleIndex];
    if (!proposal || !styleProposal) {
      throw new AppError('STYLE_NOT_FOUND', '选择的画面方向不存在。', 404);
    }
    const updatedAt = now();
    planning.selectedStyleId = styleId;
    planning.gameContract = createGameContract(proposal, styleProposal, styleId);
    planning.updatedAt = updatedAt;
    project.status = 'contract_draft';
    project.updatedAt = updatedAt;
    await this.persist();
    return planning;
  }

  async confirmGameContract(projectId) {
    const project = this.getProject(projectId);
    const planning = project.planning;
    if (!planning.gameContract || !planning.selectedStyleId) {
      throw new AppError('GAME_CONTRACT_NOT_READY', '请先选择画面方向。', 409);
    }
    const updatedAt = now();
    planning.gameContract.status = 'confirmed';
    planning.gameContract.confirmedAt = updatedAt;
    planning.updatedAt = updatedAt;
    project.status = 'ready_to_generate';
    project.updatedAt = updatedAt;
    await this.persist();
    return planning;
  }

  async saveFeedbackPlan(projectId, feedback, presetCategory, analysis) {
    const project = this.getProject(projectId);
    if (!project.currentVersionId) {
      throw new AppError('PLAYABLE_VERSION_REQUIRED', '项目还没有可以修改的试玩版本。', 409);
    }
    const createdAt = now();
    const plan = {
      id: randomUUID(),
      feedback,
      presetCategory,
      summary: analysis.summary,
      category: analysis.category,
      changes: analysis.changes,
      preserved: analysis.preserved,
      touchesContract: analysis.touchesContract,
      touchedFields: analysis.touchedFields,
      instruction: analysis.instruction,
      estimatedCost: analysis.estimatedCost,
      status: 'awaiting_confirmation',
      createdAt,
      confirmedAt: null,
      appliedAt: null,
      error: null,
    };
    project.pendingChangePlan = plan;
    if (analysis.provider) {
      project.feedbackUsageRecords.push({
        ...analysis.provider,
        kind: 'feedback_analysis',
        recordedAt: createdAt,
      });
      project.feedbackUsageRecords = project.feedbackUsageRecords.slice(-10);
    }
    project.status = 'change_plan_ready';
    project.updatedAt = createdAt;
    await this.persist();
    return plan;
  }

  async confirmFeedbackPlan(projectId, planId) {
    const project = this.getProject(projectId);
    const plan = project.pendingChangePlan;
    if (!plan || plan.id !== planId) {
      throw new AppError('CHANGE_PLAN_NOT_FOUND', '这份修改计划已经失效，请重新整理反馈。', 409);
    }
    if (plan.status !== 'awaiting_confirmation') {
      throw new AppError('CHANGE_PLAN_ALREADY_USED', '这份修改计划已经提交过。', 409);
    }
    const confirmedAt = now();
    plan.status = 'confirmed';
    plan.confirmedAt = confirmedAt;
    if (plan.touchesContract && project.planning?.gameContract) {
      const amendments = Array.isArray(project.planning.gameContract.amendments)
        ? project.planning.gameContract.amendments
        : [];
      amendments.push({
        planId: plan.id,
        summary: plan.summary,
        feedback: plan.feedback,
        touchedFields: plan.touchedFields,
        confirmedAt,
      });
      project.planning.gameContract.amendments = amendments.slice(-10);
      project.planning.gameContract.confirmedAt = confirmedAt;
    }
    project.updatedAt = confirmedAt;
    await this.persist();
    return plan;
  }

  async createTask(projectId, kind, instruction, metadata = {}) {
    const id = randomUUID();
    const createdAt = now();
    const task = {
      id,
      projectId,
      kind,
      instruction,
      status: 'queued',
      stage: 'queued',
      error: null,
      versionId: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      changePlanId: metadata.changePlanId ?? null,
      summary: metadata.summary ?? null,
    };
    this.state.tasks[id] = task;
    const project = this.getProject(projectId);
    if (task.changePlanId && project.pendingChangePlan?.id === task.changePlanId) {
      project.pendingChangePlan.status = 'generating';
    }
    project.status = 'generating';
    project.updatedAt = createdAt;
    await this.persist();
    return task;
  }

  hasActiveTask(projectId) {
    return Object.values(this.state.tasks).some(
      (task) => task.projectId === projectId && ['queued', 'running'].includes(task.status),
    );
  }

  getTask(id) {
    const task = this.state.tasks[id];
    if (!task) throw new AppError('TASK_NOT_FOUND', '任务不存在。', 404);
    return task;
  }

  async updateTask(id, patch) {
    const task = this.getTask(id);
    Object.assign(task, patch, { updatedAt: now() });
    await this.persist();
    return task;
  }

  listVersions(projectId) {
    this.getProject(projectId);
    return this.state.versions[projectId] ?? [];
  }

  getVersion(projectId, versionId) {
    const version = this.listVersions(projectId).find((item) => item.id === versionId);
    if (!version) throw new AppError('VERSION_NOT_FOUND', '游戏版本不存在。', 404);
    return version;
  }

  async restoreVersion(projectId, versionId) {
    const project = this.getProject(projectId);
    const target = this.getVersion(projectId, versionId);
    const versions = this.listVersions(projectId);
    const current = versions.find((item) => item.id === project.currentVersionId);
    if (current?.outputPath === target.outputPath) {
      throw new AppError('VERSION_ALREADY_CURRENT', '这个版本已经是当前试玩内容。', 409);
    }
    const createdAt = now();
    const restored = {
      id: randomUUID(),
      projectId,
      number: project.nextVersionNumber ?? versions.length + 1,
      parentVersionId: project.currentVersionId,
      instruction: `恢复自 v${target.number}`,
      summary: `恢复到 v${target.number}：${target.summary ?? '历史可玩版本'}`,
      generatorMode: target.generatorMode,
      outputPath: target.outputPath,
      restoredFromVersionId: target.id,
      testStatus: target.testStatus ?? 'not_recorded',
      costStatus: 'no_model_call',
      costCny: 0,
      createdAt,
    };
    versions.push(restored);
    this.state.versions[projectId] = versions.slice(-10);
    project.nextVersionNumber = restored.number + 1;
    project.currentVersionId = restored.id;
    project.status = 'playable';
    project.updatedAt = createdAt;
    await this.persist();
    return restored;
  }

  async completeTask(taskId, output) {
    const task = this.getTask(taskId);
    const project = this.getProject(task.projectId);
    const versions = this.state.versions[project.id] ?? [];
    const version = {
      id: randomUUID(),
      projectId: project.id,
      number: project.nextVersionNumber ?? versions.length + 1,
      parentVersionId: project.currentVersionId,
      instruction: task.instruction,
      summary: task.summary ?? (task.kind === 'initial' ? '生成第一版' : '生成新版本'),
      generatorMode: output.generatorMode,
      outputPath: output.outputPath,
      restoredFromVersionId: null,
      testStatus: 'not_recorded',
      costStatus: 'unverified',
      costCny: null,
      createdAt: now(),
    };
    versions.push(version);
    this.state.versions[project.id] = versions.slice(-10);
    project.nextVersionNumber = version.number + 1;
    project.currentVersionId = version.id;
    project.status = 'playable';
    project.updatedAt = now();
    Object.assign(task, {
      status: 'succeeded',
      stage: 'completed',
      versionId: version.id,
      finishedAt: now(),
      updatedAt: now(),
    });
    if (task.changePlanId && project.pendingChangePlan?.id === task.changePlanId) {
      project.pendingChangePlan.status = 'applied';
      project.pendingChangePlan.appliedAt = now();
    }
    await this.persist();
    return version;
  }

  async failTask(taskId, error) {
    const task = this.getTask(taskId);
    const project = this.getProject(task.projectId);
    Object.assign(task, {
      status: 'failed',
      stage: 'failed',
      error: { code: error.code ?? 'GENERATION_FAILED', message: error.message },
      finishedAt: now(),
      updatedAt: now(),
    });
    project.status = project.currentVersionId ? 'playable' : 'failed';
    if (task.changePlanId && project.pendingChangePlan?.id === task.changePlanId) {
      project.pendingChangePlan.status = 'failed';
      project.pendingChangePlan.error = {
        code: error.code ?? 'GENERATION_FAILED',
        message: error.message,
      };
    }
    project.updatedAt = now();
    await this.persist();
  }
}
