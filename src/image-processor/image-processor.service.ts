import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue, QueueEvents } from "bullmq";

@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);
  private queueEvents: QueueEvents;

  constructor(
    @InjectQueue("image-processing") private readonly queue: Queue,
  ) {
    this.queueEvents = new QueueEvents("image-processing", {
      connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
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
  }

  async addImageJob(bucket: string, key: string) {
    return this.queue.add(
      "generate-preview",
      { bucket, key },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async addImageJobsBatch(
    bucket: string,
    keys: string[],
    batchSize = Number(process.env.BATCH_SIZE || 20),
  ) {
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const jobs = batch.map((key) => ({
        name: "generate-preview",
        data: { bucket, key },
        opts: {
          attempts: 2,
          backoff: { type: "fixed", delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 3,
          delay: i > 0 ? 2000 : 0, // Small delay between batches
        },
      }));
      await this.queue.addBulk(jobs);
    }
    this.logger.log(`Enqueued ${keys.length} image processing jobs`);
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
}
