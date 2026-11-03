// Types shared by the server and the app.

export type Role = 'user' | 'assistant'

/** One entry in the assistant's single, persistent timeline. */
export interface Message {
  id: number
  role: Role
  content: string
  model: string | null
  /** Tool calls the assistant made while producing this message. */
  steps?: ToolStep[]
  createdAt: string
}

/** One tool call made by the assistant, e.g. a web search or a code run. */
export interface ToolStep {
  id: string
  name: string
  /** Human-readable summary, e.g. 'Searched the web for "tauri 2"'. */
  label: string
  input: unknown
  /** Tool output, truncated for display. */
  output?: string
  error?: string
}

/** A long-term fact the assistant remembers about the user or their world. */
export interface Fact {
  id: number
  text: string
  createdAt: string
}

export interface ModelOption {
  /** "provider:model", e.g. "anthropic:claude-sonnet-5-5" */
  id: string
  label: string
  provider: string
}

export interface ChatRequest {
  content: string
  model?: string
  think?: boolean
}

/** Server-sent events emitted by POST /chat. */
export type ChatEvent =
  | { type: 'user'; message: Message }
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; step: ToolStep }
  | { type: 'tool-result'; id: string; output?: string; error?: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: string }
