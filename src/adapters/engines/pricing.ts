/**
 * Estymata kosztu (ekwiwalent API) z tokenów dla CLI, które nie raportują
 * kosztu wprost (codex --json emituje token_count). Ceny per 1M tokenów;
 * dopasowanie po najdłuższym prefiksie nazwy modelu.
 *
 * Nadpisanie: FACTORY_PRICING_JSON, np.
 *   {"gpt-5.6":{"inputPerMTok":1.25,"cachedInputPerMTok":0.125,"outputPerMTok":10}}
 */
export interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface ModelPricing {
  inputPerMTok: number;
  cachedInputPerMTok?: number;
  outputPerMTok: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "gpt-5": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5.5": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5.6": { inputPerMTok: 1.75, cachedInputPerMTok: 0.175, outputPerMTok: 14 },
};

function pricingTable(): Record<string, ModelPricing> {
  const raw = process.env.FACTORY_PRICING_JSON;
  if (!raw) return DEFAULT_PRICING;
  try {
    return { ...DEFAULT_PRICING, ...(JSON.parse(raw) as Record<string, ModelPricing>) };
  } catch {
    return DEFAULT_PRICING;
  }
}

export function estimateCostUsd(model: string | undefined, usage: TokenUsage): number | undefined {
  if (!model) return undefined;
  const table = pricingTable();
  const prefix = Object.keys(table)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  if (!prefix) return undefined;
  const pricing = table[prefix];
  const cached = usage.cached_input_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  const usd = (
    input * pricing.inputPerMTok +
    cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) +
    output * pricing.outputPerMTok
  ) / 1_000_000;
  return Number.isFinite(usd) ? usd : undefined;
}
