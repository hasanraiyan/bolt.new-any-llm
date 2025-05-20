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

    const {
      request, // This would be the initial request for a new plan
      conversationHistory, // For multi-turn
      existingTasks // For multi-turn
    } = task.input as { 
      request?: string; 
      conversationHistory?: Array<{role: string, content: string}>;
      existingTasks?: Task[];
    };

    let latestUserRequest = request || "";
    if (conversationHistory && conversationHistory.length > 0) {
        const lastUserMsg = conversationHistory.filter(m => m.role === 'user').pop();
        if (lastUserMsg) latestUserRequest = lastUserMsg.content;
    }
    
    if (!latestUserRequest && !userInput) { // userInput is workflowState.originalUserInput
        return {
            status: "failure",
            error: "PlanningAgent: No user input or planning request provided.",
            plannedTasks: [],
        };
    }
    // Fallback to originalUserInput if no specific request or history latest found
    if (!latestUserRequest) latestUserRequest = userInput;


    const formattedConvHistory = this.formatConversationHistory(conversationHistory);
    const formattedExistingTasks = this.formatExistingTasks(existingTasks);

    const systemPrompt = `You are an expert project planner. Your goal is to break down the user's request into a sequence of actionable tasks, considering the ongoing conversation history and any existing, incomplete tasks.

CONVERSATION HISTORY (if any):
${formattedConvHistory}

EXISTING INCOMPLETE TASKS (if any, these were planned previously but not completed):
${formattedExistingTasks}

Based on the LATEST user message in the conversation history (or the primary request if no history), provide a NEW list of tasks to achieve the user's latest request. You can choose to continue or modify the previous plan if appropriate, or suggest a new set of tasks.
Each task should be assigned to one of the following specialized agents:
- FileAgent: Handles file creation, modification, reading, or deletion.
- CodeAgent: Handles writing, modifying, or analyzing code within files.
- ShellAgent: Handles executing shell commands in a terminal.
- ReviewAgent: Handles reviewing changes, asking clarifying questions, or requesting user approval.

Strictly follow the format: "Number. AgentName Action description" for each task.
Example:
1. FileAgent Create a new file named 'main.py'.
2. CodeAgent Write the following Python code into 'main.py': print('Hello World').

LATEST USER REQUEST: ${latestUserRequest}
Output (NEW list of tasks based on latest request):`;

    try {
      const model = this.llmManager.getModel();
      if (!model) {
        console.error("PlanningAgent: LLM model could not be obtained from LLMManager.");
        return { status: "failure", error: "LLM model not available", plannedTasks: [] };
      }

      console.log(`PlanningAgent: Sending request to LLM for input: "${latestUserRequest}"`);
      const llmResponse = await generateText({
        model: model,
        prompt: systemPrompt,
        // Consider adding parameters like temperature if needed for planning quality
      });

      const llmTextOutput = llmResponse.text.trim();
      console.log(`PlanningAgent: Received LLM output:\n${llmTextOutput}`);

      const newPlannedTasks: Task[] = []; // Changed variable name for clarity
      const lines = llmTextOutput.split('\n');

      // Regex to parse lines like "1. FileAgent Create a new file named 'script.py'."
      const taskRegex = /^\s*\d+\.\s*([a-zA-Z]+Agent)\s+(.+)$/;

      for (const line of lines) {
        const match = line.trim().match(taskRegex);
        if (match) {
          const [, agentName, actionDescription] = match;
          const newTask: Task = {
            id: this.generateId(), // Ensure unique IDs for new tasks
            agentName: agentName.trim(),
            input: { 
              action: actionDescription.trim(),
              // originalUserInput: userInput, // Retain for context if needed, but primary is latestUserRequest
              latestUserRequest: latestUserRequest, // Store the request that generated this task
              // conversationHistory can be large, decide if it needs to be in each task's input
            },
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            dependencies: [], // Dependencies will be managed by WorkflowManager if multi-step plans are generated
          };
          newPlannedTasks.push(newTask);
        } else {
          console.warn(`PlanningAgent: Could not parse task line: "${line}"`);
        }
      }

      if (newPlannedTasks.length === 0 && llmTextOutput.length > 0) {
        console.warn("PlanningAgent: LLM output was received, but no tasks could be parsed according to the expected format.");
        // Optionally, return a specific error or a "clarification" task
      }
      
      console.log(`PlanningAgent: Successfully planned ${newPlannedTasks.length} new tasks.`);
      return {
        status: "success",
        plannedTasks: newPlannedTasks, // Return the newly generated tasks
        sharedContextUpdates: {
          rawPlanText: llmTextOutput, // Keep raw text for auditing/debugging
          plannedTaskObjects: newPlannedTasks, // Keep new tasks for auditing/debugging
        }
      };

    } catch (error: any) {
      console.error("PlanningAgent: Error during LLM call or parsing:", error);
      return {
        status: "failure",
        error: `PlanningAgent failed to execute: ${error.message}`,
        plannedTasks: []
      };
    }
  }

  private formatConversationHistory(history?: Array<{role: string, content: string}>): string {
    if (!history || history.length === 0) return "No prior conversation history.";
    return history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n');
  }

  private formatExistingTasks(tasks?: Task[]): string {
    if (!tasks || tasks.length === 0) return "No existing incomplete tasks.";
    return tasks.map(task => `- Task ID: ${task.id}, Agent: ${task.agentName}, Status: ${task.status}, Input: ${JSON.stringify(task.input)}`).join('\n');
  }

  // getLatestUserRequest is handled within the execute method now.
}
