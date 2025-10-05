import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import * as sharp from "sharp";

@Processor("image-processing", {
  concurrency: 1, // Process one job at a time to manage memory
})
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);

  async process(job: Job<{ bucket: string; key: string }>) {
    const { bucket, key } = job.data;
    const startTime = Date.now();
    const startMemory = process.memoryUsage();

    try {
      this.logger.log(
        `📸 Processing: ${key} (Start: ${Math.round(startMemory.heapUsed / 1024 / 1024)}MB)`,
      );

      // Simulate image processing with Sharp
      // In a real implementation, you would:
      // 1. Download the image from S3/Backblaze
      // 2. Process it with Sharp
      // 3. Upload the processed image back to storage
      
      const processedImageKey = this.generatePreviewKey(key);
      
      // Example processing (you would implement actual image download/upload here)
      await this.simulateImageProcessing(key);
      
      const endTime = Date.now();
      const endMemory = process.memoryUsage();
      const processingTime = endTime - startTime;
      const memoryDelta = Math.round(
        (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024,
      );

      this.logger.log(
        `✅ Completed: ${key} in ${processingTime}ms (Memory: +${memoryDelta}MB)`,
      );

      return { previewKey: processedImageKey };
    } catch (error) {
      this.logger.error(`❌ Failed to process ${key}: ${error.message}`);
      throw error;
    }
  }

  private generatePreviewKey(originalKey: string): string {
    const pathParts = originalKey.split("/");
    const fileName = pathParts.pop();
    const [name, ext] = fileName.split(".");
    return `${pathParts.join("/")}/${name}_preview.${ext}`;
  }

  private async simulateImageProcessing(key: string): Promise<void> {
    // Simulate image processing delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // In a real implementation, you would:
    /*
    // 1. Download image from storage
    const imageBuffer = await this.downloadFromStorage(bucket, key);
    
    // 2. Process with Sharp
    const processedBuffer = await sharp(imageBuffer)
      .resize({
        width: 1920,
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      })
      .jpeg({
        quality: 75,
        progressive: true,
        mozjpeg: true,
      })
      .toBuffer();
    
    // 3. Upload processed image
    const previewKey = this.generatePreviewKey(key);
    await this.uploadToStorage(bucket, previewKey, processedBuffer);
    */
  }
}
