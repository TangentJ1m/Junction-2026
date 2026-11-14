import { randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  branchesTable,
  db,
  memoryTable,
  questionsTable,
  sourcesTable,
  tasksTable,
  type Branch,
  type MemoryFact,
  type Question,
  type Source,
  type Task,
} from "@workspace/db";
import { logger } from "./logger";
import { publishTaskEvent } from "./task-events";

type TaskStatus = "queued" | "running" | "waiting" | "blocked" | "done" | "failed";
type BranchStatus = TaskStatus;
type ResearchSourceInput = {
  title: string;
  url: string;
  snippet: string;
  provider: "Exa" | "Demo";
};

const connectors = new ReplitConnectors();
const queryCache = new Map<string, { expiresAt: number; results: ResearchSourceInput[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const BRANCH_TIMEOUT_MS = 8_000;
let seedPromise: Promise<void> | null = null;

const demoSources: Record<string, ResearchSourceInput[]> = {
  hotel: [
    {
      title: "Plan your trip to Japan",
      url: "https://www.japan.travel/en/plan/",
      snippet: "Demo reference only. Use this official visitor guide to explore accommodation areas and trip planning information.",
      provider: "Demo",
    },
  ],
  flights: [
    {
      title: "Tokyo travel information",
      url: "https://www.gotokyo.org/en/",
      snippet: "Demo reference only. Review current travel information and transport links before making any booking.",
      provider: "Demo",
    },
  ],
  transport: [
    {
      title: "Tokyo Metro",
      url: "https://www.tokyometro.jp/en/ticket/travel/",
      snippet: "Demo reference only. Check official routes, passes, and service information for current details.",
      provider: "Demo",
    },
  ],
  itinerary: [
    {
      title: "Tokyo Official Travel Guide",
      url: "https://www.gotokyo.org/en/",
      snippet: "Demo reference only. Browse neighborhoods and visitor information when planning an itinerary.",
      provider: "Demo",
    },
  ],
  packing: [
    {
      title: "Japan travel planning",
      url: "https://www.japan.travel/en/plan/",
      snippet: "Demo reference only. Confirm seasonal conditions and travel requirements before departure.",
      provider: "Demo",
    },
  ],
  research: [
    {
      title: "Research starting point",
      url: "https://www.gov.uk/",
      snippet: "Demo reference only. This is a starting point; live research is not available for this result.",
      provider: "Demo",
    },
  ],
};

function iso(value: Date): string {
  return value.toISOString();
}

function getTitle(prompt: string): string {
  const cleaned = prompt.trim().replace(/\s+/g, " ");
  return cleaned.length > 42 ? `${cleaned.slice(0, 39).trimEnd()}…` : cleaned;
}

function isTravelPrompt(prompt: string): boolean {
  return /\b(trip|travel|flight|hotel|itinerary|japan|tokyo|holiday)\b/i.test(prompt);
}

function isBookingPrompt(prompt: string): boolean {
  return /\b(book|booking|reserve|reservation|pay|payment|purchase|buy)\b/i.test(prompt);
}

function buildBranchNames(prompt: string): string[] {
  if (isTravelPrompt(prompt)) {
    return ["Hotel options", "Flights", "Ground transport", "Itinerary", "Packing list"];
  }
  return ["Research", "Compare options", "Next steps"];
}

function branchNeedsTripBudget(name: string): boolean {
  return name === "Hotel options" || name === "Flights";
}

function branchKey(name: string): string {
  if (/hotel/i.test(name)) return "hotel";
  if (/flight/i.test(name)) return "flights";
  if (/transport/i.test(name)) return "transport";
  if (/itinerary/i.test(name)) return "itinerary";
  if (/packing/i.test(name)) return "packing";
  return "research";
}

function buildResearchQuery(prompt: string, branchName: string): string {
  return `${prompt.trim()} — ${branchName.toLowerCase()} options, current information, and reliable sources`;
}

function fallbackSources(branchName: string): ResearchSourceInput[] {
  return demoSources[branchKey(branchName)] ?? demoSources.research;
}

async function searchExa(query: string): Promise<ResearchSourceInput[]> {
  const cacheKey = query.toLowerCase().replace(/\s+/g, " ").trim();
  const cached = queryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRANCH_TIMEOUT_MS);
  try {
    const response = await connectors.proxy("exa", "/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        type: "fast",
        numResults: 3,
        moderation: true,
        contents: {
          highlights: { query, maxCharacters: 320 },
          summary: { query },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Exa returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        highlights?: string[];
        summary?: string;
      }>;
    };

    const results = (body.results ?? [])
      .filter((result) => typeof result.url === "string" && typeof result.title === "string")
      .slice(0, 3)
      .map((result) => ({
        title: result.title ?? "Untitled source",
        url: result.url ?? "https://exa.ai/",
        snippet:
          result.highlights?.[0]?.trim() ||
          result.summary?.trim() ||
          "Exa returned this source without a highlighted excerpt.",
        provider: "Exa" as const,
      }));

    if (results.length === 0) throw new Error("Exa returned no usable sources");
    queryCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, results });
    return results;
  } finally {
    clearTimeout(timeout);
  }
}

