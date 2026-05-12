// Local-only providers: Ollama, llama.cpp, any OpenAI-compatible local endpoint.
// Ported from project-brain/src/ai/openai-compat.js — cloud providers removed.

const DEFAULT_BASE_URLS = {
  ollama:   'http://localhost:11434',
  llamacpp: 'http://localhost:8080',
  custom:   null,
};

const DEFAULT_MODELS = {
  ollama:   'llama3.2:3b',
  llamacpp: 'default',
  custom:   'default',
};

const THINK_PATTERNS = ['deepseek-r1', 'deepseek-r2', 'qwq'];

function needsThinkStrip(model) {
  return THINK_PATTERNS.some(p => model.toLowerCase().includes(p));
}

function stripThinkBlocks(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export const SUPPORTED_PROVIDERS = ['ollama', 'llamacpp', 'custom'];

export class LocalProvider {
  constructor({ providerName, baseUrl, model }) {
    this.provider = providerName;
    this.baseUrl  = (baseUrl ?? DEFAULT_BASE_URLS[providerName] ?? '').replace(/\/$/, '');
    this.model    = model ?? DEFAULT_MODELS[providerName] ?? 'default';

    if (!this.baseUrl) {
      throw new Error(
        `Base URL required for provider "${providerName}". ` +
        `Use --base-url or set AI_BASE_URL in .env`
      );
    }
  }

  async chatWithMetrics(messages, { maxTokens = 1024 } = {}) {
    const tStart = Date.now();
    let tFirstToken = null;
    let text = '';
    let completionTokens = 0;
    let promptTokens = null;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model, messages, max_tokens: maxTokens,
        stream: true, stream_options: { include_usage: true }
      }),
      signal: AbortSignal.timeout(180000)
    });

    if (!res.ok) {
      throw new Error(`${this.provider} ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done   = false;

    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { done = true; break; }
        try {
          const chunk = JSON.parse(raw);
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            if (tFirstToken === null) tFirstToken = Date.now();
            text += content;
            completionTokens++;
          }
          if (chunk.usage) {
            if (chunk.usage.completion_tokens) completionTokens = chunk.usage.completion_tokens;
            if (chunk.usage.prompt_tokens)     promptTokens     = chunk.usage.prompt_tokens;
          }
        } catch { /* skip malformed SSE chunks */ }
      }
    }

    const tEnd = Date.now();
    if (needsThinkStrip(this.model)) text = stripThinkBlocks(text);
    return { text: text.trim(), tStart, tFirstToken: tFirstToken ?? tEnd, tEnd, promptTokens, completionTokens };
  }

  async probe() {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'Reply in one sentence only.' },
          { role: 'user',   content: 'What is 2 + 2?' }
        ],
        max_tokens: 100,
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!res.ok) {
      throw new Error(`${this.provider} ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }

    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content ?? '';
    return { hasThinking: /<think>/i.test(raw), rawText: raw };
  }

  async listModels() {
    if (this.provider !== 'ollama') return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.models ?? []).map(m => m.name).sort();
    } catch { return null; }
  }

  async check() {
    if (this.provider === 'ollama') {
      try {
        const models = await this.listModels();
        if (!models) return { ok: false, reason: `Cannot reach Ollama at ${this.baseUrl}` };
        const base = this.model.split(':')[0];
        if (!models.some(m => m.startsWith(base))) {
          return { ok: false, reason: `Model "${this.model}" not found. Available: ${models.join(', ') || 'none'}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `Cannot reach Ollama — ${err.message}` };
      }
    }
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
}

export function createProvider({ providerType, baseUrl, model }) {
  if (!SUPPORTED_PROVIDERS.includes(providerType)) {
    throw new Error(`Unknown provider "${providerType}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
  return new LocalProvider({ providerName: providerType, baseUrl, model });
}
