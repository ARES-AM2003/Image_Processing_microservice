import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpStatus,
  HttpException,
  UseGuards,
  UseInterceptors,
  Logger,
  Param,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiQuery,
  ApiParam,
} from "@nestjs/swagger";

import { ImageQueueService } from "./image-queue.service.optimized";
import { EnqueueImagesDto } from "./dto/enqueue-images.dto";
import * as AWS from "aws-sdk";
import * as os from "os";

interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  uptime: number;
  memory: {
    used: number;
    total: number;
    usage: number;
    threshold: number;
  };
  queue: {
    processed: number;
    failed: number;
    pending: number;
    avgProcessingTime: number;
  };
  system: {
    cpuCores: number;
    loadAverage: number[];
    nodeVersion: string;
  };
}

interface MetricsResponse {
  performance: {
    throughput: number;
    errorRate: string;
    avgProcessingTime: number;
    totalProcessed: number;
  };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: boolean;
  };
  database: {
    totalUpdates: number;
    errors: number;
    pendingBatch: number;
    batchSuccessRate: string;
  };
  system: {
    memoryUsage: NodeJS.MemoryUsage;
    uptime: number;
    environment: string;
  };
}

@ApiTags("Image Processor - Optimized")
@Controller("image-queue")
export class ImageProcessorController {
  private readonly logger = new Logger(ImageProcessorController.name);
  private readonly s3Client: AWS.S3;
  private readonly startTime: number;

  constructor(private readonly imageQueueService: ImageQueueService) {
    this.startTime = Date.now();

    // Optimized S3 client with connection pooling
    this.s3Client = new AWS.S3({
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      s3ForcePathStyle: true,
      signatureVersion: "v4",
      maxRetries: 1,
      httpOptions: {
        timeout: 30000,
        agent: new (require("https").Agent)({
          keepAlive: true,
          maxSockets: 50,
          maxFreeSockets: 10,
          keepAliveMsecs: 30000,
        }),
      },
    });
  }