function sourceSummary(sources: ResearchSourceInput[], branchName: string): string {
  const first = sources[0];
  if (!first) return `${branchName}: no sources were found.`;
  return `${branchName}: ${first.title}. ${first.snippet}`;
}

function makeDemoSources(taskId: string, branchId: string, branchName: string): Omit<Source, "retrievedAt">[] {
  return fallbackSources(branchName).map((source, index) => ({
    id: randomUUID(),
    taskId,
    branchId,
    branchName,
    kind: index === 0 ? "primary" : "secondary",
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    supportsClaim: `${branchName} planning reference`,
    provider: source.provider,
    evidenceLabel: "Demo research",
  }));
}

function toSource(source: Source) {
  return {
    id: source.id,
    taskId: source.taskId,
    branchId: source.branchId,
    branchName: source.branchName,
    kind: source.kind as "primary" | "secondary",
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    retrievedAt: iso(source.retrievedAt),
    supportsClaim: source.supportsClaim,
    provider: source.provider as "Exa" | "Demo",
    evidenceLabel: source.evidenceLabel,
  };
}

function toQuestion(question?: Question) {
  if (!question) return null;
  return {
    id: question.id,
    prompt: question.prompt,
    why: question.why,
    options: question.options,
    status: question.status as "pending" | "answered",
    answer: question.answer,
    consent: question.consent as "once" | "this_task" | "always" | "never" | null,
  };
}

function toTaskStatus(status: string): TaskStatus {
  if (["queued", "running", "waiting", "blocked", "done", "failed"].includes(status)) {
    return status as TaskStatus;
  }
  return "queued";
}

function toHandoff(task: Task) {
  return {
    status: task.handoffStatus as "not_needed" | "pending" | "handed_to_user" | "cancelled",
    message: task.handoffMessage,
  };
}

function toBranch(branch: Branch, sources: Source[]) {
  return {
    id: branch.id,
    name: branch.name,
    status: toTaskStatus(branch.status) as BranchStatus,
    summary: branch.summary,
    confidence: branch.confidence,
    sources: sources.map(toSource),
    openQuestions: branch.openQuestions,
    updatedAt: iso(branch.updatedAt),
  };
}

export async function getTaskDetail(taskId: string) {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task) return null;

  const branchRows = await db
    .select()
    .from(branchesTable)
    .where(eq(branchesTable.taskId, taskId))
    .orderBy(asc(branchesTable.position));
  const sourceRows = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.taskId, taskId))
    .orderBy(asc(sourcesTable.kind), asc(sourcesTable.retrievedAt));
  const [question] = await db
    .select()
    .from(questionsTable)
    .where(eq(questionsTable.taskId, taskId))
    .orderBy(desc(questionsTable.createdAt))
    .limit(1);
  const sourcesByBranch = new Map<string, Source[]>();
  for (const source of sourceRows) {
    const items = sourcesByBranch.get(source.branchId) ?? [];
    items.push(source);
    sourcesByBranch.set(source.branchId, items);
  }

  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    summary: task.summary,
    status: toTaskStatus(task.status),
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    branches: branchRows.map((branch) => toBranch(branch, sourcesByBranch.get(branch.id) ?? [])),
    question: toQuestion(question),
    handoff: toHandoff(task),
  };
}

