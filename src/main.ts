import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as express from "express";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
    rawBody: true,
  });
  
  // Increase JSON body size limit
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.useGlobalPipes(new ValidationPipe());

  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle("Image Processor Microservice")
    .setDescription("Microservice for processing images")
    .setVersion("1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api", app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Image Processor Microservice is running on port ${port}`);
}
bootstrap();
