// app/lib/workflow/types.ts

/**
 * Generic type for agent input.
 */
export type AgentInput = Record<string, any>;

/**
 * Generic type for agent output.
 * - `status`: Indicates success or failure of the agent's execution.
 * - `error`: Error message if status is failure.
 * - `actionString`: Optional XML-like string for ActionRunner.
 * - `sharedContextUpdates`: Optional data to merge into workflow's sharedContext.
 * - `plannedTasks`: Optional list of tasks, primarily for PlanningAgent.
 */
export interface AgentOutput {
  status: 'success' | 'failure';
  error?: string;
  actionString?: string;
  sharedContextUpdates?: Record<string, any>;
  plannedTasks?: Task[]; // Primarily for PlanningAgent
  [key: string]: any; // Allow other arbitrary properties
}

/**
 * Represents the state of a workflow.
 */
export interface WorkflowState {
  workflowId: string;
  originalUserInput: string;
  tasks: Task[];
  currentTaskIndex: number;
  sharedContext: Record<string, any>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
}

/**
 * Represents a task within a workflow.
 */
export interface Task {
  id: string;
  agentName: string; // e.g., "PlanningAgent", "FileAgent"
  input: AgentInput; // Or a more specific input type if known for the task
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: AgentOutput;
  dependencies?: string[]; // IDs of tasks that must complete before this one
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

/**
 * Represents an agent that can execute tasks.
 */
export interface Agent {
  name: string;
  description: string; // Briefly describe what the agent does
  execute(task: Task, workflowState: WorkflowState): Promise<AgentOutput>;
}
