import { Controller, Post, Get, Body } from "@nestjs/common";
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
      },
    },
  })
  async enqueueImages(@Body() body: EnqueueImagesDto) {
    await this.imageProcessorService.addImageJobsBatch(body.bucket, body.keys);
    return { status: "enqueued", count: body.keys.length };
  }

  @Get()
  @ApiOperation({ summary: "Get queue status" })
  @ApiResponse({
    status: 200,
    description: "Queue status retrieved successfully",
    schema: {
      type: "object",
      properties: {
        worker: { type: "string", example: "running" },
        paused: { type: "boolean" },
        counts: {
          type: "object",
          properties: {
            waiting: { type: "number" },
            active: { type: "number" },
            completed: { type: "number" },
            failed: { type: "number" },
            delayed: { type: "number" },
          },
        },
      },
    },
  })
  async getQueueStatus() {
    return await this.imageProcessorService.getQueueStatus();
  }
}
