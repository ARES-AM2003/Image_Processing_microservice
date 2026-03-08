import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue, QueueEvents } from "bullmq";

@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);
  private queueEvents: QueueEvents;

  constructor(@InjectQueue("image-processing") public readonly queue: Queue) {
    this.queueEvents = new QueueEvents("image-processing", {
      connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
      },
    });
    this.registerEventListeners();
  }

  private registerEventListeners() {
    this.queueEvents.on("completed", (job) => {
      this.logger.log(`Job ${job.jobId} completed successfully`);
    });

    this.queueEvents.on("failed", (job, err) => {
      this.logger.error(`Job ${job.jobId} failed: ${err}`);
    });

    this.queueEvents.on("progress", (job, progress) => {
      this.logger.debug(`Job ${job.jobId} progress: ${progress}%`);
    });
  }

  async addImageJob(bucket: string, key: string) {
    this.logger.log(`Adding image job`);
    return this.queue.add(
      "generate-preview",
      { bucket, key },
      {
        attempts: 1,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async addImageJobsBatch(
    bucket: string,
    keys: string[],
    batchSize = Number(process.env.BATCH_SIZE || 500),
  ) {
    const startTime = Date.now();

    // Skip logging for very large batches to avoid overhead
    if (keys.length < 1000) {
      this.logger.log(`📦 Enqueue ${keys.length} keys`);
    }

    // Use single bulk operation for all sizes - much faster
    const jobs = keys.map((key) => ({
      name: "generate-preview",
      data: { bucket, key },
      opts: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 3,
      },
    }));

    // Single bulk operation - fastest approach
    await this.queue.addBulk(jobs);

    const enqueueTime = Date.now() - startTime;
    this.logger.log(`⚡ Enqueued ${keys.length} jobs in ${enqueueTime}ms`);
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
    this.logger.log(`Testing HEIC/HEIF conversion`);
    return this.queue.add(
      "test-heic-conversion",
      { bucket, key },
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
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

    // Get all active jobs and fail them immediately
    const activeJobs = await this.queue.getActive();
    this.logger.log(`🛑 Stopping ${activeJobs.length} active jobs...`);

    for (const job of activeJobs) {
      try {
        await job.moveToFailed(
          new Error("Job cancelled by clear queue operation"),
          "0",
        );
        this.logger.debug(`  ❌ Stopped job ${job.id}`);
      } catch (error) {
        this.logger.warn(
          `  ⚠️  Could not stop job ${job.id}: ${error.message}`,
        );
      }
    }

    // Drain waiting and delayed jobs
    await this.queue.drain();

    // Clean up all job types with increased limits
    await this.queue.clean(0, 10000, "completed");
    await this.queue.clean(0, 10000, "failed");
    await this.queue.clean(0, 10000, "active");
    await this.queue.clean(0, 10000, "wait");
    await this.queue.clean(0, 10000, "delayed");
    await this.queue.clean(0, 10000, "paused");

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
