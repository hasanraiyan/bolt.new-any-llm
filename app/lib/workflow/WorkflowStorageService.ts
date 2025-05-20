// app/lib/workflow/WorkflowStorageService.ts

import type { WorkflowState, Task } from './types';

/**
 * Provides an in-memory storage service for workflow states.
 * This service implements a singleton pattern.
 */
export class WorkflowStorageService {
  private static instance: WorkflowStorageService;
  private store: Map<string, string> = new Map(); // Stores workflowId -> serialized WorkflowState

  /**
   * Private constructor to prevent direct instantiation.
   */
  private constructor() {}

  /**
   * Gets the singleton instance of the WorkflowStorageService.
   * @returns The singleton instance.
   */
  public static getInstance(): WorkflowStorageService {
    if (!WorkflowStorageService.instance) {
      WorkflowStorageService.instance = new WorkflowStorageService();
    }
    return WorkflowStorageService.instance;
  }

  /**
   * Saves the workflow state to the in-memory store.
   * @param workflowId The ID of the workflow.
   * @param state The WorkflowState object to save.
   * @returns A promise that resolves when the state is saved.
   */
  public async save(workflowId: string, state: WorkflowState): Promise<void> {
    try {
      const serializedState = JSON.stringify(state);
      this.store.set(workflowId, serializedState);
      console.log(`WorkflowStorageService: WorkflowState saved for ID: ${workflowId}`);
    } catch (error) {
      console.error(`WorkflowStorageService: Error saving WorkflowState for ID ${workflowId}:`, error);
      // Optionally re-throw or handle as appropriate for your application
      throw error;
    }
    return Promise.resolve();
  }

  /**
   * Loads the workflow state from the in-memory store.
   * Handles deserialization of Date objects within tasks.
   * @param workflowId The ID of the workflow to load.
   * @returns A promise that resolves to the WorkflowState object or null if not found.
   */
  public async load(workflowId: string): Promise<WorkflowState | null> {
    const serializedState = this.store.get(workflowId);

    if (!serializedState) {
      console.warn(`WorkflowStorageService: No WorkflowState found for ID: ${workflowId}`);
      return Promise.resolve(null);
    }

    try {
      const state: WorkflowState = JSON.parse(serializedState);

      // Handle Date deserialization for tasks
      if (state.tasks && Array.isArray(state.tasks)) {
        state.tasks.forEach(task => {
          if (task.createdAt && typeof task.createdAt === 'string') {
            task.createdAt = new Date(task.createdAt);
          }
          if (task.updatedAt && typeof task.updatedAt === 'string') {
            task.updatedAt = new Date(task.updatedAt);
          }
          if (task.startedAt && typeof task.startedAt === 'string') {
            task.startedAt = new Date(task.startedAt);
          }
          if (task.completedAt && typeof task.completedAt === 'string') {
            task.completedAt = new Date(task.completedAt);
          }
        });
      }

      console.log(`WorkflowStorageService: WorkflowState loaded for ID: ${workflowId}`);
      return Promise.resolve(state);
    } catch (error) {
      console.error(`WorkflowStorageService: Error loading/parsing WorkflowState for ID ${workflowId}:`, error);
      // Optionally re-throw or handle as appropriate
      return Promise.resolve(null); // Or throw
    }
  }

  /**
   * Deletes the workflow state from the in-memory store.
   * @param workflowId The ID of the workflow to delete.
   * @returns A promise that resolves when the state is deleted.
   */
  public async delete(workflowId: string): Promise<void> {
    const deleted = this.store.delete(workflowId);
    if (deleted) {
      console.log(`WorkflowStorageService: WorkflowState deleted for ID: ${workflowId}`);
    } else {
      console.warn(`WorkflowStorageService: No WorkflowState found to delete for ID: ${workflowId}`);
    }
    return Promise.resolve();
  }
}