export async function getTaskSummaries() {
  const taskRows = await db.select().from(tasksTable).orderBy(desc(tasksTable.updatedAt));
  if (taskRows.length === 0) return [];
  const taskIds = taskRows.map((task) => task.id);
  const branchRows = await db
    .select({ taskId: branchesTable.taskId })
    .from(branchesTable)
    .where(inArray(branchesTable.taskId, taskIds));
  const sourceRows = await db
    .select({ taskId: sourcesTable.taskId })
    .from(sourcesTable)
    .where(inArray(sourcesTable.taskId, taskIds));
  const branchCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const row of branchRows) branchCounts.set(row.taskId, (branchCounts.get(row.taskId) ?? 0) + 1);
  for (const row of sourceRows) sourceCounts.set(row.taskId, (sourceCounts.get(row.taskId) ?? 0) + 1);

  return taskRows.map((task) => ({
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    status: toTaskStatus(task.status),
    branchCount: branchCounts.get(task.id) ?? 0,
    sourceCount: sourceCounts.get(task.id) ?? 0,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  }));
}

async function emitTaskUpdate(taskId: string): Promise<void> {
  const detail = await getTaskDetail(taskId);
  if (detail) publishTaskEvent(taskId, detail);
}

async function runBranch(taskId: string, branchId: string): Promise<void> {
  const [branch] = await db.select().from(branchesTable).where(eq(branchesTable.id, branchId)).limit(1);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!branch || !task) return;

  await db
    .update(branchesTable)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(branchesTable.id, branchId));
  await emitTaskUpdate(taskId);

  const query = buildResearchQuery(task.prompt, branch.name);
  let researchSources: ResearchSourceInput[];
  try {
    researchSources = await searchExa(query);
  } catch (error) {
    logger.warn({ taskId, branchId, error }, "Exa research failed; using clearly labeled demo sources");
    researchSources = fallbackSources(branch.name);
  }

  const provider = researchSources[0]?.provider ?? "Demo";
  const evidenceLabel = provider === "Exa" ? "Live Web / Exa" : "Demo research";
  const sourceRecords = researchSources.map((source, index) => ({
    id: randomUUID(),
    taskId,
    branchId,
    branchName: branch.name,
    kind: index === 0 ? "primary" : "secondary",
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    supportsClaim: `${branch.name} research`,
    provider: source.provider,
    evidenceLabel,
  }));
  if (sourceRecords.length > 0) {
    await db.insert(sourcesTable).values(sourceRecords);
  }

  const confidence = provider === "Exa" ? 0.84 : 0.55;
  await db
    .update(branchesTable)
    .set({
      status: "done",
      summary: sourceSummary(researchSources, branch.name),
      confidence,
      openQuestions: provider === "Demo" ? ["Live retrieval was unavailable; verify current details."] : [],
      updatedAt: new Date(),
    })
    .where(eq(branchesTable.id, branchId));
  await emitTaskUpdate(taskId);
}

async function finalizeTask(taskId: string): Promise<void> {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task) return;
  const branchRows = await db
    .select()
    .from(branchesTable)
    .where(eq(branchesTable.taskId, taskId))
    .orderBy(asc(branchesTable.position));
  const [question] = await db
    .select()
    .from(questionsTable)
    .where(and(eq(questionsTable.taskId, taskId), eq(questionsTable.status, "pending")))
    .limit(1);

  const waiting = branchRows.some((branch) => branch.status === "waiting" || branch.status === "blocked");
  const active = branchRows.some((branch) => branch.status === "queued" || branch.status === "running");
  const allFinished = branchRows.every((branch) => branch.status === "done");
  const mergedSummary = branchRows
    .filter((branch) => branch.status === "done" && branch.summary)
    .map((branch) => branch.summary)
    .join(" ");

  let status: TaskStatus = active ? "running" : waiting || question ? "waiting" : allFinished ? "done" : "failed";
  let handoffStatus = task.handoffStatus;
  let handoffMessage = task.handoffMessage;
  if (status === "done" && task.requiresHandoff && handoffStatus === "not_needed") {
    handoffStatus = "pending";
    handoffMessage =
      "Research is ready. Review the booking details, then continue on the provider’s secure site. Butler never collects payment details.";
  }

  await db
    .update(tasksTable)
    .set({
      status,
      summary: mergedSummary || task.summary,
      handoffStatus,
      handoffMessage,
      updatedAt: new Date(),
    })
    .where(eq(tasksTable.id, taskId));
  await emitTaskUpdate(taskId);
}

