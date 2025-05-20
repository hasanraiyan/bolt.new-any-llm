// app/lib/agents/CodeAgent.ts

import type { Agent, Task, WorkflowState, AgentInput, AgentOutput } from '../workflow/types';
import type { LLMManager } from '~/lib/modules/llm/manager'; // Optional LLMManager

/**
 * CodeAgent handles writing or modifying code within files.
 * It can either write provided code directly or use an LLM to generate code based on a description (future).
 */
export class CodeAgent implements Agent {
  public readonly name = "CodeAgent";
  public readonly description = "Handles writing or modifying code within files, potentially using an LLM for code generation.";

  /**
   * Creates an instance of CodeAgent.
   * @param llmManager Optional LLMManager for future code generation capabilities.
   */
  constructor(private llmManager?: LLMManager) {
    // this.llmManager can be used in the future to generate code from description
  }

  /**
   * Executes the code writing/modification task.
   * @param task The task containing input for the code operation.
   * @param workflowState The current state of the workflow.
   * @returns A promise that resolves to an AgentOutput containing the boltAction string or an error.
   */
  public async execute(task: Task, workflowState: WorkflowState): Promise<AgentOutput> {
    const { filePath, codeContent, codeDescription, language } = task.input as {
      filePath?: string;
      codeContent?: string;
      codeDescription?: string;
      language?: string; // For future use with LLM
    };

    if (!filePath) {
      console.error("CodeAgent: Missing filePath in task input.");
      return { error: "Missing filePath for CodeAgent", status: "failure" };
    }

    let actionString: string;
    let message: string | undefined;

    if (typeof codeContent === 'string') {
      console.log(`CodeAgent: Writing provided code to file '${filePath}'.`);
      actionString = `<boltAction type="file" filePath="${this.escapeXml(filePath)}" content="${this.escapeXml(codeContent)}"></boltAction>`;
    } else if (typeof codeDescription === 'string') {
      console.log(`CodeAgent: LLM code generation path for description: "${codeDescription}" (using placeholder).`);
      // In the future, this part would involve calling this.llmManager
      // For now, using a placeholder as specified.
      const placeholderCode = `// TODO: Implement code for: ${this.escapeXml(codeDescription)}\n// Language: ${language || 'unknown'}`;
      actionString = `<boltAction type="file" filePath="${this.escapeXml(filePath)}" content="${this.escapeXml(placeholderCode)}"></boltAction>`;
      message = "Used placeholder for LLM generation";
    } else {
      console.error("CodeAgent: Missing codeContent or codeDescription in task input.");
      return { error: "Missing filePath and (codeContent or codeDescription) for CodeAgent", status: "failure" };
    }
    
    return { actionString, status: "success", message };
  }

  /**
   * Escapes XML special characters for content and attributes.
   * @param str The string to escape.
   * @returns The escaped string.
   */
  private escapeXml(str: string): string {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"']/g, (match) => {
      switch (match) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '"': return '&quot;';
        case "'": return '&apos;';
        default: return match;
      }
    });
  }
}
