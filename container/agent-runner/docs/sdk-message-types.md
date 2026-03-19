# Claude Agent SDK Message Types

Reference for the message types emitted by the Claude Agent SDK's `query()` async iterable.

## system/init

Emitted when a session is initialized or resumed.

- `session_id` — session identifier
- `model` — model ID (e.g. `claude-opus-4-6[1m]`)
- `tools[]` — available tool names
- `skills[]` — available skill names
- `slash_commands[]` — available slash commands
- `mcp_servers[]` — `{name, status}` for each MCP server
- `agents[]` — available agent types
- `plugins[]` — loaded plugins
- `permissionMode` — e.g. `bypassPermissions`
- `claude_code_version` — SDK version
- `fast_mode_state` — `on` or `off`

## system/task_notification

- `task_id` — task identifier
- `status` — task status
- `summary` — task summary text

## assistant

Emitted for each assistant response (may be streamed incrementally).

- `message.id` — message ID
- `message.model` — model used for this response
- `message.content[]` — array of content blocks:
  - `{type: "text", text: "..."}` — text response
  - `{type: "tool_use", id: "...", name: "...", input: {...}}` — tool call
- `message.stop_reason` — always `null` during streaming
- `message.usage` — per-message token counts:
  - `input_tokens`, `output_tokens`
  - `cache_creation_input_tokens`, `cache_read_input_tokens`
- `session_id`, `uuid`, `parent_tool_use_id`

## user

Emitted after tool execution with the results.

- `message.content[]` — array of result blocks:
  - `{type: "tool_result", tool_use_id: "...", content: "...", is_error: bool}`
- `tool_use_result` — duplicate of content, sometimes structured as `{stdout, stderr, interrupted, isImage, noOutputExpected}`
- `session_id`, `uuid`, `parent_tool_use_id`

## rate_limit_event

Emitted to report rate limit status.

- `rate_limit_info.status` — `allowed` or `rejected`
- `rate_limit_info.rateLimitType` — e.g. `five_hour`
- `rate_limit_info.resetsAt` — unix timestamp
- `rate_limit_info.overageStatus` — e.g. `rejected`
- `rate_limit_info.overageDisabledReason` — e.g. `out_of_credits`
- `rate_limit_info.isUsingOverage` — boolean
- `session_id`, `uuid`

## result

Emitted at the end of each query turn.

- `subtype` — `success` or `error`
- `is_error` — boolean
- `result` — final text output (same as last assistant text)
- `stop_reason` — `end_turn`, `max_tokens`, `stop_sequence`, etc.
- `duration_ms` — wall clock duration
- `duration_api_ms` — API call duration
- `num_turns` — number of turns in this query
- `total_cost_usd` — total cost
- `session_id`, `uuid`
- `usage` — aggregate token counts:
  - `input_tokens`, `output_tokens`
  - `cache_read_input_tokens`, `cache_creation_input_tokens`
  - `server_tool_use` — `{web_search_requests, web_fetch_requests}`
  - `service_tier`, `iterations[]`, `speed`
- `modelUsage` — per-model breakdown keyed by model ID:
  - `inputTokens`, `outputTokens`
  - `cacheReadInputTokens`, `cacheCreationInputTokens`
  - `webSearchRequests`, `costUSD`
  - `contextWindow`, `maxOutputTokens`
- `permission_denials[]` — list of denied tool calls
- `fast_mode_state` — `on` or `off`
