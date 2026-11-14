import type { Response } from "express";

const listeners = new Map<string, Set<Response>>();

export function subscribeToTask(taskId: string, response: Response): () => void {
  const taskListeners = listeners.get(taskId) ?? new Set<Response>();
  taskListeners.add(response);
  listeners.set(taskId, taskListeners);

  return () => {
    taskListeners.delete(response);
    if (taskListeners.size === 0) listeners.delete(taskId);
  };
}

export function publishTaskEvent(taskId: string, payload: unknown): void {
  const taskListeners = listeners.get(taskId);
  if (!taskListeners) return;

  const message = `event: task-update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of taskListeners) {
    if (response.writableEnded || response.destroyed) {
      taskListeners.delete(response);
      continue;
    }
    response.write(message);
  }
  if (taskListeners.size === 0) listeners.delete(taskId);
}