async function runBranches(taskId: string, branchIds: string[]): Promise<void> {
  try {
    await Promise.all(branchIds.map((branchId) => runBranch(taskId, branchId)));
    await finalizeTask(taskId);
  } catch (error) {
    logger.error({ taskId, error }, "Task branch execution failed");
    await db
      .update(tasksTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));
    await emitTaskUpdate(taskId);
  }
}

async function hasDoNotAskMemory(): Promise<boolean> {
  const [fact] = await db
    .select({ id: memoryTable.id })
    .from(memoryTable)
    .where(and(eq(memoryTable.fact, "Clarification preference"), eq(memoryTable.consentMode, "never")))
    .limit(1);
  return Boolean(fact);
}

export async function createTask(prompt: string) {
  const taskId = randomUUID();
  const trimmedPrompt = prompt.trim();
  const trip = isTravelPrompt(trimmedPrompt);
  const names = buildBranchNames(trimmedPrompt);
  const answerHasGuestCount = /\b\d+\s*(people|persons?|travellers?|travelers?|guests?)\b/i.test(trimmedPrompt);
  const answerHasBudget = /[£$€]\s?\d|\bno fixed budget\b/i.test(trimmedPrompt);
  const shouldAskAboutBudget = trip && !answerHasBudget && !(await hasDoNotAskMemory());
  const questionId = shouldAskAboutBudget ? randomUUID() : null;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(tasksTable).values({
      id: taskId,
      title: getTitle(trimmedPrompt),
      prompt: trimmedPrompt,
      summary: null,
      status: questionId ? "waiting" : "running",
      requiresHandoff: isBookingPrompt(trimmedPrompt),
      handoffStatus: "not_needed",
      handoffMessage: "",
    });

    const branches = names.map((name, index) => ({
      id: randomUUID(),
      taskId,
      name,
      position: index,
      status: questionId && branchNeedsTripBudget(name) ? "waiting" : "queued",
      summary: null,
      confidence: null,
      openQuestions: [] as string[],
      createdAt: now,
      updatedAt: now,
    }));
    await tx.insert(branchesTable).values(branches);

    if (questionId) {
      await tx.insert(questionsTable).values({
        id: questionId,
        taskId,
        prompt: answerHasGuestCount
          ? "What total budget should I plan around?"
          : "How many people are travelling, and what total budget should I plan around?",
        why: "Hotel and flight options depend on your party size and budget. You can answer for this task only or choose whether Butler remembers it.",
        options: [
          "Under £2,000",
          "£2,000–£4,000",
          "£4,000–£6,000",
          "No fixed budget",
          "Other",
        ],
        status: "pending",
        answer: null,
        consent: null,
      });
    }
  });

  const created = await getTaskDetail(taskId);
  if (!created) throw new Error("Task was created but could not be loaded");
  const branchRows = await db.select().from(branchesTable).where(eq(branchesTable.taskId, taskId));
  const queuedIds = branchRows.filter((branch) => branch.status === "queued").map((branch) => branch.id);
  if (queuedIds.length > 0) {
    void runBranches(taskId, queuedIds);
  }
  return created;
}

export async function answerTaskQuestion(
  taskId: string,
  questionId: string,
  answer: string,
  consent: "once" | "this_task" | "always" | "never",
) {
  const [question] = await db
    .select()
    .from(questionsTable)
    .where(and(eq(questionsTable.id, questionId), eq(questionsTable.taskId, taskId)))
    .limit(1);
  if (!question || question.status !== "pending") return null;

  await db.transaction(async (tx) => {
    await tx
      .update(questionsTable)
      .set({ status: "answered", answer: answer.trim(), consent, updatedAt: new Date() })
      .where(eq(questionsTable.id, questionId));
    if (consent === "always") {
      await tx.insert(memoryTable).values({
        id: randomUUID(),
        fact: "Travel planning preference",
        value: answer.trim(),
        provenance: "Remembered from a previous task with your consent",
        consentMode: "always",
      });
    }
    if (consent === "never") {
      const existing = await tx
        .select({ id: memoryTable.id })
        .from(memoryTable)
        .where(and(eq(memoryTable.fact, "Clarification preference"), eq(memoryTable.consentMode, "never")))
        .limit(1);
      if (existing.length === 0) {
        await tx.insert(memoryTable).values({
          id: randomUUID(),
          fact: "Clarification preference",
          value: "Don't ask again for travel budget and party size",
          provenance: "Saved because you chose “Don’t ask again”",
          consentMode: "never",
        });
      }
    }
    await tx
      .update(branchesTable)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(eq(branchesTable.taskId, taskId), eq(branchesTable.status, "waiting")));
    await tx
      .update(tasksTable)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(tasksTable.id, taskId));
  });

  await emitTaskUpdate(taskId);
  const queued = await db
    .select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.taskId, taskId), eq(branchesTable.status, "queued")));
  if (queued.length > 0) {
    void runBranches(taskId, queued.map((branch) => branch.id));
  }
  return getTaskDetail(taskId);
}

