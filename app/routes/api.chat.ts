// Remix and Vercel AI SDK imports
import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream } from 'ai'; // generateId is not needed here
import type { Messages } from '~/lib/.server/llm/stream-text'; // Keep Messages type for request parsing

// Logging and Utility imports
import { createScopedLogger } from '~/utils/logger';

// Workflow specific imports
import { WorkflowManager } from '~/lib/workflow/WorkflowManager';
import { PlanningAgent } from '~/lib/agents/PlanningAgent';
import { FileAgent } from '~/lib/agents/FileAgent';
import { CodeAgent } from '~/lib/agents/CodeAgent';
import { LLMManager } from '~/lib/modules/llm/manager';

// Potentially problematic server-side imports (handle gracefully)
import { WebContainerEngine } from '~/lib/webcontainer'; // Attempt to import
import type { WebContainer } from '@webcontainer/api'; // For type annotation
import type { BoltShell } from '~/utils/shell'; // For type annotation

export async function action(args: ActionFunctionArgs) {
  return chatAction(args);
}

const logger = createScopedLogger('api.chat');

// Removed parseCookies as API keys are expected to be handled by LLMManager via environment variables

async function chatAction({ context, request }: ActionFunctionArgs) {
  const { 
    messages, 
    // files, // Not directly used by chatAction, but agents might need them via sharedContext if passed in
    // promptId, // Similarly, for agents if needed
    // contextOptimization, // For agents
    // supabase, // For agents
    workflowId: incomingWorkflowId // New: for multi-turn
  } = await request.json<{
    messages: Messages;
    files?: any; 
    promptId?: string;
    contextOptimization?: boolean;
    supabase?: any; 
    workflowId?: string; 
  }>();

  // Robustly extract the last user message content
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
      logger.error("api.chat: No user message found or last message isn't from user.", { messages });
      return new Response("No user message found or last message role is not 'user'.", { status: 400 });
  }
  // Ensure content is a string. If it's an object (e.g. for multimodal), stringify it.
  const currentUserMessageContent: string = typeof lastMessage.content === 'string' 
    ? lastMessage.content 
    : JSON.stringify(lastMessage.content);
  
  if (currentUserMessageContent === '[object Object]') {
      logger.warn("api.chat: Detected '[object Object]' as user message content. This usually means an object was stringified by default. Ensure message content is properly stringified if it's complex.", { originalContent: lastMessage.content });
  }
  logger.debug(`api.chat: Current user message content: "${currentUserMessageContent.substring(0, 100)}..."`);


  // Initialize LLMManager (should be robust to missing env vars if handled by LLMManager)
  const llmManager = LLMManager.getInstance(context.cloudflare?.env as Record<string, string> || {});
  
  // WebContainer and Shell Setup (Graceful handling)
  let webcontainerPromise: Promise<WebContainer> | undefined;
  let shellTerminalGetter: (() => BoltShell) | undefined; // Remains undefined for server-side
  try {
      const wcEngine = WebContainerEngine.getInstance();
      if (wcEngine) {
          webcontainerPromise = wcEngine.getWebContainer();
          // shellTerminalGetter = getShellTerminal; // Cannot be assigned server-side
          logger.info("api.chat: WebContainerEngine accessed. ActionRunner capabilities depend on successful promise resolution.");
      } else {
          logger.warn("api.chat: WebContainerEngine.getInstance() returned undefined. ActionRunner will be limited (no WebContainer access).");
      }
  } catch (e: any) { // Catch any error during instantiation or method call
      logger.warn(`api.chat: Failed to initialize WebContainerEngine or getShellTerminal. ActionRunner functionality will be limited. Error: ${e.message}`, e);
  }

  // Setup Vercel AI SDK DataStream
  const stream = createDataStream(); // Correct way to initialize
  try { // Outer try block begins here
    // Initialize LLMManager (should be robust to missing env vars if handled by LLMManager)
    const llmManager = LLMManager.getInstance(context.cloudflare?.env as Record<string, string> || {});
    
    // WebContainer and Shell Setup (Graceful handling)
    let webcontainerPromise: Promise<WebContainer> | undefined;
    let shellTerminalGetter: (() => BoltShell) | undefined; // Remains undefined for server-side
    try {
        const wcEngine = WebContainerEngine.getInstance();
        if (wcEngine) {
            webcontainerPromise = wcEngine.getWebContainer();
            logger.info("api.chat: WebContainerEngine accessed. ActionRunner capabilities depend on successful promise resolution.");
        } else {
            logger.warn("api.chat: WebContainerEngine.getInstance() returned undefined. ActionRunner will be limited (no WebContainer access).");
        }
    } catch (e: any) { // Catch any error during instantiation or method call
        logger.warn(`api.chat: Failed to initialize WebContainerEngine or getShellTerminal. ActionRunner functionality will be limited. Error: ${e.message}`, e);
    }

    // Setup Vercel AI SDK DataStream
    const stream = createDataStream();

    // --- Workflow Management IIFE ---
    (async () => {
      let workflowManager: WorkflowManager | null = null;
      let currentWorkflowId: string | null = incomingWorkflowId || null;
      let isNewWorkflow = false;

      try {
        if (currentWorkflowId) {
          logger.info(`api.chat: Attempting to load workflow: ${currentWorkflowId}`);
          workflowManager = await WorkflowManager.load(currentWorkflowId, llmManager, webcontainerPromise, shellTerminalGetter);
          if (workflowManager) {
            logger.info(`api.chat: Loaded existing workflow: ${currentWorkflowId}`);
            workflowManager.registerAgent(new PlanningAgent(llmManager));
            workflowManager.registerAgent(new FileAgent());
            workflowManager.registerAgent(new CodeAgent(llmManager));
          } else {
            logger.warn(`api.chat: Workflow ${currentWorkflowId} not found. Starting a new one.`);
            currentWorkflowId = null; 
          }
        }

        if (!workflowManager) {
          isNewWorkflow = true;
          logger.info("api.chat: Starting a new workflow.");
          workflowManager = new WorkflowManager(currentUserMessageContent, llmManager, webcontainerPromise, shellTerminalGetter);
          currentWorkflowId = workflowManager.getWorkflowState().workflowId;
          
          workflowManager.registerAgent(new PlanningAgent(llmManager));
          workflowManager.registerAgent(new FileAgent());
          workflowManager.registerAgent(new CodeAgent(llmManager));

          stream.experimental_appendMessageAnnotation({ type: 'workflowInit', workflowId: currentWorkflowId });
          logger.info(`api.chat: New workflow ${currentWorkflowId} initialized and ID sent to client.`);
        }
        
        if (isNewWorkflow) {
          stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'planning', workflowId: currentWorkflowId });
          logger.debug(`api.chat: [${currentWorkflowId}] Planning new workflow.`);
          await workflowManager.plan();
          stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'planningComplete', plan: workflowManager.getWorkflowState().tasks, workflowId: currentWorkflowId });
          logger.debug(`api.chat: [${currentWorkflowId}] Planning complete.`);
          
          stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'executing', workflowId: currentWorkflowId });
          logger.debug(`api.chat: [${currentWorkflowId}] Executing workflow.`);
          await workflowManager.executeWorkflow();
          logger.debug(`api.chat: [${currentWorkflowId}] Execution finished.`);

        } else if (workflowManager) { // Ensure workflowManager is not null for existing workflows
          stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'processingTurn', userInput: currentUserMessageContent, workflowId: currentWorkflowId });
          logger.debug(`api.chat: [${currentWorkflowId}] Processing turn with input: "${currentUserMessageContent.substring(0,100)}..."`);
          
          // Call processTurn for existing, loaded workflows
          await workflowManager.processTurn(currentUserMessageContent); 
          // logger.warn(`api.chat: [${currentWorkflowId}] processTurn method is not yet implemented in WorkflowManager. Current user message was: "${currentUserMessageContent}"`);
          // stream.append("Placeholder: Multi-turn processing not yet fully implemented in WorkflowManager.processTurn. Sending back a simple acknowledgement.\n");
        }


        const finalState = workflowManager.getWorkflowState();
        logger.info(`api.chat: [${currentWorkflowId}] Workflow ended turn with status: ${finalState.status}`);
        if (finalState.status === 'completed') {
          stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'workflowCompleted', finalState, workflowId: currentWorkflowId });
          stream.append("Workflow completed successfully.");
        } else if (finalState.status === 'failed') {
          stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'workflowFailed', finalState, workflowId: currentWorkflowId });
          stream.append(`Workflow failed: ${finalState.tasks.find(t => t.status === 'failed')?.error || 'Unknown error'}`);
        } else { 
           stream.experimental_appendMessageAnnotation({ type: 'workflowStatus', status: 'workflowPaused', finalState, workflowId: currentWorkflowId });
           stream.append("Workflow is now paused, awaiting next input or action.");
        }

      } catch (error: any) {
        logger.error(`api.chat: Error during workflow lifecycle in stream (Workflow ID: ${currentWorkflowId || 'N/A'}):`, error);
        try {
          stream.experimental_appendMessageAnnotation({ 
              type: 'workflowError', 
              message: error.message, 
              stack: error.stack, 
              workflowId: currentWorkflowId 
          });
          stream.append(`Error processing workflow: ${error.message}`); 
        } catch (streamErr) {
          logger.error("api.chat: FATAL - Could not send error to stream:", streamErr);
        }
      } finally {
        logger.info(`api.chat: Closing data stream for workflow: ${currentWorkflowId || 'N/A'}.`);
        stream.close();
      }
    })(); // End of async IIFE

    // Return the stream response (now inside the main try block)
    return new Response(stream.readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
      },
    });

  } catch (error: any) { // This catch now correctly pairs with the outer try
    logger.error("api.chat: Outer catch block error (setup phase):", error);
    if (error.message?.includes('API key')) { 
      return new Response('Invalid or missing API key', { status: 401, statusText: 'Unauthorized' });
    }
    return new Response(`Server setup error: ${error.message}`, { status: 500, statusText: 'Internal Server Error' });
  }
}
