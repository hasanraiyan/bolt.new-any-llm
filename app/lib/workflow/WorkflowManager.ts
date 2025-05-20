// app/lib/workflow/WorkflowManager.ts

import type { WebContainer } from '@webcontainer/api';
import type { BoltShell } from '~/utils/shell';
import type { Agent, Task, WorkflowState, AgentInput, AgentOutput } from './types';
import { LLMManager } from '~/lib/modules/llm/manager';
import { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionCallbackData, FileAction, ShellAction, BoltAction } from '~/types/actions'; // Adjusted path
import { WorkflowStorageService } from './WorkflowStorageService'; // Import storage service

/**
 * Manages the lifecycle and execution of a workflow.
 */
export class WorkflowManager {
  private workflowState: WorkflowState;
  private agents: Map<string, Agent> = new Map();
  private actionRunner?: ActionRunner;
  private storageService: WorkflowStorageService;
  private llmManager: LLMManager; // Ensure llmManager is a class property

  /**
   * Generates a unique ID for tasks or workflows.
   * @returns A unique string ID.
   */
  private generateId(prefix: string = 'wf_'): string {
    // Use a more robust unique ID generator if available, e.g. crypto.randomUUID if in Node 14+ or browser
    return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Creates an instance of WorkflowManager.
   * This constructor handles both new workflow creation and initialization from a loaded state.
   * @param initialUserInputOrWorkflowId For new workflows, the initial user input string. For loaded, can be the workflowId (though state.originalUserInput is used).
   * @param llmManager An instance of LLMManager.
   * @param webcontainerPromise Optional promise for WebContainer initialization.
   * @param getShellTerminal Optional function to get BoltShell instance.
   * @param loadedState Optional WorkflowState object if initializing from a loaded state.
   */
  constructor(
    initialUserInputOrWorkflowId: string, // Can be initial user input or workflowId for context
    llmManager: LLMManager,
    webcontainerPromise?: Promise<WebContainer>,
    getShellTerminal?: () => BoltShell,
    loadedState?: WorkflowState // Explicitly pass loadedState here
  ) {
    this.llmManager = llmManager; // Store llmManager
    this.storageService = WorkflowStorageService.getInstance();

    if (loadedState) {
      this.workflowState = loadedState;
      // Ensure conversationHistory exists, even if loaded state is old
      if (!this.workflowState.sharedContext.conversationHistory) {
        this.workflowState.sharedContext.conversationHistory = [{ role: 'system', content: 'Workflow loaded. Original input: ' + this.workflowState.originalUserInput }];
      }
      console.log(`WorkflowManager: Initialized from loaded state ID: ${this.workflowState.workflowId}`);
    } else {
      // New workflow from user input string
      const workflowId = this.generateId();
      const initialUserInput = initialUserInputOrWorkflowId;
      this.workflowState = {
        workflowId: workflowId,
        originalUserInput: initialUserInput,
        tasks: [],
        currentTaskIndex: 0,
        sharedContext: {
          // Initialize conversation history with the first user message
          conversationHistory: [{ role: 'user', content: initialUserInput }] 
        },
        status: 'pending',
      };
      console.log(`WorkflowManager: Initialized new workflow ID: ${this.workflowState.workflowId}. Initial input saved to history.`);
      // Save the newly created state immediately
      this.storageService.save(this.workflowState.workflowId, this.workflowState)
        .catch(err => console.error("WorkflowManager: Failed to save initial workflow state:", err));
    }

    // Initialize ActionRunner (if applicable)
    // ActionRunner's onAlert handlers are stubbed to console logs for now.
    if (webcontainerPromise && getShellTerminal) {
      this.actionRunner = new ActionRunner(webcontainerPromise, getShellTerminal,
        (alert) => console.log('ActionRunner Alert:', alert.message, alert.type, alert.details),
        (supabaseAlert) => console.log('ActionRunner Supabase Alert:', supabaseAlert.message, supabaseAlert.type, supabaseAlert.details),
        (deployAlert) => console.log('ActionRunner Deploy Alert:', deployAlert.message, deployAlert.type, deployAlert.details)
      );
      console.log('WorkflowManager: ActionRunner initialized.');
    }
  }

  /**
   * Loads a workflow from storage and returns a WorkflowManager instance.
   * @param workflowId The ID of the workflow to load.
   * @param llmManager LLMManager instance.
   * @param webcontainerPromise Optional WebContainer promise.
   * @param getShellTerminal Optional function to get BoltShell.
   * @returns A Promise resolving to a WorkflowManager instance or null if not found.
   */
  public static async load(
    workflowId: string,
    llmManager: LLMManager,
    webcontainerPromise?: Promise<WebContainer>,
    getShellTerminal?: () => BoltShell
  ): Promise<WorkflowManager | null> {
    const storage = WorkflowStorageService.getInstance();
    const state = await storage.load(workflowId);
    if (!state) {
      console.warn(`WorkflowManager.load: Workflow with ID ${workflowId} not found in storage.`);
      return null;
    }

    // Pass state.originalUserInput as the first param, and the full state as the last.
    // The constructor will prioritize the 'state' object for initialization.
    const manager = new WorkflowManager(
      state.originalUserInput, // Used if state wasn't passed, but constructor logic handles it
      llmManager,
      webcontainerPromise,
      getShellTerminal,
      state // Pass the loaded state
    );
    return manager;
  }

  /**
   * Registers an agent that can be used in the workflow.
   * @param agent The agent to register.
   */
  public registerAgent(agent: Agent): void {
    this.agents.set(agent.name, agent);
    console.log(`Agent registered: ${agent.name}`);
  }

  /**
   * Plans the workflow by creating a list of tasks.
   * (Currently a placeholder with hardcoded tasks).
   * @returns A promise that resolves when planning is complete.
   */
  public async plan(): Promise<void> {
    console.log("WorkflowManager: Planning workflow using PlanningAgent...");
    this.workflowState.status = 'running'; // Mark as running during planning
    // Save state before planning agent potentially modifies it extensively
    await this.storageService.save(this.workflowState.workflowId, this.workflowState)
        .catch(err => console.error("WorkflowManager.plan: Failed to save state before planning:", err));


    const planningAgent = this.agents.get('PlanningAgent');
    if (!planningAgent) {
      this.workflowState.status = 'failed';
      this.workflowState.tasks = [];
      console.error("WorkflowManager.plan: PlanningAgent not registered. Cannot plan workflow.");
      await this.storageService.save(this.workflowState.workflowId, this.workflowState)
          .catch(err => console.error("WorkflowManager.plan: Failed to save error state for unregistered agent:", err));
      return;
    }

    const initialPlanningTask: Task = {
      // Use a task-specific ID generator if you have one, or reuse the workflow's
      id: this.generateId('task_'), 
      agentName: 'PlanningAgent',
      // Use workflowState.originalUserInput for the planning request
      input: { request: this.workflowState.originalUserInput }, 
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
    };

    try {
      const output: AgentOutput = await planningAgent.execute(initialPlanningTask, this.workflowState);
      initialPlanningTask.updatedAt = new Date();
      initialPlanningTask.completedAt = new Date();

      if (output.status === 'success' && output.plannedTasks && output.plannedTasks.length > 0) {
        this.workflowState.tasks = output.plannedTasks;
        initialPlanningTask.status = 'completed';
        if (output.sharedContextUpdates) {
          this.workflowState.sharedContext = {
            ...this.workflowState.sharedContext,
            ...output.sharedContextUpdates,
          };
          console.log("WorkflowManager.plan: Workflow sharedContext updated by PlanningAgent:", output.sharedContextUpdates);
        }
        this.workflowState.status = 'pending'; // Ready to be executed
        console.log(`WorkflowManager.plan: Planning complete. ${this.workflowState.tasks.length} tasks generated.`);
      } else {
        initialPlanningTask.status = 'failed';
        initialPlanningTask.error = output.error || "PlanningAgent failed to produce tasks.";
        this.workflowState.status = 'failed';
        this.workflowState.tasks = [];
        console.error("WorkflowManager.plan: PlanningAgent execution failed or returned no tasks:", output.error);
      }
    } catch (error: any) {
      initialPlanningTask.status = 'failed';
      initialPlanningTask.error = error.message;
      initialPlanningTask.updatedAt = new Date();
      initialPlanningTask.completedAt = new Date();
      this.workflowState.status = 'failed';
      this.workflowState.tasks = [];
      console.error("WorkflowManager.plan: Error during PlanningAgent execution:", error);
    }
    // Optionally store the planning task in workflowState.tasks or a dedicated field
    // this.workflowState.planningAuditTask = initialPlanningTask; 
    await this.storageService.save(this.workflowState.workflowId, this.workflowState)
        .catch(err => console.error("WorkflowManager.plan: Failed to save state after planning:", err));
  }

  /**
   * Executes the workflow task by task.
   * @returns A promise that resolves when the workflow execution is finished (completed or failed).
   */
  public async executeWorkflow(): Promise<void> {
    if (this.workflowState.tasks.length === 0 && this.workflowState.status !== 'failed') {
      console.warn("WorkflowManager.executeWorkflow: No tasks to execute. Did you call plan() first?");
      this.workflowState.status = 'completed'; // Or 'failed' if no tasks is an error
      await this.storageService.save(this.workflowState.workflowId, this.workflowState)
          .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save state for no tasks:", err));
      return Promise.resolve();
    }
    
    if (this.workflowState.status === 'completed' || this.workflowState.status === 'failed') {
        console.log(`WorkflowManager.executeWorkflow: Workflow already in terminal state: ${this.workflowState.status}. Skipping execution.`);
        return Promise.resolve();
    }

    this.workflowState.status = 'running';
    console.log(`WorkflowManager.executeWorkflow: Executing workflow ID: ${this.workflowState.workflowId}`);
    await this.storageService.save(this.workflowState.workflowId, this.workflowState)
        .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save state at start of execution:", err));

    for (let i = this.workflowState.currentTaskIndex; i < this.workflowState.tasks.length; i++) {
      const task = this.workflowState.tasks[i];
      // Skip already completed or failed tasks if workflow is resumed
      if (task.status === 'completed' || task.status === 'failed') {
        console.log(`WorkflowManager.executeWorkflow: Skipping task ${task.id} with status ${task.status}`);
        continue;
      }
      
      console.log(`WorkflowManager.executeWorkflow: Executing task ${task.id} - ${task.agentName}`);

      task.status = 'running';
      task.startedAt = task.startedAt || new Date(); // Set startedAt only if not already set (for retries/resume)
      task.updatedAt = new Date();

      const agent = this.agents.get(task.agentName);

      if (!agent) {
        task.status = 'failed';
        task.error = `Agent not found: ${task.agentName}`;
        task.completedAt = new Date();
        task.updatedAt = new Date();
        this.workflowState.status = 'failed';
        console.error(`WorkflowManager.executeWorkflow: ${task.error}`);
        await this.storageService.save(this.workflowState.workflowId, this.workflowState)
            .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state for agent not found:", err));
        break; // Stop workflow execution
      }

      try {
        console.log(`WorkflowManager.executeWorkflow: Calling agent: ${agent.name} for task ${task.id}`);
        const output: AgentOutput = await agent.execute(task, this.workflowState);
        task.output = output;
        task.updatedAt = new Date();

        if (output.sharedContextUpdates) {
          this.workflowState.sharedContext = {
            ...this.workflowState.sharedContext,
            ...output.sharedContextUpdates,
          };
          console.log(`WorkflowManager.executeWorkflow: SharedContext updated by ${agent.name} for task ${task.id}:`, output.sharedContextUpdates);
        }

        if (output.status === 'failure') {
          task.status = 'failed';
          task.error = output.error || `Agent ${agent.name} reported failure.`;
          this.workflowState.status = 'failed';
          console.error(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) failed: ${task.error}`);
          // Save state and break
          await this.storageService.save(this.workflowState.workflowId, this.workflowState)
              .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state for agent failure:", err));
          break; 
        }

        if (output.actionString && this.actionRunner) {
          console.log(`WorkflowManager.executeWorkflow: Executing action string for task ${task.id}: ${output.actionString.substring(0, 100)}...`);
          const actionData = this.parseBoltActionString(output.actionString, task.id);

          if (actionData) {
            this.actionRunner.addAction(actionData);
            await this.actionRunner.runAction(actionData);
            const executedActionState = this.actionRunner.actions.get()[actionData.actionId];

            if (executedActionState?.status === 'failed') {
              task.status = 'failed';
              task.error = executedActionState.error || 'ActionRunner failed to execute action.';
              this.workflowState.status = 'failed';
              console.error(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) action failed: ${task.error}`);
              await this.storageService.save(this.workflowState.workflowId, this.workflowState)
                  .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state for action failure:", err));
              break;
            } else if (executedActionState?.status === 'complete') {
              task.status = 'completed';
              console.log(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) action executed successfully.`);
            } else {
              task.status = 'failed';
              task.error = `Action did not complete as expected: ${executedActionState?.status}`;
              this.workflowState.status = 'failed';
              console.error(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) action status unexpected: ${executedActionState?.status}`);
              await this.storageService.save(this.workflowState.workflowId, this.workflowState)
                  .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state for unexpected action status:", err));
              break;
            }
          } else {
            task.status = 'failed';
            task.error = 'Failed to parse actionString from agent.';
            this.workflowState.status = 'failed';
            console.error(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) failed: ${task.error}`);
            await this.storageService.save(this.workflowState.workflowId, this.workflowState)
                .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state for action string parsing failure:", err));
            break;
          }
        } else if (output.actionString && !this.actionRunner) {
            task.status = 'failed';
            task.error = `Agent ${agent.name} produced an actionString but ActionRunner is not available.`;
            this.workflowState.status = 'failed';
            console.error(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) failed: ${task.error}`);
            await this.storageService.save(this.workflowState.workflowId, this.workflowState)
                .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state for missing ActionRunner:", err));
            break;
        } else {
          task.status = 'completed'; // Agent handled internally, no action string
          console.log(`WorkflowManager.executeWorkflow: Task ${task.id} (agent: ${agent.name}) completed by agent (no action or ActionRunner not used).`);
        }
        task.completedAt = new Date();
        task.updatedAt = new Date();

      } catch (error: any) {
        task.status = 'failed';
        task.error = error.message || `Agent ${agent.name} execution threw an unhandled error.`;
        task.completedAt = new Date();
        task.updatedAt = new Date();
        this.workflowState.status = 'failed';
        console.error(`WorkflowManager.executeWorkflow: Error executing task ${task.id} with agent ${agent.name}:`, error);
        await this.storageService.save(this.workflowState.workflowId, this.workflowState)
            .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save error state after agent.execute() threw:", err));
        break;
      }

      this.workflowState.currentTaskIndex = i + 1;
      // Save progress after each task successfully processed or handled
      await this.storageService.save(this.workflowState.workflowId, this.workflowState)
          .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save state after task processing:", err));
      
      // If workflow failed during task execution, exit loop
      if (this.workflowState.status === 'failed') {
          console.log(`WorkflowManager.executeWorkflow: Workflow status is 'failed', exiting task loop.`);
          break;
      }
    }

    // Final status check and save
    if (this.workflowState.status !== 'failed' && this.workflowState.status !== 'running') {
      const allTasksCompleted = this.workflowState.tasks.every(t => t.status === 'completed');
      if (allTasksCompleted) {
        this.workflowState.status = 'completed';
        console.log(`WorkflowManager.executeWorkflow: Workflow ${this.workflowState.workflowId} completed successfully.`);
      } else {
        // If not all tasks are completed, but the loop finished and status isn't 'failed'
        // This could mean it was paused, or there's an unhandled state.
        // For now, if it's not 'running' or 'failed', and not all tasks are 'completed', mark as 'failed'.
        this.workflowState.status = 'failed';
        console.log(`WorkflowManager.executeWorkflow: Workflow ${this.workflowState.workflowId} finished with incomplete tasks.`);
      }
    } else if (this.workflowState.status === 'running') {
        // If loop finished but status is still 'running', it implies not all tasks were processed to completion or failure.
        // This typically means currentTaskIndex < tasks.length but loop exited.
        // Let's check if all tasks are done; if so, it's 'completed'. Otherwise, 'failed'.
        const allTasksCompleted = this.workflowState.tasks.every(t => t.status === 'completed');
        if (allTasksCompleted && this.workflowState.currentTaskIndex === this.workflowState.tasks.length) {
            this.workflowState.status = 'completed';
        } else if (this.workflowState.tasks.some(t => t.status === 'failed')) {
             this.workflowState.status = 'failed';
        } else {
            // If some tasks are still pending or running, and no failures, it might be 'paused' or 'incomplete'.
            // Forcing to 'failed' if not explicitly 'completed'.
            this.workflowState.status = 'failed';
            console.log(`WorkflowManager.executeWorkflow: Workflow ${this.workflowState.workflowId} is in an indeterminate 'running' state post-loop; marking as failed.`);
        }
    }
    
    await this.storageService.save(this.workflowState.workflowId, this.workflowState)
        .catch(err => console.error("WorkflowManager.executeWorkflow: Failed to save final workflow state:", err));

    console.log(`WorkflowManager.executeWorkflow: Finished execution for workflow ${this.workflowState.workflowId}. Final status: ${this.workflowState.status}`);
    return Promise.resolve();
  }

  /**
   * Processes a new user input in an ongoing workflow, potentially re-planning and continuing execution.
   * @param userInput The new input from the user.
   */
  public async processTurn(userInput: string): Promise<void> {
    console.log(`WorkflowManager.processTurn: Processing new user input for workflow ${this.workflowState.workflowId}`);

    // Update workflow state for the new turn
    this.workflowState.status = 'processing_turn'; 
    // Add new user input to conversation history
    this.workflowState.sharedContext.conversationHistory = [
      ...(this.workflowState.sharedContext.conversationHistory || []),
      { role: 'user', content: userInput }
    ];
    // Optionally, append to originalUserInput as well if some agents rely on it directly, though history is preferred
    // this.workflowState.originalUserInput += `\n\nUser (Turn ${this.workflowState.sharedContext.conversationHistory.length}): ${userInput}`;

    try {
      await this.storageService.save(this.workflowState.workflowId, this.workflowState);
    } catch (err) {
      console.error("WorkflowManager.processTurn: Failed to save state before re-engaging PlanningAgent:", err);
      // Decide if to proceed or mark as failed
      this.workflowState.status = 'failed';
      this.workflowState.error = "Failed to save state during turn processing.";
      await this.storageService.save(this.workflowState.workflowId, this.workflowState).catch(e => console.error("WorkflowManager.processTurn: Critical - failed to save error state:", e));
      return;
    }

    // Re-engage Planning Agent
    const planningAgent = this.agents.get('PlanningAgent') as PlanningAgent | undefined;
    if (!planningAgent) {
      console.error("WorkflowManager.processTurn: PlanningAgent not registered!");
      this.workflowState.status = 'failed';
      this.workflowState.error = "PlanningAgent not available for multi-turn.";
      await this.storageService.save(this.workflowState.workflowId, this.workflowState).catch(e => console.error("WorkflowManager.processTurn: Failed to save error state for missing PlanningAgent:", e));
      return;
    }

    const planningTaskInput: AgentInput = {
      conversationHistory: this.workflowState.sharedContext.conversationHistory,
      existingTasks: this.workflowState.tasks.filter(t => t.status !== 'completed'),
      // originalUserInput: this.workflowState.originalUserInput, // Pass if needed by PlanningAgent's prompt
    };

    const planningMetaTask: Task = {
      id: this.generateId('task_plan_turn_'),
      agentName: 'PlanningAgent',
      input: planningTaskInput,
      status: 'pending', // This task itself is pending, its output will be new tasks for the workflow
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    this.workflowState.status = 'planning'; // Workflow is now in planning phase for the new turn
    await this.storageService.save(this.workflowState.workflowId, this.workflowState).catch(err => console.error("WorkflowManager.processTurn: Failed to save state before PlanningAgent.execute:", err));

    let planningOutput: AgentOutput;
    try {
      planningOutput = await planningAgent.execute(planningMetaTask, this.workflowState);
    } catch (error: any) {
      console.error("WorkflowManager.processTurn: PlanningAgent.execute threw an error:", error);
      this.workflowState.status = 'failed';
      this.workflowState.error = `PlanningAgent execution error: ${error.message}`;
      await this.storageService.save(this.workflowState.workflowId, this.workflowState).catch(e => console.error("WorkflowManager.processTurn: Failed to save error state after PlanningAgent exception:", e));
      return;
    }

    // Process Planning Output
    if (planningOutput.status === 'failure' || !planningOutput.plannedTasks) {
      console.error("WorkflowManager.processTurn: PlanningAgent failed to provide new tasks.", planningOutput.error);
      this.workflowState.status = 'failed';
      this.workflowState.error = planningOutput.error || "Planning for the new turn failed.";
      await this.storageService.save(this.workflowState.workflowId, this.workflowState).catch(e => console.error("WorkflowManager.processTurn: Failed to save error state after planning failure:", e));
      return;
    }

    const newTasks = planningOutput.plannedTasks;
    console.log(`WorkflowManager.processTurn: New plan received with ${newTasks.length} tasks.`);

    // Task Management: Replace non-completed tasks with the new plan
    this.workflowState.tasks = [
      ...this.workflowState.tasks.filter(t => t.status === 'completed'), 
      ...newTasks
    ];
    
    // Reset currentTaskIndex to the first non-completed task in the updated list
    this.workflowState.currentTaskIndex = this.workflowState.tasks.findIndex(
        task => task.status === 'pending' || task.status === 'running'
    );
    if (this.workflowState.currentTaskIndex === -1 && this.workflowState.tasks.some(t => t.status !== 'completed')) {
        // This case should ideally not happen if findIndex works correctly and newTasks are 'pending'
        // But as a fallback, if there are non-completed tasks, start from the first one.
        this.workflowState.currentTaskIndex = 0; 
    } else if (this.workflowState.currentTaskIndex === -1) {
        // All tasks are completed, or no tasks to run.
        // If newTasks were added, currentTaskIndex should point to them.
        // If newTasks is empty and all old tasks are completed, it will remain -1.
        // executeWorkflow will handle this by marking workflow as completed if no tasks.
    }


    // Update shared context if planning agent provided updates
    if (planningOutput.sharedContextUpdates) {
      this.workflowState.sharedContext = {
        ...this.workflowState.sharedContext,
        ...planningOutput.sharedContextUpdates,
      };
      console.log("WorkflowManager.processTurn: SharedContext updated by PlanningAgent:", planningOutput.sharedContextUpdates);
    }

    this.workflowState.status = 'pending'; // Ready to execute the (potentially updated) task list
    try {
      await this.storageService.save(this.workflowState.workflowId, this.workflowState);
    } catch (err) {
       console.error("WorkflowManager.processTurn: Failed to save state before calling executeWorkflow:", err);
       // Potentially mark as failed and return
    }
    
    // Execute Workflow (will pick up from currentTaskIndex)
    await this.executeWorkflow();
  }

  /**
   * Gets the current state of the workflow.
   * @returns The current workflow state.
   */
  public getWorkflowState(): WorkflowState {
    return this.workflowState;
  }

  /**
   * Parses a <boltAction> string into an ActionCallbackData object.
   * @param actionString The XML-like string from an agent.
   * @param taskId The ID of the task requesting the action.
   * @returns ActionCallbackData if parsing is successful, null otherwise.
   */
  private parseBoltActionString(actionString: string, taskId: string): ActionCallbackData | null {
    const typeMatch = actionString.match(/type="([^"]+)"/);
    const actionType = typeMatch ? typeMatch[1] : null;

    if (!actionType) {
      console.error("WorkflowManager.parseBoltActionString: Could not parse action type from string:", actionString);
      return null;
    }

    // Use a more specific prefix for action IDs if desired
    const actionId = `${taskId}_action_${this.generateId('act_')}`; 

    if (actionType === 'file') {
      const filePathMatch = actionString.match(/filePath="([^"]+)"/);
      const contentMatch = actionString.match(/content="((?:.|\r|\n)*?)"(?:\s|>|$)/);
      
      if (filePathMatch && contentMatch) {
        const unescapedContent = contentMatch[1]
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        return {
          actionId,
          action: {
            type: 'file', filePath: filePathMatch[1], content: unescapedContent,
            changeSource: 'agent', 
          } as FileAction,
        };
      } else {
        console.error("WorkflowManager.parseBoltActionString: FileAction missing filePath or content:", actionString);
      }
    } else if (actionType === 'shell') {
      const contentMatch = actionString.match(/content="((?:.|\r|\n)*?)"(?:\s|>|$)/);
      if (contentMatch) {
         const unescapedContent = contentMatch[1]
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        return {
          actionId,
          action: { type: 'shell', content: unescapedContent } as ShellAction,
        };
      } else {
        console.error("WorkflowManager.parseBoltActionString: ShellAction missing content:", actionString);
      }
    } else {
        console.error(`WorkflowManager.parseBoltActionString: Unsupported action type "${actionType}" from string:`, actionString);
    }
    return null;
  }
}
