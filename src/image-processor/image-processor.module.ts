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
        // Keep completed jobs for 1 h (up to 500) so post-deploy debugging is possible.
        // 'true' wipes them immediately, making it impossible to tell if jobs were
        // processed at all vs never picked up by the worker.
        removeOnComplete: { count: 500, age: 3600 },
        removeOnFail: { count: 100, age: 86400 }, // keep failures for 24 h
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
