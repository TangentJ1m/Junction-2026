import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const tasksTable = pgTable("butler_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  summary: text("summary"),
  status: text("status").notNull().default("queued"),
  requiresHandoff: boolean("requires_handoff").notNull().default(false),
  handoffStatus: text("handoff_status").notNull().default("not_needed"),
  handoffMessage: text("handoff_message").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const branchesTable = pgTable("butler_branches", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  status: text("status").notNull().default("queued"),
  summary: text("summary"),
  confidence: doublePrecision("confidence"),
  openQuestions: jsonb("open_questions").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourcesTable = pgTable("butler_sources", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  branchId: text("branch_id")
    .notNull()
    .references(() => branchesTable.id, { onDelete: "cascade" }),
  branchName: text("branch_name").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  snippet: text("snippet").notNull(),
  supportsClaim: text("supports_claim").notNull(),
  provider: text("provider").notNull(),
  evidenceLabel: text("evidence_label").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questionsTable = pgTable("butler_questions", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  why: text("why").notNull(),
  options: jsonb("options").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("pending"),
  answer: text("answer"),
  consent: text("consent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryTable = pgTable("butler_memory", {
  id: text("id").primaryKey(),
  fact: text("fact").notNull(),
  value: text("value").notNull(),
  provenance: text("provenance").notNull(),
  consentMode: text("consent_mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertBranchSchema = createInsertSchema(branchesTable).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertSourceSchema = createInsertSchema(sourcesTable).omit({
  retrievedAt: true,
});
export const insertQuestionSchema = createInsertSchema(questionsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertMemorySchema = createInsertSchema(memoryTable).omit({
  createdAt: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertBranch = z.infer<typeof insertBranchSchema>;
export type InsertSource = z.infer<typeof insertSourceSchema>;
export type InsertQuestion = z.infer<typeof insertQuestionSchema>;
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type Task = typeof tasksTable.$inferSelect;
export type Branch = typeof branchesTable.$inferSelect;
export type Source = typeof sourcesTable.$inferSelect;
export type Question = typeof questionsTable.$inferSelect;
export type MemoryFact = typeof memoryTable.$inferSelect;
