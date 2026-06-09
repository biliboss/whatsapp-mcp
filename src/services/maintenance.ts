// ============================================================
// WA MCP — Scheduled Maintenance Jobs
// ============================================================
// Stage 1.5 strip: BullMQ removed from maintenance service too.
// Cron-like scheduling replaced with setInterval (acceptable for
// single-user VPS — exact timing not critical for pruning jobs).
// ============================================================

import { lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages, processedMessages } from "../db/schema.js";
import { refreshWaVersion } from "../channels/baileys/baileys.version.js";
import type { InstanceManager } from "./instance-manager.js";
import { createChildLogger } from "../utils/logger.js";
import {
  DEFAULT_MESSAGE_RETENTION_DAYS,
  DEDUP_TTL_HOURS,
  HEALTH_CHECK_INTERVAL_MS,
} from "../constants.js";

const logger = createChildLogger({ service: "maintenance" });

// Run intervals (match original cron intent):
const PRUNE_MESSAGES_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const PRUNE_DEDUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const CHECK_VERSION_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export class MaintenanceService {
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly instanceManager: InstanceManager;

  constructor(instanceManager: InstanceManager) {
    this.instanceManager = instanceManager;
  }

  async start(): Promise<void> {
    // Health check (most frequent)
    this.timers.push(
      setInterval(() => {
        this.runHealthCheck().catch((err) => {
          logger.error({ err }, "Health check failed");
        });
      }, HEALTH_CHECK_INTERVAL_MS),
    );

    // Message pruning (daily)
    this.timers.push(
      setInterval(() => {
        this.pruneMessages().catch((err) => {
          logger.error({ err }, "Message prune failed");
        });
      }, PRUNE_MESSAGES_INTERVAL_MS),
    );

    // Dedup pruning (hourly)
    this.timers.push(
      setInterval(() => {
        this.pruneDedup().catch((err) => {
          logger.error({ err }, "Dedup prune failed");
        });
      }, PRUNE_DEDUP_INTERVAL_MS),
    );

    // WA version check (daily)
    this.timers.push(
      setInterval(() => {
        this.checkWaVersion().catch((err) => {
          logger.warn({ err }, "WA version check failed");
        });
      }, CHECK_VERSION_INTERVAL_MS),
    );

    // Run version check once on startup
    this.checkWaVersion().catch((err) => {
      logger.warn({ err }, "Initial WA version check failed");
    });

    logger.info("Maintenance service started");
  }

  async stop(): Promise<void> {
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
    logger.info("Maintenance service stopped");
  }

  private async pruneMessages(): Promise<void> {
    const retentionDays = parseInt(
      process.env.WA_MESSAGE_RETENTION_DAYS ?? String(DEFAULT_MESSAGE_RETENTION_DAYS),
      10,
    );
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const result = db.delete(messages).where(lt(messages.timestamp, cutoff)).run();

    logger.info({ deleted: result.changes, retentionDays }, "Pruned old messages");
  }

  private async pruneDedup(): Promise<void> {
    const cutoff = Date.now() - DEDUP_TTL_HOURS * 60 * 60 * 1000;

    const result = db
      .delete(processedMessages)
      .where(lt(processedMessages.processedAt, cutoff))
      .run();

    logger.info({ deleted: result.changes }, "Pruned dedup entries");
  }

  private async checkWaVersion(): Promise<void> {
    try {
      const result = await refreshWaVersion();
      logger.info(
        { version: result.version, isLatest: result.isLatest },
        "WhatsApp version check completed",
      );
    } catch (err) {
      logger.warn({ err }, "Failed to refresh WhatsApp version");
    }
  }

  private async runHealthCheck(): Promise<void> {
    const allInstances = this.instanceManager.getAllInstances();

    for (const instance of allInstances) {
      if (instance.status === "disconnected") {
        const autoReconnect = process.env.WA_AUTO_RECONNECT !== "false";
        if (!autoReconnect) continue;

        if (!instance.lastConnected) continue;

        try {
          logger.info({ instanceId: instance.id }, "Auto-reconnecting instance");
          await this.instanceManager.connectInstance(instance.id);
        } catch (err) {
          logger.warn({ instanceId: instance.id, err }, "Failed to auto-reconnect instance");
        }
      }
    }
  }
}
