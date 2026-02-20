import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ImageProcessorController } from "./image-processor.controller";
import { ImageProcessorService } from "./image-processor.service";
import { ImageProcessor } from "./image.processor";

@Module({
  imports: [
    BullModule.registerQueue({
      name: "image-processing",
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 3,
        // Increase timeout for long-running jobs (e.g., HEIC conversion, large images)
        timeout: 300000, // 5 minutes
      },
    }),
  ],
  controllers: [ImageProcessorController],
  providers: [ImageProcessorService, ImageProcessor],
  exports: [ImageProcessorService],
})
export class ImageProcessorModule {}
