import type { Response } from 'openai/resources/responses/responses';
import type { CallPurpose, ModelCall, Settings, UsageSummary } from '@rag-lab/shared';
import type { EmbeddingProvider, ResponsesClient } from './providers/types.ts';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

export function callCost(
  pricing: Settings['pricing'],
  model: string,
  input: number | null,
  output: number | null,
): number | null {
  const p = pricing[model];
  if (!p || input === null) return null;
  return (input * p.inputPerMillion + (output ?? 0) * p.outputPerMillion) / 1_000_000;
}

/** Records every model call made during one run, using API-reported usage only. */
export class UsageTracker {
  readonly calls: ModelCall[] = [];
  constructor(private pricing: Settings['pricing']) {}

  record(purpose: CallPurpose, model: string, input: number | null, output: number | null, latencyMs: number): ModelCall {
    const call: ModelCall = {
      purpose,
      model,
      inputTokens: input,
      outputTokens: output,
      usageSource: input === null ? 'unavailable' : 'api',
      latencyMs: Math.round(latencyMs),
      costUsd: callCost(this.pricing, model, input, output),
    };
    this.calls.push(call);
    return call;
  }

  /** Calls the Responses API and records usage under the given purpose. */
  async respond(
    client: ResponsesClient,
    purpose: CallPurpose,
    params: ResponseCreateParamsNonStreaming,
    signal?: AbortSignal,
  ): Promise<{ response: Response; call: ModelCall }> {
    const started = performance.now();
    const response = await client.create(params, signal);
    const u = response.usage;
    const call = this.record(purpose, String(params.model), u?.input_tokens ?? null, u?.output_tokens ?? null, performance.now() - started);
    return { response, call };
  }

  async embed(provider: EmbeddingProvider, texts: string[], signal?: AbortSignal) {
    const res = await provider.embed(texts, signal);
    this.record('embedding', provider.model, res.tokens, 0, res.latencyMs);
    return res;
  }

  summary(): UsageSummary {
    return summarizeUsage(this.calls);
  }
}

export function summarizeUsage(calls: ModelCall[]): UsageSummary {
  const s: UsageSummary = {
    answerInput: 0,
    answerOutput: 0,
    planningInput: 0,
    planningOutput: 0,
    embeddingTokens: 0,
    totalTokens: 0,
    calls: calls.length,
    costUsd: 0,
    costNote: '',
    usageComplete: true,
  };
  const unpriced = new Set<string>();
  for (const c of calls) {
    if (c.usageSource === 'unavailable') s.usageComplete = false;
    const i = c.inputTokens ?? 0;
    const o = c.outputTokens ?? 0;
    if (c.purpose === 'answer') {
      s.answerInput += i;
      s.answerOutput += o;
    } else if (c.purpose === 'query_rewrite' || c.purpose === 'agent_planning') {
      s.planningInput += i;
      s.planningOutput += o;
    } else if (c.purpose === 'embedding') {
      s.embeddingTokens += i;
    }
    if (c.purpose !== 'judge') s.totalTokens += i + o;
    if (c.purpose !== 'judge') {
      if (c.costUsd === null) unpriced.add(c.model);
      else if (s.costUsd !== null) s.costUsd += c.costUsd;
    }
  }
  if (unpriced.size) {
    s.costUsd = null;
    s.costNote = `Pricing not configured for: ${[...unpriced].join(', ')} (Settings → Pricing)`;
  } else {
    s.costNote = 'Estimated from API-reported tokens × configured pricing (excludes LLM-judge calls)';
  }
  return s;
}
