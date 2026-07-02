import type { Session, StepEvent } from "@kelson/schemas";
import { SharedSessionEvent, SharedStepEvent } from "@kelson/schemas";

// TEL-3/OSS-2: sharing is a WHITELIST projection into the published shared
// schema — code content, file paths, prompt text, and every other free-text
// field simply have no destination field to leak into. The Zod parse at the
// end makes a leak a schema violation rather than a missed filter.
export const stripStepEvent = (event: StepEvent): SharedStepEvent =>
  SharedStepEvent.parse({
    id: event.id,
    session_id: event.session_id,
    sdlc_step: event.sdlc_step,
    model: event.model,
    effort: event.effort,
    tokens_in: event.tokens_in,
    tokens_out: event.tokens_out,
    tokens_cache_read: event.tokens_cache_read,
    tokens_cache_write: event.tokens_cache_write,
    cost_micro_usd: event.cost_micro_usd,
    budget_tokens: event.budget_tokens,
    overrun: event.overrun,
    schema_version: event.schema_version,
  });

export const stripSession = (
  session: Session,
  stepCount: number,
  totalCost: number,
): SharedSessionEvent =>
  SharedSessionEvent.parse({
    id: session.id,
    status: session.status,
    step_count: stepCount,
    total_cost_micro_usd: totalCost,
    started_at: session.started_at,
    ended_at: session.ended_at,
    schema_version: session.schema_version,
  });
