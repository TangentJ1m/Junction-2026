import { Router, type IRouter } from "express";
import {
  AnswerQuestionBody,
  AnswerQuestionParams,
  AnswerQuestionResponse,
  CreateTaskBody,
  CreateTaskResponse,
  DeleteMemoryParams,
  GetBranchParams,
  GetBranchResponse,
  GetDashboardResponse,
  GetTaskParams,
  GetTaskResponse,
  ListMemoryResponse,
  ListTaskSourcesParams,
  ListTaskSourcesResponse,
  ListTasksResponse,
  UpdateHandoffBody,
  UpdateHandoffParams,
  UpdateHandoffResponse,
} from "@workspace/api-zod";
import {
  answerTaskQuestion,
  createTask,
  ensureDemoData,
  forgetMemory,
  getBranchDetail,
  getDashboardSummary,
  getMemories,
  getTaskDetail,
  getTaskSources,
  getTaskSummaries,
  updateTaskHandoff,
} from "../lib/butler";
import { subscribeToTask } from "../lib/task-events";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
  await ensureDemoData();
  res.json(GetDashboardResponse.parse(await getDashboardSummary()));
});

router.get("/tasks", async (_req, res): Promise<void> => {
  await ensureDemoData();
  res.json(ListTasksResponse.parse(await getTaskSummaries()));
});

router.post("/tasks", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const task = await createTask(parsed.data.prompt);
  res.status(201).json(CreateTaskResponse.parse(task));
});

router.get("/tasks/:taskId", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await ensureDemoData();
  const task = await getTaskDetail(params.data.taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(GetTaskResponse.parse(task));
});

router.get("/tasks/:taskId/events", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).end();
    return;
  }
  const task = await getTaskDetail(params.data.taskId);
  if (!task) {
    res.status(404).end();
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: task-update\ndata: ${JSON.stringify(task)}\n\n`);
  const unsubscribe = subscribeToTask(params.data.taskId, res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.get("/tasks/:taskId/branches/:branchId", async (req, res): Promise<void> => {
  const params = GetBranchParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const branch = await getBranchDetail(params.data.taskId, params.data.branchId);
  if (!branch) {
    res.status(404).json({ error: "Branch not found" });
    return;
  }
  res.json(GetBranchResponse.parse(branch));
});

router.get("/tasks/:taskId/sources", async (req, res): Promise<void> => {
  const params = ListTaskSourcesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  res.json(ListTaskSourcesResponse.parse(await getTaskSources(params.data.taskId)));
});

router.post("/tasks/:taskId/questions/:questionId/answer", async (req, res): Promise<void> => {
  const params = AnswerQuestionParams.safeParse(req.params);
  const body = AnswerQuestionBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const task = await answerTaskQuestion(
    params.data.taskId,
    params.data.questionId,
    body.data.answer,
    body.data.consent,
  );
  if (!task) {
    res.status(404).json({ error: "Pending question not found" });
    return;
  }
  res.json(AnswerQuestionResponse.parse(task));
});

router.post("/tasks/:taskId/handoff", async (req, res): Promise<void> => {
  const params = UpdateHandoffParams.safeParse(req.params);
  const body = UpdateHandoffBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const task = await updateTaskHandoff(params.data.taskId, body.data.decision);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(UpdateHandoffResponse.parse(task));
});

router.get("/memory", async (_req, res): Promise<void> => {
  await ensureDemoData();
  const memories = await getMemories();
  const output = memories.map((memory) => ({
    id: memory.id,
    fact: memory.fact,
    value: memory.value,
    provenance: memory.provenance,
    consentMode: memory.consentMode as "always" | "never",
    createdAt: memory.createdAt.toISOString(),
  }));
  res.json(ListMemoryResponse.parse(output));
});

router.delete("/memory/:memoryId", async (req, res): Promise<void> => {
  const params = DeleteMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const removed = await forgetMemory(params.data.memoryId);
  if (!removed) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
