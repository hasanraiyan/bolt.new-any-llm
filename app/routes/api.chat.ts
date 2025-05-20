import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, generateId } from 'ai';
// import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants'; // Workflow handles this
// import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts'; // Workflow handles this
// import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text'; // Replaced by WorkflowManager
import type { Messages } from '~/lib/.server/llm/stream-text'; // Keep Messages type for request parsing
import SwitchableStream from '~/lib/.server/llm/switchable-stream'; // Keep for now, might remove if dataStream handles all
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
// import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context'; // Workflow PlanningAgent handles context
// import type { ContextAnnotation, ProgressAnnotation } from '~/types/context'; // Workflow will stream different annotations
// import { WORK_DIR } from '~/utils/constants'; // May be used by agents directly
// import { createSummary } from '~/lib/.server/llm/create-summary'; // Workflow PlanningAgent handles this
// import { extractPropertiesFromMessage } from '~/lib/.server/llm/utils'; // May be used by agents

// Workflow Imports
import { WorkflowManager } from '~/lib/workflow/WorkflowManager';
import { PlanningAgent } from '~/lib/agents/PlanningAgent';
import { FileAgent } from '~/lib/agents/FileAgent';
import { CodeAgent } from '~/lib/agents/CodeAgent';
import { LLMManager } from '~/lib/modules/llm/manager';
import { WebContainerEngine } from '~/lib/webcontainer'; // Assuming this is the correct path

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

async function chatAction({ context, request }: ActionFunctionArgs) {
  const { messages /*, files, promptId, contextOptimization, supabase */ } = await request.json<{
    messages: Messages;
    files: any; // Keep for now, agents might need it
    promptId?: string;
    contextOptimization: boolean;
    supabase?: { // Keep for now, agents might need it
      isConnected: boolean;
      hasSelectedProject: boolean;
      credentials?: {
        anonKey?: string;
        supabaseUrl?: string;
      };
    };
  }>();

  // const cookieHeader = request.headers.get('Cookie'); // LLMManager handles API keys from env
  // const apiKeys = JSON.parse(parseCookies(cookieHeader || '').apiKeys || '{}');
  // const providerSettings: Record<string, IProviderSetting> = JSON.parse(
  //   parseCookies(cookieHeader || '').providers || '{}',
  // );

  // const stream = new SwitchableStream(); // Replaced by direct dataStream usage

  // const cumulativeUsage = { // Usage will be tracked by WorkflowManager or Agents if necessary
  //   completionTokens: 0,
  //   promptTokens: 0,
  //   totalTokens: 0,
  // };
  const encoder: TextEncoder = new TextEncoder(); // Keep for custom stream messages if needed

  try {
    const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
    if (!lastUserMessage || !lastUserMessage.content) {
      throw new Error("No user message found or message content is empty.");
    }
    const initialUserMessageContent = lastUserMessage.content;
    logger.debug(`Initial user message: ${initialUserMessageContent}`);

    // Instantiate LLMManager
    // Ensure context.cloudflare.env is correctly typed or cast if necessary for LLMManager
    const llmManager = LLMManager.getInstance(context.cloudflare?.env as Record<string, string> || {});
    
    // Get WebContainer promise (ActionRunner needs this)
    // For now, direct instantiation. In a real app, this might be a singleton service.
    let webcontainerPromise;
    try {
      // WebContainerEngine might not be initializable in all serverless environments
      // or might need specific setup.
      webcontainerPromise = WebContainerEngine.getInstance().getWebContainer();
    } catch (wcError) {
      logger.warn("WebContainerEngine could not be initialized or getWebContainer failed:", wcError);
      webcontainerPromise = undefined; // Proceed without WebContainer if it fails
    }
    
    // getShellTerminal is a client-side utility, pass undefined for now.
    const getShellTerminal = undefined;

    // Instantiate WorkflowManager
    const workflowManager = new WorkflowManager(
      initialUserMessageContent,
      llmManager,
      webcontainerPromise,
      getShellTerminal
    );

    // Register Agents
    workflowManager.registerAgent(new PlanningAgent(llmManager));
    workflowManager.registerAgent(new FileAgent()); // FileAgent constructor doesn't require llmManager
    workflowManager.registerAgent(new CodeAgent(llmManager)); // CodeAgent can take optional llmManager

    const dataStream = createDataStream({
      async execute(stream) {
        try {
          logger.info("Workflow starting...");
          stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'starting', message: 'Workflow initialized.' });

          await stream.sleep(100); // Give client a moment to receive initial status

          logger.info("Planning phase...");
          stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'planning', message: 'Generating task plan...' });
          await workflowManager.plan();
          const plannedTasks = workflowManager.getWorkflowState().tasks;
          logger.info(`Planning complete. Tasks: ${JSON.stringify(plannedTasks.map(t => ({id: t.id, agent: t.agentName})))}`);
          stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'planningComplete', plan: plannedTasks, message: `Planning complete. ${plannedTasks.length} tasks generated.` });

          await stream.sleep(100);

          logger.info("Execution phase...");
          stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'executing', message: 'Starting task execution...' });
          await workflowManager.executeWorkflow(); // This will be enhanced later to stream individual task updates
          
          const finalState = workflowManager.getWorkflowState();
          logger.info(`Workflow execution finished. Status: ${finalState.status}`);

          if (finalState.status === 'completed') {
            stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'workflowCompleted', finalState, message: 'Workflow completed successfully.' });
            // Consider sending a structured final output or summary from the workflow if available
            stream.write("Workflow completed successfully. All tasks executed.");
          } else { // 'failed' or other non-completed states
            stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'workflowFailed', finalState, message: `Workflow failed. Error: ${finalState.tasks.find(t=>t.status === 'failed')?.error}` });
            stream.write(`Workflow failed. Last status: ${finalState.status}. Check tasks for details.`);
          }
        } catch (err: any) {
            logger.error("Error during workflow execution in stream:", err);
            stream.writeMessageAnnotation({ type: 'workflowStatus', status: 'error', message: `Workflow error: ${err.message}` });
            stream.write(`Error during workflow: ${err.message}`);
        } finally {
            logger.info("Closing data stream.");
            stream.close();
        }
      },
      onError: (error: any) => {
        logger.error("DataStream onError:", error);
        // This message will be sent to the client if an error occurs in the execute function before stream.close()
        return `Workflow processing error: ${error.message}`;
      },
    });
    
    // The existing TransformStream for <div class="__boltThought__"> might not be relevant
    // for workflow updates, or might need to be adapted. For now, let's simplify and remove it.
    // If specific formatting for workflow messages is needed, it can be added back.

    return new Response(dataStream.readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        // 'Text-Encoding': 'chunked', // Not standard and often not needed with event-stream
      },
    });

  } catch (error: any) {
    logger.error("Outer catch block error in chatAction:", error);

    if (error.message?.includes('API key')) { // This check might be less relevant if LLMManager handles keys
      return new Response('Invalid or missing API key', { // Return Response, don't throw for client
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    // For other errors, return a generic 500
    return new Response(`Server error: ${error.message}`, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
