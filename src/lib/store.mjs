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

export class ProjectStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.state = { projects: {}, tasks: {}, versions: {} };
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
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      const temporaryFile = `${this.stateFile}.tmp`;
      await writeFile(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`);
      await rename(temporaryFile, this.stateFile);
    });
    return this.writeChain;
  }

  async createProject(idea) {
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const createdAt = now();
    const project = {
      id,
      idea,
      tokenHash: tokenHash(token),
      status: 'draft',
      currentVersionId: null,
      nextVersionNumber: 1,
      planning: {
        status: 'not_started',
        clarifications: [],
        pendingQuestion: null,
        proposals: [],
        selectedProposalId: null,
        provider: null,
        usageRecords: [],
        updatedAt: createdAt,
      },
      createdAt,
      updatedAt: createdAt,
    };
    this.state.projects[id] = project;
    this.state.versions[id] = [];
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
    if (!Array.isArray(project.planning.usageRecords)) {
      project.planning.usageRecords = project.planning.provider
        ? [{ ...project.planning.provider, kind: project.planning.status, recordedAt: project.planning.updatedAt }]
        : [];
    }
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
    const { tokenHash: ignored, ...safeProject } = project;
    return safeProject;
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
      project.status = 'clarifying';
    } else {
      planning.status = 'proposal_ready';
      planning.pendingQuestion = null;
      planning.proposals = result.proposals;
      planning.selectedProposalId = null;
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
    planning.status = 'proposal_selected';
    planning.selectedProposalId = proposal.id;
    planning.updatedAt = updatedAt;
    project.status = 'proposal_selected';
    project.updatedAt = updatedAt;
    await this.persist();
    return { planning, proposal };
  }

  async createTask(projectId, kind, instruction) {
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
    };
    this.state.tasks[id] = task;
    const project = this.getProject(projectId);
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
      generatorMode: output.generatorMode,
      outputPath: output.outputPath,
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
    project.updatedAt = now();
    await this.persist();
  }
}
