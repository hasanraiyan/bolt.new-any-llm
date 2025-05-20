// app/lib/agents/PlanningAgent.ts

import { generateText } from 'ai';
import type { LLMManager } from '~/lib/modules/llm/manager';
import type { Agent, Task, WorkflowState, AgentInput, AgentOutput } from '../workflow/types';

/**
 * PlanningAgent analyzes the user's request and breaks it down into a sequence of tasks.
 */
export class PlanningAgent implements Agent {
  public readonly name = "PlanningAgent";
  public readonly description = "Analyzes the user's request and breaks it down into a sequence of tasks for other agents.";
  private llmManager: LLMManager;

  /**
   * Creates an instance of PlanningAgent.
   * @param llmManager An instance of LLMManager to interact with language models.
   */
  constructor(llmManager: LLMManager) {
    this.llmManager = llmManager;
  }

  /**
   * Generates a unique ID for tasks.
   * @returns A unique string ID.
   */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  /**
   * Executes the planning task. It takes the user's input and breaks it down into a series of tasks.
   * @param task The current task, which for PlanningAgent might just be a trigger.
   * @param workflowState The current state of the workflow, containing the original user input.
   * @returns A promise that resolves to an AgentOutput containing the list of planned tasks.
   */
  public async execute(task: Task, workflowState: WorkflowState): Promise<AgentOutput> {
    const userInput = workflowState.originalUserInput;
    if (!userInput) {
      throw new Error("Original user input is missing in workflowState.");
    }

    // Use task.input.request if available and relevant, otherwise default to originalUserInput
    // For PlanningAgent, the primary input is typically the overall goal.
    const planningRequest = (task.input?.request as string) || userInput;

    const systemPrompt = `You are an expert project planner. Your goal is to break down the user's request into a sequence of actionable tasks.
Each task should be assigned to one of the following specialized agents:
- FileAgent: Handles file creation, modification, reading, or deletion.
- CodeAgent: Handles writing, modifying, or analyzing code within files.
- ShellAgent: Handles executing shell commands in a terminal.
- ReviewAgent: Handles reviewing changes, asking clarifying questions, or requesting user approval.

Based on the user's request, provide a numbered list of tasks. Each line must strictly follow the format: "Number. AgentName Action description"
Example:
User Request: Create a python script that prints 'Hello World', then run it, and finally list files in the current directory.
Output:
1. FileAgent Create a new file named 'main.py'.
2. CodeAgent Write the following Python code into 'main.py': print('Hello World').
3. ShellAgent Execute the command 'python main.py'.
4. ShellAgent List files in the current directory.

User Request: ${planningRequest}
Output:`;

    try {
      // Assume llmManager is pre-configured or can get a default model
      // The actual method to get a model might vary (e.g., getDefaultModel, getModel with specific params)
      const model = this.llmManager.getModel(); // Simplified assumption
      if (!model) {
        throw new Error("LLM model could not be obtained from LLMManager.");
      }

      console.log(`PlanningAgent: Sending request to LLM for input: "${planningRequest}"`);
      const llmResponse = await generateText({
        model: model,
        prompt: systemPrompt,
      });

      const llmTextOutput = llmResponse.text.trim();
      console.log(`PlanningAgent: Received LLM output:\n${llmTextOutput}`);

      const plannedTasks: Task[] = [];
      const lines = llmTextOutput.split('\n');

      // Regex to parse lines like "1. FileAgent Create a new file named 'script.py'."
      const taskRegex = /^\s*\d+\.\s*([a-zA-Z]+Agent)\s+(.+)$/;

      for (const line of lines) {
        const match = line.trim().match(taskRegex);
        if (match) {
          const [, agentName, actionDescription] = match;
          const newTask: Task = {
            id: this.generateId(),
            agentName: agentName.trim(),
            input: { 
              action: actionDescription.trim(),
              originalUserInput: userInput, // Include original request for context
              dependencyOutput: {} // To be filled by previous tasks if needed
            },
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            // dependencies will be set by WorkflowManager based on sequence
          };
          plannedTasks.push(newTask);
        } else {
          console.warn(`PlanningAgent: Could not parse task line: "${line}"`);
        }
      }

      if (plannedTasks.length === 0 && llmTextOutput.length > 0) {
        // This might happen if the LLM doesn't follow the format or if the request is too simple for a multi-task plan.
        console.warn("PlanningAgent: LLM output was received, but no tasks could be parsed according to the expected format.");
        // Potentially create a single "fallback" task or let the workflow handle it.
        // For now, returning an empty list and letting the workflow manager decide.
      }
      
      console.log(`PlanningAgent: Successfully planned ${plannedTasks.length} tasks.`);
      return {
        status: "success",
        plannedTasks: plannedTasks,
        sharedContextUpdates: {
          rawPlanText: llmTextOutput,
          plannedTaskObjects: plannedTasks 
        }
      };

    } catch (error: any) {
      console.error("PlanningAgent: Error during LLM call or parsing:", error);
      return {
        status: "failure",
        error: `PlanningAgent failed to execute: ${error.message}`,
        plannedTasks: [] // Ensure plannedTasks is always defined, even on failure
      };
    }
  }
}
