/**
 * Types for the Meta Model API Chat Completions endpoint
 * (POST {base}/chat/completions). The API is OpenAI-compatible.
 * Reference: https://dev.meta.ai/docs/api-reference/chat-completions/schemas
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "developer" | "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Multimodal user content (Chat Completions). Images go in user messages only,
 * as data: URLs or https URLs. https://dev.meta.ai/docs/image-understanding
 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Constrained decoding: https://dev.meta.ai/docs/structured-outputs */
export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean; description?: string };
}

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: FunctionToolDefinition[];
  /** Meta Model API only supports "auto". */
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  reasoning_effort?: ReasoningEffort;
  response_format?: JsonSchemaResponseFormat;
  max_completion_tokens?: number;
  safety_identifier?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** The minimal interface the agent loop depends on; mocked in tests. */
export interface StreamCallbacks {
  /** Called with each incremental piece of assistant text as it arrives. */
  onTextDelta?: (delta: string) => void;
}

export interface ModelClient {
  readonly modelId: string;
  createChatCompletion(req: Omit<ChatCompletionRequest, "model" | "stream">): Promise<ChatCompletionResponse>;
  /**
   * Optional streaming variant (stream: true, SSE). Resolves to the same aggregated
   * shape as createChatCompletion once the stream finishes.
   */
  streamChatCompletion?(
    req: Omit<ChatCompletionRequest, "model" | "stream">,
    callbacks: StreamCallbacks,
  ): Promise<ChatCompletionResponse>;
}