export async function updateTaskHandoff(taskId: string, decision: "hand_to_user" | "cancel") {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
  if (!task || !task.requiresHandoff || task.handoffStatus !== "pending") return null;
  const handedOff = decision === "hand_to_user";
  await db
    .update(tasksTable)
    .set({
      handoffStatus: handedOff ? "handed_to_user" : "cancelled",
      handoffMessage: handedOff
        ? "Handed to you. Complete the booking directly on the provider’s secure website. No payment details were collected."
        : "Booking handoff cancelled. No booking or payment was made.",
      updatedAt: new Date(),
    })
    .where(eq(tasksTable.id, taskId));
  await emitTaskUpdate(taskId);
  return getTaskDetail(taskId);
}

export async function getBranchDetail(taskId: string, branchId: string) {
  const [branch] = await db
    .select()
    .from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), eq(branchesTable.taskId, taskId)))
    .limit(1);
  if (!branch) return null;
  const sources = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.branchId, branchId))
    .orderBy(asc(sourcesTable.kind), asc(sourcesTable.retrievedAt));
  return toBranch(branch, sources);
}

export async function getTaskSources(taskId: string) {
  return (await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.taskId, taskId))
    .orderBy(asc(sourcesTable.branchName), asc(sourcesTable.kind), asc(sourcesTable.retrievedAt)))
    .map(toSource);
}

export async function getMemories(): Promise<MemoryFact[]> {
  return db.select().from(memoryTable).orderBy(desc(memoryTable.createdAt));
}

export async function forgetMemory(memoryId: string) {
  const [removed] = await db.delete(memoryTable).where(eq(memoryTable.id, memoryId)).returning();
  return removed ?? null;
}

export async function getDashboardSummary() {
  const tasks = await getTaskSummaries();
  return {
    taskCount: tasks.length,
    needsAttention: tasks.filter((task) => task.status === "waiting" || task.status === "blocked").length,
    running: tasks.filter((task) => task.status === "running" || task.status === "queued").length,
    finished: tasks.filter((task) => task.status === "done").length,
    recentTasks: tasks.slice(0, 5),
  };
}

