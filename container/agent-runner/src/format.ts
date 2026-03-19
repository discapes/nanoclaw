export function collapse(s: string): string {
  return s.trim().replace(/\s*\n\s*/g, '  ↵ ');
}

export function truncateMiddle(s: string, max = 5000): string {
  s = collapse(s);
  if (s.length <= max) return s;
  const half = Math.floor((max - 5) / 2);
  return s.slice(0, half) + ' ... ' + s.slice(-half);
}

export function extractUserMessages(s: string): string | null {
  const matches = [
    ...s.matchAll(/<message sender="([^"]*)"[^>]*>([\s\S]*?)<\/message>/g),
  ];
  if (matches.length === 0) return null;
  return matches
    .map((m) => (matches.length > 1 ? `${m[1]}: ${m[2]}` : m[2]))
    .join(' | ');
}

function formatFields(obj: Record<string, any>, max = 200): string {
  return Object.entries(obj)
    .map(
      ([k, v]) =>
        `${k}=${truncateMiddle(typeof v === 'string' ? v : JSON.stringify(v), max)}`,
    )
    .join(', ');
}

export function extractText(val: any): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val))
    return val.map(extractText).filter(Boolean).join('\n');
  if (val?.type === 'text' && val.text) return val.text;
  return '';
}

export function formatValue(val: any, max = 5000): string {
  if (typeof val === 'string') return truncateMiddle(val, max);
  if (Array.isArray(val)) {
    if (val.length === 1) return formatValue(val[0], max);
    return '[ ' + val.map((v) => formatValue(v, max)).join(' | ') + ' ]';
  }
  if (val?.type === 'image') return '<image>';
  if (val?.type === 'text' && val.text) return truncateMiddle(val.text, max);
  if (val?.type === 'thinking')
    return `«${truncateMiddle(val.thinking || 'redacted', max)}»`;
  if (val?.type === 'tool_use' || val?.type === 'server_tool_use')
    return `${val.name}(${formatFields(val.input || {})})`;
  if (val?.type === 'tool_result') {
    const wrapper = val.is_error ? 'Error' : 'Result';
    return `${wrapper}(${formatValue(val.content, max)})`;
  }
  return formatFields(val, max);
}

// See docs/sdk-message-types.md for the full schema of each message type.
export function formatMessage(message: any): { label: string; text: string } {
  const type = message.type;

  if (type === 'system' && message.subtype === 'init') {
    const tools = message.tools?.length ?? 0;
    const skills = message.skills?.length ?? 0;
    const mcps = message.mcp_servers
      ?.map(
        (s: any) =>
          `${s.name}(${s.status == 'connected' ? s.status : JSON.stringify(s)})`,
      )
      .join(', ');
    return {
      label: 'init',
      text: `Session: ${message.session_id || 'new'} | model=${message.model} | ${tools} tools, ${skills} skills | MCP: ${mcps || 'none'}`,
    };
  }

  if (type === 'system' && message.subtype === 'task_notification') {
    return {
      label: 'task',
      text: `${message.task_id}: ${message.status} — ${message.summary}`,
    };
  }

  if (type === 'system') {
    return { label: `system/${message.subtype}`, text: formatValue(message) };
  }

  if (type === 'assistant' && message.message?.content) {
    return { label: 'assistant', text: formatValue(message.message.content) };
  }

  if (type === 'user' && message.message?.content) {
    return { label: 'user', text: formatValue(message.message.content) };
  }

  if (type === 'rate_limit_event') {
    const r = message.rate_limit_info || {};
    return {
      label: 'rate_limit',
      text: `${r.rateLimitType} ${r.status}${r.resetsAt ? ` | resets ${new Date(r.resetsAt * 1000).toISOString()}` : ''}`,
    };
  }

  if (type === 'result') {
    const u = message.usage || {};
    const cost = message.total_cost_usd
      ? `$${message.total_cost_usd.toFixed(4)}`
      : '';
    const dur = message.duration_api_ms
      ? `${(message.duration_api_ms / 1000).toFixed(1)}s`
      : '';
    const tokens = [
      u.input_tokens && `in:${u.input_tokens}`,
      u.output_tokens && `out:${u.output_tokens}`,
      u.cache_read_input_tokens && `cache_read:${u.cache_read_input_tokens}`,
      u.cache_creation_input_tokens &&
        `cache_write:${u.cache_creation_input_tokens}`,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      label: 'result',
      text: `${message.subtype} | ${message.num_turns} turns | ${dur} | ${cost} | ${tokens}`,
    };
  }

  return {
    label: 'unhandled',
    text: truncateMiddle(JSON.stringify(message)),
  };
}
