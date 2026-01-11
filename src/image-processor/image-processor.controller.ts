import { Controller, Post, Body, Get, Delete } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from "@nestjs/swagger";
import { ImageProcessorService } from "./image-processor.service";
import { EnqueueImagesDto } from "./dto/enqueue-images.dto";

@ApiTags("Image Processor")
@Controller("image-queue")
export class ImageProcessorController {
  constructor(private readonly imageProcessorService: ImageProcessorService) {}

  @Post("enqueue")
  @ApiOperation({ summary: "Enqueue images for processing" })
  @ApiBody({ type: EnqueueImagesDto })
  @ApiResponse({
    status: 200,
    description: "Images enqueued successfully",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", example: "enqueued" },
        count: { type: "number", example: 5 },
        message: {
          type: "string",
          example:
            "Images will be validated and processed according to size and format requirements",
        },
      },
    },
  })
  async enqueueImages(@Body() body: EnqueueImagesDto) {
    await this.imageProcessorService.addImageJobsBatch(body.bucket, body.keys);
    return {
      status: "enqueued",
      count: body.keys.length,
      message:
        "Images will be validated and processed according to size and format requirements",
    };
  }

  @Delete("clear")
  @ApiOperation({ summary: "Stop and remove all current jobs from the queue" })
  @ApiResponse({
    status: 200,
    description: "All jobs cleared successfully",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: true },
        clearTime: { type: "number", example: 150 },
        message: { type: "string", example: "Queue cleared successfully" },
      },
    },
  })
  async clearQueue() {
    return this.imageProcessorService.clearQueue();
  }

  @Get("status")
  @ApiOperation({ summary: "Get current queue status" })
  @ApiResponse({
    status: 200,
    description: "Queue status retrieved successfully",
    schema: {
      type: "object",
      properties: {
        worker: { type: "string", example: "running" },
        paused: { type: "boolean", example: false },
        counts: {
          type: "object",
          properties: {
            waiting: { type: "number", example: 10 },
            active: { type: "number", example: 2 },
            completed: { type: "number", example: 100 },
            failed: { type: "number", example: 5 },
            delayed: { type: "number", example: 0 },
          },
        },
      },
    },
  })
  async getQueueStatus() {
    return this.imageProcessorService.getQueueStatus();
  }

  @Post("pause")
  @ApiOperation({ summary: "Pause the queue processing" })
  @ApiResponse({
    status: 200,
    description: "Queue paused successfully",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: true },
        message: { type: "string", example: "Queue paused" },
      },
    },
  })
  async pauseQueue() {
    return this.imageProcessorService.pauseQueue();
  }

  @Post("resume")
  @ApiOperation({ summary: "Resume the queue processing" })
  @ApiResponse({
    status: 200,
    description: "Queue resumed successfully",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: true },
        message: { type: "string", example: "Queue resumed" },
      },
    },
  })
  async resumeQueue() {
    return this.imageProcessorService.resumeQueue();
  }
}