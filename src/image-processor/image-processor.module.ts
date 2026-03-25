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
      },
      streams: {
        events: {
          maxLen: Number(process.env.BULLMQ_EVENTS_MAXLEN || 2000),
        },
      },
    }),
  ],
  controllers: [ImageProcessorController],
  providers: [ImageProcessorService, ImageProcessor],
  exports: [ImageProcessorService],
})
export class ImageProcessorModule {}
