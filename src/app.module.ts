import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { ImageProcessorModule } from "./image-processor/image-processor.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
        retryDelayOnFailover: 100,
        enableReadyCheck: false,
        lazyConnect: true,
        keepAlive: 30000,
        family: 4,
        connectTimeout: 5000,
        commandTimeout: 10000,
        db: 0,
      },
    }),
    ImageProcessorModule,
  ],
})
export class AppModule {}
