// ============================================================
// WA MCP — Message Queue (direct dispatch, no Redis)
// ============================================================
// Stage 1.5 strip: BullMQ + ioredis removed. Single-user VPS deploy
// does not need Redis rate-limiting or persistence. All enqueue calls
// dispatch synchronously to the adapter. EnqueueResult shape preserved
// so all callers compile without changes.
// ============================================================

import type { ChannelAdapter } from "../channels/channel.interface.js";
import type { MessageContent } from "../types/channel.types.js";
import {
  DEFAULT_BAILEYS_RATE_LIMIT,
  DEFAULT_CLOUD_RATE_LIMIT,
} from "../constants.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "message-queue" });

export interface OutboundJob {
  instanceId: string;
  to: string;
  content: MessageContent;
}

export interface EnqueueResult {
  status: "queued";
  jobId: string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

// Simple in-process rate-limiter: count sends per minute per instance
interface RateBucket {
  count: number;
  windowStart: number;
}

export class MessageQueue {
  private getAdapter: ((instanceId: string) => ChannelAdapter) | null = null;
  private readonly rateBuckets = new Map<string, RateBucket>();

  /** Set the adapter resolver so enqueue can send messages */
  setAdapterResolver(resolver: (instanceId: string) => ChannelAdapter): void {
    this.getAdapter = resolver;
  }

  /** Enqueue (and immediately dispatch) an outbound message */
  async enqueueMessage(
    instanceId: string,
    to: string,
    content: MessageContent,
    channel: "baileys" | "cloud" = "baileys",
  ): Promise<EnqueueResult> {
    if (!this.getAdapter) {
      throw new Error("Adapter resolver not set");
    }

    const rateLimit =
      channel === "baileys"
        ? parseInt(process.env.WA_BAILEYS_RATE_LIMIT ?? String(DEFAULT_BAILEYS_RATE_LIMIT), 10)
        : parseInt(process.env.WA_CLOUD_RATE_LIMIT ?? String(DEFAULT_CLOUD_RATE_LIMIT), 10);

    // Soft rate-limit check (log warning, don't hard-block — single user)
    const now = Date.now();
    const bucket = this.rateBuckets.get(instanceId) ?? { count: 0, windowStart: now };
    if (now - bucket.windowStart >= 60_000) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    if (bucket.count >= rateLimit) {
      logger.warn({ instanceId, count: bucket.count, rateLimit }, "Rate limit exceeded — sending anyway (single-user mode)");
    }
    bucket.count++;
    this.rateBuckets.set(instanceId, bucket);

    const adapter = this.getAdapter(instanceId);
    await adapter.sendMessage(to, content);

    const jobId = `direct-${instanceId}-${Date.now()}`;
    logger.debug({ jobId, instanceId }, "Outbound message sent (direct dispatch)");
    return { status: "queued", jobId };
  }

  /** Queue stats — always empty (no Redis backend) */
  async getQueueStats(_instanceId: string): Promise<QueueStats> {
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }

  /** No-op: no queue to remove */
  async removeInstanceQueue(_instanceId: string): Promise<void> {}

  /** No-op: nothing to close */
  async close(): Promise<void> {}
}
