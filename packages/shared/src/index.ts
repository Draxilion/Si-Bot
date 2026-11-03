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
  /** The model's visible reasoning (Think mode or reasoning models). */
  reasoning?: string
  /** Milliseconds spent reasoning before answering. */
  thoughtMs?: number
  /** Web pages the answer drew on, in order of first use. */
  sources?: Source[]
  /** Files the user attached to this message. */
  attachments?: AttachmentMeta[]
  /** Set when the message was produced by a scheduled task rather than a chat turn. */
  taskId?: number
  /** True when the reply was cut short (stopped by the user or failed mid-way). */
  partial?: boolean
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

export interface Source {
  url: string
  title: string
}

export interface AttachmentMeta {
  id: number
  name: string
  mediaType: string
  size: number
}

/** A long-term fact the assistant remembers about the user or their world. */
export interface Fact {
  id: number
  text: string
  createdAt: string
}

/** A job Si runs on its own: once at a time, or repeatedly on a cron schedule. */
export interface Task {
  id: number
  title: string
  prompt: string
  /** Cron expression (5 fields) for repeating tasks. */
  cron: string | null
  /** ISO time for one-off tasks. */
  runAt: string | null
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
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
  /** DeepSearch: thorough multi-source research with a larger tool budget. */
  deep?: boolean
  /** IANA timezone of the app, e.g. "Europe/Chisinau". */
  timezone?: string
  /** Ids of files uploaded with POST /api/files. */
  attachments?: number[]
  /**
   * Rewind the timeline before answering: every message with id >= this one is deleted first.
   * Used to edit a sent message or regenerate a reply.
   */
  replaceFrom?: number
  /** Answer the newest user message again: deletes every reply after it. `content` is ignored. */
  regenerate?: boolean
}

/** Server-sent events emitted by POST /chat. */
export type ChatEvent =
  | { type: 'user'; message: Message }
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  /** Text streamed since `from` was the model narrating before a tool call: move it out of the answer into reasoning. */
  | { type: 'retract'; from: number }
  | { type: 'tool-call'; step: ToolStep }
  | { type: 'tool-result'; id: string; output?: string; error?: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; message: Message }
  | { type: 'suggestions'; suggestions: string[] }
  | { type: 'error'; error: string }
