// app/lib/agents/FileAgent.ts

import type { Agent, Task, WorkflowState, AgentInput, AgentOutput } from '../workflow/types';

/**
 * FileAgent handles file operations like creating, writing, or deleting files.
 */
export class FileAgent implements Agent {
  public readonly name = "FileAgent";
  public readonly description = "Handles file operations like creating, writing, or deleting files.";

  /**
   * Creates an instance of FileAgent.
   */
  constructor() {
    // Constructor can be extended if needed, e.g., with an LLMManager
  }

  /**
   * Executes the file operation task.
   * @param task The task containing input for the file operation.
   * @param workflowState The current state of the workflow.
   * @returns A promise that resolves to an AgentOutput containing the boltAction string or an error.
   */
  public async execute(task: Task, workflowState: WorkflowState): Promise<AgentOutput> {
    const { filePath, content, operation = 'create' } = task.input as {
      filePath?: string;
      content?: string;
      operation?: 'create' | 'append' | 'delete';
    };

    if (!filePath) {
      console.error("FileAgent: Missing filePath in task input.");
      return { error: "Missing filePath for FileAgent", status: "failure" };
    }

    let actionString: string;

    switch (operation) {
      case 'create':
      case 'append': // For now, append is treated as create (overwrite)
        if (typeof content !== 'string') { // content can be an empty string, so check type
          console.error("FileAgent: Missing content for create/append operation.");
          return { error: "Missing content for FileAgent create/append operation", status: "failure" };
        }
        console.log(`FileAgent: Preparing to ${operation} file '${filePath}' with content: "${content.substring(0, 50)}..."`);
        actionString = `<boltAction type="file" filePath="${filePath}" content="${this.escapeXml(content)}"></boltAction>`;
        break;
      
      case 'delete':
        console.log(`FileAgent: Preparing to delete file '${filePath}'`);
        actionString = `<boltAction type="shell" content="rm ${this.escapeXml(filePath)}"></boltAction>`;
        break;

      default:
        console.error(`FileAgent: Unknown operation '${operation}'`);
        return { error: `Unknown operation '${operation}' for FileAgent`, status: "failure" };
    }
    
    return { actionString, status: "success" };
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
