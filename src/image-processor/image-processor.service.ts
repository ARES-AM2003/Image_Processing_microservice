import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue, QueueEvents } from "bullmq";
import { createHash } from "crypto";

@Injectable()
export class ImageProcessorService implements OnModuleDestroy {
  private readonly logger = new Logger(ImageProcessorService.name);
  private queueEvents: QueueEvents;
  private readonly maxQueuedJobs = Number(
    process.env.QUEUE_MAX_WAITING_JOBS || 20000,
  );
  private readonly enqueueChunkSize = Number(
    process.env.ENQUEUE_CHUNK_SIZE || 500,
  );
  private readonly previewStatusBaseUrl = (
    process.env.PREVIEW_STATUS_BASE_URL || "https://prod.fotosfolio.com"
  ).replace(/\/+$/, "");
  private readonly previewStatusPath =
    process.env.PREVIEW_STATUS_PATH || "/uploads/bulk/preview-status";
  private readonly previewStatusBatchSize = Math.max(
    1,
    Number(process.env.PREVIEW_STATUS_BATCH_SIZE || process.env.BATCH_SIZE || 20),
  );
  private readonly previewStatusFlushIntervalMs = Number(
    process.env.PREVIEW_STATUS_FLUSH_INTERVAL_MS || 5000,
  );
  private pendingPreviewStatusKeys = new Map<string, number>();
  private previewStatusFlushInProgress = false;
  private previewStatusFlushTimer: NodeJS.Timeout;