async function seedDemoData(): Promise<void> {
  const existing = await db.select({ id: tasksTable.id }).from(tasksTable).limit(1);
  if (existing.length > 0) return;

  const tasks = [
    {
      id: "demo-tokyo-trip",
      title: "Tokyo Trip (Nov 18–23)",
      prompt: "Plan a trip to Tokyo in November for 2 people",
      summary: "Demo task. Set a budget to continue hotel and flight research.",
      status: "waiting",
      requiresHandoff: true,
      handoffStatus: "not_needed",
      handoffMessage: "",
    },
    {
      id: "demo-london-rent",
      title: "London Rent Increase Check",
      prompt: "Check whether my London rent increase is allowed",
      summary: "Demo task. Confirm the UK nation before reviewing the right guidance.",
      status: "waiting",
      requiresHandoff: false,
      handoffStatus: "not_needed",
      handoffMessage: "",
    },
    {
      id: "demo-railcard",
      title: "Student Railcard & Benefits Check",
      prompt: "Check current student railcard and travel benefits",
      summary: "Demo task with one research branch still in progress.",
      status: "running",
      requiresHandoff: false,
      handoffStatus: "not_needed",
      handoffMessage: "",
    },
    {
      id: "demo-bank-accounts",
      title: "Compare UK Student Bank Accounts",
      prompt: "Compare UK student bank account options",
      summary: "Demo comparison completed. Open the source ledger to review sample links.",
      status: "done",
      requiresHandoff: false,
      handoffStatus: "not_needed",
      handoffMessage: "",
    },
  ];

  const branchData = [
    { id: "demo-tokyo-hotel", taskId: "demo-tokyo-trip", name: "Hotel options", position: 0, status: "waiting" },
    { id: "demo-tokyo-flights", taskId: "demo-tokyo-trip", name: "Flights", position: 1, status: "waiting" },
    { id: "demo-tokyo-transport", taskId: "demo-tokyo-trip", name: "Ground transport", position: 2, status: "done", summary: "Demo reference for Tokyo Metro passes and current service details.", confidence: 0.55 },
    { id: "demo-tokyo-itinerary", taskId: "demo-tokyo-trip", name: "Itinerary", position: 3, status: "done", summary: "Demo reference for visitor information and itinerary ideas.", confidence: 0.55 },
    { id: "demo-tokyo-packing", taskId: "demo-tokyo-trip", name: "Packing list", position: 4, status: "done", summary: "Demo reference for trip planning and seasonal checks.", confidence: 0.55 },
    { id: "demo-rent-law", taskId: "demo-london-rent", name: "Tenancy guidance", position: 0, status: "waiting" },
    { id: "demo-railcard-rules", taskId: "demo-railcard", name: "Eligibility and benefits", position: 0, status: "running" },
    { id: "demo-bank-overdraft", taskId: "demo-bank-accounts", name: "Fees and overdrafts", position: 0, status: "done", summary: "Demo reference to a UK student account comparison.", confidence: 0.55 },
  ];

  await db.transaction(async (tx) => {
    await tx.insert(tasksTable).values(tasks);
    await tx.insert(branchesTable).values(branchData.map((branch) => ({
      ...branch,
      openQuestions: [] as string[],
    })));
    await tx.insert(questionsTable).values([
      {
        id: "demo-budget-question",
        taskId: "demo-tokyo-trip",
        prompt: "What total budget should I plan around?",
        why: "Hotel and flight options depend on your total budget. This demo question demonstrates the consent controls.",
        options: ["Under £2,000", "£2,000–£4,000", "£4,000–£6,000", "No fixed budget", "Other"],
        status: "pending",
        answer: null,
        consent: null,
      },
      {
        id: "demo-rent-question",
        taskId: "demo-london-rent",
        prompt: "Which UK nation applies to your tenancy?",
        why: "Rent rules differ across England, Wales, Scotland, and Northern Ireland.",
        options: ["England", "Wales", "Scotland", "Northern Ireland", "Other"],
        status: "pending",
        answer: null,
        consent: null,
      },
    ]);

    const sampleSources = [
      ...makeDemoSources("demo-tokyo-trip", "demo-tokyo-transport", "Ground transport"),
      ...makeDemoSources("demo-tokyo-trip", "demo-tokyo-itinerary", "Itinerary"),
      ...makeDemoSources("demo-tokyo-trip", "demo-tokyo-packing", "Packing list"),
      {
        id: randomUUID(),
        taskId: "demo-railcard",
        branchId: "demo-railcard-rules",
        branchName: "Eligibility and benefits",
        kind: "primary",
        title: "16–25 Railcard",
        url: "https://www.16-25railcard.co.uk/",
        snippet: "Demo reference only. Check the official site for current eligibility and discounts.",
        supportsClaim: "Student railcard eligibility reference",
        provider: "Demo",
        evidenceLabel: "Demo research",
      },
      {
        id: randomUUID(),
        taskId: "demo-bank-accounts",
        branchId: "demo-bank-overdraft",
        branchName: "Fees and overdrafts",
        kind: "primary",
        title: "Student bank accounts guide",
        url: "https://www.moneysavingexpert.com/banking/student-bank-account/",
        snippet: "Demo reference only. Compare current fees, overdrafts, and eligibility with providers directly.",
        supportsClaim: "Student bank account comparison reference",
        provider: "Demo",
        evidenceLabel: "Demo research",
      },
    ];
    await tx.insert(sourcesTable).values(sampleSources);
  });
}

export async function ensureDemoData(): Promise<void> {
  if (!seedPromise) {
    seedPromise = seedDemoData().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  await seedPromise;
}