  @Post("enqueue")
  @ApiOperation({
    summary: "Enqueue images for processing (Optimized)",
    description:
      "High-performance batch enqueue with intelligent batching and error handling",
  })
  @ApiBody({ type: EnqueueImagesDto })
  @ApiResponse({
    status: 200,
    description: "Images enqueued successfully",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", example: "enqueued" },
        count: { type: "number", example: 1000 },
        batchSize: { type: "number", example: 200 },
        estimatedProcessingTime: { type: "string", example: "5-10 minutes" },
        enqueueDuration: { type: "number", example: 1250 },
        throughput: { type: "number", example: 800 },
        message: { type: "string" },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Invalid request parameters",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded",
  })
  async enqueueImages(@Body() body: EnqueueImagesDto) {
    const startTime = Date.now();

    try {
      // Validation
      if (!body.bucket || !body.keys || body.keys.length === 0) {
        throw new HttpException(
          "Invalid request: bucket and keys are required",
          HttpStatus.BAD_REQUEST,
        );
      }

      if (body.keys.length > 10000) {
        throw new HttpException(
          "Batch size too large: maximum 10,000 images per request",
          HttpStatus.BAD_REQUEST,
        );
      }

      // Optimized batch processing
      await this.imageQueueService.addImageJobsBatch(body.bucket, body.keys);

      const enqueueDuration = Date.now() - startTime;
      const throughput = Math.round(
        (body.keys.length / enqueueDuration) * 1000,
      );
      const estimatedProcessingMinutes = Math.ceil(body.keys.length / 60); // Assuming 60 images/minute

      this.logger.log(
        `📦 Enqueued ${body.keys.length} images in ${enqueueDuration}ms (${throughput} items/sec)`,
      );

      return {
        status: "enqueued",
        count: body.keys.length,
        batchSize: Math.min(200, Math.max(50, os.cpus().length * 10)),
        estimatedProcessingTime: `${estimatedProcessingMinutes}-${estimatedProcessingMinutes * 2} minutes`,
        enqueueDuration,
        throughput,
        message: `${body.keys.length} images queued for processing with optimized batching`,
      };
    } catch (error) {
      this.logger.error(`Enqueue failed: ${error.message}`, error.stack);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        "Internal server error during enqueue operation",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  @ApiOperation({
    summary: "Get queue status (Optimized)",
    description: "Comprehensive queue status with performance metrics",
  })
  @ApiResponse({
    status: 200,
    description: "Queue status retrieved successfully",
  })
  async getQueueStatus() {
    try {
      const queueStatus = await this.imageQueueService.queue.getWaitingCount();
      const metrics = this.imageQueueService.getMetrics();

      return {
        queue: {
          waiting: queueStatus,
          active: await this.imageQueueService.queue.getActiveCount(),
          completed: await this.imageQueueService.queue.getCompletedCount(),
          failed: await this.imageQueueService.queue.getFailedCount(),
        },
        performance: {
          totalProcessed: metrics.processed,
          totalFailed: metrics.failed,
          averageProcessingTime: Math.round(metrics.averageProcessingTime),
          throughput: Math.round(metrics.processed / (metrics.uptime / 1000)),
          errorRate:
            (
              (metrics.failed / (metrics.processed + metrics.failed)) *
              100
            ).toFixed(2) + "%",
        },
        database: {
          pendingUpdates: metrics.pendingUpdates,
          totalDbUpdates: metrics.dbUpdates,
          dbErrors: metrics.dbErrors,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to get queue status: ${error.message}`);
      throw new HttpException(
        "Unable to retrieve queue status",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get("health")
  @ApiOperation({
    summary: "Health check endpoint",
    description: "Comprehensive health check with system metrics",
  })
  @ApiResponse({
    status: 200,
    description: "Service health status",
  })
  async getHealth(): Promise<HealthCheckResponse> {
    try {
      const memory = process.memoryUsage();
      const metrics = this.imageQueueService.getMetrics();
      const memoryThresholdMB = Number(process.env.MEMORY_THRESHOLD_MB || 1536);
      const memoryUsageMB = Math.round(memory.heapUsed / 1024 / 1024);
      const memoryUsagePercent = Math.round(
        (memory.heapUsed / memory.heapTotal) * 100,
      );

      // Determine health status
      let status: "healthy" | "degraded" | "unhealthy" = "healthy";

      if (memoryUsageMB > memoryThresholdMB * 0.9) {
        status = "degraded";
      }
      if (memoryUsageMB > memoryThresholdMB || memoryUsagePercent > 90) {
        status = "unhealthy";
      }

      const errorRate =
        metrics.processed > 0
          ? (metrics.failed / (metrics.processed + metrics.failed)) * 100
          : 0;

      if (errorRate > 10) {
        status = "degraded";
      }
      if (errorRate > 25) {
        status = "unhealthy";
      }

      return {
        status,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || "1.0.0",
        uptime: Math.round(process.uptime()),
        memory: {
          used: memoryUsageMB,
          total: Math.round(memory.heapTotal / 1024 / 1024),
          usage: memoryUsagePercent,
          threshold: memoryThresholdMB,
        },
        queue: {
          processed: metrics.processed,
          failed: metrics.failed,
          pending: metrics.pendingUpdates,
          avgProcessingTime: Math.round(metrics.averageProcessingTime),
        },
        system: {
          cpuCores: os.cpus().length,
          loadAverage: os.loadavg(),
          nodeVersion: process.version,
        },
      };
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`);
      return {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        version: "unknown",
        uptime: 0,
        memory: { used: 0, total: 0, usage: 0, threshold: 0 },
        queue: { processed: 0, failed: 0, pending: 0, avgProcessingTime: 0 },
        system: { cpuCores: 0, loadAverage: [0, 0, 0], nodeVersion: "unknown" },
      };
    }
  }

  @Get("metrics")
  @ApiOperation({
    summary: "Detailed performance metrics",
    description: "Comprehensive metrics for monitoring and optimization",
  })
  @ApiResponse({
    status: 200,
    description: "Performance metrics retrieved successfully",
  })
  async getMetrics(): Promise<MetricsResponse> {
    try {
      const metrics = this.imageQueueService.getMetrics();
      const queueCounts = {
        waiting: await this.imageQueueService.queue.getWaitingCount(),
        active: await this.imageQueueService.queue.getActiveCount(),
        completed: await this.imageQueueService.queue.getCompletedCount(),
        failed: await this.imageQueueService.queue.getFailedCount(),
        delayed: await this.imageQueueService.queue.getDelayedCount(),
        paused: await this.imageQueueService.queue.isPaused(),
      };

      const totalJobs = metrics.processed + metrics.failed;
      const errorRate = totalJobs > 0 ? (metrics.failed / totalJobs) * 100 : 0;
      const dbSuccessRate =
        metrics.dbUpdates + metrics.dbErrors > 0
          ? (
              (metrics.dbUpdates / (metrics.dbUpdates + metrics.dbErrors)) *
              100
            ).toFixed(2)
          : "100.00";

      return {
        performance: {
          throughput: Math.round(metrics.processed / (metrics.uptime / 1000)),
          errorRate: errorRate.toFixed(2) + "%",
          avgProcessingTime: Math.round(metrics.averageProcessingTime),
          totalProcessed: metrics.processed,
        },
        queue: queueCounts,
        database: {
          totalUpdates: metrics.dbUpdates,
          errors: metrics.dbErrors,
          pendingBatch: metrics.pendingUpdates,
          batchSuccessRate: dbSuccessRate + "%",
        },
        system: {
          memoryUsage: metrics.memoryUsage,
          uptime: metrics.uptime,
          environment: process.env.NODE_ENV || "development",
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get metrics: ${error.message}`);
      throw new HttpException(
        "Unable to retrieve metrics",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Post("queue/clear")
  @ApiOperation({
    summary: "Clear all jobs from queue",
    description: "Emergency operation to clear all pending jobs",
  })
  @ApiResponse({
    status: 200,
    description: "Queue cleared successfully",
  })
  async clearQueue() {
    try {
      await this.imageQueueService.queue.drain();
      await this.imageQueueService.queue.clean(0, 1000, "completed");
      await this.imageQueueService.queue.clean(0, 1000, "failed");
      const result = { success: true, message: "Queue cleared successfully" };
      this.logger.warn("🧹 Queue manually cleared");
      return result;
    } catch (error) {
      this.logger.error(`Failed to clear queue: ${error.message}`);
      throw new HttpException(
        "Failed to clear queue",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("queue/pause")
  @ApiOperation({ summary: "Pause queue processing" })
  async pauseQueue() {
    try {
      await this.imageQueueService.queue.pause();
      const result = { success: true, message: "Queue paused" };
      this.logger.warn("⏸️ Queue manually paused");
      return result;
    } catch (error) {
      throw new HttpException(
        "Failed to pause queue",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("queue/resume")
  @ApiOperation({ summary: "Resume queue processing" })
  async resumeQueue() {
    try {
      await this.imageQueueService.queue.resume();
      const result = { success: true, message: "Queue resumed" };
      this.logger.log("▶️ Queue manually resumed");
      return result;
    } catch (error) {
      throw new HttpException(
        "Failed to resume queue",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("database/flush-pending")
  @ApiOperation({
    summary: "Force flush pending database updates",
    description: "Manually trigger batch database updates",
  })
  @ApiResponse({
    status: 200,
    description: "Pending updates flushed successfully",
  })
  async flushPendingUpdates() {
    try {
      const result = await this.imageQueueService.flushPendingUpdates();
      this.logger.log(
        `💾 Manually flushed ${result.success} pending DB updates`,
      );
      return {
        ...result,
        message: `Flushed ${result.success} pending database updates`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to flush pending updates: ${error.message}`);
      throw new HttpException(
        "Failed to flush pending updates",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("metrics/reset")
  @ApiOperation({
    summary: "Reset performance metrics",
    description: "Reset counters and metrics for fresh monitoring period",
  })
  @ApiResponse({
    status: 200,
    description: "Metrics reset successfully",
  })
  async resetMetrics() {
    try {
      this.imageQueueService.resetMetrics();
      this.logger.log("📊 Performance metrics manually reset");
      return {
        success: true,
        message: "Performance metrics reset successfully",
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        "Failed to reset metrics",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get("debug/s3-test")
  @ApiOperation({ summary: "Test S3 connectivity" })
  @ApiQuery({ name: "bucket", required: true })
  @ApiQuery({ name: "prefix", required: false })
  @ApiQuery({ name: "maxKeys", required: false, type: Number })
  async testS3Connection(
    @Query("bucket") bucket: string,
    @Query("prefix") prefix?: string,
    @Query("maxKeys") maxKeys?: number,
  ) {
    if (!bucket) {
      throw new HttpException(
        "bucket query parameter is required",
        HttpStatus.BAD_REQUEST,
      );
    }

    const startTime = Date.now();

    try {
      const listParams: AWS.S3.ListObjectsV2Request = {
        Bucket: bucket,
        MaxKeys: maxKeys || 10,
      };

      if (prefix) {
        listParams.Prefix = prefix;
      }

      const result = await this.s3Client.listObjectsV2(listParams).promise();
      const responseTime = Date.now() - startTime;

      return {
        success: true,
        bucket: bucket,
        prefix: prefix || "",
        objectCount: result.Contents?.length || 0,
        isTruncated: result.IsTruncated,
        responseTime,
        objects:
          result.Contents?.map((obj) => ({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified,
          })) || [],
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.logger.error(`S3 test failed: ${error.message}`);

      return {
        success: false,
        error: error.message,
        code: error.code,
        statusCode: error.statusCode,
        bucket: bucket,
        responseTime,
      };
    }
  }

  @Get("debug/memory")
  @ApiOperation({
    summary: "Detailed memory analysis",
    description: "In-depth memory usage analysis for debugging",
  })
  async getMemoryAnalysis() {
    const memory = process.memoryUsage();

    return {
      memory: {
        rss: `${Math.round(memory.rss / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
        external: `${Math.round(memory.external / 1024 / 1024)}MB`,
        arrayBuffers: `${Math.round(memory.arrayBuffers / 1024 / 1024)}MB`,
      },
      system: {
        totalMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
        freeMemory: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
        memoryUsage: `${Math.round((1 - os.freemem() / os.totalmem()) * 100)}%`,
      },
      process: {
        pid: process.pid,
        uptime: `${Math.round(process.uptime())}s`,
        nodeVersion: process.version,
        platform: process.platform,
      },
      gc: {
        available: typeof global.gc === "function",
        recommendation:
          memory.heapUsed > memory.heapTotal * 0.8
            ? "Consider running garbage collection"
            : "Memory usage is normal",
      },
    };
  }

  @Post("debug/gc")
  @ApiOperation({
    summary: "Force garbage collection",
    description: "Manually trigger garbage collection (if enabled)",
  })
  async forceGarbageCollection() {
    const beforeMemory = process.memoryUsage();

    if (typeof global.gc === "function") {
      global.gc();
      const afterMemory = process.memoryUsage();
      const freed = beforeMemory.heapUsed - afterMemory.heapUsed;

      return {
        success: true,
        message: "Garbage collection completed",
        before: `${Math.round(beforeMemory.heapUsed / 1024 / 1024)}MB`,
        after: `${Math.round(afterMemory.heapUsed / 1024 / 1024)}MB`,
        freed: `${Math.round(freed / 1024 / 1024)}MB`,
        timestamp: new Date().toISOString(),
      };
    } else {
      return {
        success: false,
        message:
          "Garbage collection not available. Start with --expose-gc flag.",
        currentMemory: `${Math.round(beforeMemory.heapUsed / 1024 / 1024)}MB`,
      };
    }
  }
}