  constructor(@InjectQueue("image-processing") public readonly queue: Queue) {
    this.queueEvents = new QueueEvents("image-processing", {
      connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
      },
    });
    this.previewStatusFlushTimer = setInterval(() => {
      void this.flushPreviewStatusBatch();
    }, this.previewStatusFlushIntervalMs);
    this.registerEventListeners();
  }

  onModuleDestroy() {
    clearInterval(this.previewStatusFlushTimer);
  }

  private registerEventListeners() {
    this.queueEvents.on("completed", async ({ jobId, returnvalue }) => {
      this.logger.log(`Job ${jobId} completed successfully`);
      await this.onJobCompleted(jobId, returnvalue);
    });

    this.queueEvents.on("failed", (job, err) => {
      this.logger.error(`Job ${job.jobId} failed: ${err}`);
    });

    this.queueEvents.on("progress", (job, progress) => {
      this.logger.debug(`Job ${job.jobId} progress: ${progress}%`);
    });
  }

  private async onJobCompleted(jobId: string, returnvalue?: any): Promise<void> {
    try {
      let fileKey = returnvalue?.originalKey;

      if (!fileKey) {
        const completedJob = await this.queue.getJob(jobId);
        fileKey = completedJob?.data?.key;
      }

      if (!fileKey || typeof fileKey !== "string") {
        this.logger.warn(`Could not find file key for completed job ${jobId}`);
        return;
      }

      this.pendingPreviewStatusKeys.set(fileKey, 0);

      if (this.pendingPreviewStatusKeys.size >= this.previewStatusBatchSize) {
        await this.flushPreviewStatusBatch();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to prepare preview status update for job ${jobId}: ${errorMessage}`,
      );
    }
  }

  private async flushPreviewStatusBatch(): Promise<void> {
    if (this.previewStatusFlushInProgress) {
      return;
    }

    if (this.pendingPreviewStatusKeys.size === 0) {
      return;
    }

    this.previewStatusFlushInProgress = true;

    const fileKeys = Array.from(this.pendingPreviewStatusKeys.keys()).slice(
      0,
      this.previewStatusBatchSize,
    );

    this.logger.log(`🔄 Flushing preview status for ${fileKeys.length} file(s)...`);

    for (const key of fileKeys) {
      this.pendingPreviewStatusKeys.delete(key);
    }

    try {
      const response = await fetch(
        `${this.previewStatusBaseUrl}${this.previewStatusPath}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fileKeys }),
        },
      );

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(
          `HTTP ${response.status} ${response.statusText} - ${responseText}`,
        );
      }

      const result = await response.json().catch(() => ({}));
      this.logger.log(
        `✅ Preview status updated for ${fileKeys.length} file(s). Result: ${JSON.stringify(result)}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      for (const key of fileKeys) {
        const retryCount = (this.pendingPreviewStatusKeys.get(key) || 0) + 1;
        if (retryCount <= 3) {
          this.pendingPreviewStatusKeys.set(key, retryCount);
          this.logger.warn(
            `⚠️  Retrying status update for ${key} (attempt ${retryCount}/3): ${errorMessage}`,
          );
        } else {
          this.logger.error(
            `❌ Max retries reached for ${key}. Giving up after 3 attempts. Error: ${errorMessage}`,
          );
        }
      }
    } finally {
      this.previewStatusFlushInProgress = false;
    }
  }

  async addImageJob(bucket: string, key: string) {
    bucket = this.resolveBucket(bucket);
    await this.ensureQueueCapacity(1);

    this.logger.log(`Adding image job`);
    return this.queue.add(
      "generate-preview",
      { bucket, key },
      {
        jobId: this.buildDeterministicJobId("generate-preview", bucket, key),
        attempts: 1,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async addImageJobsBatch(
    bucket: string,
    keys: string[],
    batchSize = Number(process.env.BATCH_SIZE || this.enqueueChunkSize),
  ) {
    bucket = this.resolveBucket(bucket);
    const startTime = Date.now();
    const uniqueKeys = [...new Set(keys)];

    const existingChecks = await Promise.all(
      uniqueKeys.map(async (key) => {
        const jobId = this.buildDeterministicJobId("generate-preview", bucket, key);
        const existingJob = await this.queue.getJob(jobId);
        
        // Only skip if the job is actually waiting, active, or delayed - allowing retry of failed/completed jobs
        let isActiveOrWaiting = false;
        if (existingJob) {
          const state = await existingJob.getState();
          isActiveOrWaiting = state === "waiting" || state === "active" || state === "delayed" || state === "prioritized";
        }
        
        return { key, jobId, exists: isActiveOrWaiting };
      }),
    );

    const keysToEnqueue = existingChecks
      .filter((item) => !item.exists)
      .map((item) => item.key);
    const existingInQueue = existingChecks.length - keysToEnqueue.length;

    await this.ensureQueueCapacity(keysToEnqueue.length);

    // Skip logging for very large batches to avoid overhead
    if (uniqueKeys.length < 1000) {
      this.logger.log(
        `📦 Enqueue request: ${uniqueKeys.length} unique keys ` +
          `(skipped ${keys.length - uniqueKeys.length} duplicates in request, ${existingInQueue} already in queue)`,
      );
    }

    if (keysToEnqueue.length === 0) {
      this.logger.log(`⏭️ No new jobs to enqueue (all keys already exist in queue)`);
      return;
    }

    // Use single bulk operation for all sizes - much faster
    const jobs = keysToEnqueue.map((key) => ({
      name: "generate-preview",
      data: { bucket, key },
      opts: {
        jobId: this.buildDeterministicJobId("generate-preview", bucket, key),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }));

    // Chunked bulk operations to avoid large Redis Lua allocations.
    const chunkSize = Math.max(1, Math.min(batchSize, this.enqueueChunkSize));
    for (let i = 0; i < jobs.length; i += chunkSize) {
      await this.queue.addBulk(jobs.slice(i, i + chunkSize));
    }

    const enqueueTime = Date.now() - startTime;
    this.logger.log(
      `⚡ Enqueued ${keysToEnqueue.length} new jobs in ${enqueueTime}ms (${existingInQueue} skipped as existing)`,
    );
  }

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

  async testHeicConversion(bucket: string, key: string) {
    bucket = this.resolveBucket(bucket);
    this.logger.log(`Testing HEIC/HEIF conversion`);
    return this.queue.add(
      "test-heic-conversion",
      { bucket, key },
      {
        jobId: this.buildDeterministicJobId("test-heic-conversion", bucket, key),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async clearQueue() {
    this.logger.log("🧹 Clearing queue and stopping all jobs...");
    const startTime = Date.now();

    // Get counts before clearing
    const beforeCounts = {
      waiting: await this.queue.getWaitingCount(),
      active: await this.queue.getActiveCount(),
      completed: await this.queue.getCompletedCount(),
      failed: await this.queue.getFailedCount(),
      delayed: await this.queue.getDelayedCount(),
    };

    this.logger.log(
      `📊 Before: ${beforeCounts.waiting} waiting, ${beforeCounts.active} active, ` +
        `${beforeCounts.completed} completed, ${beforeCounts.failed} failed, ${beforeCounts.delayed} delayed`,
    );

    // Drain waiting, paused, prioritized, and delayed
    await this.queue.drain(true);

    // Remove active jobs by discarding them
    const activeJobs = await this.queue.getActive();
    this.logger.log(`🛑 Stopping ${activeJobs.length} active jobs...`);
    for (const job of activeJobs) {
      try {
        await job.discard();
        await job.remove();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`  ⚠️  Error stopping active job ${job.id}: ${errorMessage}`);
      }
    }

    // Clean up completed/failed (wait/delayed already handled by drain)
    await this.queue.clean(0, 10000, "completed");
    await this.queue.clean(0, 10000, "failed");

    // Force-obliterate any orphaned job hashes directly via Redis
    const redis = await this.queue.client as any;
    const match = this.queue.toKey('') + 'img_*';
    const stream = redis.scanStream({ match });
    for await (const keys of stream) {
      if (keys.length) await redis.del(keys);
    }

    // Get counts after clearing
    const afterCounts = {
      waiting: await this.queue.getWaitingCount(),
      active: await this.queue.getActiveCount(),
      completed: await this.queue.getCompletedCount(),
      failed: await this.queue.getFailedCount(),
      delayed: await this.queue.getDelayedCount(),
    };

    const clearTime = Date.now() - startTime;
    const totalRemoved =
      beforeCounts.waiting -
      afterCounts.waiting +
      (beforeCounts.active - afterCounts.active) +
      (beforeCounts.completed - afterCounts.completed) +
      (beforeCounts.failed - afterCounts.failed) +
      (beforeCounts.delayed - afterCounts.delayed);

    this.logger.log(
      `✅ Queue cleared in ${clearTime}ms - Removed ${totalRemoved} jobs`,
    );
    this.logger.log(
      `📊 After: ${afterCounts.waiting} waiting, ${afterCounts.active} active, ` +
        `${afterCounts.completed} completed, ${afterCounts.failed} failed, ${afterCounts.delayed} delayed`,
    );

    return {
      success: true,
      clearTime,
      jobsRemoved: totalRemoved,
      before: beforeCounts,
      after: afterCounts,
      message: `Successfully cleared ${totalRemoved} jobs from queue`,
    };
  }

  private async ensureQueueCapacity(incomingJobs: number): Promise<void> {
    const [waiting, delayed, prioritized] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getDelayedCount(),
      this.queue.getPrioritizedCount(),
    ]);

    const currentQueued = waiting + delayed + prioritized;
    const projected = currentQueued + incomingJobs;

    if (projected > this.maxQueuedJobs) {
      const message =
        `Queue capacity exceeded: current=${currentQueued}, incoming=${incomingJobs}, ` +
        `limit=${this.maxQueuedJobs}. Pause producers or clear queue before retrying.`;
      this.logger.warn(message);
      throw new Error(message);
    }
  }

  private buildDeterministicJobId(jobName: string, bucket: string, key: string): string {
    const hash = createHash("sha256")
      .update(`${jobName}:${bucket}:${key}`)
      .digest("hex");
    return `img_${hash}`;
  }

  private resolveBucket(bucket: string): string {
    const providedBucket = bucket?.trim();
    const configuredBucket = process.env.S3_BUCKET_NAME?.trim();

    if (configuredBucket) {
      if (providedBucket && providedBucket !== configuredBucket) {
        this.logger.warn(
          `Ignoring request bucket ${providedBucket} and using configured S3 bucket ${configuredBucket}`,
        );
      }
      return configuredBucket;
    }

    const isPlaceholderBucket =
      !providedBucket ||
      /^YOUR_BUCKET_NAME$/i.test(providedBucket) ||
      /^S3_BUCKET_NAME$/i.test(providedBucket) ||
      /^<.*>$/.test(providedBucket);

    if (!isPlaceholderBucket) {
      this.logger.warn(
        `S3_BUCKET_NAME is not set; falling back to request bucket ${providedBucket}`,
      );
      return providedBucket;
    }

    throw new Error(
      `S3 bucket is required. Set body.bucket or S3_BUCKET_NAME in the environment.`,
    );
  }

  async pauseQueue() {
    this.logger.log("⏸️ Pausing queue...");
    await this.queue.pause();
    return { success: true, message: "Queue paused" };
  }

  async resumeQueue() {
    this.logger.log("▶️ Resuming queue...");
    await this.queue.resume();
    return { success: true, message: "Queue resumed" };
  }
}
