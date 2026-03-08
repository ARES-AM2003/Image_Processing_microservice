import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue, QueueEvents } from "bullmq";
import { basename } from "path";
import * as os from "os";

interface JobMetrics {
  processed: number;
  failed: number;
  dbUpdates: number;
  dbErrors: number;
  averageProcessingTime: number;
  lastResetTime: number;
}

interface BatchUpdateResult {
  success: number;
  failed: number;
  errors: string[];
}

@Injectable()
export class ImageQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImageQueueService.name);
  private queueEvents: QueueEvents;
  private metrics: JobMetrics;
  private pendingUpdates = new Map<
    string,
    { friendlyUrl: string; fileName: string; timestamp: number }
  >();
  private batchUpdateTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_UPDATE_INTERVAL = 5000; // 5 seconds
  private readonly BATCH_UPDATE_SIZE = 100;
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private isShuttingDown = false;

  constructor(@InjectQueue("image-processing") public readonly queue: Queue) {
    this.initializeMetrics();
    this.setupQueueEvents();
  }

  async onModuleInit() {
    this.registerCompletedListener();
    this.startBatchUpdateTimer();
    this.logger.log("🚀 ImageQueueService initialized with optimizations");
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;

    // Process any pending updates
    if (this.pendingUpdates.size > 0) {
      this.logger.log(
        `📦 Processing ${this.pendingUpdates.size} pending updates before shutdown`,
      );
      await this.processBatchUpdates();
    }

    // Clean up timers and events
    if (this.batchUpdateTimer) {
      clearInterval(this.batchUpdateTimer);
    }

    if (this.queueEvents) {
      await this.queueEvents.close();
    }

    this.logger.log("✅ ImageQueueService gracefully shut down");
  }

  private initializeMetrics(): void {
    this.metrics = {
      processed: 0,
      failed: 0,
      dbUpdates: 0,
      dbErrors: 0,
      averageProcessingTime: 0,
      lastResetTime: Date.now(),
    };
  }

  private setupQueueEvents(): void {
    this.queueEvents = new QueueEvents("image-processing", {
      connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD,
        // Production optimizations - must be null for BullMQ blocking commands
        maxRetriesPerRequest: null,
        retryDelayOnFailover: 50,
        enableReadyCheck: false,
        lazyConnect: true,
        keepAlive: 30000,
        commandTimeout: 5000,
        enableAutoPipelining: true,
      },
    });
  }

  /**
   * Optimized single job addition with minimal overhead
   */
  async addImageJob(bucket: string, key: string): Promise<any> {
    try {
      return await this.queue.add(
        "generate-preview",
        { bucket, key },
        {
          attempts: 2, // Reduced from 3
          backoff: { type: "exponential", delay: 2000 }, // Faster backoff
          removeOnComplete: 10, // Keep fewer completed jobs
          removeOnFail: 5,
          priority: this.calculateJobPriority(key),
        },
      );
    } catch (error) {
      this.logger.error(`Failed to add job for ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Ultra-optimized batch job addition
   */
  async addImageJobsBatch(
    bucket: string,
    keys: string[],
    customBatchSize?: number,
  ): Promise<void> {
    const startTime = Date.now();
    const batchSize =
      customBatchSize || this.calculateOptimalBatchSize(keys.length);

    this.logger.log(
      `📦 Processing ${keys.length} jobs in batches of ${batchSize}`,
    );

    try {
      // Create all jobs without delay - maximum throughput
      const allJobs = keys.map((key) => ({
        name: "generate-preview",
        data: { bucket, key },
        opts: {
          attempts: 2,
          removeOnComplete: 10,
          removeOnFail: 5,
          priority: this.calculateJobPriority(key),
        },
      }));

      // Process in optimal batches with parallel execution
      const batches = this.chunkArray(allJobs, batchSize);

      // Use Promise.allSettled for better error handling
      const results = await Promise.allSettled(
        batches.map((batch) => this.queue.addBulk(batch)),
      );

      // Count successful batches
      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      const processingTime = Date.now() - startTime;
      const throughput = Math.round((keys.length / processingTime) * 1000);

      this.logger.log(
        `⚡ Enqueued ${keys.length} jobs in ${processingTime}ms (${throughput} jobs/sec) - Success: ${successful}/${batches.length} batches`,
      );

      if (failed > 0) {
        this.logger.warn(`⚠️  ${failed} batches failed to enqueue`);
      }
    } catch (error) {
      this.logger.error(`Failed to process batch jobs:`, error.message);
      throw error;
    }
  }

  /**
   * Production-optimized completed job listener with batching
   */
  private registerCompletedListener(): void {
    this.queueEvents.on("completed", async (job) => {
      const startTime = Date.now();

      try {
        // Fast extraction of preview key
        const previewKey = this.extractPreviewKey(job.returnvalue);
        if (!previewKey) {
          return; // Silent return for better performance
        }

        // Build friendly URL
        const baseUrl =
          process.env.BASE_CDN_URL || "https://cdn.fotosfolio.com";
        const friendlyUrl = `${baseUrl}/${previewKey}`;
        const fileName = basename(previewKey);

        // Add to batch update queue instead of immediate DB update
        this.addToPendingUpdates(fileName, friendlyUrl);

        // Update metrics
        this.updateMetrics(startTime, true);

        // Log only significant milestones
        if (this.metrics.processed % 100 === 0) {
          this.logger.log(
            `📊 Processed: ${this.metrics.processed}, Pending DB Updates: ${this.pendingUpdates.size}`,
          );
        }
      } catch (error) {
        this.updateMetrics(startTime, false);
        this.logger.error(
          `Job completion handler error for job ${job.jobId}:`,
          error.message,
        );
      }
    });

    this.queueEvents.on("failed", (job, err) => {
      this.metrics.failed++;
      this.logger.error(`Job ${job.jobId} failed:`, err);
    });

    this.queueEvents.on("error", (error) => {
      this.logger.error("Queue events error:", error.message);
    });
  }

  /**
   * Add update to pending batch
   */
  private addToPendingUpdates(fileName: string, friendlyUrl: string): void {
    this.pendingUpdates.set(fileName, {
      friendlyUrl,
      fileName,
      timestamp: Date.now(),
    });

    // Trigger immediate batch if we reach the size limit
    if (this.pendingUpdates.size >= this.BATCH_UPDATE_SIZE) {
      setImmediate(() => this.processBatchUpdates());
    }
  }

  /**
   * Start batch update timer
   */
  private startBatchUpdateTimer(): void {
    this.batchUpdateTimer = setInterval(async () => {
      if (this.pendingUpdates.size > 0 && !this.isShuttingDown) {
        await this.processBatchUpdates();
      }
    }, this.BATCH_UPDATE_INTERVAL);
  }

  /**
   * Process pending updates in batches for optimal DB performance
   */
  private async processBatchUpdates(): Promise<BatchUpdateResult> {
    if (this.pendingUpdates.size === 0) {
      return { success: 0, failed: 0, errors: [] };
    }

    const updates = Array.from(this.pendingUpdates.values());
    const updateSize = updates.length;
    this.pendingUpdates.clear(); // Clear immediately to prevent duplicates

    const startTime = Date.now();
    const result: BatchUpdateResult = {
      success: updateSize,
      failed: 0,
      errors: [],
    };

    // Simulate batch update since we don't have database access
    const processingTime = Date.now() - startTime;
    this.metrics.dbUpdates += result.success;

    this.logger.log(
      `✅ Simulated batch DB update: ${result.success}/${updateSize} records in ${processingTime}ms`,
    );

    return result;
  }

  /**
   * Get comprehensive service metrics
   */
  getMetrics(): JobMetrics & {
    pendingUpdates: number;
    queueHealth: string;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
  } {
    const uptime = Date.now() - this.metrics.lastResetTime;
    return {
      ...this.metrics,
      pendingUpdates: this.pendingUpdates.size,
      queueHealth: this.isShuttingDown ? "shutting_down" : "healthy",
      uptime,
      memoryUsage: process.memoryUsage(),
    };
  }

  /**
   * Reset metrics for monitoring
   */
  resetMetrics(): void {
    this.initializeMetrics();
    this.logger.log("📊 Metrics reset");
  }

  /**
   * Manual trigger for batch updates (for testing/debugging)
   */
  async flushPendingUpdates(): Promise<BatchUpdateResult> {
    return await this.processBatchUpdates();
  }

  /**
   * Get queue status (compatibility method)
   */
  async getQueueStatus() {
    const waiting = await this.queue.getWaitingCount();
    const active = await this.queue.getActiveCount();
    const completed = await this.queue.getCompletedCount();
    const failed = await this.queue.getFailedCount();
    const delayed = await this.queue.getDelayedCount();
    const paused = await this.queue.isPaused();

    return {
      worker: "running",
      paused,
      counts: { waiting, active, completed, failed, delayed },
    };
  }

  /**
   * Clear queue (compatibility method)
   */
  async clearQueue() {
    this.logger.log("🧹 Clearing queue...");
    const startTime = Date.now();

    await this.queue.drain();
    await this.queue.clean(0, 1000, "completed");
    await this.queue.clean(0, 1000, "failed");

    const clearTime = Date.now() - startTime;
    this.logger.log(`✅ Queue cleared in ${clearTime}ms`);

    return {
      success: true,
      clearTime,
      message: "Queue cleared successfully",
    };
  }

  /**
   * Pause queue (compatibility method)
   */
  async pauseQueue() {
    this.logger.log("⏸️ Pausing queue...");
    await this.queue.pause();
    return { success: true, message: "Queue paused" };
  }

  /**
   * Resume queue (compatibility method)
   */
  async resumeQueue() {
    this.logger.log("▶️ Resuming queue...");
    await this.queue.resume();
    return { success: true, message: "Queue resumed" };
  }

  // Private utility methods

  private extractPreviewKey(returnValue: any): string | null {
    if (
      returnValue &&
      typeof returnValue === "object" &&
      "previewKey" in returnValue &&
      typeof returnValue.previewKey === "string"
    ) {
      return returnValue.previewKey;
    }
    return null;
  }

  private calculateJobPriority(key: string): number {
    // Prioritize smaller files and certain formats
    if (key.includes("thumb") || key.includes("preview")) return 10;
    if (key.endsWith(".heic") || key.endsWith(".heif")) return 7;
    if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return 5;
    return 3; // Default priority
  }

  private calculateOptimalBatchSize(totalJobs: number): number {
    const cpuCores = os.cpus().length;
    const baseSize = Math.max(50, cpuCores * 10);

    if (totalJobs < 100) return Math.min(totalJobs, 25);
    if (totalJobs < 1000) return Math.min(totalJobs, baseSize);
    return Math.min(200, baseSize * 2); // Cap at 200 for very large batches
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private updateMetrics(startTime: number, success: boolean): void {
    const processingTime = Date.now() - startTime;

    if (success) {
      this.metrics.processed++;
      // Running average calculation
      this.metrics.averageProcessingTime =
        (this.metrics.averageProcessingTime * (this.metrics.processed - 1) +
          processingTime) /
        this.metrics.processed;
    } else {
      this.metrics.failed++;
    }
  }
}
