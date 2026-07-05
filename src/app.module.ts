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
        // lazyConnect removed — caused BullMQ worker to silently register against
        // a disconnected socket on startup, requiring a manual container restart
        // to pick up queued jobs.
        enableReadyCheck: true,       // fail loudly if Redis is unreachable at boot
        keepAlive: 30000,
        family: 4,
        connectTimeout: 10000,        // give fresh container more time to reach Redis
        commandTimeout: 10000,
        retryStrategy: (times: number) => Math.min(times * 500, 10000), // exponential back-off, cap 10 s
        reconnectOnError: () => true, // always reconnect on any socket error
        db: 0,
      },
    }),
    ImageProcessorModule,
  ],
})
export class AppModule {}
